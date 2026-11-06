// GET /api/status -> what is set up, and whether this browser is signed in (no secrets revealed)
import { json, checkSession, getCookie } from '../_lib.js';
import { voiceInfo } from './tts.js';

export async function onRequestGet({ request, env }) {
  return json({
    signedIn: await checkSession(env, getCookie(request, 'tr_session')),
    setup: {
      password: !!env.FAMILY_PASSWORD,
      storage: !!env.BUCKET,
      claude: !!env.ANTHROPIC_API_KEY,
      voice: !!voiceInfo(env),
    },
    voiceId: (voiceInfo(env) || {}).id || null,
    voiceService: (voiceInfo(env) || {}).provider || null,
    redraw: !!env.OPENAI_API_KEY,
  });
}
