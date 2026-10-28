// ---------- Offline queue (IndexedDB) ----------
// Stores: "queue" = operations waiting to upload, "conflicts" = operations that need a decision
const idbOpen = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('notes-offline', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
    req.result.createObjectStore('conflicts', { keyPath: 'qid' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idbDo(storeName, mode, fn) {
  const d = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => { d.close(); resolve(req && req.result); };
    tx.onerror = () => reject(tx.error);
  });
}
const qAll = async (s = 'queue') => (await idbDo(s, 'readonly', (o) => o.getAll())).sort((a, b) => a.qid - b.qid);
const qPut = (it, s = 'queue') => idbDo(s, 'readwrite', (o) => o.put(it));
const qDel = (qid, s = 'queue') => idbDo(s, 'readwrite', (o) => o.delete(qid));

// Non-admins only see their own operations
const visibleOps = (items) => items.filter((it) => it.kind !== 'audit' && (isAdmin() || it.by === currentUser().email));

async function refreshPending() {
  try {
    const n = visibleOps(await qAll()).length + visibleOps(await qAll('conflicts')).length;
    document.querySelectorAll('[data-nav="sync"] .count').forEach((c) => { c.textContent = n || ''; });
  } catch {}
}

// A queued operation. kind: note-add|note-edit|note-delete|user-add|user-edit|user-delete|profile-edit|audit
// (user-* are admin actions through the edge function and need a connection; profile-edit is the user's own name/photo)
function baseItem(kind, targetId, row, label, auditInfo) {
  const u = currentUser();
  return { kind, targetId, row, label, audit: auditInfo, by: u.email, byName: rawName(u), at: new Date().toISOString(), base_updated_at: null };
}

// ---------- Audit log ----------
// Never throws: a failed audit must not break the real action. Offline rows are queued.
async function audit(action, targetType, targetId, details, o = {}) {
  const u = currentUser();
  const row = {
    user_email: o.email || u.email, user_name: o.name || rawName(u), action,
    target_type: targetType || null, target_id: targetId == null ? null : String(targetId),
    details: details || null, created_at: o.at || new Date().toISOString(),
  };
  try {
    if (net !== 'online') throw new Error('Failed to fetch');
    const { error } = await db.from('audit_log').insert(row);
    if (error) throw error;
  } catch (e) {
    if (isNetErr(e)) { try { await qPut({ kind: 'audit', row, at: row.created_at }); } catch {} }
  }
}
function auditItem(it, d) {
  const a = it.audit;
  if (a) audit(a.action, a.targetType, d && d.id != null ? d.id : a.targetId, a.details, { at: it.at, email: it.by, name: it.byName });
}

// ---------- Images (Supabase Storage buckets "avatars" and "note-images") ----------
const NOTE_IMAGES = 'note-images';

// Shrinks to WebP before uploading: square=true center-crops to max×max,
// otherwise the longest side is capped at max and the aspect ratio kept
async function resizeImage(file, max, square) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (square) {
    const side = Math.min(bmp.width, bmp.height);
    canvas.width = canvas.height = max;
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, max, max);
  } else {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
}

