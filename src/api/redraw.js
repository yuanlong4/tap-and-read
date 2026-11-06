// POST /api/redraw {image: "<base64 jpeg>", w, h} -> {image: "<base64 jpeg>"}
// Redraws a page photo as a clean, flat, evenly lit "scan" with OpenAI's image model (gpt-image-2).
// The words a child learns always come from Claude reading the ORIGINAL photo; the app also asks
// Claude to re-read the redrawn page and keeps the original if any text looks different.
import { json, error } from '../_lib.js';

const PROMPT = `This is a photo of one page of a children's picture book. Recreate it as a clean, flat, evenly lit, high-quality scan of the very same page.
Remove shadows, glare, uneven lighting, paper curl, and anything that is not the page (table, background, fingers).
Keep everything on the page exactly the same: every word, letter and punctuation mark, the line breaks, the font, the layout, and every part of the illustrations, their colours and characters.
Do not add, remove, fix, translate or restyle anything. White paper should look white.`;

function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// the standard output sizes closest to the page's shape
function sizeFor(w, h) {
  const r = (+h || 1) / (+w || 1);
  if (r > 1.2) return '1024x1536';
  if (r < 1 / 1.2) return '1536x1024';
  return '1024x1024';
}

export async function onRequestPost({ request, env }) {
  if (!env.OPENAI_API_KEY) return error('Redraw needs the OPENAI_API_KEY secret in Cloudflare.', 503);
  let body;
  try { body = await request.json(); } catch { return error('Expected JSON.'); }
  const image = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!image || image.length > 12_000_000) return error('Missing or too-large image.');

  const form = new FormData();
  form.append('model', env.REDRAW_MODEL || 'gpt-image-2');
  form.append('image', new Blob([b64ToBytes(image)], { type: 'image/jpeg' }), 'page.jpg');
  form.append('prompt', PROMPT);
  form.append('quality', env.REDRAW_QUALITY || 'low');
  form.append('size', sizeFor(body.w, body.h));
  form.append('output_format', 'jpeg');
  form.append('n', '1');

  const base = env.OPENAI_BASE_URL || 'https://api.openai.com';
  const res = await fetch(base + '/v1/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok) return error('Redraw failed: ' + ((data && data.error && data.error.message) || res.status), 502);
  const item = data && data.data && data.data[0];
  let out = item && item.b64_json;
  if (!out && item && item.url) { const r = await fetch(item.url); if (r.ok) out = bytesToB64(new Uint8Array(await r.arrayBuffer())); }
  if (!out) return error('Redraw returned no image.', 502);
  return json({ image: out });
}
