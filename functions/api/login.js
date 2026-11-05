// POST /api/login {password}  -> sets the session cookie
// POST /api/login {logout:true} -> clears it
import { json, error, makeSession, safeEqual } from '../_lib.js';

const cookie = (value, maxAge) =>
  `tr_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_PASSWORD) return error('The site is not set up yet: add the FAMILY_PASSWORD secret in Cloudflare.', 503);
  let body = {};
  try { body = await request.json(); } catch {}
  if (body.logout) return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  // small delay makes guessing passwords slow
  await new Promise((r) => setTimeout(r, 400));
  if (!(await safeEqual(body.password || '', env.FAMILY_PASSWORD))) return error('That password is not right.', 401);
  return json({ ok: true }, 200, { 'set-cookie': cookie(await makeSession(env), 180 * 86400) });
}
