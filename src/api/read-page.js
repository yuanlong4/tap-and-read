// POST /api/read-page {image: "<base64 jpeg>"} -> {lines: ["...", ...]}
// Claude reads the story text on one photographed page.
import { json, error } from '../_lib.js';

const PROMPT = `This is a photo of one page of a children's picture book. Transcribe the printed story text on the page exactly as written.

Rules:
- Copy spelling, capitalisation and punctuation exactly. Do not correct or modernise anything.
- Keep each printed line as its own entry, in reading order. Use an empty string "" between paragraphs.
- If the page is a cover, include the title (and subtitle) but not author/publisher logos.
- Leave out page numbers, and words that are only part of the artwork (signs, labels on objects) unless they are clearly part of the story text.
- If there is no story text, return an empty list.

Reply with only JSON in this shape: {"lines": ["First line of text", "second line", "", "new paragraph"]}`;

function parseLines(text) {
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && Array.isArray(v.lines) ? v.lines.map((l) => String(l ?? '')) : null; } catch { return null; } };
  return tryParse(text)
    || tryParse((text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1] || '')
    || tryParse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return error('Claude is not set up: add the ANTHROPIC_API_KEY secret in Cloudflare.', 503);
  let body;
  try { body = await request.json(); } catch { return error('Expected JSON.'); }
  const image = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!image || image.length > 7_000_000) return error('Missing or too-large image.');

  const base = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return error('Claude could not read the page: ' + ((data && data.error && data.error.message) || res.status), 502);
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const lines = parseLines(text);
  if (!lines) return error('Claude replied in an unexpected format.', 502);
  return json({ lines });
}
