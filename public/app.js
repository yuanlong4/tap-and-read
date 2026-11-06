/* Tap & Read — teach kids to read from photos of their own books.
 * Parents photograph each page; Claude reads the words; every word becomes tappable,
 * with a natural voice for single words and for reading the page aloud.
 */
'use strict';

/* ================= small helpers ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = (t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '').replace(/^'+|'+$/g, '');
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const wordKey = (t) => clean(t).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Voice settings: words are said slowly with a natural ending ("Duck."), pages a little faster.
let VOICE_VERSION = 'unknown';   // set from the server: which voice service + voice is in use
const WORD_SPEED = 0.8, PAGE_SPEED = 0.95;
const wordPrompt = (t) => { const c = clean(t); return c.charAt(0).toUpperCase() + c.slice(1) + '.'; };

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts,
    headers: { ...(opts.body && typeof opts.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new ApiError('Please sign in.', 401); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  return data;
}
// run tasks with limited parallelism
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

function show(view) {
  for (const v of ['vLogin', 'vLibrary', 'vBuilder', 'vReader']) $(v).classList.toggle('hidden', v !== view);
  $('homeBtn').classList.toggle('hidden', view === 'vLibrary' || view === 'vLogin');
  $('signOutBtn').classList.toggle('hidden', view !== 'vLibrary');
  stopAll();
}
function ask(title, text, yes = 'OK') {
  return new Promise((res) => {
    $('mTitle').textContent = title; $('mText').textContent = text; $('mYes').textContent = yes;
    $('modal').classList.remove('hidden');
    const done = (v) => { $('modal').classList.add('hidden'); res(v); };
    $('mYes').onclick = () => done(true); $('mNo').onclick = () => done(false);
  });
}
function setVoiceStat(msg, done) {
  const el = $('voiceStat'); if (!msg) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden'); el.classList.toggle('done', !!done);
  el.innerHTML = `<span class="dot"></span>${esc(msg)}`;
}

/* ================= sign in ================= */
function showLogin() { show('vLogin'); setTimeout(() => $('pw').focus(), 50); }
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) }); $('pw').value = '';
        const s = await api('/api/status').catch(() => null); if (s && s.voiceId) VOICE_VERSION = s.voiceId; goHome(); }
  catch (err) { $('loginErr').textContent = err.message; }
});
$('signOutBtn').onclick = async () => { await api('/api/login', { method: 'POST', body: JSON.stringify({ logout: true }) }).catch(() => {}); showLogin(); };

/* ================= library ================= */
let books = [];
async function goHome() {
  show('vLibrary');
  try { books = await api('/api/books'); } catch (e) { if (e.status !== 401) $('shelf').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  $('emptyShelf').classList.toggle('hidden', books.length > 0);
  $('shelf').innerHTML = books.map((b) => `
    <div class="book">
      <button class="cover" data-open="${b.id}" style="background-image:url(/api/photos/${b.id}/0)" aria-label="Open ${esc(b.title)}"></button>
      <div class="meta"><b>${esc(b.title)}</b><span>${b.pages} page${b.pages === 1 ? '' : 's'}</span></div>
      <div class="acts"><button class="btn small sun" data-open="${b.id}">Read</button><button class="btn small ghost" data-del="${b.id}">Delete</button></div>
    </div>`).join('');
}
$('shelf').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
  if (o) { try { const b = await api('/api/books/' + o.dataset.open); openReader(b, 0); prepareVoice(b); } catch (err) { if (err.status !== 401) alertMsg(err.message); } }
  if (d) {
    const b = books.find((x) => x.id === d.dataset.del);
    if (await ask('Delete this book?', `“${b ? b.title : 'This book'}” will be removed for everyone in the family.`, 'Delete')) {
      await api('/api/books/' + d.dataset.del, { method: 'DELETE' }).catch((err) => alertMsg(err.message)); goHome();
    }
  }
});
function alertMsg(m) { ask('Something went wrong', m, 'OK'); $('mNo').classList.add('hidden'); setTimeout(() => $('mNo').classList.remove('hidden'), 0); }
$('newBookBtn').onclick = openBuilder; $('firstBookBtn').onclick = openBuilder; $('homeBtn').onclick = goHome;

