// GET /api/status -> what is set up, and whether this browser is signed in (no secrets revealed)
import { json, checkSession, getCookie } from '../_lib.js';
import { voiceInfo } from './tts.js';

export async function onRequestGet({ request, env }) {
  const signedIn = await checkSession(env, getCookie(request, 'tr_session'));
  const v = voiceInfo(env);
  return json({
    signedIn,
    setup: {
      password: !!env.FAMILY_PASSWORD,
      storage: !!env.BUCKET,
      claude: !!env.ANTHROPIC_API_KEY,
      voice: !!v,
    },
    // only for the family (signed in): which voice is in use, so books know when to remake their sound
    ...(signedIn ? { voiceId: (v && v.id) || null, voiceService: (v && v.provider) || null, redraw: !!env.OPENAI_API_KEY } : {}),
  });
}
