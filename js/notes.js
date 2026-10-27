// ---------- Notes ----------
const editing = { id: null, base: null, qid: null }; // the note being edited (id null = adding)
const blobUrl = (f) => (f ? URL.createObjectURL(f) : null);

// Server rows + operations still waiting in the queue
async function withPending(rows) {
  const out = rows.map((r) => ({ ...r }));
  const adds = [];
  for (const it of await qAll()) {
    if (!it.kind.startsWith('note')) continue;
    const row = out.find((r) => String(r.id) === String(it.targetId));
    if (it.kind === 'note-add') {
      adds.unshift({ ...it.row, id: 'q' + it.qid, created_at: it.at, created_by: it.by, image_url: blobUrl(it.imageFile), _pending: 'add' });
    } else if (row && it.kind === 'note-edit') {
      Object.assign(row, it.row, { _pending: 'edit' });
      if (it.imageFile) row.image_url = blobUrl(it.imageFile);
      else if (it.imageCleared) row.image_url = null;
    } else if (row && it.kind === 'note-delete') {
      row._pending = 'delete';
    }
  }
  return [...adds, ...out];
}

async function loadNotes() {
  
  setText('notesMsg', t('loading'));
  const res = await cached('notes', () => db.from('entries').select('*').order('created_at', { ascending: false }));
  if (res.error) { $('notesTable').innerHTML = ''; return setText('notesMsg', t('error') + res.error.message, 'err'); }
  setText('notesMsg', res.stale ? t('staleCopy') : '');
  await cached('names', () => db.from('users').select('name, email, avatar_url')); // so every role sees names, not emails
  const rows = await withPending(res.data);

  $('notesTable').replaceChildren(makeTable([
    { h: 'fImage', cell: (n) => {
      if (!n.image_url) { const d = el('div', 'thumb-empty'); d.innerHTML = ICONS.image; return d; }
      const img = el('img', 'thumb'); img.src = n.image_url; img.alt = ''; img.loading = 'lazy';
      return img;
    } },
    { h: 'fTitle', cell: (n) => { const s = el('span', 'clip', n.title); if (n._pending) s.append(pendingBadge()); return s; } },
    { h: 'fAmount', cls: 'num', cell: (n) => n.amount },
    { h: 'createdBy', cell: (n) => nameOf(n.created_by) },
    { h: 'editedBy', cell: (n) => (n.updated_by ? nameOf(n.updated_by) : '—') },
    { h: 'colDate', cell: (n) => formatDate(n.created_at) },
    { h: 'colActions', cls: 'actions', cell: (n) => {
      const canChange = canEditNote(n) && (!n._pending || n._pending === 'edit');
      return actions(
        n._pending !== 'delete' && iconLink('#/notes/view/' + n.id, 'eye', 'viewBtn'),
        canChange && iconLink('#/notes/edit/' + n.id, 'edit', 'editBtn'),
        canChange && iconBtn('trash', 'delBtn', 'del', (e) => deleteNote(n, e.currentTarget)),
      );
    } },
  ], rows, 'empty'));
}

async function deleteNote(n, btn) {
  if (!confirmed(btn)) return;
  btn.disabled = true;
  const it = baseItem('note-delete', n.id, { title: n.title }, n.title,
    { action: 'note.delete', targetType: 'note', targetId: n.id, details: { title: n.title } });
  it.base_updated_at = n._base || n.updated_at;
  try {
    const r = await runOp(it);
    if (r.mode === 'queued') toast(t('savedLocal'), 'warn');
  } catch (err) {
    toast(t('error') + err.message, 'err');
  }
  loadNotes();
}

// One note by id: from the server (or the saved copy), with any queued edit applied.
// _base is the updated_at the edit should be compared against when it syncs.
async function getNote(id) {
  const items = await qAll();
  if (String(id)[0] === 'q') {
    const it = items.find((i) => i.qid === Number(String(id).slice(1)));
    return it && { ...it.row, id, created_at: it.at, created_by: it.by, image_url: blobUrl(it.imageFile), _pending: 'add' };
  }
  let data;
  if (net === 'online') {
    const r = await db.from('entries').select('*').eq('id', id).maybeSingle();
    if (!r.error) data = r.data;
    else if (!isNetErr(r.error)) throw r.error;
  }
  if (data === undefined) data = (cacheGet('notes') || []).find((n) => String(n.id) === String(id));
  if (!data) return null;
  const pe = items.find((i) => i.kind === 'note-edit' && String(i.targetId) === String(id));
  if (!pe) return { ...data, _base: data.updated_at };
  return {
    ...data, ...pe.row, _pending: 'edit', _base: pe.base_updated_at, _qid: pe.qid,
    image_url: pe.imageFile ? blobUrl(pe.imageFile) : pe.imageCleared ? null : data.image_url,
    _file: pe.imageFile, _cleared: pe.imageCleared,
  };
}