/* ================= on-device word finder (for word positions on the photo) ================= */
let ocrP = null;
function getOCR() {
  if (!ocrP) {
    const base = new URL('ocr/', location.href).href;
    ocrP = Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang', logger: (m) => ocrLogger && ocrLogger(m) });
    ocrP.catch(() => { ocrP = null; });
  }
  return ocrP;
}
let ocrLogger = null;
function ocrWords(data) {
  const out = []; let lineId = 0;
  const push = (w, lid) => { const t = (w.text || '').trim(); if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ text: t, conf: Math.round(w.confidence), box: w.bbox, line: lid }); };
  if (data.blocks && data.blocks.length) {
    for (const b of data.blocks) for (const p of (b.paragraphs || [])) { for (const l of (p.lines || [])) { for (const w of (l.words || [])) push(w, lineId); lineId++; } lineId += 1000; }
  } else if (data.words) { for (const w of data.words) push(w, 0); }
  return out.filter((w) => (w.box.x1 - w.box.x0) > 4 && (w.box.y1 - w.box.y0) > 4);
}
function cleanOCROnly(ws) {   // used only if Claude could not read a page
  const byLine = {}; ws.forEach((w) => (byLine[w.line] = byLine[w.line] || []).push(w));
  return ws.filter((w) => !(w.conf < 45 && clean(w.text).length < 3) && !(/^\d{1,3}$/.test(w.text) && byLine[w.line].length === 1) && w.conf >= 30);
}

