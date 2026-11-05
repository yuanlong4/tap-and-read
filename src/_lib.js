// Shared helpers for the server functions.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const error = (message, status = 400) => json({ error: message }, status);

const enc = new TextEncoder();

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// The session cookie is signed with a secret derived from the family password,
// so changing the password signs everyone out.
const sessionSecret = (env) => env.SESSION_SECRET || 'tap-and-read:' + (env.FAMILY_PASSWORD || '');

export async function makeSession(env, days = 180) {
  const exp = String(Date.now() + days * 864e5);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(sessionSecret(env)), enc.encode(exp));
  return `${exp}.${b64url(sig)}`;
}

export async function checkSession(env, value) {
  if (!value || !env.FAMILY_PASSWORD) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !(+exp > Date.now())) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(sessionSecret(env)), fromB64url(sig), enc.encode(exp));
  } catch { return false; }
}

export function getCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// Constant-time-ish string comparison (via hashing both sides)
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(id);

export function bucket(env) {
  if (!env.BUCKET) throw new Error('Storage is not set up: the R2 bucket binding "BUCKET" is missing.');
  return env.BUCKET;
}
