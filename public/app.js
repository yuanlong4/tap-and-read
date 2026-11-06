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
let canRedraw = false;           // ✨ Redraw is available when the OpenAI key is set
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
  for (const v of ['vLogin', 'vLibrary', 'vBuilder', 'vReader', 'vEdit']) $(v).classList.toggle('hidden', v !== view);
  document.body.classList.toggle('reading', view === 'vReader');
  $('homeBtn').classList.toggle('hidden', view === 'vLibrary' || view === 'vLogin');
  $('signOutBtn').classList.toggle('hidden', view !== 'vLibrary');
  stopAll();
}
function ask(title, text, yes = 'OK', no = 'Cancel') {
  return new Promise((res) => {
    $('mTitle').textContent = title; $('mText').textContent = text; $('mYes').textContent = yes; $('mNo').textContent = no;
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
        const s = await api('/api/status').catch(() => null); if (s && s.voiceId) VOICE_VERSION = s.voiceId; canRedraw = !!(s && s.redraw); goHome(); }
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
      <div class="acts"><button class="btn small sun" data-open="${b.id}">Read</button><button class="btn small ghost" data-edit="${b.id}">Edit</button><button class="btn small ghost" data-del="${b.id}">Delete</button></div>
    </div>`).join('');
}
$('shelf').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]'), ed = e.target.closest('[data-edit]');
  if (ed) { try { openEditPages(await api('/api/books/' + ed.dataset.edit), 'library'); } catch (err) { if (err.status !== 401) alertMsg(err.message); } return; }
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
function openBuilder() { pending = []; $('bTitle').value = ''; $('progress').textContent = ''; renderThumbs(); show('vBuilder'); Scan.load().catch(() => {}); }
function loadCanvas(file) {   // photo -> canvas, at most 2000 px on the long edge (phone photos come out upright)
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const max = 2000, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not open ' + file.name)); };
    img.src = url;
  });
}
const toBlob = (canvas, q = 0.85) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
function rotateTimes(canvas, quarterTurns) { let c = canvas; for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) c = Scan.rotate90(c); return c; }
// the version of a page we'll use: straightened (unless switched off), turned as asked
function finalCanvas(p) { return rotateTimes(p.useCrop && p.crop ? p.crop : p.orig, p.rot); }
async function refreshThumb(p) { const c = p.useRedraw && p.redraw ? p.redraw : finalCanvas(p); if (p.src) URL.revokeObjectURL(p.src); p.src = URL.createObjectURL(await toBlob(c, 0.7)); }

async function addFiles(list) {
  const files = [...list].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const added = [];
  for (const f of files) {
    try { const orig = await loadCanvas(f); const p = { name: f.name, orig, crop: null, useCrop: true, rot: 0, busy: true }; await refreshThumb(p); pending.push(p); added.push(p); }
    catch (e) { console.warn(e); }
  }
  renderThumbs();
  if (!added.length) return;
  $('progress').textContent = 'Straightening the pages…';
  for (const p of added) {   // find the page in each photo, cut away the background, straighten it
    try { p.crop = await Scan.straighten(p.orig); } catch (e) { console.warn('straighten failed', e); }
    p.busy = false; await refreshThumb(p); renderThumbs();
  }
  if ($('progress').textContent.startsWith('Straightening')) $('progress').textContent = '';
}
function renderThumbs() {
  $('thumbs').innerHTML = pending.map((p, i) => `
    <div class="thumb${p.busy ? ' busy' : ''}">
      <div class="im"><img src="${p.src}" alt="page ${i + 1}"><span class="n">p.${i + 1}</span><div class="st"><i id="st${i}"></i></div></div>
      <div class="cap">${p.busy ? 'Straightening…' : p.redrawBusy ? '✨ Redrawing… (about 20 s)' : p.redraw && p.useRedraw ? '✨ Redrawn' : p.crop ? (p.useCrop ? '✓ Straightened' : 'Original photo') : 'Page not found: original'}</div>
      <div class="tb">
        <button data-a="l" data-i="${i}" title="Move earlier">◀</button><button data-a="r" data-i="${i}" title="Move later">▶</button>
        <button data-a="rot" data-i="${i}" title="Turn the page">⟳</button>
        ${p.crop ? `<button data-a="crop" data-i="${i}" title="Switch between the straightened page and the original photo">✂</button>` : ''}
        ${canRedraw ? `<button data-a="redraw" data-i="${i}" title="${p.redraw ? (p.useRedraw ? 'Go back to the photo' : 'Use the redrawn page') : 'Redraw as a clean scan (AI)'}">${p.redraw && p.useRedraw ? '↩' : '✨'}</button>` : ''}
        <button data-a="x" data-i="${i}" title="Remove">✕</button>
      </div>
    </div>`).join('');
  $('buildBtn').disabled = !pending.length || pending.some((p) => p.busy || p.redrawBusy);
}
$('thumbs').addEventListener('click', (e) => {
  if (e.target.closest('button') && (pending[+e.target.closest('button').dataset.i]?.busy || pending[+e.target.closest('button').dataset.i]?.redrawBusy)) return;
  const b = e.target.closest('button'); if (!b) return; const i = +b.dataset.i;
  if (b.dataset.a === 'x') pending.splice(i, 1);
  if (b.dataset.a === 'l' && i > 0) [pending[i - 1], pending[i]] = [pending[i], pending[i - 1]];
  if (b.dataset.a === 'r' && i < pending.length - 1) [pending[i + 1], pending[i]] = [pending[i], pending[i + 1]];
  if (b.dataset.a === 'rot' || b.dataset.a === 'crop') {
    const p = pending[i]; if (b.dataset.a === 'rot') p.rot = (p.rot + 1) % 4; else p.useCrop = !p.useCrop;
    p.redraw = null; p.useRedraw = false;   // the redrawn version no longer matches
    refreshThumb(p).then(renderThumbs); return;
  }
  if (b.dataset.a === 'redraw') {
    const p = pending[i];
    if (p.redraw) { p.useRedraw = !p.useRedraw; refreshThumb(p).then(renderThumbs); return; }
    p.redrawBusy = true; renderThumbs();
    redrawCanvas(finalCanvas(p))
      .then(async (c) => { p.redraw = c; p.useRedraw = true; await refreshThumb(p); })
      .catch((err) => alertMsg('Redraw did not work: ' + err.message))
      .finally(() => { p.redrawBusy = false; renderThumbs(); });
    return;
  }
  renderThumbs();
});
$('files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('cancelBuild').onclick = () => goHome();

const blobToB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
function b64ToBlob(b64, type = 'image/jpeg') { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }
function blobToCanvas(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url); res(c); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not open the picture.')); };
    img.src = url;
  });
}
const readPageApi = async (canvas) => api('/api/read-page', { method: 'POST', body: JSON.stringify({ image: await blobToB64(await toBlob(canvas)) }) });
// ✨ Redraw: OpenAI's image model turns the photo into a clean, flat "scan" of the same page
async function redrawCanvas(canvas) {
  const r = await api('/api/redraw', { method: 'POST', body: JSON.stringify({ image: await blobToB64(await toBlob(canvas, 0.9)), w: canvas.width, h: canvas.height }) });
  return blobToCanvas(b64ToBlob(r.image));
}
// How alike two readings of a page are (1 = same words), word by word
function textSimilarity(linesA, linesB) {
  const toks = (ls) => ls.join(' ').split(/\s+/).map(norm).filter(Boolean);
  const a = toks(linesA), b = toks(linesB);
  if (!a.length && !b.length) return 1;
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return 1 - prev[n] / Math.max(m, n);
}
// The page's words back as printed lines (paragraph gaps as "")
function linesFromWords(words) {
  const out = []; let last = null, cur = [];
  for (const w of words) {
    if (last !== null && w.line !== last) { out.push(cur.join(' ')); cur = []; if (w.line - last >= 1000) out.push(''); }
    cur.push(w.text); last = w.line;
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}
// Find where the given words sit on a picture
async function findBoxes(blob, lines) {
  const ocr = await getOCR();
  const { data } = await ocr.recognize(blob, {}, { blocks: true, text: true });
  const found = ocrWords(data);
  return lines ? alignWords(lines, found) : cleanOCROnly(found);
}
const putPhoto = async (bookId, n, blob) => api(`/api/photos/${bookId}/${n}`, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
const SIMILAR_ENOUGH = 1;   // every word must match (punctuation and capitals ignored)

$('buildBtn').onclick = async () => {
  const title = $('bTitle').value.trim() || 'My book';
  const pages = pending.slice(), prog = $('progress'), N = pages.length;
  $('buildBtn').disabled = true; $('cancelBuild').disabled = true;
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rejected = [];
  try {
    // 1. Claude reads each page photo (two at a time); sideways pages are turned; photos are stored.
    //    A redrawn page is read too, and only used if Claude finds the same words on it.
    let claudeDone = 0;
    const tick = () => { prog.textContent = `Reading the pages… Claude has read ${claudeDone} of ${N}`; };
    tick();
    const ready = pages.map(() => { let r; const pr = new Promise((x) => { r = x; }); return { pr, r }; });
    const work = pool(pages, 2, async (p, i) => {
      let canvas = finalCanvas(p), lines = null, turn = 0;
      try {
        const r = await readPageApi(canvas);
        lines = r.lines; turn = (r.rotate || 0) / 90;
        if (turn) canvas = rotateTimes(canvas, turn);
      } catch (e) { console.warn('Claude could not read page', i + 1, e.message); if (e.status === 503 || e.status === 401) { ready[i].r({ error: e }); throw e; } }
      const origBlob = await toBlob(canvas);
      await putPhoto(id, i, origBlob);
      const out = { lines, orig: { n: i, w: canvas.width, h: canvas.height }, blob: origBlob, use: 'orig' };
      if (p.useRedraw && p.redraw && lines) {
        const rc = rotateTimes(p.redraw, turn);
        try {
          const r2 = await readPageApi(rc);
          if (textSimilarity(lines, r2.lines) >= SIMILAR_ENOUGH) {
            const rb = await toBlob(rc); await putPhoto(id, N + i, rb);
            Object.assign(out, { redraw: { n: N + i, w: rc.width, h: rc.height }, blob: rb, use: 'redraw' });
          } else rejected.push(i + 1);
        } catch (e) { rejected.push(i + 1); }
      }
      claudeDone++; tick();
      ready[i].r(out);
    });
    work.catch(() => {});
    // 2. as each page is ready, find where its words sit on the picture shown
    const ocr = await getOCR(); let cur = -1;
    ocrLogger = (m) => { if (cur >= 0 && m.status === 'recognizing text') { const el = $('st' + cur); if (el) el.style.width = Math.round(m.progress * 100) + '%'; } };
    const book = { id, title, created: Date.now(), updated: Date.now(), wordClips: {}, voice: VOICE_VERSION, photoSeq: 2 * N, pages: [] };
    for (let i = 0; i < N; i++) {
      const r = await ready[i].pr; if (r.error) throw r.error;
      cur = i; const { data } = await ocr.recognize(r.blob, {}, { blocks: true, text: true });
      const found = ocrWords(data), shown = r[r.use];
      book.pages.push({ n: shown.n, w: shown.w, h: shown.h, source: r.lines ? 'claude' : 'ocr',
        words: r.lines ? alignWords(r.lines, found) : cleanOCROnly(found), clips: null,
        versions: { orig: { ...r.orig }, ...(r.redraw ? { redraw: { ...r.redraw } } : {}) }, use: r.use });
      const el = $('st' + i); if (el) el.style.width = '100%';
    }
    ocrLogger = null;
    await work;
    // 3. save it
    await saveBook(book);
    openReader(book, 0);
    prepareVoice(book);
    if (rejected.length) alertMsg(`The redrawn version of page ${rejected.join(', ')} seemed to have different words, so the original photo is used there. You can try ✨ again from Edit pages.`);
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
function openReader(b, p) { migrateBook(b); book = b; pg = p; show('vReader'); $('rTitle').textContent = b.title; $('editArea').classList.add('hidden'); setView(view); renderPage(); }
// Size the page photo so the whole page fits in the window
function fitPhoto() {
  if (!book || $('vReader').classList.contains('hidden')) return;
  const page = book.pages[pg], pane = $('photopane');
  if (!$('stage').classList.contains('photo-only')) { pane.style.width = ''; return; }
  const top = $('photowrap').getBoundingClientRect().top + window.scrollY;
  const navH = $('vReader').querySelector('.nav').offsetHeight + 30;
  const availH = Math.max(240, window.innerHeight - top - navH), availW = $('photowrap').clientWidth;
  pane.style.width = Math.floor(Math.min(availW, availH * page.w / page.h)) + 'px';
}
window.addEventListener('resize', fitPhoto);
window.addEventListener('orientationchange', () => setTimeout(fitPhoto, 300));
const pageWords = () => book.pages[pg].words;
function renderPage() {
  stopAll();
  const page = book.pages[pg];
  $('pageImg').src = `/api/photos/${book.id}/${page.n ?? pg}`;
  $('bubble').classList.add('hidden'); fitPhoto();
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
  if ($('stage').classList.contains('photo-only')) {
    const bub = $('bubble'); bub.innerHTML = `${esc(word)}${syl.length > 1 ? `<span class="syl">${syl.map(esc).join(' · ')}</span>` : ''}`;
    bub.classList.remove('hidden'); clearTimeout(bub._t); bub._t = setTimeout(() => bub.classList.add('hidden'), 2500);
  }
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
let view = (() => { try { return localStorage.getItem('tr-view') || 'photo'; } catch (e) { return 'photo'; } })();
function setView(v) {
  view = v; try { localStorage.setItem('tr-view', v); } catch (e) {}
  [...$('viewToggle').children].forEach((x) => x.classList.toggle('on', x.dataset.v === v));
  $('stage').className = 'stage' + (v === 'photo' ? ' photo-only' : v === 'text' ? ' text-only' : '');
  fitPhoto();
}
$('viewToggle').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
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

/* ================= edit pages (for grown-ups) ================= */
const photoUrl = (b, n) => `/api/photos/${b.id}/${n}`;
// older books: give every page a record of its photo versions
function migrateBook(b) {
  for (const p of b.pages) if (!p.versions) { p.versions = { orig: { n: p.n ?? b.pages.indexOf(p), w: p.w, h: p.h } }; p.use = 'orig'; p.n = p.versions.orig.n; }
  if (b.photoSeq == null) b.photoSeq = 1 + Math.max(-1, ...b.pages.flatMap((p) => Object.values(p.versions).map((v) => v.n)));
}
const nextPhoto = (b) => b.photoSeq++;
async function fetchCanvas(b, n) { const r = await fetch(photoUrl(b, n)); if (!r.ok) throw new Error('Could not load a page photo.'); return blobToCanvas(await r.blob()); }
const deletePhotos = (b, ns) => Promise.all(ns.map((n) => api(photoUrl(b, n), { method: 'DELETE' }).catch(() => {})));

// Show the original photo or the redrawn one (tap spots are found for each picture once, then remembered)
async function useVersion(b, page, which) {
  const v = page.versions[which]; if (!v || page.use === which) return;
  page.versions[page.use].boxes = page.words.map((w) => w.box);
  let boxes = v.boxes;
  if (!boxes || boxes.length !== page.words.length) {
    const r = await fetch(photoUrl(b, v.n)); if (!r.ok) throw new Error('Could not load a page photo.');
    boxes = (await findBoxes(await r.blob(), linesFromWords(page.words))).map((w) => w.box);
  }
  page.words.forEach((w, i) => { w.box = boxes[i] || null; });
  page.use = which; page.n = v.n; page.w = v.w; page.h = v.h;
}
// Turn a page a quarter turn clockwise (every version, and the tap spots with it)
async function rotatePage(b, page) {
  const old = [];
  for (const [k, v] of Object.entries(page.versions)) {
    const c = Scan.rotate90(await fetchCanvas(b, v.n)); const n = nextPhoto(b);
    await putPhoto(b.id, n, await toBlob(c)); old.push(v.n);
    const rb = (x) => (x ? { x0: v.h - x.y1, y0: x.x0, x1: v.h - x.y0, y1: x.x1 } : null);
    if (k === page.use) page.words.forEach((w) => { w.box = rb(w.box); });
    page.versions[k] = { n, w: v.h, h: v.w, ...(v.boxes ? { boxes: v.boxes.map(rb) } : {}) };
  }
  const cur = page.versions[page.use]; page.n = cur.n; page.w = cur.w; page.h = cur.h;
  return old;
}
// A new page from a photo: straighten, Claude reads it, store it, find the words on it
async function pageFromFile(b, file, step) {
  let c = await loadCanvas(file);
  step('straightening…'); try { const cr = await Scan.straighten(c); if (cr) c = cr; } catch (e) { console.warn(e); }
  step('Claude is reading…'); let lines = null;
  try { const r = await readPageApi(c); lines = r.lines; if (r.rotate) c = rotateTimes(c, r.rotate / 90); }
  catch (e) { if (e.status === 401 || e.status === 503) throw e; console.warn('Claude could not read the page', e.message); }
  const n = nextPhoto(b), blob = await toBlob(c); await putPhoto(b.id, n, blob);
  step('finding the words…');
  return { n, w: c.width, h: c.height, source: lines ? 'claude' : 'ocr', words: await findBoxes(blob, lines), clips: null, versions: { orig: { n, w: c.width, h: c.height } }, use: 'orig' };
}
// ✨ Redraw an existing page from its original photo; keep it only if Claude finds the same words
async function redrawPage(b, page) {
  const rc = await redrawCanvas(await fetchCanvas(b, page.versions.orig.n));
  const check = await readPageApi(rc);
  if (textSimilarity(linesFromWords(page.words), check.lines) < SIMILAR_ENOUGH) {
    const keep = await ask('The redrawn page looks different', 'Claude found different words on the redrawn page, so the AI may have changed some text. Keep the original photo?', 'Keep original', 'Use redraw anyway');
    if (keep) return [];
  }
  const old = page.versions.redraw ? [page.versions.redraw.n] : [];
  if (page.use === 'redraw') await useVersion(b, page, 'orig');
  const n = nextPhoto(b), blob = await toBlob(rc); await putPhoto(b.id, n, blob);
  page.versions.redraw = { n, w: rc.width, h: rc.height, boxes: (await findBoxes(blob, linesFromWords(page.words))).map((w) => w.box) };
  await useVersion(b, page, 'redraw');
  return old;
}

let editing = null;   // { book, from, busy, status: {i, text} }
function openEditPages(b, from) {
  migrateBook(b); stopAll();
  editing = { book: b, from, busy: false, status: null };
  $('eTitle').value = b.title; $('eProg').textContent = '';
  show('vEdit'); renderEditPages();
}
function renderEditPages() {
  const b = editing.book, st = editing.status;
  $('vEdit').classList.toggle('locked', editing.busy);
  $('eGrid').innerHTML = b.pages.map((p, i) => {
    const busy = st && st.i === i;
    const cap = busy ? st.text : `${p.use === 'redraw' ? '✨ Redrawn' : 'Photo'} · ${p.words.length} word${p.words.length === 1 ? '' : 's'}`;
    const redrawBtn = !canRedraw && !p.versions.redraw ? ''
      : p.use === 'redraw' ? `<button data-e="orig" data-i="${i}" title="Go back to the original photo">↩</button>`
      : p.versions.redraw ? `<button data-e="useredraw" data-i="${i}" title="Use the redrawn page again">✨</button>${canRedraw ? `<button data-e="redraw" data-i="${i}" title="Redraw again (AI)">✨+</button>` : ''}`
      : `<button data-e="redraw" data-i="${i}" title="Redraw as a clean scan (AI)">✨</button>`;
    return `<div class="thumb${busy ? ' busy' : ''}">
      <div class="im"><img src="${photoUrl(b, p.n)}" alt="page ${i + 1}" loading="lazy"><span class="n">p.${i + 1}</span></div>
      <div class="cap">${esc(cap)}</div>
      <div class="tb">
        <button data-e="l" data-i="${i}" title="Move earlier">◀</button><button data-e="r" data-i="${i}" title="Move later">▶</button>
        <button data-e="rot" data-i="${i}" title="Turn the page">⟳</button>${redrawBtn}
        <button data-e="replace" data-i="${i}" title="Replace with a new photo">↻</button>
        <button data-e="words" data-i="${i}" title="Fix words on this page">✎</button>
        <button data-e="del" data-i="${i}" title="Remove this page">✕</button>
      </div></div>`;
  }).join('');
}
// Run one change at a time; save the book after each, then tidy up photos that are no longer used
async function editOp(i, text, fn) {
  if (editing.busy) return;
  const b = editing.book;
  editing.busy = true; editing.status = { i, text }; renderEditPages();
  try {
    const unused = (await fn()) || [];
    await saveBook(b);
    if (unused.length) deletePhotos(b, unused);
  } catch (e) { console.error(e); if (e.status !== 401) alertMsg(e.message); }
  finally { editing.busy = false; editing.status = null; $('eProg').textContent = ''; renderEditPages(); }
}
let replaceAt = -1;
$('eGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn || !editing || editing.busy) return;
  const b = editing.book, i = +btn.dataset.i, page = b.pages[i];
  switch (btn.dataset.e) {
    case 'l': if (i > 0) editOp(-1, '', () => { [b.pages[i - 1], b.pages[i]] = [b.pages[i], b.pages[i - 1]]; }); break;
    case 'r': if (i < b.pages.length - 1) editOp(-1, '', () => { [b.pages[i + 1], b.pages[i]] = [b.pages[i], b.pages[i + 1]]; }); break;
    case 'rot': editOp(i, 'Turning…', () => rotatePage(b, page)); break;
    case 'redraw': editOp(i, '✨ Redrawing… (about 20 s)', () => redrawPage(b, page)); break;
    case 'orig': editOp(i, 'Switching…', () => useVersion(b, page, 'orig')); break;
    case 'useredraw': editOp(i, 'Switching…', () => useVersion(b, page, 'redraw')); break;
    case 'replace': replaceAt = i; $('eReplace').click(); break;
    case 'words': saveBook(b).catch(() => {}); openReader(b, i); $('editArea').classList.remove('hidden'); renderEdit(); break;
    case 'del':
      if (b.pages.length === 1) { alertMsg('A book needs at least one page. To remove the whole book, use Delete in the library.'); break; }
      ask('Remove this page?', `Page ${i + 1} will be removed from “${b.title}”.`, 'Remove').then((yes) => {
        if (yes) editOp(-1, '', () => { const gone = b.pages.splice(i, 1)[0]; return Object.values(gone.versions).map((v) => v.n); });
      });
      break;
  }
});
$('eReplace').addEventListener('change', (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || replaceAt < 0) return;
  const b = editing.book, i = replaceAt; replaceAt = -1;
  editOp(i, 'New photo: getting ready…', async () => {
    const np = await pageFromFile(b, f, (t) => { editing.status = { i, text: 'New photo: ' + t }; renderEditPages(); });
    const old = b.pages[i]; b.pages[i] = np;
    return Object.values(old.versions).map((v) => v.n);
  });
});
$('eAdd').addEventListener('change', (e) => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); e.target.value = '';
  if (!files.length) return;
  const b = editing.book;
  editOp(-1, '', async () => {
    Scan.load().catch(() => {});
    for (let k = 0; k < files.length; k++) {
      const np = await pageFromFile(b, files[k], (t) => { $('eProg').textContent = `Adding page ${k + 1} of ${files.length}: ${t}`; });
      b.pages.push(np); renderEditPages();
      await saveBook(b);
    }
  });
});
let titleTimer = 0;
$('eTitle').addEventListener('input', () => {
  const b = editing.book, v = $('eTitle').value.trim();
  clearTimeout(titleTimer); if (!v) return;
  titleTimer = setTimeout(() => { b.title = v; saveBook(b).catch((err) => alertMsg(err.message)); }, 600);
});
$('eDone').onclick = async () => {
  if (editing.busy) return;
  const b = editing.book, v = $('eTitle').value.trim();
  clearTimeout(titleTimer); if (v && v !== b.title) { b.title = v; }
  try { await saveBook(b); } catch (e) { if (e.status !== 401) alertMsg(e.message); return; }
  const from = editing.from; editing = null;
  if (from === 'reader') openReader(b, Math.min(pg, b.pages.length - 1)); else goHome();
  prepareVoice(b);
};
$('editPagesBtn').onclick = () => { if (book) openEditPages(book, 'reader'); };

/* ================= start ================= */
(async () => {
  try {
    const s = await api('/api/status');
    if (s.voiceId) VOICE_VERSION = s.voiceId;
    canRedraw = !!s.redraw;
    if (!s.signedIn) return showLogin();
    goHome();
  } catch (e) { showLogin(); }
})();
