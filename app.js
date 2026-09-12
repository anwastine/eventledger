/* Event Ledger — single-page app. Data model lives in DB; persisted to localStorage and (optionally) a private GitHub repo. */
const DEFAULT_REPO = 'anwastine/eventledger-data';
const LS = { data: 'el.data', vault: 'el.vault', repo: 'el.repo', mode: 'el.mode', session: 'el.session' };
const PAY_MODES = ['Cash', 'UPI', 'Bank transfer', 'Cheque', 'Card', 'Other'];
const EXP_CATEGORIES = ['Decoration', 'Food & catering', 'Sound & lights', 'Transport', 'Venue', 'Materials', 'Printing', 'Photography', 'Staff', 'Rent', 'Misc'];
const VENDOR_CATEGORIES = ['Worker / labour', 'Decorator', 'Caterer', 'Sound & DJ', 'Photographer', 'Developer', 'Transport', 'Supplier', 'Freelancer', 'Other'];
const OTHER_CATEGORIES = ['Personal debt', 'Loan / EMI', 'Borrowed money', 'Rent', 'Bills', 'Salary', 'Purchase on credit', 'Other'];
const STATUSES = ['upcoming', 'completed', 'cancelled'];

let DB = null;
let session = { password: null, token: null, mode: 'local' };
let ui = { tab: 'dashboard', eventId: null, search: '', status: 'all', period: 'all', from: '', to: '', showSettled: false, sort: 'date-desc' };
let syncState = { status: 'local', dirty: false, timer: null, busy: false, lastError: null };

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; };
const money = (n) => { n = Math.round((n || 0) * 100) / 100; const neg = n < 0; const s = Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); return (neg ? '−₹' : '₹') + s; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => { if (!d) return '—'; const [y, m, dd] = d.split('-'); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${dd} ${M[+m - 1]} ${y}`; };
const daysUntil = (d) => Math.round((new Date(d) - new Date(today())) / 86400000);
const sum = (arr, f = x => x.amount) => (arr || []).reduce((a, x) => a + num(f(x)), 0);
const opts = (list, sel) => list.map(o => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('');

function toast(msg, kind = '') { const t = $('#toast'); t.textContent = msg; t.className = `toast ${kind}`; clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 2600); }

/* ---------- data model ---------- */
function emptyDB() { return { version: 1, auth: null, settings: { businessName: 'Event Ledger', updatedAt: now() }, events: [], payables: [], deleted: {} }; }
function newEvent(p = {}) {
  return { id: uid(), name: '', client: '', phone: '', eventDate: today(), venue: '', closedOn: today(), closedCost: 0, status: 'upcoming', notes: '', payments: [], expenses: [], payables: [], createdAt: now(), updatedAt: now(), ...p };
}
function getEvent(id) { return DB.events.find(e => e.id === id); }
function touch(ev) { ev.updatedAt = now(); }

function calc(ev) {
  const billed = num(ev.closedCost);
  const received = sum(ev.payments);
  const expenses = sum(ev.expenses);
  const payablesTotal = sum(ev.payables);
  const payablesPaid = sum(ev.payables, p => sum(p.payments));
  const payablesDue = payablesTotal - payablesPaid;
  const totalCost = expenses + payablesTotal;
  return { billed, received, toCollect: billed - received, expenses, payablesTotal, payablesPaid, payablesDue, totalCost, profit: billed - totalCost, cashNow: received - expenses - payablesPaid };
}
function allPayables() {
  const out = [];
  for (const ev of DB.events) for (const p of ev.payables || []) { const paid = sum(p.payments); out.push({ ev, p, paid, due: num(p.amount) - paid }); }
  for (const p of DB.payables || []) { const paid = sum(p.payments); out.push({ ev: null, p, paid, due: num(p.amount) - paid }); }
  return out;
}
function touchPayable(ev, p) { if (ev) touch(ev); else p.updatedAt = now(); }

/* ---------- persistence ---------- */
function loadLocal() { try { const j = JSON.parse(localStorage.getItem(LS.data)); return j && j.version ? j : null; } catch { return null; } }
function saveLocal() { localStorage.setItem(LS.data, JSON.stringify(DB)); }
function save(opts = {}) {
  saveLocal();
  if (session.mode === 'sync') { syncState.dirty = true; setSyncUI('pending'); clearTimeout(syncState.timer); syncState.timer = setTimeout(syncNow, opts.immediate ? 0 : 1200); }
  if (!opts.silent) render();
}

function merge(remote, local) {
  if (!remote) return local; if (!local) return remote;
  const out = emptyDB();
  out.auth = (remote.auth && local.auth) ? ((local.authUpdatedAt || 0) > (remote.authUpdatedAt || 0) ? local.auth : remote.auth) : (local.auth || remote.auth);
  out.authUpdatedAt = Math.max(remote.authUpdatedAt || 0, local.authUpdatedAt || 0);
  out.settings = (local.settings?.updatedAt || 0) >= (remote.settings?.updatedAt || 0) ? local.settings : remote.settings;
  out.deleted = { ...(remote.deleted || {}), ...(local.deleted || {}) };
  for (const k of Object.keys(out.deleted)) out.deleted[k] = Math.max(remote.deleted?.[k] || 0, local.deleted?.[k] || 0);
  const map = new Map();
  for (const e of [...(remote.events || []), ...(local.events || [])]) { const cur = map.get(e.id); if (!cur || (e.updatedAt || 0) > (cur.updatedAt || 0)) map.set(e.id, e); }
  out.events = [...map.values()].filter(e => !(out.deleted[e.id] && out.deleted[e.id] >= (e.updatedAt || 0)));
  const pm = new Map();
  for (const p of [...(remote.payables || []), ...(local.payables || [])]) { const cur = pm.get(p.id); if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) pm.set(p.id, p); }
  out.payables = [...pm.values()].filter(p => !(out.deleted[p.id] && out.deleted[p.id] >= (p.updatedAt || 0)));
  return out;
}

async function syncNow() {
  if (session.mode !== 'sync' || syncState.busy || !GitSync.ready()) return;
  syncState.busy = true; setSyncUI('syncing');
  try {
    const before = JSON.stringify(DB);
    const { data: remote } = await GitSync.pull();
    DB = merge(remote, DB);
    saveLocal();
    if (JSON.stringify(DB) !== JSON.stringify(remote)) await GitSync.push(DB, merge);
    syncState.dirty = false; syncState.lastError = null; setSyncUI('synced');
    if (JSON.stringify(DB) !== before) render();
  } catch (e) {
    syncState.lastError = e.message; setSyncUI('error'); console.warn('sync failed', e);
  } finally { syncState.busy = false; }
}
function setSyncUI(s) {
  syncState.status = s; const b = $('#syncBtn'); if (!b) return;
  b.dataset.state = s;
  const labels = { local: 'Local only', pending: 'Unsaved', syncing: 'Syncing…', synced: 'Synced', error: 'Sync failed' };
  $('#syncLabel').textContent = labels[s] || s;
  b.title = s === 'error' ? (syncState.lastError || 'Sync failed') + ' — tap to retry' : 'Tap to sync now';
}

/* ---------- auth flow ---------- */
async function boot() {
  const local = loadLocal();
  const vault = localStorage.getItem(LS.vault);
  const mode = localStorage.getItem(LS.mode);
  const repo = localStorage.getItem(LS.repo) || DEFAULT_REPO;
  const sess = sessionStorage.getItem(LS.session);
  $('#auth').classList.remove('hidden');
  if (local && local.auth) {
    showLogin({ needToken: mode === 'sync' && !vault, repo });
    if (sess) { try { const s = JSON.parse(sess); await unlock(s.password, s.token, mode || 'local', repo, { quiet: true }); } catch { } }
  } else if (mode === 'sync') {
    showLogin({ needToken: !vault, repo });
  } else {
    showSetup(repo);
  }
}
function showLogin({ needToken, repo }) {
  $('#setupForm').classList.add('hidden'); $('#loginForm').classList.remove('hidden');
  $('#loginTokenWrap').classList.toggle('hidden', !needToken);
  $('#loginRepoLabel').textContent = repo;
  setTimeout(() => $('#loginPassword').focus(), 50);
}
function showSetup(repo) {
  $('#loginForm').classList.add('hidden'); $('#setupForm').classList.remove('hidden');
  $('#setupRepo').value = repo;
  setTimeout(() => $('#setupPassword').focus(), 50);
}

async function unlock(password, token, mode, repo, { quiet } = {}) {
  let local = loadLocal();
  if (mode === 'sync') {
    if (!token) { const v = localStorage.getItem(LS.vault); if (!v) throw new Error('GitHub token needed on this device'); try { token = await Crypto.open(password, JSON.parse(v)); } catch { throw new Error('Wrong password'); } }
    GitSync.configure({ repo, token });
    let remote;
    try { remote = (await GitSync.pull()).data; } catch (e) {
      if (local && local.auth && await Crypto.verifyAuth(password, local.auth)) { remote = null; toast('Offline — using local copy', 'warn'); }
      else throw e;
    }
    if (remote && remote.auth) { if (!(await Crypto.verifyAuth(password, remote.auth))) throw new Error('Wrong password'); }
    else if (local && local.auth) { if (!(await Crypto.verifyAuth(password, local.auth))) throw new Error('Wrong password'); }
    else { local = local || emptyDB(); local.auth = await Crypto.makeAuth(password); local.authUpdatedAt = now(); }
    DB = merge(remote, local) || emptyDB();
    if (!DB.auth) { DB.auth = await Crypto.makeAuth(password); DB.authUpdatedAt = now(); }
    DB.payables = DB.payables || [];
    localStorage.setItem(LS.vault, JSON.stringify(await Crypto.seal(password, token)));
    localStorage.setItem(LS.repo, repo); localStorage.setItem(LS.mode, 'sync');
    session = { password, token, mode: 'sync' };
    saveLocal();
    try { if (JSON.stringify(DB) !== JSON.stringify(remote)) await GitSync.push(DB, merge); setSyncUI('synced'); } catch (e) { syncState.lastError = e.message; setSyncUI('error'); }
  } else {
    if (local && local.auth) { if (!(await Crypto.verifyAuth(password, local.auth))) throw new Error('Wrong password'); DB = local; DB.payables = DB.payables || []; }
    else { DB = local || emptyDB(); DB.auth = await Crypto.makeAuth(password); DB.authUpdatedAt = now(); }
    localStorage.setItem(LS.mode, 'local');
    session = { password, token: null, mode: 'local' };
    saveLocal(); setSyncUI('local');
  }
  sessionStorage.setItem(LS.session, JSON.stringify({ password, token }));
  enterApp();
  if (!quiet) toast('Unlocked');
}
function enterApp() {
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  setSyncUI(session.mode === 'sync' ? (syncState.status === 'error' ? 'error' : 'synced') : 'local');
  render();
}
function lock() { sessionStorage.removeItem(LS.session); session = { password: null, token: null, mode: 'local' }; DB = null; location.reload(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#loginError'); err.textContent = ''; const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Unlocking…';
  try { await unlock($('#loginPassword').value, $('#loginToken').value.trim() || null, localStorage.getItem(LS.mode) || 'local', localStorage.getItem(LS.repo) || DEFAULT_REPO); }
  catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});
$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#setupError'); err.textContent = '';
  const p1 = $('#setupPassword').value, p2 = $('#setupPassword2').value, token = $('#setupToken').value.trim(), repo = $('#setupRepo').value.trim();
  if (p1 !== p2) { err.textContent = 'Passwords do not match'; return; }
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Setting up…';
  try {
    if (token) { if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repo must look like owner/repo'); await unlock(p1, token, 'sync', repo); }
    else await unlock(p1, null, 'local', repo);
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = 'Create ledger'; }
});
$('#linkLocalOnly').addEventListener('click', (e) => { e.preventDefault(); localStorage.setItem(LS.mode, 'local'); $('#loginTokenWrap').classList.add('hidden'); toast('Local-only mode: data stays on this device'); });
$('#linkResetDevice').addEventListener('click', (e) => { e.preventDefault(); if (confirm('Remove all ledger data stored on THIS device? (Data in the GitHub repo is untouched.)')) { Object.values(LS).forEach(k => localStorage.removeItem(k)); sessionStorage.clear(); location.reload(); } });
$('#loginChangeRepo').addEventListener('click', (e) => { e.preventDefault(); const r = prompt('Data repo (owner/repo):', localStorage.getItem(LS.repo) || DEFAULT_REPO); if (r) { localStorage.setItem(LS.repo, r.trim()); $('#loginRepoLabel').textContent = r.trim(); } });
$('#lockBtn').addEventListener('click', lock);
$('#syncBtn').addEventListener('click', () => { if (session.mode === 'sync') syncNow(); else { go('settings'); } });
window.addEventListener('online', () => { if (syncState.dirty || syncState.status === 'error') syncNow(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && DB && session.mode === 'sync' && !syncState.dirty) syncNow(); });

/* ---------- navigation ---------- */
function go(tab, eventId = null) { ui.tab = tab; ui.eventId = eventId; window.scrollTo(0, 0); render(); }
$$('.tab').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
$('#fab').addEventListener('click', () => openEventForm());

/* ---------- rendering ---------- */
function render() {
  if (!DB) return;
  $('#bizName').textContent = DB.settings.businessName || 'Event Ledger';
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab || (ui.tab === 'event' && b.dataset.tab === 'events')));
  const dueCount = allPayables().filter(x => x.due > 0.005).length;
  const collectCount = DB.events.filter(e => e.status !== 'cancelled' && calc(e).toCollect > 0.005).length;
  $('#payablesBadge').textContent = dueCount; $('#payablesBadge').classList.toggle('hidden', !dueCount);
  $('#collectBadge').textContent = collectCount; $('#collectBadge').classList.toggle('hidden', !collectCount);
  $('#fab').classList.toggle('hidden', !(ui.tab === 'events' || ui.tab === 'dashboard'));
  const main = $('#main');
  const views = { dashboard: renderDashboard, events: renderEvents, event: renderEventDetail, payables: renderPayables, collect: renderCollect, settings: renderSettings };
  main.innerHTML = (views[ui.tab] || renderDashboard)();
  bindMain();
}

function periodFilter(list) {
  const p = ui.period; if (p === 'all') return list;
  const t = new Date(); const y = t.getFullYear(), m = t.getMonth();
  let from, to;
  if (p === 'month') { from = new Date(y, m, 1); to = new Date(y, m + 1, 0); }
  else if (p === 'lastmonth') { from = new Date(y, m - 1, 1); to = new Date(y, m, 0); }
  else if (p === 'year') { from = new Date(y, 0, 1); to = new Date(y, 11, 31); }
  else if (p === 'custom') { from = ui.from ? new Date(ui.from) : new Date(1970, 0, 1); to = ui.to ? new Date(ui.to) : new Date(2100, 0, 1); }
  const f = from.toISOString().slice(0, 10), tt = to.toISOString().slice(0, 10);
  return list.filter(e => e.eventDate >= f && e.eventDate <= tt);
}
function statCard(label, value, cls = '', sub = '') { return `<div class="stat ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${money(value)}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`; }

function renderDashboard() {
  const evs = periodFilter(DB.events.filter(e => e.status !== 'cancelled'));
  const tot = evs.reduce((a, e) => { const c = calc(e); for (const k in c) a[k] = (a[k] || 0) + c[k]; return a; }, {});
  const collectList = evs.filter(e => calc(e).toCollect > 0.005).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const payList = allPayables().filter(x => x.due > 0.005 && (x.ev === null || evs.includes(x.ev))).sort((a, b) => (a.p.dueDate || '9999').localeCompare(b.p.dueDate || '9999'));
  const upcoming = DB.events.filter(e => e.status === 'upcoming' && daysUntil(e.eventDate) >= 0).sort((a, b) => a.eventDate.localeCompare(b.eventDate)).slice(0, 6);
  const otherDue = sum(allPayables().filter(x => x.ev === null), x => Math.max(0, x.due));
  const totalNeedToPay = (tot.payablesDue || 0) + otherDue;
  const profitRows = evs.map(e => ({ e, c: calc(e) })).sort((a, b) => b.c.billed - a.c.billed).slice(0, 8);
  const maxBilled = Math.max(1, ...profitRows.map(r => r.c.billed));
  return `
  <section class="page">
    <div class="page-head"><h2>Dashboard</h2>
      <div class="filters">
        <select id="periodSel">${['all|All time', 'month|This month', 'lastmonth|Last month', 'year|This year', 'custom|Custom'].map(o => { const [v, l] = o.split('|'); return `<option value="${v}" ${ui.period === v ? 'selected' : ''}>${l}</option>`; }).join('')}</select>
        ${ui.period === 'custom' ? `<input type="date" id="fromDate" value="${ui.from}"> <input type="date" id="toDate" value="${ui.to}">` : ''}
      </div></div>
    <p class="muted small">${evs.length} event${evs.length === 1 ? '' : 's'} (cancelled excluded) · by event date</p>
    <div class="stats">
      ${statCard('Total billed', tot.billed, 'blue')}
      ${statCard('Received', tot.received, 'green', `${tot.billed ? Math.round(tot.received / tot.billed * 100) : 0}% of billed`)}
      ${statCard('Need to receive', tot.toCollect, tot.toCollect > 0 ? 'amber' : 'green', `${collectList.length} event${collectList.length === 1 ? '' : 's'} pending`)}
      ${statCard('Need to pay', totalNeedToPay, totalNeedToPay > 0 ? 'red' : 'green', `events ${money(tot.payablesDue)} · other/personal ${money(otherDue)}`)}
      ${statCard('Total expenses', tot.totalCost, '', `direct ${money(tot.expenses)} + vendors ${money(tot.payablesTotal)}`)}
      ${statCard('Paid out so far', tot.expenses + tot.payablesPaid, '', `direct ${money(tot.expenses)} + vendors ${money(tot.payablesPaid)}`)}
      ${statCard('Expected profit', tot.profit, tot.profit >= 0 ? 'green' : 'red', `${tot.billed ? Math.round(tot.profit / tot.billed * 100) : 0}% margin`)}
      ${statCard('Cash position now', tot.cashNow, tot.cashNow >= 0 ? 'green' : 'red', 'received − paid out')}
    </div>

    <div class="grid2">
      <div class="card">
        <h3>💰 Need to receive <span class="pill">${money(tot.toCollect)}</span></h3>
        ${collectList.length ? `<ul class="list">${collectList.slice(0, 8).map(e => { const c = calc(e); return `<li class="row" data-open="${e.id}"><div><b>${esc(e.name)}</b><div class="muted small">${esc(e.client)} · ${fmtDate(e.eventDate)}</div></div><div class="right"><b class="amber">${money(c.toCollect)}</b><div class="muted small">of ${money(c.billed)}</div></div></li>`; }).join('')}</ul>${collectList.length > 8 ? `<button class="btn link" data-go="collect">See all ${collectList.length} →</button>` : ''}` : '<p class="muted">All collected 🎉</p>'}
      </div>
      <div class="card">
        <h3>💸 Need to pay <span class="pill">${money(totalNeedToPay)}</span></h3>
        ${payList.length ? `<ul class="list">${payList.slice(0, 8).map(x => `<li class="row" ${x.ev ? `data-open="${x.ev.id}"` : 'data-go="payables"'}><div><b>${esc(x.p.vendor)}</b><div class="muted small">${esc(x.p.desc || x.p.category || '')} · ${x.ev ? esc(x.ev.name) : '<i>personal / other</i>'}${x.p.dueDate ? ` · due ${fmtDate(x.p.dueDate)}` : ''}</div></div><div class="right"><b class="red">${money(x.due)}</b><div class="muted small">of ${money(x.p.amount)}</div></div></li>`).join('')}</ul>${payList.length > 8 ? `<button class="btn link" data-go="payables">See all ${payList.length} →</button>` : ''}` : '<p class="muted">Nothing pending 🎉</p>'}
      </div>
      <div class="card">
        <h3>📅 Upcoming events</h3>
        ${upcoming.length ? `<ul class="list">${upcoming.map(e => { const d = daysUntil(e.eventDate); return `<li class="row" data-open="${e.id}"><div><b>${esc(e.name)}</b><div class="muted small">${esc(e.client)} · ${esc(e.venue || '')}</div></div><div class="right"><b>${fmtDate(e.eventDate)}</b><div class="muted small">${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}</div></div></li>`; }).join('')}</ul>` : '<p class="muted">No upcoming events. Tap ＋ to add one.</p>'}
      </div>
      <div class="card">
        <h3>📈 Billing vs profit</h3>
        ${profitRows.length ? profitRows.map(r => `<div class="bar-row" data-open="${r.e.id}"><div class="bar-label"><span>${esc(r.e.name)}</span><span class="${r.c.profit >= 0 ? 'green' : 'red'}">${money(r.c.profit)}</span></div><div class="bar"><div class="bar-fill" style="width:${Math.max(2, r.c.billed / maxBilled * 100)}%"><div class="bar-cost" style="width:${r.c.billed ? Math.min(100, r.c.totalCost / r.c.billed * 100) : 0}%"></div></div></div></div>`).join('') + '<p class="muted small">Bar = billed, dark part = cost, remainder = profit</p>' : '<p class="muted">Add events to see the chart.</p>'}
      </div>
    </div>
  </section>`;
}

function eventCard(e) {
  const c = calc(e); const pct = c.billed ? Math.min(100, c.received / c.billed * 100) : 0;
  return `<div class="event-card" data-open="${e.id}">
    <div class="ec-head"><div><b>${esc(e.name || '(untitled)')}</b><div class="muted small">${esc(e.client)}${e.venue ? ' · ' + esc(e.venue) : ''}</div></div><span class="status ${e.status}">${e.status}</span></div>
    <div class="ec-meta muted small">📅 ${fmtDate(e.eventDate)} · closed ${fmtDate(e.closedOn)}</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="ec-nums">
      <div><span class="muted">Billed</span><b>${money(c.billed)}</b></div>
      <div><span class="muted">Received</span><b class="green">${money(c.received)}</b></div>
      <div><span class="muted">To collect</span><b class="${c.toCollect > 0 ? 'amber' : ''}">${money(c.toCollect)}</b></div>
      <div><span class="muted">To pay</span><b class="${c.payablesDue > 0 ? 'red' : ''}">${money(c.payablesDue)}</b></div>
      <div><span class="muted">Profit</span><b class="${c.profit >= 0 ? 'green' : 'red'}">${money(c.profit)}</b></div>
    </div></div>`;
}
function renderEvents() {
  let list = DB.events.slice();
  if (ui.status !== 'all') list = list.filter(e => e.status === ui.status);
  if (ui.search) { const q = ui.search.toLowerCase(); list = list.filter(e => [e.name, e.client, e.phone, e.venue, e.notes].join(' ').toLowerCase().includes(q)); }
  const sorters = { 'date-desc': (a, b) => b.eventDate.localeCompare(a.eventDate), 'date-asc': (a, b) => a.eventDate.localeCompare(b.eventDate), 'billed': (a, b) => calc(b).billed - calc(a).billed, 'collect': (a, b) => calc(b).toCollect - calc(a).toCollect, 'updated': (a, b) => b.updatedAt - a.updatedAt };
  list.sort(sorters[ui.sort] || sorters['date-desc']);
  const counts = STATUSES.reduce((a, s) => (a[s] = DB.events.filter(e => e.status === s).length, a), {});
  return `<section class="page">
    <div class="page-head"><h2>Events & clients</h2><button class="btn primary" id="addEventBtn">＋ New event</button></div>
    <div class="toolbar">
      <input type="search" id="searchBox" placeholder="Search name, client, phone, venue…" value="${esc(ui.search)}">
      <select id="sortSel">${['date-desc|Newest event date', 'date-asc|Oldest event date', 'updated|Recently updated', 'billed|Highest billed', 'collect|Most to collect'].map(o => { const [v, l] = o.split('|'); return `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${l}</option>`; }).join('')}</select>
    </div>
    <div class="chips">${['all', ...STATUSES].map(s => `<button class="chip ${ui.status === s ? 'active' : ''}" data-status="${s}">${s === 'all' ? `All (${DB.events.length})` : `${s} (${counts[s]})`}</button>`).join('')}</div>
    ${list.length ? `<div class="event-grid">${list.map(eventCard).join('')}</div>` : `<div class="empty"><p>${DB.events.length ? 'No events match.' : 'No events yet.'}</p><button class="btn primary" id="addEventBtn2">＋ Add your first event</button></div>`}
  </section>`;
}

function renderEventDetail() {
  const e = getEvent(ui.eventId); if (!e) { ui.tab = 'events'; return renderEvents(); }
  const c = calc(e);
  const payRows = (e.payments || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const expRows = (e.expenses || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  return `<section class="page">
    <button class="btn link back" data-go="events">← All events</button>
    <div class="detail-head">
      <div><h2>${esc(e.name)}</h2><div class="muted">${esc(e.client)}${e.phone ? ` · <a href="tel:${esc(e.phone)}">${esc(e.phone)}</a>` : ''}${e.venue ? ' · ' + esc(e.venue) : ''}</div>
      <div class="muted small">📅 Event ${fmtDate(e.eventDate)} · Closed on ${fmtDate(e.closedOn)}</div></div>
      <div class="detail-actions">
        <select id="statusSel" class="status-sel ${e.status}">${STATUSES.map(s => `<option ${e.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="btn" id="editEventBtn">✏️ Edit</button>
        <button class="btn" id="stmtBtn">📋 Client statement</button>
        <button class="btn danger-outline" id="deleteEventBtn">🗑</button>
      </div>
    </div>
    <div class="stats compact">
      ${statCard('Total billed', c.billed, 'blue')}
      ${statCard('Received', c.received, 'green')}
      ${statCard('Need to collect', c.toCollect, c.toCollect > 0 ? 'amber' : 'green')}
      ${statCard('Total expense by now', c.totalCost, '', `direct ${money(c.expenses)} + vendors ${money(c.payablesTotal)}`)}
      ${statCard('Expected profit', c.profit, c.profit >= 0 ? 'green' : 'red', `${c.billed ? Math.round(c.profit / c.billed * 100) : 0}% margin`)}
      ${statCard('Need to pay vendors', c.payablesDue, c.payablesDue > 0 ? 'red' : 'green', `paid ${money(c.payablesPaid)} of ${money(c.payablesTotal)}`)}
      ${statCard('Cash in hand from event', c.cashNow, c.cashNow >= 0 ? 'green' : 'red', 'received − paid out')}
    </div>

    <div class="card">
      <h3>💰 Payments received <span class="pill green">${money(c.received)}</span></h3>
      <form class="inline-form" id="payForm">
        <input type="number" step="any" min="0" name="amount" placeholder="Amount ₹" required>
        <input type="date" name="date" value="${today()}" required>
        <select name="mode">${opts(PAY_MODES, 'UPI')}</select>
        <input type="text" name="note" placeholder="Note (advance, 2nd instalment…)">
        <button class="btn primary">Add</button>
      </form>
      ${c.toCollect > 0 ? `<div class="quick"><button class="btn small" data-fill="pay" data-amt="${c.toCollect}">Fill balance ${money(c.toCollect)}</button></div>` : ''}
      ${payRows.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Note</th><th>Mode</th><th class="r">Amount</th><th></th></tr></thead><tbody>${payRows.map(p => `<tr><td>${fmtDate(p.date)}</td><td>${esc(p.note)}</td><td class="muted">${esc(p.mode)}</td><td class="r green">${money(p.amount)}</td><td class="r"><button class="x" data-del-pay="${p.id}" title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No payments yet.</p>'}
    </div>

    <div class="card">
      <h3>🧾 Direct expenses <span class="pill">${money(c.expenses)}</span></h3>
      <p class="muted small">Things already paid for this event (purchases, fuel, food…).</p>
      <form class="inline-form" id="expForm">
        <input type="text" name="desc" placeholder="What was it?" required>
        <input type="number" step="any" min="0" name="amount" placeholder="Amount ₹" required>
        <input type="date" name="date" value="${today()}" required>
        <select name="category">${opts(EXP_CATEGORIES, 'Misc')}</select>
        <button class="btn primary">Add</button>
      </form>
      ${expRows.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Expense</th><th>Category</th><th class="r">Amount</th><th></th></tr></thead><tbody>${expRows.map(x => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.desc)}</td><td class="muted">${esc(x.category)}</td><td class="r">${money(x.amount)}</td><td class="r"><button class="x" data-del-exp="${x.id}" title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No expenses yet.</p>'}
    </div>

    <div class="card">
      <h3>👷 Workers & services to pay <span class="pill red">${money(c.payablesDue)} due</span></h3>
      <p class="muted small">Money owed to workers, developers, decorators, suppliers… Pay in parts; remaining auto-updates.</p>
      <form class="inline-form" id="vendorForm">
        <input type="text" name="vendor" placeholder="Worker / service name" required list="vendorList">
        <datalist id="vendorList">${[...new Set(allPayables().map(x => x.p.vendor))].map(v => `<option value="${esc(v)}">`).join('')}</datalist>
        <input type="text" name="desc" placeholder="For what?">
        <select name="category">${opts(VENDOR_CATEGORIES, 'Worker / labour')}</select>
        <input type="number" step="any" min="0" name="amount" placeholder="Agreed amount ₹" required>
        <input type="date" name="dueDate" title="Due date (optional)">
        <button class="btn primary">Add</button>
      </form>
      ${(e.payables || []).length ? e.payables.map(p => payableBlock(e, p)).join('') : '<p class="muted small">No workers/services added yet.</p>'}
    </div>

    <div class="card">
      <h3>📝 Notes</h3>
      <textarea id="notesBox" rows="3" placeholder="Anything to remember about this event…">${esc(e.notes)}</textarea>
    </div>
  </section>`;
}
function payableBlock(e, p, { showEvent } = {}) {
  const paid = sum(p.payments), due = num(p.amount) - paid; const settled = due <= 0.005;
  const rows = (p.payments || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="payable ${settled ? 'settled' : ''}" data-pid="${p.id}" data-eid="${e ? e.id : ''}">
    <div class="pb-head">
      <div><b>${esc(p.vendor)}</b> <span class="muted small">${esc(p.category || '')}${p.desc ? ' · ' + esc(p.desc) : ''}</span>
        ${showEvent ? (e ? `<div class="muted small">🎪 <a href="#" data-open="${e.id}">${esc(e.name)}</a> · ${fmtDate(e.eventDate)}</div>` : `<div class="muted small">👤 Personal / other · added ${fmtDate(p.createdOn || '')}</div>`) : ''}
        ${p.dueDate ? `<div class="muted small">Due ${fmtDate(p.dueDate)}${!settled && daysUntil(p.dueDate) < 0 ? ' <span class="red">· overdue</span>' : ''}</div>` : ''}</div>
      <div class="right"><div class="${settled ? 'green' : 'red'}"><b>${settled ? 'Settled ✓' : money(due) + ' due'}</b></div><div class="muted small">paid ${money(paid)} of ${money(p.amount)}</div></div>
    </div>
    <div class="progress"><div class="${settled ? 'ok' : ''}" style="width:${num(p.amount) ? Math.min(100, paid / num(p.amount) * 100) : 0}%"></div></div>
    ${!settled ? `<div class="pb-actions">
      <button class="btn small primary" data-payfull="${p.id}">Pay full ${money(due)}</button>
      <button class="btn small" data-paypart="${p.id}">Pay partial</button>
      <button class="btn small" data-editvendor="${p.id}">Edit</button>
      <button class="btn small danger-outline" data-delvendor="${p.id}">Delete</button>
    </div>
    <form class="inline-form pay-part hidden" data-payform="${p.id}">
      <input type="number" step="any" min="0" max="${due}" name="amount" placeholder="Amount ₹" value="${due}" required>
      <input type="date" name="date" value="${today()}" required>
      <select name="mode">${opts(PAY_MODES, 'Cash')}</select>
      <input type="text" name="note" placeholder="Note">
      <button class="btn primary small">Record</button>
    </form>` : `<div class="pb-actions"><button class="btn small" data-editvendor="${p.id}">Edit</button><button class="btn small danger-outline" data-delvendor="${p.id}">Delete</button></div>`}
    ${rows.length ? `<table class="tbl small"><tbody>${rows.map(r => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.note)}</td><td class="muted">${esc(r.mode)}</td><td class="r">${money(r.amount)}</td><td class="r"><button class="x" data-del-vpay="${p.id}:${r.id}">✕</button></td></tr>`).join('')}</tbody></table>` : ''}
  </div>`;
}

function renderPayables() {
  const all = allPayables();
  const open = all.filter(x => x.due > 0.005);
  const totalDue = sum(open, x => x.due), totalPaid = sum(all, x => x.paid), totalAmt = sum(all, x => x.p.amount);
  const byVendor = {}; for (const x of open) { byVendor[x.p.vendor] = (byVendor[x.p.vendor] || 0) + x.due; }
  const vendors = Object.entries(byVendor).sort((a, b) => b[1] - a[1]);
  const list = (ui.showSettled ? all : open).sort((a, b) => (a.due > 0.005 ? 0 : 1) - (b.due > 0.005 ? 0 : 1) || (a.p.dueDate || '9999').localeCompare(b.p.dueDate || '9999') || b.ev.eventDate.localeCompare(a.ev.eventDate));
  return `<section class="page">
    <div class="page-head"><h2>Payments to make</h2><div class="row-btns"><label class="toggle"><input type="checkbox" id="showSettled" ${ui.showSettled ? 'checked' : ''}> show settled</label><button class="btn primary" id="addPayableBtn">＋ Add payment to make</button></div></div>
    <p class="muted small">Workers & services from events, plus anything else you owe — personal debts, loans, bills.</p>
    <div class="stats compact">
      ${statCard('Total to pay now', totalDue, totalDue > 0 ? 'red' : 'green', `events ${money(sum(open.filter(x => x.ev), x => x.due))} · other ${money(sum(open.filter(x => !x.ev), x => x.due))}`)}
      ${statCard('Paid to vendors so far', totalPaid, 'green')}
      ${statCard('Total committed', totalAmt, 'blue')}
    </div>
    ${vendors.length ? `<div class="card"><h3>By person / service</h3><div class="vendor-chips">${vendors.map(([v, d]) => `<span class="vchip"><b>${esc(v)}</b> ${money(d)}</span>`).join('')}</div></div>` : ''}
    <div class="card">
      ${list.length ? list.map(x => payableBlock(x.ev, x.p, { showEvent: true })).join('') : '<p class="muted">Nothing to pay 🎉 Use ＋ Add payment to make, or add workers/services inside an event.</p>'}
    </div>
  </section>`;
}

function renderCollect() {
  const list = DB.events.filter(e => e.status !== 'cancelled').map(e => ({ e, c: calc(e) })).filter(x => ui.showSettled || x.c.toCollect > 0.005).sort((a, b) => (a.c.toCollect > 0.005 ? 0 : 1) - (b.c.toCollect > 0.005 ? 0 : 1) || a.e.eventDate.localeCompare(b.e.eventDate));
  const total = sum(list.filter(x => x.c.toCollect > 0), x => x.c.toCollect);
  return `<section class="page">
    <div class="page-head"><h2>Payments to receive</h2><label class="toggle"><input type="checkbox" id="showSettled" ${ui.showSettled ? 'checked' : ''}> show fully paid</label></div>
    <div class="stats compact">${statCard('Total to collect', total, total > 0 ? 'amber' : 'green', `${list.filter(x => x.c.toCollect > 0.005).length} client${list.length === 1 ? '' : 's'}`)}</div>
    <div class="card">${list.length ? list.map(({ e, c }) => `<div class="payable ${c.toCollect <= 0.005 ? 'settled' : ''}">
      <div class="pb-head"><div><b><a href="#" data-open="${e.id}">${esc(e.name)}</a></b> <span class="muted small">${esc(e.client)}${e.phone ? ` · <a href="tel:${esc(e.phone)}">${esc(e.phone)}</a>` : ''}</span><div class="muted small">📅 ${fmtDate(e.eventDate)} · <span class="status ${e.status}">${e.status}</span></div></div>
      <div class="right"><div class="${c.toCollect > 0.005 ? 'amber' : 'green'}"><b>${c.toCollect > 0.005 ? money(c.toCollect) + ' pending' : 'Fully paid ✓'}</b></div><div class="muted small">received ${money(c.received)} of ${money(c.billed)}</div></div></div>
      <div class="progress"><div class="${c.toCollect <= 0.005 ? 'ok' : ''}" style="width:${c.billed ? Math.min(100, c.received / c.billed * 100) : 0}%"></div></div>
      ${c.toCollect > 0.005 ? `<div class="pb-actions"><button class="btn small primary" data-recvfull="${e.id}">Received full ${money(c.toCollect)}</button><button class="btn small" data-recvpart="${e.id}">Received partial</button><button class="btn small" data-wa="${e.id}">WhatsApp reminder</button></div>
      <form class="inline-form pay-part hidden" data-recvform="${e.id}"><input type="number" step="any" min="0" name="amount" placeholder="Amount ₹" value="${c.toCollect}" required><input type="date" name="date" value="${today()}" required><select name="mode">${opts(PAY_MODES, 'UPI')}</select><input type="text" name="note" placeholder="Note"><button class="btn primary small">Record</button></form>` : ''}
    </div>`).join('') : '<p class="muted">Everything collected 🎉</p>'}</div>
  </section>`;
}

function renderSettings() {
  const isSync = session.mode === 'sync';
  return `<section class="page">
    <h2>Settings</h2>
    <div class="card"><h3>Business</h3><form id="bizForm" class="inline-form"><input type="text" name="businessName" value="${esc(DB.settings.businessName)}" placeholder="Business name"><button class="btn primary">Save</button></form></div>
    <div class="card"><h3>Sync <span class="pill ${isSync ? 'green' : ''}">${isSync ? 'GitHub · ' + esc(GitSync.repo) : 'Local only'}</span></h3>
      <p class="muted small">${isSync ? 'Every change is saved to your private GitHub repo. Open this app on any device, enter the password + token once, and your data follows you.' : 'Data is only on this device. Connect a private GitHub repo to back up and use on phone + laptop.'}</p>
      <form id="syncForm" class="form">
        <label>Data repo (owner/repo)<input type="text" name="repo" value="${esc(localStorage.getItem(LS.repo) || DEFAULT_REPO)}"></label>
        <label>GitHub fine-grained token<input type="password" name="token" placeholder="${isSync ? '•••••••• (leave blank to keep current)' : 'github_pat_…'}"></label>
        <details><summary>How to create the token</summary><ol class="small"><li>GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token.</li><li>Repository access: <b>Only select repositories</b> → pick <code>${esc(DEFAULT_REPO)}</code>.</li><li>Permissions → Repository → <b>Contents: Read and write</b>. Nothing else.</li><li>Expiration: pick 1 year (you can set a new one here anytime).</li></ol></details>
        <div class="row-btns"><button class="btn primary">${isSync ? 'Update & sync' : 'Connect & sync'}</button>${isSync ? '<button type="button" class="btn" id="syncNowBtn">Sync now</button>' : ''}</div>
        <p class="auth-error" id="syncErr">${syncState.lastError ? esc(syncState.lastError) : ''}</p>
      </form></div>
    <div class="card"><h3>Password</h3><form id="pwForm" class="form"><label>Current password<input type="password" name="cur" required></label><label>New password<input type="password" name="new" minlength="4" required></label><label>Repeat new password<input type="password" name="new2" minlength="4" required></label><button class="btn primary">Change password</button><p class="auth-error" id="pwErr"></p></form></div>
    <div class="card"><h3>Backup</h3><div class="row-btns"><button class="btn" id="exportBtn">⬇ Export JSON</button><button class="btn" id="importBtn">⬆ Import JSON</button><input type="file" id="importFile" accept="application/json" class="hidden"><button class="btn" id="exportCsvBtn">⬇ Export CSV (events)</button></div>
      <p class="muted small">${DB.events.length} events · ${allPayables().length} payables · last change ${new Date(Math.max(0, ...DB.events.map(e => e.updatedAt || 0))).toLocaleString()}</p></div>
    <div class="card danger"><h3>Danger zone</h3><div class="row-btns"><button class="btn danger-outline" id="wipeBtn">Delete ALL events</button><button class="btn danger-outline" id="resetDeviceBtn">Sign out & forget this device</button></div></div>
  </section>`;
}

/* ---------- modal forms ---------- */
function openModal(html) { $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden'); setTimeout(() => $('#modalCard input,#modalCard select')?.focus(), 30); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openEventForm(ev) {
  const e = ev || newEvent();
  openModal(`<form id="eventForm" class="form">
    <h3>${ev ? 'Edit event' : 'New event / client'}</h3>
    <div class="form-grid">
      <label class="span2">Event name*<input name="name" value="${esc(e.name)}" required placeholder="e.g. Sharma wedding decor"></label>
      <label>Client name*<input name="client" value="${esc(e.client)}" required></label>
      <label>Phone<input name="phone" value="${esc(e.phone)}" inputmode="tel"></label>
      <label>Event date*<input type="date" name="eventDate" value="${esc(e.eventDate)}" required></label>
      <label>Venue<input name="venue" value="${esc(e.venue)}"></label>
      <label>Closed on (deal date)*<input type="date" name="closedOn" value="${esc(e.closedOn)}" required></label>
      <label>Closed cost (₹)*<input type="number" step="any" min="0" name="closedCost" value="${e.closedCost || ''}" required placeholder="Total agreed amount"></label>
      ${!ev ? `<label>Advance received (₹)<input type="number" step="any" min="0" name="advance" placeholder="0"></label><label>Advance date<input type="date" name="advanceDate" value="${today()}"></label>` : ''}
      <label>Status<select name="status">${opts(STATUSES, e.status)}</select></label>
      <label class="span2">Notes<textarea name="notes" rows="2">${esc(e.notes)}</textarea></label>
    </div>
    <div class="row-btns"><button class="btn primary">${ev ? 'Save changes' : 'Create event'}</button><button type="button" class="btn" data-close>Cancel</button></div>
  </form>`);
  $('#eventForm').addEventListener('submit', (x) => {
    x.preventDefault(); const f = new FormData(x.target);
    const target = ev || e;
    ['name', 'client', 'phone', 'eventDate', 'venue', 'closedOn', 'status', 'notes'].forEach(k => target[k] = String(f.get(k) || '').trim());
    target.closedCost = num(f.get('closedCost'));
    if (!ev) { const adv = num(f.get('advance')); if (adv > 0) target.payments.push({ id: uid(), date: f.get('advanceDate') || today(), amount: adv, mode: 'UPI', note: 'Advance' }); DB.events.push(target); }
    touch(target); closeModal(); save({ silent: true }); go('event', target.id); toast(ev ? 'Saved' : 'Event created');
  });
}
function openVendorForm(e, p) {
  openModal(`<form id="vendorEdit" class="form"><h3>Edit worker / service</h3><div class="form-grid">
    <label>Name*<input name="vendor" value="${esc(p.vendor)}" required></label>
    <label>Category<select name="category">${opts(e ? VENDOR_CATEGORIES : OTHER_CATEGORIES, p.category)}</select></label>
    <label class="span2">For what<input name="desc" value="${esc(p.desc)}"></label>
    <label>Agreed amount (₹)*<input type="number" step="any" min="0" name="amount" value="${p.amount}" required></label>
    <label>Due date<input type="date" name="dueDate" value="${esc(p.dueDate || '')}"></label></div>
    <div class="row-btns"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`);
  $('#vendorEdit').addEventListener('submit', (x) => { x.preventDefault(); const f = new FormData(x.target); p.vendor = f.get('vendor').trim(); p.category = f.get('category'); p.desc = f.get('desc').trim(); p.amount = num(f.get('amount')); p.dueDate = f.get('dueDate') || ''; touchPayable(e, p); closeModal(); save(); toast('Saved'); });
}
function openNewPayableForm() {
  const evOpts = DB.events.filter(e => e.status !== 'cancelled').sort((a, b) => b.eventDate.localeCompare(a.eventDate)).map(e => `<option value="${e.id}">${esc(e.name)} · ${esc(e.client)}</option>`).join('');
  openModal(`<form id="newPayable" class="form"><h3>Add a payment to make</h3><div class="form-grid">
    <label class="span2">Link to event<select name="event"><option value="">— None (personal / other debt) —</option>${evOpts}</select></label>
    <label>To whom*<input name="vendor" required placeholder="Person, shop, bank…" list="vendorList2"><datalist id="vendorList2">${[...new Set(allPayables().map(x => x.p.vendor))].map(v => `<option value="${esc(v)}">`).join('')}</datalist></label>
    <label>Category<select name="category">${opts(OTHER_CATEGORIES, 'Personal debt')}</select></label>
    <label class="span2">For what<input name="desc" placeholder="e.g. borrowed for bike repair"></label>
    <label>Total amount (₹)*<input type="number" step="any" min="0" name="amount" required></label>
    <label>Already paid (₹)<input type="number" step="any" min="0" name="paid" placeholder="0"></label>
    <label>Due date<input type="date" name="dueDate"></label>
    <label>Added on<input type="date" name="createdOn" value="${today()}"></label></div>
    <div class="row-btns"><button class="btn primary">Add</button><button type="button" class="btn" data-close>Cancel</button></div></form>`);
  const catSel = $('#newPayable [name=category]');
  $('#newPayable [name=event]').addEventListener('change', (x) => { catSel.innerHTML = opts(x.target.value ? VENDOR_CATEGORIES : OTHER_CATEGORIES, x.target.value ? 'Worker / labour' : 'Personal debt'); });
  $('#newPayable').addEventListener('submit', (x) => {
    x.preventDefault(); const f = new FormData(x.target);
    const p = { id: uid(), vendor: f.get('vendor').trim(), desc: f.get('desc').trim(), category: f.get('category'), amount: num(f.get('amount')), dueDate: f.get('dueDate') || '', createdOn: f.get('createdOn') || today(), payments: [] };
    const paid = num(f.get('paid')); if (paid > 0) p.payments.push({ id: uid(), date: p.createdOn, amount: paid, mode: 'Cash', note: 'Already paid' });
    const ev = f.get('event') ? getEvent(f.get('event')) : null;
    if (ev) { ev.payables.push(p); touch(ev); } else { p.updatedAt = now(); DB.payables.push(p); }
    closeModal(); save(); toast(ev ? `Added to ${ev.name}` : 'Added to your payments');
  });
}

function clientStatement(e) {
  const c = calc(e); const biz = DB.settings.businessName || 'Event Ledger';
  const lines = [`*${biz}* — Payment statement`, `Event: ${e.name}`, `Client: ${e.client}`, `Event date: ${fmtDate(e.eventDate)}`, ``, `Total amount: ${money(c.billed)}`];
  if (e.payments.length) { lines.push(`Received:`); e.payments.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(p => lines.push(`  • ${fmtDate(p.date)} — ${money(p.amount)}${p.note ? ` (${p.note})` : ''}`)); }
  lines.push(`Total received: ${money(c.received)}`, `*Balance due: ${money(Math.max(0, c.toCollect))}*`);
  return lines.join('\n');
}
function shareText(text) {
  if (navigator.share) navigator.share({ text }).catch(() => { });
  else navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'));
}

/* ---------- event binding on main ---------- */
function bindMain() {
  const main = $('#main');
  $$('[data-open]', main).forEach(el => el.addEventListener('click', (x) => { if (x.target.closest('button,form,input,select,a[href^="tel"]')) return; x.preventDefault(); go('event', el.dataset.open); }));
  $$('[data-go]', main).forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  $$('[data-close]').forEach(el => el.addEventListener('click', closeModal));
  $('#addEventBtn')?.addEventListener('click', () => openEventForm());
  $('#addEventBtn2')?.addEventListener('click', () => openEventForm());
  $('#periodSel')?.addEventListener('change', (x) => { ui.period = x.target.value; render(); });
  $('#fromDate')?.addEventListener('change', (x) => { ui.from = x.target.value; render(); });
  $('#toDate')?.addEventListener('change', (x) => { ui.to = x.target.value; render(); });
  $('#searchBox')?.addEventListener('input', (x) => { ui.search = x.target.value; const pos = x.target.selectionStart; render(); const b = $('#searchBox'); b.focus(); b.setSelectionRange(pos, pos); });
  $('#sortSel')?.addEventListener('change', (x) => { ui.sort = x.target.value; render(); });
  $$('[data-status]', main).forEach(b => b.addEventListener('click', () => { ui.status = b.dataset.status; render(); }));
  $('#showSettled')?.addEventListener('change', (x) => { ui.showSettled = x.target.checked; render(); });

  // event detail
  const e = ui.tab === 'event' ? getEvent(ui.eventId) : null;
  if (e) {
    $('#statusSel').addEventListener('change', (x) => { e.status = x.target.value; touch(e); save(); toast(`Marked ${e.status}`); });
    $('#editEventBtn').addEventListener('click', () => openEventForm(e));
    $('#stmtBtn').addEventListener('click', () => shareText(clientStatement(e)));
    $('#deleteEventBtn').addEventListener('click', () => { if (confirm(`Delete "${e.name}" and all its payments/expenses?`)) { DB.deleted[e.id] = now(); DB.events = DB.events.filter(x => x.id !== e.id); save({ silent: true }); go('events'); toast('Deleted'); } });
    $('#payForm').addEventListener('submit', (x) => { x.preventDefault(); const f = new FormData(x.target); e.payments.push({ id: uid(), date: f.get('date'), amount: num(f.get('amount')), mode: f.get('mode'), note: String(f.get('note')).trim() }); touch(e); save(); toast('Payment added'); });
    $$('[data-fill="pay"]').forEach(b => b.addEventListener('click', () => { const i = $('#payForm [name=amount]'); i.value = b.dataset.amt; i.focus(); }));
    $('#expForm').addEventListener('submit', (x) => { x.preventDefault(); const f = new FormData(x.target); e.expenses.push({ id: uid(), date: f.get('date'), desc: String(f.get('desc')).trim(), amount: num(f.get('amount')), category: f.get('category') }); touch(e); save(); toast('Expense added'); });
    $('#vendorForm').addEventListener('submit', (x) => { x.preventDefault(); const f = new FormData(x.target); e.payables.push({ id: uid(), vendor: String(f.get('vendor')).trim(), desc: String(f.get('desc')).trim(), category: f.get('category'), amount: num(f.get('amount')), dueDate: f.get('dueDate') || '', payments: [] }); touch(e); save(); toast('Added to payables'); });
    $$('[data-del-pay]').forEach(b => b.addEventListener('click', () => { if (confirm('Delete this payment?')) { e.payments = e.payments.filter(p => p.id !== b.dataset.delPay); touch(e); save(); } }));
    $$('[data-del-exp]').forEach(b => b.addEventListener('click', () => { if (confirm('Delete this expense?')) { e.expenses = e.expenses.filter(p => p.id !== b.dataset.delExp); touch(e); save(); } }));
    $('#notesBox').addEventListener('change', (x) => { e.notes = x.target.value; touch(e); save({ silent: true }); toast('Notes saved'); });
  }

  // payable actions (event detail + payables tab)
  const findPayable = (pid) => { for (const ev of DB.events) { const p = (ev.payables || []).find(p => p.id === pid); if (p) return { ev, p }; } const p = (DB.payables || []).find(p => p.id === pid); return p ? { ev: null, p } : null; };
  $('#addPayableBtn')?.addEventListener('click', openNewPayableForm);
  $$('[data-payfull]', main).forEach(b => b.addEventListener('click', () => { const { ev, p } = findPayable(b.dataset.payfull); const due = num(p.amount) - sum(p.payments); if (confirm(`Record full payment of ${money(due)} to ${p.vendor}?`)) { p.payments.push({ id: uid(), date: today(), amount: due, mode: 'Cash', note: 'Full settlement' }); touchPayable(ev, p); save(); toast(`Paid ${p.vendor} in full`); } }));
  $$('[data-paypart]', main).forEach(b => b.addEventListener('click', () => { const f = $(`[data-payform="${b.dataset.paypart}"]`, main); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.querySelector('[name=amount]').focus(); }));
  $$('[data-payform]', main).forEach(f => f.addEventListener('submit', (x) => { x.preventDefault(); const { ev, p } = findPayable(f.dataset.payform); const fd = new FormData(f); const amt = num(fd.get('amount')); if (amt <= 0) return; p.payments.push({ id: uid(), date: fd.get('date'), amount: amt, mode: fd.get('mode'), note: String(fd.get('note')).trim() }); touchPayable(ev, p); save(); toast(`Recorded ${money(amt)} to ${p.vendor}`); }));
  $$('[data-editvendor]', main).forEach(b => b.addEventListener('click', () => { const { ev, p } = findPayable(b.dataset.editvendor); openVendorForm(ev, p); }));
  $$('[data-delvendor]', main).forEach(b => b.addEventListener('click', () => { const { ev, p } = findPayable(b.dataset.delvendor); if (confirm(`Remove ${p.vendor} (${money(p.amount)})?`)) { if (ev) { ev.payables = ev.payables.filter(x => x.id !== p.id); touch(ev); } else { DB.deleted[p.id] = now(); DB.payables = DB.payables.filter(x => x.id !== p.id); } save(); } }));
  $$('[data-del-vpay]', main).forEach(b => b.addEventListener('click', () => { const [pid, rid] = b.dataset.delVpay.split(':'); const { ev, p } = findPayable(pid); if (confirm('Delete this payment record?')) { p.payments = p.payments.filter(r => r.id !== rid); touchPayable(ev, p); save(); } }));

  // collect tab
  $$('[data-recvfull]', main).forEach(b => b.addEventListener('click', () => { const ev = getEvent(b.dataset.recvfull); const c = calc(ev); if (confirm(`Record ${money(c.toCollect)} received from ${ev.client}?`)) { ev.payments.push({ id: uid(), date: today(), amount: c.toCollect, mode: 'UPI', note: 'Final payment' }); touch(ev); save(); toast('Recorded'); } }));
  $$('[data-recvpart]', main).forEach(b => b.addEventListener('click', () => { const f = $(`[data-recvform="${b.dataset.recvpart}"]`, main); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.querySelector('[name=amount]').focus(); }));
  $$('[data-recvform]', main).forEach(f => f.addEventListener('submit', (x) => { x.preventDefault(); const ev = getEvent(f.dataset.recvform); const fd = new FormData(f); const amt = num(fd.get('amount')); if (amt <= 0) return; ev.payments.push({ id: uid(), date: fd.get('date'), amount: amt, mode: fd.get('mode'), note: String(fd.get('note')).trim() }); touch(ev); save(); toast(`Recorded ${money(amt)}`); }));
  $$('[data-wa]', main).forEach(b => b.addEventListener('click', () => { const ev = getEvent(b.dataset.wa); const text = clientStatement(ev); const ph = (ev.phone || '').replace(/\D/g, ''); const url = `https://wa.me/${ph ? (ph.length === 10 ? '91' + ph : ph) : ''}?text=${encodeURIComponent(text)}`; window.open(url, '_blank'); }));

  // settings
  $('#bizForm')?.addEventListener('submit', (x) => { x.preventDefault(); DB.settings.businessName = new FormData(x.target).get('businessName').trim() || 'Event Ledger'; DB.settings.updatedAt = now(); save(); toast('Saved'); });
  $('#syncForm')?.addEventListener('submit', async (x) => {
    x.preventDefault(); const fd = new FormData(x.target); const repo = fd.get('repo').trim(); let token = fd.get('token').trim(); const err = $('#syncErr'); err.textContent = '';
    if (!token && session.mode === 'sync') token = session.token;
    if (!token) { err.textContent = 'Token required'; return; }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { err.textContent = 'Repo must look like owner/repo'; return; }
    try { await unlock(session.password, token, 'sync', repo); toast('Connected & synced'); go('settings'); } catch (ex) { err.textContent = ex.message; }
  });
  $('#syncNowBtn')?.addEventListener('click', async () => { await syncNow(); render(); toast(syncState.status === 'synced' ? 'Synced' : 'Sync failed: ' + syncState.lastError, syncState.status === 'synced' ? '' : 'warn'); });
  $('#pwForm')?.addEventListener('submit', async (x) => {
    x.preventDefault(); const fd = new FormData(x.target); const err = $('#pwErr'); err.textContent = '';
    if (fd.get('new') !== fd.get('new2')) { err.textContent = 'New passwords do not match'; return; }
    if (!(await Crypto.verifyAuth(fd.get('cur'), DB.auth))) { err.textContent = 'Current password is wrong'; return; }
    DB.auth = await Crypto.makeAuth(fd.get('new')); DB.authUpdatedAt = now(); session.password = fd.get('new');
    if (session.mode === 'sync') localStorage.setItem(LS.vault, JSON.stringify(await Crypto.seal(session.password, session.token)));
    sessionStorage.setItem(LS.session, JSON.stringify({ password: session.password, token: session.token }));
    save({ immediate: true }); toast('Password changed'); x.target.reset();
  });
  $('#exportBtn')?.addEventListener('click', () => { const { auth, authUpdatedAt, ...rest } = DB; download(`event-ledger-${today()}.json`, JSON.stringify(rest, null, 2), 'application/json'); });
  $('#exportCsvBtn')?.addEventListener('click', () => {
    const rows = [['Event', 'Client', 'Phone', 'Event date', 'Closed on', 'Status', 'Billed', 'Received', 'To collect', 'Direct expenses', 'Vendor total', 'Vendor paid', 'Vendor due', 'Total cost', 'Profit']];
    for (const e of DB.events) { const c = calc(e); rows.push([e.name, e.client, e.phone, e.eventDate, e.closedOn, e.status, c.billed, c.received, c.toCollect, c.expenses, c.payablesTotal, c.payablesPaid, c.payablesDue, c.totalCost, c.profit]); }
    download(`event-ledger-${today()}.csv`, rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  });
  $('#importBtn')?.addEventListener('click', () => $('#importFile').click());
  $('#importFile')?.addEventListener('change', async (x) => {
    const file = x.target.files[0]; if (!file) return;
    try { const j = JSON.parse(await file.text()); if (!Array.isArray(j.events)) throw new Error('Not a ledger file'); const mode = confirm(`Import ${j.events.length} events.\n\nOK = merge into current data\nCancel = replace everything`) ? 'merge' : 'replace'; const { auth, authUpdatedAt } = DB; if (mode === 'merge') DB = merge(DB, { ...j, auth: null }); else DB = { ...emptyDB(), ...j }; DB.auth = auth; DB.authUpdatedAt = authUpdatedAt; DB.payables = DB.payables || []; DB.events.forEach(e => touch(e)); DB.payables.forEach(p => p.updatedAt = now()); save({ immediate: true }); toast('Imported'); } catch (ex) { alert('Import failed: ' + ex.message); }
  });
  $('#wipeBtn')?.addEventListener('click', () => { if (prompt('Type DELETE to remove all events') === 'DELETE') { DB.events.forEach(e => DB.deleted[e.id] = now()); DB.events = []; (DB.payables || []).forEach(p => DB.deleted[p.id] = now()); DB.payables = []; save({ immediate: true }); toast('All events deleted'); } });
  $('#resetDeviceBtn')?.addEventListener('click', () => { if (confirm('Sign out and remove ledger data from this device? Your GitHub copy stays.')) { Object.values(LS).forEach(k => localStorage.removeItem(k)); sessionStorage.clear(); location.reload(); } });
}
function download(name, content, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

boot();
