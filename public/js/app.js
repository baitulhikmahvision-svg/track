import {
  PRAYERS, PRAYER_NAMES, STATUSES, STATUS_LABELS, getPrayerTimes, omanDateStr, addDays, fmtTime, prettyDate, prayerLabel,
} from './shared.js';

/* ---------- tiny helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full/blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LET = { jamaah: 'J', individual: 'I', qaza: 'Q', missed: 'M' };
const GOOD = ['jamaah', 'individual', 'qaza'];

const S = {
  auth: LS.get('auth'), roster: [], config: null, skew: 0, error: null,
  day: null, log: {}, pushOn: false, pushOk: null,
  adminMode: false, login: { q: '', sel: null, code: '', err: '', busy: false }, alogin: { pw: '', err: '', busy: false },
  admin: { tab: 'day', day: null, data: null, q: '', filter: 'all', range: 7, sort: 'name', off: null, msg: '', loading: false },
  modal: null, deferred: null,
};
const now = () => Date.now() + S.skew;
const today = () => omanDateStr(now());
const isStudent = () => S.auth?.role === 's';
const isAdmin = () => S.auth?.role === 'a';

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- API ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (S.auth?.token) headers.Authorization = 'Bearer ' + S.auth.token;
  let res;
  try { res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('You are offline.'), { offline: true }); }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (res.status === 401 && S.auth) { await logout(true); throw new Error('Session expired. Please sign in again.'); }
  if (!res.ok) throw new Error(data?.error || 'Something went wrong. Please try again.');
  return data;
}

/* ---------- prayer times (cached) ---------- */
const tcache = {};
function timesFor(date) {
  const off = S.config?.settings?.offsets;
  const key = date + JSON.stringify(off);
  return (tcache[key] ||= getPrayerTimes(date, off));
}
function nextPrayer() {
  const t = today(), n = now(), times = timesFor(t);
  for (const p of PRAYERS) if (times[p] > n) return { p, at: times[p], date: t };
  const tm = addDays(t, 1);
  return { p: 'fajr', at: timesFor(tm).fajr, date: tm };
}
const until = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m} min`; };

/* ---------- boot ---------- */
async function boot() {
  try {
    const [roster, config] = await Promise.all([api('/roster'), api('/config')]);
    S.roster = roster; S.config = config; S.skew = config.serverTime - Date.now();
    LS.set('cfg', { roster, config });
  } catch (e) {
    const c = LS.get('cfg');
    if (c) { S.roster = c.roster; S.config = c.config; }
    else { S.error = e.message || 'Could not load the app.'; }
  }
  S.day = today();
  S.admin.day = today();
  if (isStudent()) { S.log = LS.get('mylog:' + S.auth.id, {}); loadMyLog(); refreshPushState(); }
  if (isAdmin()) loadOverview();
  render();
}

/* ---------- auth ---------- */
async function doLogin() {
  const code = $('#code')?.value || S.login.code;
  S.login.code = code; S.login.err = ''; S.login.busy = true; render();
  try {
    const r = await api('/login', { method: 'POST', body: { id: S.login.sel, code } });
    S.auth = { role: 's', token: r.token, id: r.student.id, name: r.student.name };
    LS.set('auth', S.auth);
    S.login = { q: '', sel: null, code: '', err: '', busy: false };
    S.log = LS.get('mylog:' + S.auth.id, {}); S.day = today();
    loadMyLog(); refreshPushState();
  } catch (e) { S.login.busy = false; S.login.err = e.message; }
  render();
}
async function doAdminLogin() {
  S.alogin.pw = $('#apw')?.value || ''; S.alogin.err = ''; S.alogin.busy = true; render();
  try {
    const r = await api('/admin/login', { method: 'POST', body: { password: S.alogin.pw } });
    S.auth = { role: 'a', token: r.token, name: 'President' };
    LS.set('auth', S.auth);
    S.alogin = { pw: '', err: '', busy: false }; S.adminMode = false;
    S.admin.off = null; S.admin.day = today();
    loadOverview();
  } catch (e) { S.alogin.busy = false; S.alogin.err = e.message; }
  render();
}
async function logout(expired = false) {
  if (isStudent() && !expired) {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await api('/me/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
    } catch { /* best effort */ }
  }
  S.auth = null; LS.del('auth'); S.log = {}; S.pushOn = false; S.modal = null; S.admin.data = null; S.admin.tab = 'day';
  render();
}

/* ---------- student: log ---------- */
const pendingKey = () => 'pending:' + S.auth.id;
async function loadMyLog() {
  try {
    await flushPending();
    const r = await api('/me/log');
    S.skew = r.serverTime - Date.now();
    S.log = r.days || {};
    for (const q of LS.get(pendingKey(), [])) applyLocal(q.date, q.prayer, q.status); // unsent edits win
    LS.set('mylog:' + S.auth.id, S.log);
    render();
  } catch { /* offline: keep cached copy */ }
}
function applyLocal(date, prayer, status) {
  S.log[date] ||= {};
  if (status === null) delete S.log[date][prayer]; else S.log[date][prayer] = status;
  if (!Object.keys(S.log[date]).length) delete S.log[date];
}
async function flushPending() {
  if (!isStudent()) return;
  let q = LS.get(pendingKey(), []);
  while (q.length) {
    try { await api('/me/log', { method: 'PUT', body: q[0] }); }
    catch (e) { if (e.offline) return; /* rejected by server -> drop it */ }
    q = q.slice(1); LS.set(pendingKey(), q);
  }
}
async function setStatus(date, prayer, status) {
  const cur = S.log[date]?.[prayer] ?? null;
  const next = cur === status ? null : status;
  applyLocal(date, prayer, next);
  LS.set('mylog:' + S.auth.id, S.log);
  render();
  try { await api('/me/log', { method: 'PUT', body: { date, prayer, status: next } }); }
  catch (e) {
    if (e.offline) {
      const q = LS.get(pendingKey(), []); q.push({ date, prayer, status: next }); LS.set(pendingKey(), q);
      toast('Saved on your phone. It will sync when you are online.');
    } else { toast(e.message); loadMyLog(); }
  }
}
function stats(days) {
  const t = today();
  let J = 0, I = 0, Q = 0, M = 0;
  for (let i = 0; i < 7; i++) for (const p of PRAYERS) {
    const s = days[addDays(t, -i)]?.[p];
    if (s === 'jamaah') J++; else if (s === 'individual') I++; else if (s === 'qaza') Q++; else if (s === 'missed') M++;
  }
  const full = (d) => PRAYERS.every((p) => GOOD.includes(days[d]?.[p]));
  let streak = 0, d = t;
  if (!full(d)) d = addDays(d, -1);
  while (full(d)) { streak++; d = addDays(d, -1); }
  return { J, I, Q, M, prayed: J + I + Q, streak };
}

/* ---------- notifications ---------- */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };

async function refreshPushState() {
  if (!pushSupported()) { S.pushOk = false; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    S.pushOn = !!sub && Notification.permission === 'granted';
    if (S.pushOn && isStudent()) api('/me/push', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {});
    S.pushOk = true; render();
  } catch { S.pushOk = false; }
}
async function enablePush() {
  try {
    if (!S.config.vapidPublicKey) return toast('Reminders are not switched on by the admin yet.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed.'); return render(); }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(S.config.vapidPublicKey) });
    await api('/me/push', { method: 'POST', body: { subscription: sub.toJSON() } });
    S.pushOn = true; render(); toast('Reminders are on. Jazakallah khair!');
  } catch (e) { toast(e.message || 'Could not turn on reminders.'); }
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api('/me/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
    S.pushOn = false; render(); toast('Reminders turned off.');
  } catch (e) { toast(e.message); }
}
async function testPush() {
  try { await api('/me/test-push', { method: 'POST' }); toast('Test sent - check your notifications.'); }
  catch (e) { toast(e.message); }
}

/* ---------- admin data ---------- */
async function loadOverview(silent = true) {
  if (!isAdmin()) return;
  S.admin.loading = true;
  try {
    const r = await api('/admin/overview?days=30');
    S.skew = r.serverTime - Date.now();
    S.admin.data = { students: r.students, at: Date.now() };
  } catch (e) { if (!silent || !S.admin.data) toast(e.message); }
  S.admin.loading = false; render();
}
const students = () => S.admin.data?.students || [];
function cellState(s, date, p) {
  const v = s.days[date]?.[p];
  if (v) return v;
  if (date === today() && now() < timesFor(date)[p]) return 'future';
  return 'none';
}
const cell = (st) => `<span class="cell c-${st}">${LET[st] || '·'}</span>`;

/* ---------- views ---------- */
function render() {
  const app = $('#app');
  let html;
  if (S.error) html = `<div class="center"><div><h2>Couldn't load</h2><p class="muted">${esc(S.error)}</p><button class="btn primary" data-act="reload">Try again</button></div></div>`;
  else if (!S.config) html = '<div class="center"><div class="spin"></div></div>';
  else if (!S.auth) html = S.adminMode ? viewAdminLogin() : viewLogin();
  else if (isAdmin()) html = viewAdmin();
  else html = viewStudent();
  const ae = document.activeElement;
  const id = ae && ae.id, sel = ae && ae.selectionStart;
  app.innerHTML = html;
  if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(sel, sel); } catch { /* not a text input */ } } }
  renderModal();
}

