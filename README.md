# Tap & Read

A family website that turns photos of real picture books into books a child can read word by word.

- A grown-up photographs each page. **Claude** reads the text exactly, and every word becomes tappable, on the photo and in a large clean version beside it.
- Tapping a word says it slowly in a natural voice (Kokoro, a Bella/Nicole blend). **Read to me** reads the page and highlights each word as it is spoken.
- **Fix words** lets a grown-up correct anything the reader got wrong.
- Books, photos and voice live in your own Cloudflare storage, so every phone, tablet and computer in the family sees the same library. The voice is made **once** per word or page and reused forever.
- The whole site sits behind a family password.

## How it fits together

| Part | Service | Cost |
|---|---|---|
| Website, login, storage (books, photos, voice) | Cloudflare Workers + R2 | Free tier |
| Reading the page photos | Anthropic API (Claude) | About 1 cent per page |
| The voice | DeepInfra, Kokoro-82M | Under $1 per million characters (a picture book costs a fraction of a cent) |

Code layout:

```
public/            the website (index.html, app.js, styles.css, ocr/ = on-device word finder)
src/worker.js      server entry: sends /api/* to the code below, everything else to public/
src/api/           server code that runs on Cloudflare
  login.js         family password → signed cookie
  read-page.js     sends a page photo to Claude, returns the lines of text
  tts.js           makes speech on DeepInfra, stores the MP3 in R2 (reused forever)
  books.js, book.js, photos.js, audio.js   storage in R2
wrangler.toml      Cloudflare settings (storage bucket, voice, Claude model)
```

## One-time setup (about 15 minutes)

You need: this GitHub repository, an **Anthropic API key**, a **DeepInfra API key** (deepinfra.com → API keys; add a few dollars of credit), and a free **Cloudflare** account.

Cloudflare's dashboard changes from time to time, so button names may differ slightly.

1. **Create the storage.** In Cloudflare: **R2 Object Storage → Create bucket**, name it exactly `tap-and-read`.
   Cloudflare may ask you to add a payment method to turn on R2. Normal family use stays inside the free tier.
2. **Create the website.** **Workers & Pages → Create → Import a repository**, choose `tap-and-read`, then:
   - Project name: `tap-and-read` (must match `name` in `wrangler.toml`)
   - Build command: *(leave empty)*
   - Deploy command: `npx wrangler deploy` (the default)

   Click **Deploy**. The storage connection and website files are read automatically from `wrangler.toml`.
3. **Add the secrets.** In the new project: **Settings → Variables and Secrets → Add**, type **Secret**, for Production:
   - `FAMILY_PASSWORD`: the password your family will type to sign in
   - `ANTHROPIC_API_KEY`: your Anthropic key
   - `DEEPINFRA_API_KEY`: your DeepInfra key

   Enter keys only here, never in code or chat.
4. **Redeploy** if the site was already deployed before you added the secrets (**Deployments → Retry**, or push any change to GitHub). Secrets added in the dashboard usually apply right away.
5. Open the address Cloudflare shows (like `https://tap-and-read.<your-name>.workers.dev`), sign in, and add a book.
   On iPhone/iPad: Safari → Share → **Add to Home Screen** for an app icon.

**Something not working?** Open `https://<your-site>/api/status`. It shows which of the password, storage, Claude and voice are set up, without revealing any secrets.

Recommended: set a monthly spending limit in both the Anthropic Console and DeepInfra.

## Settings you can change

In `wrangler.toml` under `[vars]`:

- `VOICE`: Kokoro voices to blend, comma-separated (default `af_bella,af_nicole`; e.g. `af_nicole` for Nicole only).
- `CLAUDE_MODEL`: the Claude model that reads pages.

Speeds are at the top of `public/app.js` (`WORD_SPEED`, `PAGE_SPEED`). If you change the voice, also bump `VOICE_VERSION` there so books re-make their voice.

## Run it on your own computer (optional)

```
npm install -g wrangler
# create .dev.vars with FAMILY_PASSWORD=..., ANTHROPIC_API_KEY=..., DEEPINFRA_API_KEY=...
wrangler dev
```

## Notes

- Page photos are sent to Anthropic to read the text, and page text is sent to DeepInfra to make the voice. Nothing else leaves your Cloudflare account.
- The voice clips are shared across books: "the", "a", "said" are made once for the whole library.
