// GET    /api/books/<id> -> the whole book (title, pages, words, voice clips)
// PUT    /api/books/<id> -> save it
// DELETE /api/books/<id> -> remove the book and its photos (shared voice clips are kept for reuse)
import { json, error, validId, bucket } from '../_lib.js';

export async function onRequestGet({ params, env }) {
  if (!validId(params.id)) return error('Not found.', 404);
  const obj = await bucket(env).get(`books/${params.id}.json`);
  if (!obj) return error('Not found.', 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export async function onRequestPut({ params, request, env }) {
  if (!validId(params.id)) return error('Bad book id.');
  const text = await request.text();
  if (text.length > 4 * 1024 * 1024) return error('Book is too large.');
  let book; try { book = JSON.parse(text); } catch { return error('Expected JSON.'); }
  if (!book || book.id !== params.id || !Array.isArray(book.pages)) return error('Not a book.');
  await bucket(env).put(`books/${params.id}.json`, text, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { title: String(book.title || 'Untitled').slice(0, 200), created: String(book.created || Date.now()), updated: String(book.updated || Date.now()), pages: String(book.pages.length) },
  });
  return json({ ok: true });
}

export async function onRequestDelete({ params, env }) {
  if (!validId(params.id)) return error('Bad book id.');
  const store = bucket(env);
  await store.delete(`books/${params.id}.json`);
  let cursor;
  do {
    const page = await store.list({ prefix: `photos/${params.id}/`, cursor });
    if (page.objects.length) await store.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ ok: true });
}
