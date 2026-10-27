// ---------- Sync page ----------
const FIELD_LABEL = { title: 'fTitle', amount: 'fAmount', notes: 'fNotes', image_url: 'fImage', avatar_url: 'fImage', name: 'uName', email: 'email', role: 'role' };

// Fields an operation changes (password is never shown)
function changedFields(it) {
  const ks = Object.keys(it.row || {}).filter((k) => !['password', 'image_url', 'avatar_url'].includes(k));
  if (it.imageFile || it.imageCleared) ks.push(it.kind.startsWith('user') ? 'avatar_url' : 'image_url');
  return ks;
}
const mineVal = (it, k) => (k === 'image_url' || k === 'avatar_url' ? blobUrl(it.imageFile) : it.row[k]);

// A value as a node: images as thumbnails, everything else as text
function valNode(k, v) {
  if ((k === 'image_url' || k === 'avatar_url') && v) { const i = el('img'); i.src = v; i.alt = ''; return i; }
  return el('span', null, v == null || v === '' ? '—' : String(v));
}
const sameVal = (a, b) => (a ?? '') === (b ?? '');
const opLabel = (it) => actLabel(it.kind.replace('-', '.'));

// Field-by-field local vs server table
function diffTable(it, server) {
  const rows = changedFields(it).map((k) => ({ k, mine: mineVal(it, k), srv: server && server[k] }));
  return makeTable([
    { h: 'field', cell: (r) => t(FIELD_LABEL[r.k] || r.k) },
    { h: 'local', cell: (r) => valNode(r.k, r.mine) },
    { h: 'server', cls: 'diff-cell', cell: (r, tr) => {
      if (!sameVal(r.mine, r.srv) && r.k !== 'image_url' && r.k !== 'avatar_url') tr.classList.add('changed');
      return valNode(r.k, r.srv);
    } },
  ], rows, 'noPending');
}

async function renderPending(withDiff) {
  const items = visibleOps(await qAll());
  if (!items.length) return $('pendingBox').replaceChildren(el('div', 'msg', t('noPending')));
  const table = makeTable([
    { h: 'opType', cell: (it) => opLabel(it) },
    { h: 'colTarget', cell: (it) => el('span', 'clip', it.label || it.targetId) },
    { h: 'colWhen', cell: (it) => formatDateTime(it.at) },
  ], items, 'noPending');
  $('pendingBox').replaceChildren(table);
  if (!withDiff) return;

  // Compare each queued note edit with what the server has now
  const trs = table.querySelectorAll('tbody tr');
  for (const [i, it] of items.entries()) {
    if (it.kind !== 'note-edit' || net !== 'online') continue;
    const { data: server } = await db.from('entries').select('*').eq('id', it.targetId).maybeSingle();
    const d = el('tr', 'detail-row');
    const td = el('td'); td.colSpan = 3;
    if (!server) td.append(el('div', 'msg err', t('serverGone')));
    else {
      if (server.updated_at !== it.base_updated_at) td.append(el('div', 'msg err', t('serverChangedWarn')));
      td.append(diffTable(it, server));
    }
    d.append(td);
    trs[i].after(d);
  }
}

async function renderConflicts() {
  const items = visibleOps(await qAll('conflicts'));
  const box = $('conflictBox');
  if (!items.length) return box.replaceChildren(el('div', 'msg', t('noConflicts')));
  box.replaceChildren(...items.map((it) => {
    const card = el('div', 'conflict');
    card.append(el('h3', null, `${opLabel(it)} — ${it.label || it.targetId}`));
    const reason = it.reason === 'changed' ? t('rChanged') : it.reason === 'deleted' ? t('rDeleted') : t('rError') + (it.error || '');
    card.append(el('div', 'meta', reason));
    const s = it.server;
    if (s) {
      const who = s.updated_by ? nameOf(s.updated_by) : t('unknown');
      card.append(el('div', 'meta', t('changedByAt').replace('{who}', who).replace('{when}', formatDateTime(s.updated_at))));
    }

    // Mine vs server, side by side
    const isDel = it.kind.endsWith('delete');
    const keys = isDel ? ['title', 'amount', 'notes'] : changedFields(it);
    const side = (head, get) => {
      const box2 = el('div', 'side');
      box2.append(el('h4', null, head));
      const dl = el('dl');
      for (const k of keys) {
        const mv = isDel ? null : mineVal(it, k), sv = s && s[k];
        const v = get(k);
        dl.append(el('dt', null, t(FIELD_LABEL[k] || k)));
        const dd = el('dd', !isDel && !sameVal(mv, sv) ? 'diff' : '');
        dd.append(valNode(k, v));
        dl.append(dd);
      }
      box2.append(dl);
      return box2;
    };
    const sides = el('div', 'sides');
    const mine = side(t('mine'), (k) => mineVal(it, k));
    if (isDel) { mine.querySelector('dl').replaceChildren(el('dd', 'diff', t('deleteOp'))); }
    sides.append(mine, side(t('serverVer'), (k) => s && s[k]));
    card.append(sides);

    const act = el('div', 'form-actions');
    const keepMine = el('button', 'btn', t('keepMine')); keepMine.type = 'button';
    const keepServer = el('button', 'btn ghost', t('keepServer')); keepServer.type = 'button';
    keepMine.addEventListener('click', () => resolveConflict(it, 'mine', act));
    keepServer.addEventListener('click', () => resolveConflict(it, 'server', act));
    act.append(keepMine, keepServer);
    card.append(act);
    return card;
  }));
}

async function resolveConflict(it, choice, act) {
  if (net !== 'online') return toast(t('needOnline'), 'warn');
  act.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    // "Keep mine" overwrites the server; "Keep server" just drops my change
    if (choice === 'mine') auditItem(it, await applyItem(it, true));
    await qDel(it.qid, 'conflicts');
    audit('sync.resolve', 'sync', it.targetId, { choice, operation: it.kind, label: it.label });
    toast(t('resolved'), 'ok');
  } catch (err) {
    toast(t('error') + err.message, 'err');
  }
  refreshPending();
  renderSync();
}

async function renderSync() {
  setText('syncMsg', '');
  await renderPending(false);
  await renderConflicts();
}

$('syncNowBtn').addEventListener('click', async () => {
  if (net !== 'online') return toast(t('needOnline'), 'warn');
  setText('syncMsg', t('syncing'));
  const r = await syncNow();
  setText('syncMsg', '');
  if (r && !r.done && !r.conf) toast(t('nothingToSync'));
  renderSync();
});
$('checkBtn').addEventListener('click', async () => {
  setText('syncMsg', t('loading'));
  await renderPending(true);
  await renderConflicts();
  setText('syncMsg', '');
});
