// GET /api/audio/<key> -> the stored MP3 (never changes, so browsers may keep it)
import { error, bucket } from '../_lib.js';

export async function onRequestGet({ params, env }) {
  const key = String(params.key || '');
  if (!/^[a-f0-9]{64}$/.test(key)) return error('Not found.', 404);
  const obj = await bucket(env).get(`audio/${key}.mp3`);
  if (!obj) return error('Not found.', 404);
  return new Response(obj.body, {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag },
  });
}