function viewLogin() {
  const L = S.login, q = L.q.trim().toLowerCase();
  const list = S.roster.filter((r) => !q || r.name.toLowerCase().includes(q));
  const sel = S.roster.find((r) => r.id === L.sel);
  return `<main class="wrap narrow">
    <img class="hero-logo" src="/logo.png" alt="Baitul Hikmah - Al Khuwair Branch">
    <h1 class="title">Salah Tracker</h1>
    <p class="sub">${sel ? 'Enter your personal code.' : 'Find your name to get started.'}</p>
    ${sel ? `<div class="picked"><span>${esc(sel.name)}</span><button class="link" data-act="unpick">Change</button></div>
      <form data-form="login" autocomplete="off">
        <label class="lbl" for="code">Your code</label>
        <input id="code" class="inp code" placeholder="ABC-123" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="8" value="${esc(L.code)}" data-in="logincode">
        ${L.err ? `<p class="err">${esc(L.err)}</p>` : ''}
        <button class="btn primary" ${L.busy ? 'disabled' : ''}>${L.busy ? 'Signing in…' : 'Sign in'}</button>
      </form>`
    : `<input id="q" class="inp" type="search" placeholder="Search your name…" value="${esc(L.q)}" data-in="loginq" autocomplete="off">
      <div class="names">${list.map((r) => `<button class="name" data-act="pick" data-id="${r.id}">${esc(r.name)}</button>`).join('') || '<p class="muted pad">No match</p>'}</div>`}
    <button class="link center-link" data-act="adminmode">President login</button>
  </main>`;
}