/* ---- line up Claude's exact words with the word boxes found on the photo ---- */
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function sim(a, b) { a = norm(a); b = norm(b); if (!a || !b) return 0; if (a === b) return 1; return 1 - lev(a, b) / Math.max(a.length, b.length); }
function alignWords(lines, ocr) {
  const cw = []; let ln = 0, para = 0;
  for (const l of lines) {
    if (!l.trim()) { para += 1000; continue; }
    for (const t of l.trim().split(/\s+/)) if (/[\p{L}\p{N}]/u.test(t)) cw.push({ text: t, line: para + ln, conf: 100, box: null });
    ln++;
  }
  const n = cw.length, m = ocr.length, GAP = -0.45;
  const S = Array.from({ length: n + 1 }, () => new Float32Array(m + 1)), T = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) { S[i][0] = i * GAP; T[i][0] = 1; }
  for (let j = 1; j <= m; j++) { S[0][j] = j * GAP; T[0][j] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const s = sim(cw[i - 1].text, ocr[j - 1].text);
    const d = s >= 0.5 ? S[i - 1][j - 1] + 2 * s : -1e9, u = S[i - 1][j] + GAP, l = S[i][j - 1] + GAP;
    if (d >= u && d >= l) { S[i][j] = d; T[i][j] = 0; } else if (u >= l) { S[i][j] = u; T[i][j] = 1; } else { S[i][j] = l; T[i][j] = 2; }
  }
  const match = new Array(n).fill(-1); let i = n, j = m;
  while (i > 0 || j > 0) { const t = T[i][j]; if (i > 0 && j > 0 && t === 0) { match[i - 1] = j - 1; i--; j--; } else if (i > 0 && (j === 0 || t === 1)) i--; else j--; }
  for (let k = 0; k < n; k++) if (match[k] >= 0) { const o = ocr[match[k]]; cw[k].box = { ...o.box }; cw[k].conf = o.conf; }
  // one photo word that swallowed the next word(s): share its box
  for (let k = 0; k < n; k++) {
    if (match[k] < 0) continue;
    const o = ocr[match[k]]; let e = k, best = sim(cw[k].text, o.text);
    while (e + 1 < n && match[e + 1] < 0 && cw[e + 1].line === cw[k].line) { const s2 = sim(cw.slice(k, e + 2).map((w) => w.text).join(''), o.text); if (s2 > best) { best = s2; e++; } else break; }
    if (e > k) {
      const grp = cw.slice(k, e + 1), tot = grp.reduce((a, w) => a + w.text.length + 1, 0), W = o.box.x1 - o.box.x0; let x = o.box.x0;
      for (const w of grp) { const ww = W * (w.text.length + 1) / tot; w.box = { x0: Math.round(x), y0: o.box.y0, x1: Math.round(x + ww - 4), y1: o.box.y1 }; w.conf = 60; x += ww; }
      for (let q = k + 1; q <= e; q++) match[q] = -2;
    }
  }
  // words the photo reader missed: place them between their neighbours
  let k = 0;
  while (k < n) {
    if (match[k] !== -1) { k++; continue; }
    let e = k; while (e < n && match[e] === -1) e++;
    const run = cw.slice(k, e);
    let pj = -1; for (let q = k - 1; q >= 0; q--) if (match[q] >= 0) { pj = match[q]; break; }
    let nj = m; for (let q = e; q < n; q++) if (match[q] >= 0) { nj = match[q]; break; }
    const between = ocr.slice(pj + 1, nj); let region = null;
    if (between.length) {
      region = between.reduce((r, o) => ({ x0: Math.min(r.x0, o.box.x0), y0: Math.min(r.y0, o.box.y0), x1: Math.max(r.x1, o.box.x1), y1: Math.max(r.y1, o.box.y1) }), { ...between[0].box });
      if (region.y1 - region.y0 > 2.2 * (between[0].box.y1 - between[0].box.y0)) region = null;
    } else if (pj >= 0 && nj < m && ocr[pj].line === ocr[nj].line && ocr[nj].box.x0 > ocr[pj].box.x1) {
      const a = ocr[pj].box, b = ocr[nj].box; region = { x0: a.x1 + 6, y0: Math.min(a.y0, b.y0), x1: b.x0 - 6, y1: Math.max(a.y1, b.y1) };
    }
    if (region && region.x1 > region.x0) {
      const tot = run.reduce((s, w) => s + w.text.length + 1, 0); let x = region.x0; const W = region.x1 - region.x0;
      for (const w of run) { const ww = W * (w.text.length + 1) / tot; w.box = { x0: Math.round(x), y0: region.y0, x1: Math.round(x + ww - 6), y1: region.y1 }; w.conf = 60; x += ww; }
    }
    k = e;
  }
  return cw;
}

/* ================= adding a book ================= */
let pending = [];
function openBuilder() { pending = []; $('bTitle').value = ''; $('progress').textContent = ''; renderThumbs(); show('vBuilder'); }
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const max = 2000, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob((blob) => res({ blob, src: URL.createObjectURL(blob), w: c.width, h: c.height }), 'image/jpeg', 0.85);
    };
    img.onerror = rej; img.src = url;
  });
}
async function addFiles(list) {
  const files = [...list].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const f of files) { try { pending.push({ name: f.name, ...(await loadImage(f)) }); } catch (e) {} }
  renderThumbs();
}
function renderThumbs() {
  $('thumbs').innerHTML = pending.map((p, i) => `
    <div class="thumb"><img src="${p.src}" alt="page ${i + 1}"><span class="n">p.${i + 1}</span>
      <div class="ctl"><button data-a="l" data-i="${i}" title="Move earlier">◀</button><button data-a="r" data-i="${i}" title="Move later">▶</button><button data-a="x" data-i="${i}" title="Remove">✕</button></div>
      <div class="st"><i id="st${i}"></i></div></div>`).join('');
  $('buildBtn').disabled = !pending.length;
}
$('thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; const i = +b.dataset.i;
  if (b.dataset.a === 'x') pending.splice(i, 1);
  if (b.dataset.a === 'l' && i > 0) [pending[i - 1], pending[i]] = [pending[i], pending[i - 1]];
  if (b.dataset.a === 'r' && i < pending.length - 1) [pending[i + 1], pending[i]] = [pending[i], pending[i + 1]];
  renderThumbs();
});
$('files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('cancelBuild').onclick = () => goHome();

const blobToB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });

