// POST /api/tts {text, kind: "word"|"page", speed?, timestamps?} -> {url, words?, duration?}
// Makes speech, stores the MP3 in R2, and reuses it forever after:
// the same text + voice settings is only ever generated once, for every book and device.
//
// Two voice services are supported:
//   - OpenAI (gpt-4o-mini-tts): used when OPENAI_API_KEY is set. Warm, steerable voices.
//   - DeepInfra (Kokoro):       used otherwise, when DEEPINFRA_API_KEY is set. Cheapest; gives word timings.
import { json, error, sha256Hex, bucket } from '../_lib.js';

// How the OpenAI voice should sound. Changing these makes new recordings (old ones stay cached).
const OPENAI_STYLE = {
  word: 'You are helping a young child learn to read. Say the single word warmly and clearly, at a slow, gentle pace, '
      + 'with natural, friendly intonation, the way a kind teacher would say it when pointing at the word. Say only the word.',
  page: 'You are a kind, warm teacher reading a picture book aloud to a young child. Read naturally and expressively, '
      + 'at a gentle, unhurried pace, with clear words and a friendly, lively tone. Give characters a little expression.',
};

export function voiceInfo(env) {
  if (env.OPENAI_API_KEY) {
    const voice = env.OPENAI_VOICE || 'coral', model = env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    return { provider: 'openai', voice, model, id: `openai:${model}:${voice}:v1` };
  }
  if (env.DEEPINFRA_API_KEY) {
    const voices = String(env.VOICE || 'af_bella,af_nicole').split(',').map((v) => v.trim()).filter(Boolean);
    return { provider: 'deepinfra', voices, id: `kokoro:${voices.join('+')}:v1` };
  }
  return null;
}

function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// DeepInfra may answer with raw audio, or JSON carrying the audio as a data URL, base64, or a link.
async function readDeepInfra(res) {
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

async function speakOpenAI(env, v, text, kind) {
  const base = env.OPENAI_BASE_URL || 'https://api.openai.com';
  const res = await fetch(base + '/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: v.model, voice: v.voice, input: text, instructions: OPENAI_STYLE[kind], response_format: 'mp3' }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    let detail = msg; try { detail = JSON.parse(msg).error.message; } catch {}
    throw new Error('OpenAI voice failed (' + res.status + '): ' + String(detail).slice(0, 200));
  }
  return { audio: new Uint8Array(await res.arrayBuffer()), words: null };
}

async function speakDeepInfra(env, v, text, speed, timestamps) {
  const url = env.DEEPINFRA_URL || 'https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M';
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.DEEPINFRA_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, preset_voice: v.voices, speed, output_format: 'mp3', return_timestamps: timestamps }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error('DeepInfra voice failed (' + res.status + '): ' + msg.slice(0, 200));
  }
  return readDeepInfra(res);
}

export async function onRequestPost({ request, env }) {
  const v = voiceInfo(env);
  if (!v) return error('The voice is not set up: add OPENAI_API_KEY (or DEEPINFRA_API_KEY) in Cloudflare.', 503);
  let body;
  try { body = await request.json(); } catch { return error('Expected JSON.'); }
  const text = String(body.text || '').trim();
  const kind = body.kind === 'page' ? 'page' : 'word';
  const speed = Math.min(1.5, Math.max(0.5, +body.speed || 1));
  const timestamps = !!body.timestamps;
  if (!text) return error('No text.');
  if (text.length > 1500) return error('Text is too long for one clip.');

  const settings = v.provider === 'openai' ? [v.id, kind, OPENAI_STYLE[kind]] : [v.id, speed.toFixed(2), timestamps ? 't' : ''];
  const key = await sha256Hex([...settings, text].join('|'));
  const store = bucket(env);
  const meta = await store.get(`audio/${key}.json`);
  if (meta) return json({ url: `/api/audio/${key}`, ...(await meta.json()) });

  let out;
  try {
    out = v.provider === 'openai' ? await speakOpenAI(env, v, text, kind) : await speakDeepInfra(env, v, text, speed, timestamps);
  } catch (e) { return error(e.message, 502); }
  const { audio, words } = out;
  if (!audio || audio.length < 100) return error('The voice service sent no audio.', 502);
  const info = { words: timestamps && words && words.length ? words : undefined, duration: words && words.length ? words[words.length - 1].e : undefined };
  await store.put(`audio/${key}.mp3`, audio, { httpMetadata: { contentType: 'audio/mpeg' } });
  await store.put(`audio/${key}.json`, JSON.stringify(info), { httpMetadata: { contentType: 'application/json' } });
  return json({ url: `/api/audio/${key}`, ...info });
}