function viewAdminLogin() {
  const A = S.alogin;
  return `<main class="wrap narrow">
    <img class="hero-logo" src="/logo.png" alt="Baitul Hikmah">
    <h1 class="title">President login</h1>
    <p class="sub">See how everyone is doing with their salah.</p>
    <form data-form="alogin">
      <label class="lbl" for="apw">Password</label>
      <input id="apw" class="inp" type="password" autocomplete="current-password" value="${esc(A.pw)}" data-in="apw">
      ${A.err ? `<p class="err">${esc(A.err)}</p>` : ''}
      <button class="btn primary" ${A.busy ? 'disabled' : ''}>${A.busy ? 'Checking…' : 'Sign in'}</button>
    </form>
    <button class="link center-link" data-act="studentmode">← Back to student login</button>
  </main>`;
}

function reminderCard() {
  const head = '<h3>Prayer reminders</h3>';
  if (!S.config.vapidPublicKey) return `<div class="card">${head}<p>Reminders have not been switched on by the admin yet.</p></div>`;
  if (isIOS && !standalone()) return `<div class="card gold">${head}<p>On iPhone, first add this app to your Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b>. Then open it from there and turn on reminders.</p></div>`;
  if (!pushSupported()) return `<div class="card">${head}<p>This browser can't show reminders. Please use Chrome on Android, or Safari (iOS 16.4+) with the app added to your Home Screen.</p></div>`;
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return `<div class="card">${head}<p>Notifications are blocked for this app. Allow them in your phone's Settings → Notifications, then come back.</p></div>`;
  if (S.pushOn) return `<div class="card">${head.replace('</h3>', '<span class="badge-on">ON</span></h3>')}<p>You will be reminded at every prayer time in Muscat.</p>
    <div class="row"><button class="btn ghost sm" data-act="testpush">Send test</button><button class="btn ghost sm" data-act="pushoff">Turn off</button></div></div>`;
  return `<div class="card gold">${head}<p>Get a notification at each prayer time so you never miss jamaah.</p>
    <div class="row"><button class="btn primary sm" data-act="pushon">Turn on reminders</button></div></div>`;
}