$('buildBtn').onclick = async () => {
  const title = $('bTitle').value.trim() || 'My book';
  const pages = pending.slice(), prog = $('progress');
  $('buildBtn').disabled = true; $('cancelBuild').disabled = true;
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    // 1. upload the photos, and ask Claude to read each page (two at a time)
    let claudeDone = 0;
    const tick = () => { prog.textContent = `Reading the pages… Claude has read ${claudeDone} of ${pages.length}`; };
    tick();
    const claudeRes = new Array(pages.length);
    const claudeAll = pool(pages, 2, async (p, i) => {
      await api(`/api/photos/${id}/${i}`, { method: 'PUT', body: p.blob, headers: { 'content-type': 'image/jpeg' } });
      try { claudeRes[i] = (await api('/api/read-page', { method: 'POST', body: JSON.stringify({ image: await blobToB64(p.blob) }) })).lines; }
      catch (e) { console.warn('Claude could not read page', i + 1, e.message); claudeRes[i] = null; if (e.status === 503) throw e; }
      claudeDone++; tick();
    });
    // 2. meanwhile, find where each word sits on the photo
    const ocr = await getOCR(); let cur = -1; const ocrRes = [];
    ocrLogger = (m) => { if (cur >= 0 && m.status === 'recognizing text') { const el = $('st' + cur); if (el) el.style.width = Math.round(m.progress * 80) + '%'; } };
    for (let i = 0; i < pages.length; i++) { cur = i; const { data } = await ocr.recognize(pages[i].blob, {}, { blocks: true, text: true }); ocrRes.push(ocrWords(data)); }
    ocrLogger = null;
    await claudeAll;
    // 3. put it together and save
    const book = { id, title, created: Date.now(), updated: Date.now(), wordClips: {}, voice: VOICE_VERSION, pages: [] };
    pages.forEach((p, i) => {
      const lines = claudeRes[i];
      book.pages.push({ n: i, w: p.w, h: p.h, source: lines ? 'claude' : 'ocr', words: lines ? alignWords(lines, ocrRes[i]) : cleanOCROnly(ocrRes[i]), clips: null });
      $('st' + i).style.width = '100%';
    });
    await saveBook(book);
    openReader(book, 0);
    prepareVoice(book);
  } catch (err) {
    console.error(err);
    if (err.status !== 401) prog.textContent = 'Something went wrong: ' + err.message;
  } finally { $('buildBtn').disabled = false; $('cancelBuild').disabled = false; }
};
async function saveBook(b) { b.updated = Date.now(); await api('/api/books/' + b.id, { method: 'PUT', body: JSON.stringify(b) }); }