// ---------- Add / Edit note ----------
const form = $('form');
const setMsg = (text, cls = '') => setText('msg', text, cls);

// Note image state: the saved URL, a newly picked file, or a request to remove it
const noteImage = { url: null, file: null, cleared: false };

function showNoteImage(src) {
  $('noteImagePreview').classList.toggle('hidden', !src);
  $('noteImageDrop').classList.toggle('hidden', !!src);
  if (src) $('noteImageImg').src = src;
}

function resetNoteImage(url = null) {
  Object.assign(noteImage, { url, file: null, cleared: false });
  $('noteImage').value = '';
  showNoteImage(url);
}

$('noteImage').addEventListener('change', () => {
  const file = $('noteImage').files[0];
  if (!file) return;
  noteImage.file = file;
  showNoteImage(URL.createObjectURL(file));
});

$('noteImageRemove').addEventListener('click', () => {
  noteImage.file = null;
  noteImage.cleared = !!noteImage.url;
  $('noteImage').value = '';
  showNoteImage(null);
});

function openAdd() {
  Object.assign(editing, { id: null, base: null, qid: null });
  $('editorTitle').textContent = t('addTitle');
  form.reset();
  resetNoteImage();
  setMsg('');
}

async function openEdit(id) {
  Object.assign(editing, { id: null, base: null, qid: null });
  $('editorTitle').textContent = t('editTitle');
  form.reset();
  resetNoteImage();
  if (String(id)[0] === 'q') { location.hash = '#/notes/view/' + id; return; } // not uploaded yet
  setMsg(t('loading'));
  try {
    const n = await getNote(id);
    if (!n) return setMsg(t('notFound'), 'err');
    if (!canEditNote(n)) { location.hash = '#/notes/view/' + id; return; }
    Object.assign(editing, { id: n.id, base: n._base, qid: n._qid || null });
    form.title.value = n.title;
    form.amount.value = n.amount ?? '';
    form.notes.value = n.notes || '';
    resetNoteImage(n.image_url);
    // Keep an image that is already queued for upload
    if (n._file) noteImage.file = n._file;
    if (n._cleared) noteImage.cleared = true;
    setMsg('');
  } catch (err) {
    setMsg(t('error') + err.message, 'err');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('save').disabled = true;
  setMsg(t('saving'));

  const row = {
    title: form.title.value.trim(),
    amount: form.amount.value === '' ? null : Number(form.amount.value),
    notes: form.notes.value.trim() || null,
  };
  const isEdit = !!editing.id;
  const it = baseItem(isEdit ? 'note-edit' : 'note-add', editing.id, row, row.title,
    { action: isEdit ? 'note.edit' : 'note.add', targetType: 'note', targetId: editing.id, details: { title: row.title } });
  Object.assign(it, { imageFile: noteImage.file, imageCleared: noteImage.cleared, base_updated_at: editing.base });
  if (editing.qid) it.qid = editing.qid;

  try {
    if (noteImage.file && net === 'online') setMsg(t('uploading'));
    const r = await runOp(it);
    if (r.mode === 'queued') {
      editing.qid = isEdit ? it.qid : null;
      setMsg(t('savedLocal'), 'ok');
      if (!isEdit) { form.reset(); resetNoteImage(); }
    } else {
      setMsg(t(isEdit ? 'updated' : 'saved'), 'ok');
      if (isEdit) {
        Object.assign(editing, { base: r.data.updated_at, qid: null });
        resetNoteImage(r.data.image_url);
      } else {
        form.reset();
        resetNoteImage();
      }
    }
  } catch (err) {
    setMsg(t('error') + err.message, 'err');
  }
  $('save').disabled = false;
});

// ---------- View note (read-only) ----------
async function openView(id) {
  $('viewBody').classList.add('hidden');
  setText('viewMsg', t('loading'));
  let n;
  try { n = await getNote(id); } catch (err) { return setText('viewMsg', t('error') + err.message, 'err'); }
  if (!n) return setText('viewMsg', t('notFound'), 'err');
  $('vTitle').textContent = n.title;
  $('vDate').textContent = formatDate(n.created_at);
  $('vAmount').textContent = n.amount ?? '—';
  $('vNotes').textContent = n.notes || '—';
  $('vBy').textContent = nameOf(n.created_by);
  $('vEditedBy').textContent = n.updated_by ? nameOf(n.updated_by) + ' · ' + formatDate(n.updated_at) : '—';
  $('vImageLink').classList.toggle('hidden', !n.image_url);
  if (n.image_url) {
    $('vImage').src = n.image_url;
    $('vImageLink').href = n.image_url;
  }
  $('vEdit').href = '#/notes/edit/' + n.id;
  $('vEdit').classList.toggle('hidden', !canEditNote(n) || n._pending === 'add');
  setText('viewMsg', '');
  $('viewBody').classList.remove('hidden');
}
