# Tap & Read

A family website that turns photos of real picture books into books a child can read word by word.

- A grown-up photographs each page. **Claude** reads the text exactly, and every word becomes tappable, on the photo and in a large clean version beside it.
- Photos are **straightened and cropped automatically** (the table and background are cut away, slanted shots are squared up), and Claude turns sideways pages upright. The page then fills the screen in **Full page** view.
- Tapping a word says it slowly in a warm, natural voice (OpenAI's steerable voice, told to sound like a kind teacher). **Read to me** reads the page and highlights each word as it is spoken.
- **Fix words** lets a grown-up correct anything the reader got wrong.
- **Two-page photos are split automatically**: Claude says when a photo shows an open book with two facing pages and where the fold is; the photo is cut into a left and a right page, each with its own words and voice. In Edit pages, **⇆ Split** splits a page by hand and **⇄ Join** puts two halves back together.
- **Edit pages** (from the reader or the library): reorder, remove, add, replace or turn pages, rename the book. Every page keeps its original photo.
- **✨ Redraw** (optional, tap per page): OpenAI's image model (gpt-image-2, low quality, about half a cent a page) turns a page photo into a clean, flat "scan". The words always come from Claude reading the original photo; Claude also re-reads the redrawn page, and if any word differs the original is kept. Uses the same `OPENAI_API_KEY` as the voice. Quality can be changed with a `REDRAW_QUALITY` variable (`low`, `medium`, `high`).
- Books, photos and voice live in your own Cloudflare storage, so every phone, tablet and computer in the family sees the same library. The voice is made **once** per word or page and reused forever.
- The whole site sits behind a family password.

## How it fits together

| Part | Service | Cost |
|---|---|---|
| Website, login, storage (books, photos, voice) | Cloudflare Workers + R2 | Free tier |
| Reading the page photos | Anthropic API (Claude) | About 1 cent per page |
| The voice | OpenAI gpt-4o-mini-tts (or DeepInfra Kokoro as a cheaper alternative) | About 1.5 cents per minute of speech, so a few cents per book, made once |

Code layout:

```
public/            the website (index.html, app.js, styles.css, scan.js = page straightener,
                   ocr/ = on-device word finder, vendor/opencv.js = image library for straightening)
src/worker.js      server entry: sends /api/* to the code below, everything else to public/
src/api/           server code that runs on Cloudflare
  login.js         family password → signed cookie
  read-page.js     sends a page photo to Claude, returns the lines of text
  tts.js           makes speech (OpenAI, or DeepInfra), stores the MP3 in R2 (reused forever)
  redraw.js        ✨ redraws a page photo as a clean scan (OpenAI gpt-image-2)
  books.js, book.js, photos.js, audio.js   storage in R2
wrangler.toml      Cloudflare settings (storage bucket, voice, Claude model)
```

## One-time setup (about 15 minutes)

You need: this GitHub repository, an **Anthropic API key**, an **OpenAI API key** (platform.openai.com → API keys; add a few dollars of credit), and a free **Cloudflare** account.

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
   - `OPENAI_API_KEY`: your OpenAI key (for the voice)
   - *(optional)* `DEEPINFRA_API_KEY`: only used if `OPENAI_API_KEY` is not set

   Enter keys only here, never in code or chat.
4. **Redeploy** if the site was already deployed before you added the secrets (**Deployments → Retry**, or push any change to GitHub). Secrets added in the dashboard usually apply right away.
5. Open the address Cloudflare shows (like `https://tap-and-read.<your-name>.workers.dev`), sign in, and add a book.
   On iPhone/iPad: Safari → Share → **Add to Home Screen** for an app icon.

**Something not working?** Open `https://<your-site>/api/status`. It shows which of the password, storage, Claude and voice are set up, without revealing any secrets.

Recommended: set a monthly spending limit in both the Anthropic Console and DeepInfra.

## Settings you can change

In `wrangler.toml` under `[vars]`:

- `OPENAI_VOICE`: the OpenAI voice (default `coral`). Listen to them at https://www.openai.fm. The speaking style (warm teacher, slow for single words) is at the top of `src/api/tts.js`.
- `VOICE`: Kokoro voices to blend for DeepInfra, comma-separated (default `af_bella,af_nicole`).
- `CLAUDE_MODEL`: the Claude model that reads pages.

When the voice service or voice changes, books re-make their voice automatically the next time they are opened.

## Run it on your own computer (optional)

```
npm install -g wrangler
# create .dev.vars with FAMILY_PASSWORD=..., ANTHROPIC_API_KEY=..., DEEPINFRA_API_KEY=...
wrangler dev
```

## Notes

- Page photos are sent to Anthropic to read the text, and page text is sent to OpenAI (or DeepInfra) to make the voice. Nothing else leaves your Cloudflare account.
- The voice clips are shared across books: "the", "a", "said" are made once for the whole library.