/* ================= the voice (made on the server, stored once, plays everywhere) ================= */
function pageChunks(page) {   // the page's words split into pieces of up to ~300 characters, at sentence ends
  const out = []; let start = 0, len = 0;
  page.words.forEach((w, i) => {
    len += w.text.length + 1;
    const end = /[.!?…]["”'’)\]]*$/.test(w.text) || i === page.words.length - 1;
    if ((end && len > 300) || i === page.words.length - 1 || (len > 450)) { out.push({ start, end: i }); start = i + 1; len = 0; }
  });
  return out.map((c) => ({ ...c, text: page.words.slice(c.start, c.end + 1).map((w) => w.text).join(' ') }));
}
// match the voice service's word timings to our words
function mapTimings(chunk, page, tw) {
  if (!tw || !tw.length) return null;
  const ours = page.words.slice(chunk.start, chunk.end + 1), out = new Array(ours.length).fill(null); let j = 0;
  ours.forEach((w, i) => {
    const n = norm(w.text);
    for (let k = j; k < Math.min(tw.length, j + 4); k++) {
      const t = norm(tw[k].t);
      if (t && (t === n || n.startsWith(t) || t.startsWith(n))) { out[i] = tw[k].s; j = k + 1; break; }
    }
  });
  for (let i = 0; i < out.length; i++) if (out[i] == null) {   // fill gaps between known times
    let a = i - 1; while (a >= 0 && out[a] == null) a--;
    let b = i + 1; while (b < out.length && out[b] == null) b++;
    const ta = a >= 0 ? out[a] : 0, tb = b < out.length ? out[b] : (tw[tw.length - 1].e || ta + 0.4);
    out[i] = ta + (tb - ta) * (i - a) / (b - a);
  }
  return out;
}
let voiceJob = null;
async function prepareVoice(b) {
  if (voiceJob && voiceJob.id === b.id) return voiceJob.p;
  const run = (async () => {
    if (VOICE_VERSION !== 'unknown' && b.voice !== VOICE_VERSION) { b.wordClips = {}; b.pages.forEach((p) => { p.clips = null; }); b.voice = VOICE_VERSION; }
    const jobs = [];
    const seen = new Set();
    // the page being read comes first
    const order = [...b.pages.keys()].sort((x, y) => ((x < pg) - (y < pg)) || (x - y));
    for (const pi of order) {
      const p = b.pages[pi];
      for (const w of p.words) { const k = wordKey(w.text); if (k && !b.wordClips[k] && !seen.has(k)) { seen.add(k); jobs.push({ kind: 'w', key: k, text: wordPrompt(w.text) }); } }
      const chunks = pageChunks(p);
      const sig = chunks.map((c) => c.text).join('\n');
      if (!p.clips || p.clipsFor !== sig) jobs.push({ kind: 'p', pi, chunks, sig });
    }
    if (!jobs.length) { setVoiceStat(null); return; }
    let done = 0, changed = 0, failed = 0;
    setVoiceStat(`Making the voice… 0 of ${jobs.length}`);
    await pool(jobs, 4, async (j) => {
      try {
        if (j.kind === 'w') {
          const r = await api('/api/tts', { method: 'POST', body: JSON.stringify({ text: j.text, kind: 'word', speed: WORD_SPEED }) });
          b.wordClips[j.key] = r.url;
        } else {
          const p = b.pages[j.pi], clips = [];
          for (const c of j.chunks) {
            const r = await api('/api/tts', { method: 'POST', body: JSON.stringify({ text: c.text, kind: 'page', speed: PAGE_SPEED, timestamps: true }) });
            clips.push({ start: c.start, end: c.end, url: r.url, dur: r.duration || null, times: mapTimings(c, p, r.words) });
          }
          if (b.pages[j.pi] === p) { p.clips = clips; p.clipsFor = j.sig; }
        }
        changed++;
      } catch (e) { failed++; console.warn('voice failed for', j, e.message); if (e.status === 503) throw e; }
      done++; setVoiceStat(`Making the voice… ${done} of ${jobs.length}`);
      if (changed % 12 === 0) saveBook(b).catch(() => {});
    }).catch((e) => { setVoiceStat(e.message, true); });
    if (changed) await saveBook(b).catch(() => {});
    if (failed) setVoiceStat(`Voice ready (${failed} could not be made, device voice used there)`, true);
    else { setVoiceStat('Voice ready', true); setTimeout(() => { if ($('voiceStat').classList.contains('done')) setVoiceStat(null); }, 2500); }
  })();
  voiceJob = { id: b.id, p: run };
  try { await run; } finally { if (voiceJob && voiceJob.p === run) voiceJob = null; }
}

/* ================= playback ================= */
const synth = window.speechSynthesis;
let sysVoice = null, rate = 1, reading = false, curAudio = null, rafId = 0, readToken = 0;
function pickVoice() {
  if (!synth) return;
  const vs = synth.getVoices().filter((v) => /^en/i.test(v.lang));
  sysVoice = vs.find((v) => /samantha|google us english|jenny|aria|natural/i.test(v.name)) || vs.find((v) => /en-US/i.test(v.lang)) || vs[0] || null;
}
if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }
function sysSay(text, r) {
  return new Promise((res) => {
    if (!synth) return res();
    try { const u = new SpeechSynthesisUtterance(text); if (sysVoice) u.voice = sysVoice; u.rate = 0.9 * (r || 1); u.onend = u.onerror = () => res(); synth.speak(u); } catch (e) { res(); }
  });
}
// One shared player, unlocked during each tap, so sound can still start after a short wait (iPhone/iPad)
const player = new Audio(); player.preload = 'auto';
const SILENT = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA';
function unlockAudio() { try { player.onended = player.onerror = player.onpause = null; player.src = SILENT; player.play().catch(() => {}); } catch (e) {} }
function stopAll() {
  reading = false; readToken++;
  if (curAudio) { const a = curAudio; curAudio = null; try { a.pause(); } catch (e) {} }
  cancelAnimationFrame(rafId);
  try { synth && synth.cancel(); } catch (e) {}
  const ra = $('readAll'); if (ra) ra.textContent = '▶ Read to me';
}
let playSeq = 0;
function playUrl(url, r, onTick) {
  return new Promise((res) => {
    const my = ++playSeq; let finished = false;
    const fin = (ok) => { if (finished) return; finished = true; cancelAnimationFrame(rafId); if (curAudio === player && my === playSeq) curAudio = null; res(ok !== false); };
    player.onended = () => fin(true); player.onerror = () => fin(false); player.onpause = () => { if (!player.ended) fin(true); };
    player.src = url; player.playbackRate = r; player.preservesPitch = true; curAudio = player;
    player.play().then(() => { player.playbackRate = r; if (onTick) { const loop = () => { if (finished) return; onTick(player.currentTime, player.duration); rafId = requestAnimationFrame(loop); }; loop(); } }).catch(() => fin(false));
  });
}
function syllables(word) {
  const w = word.toLowerCase(); if (w.length <= 3) return [word];
  const parts = w.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]*$|[^aeiouy](?=[^aeiouy]))?/g);
  if (!parts || parts.join('') !== w) return [word];
  if (parts.length > 1 && /^[^aeiouy]*e$/.test(parts[parts.length - 1]) && !/le$/.test(w)) parts[parts.length - 2] += parts.pop();
  return parts;
}

