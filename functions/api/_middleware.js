// Every /api/* request must come from a signed-in family member,
// except logging in and the setup check.
import { error, checkSession, getCookie } from '../_lib.js';

const OPEN = new Set(['/api/login', '/api/status']);

export async function onRequest(context) {
  const { request, env, next } = context;
  const path = new URL(request.url).pathname;
  if (OPEN.has(path)) return next();
  if (!env.FAMILY_PASSWORD) return error('The site is not set up yet: add the FAMILY_PASSWORD secret in Cloudflare.', 503);
  if (!(await checkSession(env, getCookie(request, 'tr_session')))) return error('Please sign in.', 401);
  try {
    return await next();
  } catch (e) {
    console.error(e);
    return error(e && e.message ? e.message : 'Something went wrong.', 500);
  }
}
