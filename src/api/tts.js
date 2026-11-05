// POST /api/tts {text, speed?, timestamps?} -> {url, words?, duration?}
// Makes speech with Kokoro on DeepInfra, stores the MP3 in R2, and reuses it forever after:
// the same text + voice + speed is only ever generated once, for every book and device.
import { json, error, sha256Hex, bucket } from '../_lib.js';

const voices = (env) => String(env.VOICE || 'af_bella,af_nicole').split(',').map((v) => v.trim()).filter(Boolean);

function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// DeepInfra may answer with raw audio, or JSON carrying the audio as a data URL, base64, or a link.
async function readAudio(res) {
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('audio/') || type === 'application/octet-stream') return { audio: new Uint8Array(await res.arrayBuffer()), words: null };
  const data = await res.json();
  let a = data.audio || data.output || (data.outputs && data.outputs[0]);
  if (a && typeof a === 'object' && a.url) a = a.url;
  let audio = null;
  if (typeof a === 'string') {
    if (a.startsWith('data:')) audio = b64ToBytes(a.slice(a.indexOf(',') + 1));
    else if (/^https?:\/\//.test(a)) { const r = await fetch(a); if (r.ok) audio = new Uint8Array(await r.arrayBuffer()); }
    else audio = b64ToBytes(a);
  }
  const words = Array.isArray(data.words) ? data.words.map((w) => ({ t: String(w.text ?? w.word ?? ''), s: +w.start || 0, e: +w.end || 0 })) : null;
  return { audio, words };
}

export async function onRequestPost({ request, env }) {
  if (!env.DEEPINFRA_API_KEY) return error('The voice is not set up: add the DEEPINFRA_API_KEY secret in Cloudflare.', 503);
  let body;
  try { body = await request.json(); } catch { return error('Expected JSON.'); }
  const text = String(body.text || '').trim();
  const speed = Math.min(1.5, Math.max(0.5, +body.speed || 1));
  const timestamps = !!body.timestamps;
  if (!text) return error('No text.');
  if (text.length > 1500) return error('Text is too long for one clip.');

  const v = voices(env);
  const key = await sha256Hex(['kokoro', v.join('+'), speed.toFixed(2), timestamps ? 't' : '', text].join('|'));
  const store = bucket(env);
  const meta = await store.get(`audio/${key}.json`);
  if (meta) return json({ url: `/api/audio/${key}`, ...(await meta.json()) });

  const url = env.DEEPINFRA_URL || 'https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M';
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.DEEPINFRA_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, preset_voice: v, speed, output_format: 'mp3', return_timestamps: timestamps }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    return error('The voice service failed (' + res.status + '): ' + msg.slice(0, 200), 502);
  }
  const { audio, words } = await readAudio(res);
  if (!audio || audio.length < 100) return error('The voice service sent no audio.', 502);
  const info = { words: timestamps ? words : undefined, duration: words && words.length ? words[words.length - 1].e : undefined };
  await store.put(`audio/${key}.mp3`, audio, { httpMetadata: { contentType: 'audio/mpeg' } });
  await store.put(`audio/${key}.json`, JSON.stringify(info), { httpMetadata: { contentType: 'application/json' } });
  return json({ url: `/api/audio/${key}`, ...info });
}
