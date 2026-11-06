// PUT /api/photos/<bookId>/<page> (JPEG body)  -> stores a page photo
// GET /api/photos/<bookId>/<page>               -> returns it
import { json, error, validId, bucket } from '../_lib.js';

const keyFor = (params) => {
  const book = String(params.book || ''), n = String(params.n || '');
  if (!validId(book) || !/^\d{1,4}$/.test(n)) return null;
  return `photos/${book}/${n}.jpg`;
};

export async function onRequestGet({ params, env }) {
  const key = keyFor(params); if (!key) return error('Not found.', 404);
  const obj = await bucket(env).get(key);
  if (!obj) return error('Not found.', 404);
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag } });
}

export async function onRequestPut({ params, request, env }) {
  const key = keyFor(params); if (!key) return error('Bad photo address.');
  const type = request.headers.get('content-type') || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return error('Photos must be JPEG, PNG or WebP.');
  const body = await request.arrayBuffer();
  if (body.byteLength > 8 * 1024 * 1024) return error('Photo is too large.');
  await bucket(env).put(key, body, { httpMetadata: { contentType: type } });
  return json({ ok: true });
}

export async function onRequestDelete({ params, env }) {
  const key = keyFor(params); if (!key) return error('Bad photo address.');
  await bucket(env).delete(key);
  return json({ ok: true });
}
