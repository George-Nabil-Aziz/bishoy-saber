// ---------- User form (shared by the Users editor page and the Profile page) ----------
let formCount = 0;

function setPreview(f, src) {
  if (!src) {
    f.preview.innerHTML = ICONS.camera;
    f.preview.classList.remove('has-photo');
    return;
  }
  const img = el('img');
  img.src = src;
  f.preview.replaceChildren(img);
  f.preview.classList.add('has-photo');
}

// Clones the form template into `host`; returns refs to its fields ("editing" = the user being edited, or null)
function mountUserForm(host, { role, cancel, onDone }) {
  const node = $('userFormTpl').content.cloneNode(true).firstElementChild;
  const n = ++formCount;
  const f = { form: node, editing: null, onDone };
  node.querySelectorAll('[data-f]').forEach((x) => {
    f[x.dataset.f] = x;
    if (x.matches('input, select')) x.id = `uf${n}-${x.dataset.f}`;
  });
  node.querySelectorAll('label[data-for]').forEach((l) => { l.htmlFor = `uf${n}-${l.dataset.for}`; });
  f.roleBox.classList.toggle('hidden', !role);
  f.cancel.classList.toggle('hidden', !cancel);
  addEye(f.password);
  f.photo.addEventListener('change', () => {
    const file = f.photo.files[0];
    setPreview(f, file ? URL.createObjectURL(file) : f.editing && f.editing.avatar_url);
  });
  node.addEventListener('submit', (e) => submitUserForm(e, f));
  host.append(node);
  return f;
}

const setFormMsg = (f, text, cls = '') => { f.msg.textContent = text; f.msg.className = 'msg ' + cls; };

// Button text and password rules for add vs. edit mode
function syncUserFormTexts(f) {
  const edit = !!f.editing;
  f.btn.textContent = t(edit ? 'save' : 'addUser');
  const needPw = !edit || f.editing.auth_id === null; // a legacy user gets their login when an admin sets a password
  f.password.required = needPw;
  f.pwLabel.classList.toggle('req', needPw);
  f.pwHint.classList.toggle('hidden', needPw);
}

// u = user to edit, or null to add
function fillUserForm(f, u) {
  f.editing = u;
  f.form.reset();
  f.name.value = u ? rawName(u) : '';
  f.email.value = u ? u.email : '';
  f.role.value = u && u.role === 'admin' || (u && isOwner(u.email)) ? 'admin' : 'user';
  // The owner's email is fixed (it protects the account from being deleted); owner and self keep their role.
  // On the profile page the email is fixed too: only an admin changes an email (it is the login)
  f.email.readOnly = !!u && (isOwner(u.email) || f === pf);
  f.role.disabled = !!u && (isOwner(u.email) || isMe(u));
  setPreview(f, u && u.avatar_url);
  setFormMsg(f, '');
  syncUserFormTexts(f);
}

async function submitUserForm(e, f) {
  e.preventDefault();
  f.btn.disabled = true;
  const u = f.editing;
  const profile = f === pf;
  // Profile: own name/photo through the table, own password through Auth. Admin form: through the edge function.
  const row = { name: f.name.value.trim() };
  if (!profile) {
    row.email = f.email.value.trim().toLowerCase();
    row.role = f.role.value;
    if (f.password.value) row.password = f.password.value;
  }

  const details = { name: row.name, email: profile ? u.email : row.email };
  if (row.role) details.role = row.role;
  const it = baseItem(profile ? 'profile-edit' : u ? 'user-edit' : 'user-add', u && u.id, row, row.name,
    { action: profile ? 'profile.edit' : u ? 'user.edit' : 'user.add', targetType: 'user', targetId: u && u.id, details });
  it.targetEmail = u && u.email;
  it.imageFile = f.photo.files[0] || null;

  try {
    setFormMsg(f, t(it.imageFile && net === 'online' ? 'uploading' : 'saving'));
    const r = await runOp(it);
    let pwError = null;
    if (profile && f.password.value) {
      if (net !== 'online') pwError = t('needOnline');
      else pwError = ((await db.auth.updateUser({ password: f.password.value })).error || {}).message || null;
    }
    // Keep the sidebar in sync when editing yourself
    if (u && isMe(u)) {
      const me = currentUser();
      saveSession({ ...me, name: row.name, email: row.email || me.email, avatar_url: r.data ? r.data.avatar_url : me.avatar_url });
    }
    if (r.mode === 'queued') toast(t('savedLocal'), 'warn');
    if (profile) {
      loadProfile();
      if (pwError) setFormMsg(f, t('error') + pwError, 'err');
      else setFormMsg(f, t(r.mode === 'queued' ? 'savedLocal' : 'profileSaved'), 'ok');
    } else {
      if (r.mode === 'online') toast(t(u ? 'userUpdated' : 'userAdded'), 'ok');
      location.hash = '#/users';
    }
  } catch (err) {
    setFormMsg(f, err.code === '23505' ? t('userExists') : t('error') + err.message, 'err');
  } finally {
    f.btn.disabled = false;
  }
}

const uf = mountUserForm($('userFormHost'), { role: true, cancel: true });
const pf = mountUserForm($('profileFormHost'), { role: false, cancel: false });

