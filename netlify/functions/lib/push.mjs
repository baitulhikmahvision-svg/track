import webpush from 'web-push';
import { getJSON, setJSON, del } from './store.mjs';

let ready = false;
export function pushConfigured() {
  if (ready) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
  ready = true;
  return true;
}

/** Send one notification to every device a student has registered. Returns how many devices accepted it. */
export async function sendToStudent(sid, payload) {
  if (!pushConfigured()) return 0;
  const subs = (await getJSON(`push/${sid}`)) || [];
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  const keep = [];
  let ok = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
      keep.push(sub);
      ok++;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) return; // expired -> drop
      keep.push(sub); // temporary problem -> keep
    }
  }));
  if (keep.length !== subs.length) {
    if (keep.length) await setJSON(`push/${sid}`, keep); else await del(`push/${sid}`);
  }
  return ok;
}
