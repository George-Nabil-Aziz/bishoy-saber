// ---------- History (audit log) ----------
let auditRows = [];
const actLabel = (a) => t('act_' + String(a).replace('.', '_')) || a;
const targetText = (r) => [r.target_type, r.target_id].filter(Boolean).join(' #');

// "title: Foo · count: 3"
function detailsText(d) {
  if (!d) return '';
  return Object.entries(d).map(([k, v]) => `${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

// Rebuilds a filter <select>, keeping the chosen value when it still exists
function fillSelect(sel, allKey, values, label) {
  const keep = sel.value;
  sel.replaceChildren(new Option(t(allKey), ''), ...values.map((v) => new Option(label(v), v)));
  sel.value = values.includes(keep) ? keep : '';
}

async function loadHistory() {
  setText('historyMsg', t('loading'));
  const res = await cached('audit', () => db.from('audit_log').select('*').order('created_at', { ascending: false }).limit(500));
  if (res.error) { $('historyTable').innerHTML = ''; return setText('historyMsg', t('error') + res.error.message, 'err'); }
  setText('historyMsg', res.stale ? t('staleCopy') : '');
  auditRows = res.data;
  const uniq = (k) => [...new Set(auditRows.map((r) => r[k]).filter(Boolean))];
  fillSelect($('fUser'), 'allUsers', uniq('user_email'), (e) => nameOf(e) + ' — ' + e);
  fillSelect($('fAction'), 'allActions', uniq('action'), actLabel);
  renderAudit();
}

function renderAudit() {
  const u = $('fUser').value, a = $('fAction').value;
  const rows = auditRows.filter((r) => (!u || r.user_email === u) && (!a || r.action === a));
  const COLS = 6;
  $('historyTable').replaceChildren(makeTable([
    { h: 'colWhen', cell: (r) => formatDateTime(r.created_at) },
    { h: 'colUser', cell: (r) => el('span', 'clip', r.user_name || r.user_email) },
    { h: 'colAction', cell: (r) => actLabel(r.action) },
    { h: 'colTarget', cell: (r) => targetText(r) },
    { h: 'colDetails', cell: (r) => el('span', 'clip', detailsText(r.details)) },
    { h: 'colActions', cls: 'actions', cell: (r, tr) => actions(iconBtn('eye', 'viewBtn', 'edit', () => {
      // View toggles a row with the full details under this one
      if (tr._detail) { tr._detail.remove(); tr._detail = null; return; }
      const d = el('tr', 'detail-row');
      const td = el('td'); td.colSpan = COLS;
      td.append(el('div', 'detail-box', [r.user_email, formatDateTime(r.created_at), actLabel(r.action), targetText(r), JSON.stringify(r.details, null, 2)].filter(Boolean).join('\n')));
      d.append(td);
      tr.after(d);
      tr._detail = d;
    })) },
  ], rows, 'noHistory'));
}
$('fUser').addEventListener('change', renderAudit);
$('fAction').addEventListener('change', renderAudit);
