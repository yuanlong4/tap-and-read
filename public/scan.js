/* Page straightener: finds the book page in a photo, cuts away the background,
 * and corrects the angle so the page is upright and fills the image.
 * Uses OpenCV (loaded only when a grown-up adds a book).
 */
'use strict';
const Scan = (() => {
  let cvP = null;
  function loadCV() {
    if (cvP) return cvP;
    cvP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/opencv.js'; s.async = true;
      s.onerror = () => { cvP = null; reject(new Error('Could not load the page straightener.')); };
      s.onload = () => {
        const c = window.cv;
        if (!c) return reject(new Error('Page straightener failed to start.'));
        // OpenCV's module is itself "thenable"; hand it over wrapped so the promise doesn't wait on itself
        const ready = (m) => { if (m && typeof m.then === 'function') { try { delete m.then; } catch (e) {} } window.cv = m; resolve({ cv: m }); };
        if (c.Mat && c.getPerspectiveTransform) ready(c);
        else if (typeof c.then === 'function') c.then(ready);
        else c.onRuntimeInitialized = () => ready(c);
      };
      document.head.appendChild(s);
    });
    return cvP;
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // order 4 points as top-left, top-right, bottom-right, bottom-left
  function order(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y));
    return [bySum[0], byDiff[3], bySum[3], byDiff[0]];
  }
  function quadArea(q) {
    let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; } return Math.abs(s) / 2;
  }
  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (z !== 0) { if (sign && Math.sign(z) !== sign) return false; sign = Math.sign(z); }
    }
    return true;
  }

  // Look for the page outline in a (small) copy of the photo. Returns 4 corners in that copy's pixels, or null.
  // Three detectors are tried: edges, brightness, and "everything that isn't the table" (colour differs from the
  // photo's border). In each, all large shapes are kept together (both pages of an open book) and wrapped in their
  // convex hull, which also ignores dark pictures or shadows that break an outline. The largest sensible
  // 4-cornered result wins.
  function findPage(cv, src, minFrac, pixels) {
    const W = src.cols, H = src.rows;
    const quadFromMask = (mask) => {
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const pts = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i), hl = new cv.Mat(); cv.convexHull(c, hl, false, true);
        const a = cv.contourArea(hl);
        if (a >= 0.08 * W * H && a <= 0.995 * W * H) for (let k = 0; k < c.data32S.length; k++) pts.push(c.data32S[k]);
        hl.delete(); c.delete();
      }
      contours.delete(); hier.delete();
      if (!pts.length) return null;
      const all = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts), hull = new cv.Mat();
      cv.convexHull(all, hull, false, true); all.delete();
      const area = cv.contourArea(hull); let best = null;
      if (area >= minFrac * W * H && area <= 0.995 * W * H) {
        const peri = cv.arcLength(hull, true);
        for (const eps of [0.02, 0.03, 0.04, 0.06]) {
          const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * peri, true);
          if (ap.rows === 4) { const q = order([0, 1, 2, 3].map((k) => ({ x: ap.data32S[k * 2], y: ap.data32S[k * 2 + 1] }))); if (isConvex(q)) best = q; }
          ap.delete(); if (best) break;
        }
        if (!best) {   // rounded corners etc.: the tightest rotated rectangle around it
          const q = order(cv.RotatedRect.points(cv.minAreaRect(hull)).map((p) => ({ x: p.x, y: p.y })));
          if (quadArea(q) < area * 1.2) best = q;
        }
      }
      hull.delete();
      return best;
    };
    const gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), bright = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)), k9 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    const found = [];
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      // 1) edges
      cv.Canny(blur, edges, 40, 120);
      cv.dilate(edges, edges, k, new cv.Point(-1, -1), 2);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
      found.push(quadFromMask(edges));
      // 2) brightness (pages are usually lighter than the table)
      cv.threshold(blur, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(bright, bright, cv.MORPH_OPEN, k);
      found.push(quadFromMask(bright));
      // 3) everything whose colour differs from the photo's border (the table)
      if (pixels) {
        const d = pixels.data, b = 6, border = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if (y >= b && y < H - b && x >= b && x < W - b) { x = W - b - 1; continue; }
          const o = (y * W + x) * 4; border.push([d[o], d[o + 1], d[o + 2]]);
        }
        const med = (arr) => { const v = arr.slice().sort((p, q) => p - q); return v[v.length >> 1]; };
        const bg = [0, 1, 2].map((c) => med(border.map((px) => px[c])));
        const dist3 = (r, g2, bl) => Math.hypot(r - bg[0], g2 - bg[1], bl - bg[2]);
        const thr = Math.max(40, 3 * med(border.map((px) => dist3(px[0], px[1], px[2]))));
        const m = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) { const o = i * 4; m[i] = dist3(d[o], d[o + 1], d[o + 2]) > thr ? 255 : 0; }
        const mask = cv.matFromArray(H, W, cv.CV_8UC1, m);
        cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k9);
        cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
        found.push(quadFromMask(mask)); mask.delete();
      }
    } finally { gray.delete(); blur.delete(); edges.delete(); bright.delete(); k.delete(); k9.delete(); }
    const ok = found.filter(Boolean);
    if (!ok.length) return null;
    return ok.reduce((a, q) => (quadArea(q) > quadArea(a) ? q : a));
  }

  // Straighten + crop. Takes an image/canvas, returns a canvas (or null when no page was found).
  // One pass only: picture-book illustrations are rectangles too, so looking again inside would crop to the picture.
  const straighten = (img) => straightenOnce(img, 0.2);
  async function straightenOnce(img, minFrac) {
    const { cv } = await loadCV();
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    // detect on a small copy (fast), then warp the full-size image
    const s = Math.min(1, 900 / Math.max(W, H));
    const small = document.createElement('canvas'); small.width = Math.round(W * s); small.height = Math.round(H * s);
    small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
    const srcSmall = cv.imread(small), pixels = small.getContext('2d').getImageData(0, 0, small.width, small.height);
    let q;
    try { q = findPage(cv, srcSmall, minFrac, pixels); } finally { srcSmall.delete(); }
    if (!q) return null;
    q = q.map((p) => ({ x: p.x / s, y: p.y / s }));
    // don't bother if the page already fills the photo
    if (quadArea(q) > W * H * 0.93) return null;
    const outW = Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2])));
    const outH = Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2])));
    if (outW < 200 || outH < 200) return null;
    const full = document.createElement('canvas'); full.width = W; full.height = H;
    full.getContext('2d').drawImage(img, 0, 0);
    const src = cv.imread(full), dst = new cv.Mat();
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, q.flatMap((p) => [p.x, p.y]));
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    const M = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      // trim a thin border so no table edge is left
      const inset = Math.round(Math.min(outW, outH) * 0.006);
      const out = document.createElement('canvas'); out.width = outW - inset * 2; out.height = outH - inset * 2;
      const tmp = document.createElement('canvas'); tmp.width = outW; tmp.height = outH;
      cv.imshow(tmp, dst);
      out.getContext('2d').drawImage(tmp, inset, inset, out.width, out.height, 0, 0, out.width, out.height);
      return out;
    } finally { src.delete(); dst.delete(); from.delete(); to.delete(); M.delete(); }
  }

  function rotate90(canvas) {   // clockwise
    const out = document.createElement('canvas'); out.width = canvas.height; out.height = canvas.width;
    const g = out.getContext('2d'); g.translate(out.width, 0); g.rotate(Math.PI / 2); g.drawImage(canvas, 0, 0);
    return out;
  }

  return { load: loadCV, straighten, rotate90 };
})();