async function uploadImage(bucket, file, max, square) {
  const path = crypto.randomUUID() + '.webp';
  const blob = await resizeImage(file, max, square);
  const { error } = await db.storage.from(bucket).upload(path, blob, { contentType: 'image/webp' });
  if (error) throw error;
  return db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

function removeImage(bucket, url) {
  const path = url && url.split(`/${bucket}/`)[1];
  if (path) db.storage.from(bucket).remove([path]);
}

// ---------- Applying an operation to the server ----------
const must = ({ data, error }) => { if (error) throw error; return data; };
const conflict = (reason, server) => Object.assign(new Error('conflict'), { conflict: reason, server });
// Add / edit / delete another user: edge function "admin-users" (creates the login too)
async function adminCall(action, body) {
  const { data, error } = await db.functions.invoke('admin-users', { body: { action, ...body } });
  if (!error) return data;
  if (error.name === 'FunctionsFetchError') throw new Error('Failed to fetch');
  let j = null;
  try { j = await error.context.json(); } catch {}
  throw Object.assign(new Error((j && j.error) || error.message), { code: j && j.code });
}
const userQ = (q, it) => (it.targetId ? q.eq('id', it.targetId) : q.eq('email', it.targetEmail));

// Uploads/removes the item's image around `write(row)`; cleans up if the write fails
async function withImage(it, oldUrl, write) {
  const [bucket, col, max, square] = /^(user|profile)/.test(it.kind) ? ['avatars', 'avatar_url', 256, true] : [NOTE_IMAGES, 'image_url', 1280, false];
  const row = { ...it.row };
  let url = null;
  if (it.imageFile) url = row[col] = await uploadImage(bucket, it.imageFile, max, square);
  else if (it.imageCleared) row[col] = null;
  try {
    const out = await write(row);
    if (it.imageFile || it.imageCleared) removeImage(bucket, oldUrl);
    return out;
  } catch (e) {
    removeImage(bucket, url);
    throw e;
  }
}

// force=false: edits/deletes of notes whose server copy changed throw a conflict instead
async function applyItem(it, force) {
  const now = new Date().toISOString();
  switch (it.kind) {
    case 'audit':
      must(await db.from('audit_log').insert(it.row));
      return null;
    case 'note-add':
      return withImage(it, null, async (row) => must(await db.from('entries')
        .insert({ ...row, created_at: it.at, created_by: it.by, updated_by: it.by, updated_at: now }).select().single()));
    case 'note-edit': {
      const cur = must(await db.from('entries').select('*').eq('id', it.targetId).maybeSingle());
      if (!cur && !force) throw conflict('deleted', null);
      if (cur && !force && cur.updated_at !== it.base_updated_at) throw conflict('changed', cur);
      return withImage(it, cur && cur.image_url, async (row) => must(cur
        ? await db.from('entries').update({ ...row, updated_at: now, updated_by: it.by }).eq('id', it.targetId).select().single()
        : await db.from('entries').insert({ ...row, created_by: it.by, updated_by: it.by, updated_at: now }).select().single()));
    }
    case 'note-delete': {
      const cur = must(await db.from('entries').select('*').eq('id', it.targetId).maybeSingle());
      if (!cur) return null;
      if (!force && cur.updated_at !== it.base_updated_at) throw conflict('changed', cur);
      must(await db.from('entries').delete().eq('id', it.targetId));
      removeImage(NOTE_IMAGES, cur.image_url);
      return null;
    }
    case 'user-add':
      return withImage(it, null, (row) => adminCall('create', row));
    case 'user-edit': {
      const cur = must(await userQ(db.from('users').select('id, avatar_url'), it).maybeSingle());
      if (!cur) throw force ? new Error(t('notFound')) : conflict('deleted', null);
      return withImage(it, cur.avatar_url, (row) => adminCall('update', { ...row, id: cur.id }));
    }
    case 'user-delete': {
      const cur = must(await db.from('users').select('id, avatar_url').eq('id', it.targetId).maybeSingle());
      if (!cur) return null;
      await adminCall('delete', { id: cur.id });
      removeImage('avatars', cur.avatar_url);
      return null;
    }
    case 'profile-edit': {
      const cur = must(await db.from('users').select('id, avatar_url').eq('id', it.targetId).maybeSingle());
      if (!cur) throw new Error(t('notFound'));
      return withImage(it, cur.avatar_url, async (row) => must(await db.from('users').update(row).eq('id', cur.id).select('id, avatar_url').single()));
    }
  }
}

// Runs an operation now when online, otherwise queues it. Throws real (non-network) errors.
async function runOp(it) {
  const needsNet = it.kind.startsWith('user-'); // admin user actions are never queued
  if (needsNet && net !== 'online') throw new Error(t('needOnline'));
  if (net === 'online') {
    try {
      const data = await applyItem(it, true);
      if (it.qid) await qDel(it.qid); // supersedes an older queued version
      auditItem(it, data);
      return { mode: 'online', data };
    } catch (err) {
      if (!isNetErr(err)) throw err;
      if (needsNet) throw new Error(t('needOnline'));
    }
  }
  it.qid = await qPut(it);
  refreshPending();
  return { mode: 'queued' };
}

// ---------- Auto sync ----------
let syncing = false;
let meChecked = false;

async function syncNow() {
  if (syncing || net !== 'online') return null;
  syncing = true;
  let done = 0, conf = 0, userOps = false;
  try {
    for (const it of await qAll()) {
      try {
        const data = await applyItem(it, false);
        await qDel(it.qid);
        if (it.kind !== 'audit') { done++; auditItem(it, data); }
        if (/^(user|profile)/.test(it.kind)) userOps = true;
      } catch (err) {
        if (isNetErr(err)) break; // connection dropped, try again later
        await qDel(it.qid);
        if (it.kind === 'audit') continue;
        await qPut({ ...it, reason: err.conflict || 'error', server: err.server || null, error: err.conflict ? null : err.message, found: new Date().toISOString() }, 'conflicts');
        conf++;
      }
    }
  } catch {} finally { syncing = false; }
  if (!meChecked || userOps) { meChecked = true; await refreshMe(); }
  if (done || conf) {
    if (done) toast(t('uploaded').replace('{n}', done), 'ok');
    if (conf) toast(t('syncConflicts').replace('{m}', conf), 'warn', { href: '#/sync', text: t('openSync') });
    audit('sync', 'sync', null, { count: done, conflicts: conf });
    if (['notes', 'viewer', 'users', 'sync'].includes(curSection) && curRun) curRun();
  }
  refreshPending();
  return { done, conf };
}