// ---------- Users ----------
async function withPendingUsers(rows) {
  const out = rows.map((r) => ({ ...r }));
  const adds = [];
  for (const it of await qAll()) {
    if (!it.kind.startsWith('user')) continue;
    const { password, ...row } = it.row || {};
    const u = out.find((r) => String(r.id) === String(it.targetId));
    if (it.kind === 'user-add') adds.push({ ...row, id: 'q' + it.qid, _pending: 'add', avatar_url: blobUrl(it.imageFile) });
    else if (u && it.kind === 'user-edit') {
      Object.assign(u, row, { _pending: 'edit' });
      if (it.imageFile) u.avatar_url = blobUrl(it.imageFile);
    } else if (u && it.kind === 'user-delete') u._pending = 'delete';
  }
  return [...out, ...adds];
}

async function loadUsers() {
  setText('usersMsg', t('loading'));
  const res = await cached('users', () => db.from('users').select(USER_COLS).order('created_at'));
  if (res.error) { $('usersTable').innerHTML = ''; return setText('usersMsg', t('error') + res.error.message, 'err'); }
  setText('usersMsg', res.stale ? t('staleCopy') : '');
  const rows = await withPendingUsers(res.data);

  $('usersTable').replaceChildren(makeTable([
    { h: null, cell: (u) => { const a = el('span', 'avatar'); fillAvatar(a, u); return a; } },
    { h: 'uName', cell: (u) => {
      const s = el('span', null, displayName(u));
      // The owner and the signed-in user can't be removed
      const tag = isOwner(u.email) ? 'owner' : isMe(u) ? 'you' : null;
      if (tag) s.append(' ', el('span', 'badge', t(tag)));
      if (u.auth_id === null) s.append(' ', el('span', 'badge', t('noLogin')));
      if (u._pending) s.append(pendingBadge());
      return s;
    } },
    { h: 'email', cell: (u) => {
      const s = el('span', 'email-cell');
      s.append(el('span', 'clip', u.email), iconBtn('copy', 'copyEmail', 'copy', () => copyText(u.email)));
      return s;
    } },
    { h: 'role', cell: (u) => {
      const admin = u.role === 'admin' || isOwner(u.email);
      return el('span', 'badge' + (admin ? ' admin' : ''), t(admin ? 'roleAdmin' : 'roleUser'));
    } },
    { h: 'colActions', cls: 'actions', cell: (u) => {
      if (u._pending === 'delete' || u._pending === 'add') return '';
      const protectedUser = isOwner(u.email) || isMe(u);
      const del = iconBtn('trash', 'delBtn', 'del', (e) => deleteUser(u, e.currentTarget));
      del.disabled = protectedUser;
      return actions(iconLink('#/users/edit/' + u.id, 'edit', 'editBtn'), del);
    } },
  ], rows, 'noUsers'));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied'), 'ok'); } catch { toast(t('error') + text, 'err'); }
}

async function deleteUser(u, btn) {
  if (!confirmed(btn)) return;
  btn.disabled = true;
  const it = baseItem('user-delete', u.id, { name: u.name, email: u.email }, u.name || u.email,
    { action: 'user.delete', targetType: 'user', targetId: u.id, details: { name: u.name, email: u.email } });
  try {
    const r = await runOp(it);
    if (r.mode === 'queued') toast(t('savedLocal'), 'warn');
  } catch (err) {
    toast(t('error') + err.message, 'err');
  }
  loadUsers();
}

// One user by id: server or saved copy, with queued edits applied
async function getUser(id) {
  let data;
  if (net === 'online') {
    const r = await db.from('users').select(USER_COLS).eq('id', id).maybeSingle();
    if (!r.error) data = r.data;
    else if (!isNetErr(r.error)) throw r.error;
  }
  if (data === undefined) data = (cacheGet('users') || []).find((u) => String(u.id) === String(id));
  if (!data) return null;
  const rows = await withPendingUsers([data]);
  return rows[0];
}

async function openUserEditor(id) {
  $('userEditorTitle').textContent = t(id ? 'editUser' : 'addUser');
  fillUserForm(uf, null);
  if (!id) return;
  setFormMsg(uf, t('loading'));
  try {
    const u = await getUser(id);
    if (!u) return setFormMsg(uf, t('notFound'), 'err');
    fillUserForm(uf, u);
    $('userEditorTitle').textContent = t('editUser');
  } catch (err) {
    setFormMsg(uf, t('error') + err.message, 'err');
  }
}

// ---------- Profile ----------
const meUser = () => { const u = currentUser(); return { id: u.id, name: rawName(u), email: u.email, avatar_url: u.avatar_url, role: isAdmin() ? 'admin' : 'user' }; };

function renderProfileHead() {
  const u = currentUser();
  fillAvatar($('pAvatar'), u);
  $('pName').textContent = displayName(u);
  $('pEmail').textContent = u.email;
  $('pRole').textContent = t(isAdmin() ? 'roleAdmin' : 'roleUser');
  $('pRole').className = 'badge' + (isAdmin() ? ' admin' : '');
}

function loadProfile() {
  renderProfileHead();
  fillUserForm(pf, meUser());
}
