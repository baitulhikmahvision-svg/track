// Shared by the phone app (browser) and the Netlify functions (server).
// Prayer times are calculated offline - no external service needed.

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
export const PRAYER_NAMES = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
export const STATUSES = ['jamaah', 'individual', 'qaza', 'missed'];
export const STATUS_LABELS = { jamaah: 'Jamaah', individual: 'Individual', qaza: 'Qaza', missed: 'Missed' };

export const TZ = 4; // Oman = UTC+4, no daylight saving
export const LOCATION = { name: 'Al Khuwair, Muscat, Oman', lat: 23.593, lng: 58.415 };

// Calculation: Fajr 18 deg, Isha 17 deg, standard Asr (shadow = 1x).
// "offsets" are minutes added on top, adjustable by the President in Settings so
// the times can be matched to the official Oman Ministry of Awqaf timetable.
export const DEFAULT_SETTINGS = {
  offsets: { fajr: 0, dhuhr: 2, asr: 0, maghrib: 2, isha: 0 },
  followUpMin: 30,
};
const METHOD = { fajr: 18, isha: 17, asrFactor: 1 };

const R = Math.PI / 180;
const sin = (d) => Math.sin(d * R);
const cos = (d) => Math.cos(d * R);
const tan = (d) => Math.tan(d * R);
const arcsin = (x) => Math.asin(x) / R;
const arccos = (x) => Math.acos(Math.min(1, Math.max(-1, x))) / R;
const arctan2 = (y, x) => Math.atan2(y, x) / R;
const arccot = (x) => Math.atan(1 / x) / R;
const fix = (a, b) => { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; };

function julian(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360);
  const q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * sin(g) + 0.020 * sin(2 * g), 360);
  const e = 23.439 - 0.00000036 * D;
  const RA = fix(arctan2(cos(e) * sin(L), cos(L)) / 15, 24);
  let eqt = q / 15 - RA;
  eqt = fix(eqt + 12, 24) - 12; // keep within +-12h
  const decl = arcsin(sin(e) * sin(L));
  return { decl, eqt };
}

/** dateStr = 'YYYY-MM-DD' (Oman date). Returns UTC millisecond timestamps. */
export function getPrayerTimes(dateStr, offsets = DEFAULT_SETTINGS.offsets) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const { lat, lng } = LOCATION;
  const jd = julian(y, m, d) - lng / (15 * 24);
  const pos = (t) => sunPosition(jd + t / 24);
  const midDay = (t) => fix(12 - pos(t).eqt, 24);
  const angleTime = (angle, t, ccw) => {
    const { decl } = pos(t);
    const x = (-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat));
    const h = arccos(x) / 15;
    return midDay(t) + (ccw ? -h : h);
  };
  const asrTime = (factor, t) => {
    const { decl } = pos(t);
    const angle = -arccot(factor + tan(Math.abs(lat - decl)));
    return angleTime(angle, t, false);
  };
  const adj = (h) => h + TZ - lng / 15;
  const raw = {
    fajr: adj(angleTime(METHOD.fajr, 5, true)),
    sunrise: adj(angleTime(0.833, 6, true)),
    dhuhr: adj(midDay(12)),
    asr: adj(asrTime(METHOD.asrFactor, 13)),
    maghrib: adj(angleTime(0.833, 18, false)),
    isha: adj(angleTime(METHOD.isha, 18, false)),
  };
  const base = Date.UTC(y, m - 1, d) - TZ * 3600000; // local midnight in UTC ms
  const out = {};
  for (const k of Object.keys(raw)) {
    const off = PRAYERS.includes(k) ? Number(offsets?.[k] || 0) : 0;
    out[k] = base + (Math.round(raw[k] * 60) + off) * 60000;
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
export const omanDateStr = (ms) => new Date(ms + TZ * 3600000).toISOString().slice(0, 10);
export const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const isFriday = (dateStr) => new Date(dateStr + 'T00:00:00Z').getUTCDay() === 5;
export function fmtTime(ms) {
  const d = new Date(ms + TZ * 3600000);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${pad(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
export function prettyDate(dateStr) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(dateStr + 'T00:00:00Z'));
}
export const prayerLabel = (p, dateStr) => (p === 'dhuhr' && isFriday(dateStr) ? "Jumu'ah (Dhuhr)" : PRAYER_NAMES[p]);
