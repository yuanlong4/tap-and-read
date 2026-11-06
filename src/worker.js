// Tap & Read on Cloudflare Workers.
// Requests to /api/* are handled here (sign-in checked first); everything else is the website in /public.
import { error } from './_lib.js';
import { onRequest as guard } from './api/_middleware.js';
import * as login from './api/login.js';
import * as status from './api/status.js';
import * as readPage from './api/read-page.js';
import * as tts from './api/tts.js';
import * as audio from './api/audio.js';
import * as photos from './api/photos.js';
import * as books from './api/books.js';
import * as book from './api/book.js';
import * as redraw from './api/redraw.js';

// [pattern, module] — :name parts become params
const ROUTES = [
  ['/api/login', login],
  ['/api/status', status],
  ['/api/read-page', readPage],
  ['/api/tts', tts],
  ['/api/redraw', redraw],
  ['/api/audio/:key', audio],
  ['/api/photos/:book/:n', photos],
  ['/api/books', books],
  ['/api/books/:id', book],
].map(([pattern, mod]) => {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
  return { re, names, mod };
});

const handlerName = (method) => 'onRequest' + method.charAt(0) + method.slice(1).toLowerCase();

async function handleApi(request, env, ctx) {
  const path = new URL(request.url).pathname;
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const fn = r.mod[handlerName(request.method)] || r.mod.onRequest;
    const context = { request, env, params, waitUntil: (p) => ctx.waitUntil(p) };
    const next = async () => (fn ? fn(context) : error('Method not allowed.', 405));
    return guard({ ...context, next });
  }
  return error('Not found.', 404);
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