function installCard() {
  if (standalone()) return '';
  if (S.deferred) return `<div class="card"><h3>Install the app</h3><p>Add Salah Tracker to your home screen for quick access.</p><div class="row"><button class="btn primary sm" data-act="install">Install</button></div></div>`;
  if (isIOS) return `<div class="card"><h3>Add to Home Screen</h3><p>Tap <b>Share</b> → <b>Add to Home Screen</b> to keep the app on your phone.</p></div>`;
  return `<div class="card"><h3>Add to Home Screen</h3><p>Open your browser menu (⋮) and choose <b>Install app</b> / <b>Add to Home screen</b>.</p></div>`;
}

function viewStudent() {
  const t = today(), day = S.day || t, times = timesFor(day), logDay = S.log[day] || {};
  const st = stats(S.log), first = S.auth.name.split(' ')[0];
  const n = nextPrayer();
  const tabs = [0, 1, 2].map((i) => addDays(t, -i));
  return `<main class="wrap">
    <div class="top"><img src="/logo.png" alt="Baitul Hikmah"><div class="who"><strong>${esc(S.auth.name)}</strong><button class="link" data-act="logout">Sign out</button></div></div>
    <div class="greet">Assalamu alaikum, ${esc(first)}</div>
    <div class="date">${prettyDate(t)} · Muscat</div>
    <div class="days">${tabs.map((d, i) => `<button class="day ${d === day ? 'on' : ''}" data-act="day" data-d="${d}">${i === 0 ? 'Today' : i === 1 ? 'Yesterday' : prettyDate(d)}</button>`).join('')}</div>
    ${day === t ? `<div class="next"><div><small>Next prayer</small><b>${prayerLabel(n.p, n.date)}</b></div><div class="in">${until(n.at - now())}<small><br>at ${fmtTime(n.at)}</small></div></div>` : ''}
    ${PRAYERS.map((p) => {
      const locked = day === t && now() < times[p] - 3 * 60000, cur = logDay[p];
      return `<section class="pcard ${cur ? 'st-' + cur : ''}">
        <div class="phead"><h3>${prayerLabel(p, day)}</h3><span class="ptime">${fmtTime(times[p])}</span></div>
        <div class="opts">${STATUSES.map((s) => `<button class="opt o-${s} ${cur === s ? 'on' : ''}" data-act="set" data-p="${p}" data-s="${s}" ${locked ? 'disabled' : ''}>${STATUS_LABELS[s]}</button>`).join('')}</div>
        ${locked ? `<p class="hint">Opens at ${fmtTime(times[p])}</p>` : ''}
      </section>`;
    }).join('')}
    <div class="stats"><div class="stat"><b>${st.J}</b><span>Jamaah<br>last 7 days</span></div><div class="stat"><b>${st.prayed}</b><span>Prayed<br>last 7 days</span></div><div class="stat"><b>${st.streak}</b><span>Day streak<br>all 5 prayed</span></div></div>
    ${reminderCard()}
    ${installCard()}
  </main>`;
}

