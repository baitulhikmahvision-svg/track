// Runs every minute (Netlify scheduled function).
// - At each prayer time: reminds every student who turned notifications on.
// - 30 minutes later: gently nudges only the students who have NOT logged that prayer yet.
import { PRAYERS, PRAYER_NAMES, getPrayerTimes, omanDateStr, isFriday } from '../../public/js/shared.js';
import { getJSON, setJSON, listKeys, getSettings, pool } from './lib/store.mjs';
import { sendToStudent, pushConfigured } from './lib/push.mjs';

const WINDOW_MIN = 12; // tolerate scheduler delays

export default async () => {
  if (!pushConfigured()) return new Response('push not configured');
  const now = Date.now();
  const date = omanDateStr(now);
  const settings = await getSettings();
  const times = getPrayerTimes(date, settings.offsets);
  const follow = settings.followUpMin || 30;

  const jobs = [];
  for (const p of PRAYERS) {
    const age = (now - times[p]) / 60000;
    if (age >= 0 && age < WINDOW_MIN) jobs.push({ p, kind: 'adhan' });
    else if (age >= follow && age < follow + WINDOW_MIN) jobs.push({ p, kind: 'followup' });
  }
  if (!jobs.length) return new Response('nothing due');

  const sentKey = `sent/${date}`;
  const sent = (await getJSON(sentKey)) || {};
  const due = jobs.filter((j) => !sent[`${j.p}:${j.kind}`]);
  if (!due.length) return new Response('already sent');
  for (const j of due) sent[`${j.p}:${j.kind}`] = now; // mark first so overlapping runs don't double-send
  await setJSON(sentKey, sent);

  const subscribers = (await listKeys('push/')).map((k) => k.slice(5));
  for (const { p, kind } of due) {
    const name = p === 'dhuhr' && isFriday(date) ? "Jumu'ah" : PRAYER_NAMES[p];
    const tag = `salah-${date}-${p}-${kind}`;
    await pool(subscribers, 20, async (sid) => {
      if (kind === 'followup') {
        const blob = await getJSON(`log/${sid}`);
        if (blob?.days?.[date]?.[p]) return; // already logged
        return sendToStudent(sid, {
          title: `Did you pray ${name}?`,
          body: 'You have not marked it yet. Open the app and log it (Qaza if it was missed). May Allah accept from you.',
          tag, url: '/',
        });
      }
      return sendToStudent(sid, {
        title: `It's time for ${name}`,
        body: 'Come to jamaah if you can. After you pray, tap here to log it in your Salah Tracker.',
        tag, url: '/',
      });
    });
  }
  return new Response(`sent ${due.map((d) => d.p + ':' + d.kind).join(',')}`);
};

export const config = { schedule: '* * * * *' };
