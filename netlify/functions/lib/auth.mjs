import crypto from 'node:crypto';
import { HttpError } from './http.mjs';

export function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 16) throw new HttpError(500, 'Server not set up yet: add the TOKEN_SECRET environment variable in Netlify.');
  return s;
}

export function sign(payload, days) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + days * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', secret()).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
}

export function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** role: 's' (student) or 'a' (admin / president) */
export function requireAuth(req, role) {
  const h = req.headers.get('authorization') || '';
  const p = verify(h.replace(/^Bearer\s+/i, ''));
  if (!p || p.r !== role) throw new HttpError(401, 'Please sign in again.');
  return p;
}