/* ================= reader ================= */
let book = null, pg = 0;
function openReader(b, p) { book = b; pg = p; show('vReader'); $('rTitle').textContent = b.title; $('editArea').classList.add('hidden'); renderPage(); }
const pageWords = () => book.pages[pg].words;
function renderPage() {
  stopAll();
  const page = book.pages[pg];
  $('pageImg').src = `/api/photos/${book.id}/${page.n ?? pg}`;
  $('photopane').querySelectorAll('.hot').forEach((n) => n.remove());
  page.words.forEach((w, i) => {
    if (!w.box) return;
    const d = document.createElement('div'); d.className = 'hot'; d.dataset.i = i; const pad = 3;
    d.style.left = ((w.box.x0 - pad) / page.w * 100) + '%'; d.style.top = ((w.box.y0 - pad) / page.h * 100) + '%';
    d.style.width = ((w.box.x1 - w.box.x0 + pad * 2) / page.w * 100) + '%'; d.style.height = ((w.box.y1 - w.box.y0 + pad * 2) / page.h * 100) + '%';
    d.title = w.text; $('photopane').appendChild(d);
  });
  let html = '', last = null;
  page.words.forEach((w, i) => {
    if (last !== null && w.line !== last) html += (w.line - last >= 1000 ? '<span class="linebreak"></span><span class="linebreak"></span>' : '<br>');
    else if (last !== null) html += ' ';
    html += `<span class="w" data-i="${i}">${esc(w.text)}</span>`; last = w.line;
  });
  $('words').innerHTML = html || '<span class="muted" style="font-size:18px">No words on this page — it may be a picture page. Use “Fix words” to add some.</span>';
  $('say').innerHTML = '<span class="muted">Tap a word to hear it.</span>';
  $('srcNote').textContent = page.source === 'claude' ? '✨ Words checked by Claude' : '';
  $('pgLabel').textContent = `Page ${pg + 1} of ${book.pages.length}`;
  $('prevPg').disabled = pg === 0; $('nextPg').disabled = pg === book.pages.length - 1;
  $('readAll').disabled = !page.words.length;
  if (!$('editArea').classList.contains('hidden')) renderEdit();
}
function highlight(i) {
  document.querySelectorAll('.w.on,.hot.on').forEach((n) => n.classList.remove('on'));
  if (i < 0) return;
  document.querySelectorAll(`[data-i="${i}"]`).forEach((n) => n.classList.add('on'));
  const t = document.querySelector(`.w[data-i="${i}"]`); t && t.classList.add('seen');
}
async function wordUrl(text) {
  const k = wordKey(text); if (!k) return null;
  if (book.wordClips[k]) return book.wordClips[k];
  const r = await api('/api/tts', { method: 'POST', body: JSON.stringify({ text: wordPrompt(text), kind: 'word', speed: WORD_SPEED }) });
  book.wordClips[k] = r.url; return r.url;
}
function sayWord(i) {
  const w = pageWords()[i]; const word = clean(w.text) || w.text;
  stopAll(); unlockAudio(); highlight(i);
  const syl = syllables(word);
  $('say').innerHTML = `<span class="big">${esc(word)}</span>${syl.length > 1 ? `<span class="syl">${syl.map(esc).join(' · ')}</span>` : ''}`;
  const my = readToken;
  const cached = book.wordClips[wordKey(w.text)];
  if (!cached) $('say').insertAdjacentHTML('beforeend', '<span class="syl" id="wait">🎙️ one moment…</span>');
  wordUrl(w.text).then(async (url) => {
    const x = $('wait'); x && x.remove();
    if (my !== readToken) return;
    if (!url || !(await playUrl(url, rate < 1 ? 0.75 : 1))) sysSay(word, rate);
  }).catch(() => { const x = $('wait'); x && x.remove(); if (my === readToken) sysSay(word, rate); });
}
function onTap(e) { const t = e.target.closest('[data-i]'); if (t) sayWord(+t.dataset.i); }
$('words').addEventListener('click', onTap);
$('photopane').addEventListener('click', onTap);

