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

- If the photo is sideways or upside down, read it anyway, and say how many degrees it must be turned CLOCKWISE so the text is upright: 0, 90, 180 or 270.
- Say how many book pages the photo shows: 1, or 2 when it shows an open book with two facing pages (count it as 2 even when one picture spreads across both pages).
  For 2 pages, also give "split": where the fold between the pages is, as a number from 0 (left edge) to 1000 (right edge) of the photo once it is turned upright,
  and put the left page's lines in "left" and the right page's lines in "right". "lines" always holds all the text, left page first.

Reply with only JSON in one of these shapes:
{"rotate": 0, "pages": 1, "lines": ["First line of text", "second line", "", "new paragraph"]}
{"rotate": 0, "pages": 2, "split": 500, "left": ["left page text"], "right": ["right page text"], "lines": ["left page text", "", "right page text"]}`;

function parseLines(text) {
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      if (!v || !Array.isArray(v.lines)) return null;
      const r = [0, 90, 180, 270].includes(+v.rotate) ? +v.rotate : 0;
      const strs = (a) => (Array.isArray(a) ? a.map((l) => String(l ?? '')) : null);
      const out = { lines: strs(v.lines), rotate: r };
      // two facing pages: where to cut, and each page's own text
      const split = +v.split;
      if (+v.pages === 2 && split >= 150 && split <= 850 && strs(v.left) && strs(v.right)) out.spread = { split, left: strs(v.left), right: strs(v.right) };
      return out;
    } catch { return null; }
  };
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
      max_tokens: 3000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return error('Claude could not read the page: ' + ((data && data.error && data.error.message) || res.status), 502);
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const out = parseLines(text);
  if (!out) return error('Claude replied in an unexpected format.', 502);
  return json(out);
}
