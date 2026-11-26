// Storage on Supabase (Postgres). One simple table "kv": key (text) -> value (json).
// Talks to Supabase's REST API with plain fetch, so no extra npm package is needed.
import { HttpError } from './http.mjs';
import { DEFAULT_SETTINGS } from '../../../public/js/shared.js';

function cfg() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new HttpError(500, 'Database not set up yet: add SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // legacy JWT-style keys
  return { base: url + '/rest/v1/kv', headers };
}

async function call(query, init = {}, retries = 1) {
  const { base, headers } = cfg();
  let res;
  try { res = await fetch(base + query, { ...init, headers: { ...headers, ...(init.headers || {}) } }); }
  catch (e) { if (retries > 0) return call(query, init, retries - 1); throw new HttpError(500, 'Could not reach the database.'); }
  if (!res.ok) {
    if (retries > 0 && res.status >= 500) return call(query, init, retries - 1);
    console.error('Supabase error', res.status, await res.text().catch(() => ''));
    throw new HttpError(500, 'Database error. Please try again.');
  }
  return res;
}

const enc = encodeURIComponent;

export async function getJSON(key) {
  const rows = await (await call(`?key=eq.${enc(key)}&select=value`)).json();
  return rows.length ? rows[0].value : null;
}

export async function setJSON(key, value) {
  await call('?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

export async function del(key) {
  await call(`?key=eq.${enc(key)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

export async function listKeys(prefix) {
  const rows = await (await call(`?key=like.${enc(prefix)}*&select=key&limit=5000`)).json();
  return rows.map((r) => r.key);
}

/** Every row whose key starts with prefix, in ONE request -> { key: value } */
export async function listValues(prefix) {
  const rows = await (await call(`?key=like.${enc(prefix)}*&select=key,value&limit=5000`)).json();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getSettings() {
  const saved = (await getJSON('settings')) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    offsets: { ...DEFAULT_SETTINGS.offsets, ...(saved.offsets || {}) },
  };
}

/** Run async fn over items, `n` at a time. */
export async function pool(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  }
  return out;
}