// When there are no exact word timings, estimate them from word lengths and pauses at punctuation
const estCache = new WeakMap();
function estWord(c, page, t, dur) {
  if (!estCache.has(c)) {
    const ws = page.words.slice(c.start, c.end + 1);
    const w = ws.map((x) => clean(x.text).length + 2 + (/[,;:]$/.test(x.text) ? 3 : 0) + (/[.!?]["”']?$/.test(x.text) ? 5 : 0));
    const tot = w.reduce((a, b) => a + b, 0); let acc = 0;
    estCache.set(c, w.map((x) => { const s = acc / tot; acc += x; return s; }));
  }
  const starts = estCache.get(c);
  const lead = Math.min(0.25, dur * 0.05), f = Math.max(0, (t - lead) / Math.max(0.1, dur - lead * 2));
  let k = 0; while (k + 1 < starts.length && f >= starts[k + 1]) k++;
  return k;
}
$('readAll').onclick = async () => {
  if (reading) { stopAll(); highlight(-1); return; }
  const page = book.pages[pg]; if (!page.words.length) return;
  stopAll(); unlockAudio(); reading = true; const my = readToken; $('readAll').textContent = '■ Stop';
  const alive = () => reading && my === readToken;
  const r = rate < 1 ? 0.75 : 1;
  let clips = page.clips;
  if (!clips) {   // voice for this page not made yet: make it now
    $('readAll').textContent = '… one moment';
    try { await prepareVoice(book); } catch (e) {}
    if (!alive()) return; clips = book.pages[pg] === page ? page.clips : null; $('readAll').textContent = '■ Stop';
  }
  if (clips && clips.length) {
    for (const c of clips) {
      if (!alive()) return;
      let lastIdx = -1;
      const n = c.end - c.start + 1;
      const ok = await playUrl(c.url, r, (t, dur) => {
        let k = 0;
        if (c.times) { while (k + 1 < n && t >= c.times[k + 1] - 0.03) k++; }
        else if (dur) { k = estWord(c, page, t, dur); }
        if (c.start + k !== lastIdx) { lastIdx = c.start + k; highlight(lastIdx); }
      });
      if (!ok) break;
      await sleep(250);
    }
  } else {
    for (let i = 0; i < page.words.length; i++) { if (!alive()) return; highlight(i); await sysSay(clean(page.words[i].text) || page.words[i].text, rate); }
  }
  if (my === readToken) { reading = false; $('readAll').textContent = '▶ Read to me'; highlight(-1); }
};
$('prevPg').onclick = () => { if (pg > 0) { pg--; renderPage(); } };
$('nextPg').onclick = () => { if (pg < book.pages.length - 1) { pg++; renderPage(); } };
document.addEventListener('keydown', (e) => {
  if ($('vReader').classList.contains('hidden') || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') $('nextPg').click();
  if (e.key === 'ArrowLeft') $('prevPg').click();
});
$('viewToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...$('viewToggle').children].forEach((x) => x.classList.toggle('on', x === b));
  $('stage').className = 'stage' + (b.dataset.v === 'photo' ? ' photo-only' : b.dataset.v === 'text' ? ' text-only' : '');
});
$('speedToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...$('speedToggle').children].forEach((x) => x.classList.toggle('on', x === b)); rate = +b.dataset.s < 0.8 ? 0.7 : 1;
});

/* ================= fixing words (for grown-ups) ================= */
let editDirty = false;
$('editBtn').onclick = () => { $('editArea').classList.toggle('hidden'); renderEdit(); };
$('doneEdit').onclick = async () => {
  $('editArea').classList.add('hidden'); renderPage();
  if (editDirty) { editDirty = false; try { await saveBook(book); } catch (e) { alertMsg(e.message); } prepareVoice(book); }
};
function renderEdit() {
  const ws = pageWords();
  $('editWords').innerHTML = ws.map((w, i) => `<span class="chip${w.conf < 70 ? ' low' : ''}" data-e="${i}">${esc(w.text)}</span>`).join('') +
    '<span class="chip" data-add="1" style="border-style:dashed">＋ add word</span>';
}
function renderPageKeepEdit() { const open = !$('editArea').classList.contains('hidden'); renderPage(); if (open) $('editArea').classList.remove('hidden'); }
$('editWords').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c || c.querySelector('input')) return;
  const ws = pageWords();
  if (c.dataset.add) { const lastW = ws[ws.length - 1]; ws.push({ text: 'word', conf: 100, line: lastW ? lastW.line : 0, box: null }); editDirty = true; renderEdit(); renderPageKeepEdit(); return; }
  const i = +c.dataset.e;
  c.innerHTML = `<input value="${esc(ws[i].text)}">`; const inp = c.querySelector('input'); inp.focus(); inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v !== ws[i].text) editDirty = true;
    if (v) { ws[i].text = v; ws[i].conf = 100; } else ws.splice(i, 1);
    renderEdit(); renderPageKeepEdit();
  };
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = ws[i].text; inp.blur(); } });
  inp.addEventListener('blur', commit, { once: true });
});

/* ================= start ================= */
(async () => {
  try {
    const s = await api('/api/status');
    if (s.voiceId) VOICE_VERSION = s.voiceId;
    if (!s.signedIn) return showLogin();
    goHome();
  } catch (e) { showLogin(); }
})();
