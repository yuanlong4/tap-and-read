// GET /api/books -> [{id, title, created, pages}] newest first
import { json, bucket } from '../../_lib.js';

export async function onRequestGet({ env }) {
  const store = bucket(env); const out = []; let cursor;
  do {
    const page = await store.list({ prefix: 'books/', cursor, include: ['customMetadata'] });
    for (const o of page.objects) {
      const m = o.customMetadata || {};
      out.push({ id: o.key.slice(6, -5), title: m.title || 'Untitled', created: +m.created || 0, updated: +m.updated || 0, pages: +m.pages || 0 });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => b.created - a.created);
  return json(out);
}