/* ----- admin ----- */
function dayCounts(date) {
  const times = timesFor(date), out = {};
  for (const p of PRAYERS) {
    const c = { jamaah: 0, individual: 0, qaza: 0, missed: 0, none: 0, future: 0 };
    for (const s of students()) c[cellState(s, date, p)]++;
    out[p] = c;
  }
  return out;
}
const legend = `<div class="legend"><span><i class="dot" style="background:var(--jamaah)"></i>Jamaah</span><span><i class="dot" style="background:var(--individual)"></i>Individual</span><span><i class="dot" style="background:var(--qaza)"></i>Qaza</span><span><i class="dot" style="background:var(--missed)"></i>Missed</span><span><i class="dot" style="background:var(--none)"></i>Not logged</span></div>`;
const headCells = `<span class="cells h">${PRAYERS.map((p) => `<span>${PRAYER_NAMES[p][0]}</span>`).join('')}</span>`;

function viewAdmin() {
  const A = S.admin, tab = A.tab;
  const tabs = [['day', 'Day'], ['report', 'Report'], ['students', 'Students'], ['settings', 'Settings']];
  let body = '';
  if (!A.data) body = '<div class="center"><div class="spin"></div></div>';
  else if (tab === 'day') body = adminDay();
  else if (tab === 'report') body = adminReport();
  else if (tab === 'students') body = adminStudents();
  else body = adminSettings();
  return `<main class="wrap">
    <div class="top"><img src="/logo.png" alt="Baitul Hikmah"><div class="who"><strong>President</strong><button class="link" data-act="refresh">${A.loading ? 'Refreshing…' : 'Refresh'}</button></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${l}</button>`).join('')}</div>
    ${body}
  </main>`;
}

function filtered(date) {
  const A = S.admin, q = A.q.trim().toLowerCase();
  return students().filter((s) => {
    if (q && !s.name.toLowerCase().includes(q)) return false;
    const st = PRAYERS.map((p) => cellState(s, date, p));
    if (A.filter === 'pending') return st.includes('none');
    if (A.filter === 'missed') return st.includes('missed');
    if (A.filter === 'qaza') return st.includes('qaza');
    return true;
  });
}

function adminDay() {
  const A = S.admin, d = A.day, t = today(), c = dayCounts(d), total = students().length;
  const list = filtered(d);
  const seg = (p, k) => (c[p][k] ? `<i class="${k}" style="width:${(c[p][k] / total) * 100}%"></i>` : '');
  const chips = [['all', 'Everyone'], ['pending', 'Not logged yet'], ['missed', 'Missed'], ['qaza', 'Qaza']];
  return `<div class="dnav"><button data-act="dprev" ${d <= addDays(t, -29) ? 'disabled' : ''}>‹</button><b>${d === t ? 'Today · ' : ''}${prettyDate(d)}</b><button data-act="dnext" ${d >= t ? 'disabled' : ''}>›</button></div>
    <div class="card">${PRAYERS.map((p) => {
      const x = c[p], logged = x.jamaah + x.individual + x.qaza + x.missed;
      return `<div class="sumrow"><div class="h"><b>${prayerLabel(p, d)}</b><span>${logged}/${total} logged</span></div>
        <div class="bar">${seg(p, 'jamaah')}${seg(p, 'individual')}${seg(p, 'qaza')}${seg(p, 'missed')}</div>
        <div class="nums">Jamaah ${x.jamaah} · Individual ${x.individual} · Qaza ${x.qaza} · Missed ${x.missed}</div></div>`;
    }).join('')}${legend}</div>
    <input id="aq" class="inp" type="search" placeholder="Search a student…" value="${esc(A.q)}" data-in="aq" autocomplete="off">
    <div class="chips">${chips.map(([k, l]) => `<button class="chip ${A.filter === k ? 'on' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="alist"><div class="ahead"><span>${list.length} student${list.length === 1 ? '' : 's'}</span>${headCells}</div>
    ${list.map((s) => `<button class="arow" data-act="stu" data-id="${s.id}"><span class="aname">${esc(s.name)}</span><span class="cells">${PRAYERS.map((p) => cell(cellState(s, d, p))).join('')}</span></button>`).join('') || '<p class="muted pad">No students match.</p>'}</div>`;
}

function reportRows(range) {
  const t = today();
  return students().map((s) => {
    const r = { s, jamaah: 0, individual: 0, qaza: 0, missed: 0, none: 0 };
    for (let i = 0; i < range; i++) {
      const d = addDays(t, -i);
      for (const p of PRAYERS) { const st = cellState(s, d, p); if (st !== 'future') r[st]++; }
    }
    r.logged = r.jamaah + r.individual + r.qaza + r.missed;
    return r;
  });
}
function adminReport() {
  const A = S.admin;
  const rows = reportRows(A.range);
  const sorts = { name: (a, b) => a.s.name.localeCompare(b.s.name), jamaah: (a, b) => b.jamaah - a.jamaah, missed: (a, b) => b.missed + b.none - (a.missed + a.none), logged: (a, b) => a.logged - b.logged };
  rows.sort(sorts[A.sort]);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return `<div class="card"><h3>Summary · last ${A.range} days</h3>
    <p>Jamaah <b class="num-j">${sum('jamaah')}</b> · Individual <b>${sum('individual')}</b> · Qaza <b class="num-q">${sum('qaza')}</b> · Missed <b class="num-m">${sum('missed')}</b> · Not logged <b>${sum('none')}</b></p>
    <div class="row"><select class="inp" data-in="range" style="width:auto"><option value="7" ${A.range === 7 ? 'selected' : ''}>Last 7 days</option><option value="14" ${A.range === 14 ? 'selected' : ''}>Last 14 days</option><option value="30" ${A.range === 30 ? 'selected' : ''}>Last 30 days</option></select>
    <select class="inp" data-in="sort" style="width:auto"><option value="name" ${A.sort === 'name' ? 'selected' : ''}>A–Z</option><option value="jamaah" ${A.sort === 'jamaah' ? 'selected' : ''}>Most jamaah</option><option value="missed" ${A.sort === 'missed' ? 'selected' : ''}>Needs follow-up</option><option value="logged" ${A.sort === 'logged' ? 'selected' : ''}>Least logged</option></select></div>
    <div class="row"><button class="btn ghost sm" data-act="csv1">Download summary</button><button class="btn ghost sm" data-act="csv2">Download daily log</button></div></div>
    <div class="alist" style="overflow-x:auto"><table class="table"><thead><tr><th>Name</th><th>Jamaah</th><th>Indiv.</th><th>Qaza</th><th>Missed</th><th>Not logged</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-act="stu" data-id="${r.s.id}" style="cursor:pointer"><td>${esc(r.s.name)}</td><td class="num-j">${r.jamaah}</td><td>${r.individual}</td><td class="num-q">${r.qaza}</td><td class="num-m">${r.missed}</td><td>${r.none}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function adminStudents() {
  const A = S.admin, q = A.q.trim().toLowerCase();
  const list = students().filter((s) => !q || s.name.toLowerCase().includes(q));
  return `<div class="card"><h3>Student codes</h3><p>Each student signs in with their own name and code. Send them their code privately.</p>
    <div class="row"><button class="btn ghost sm" data-act="copyall">Copy all codes</button><span class="muted" style="align-self:center;font-size:13px">${students().filter((s) => s.notif).length} of ${students().length} have reminders on</span></div></div>
    <input id="aq" class="inp" type="search" placeholder="Search a student…" value="${esc(A.q)}" data-in="aq" autocomplete="off" style="margin-bottom:10px">
    <div class="alist">${list.map((s) => `<div class="srow"><span class="n">${esc(s.name)}${s.notif ? ' 🔔' : ''}</span><span class="c">${s.code}</span>
      <button class="btn ghost sm" data-act="copy" data-id="${s.id}">Copy</button><button class="btn ghost sm" data-act="wa" data-id="${s.id}">WhatsApp</button></div>`).join('')}</div>`;
}

function adminSettings() {
  const A = S.admin;
  A.off ||= { ...S.config.settings.offsets };
  const t = today(), tm = getPrayerTimes(t, A.off);
  return `<div class="card"><h3>Prayer time adjustment</h3>
    <p>Times are calculated for Al Khuwair. Compare with the official Oman Ministry of Awqaf timetable and add or subtract minutes so they match. Reminders follow these times.</p>
    <div style="margin-top:12px">${PRAYERS.map((p) => `<div class="field"><label for="off-${p}"><b>${PRAYER_NAMES[p]}</b> <span class="muted">· today ${fmtTime(tm[p])}</span></label><input id="off-${p}" class="inp" type="number" inputmode="numeric" min="-30" max="30" value="${A.off[p]}" data-in="off:${p}"></div>`).join('')}</div>
    <div class="row"><button class="btn primary sm" data-act="savesettings">Save times</button></div></div>
  <div class="card"><h3>Message to everyone</h3><p>Sends a notification to every student who has reminders on.</p>
    <textarea id="bmsg" class="inp" maxlength="200" placeholder="e.g. Jamaah for Maghrib at the masjid tonight, insha Allah." data-in="msg" style="margin-top:10px">${esc(A.msg)}</textarea>
    <div class="row"><button class="btn gold sm" data-act="broadcast">Send message</button></div></div>
  <div class="card"><h3>Account</h3><div class="row"><button class="btn ghost sm" data-act="logout">Sign out</button></div></div>`;
}

/* ----- modal ----- */
function renderModal() {
  const m = $('#modal');
  if (!S.modal) { m.innerHTML = ''; return; }
  const s = students().find((x) => x.id === S.modal.id);
  if (!s) { m.innerHTML = ''; return; }
  const t = today();
  const days = Array.from({ length: 14 }, (_, i) => addDays(t, -i));
  let J = 0, Q = 0, M = 0, N = 0;
  for (const d of days) for (const p of PRAYERS) { const st = cellState(s, d, p); if (st === 'jamaah') J++; else if (st === 'qaza') Q++; else if (st === 'missed') M++; else if (st === 'none') N++; }
  m.innerHTML = `<div class="sheet-bg" data-act="closemodal"><div class="sheet" data-stop>
    <h2>${esc(s.name)}</h2>
    <div class="bigcode">${s.code}</div>
    <p class="muted">${s.updated ? 'Last update: ' + new Date(s.updated + 4 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' (Muscat)' : 'Has not logged anything yet'} · Reminders ${s.notif ? 'on' : 'off'}</p>
    <p style="margin:10px 0"><b>Last 14 days:</b> Jamaah <b class="num-j">${J}</b> · Qaza <b class="num-q">${Q}</b> · Missed <b class="num-m">${M}</b> · Not logged ${N}</p>
    ${legend}
    <div class="drow"><b></b>${headCells}</div>
    ${days.map((d) => `<div class="drow"><span>${d === t ? 'Today' : prettyDate(d)}</span><span class="cells">${PRAYERS.map((p) => cell(cellState(s, d, p))).join('')}</span></div>`).join('')}
    <button class="btn ghost" data-act="closemodal">Close</button></div></div>`;
}

/* ---------- exports ---------- */
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function download(name, rows) {
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportSummary() {
  const rows = reportRows(S.admin.range).sort((a, b) => a.s.name.localeCompare(b.s.name));
  download(`salah-summary-${today()}.csv`, [['Name', 'Jamaah', 'Individual', 'Qaza', 'Missed', 'Not logged'], ...rows.map((r) => [r.s.name, r.jamaah, r.individual, r.qaza, r.missed, r.none])]);
}
function exportDaily() {
  const out = [['Name', 'Date', ...PRAYERS.map((p) => PRAYER_NAMES[p])]];
  for (const s of [...students()].sort((a, b) => a.name.localeCompare(b.name)))
    for (let i = 0; i < S.admin.range; i++) {
      const d = addDays(today(), -i);
      out.push([s.name, d, ...PRAYERS.map((p) => { const st = cellState(s, d, p); return st === 'none' ? 'Not logged' : st === 'future' ? '' : STATUS_LABELS[st]; })]);
    }
  download(`salah-daily-${today()}.csv`, out);
}
const inviteText = (s) => `Assalamu alaikum ${s.name}! Your Salah Tracker code is ${s.code}\n\nOpen ${location.origin} → choose your name → enter the code. Add it to your Home Screen and turn on reminders so you never miss a prayer.`;
async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(okMsg); } catch { toast('Could not copy.'); } ta.remove(); }
}

/* ---------- events ---------- */
const actions = {
  reload: () => location.reload(),
  pick: (el) => { S.login.sel = el.dataset.id; S.login.err = ''; S.login.code = ''; render(); $('#code')?.focus(); },
  unpick: () => { S.login.sel = null; S.login.err = ''; render(); },
  adminmode: () => { S.adminMode = true; render(); },
  studentmode: () => { S.adminMode = false; render(); },
  logout: () => logout(),
  day: (el) => { S.day = el.dataset.d; render(); },
  set: (el) => setStatus(S.day || today(), el.dataset.p, el.dataset.s),
  pushon: enablePush, pushoff: disablePush, testpush: testPush,
  install: async () => { const d = S.deferred; if (!d) return; d.prompt(); await d.userChoice; S.deferred = null; render(); },
  tab: (el) => { S.admin.tab = el.dataset.t; S.admin.q = ''; render(); window.scrollTo(0, 0); },
  refresh: () => loadOverview(false),
  dprev: () => { S.admin.day = addDays(S.admin.day, -1); render(); },
  dnext: () => { if (S.admin.day < today()) { S.admin.day = addDays(S.admin.day, 1); render(); } },
  filter: (el) => { S.admin.filter = el.dataset.f; render(); },
  stu: (el) => { S.modal = { id: el.dataset.id }; renderModal(); },
  closemodal: () => { S.modal = null; renderModal(); },
  csv1: exportSummary, csv2: exportDaily,
  copy: (el) => { const s = students().find((x) => x.id === el.dataset.id); copy(inviteText(s), 'Copied ' + s.name + '’s invite'); },
  copyall: () => copy(students().map((s) => `${s.name} - ${s.code}`).join('\n'), 'All codes copied'),
  wa: (el) => { const s = students().find((x) => x.id === el.dataset.id); window.open('https://wa.me/?text=' + encodeURIComponent(inviteText(s)), '_blank', 'noopener'); },
  savesettings: async () => {
    try { const r = await api('/admin/settings', { method: 'PUT', body: { offsets: S.admin.off } }); S.config.settings = r.settings; S.admin.off = { ...r.settings.offsets }; toast('Prayer times saved.'); render(); }
    catch (e) { toast(e.message); }
  },
  broadcast: async () => {
    const msg = S.admin.msg.trim();
    if (!msg) return toast('Write a message first.');
    if (!confirm('Send this message to all students with reminders on?')) return;
    try { const r = await api('/admin/broadcast', { method: 'POST', body: { message: msg } }); S.admin.msg = ''; toast(`Sent to ${r.delivered} of ${r.students} students.`); render(); }
    catch (e) { toast(e.message); }
  },
};
const inputs = {
  loginq: (v) => { S.login.q = v; render(); },
  logincode: (v) => { S.login.code = v; },
  apw: (v) => { S.alogin.pw = v; },
  aq: (v) => { S.admin.q = v; render(); },
  range: (v) => { S.admin.range = Number(v); render(); },
  sort: (v) => { S.admin.sort = v; render(); },
  msg: (v) => { S.admin.msg = v; },
};

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]') && !e.target.closest('[data-act]')) return;
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.classList.contains('sheet-bg') && e.target !== el) return; // click inside the sheet
  actions[el.dataset.act]?.(el, e);
});
document.addEventListener('input', (e) => {
  const key = e.target.dataset?.in;
  if (!key) return;
  if (key.startsWith('off:')) { S.admin.off[key.slice(4)] = e.target.value === '' ? 0 : Number(e.target.value); return; }
  inputs[key]?.(e.target.value);
});
document.addEventListener('submit', (e) => {
  const f = e.target.dataset?.form;
  if (!f) return;
  e.preventDefault();
  if (f === 'login') doLogin(); else if (f === 'alogin') doAdminLogin();
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferred = e; if (isStudent()) render(); });
window.addEventListener('online', () => { if (isStudent()) loadMyLog(); });

// keep clocks / countdowns fresh and pick up the latest data
setInterval(() => {
  if (document.hidden || !S.config) return;
  if (isStudent()) render();
  else if (isAdmin() && S.admin.tab !== 'settings' && !S.modal && document.activeElement?.tagName !== 'INPUT') loadOverview();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (isStudent()) loadMyLog(); else if (isAdmin()) loadOverview();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
