import { PRAYERS, STATUSES, LOCATION, PRAYER_NAMES, getPrayerTimes, omanDateStr, addDays } from '../../public/js/shared.js';
import { STUDENTS, allCodes, normCode, fmtCode, findStudent } from './lib/roster.mjs';
import { HttpError, json, sleep } from './lib/http.mjs';
import { secret, sign, requireAuth, safeEq } from './lib/auth.mjs';
import { getJSON, setJSON, listKeys, listValues, getSettings, pool } from './lib/store.mjs';
import { sendToStudent, pushConfigured } from './lib/push.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEEP_DAYS = 90;

async function readBody(req) {
  try { return (await req.json()) || {}; } catch { return {}; }
}

async function setNotifFlag(sid, on) {
  const blob = (await getJSON(`log/${sid}`)) || { days: {} };
  if (!!blob.notif === on) return;
  blob.notif = on;
  await setJSON(`log/${sid}`, blob);
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const m = req.method;
    const route = `${m} ${path}`;

    // ---------- public ----------
    if (route === 'GET /roster') return json(STUDENTS.map(({ id, name }) => ({ id, name })));

    if (route === 'GET /config') {
      return json({
        location: LOCATION,
        settings: await getSettings(),
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
        serverTime: Date.now(),
      });
    }

    if (route === 'POST /login') {
      const { id, code } = await readBody(req);
      const s = findStudent(id);
      const real = s ? allCodes(secret())[s.id] : null;
      if (!s || !safeEq(normCode(code), real)) { await sleep(700); throw new HttpError(403, 'That code is not correct. Check it and try again.'); }
      return json({ token: sign({ r: 's', id: s.id }, 180), student: { id: s.id, name: s.name } });
    }

    if (route === 'POST /admin/login') {
      const { password } = await readBody(req);
      const real = process.env.ADMIN_PASSWORD;
      if (!real) throw new HttpError(500, 'President password not set yet: add ADMIN_PASSWORD in Netlify.');
      if (!safeEq(password || '', real)) { await sleep(900); throw new HttpError(403, 'Wrong password.'); }
      return json({ token: sign({ r: 'a' }, 30) });
    }

    // ---------- student ----------
    if (path.startsWith('/me/')) {
      const { id } = requireAuth(req, 's');
      const student = findStudent(id);
      if (!student) throw new HttpError(401, 'Please sign in again.');

      if (route === 'GET /me/log') {
        const blob = (await getJSON(`log/${id}`)) || { days: {} };
        return json({ days: blob.days || {}, serverTime: Date.now() });
      }

      if (route === 'PUT /me/log') {
        const { date, prayer, status } = await readBody(req);
        const now = Date.now();
        const today = omanDateStr(now);
        if (!DATE_RE.test(date || '') || date > today || date < addDays(today, -3)) throw new HttpError(400, 'You can only update today and the last 3 days.');
        if (!PRAYERS.includes(prayer)) throw new HttpError(400, 'Unknown prayer.');
        if (status !== null && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
        if (date === today && status !== null) {
          const t = getPrayerTimes(date, (await getSettings()).offsets)[prayer];
          if (now < t - 3 * 60000) throw new HttpError(400, `It is not time for ${PRAYER_NAMES[prayer]} yet.`);
        }
        const blob = (await getJSON(`log/${id}`)) || { days: {} };
        blob.days ||= {};
        blob.days[date] ||= {};
        if (status === null) delete blob.days[date][prayer]; else blob.days[date][prayer] = status;
        if (!Object.keys(blob.days[date]).length) delete blob.days[date];
        const cutoff = addDays(today, -KEEP_DAYS);
        for (const d of Object.keys(blob.days)) if (d < cutoff) delete blob.days[d];
        blob.updated = now;
        await setJSON(`log/${id}`, blob);
        return json({ ok: true });
      }

      if (route === 'POST /me/push') {
        const { subscription } = await readBody(req);
        if (!subscription?.endpoint?.startsWith('https://') || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw new HttpError(400, 'Invalid subscription.');
        let subs = (await getJSON(`push/${id}`)) || [];
        subs = subs.filter((s) => s.endpoint !== subscription.endpoint);
        subs.push({ endpoint: subscription.endpoint, keys: subscription.keys });
        await setJSON(`push/${id}`, subs.slice(-5));
        await setNotifFlag(id, true);
        return json({ ok: true });
      }

      if (route === 'DELETE /me/push') {
        const { endpoint } = await readBody(req);
        let subs = (await getJSON(`push/${id}`)) || [];
        subs = endpoint ? subs.filter((s) => s.endpoint !== endpoint) : [];
        await setJSON(`push/${id}`, subs);
        await setNotifFlag(id, subs.length > 0);
        return json({ ok: true });
      }

      if (route === 'POST /me/test-push') {
        if (!pushConfigured()) throw new HttpError(500, 'Reminders are not set up on the server yet (VAPID keys missing).');
        const n = await sendToStudent(id, { title: 'Test reminder', body: 'Reminders are working. Insha Allah you will be reminded at every prayer time.', tag: 'salah-test', url: '/' });
        if (!n) throw new HttpError(400, 'Could not reach this device. Turn reminders off and on again.');
        return json({ ok: true });
      }
    }

    // ---------- president / admin ----------
    if (path.startsWith('/admin/') && path !== '/admin/login') {
      requireAuth(req, 'a');
      const codes = allCodes(secret());

      if (route === 'GET /admin/overview') {
        const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 30));
        const cutoff = addDays(omanDateStr(Date.now()), -(days - 1));
        const all = await listValues('log/'); // one database request for everyone
        const students = STUDENTS.map((s) => {
          const blob = all[`log/${s.id}`] || {};
          const d = {};
          for (const [k, v] of Object.entries(blob.days || {})) if (k >= cutoff) d[k] = v;
          return { id: s.id, name: s.name, code: fmtCode(codes[s.id]), days: d, updated: blob.updated || null, notif: !!blob.notif };
        });
        return json({ students, serverTime: Date.now() });
      }

      if (route === 'PUT /admin/settings') {
        const { offsets } = await readBody(req);
        const cur = await getSettings();
        const next = { ...cur.offsets };
        for (const p of PRAYERS) {
          const v = Number(offsets?.[p]);
          if (Number.isFinite(v)) next[p] = Math.max(-30, Math.min(30, Math.round(v)));
        }
        await setJSON('settings', { offsets: next });
        return json({ settings: await getSettings() });
      }

      if (route === 'POST /admin/broadcast') {
        const { message } = await readBody(req);
        const text = String(message || '').trim().slice(0, 200);
        if (!text) throw new HttpError(400, 'Write a message first.');
        if (!pushConfigured()) throw new HttpError(500, 'Reminders are not set up on the server yet (VAPID keys missing).');
        const ids = (await listKeys('push/')).map((k) => k.slice(5));
        const res = await pool(ids, 20, (sid) => sendToStudent(sid, { title: 'Baitul Hikmah', body: text, tag: 'salah-msg-' + Date.now(), url: '/' }));
        return json({ students: ids.length, delivered: res.filter(Boolean).length });
      }
    }

    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error. Please try again.' }, 500);
  }
};

export const config = { path: '/api/*' };
