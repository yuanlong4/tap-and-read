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
  // A page is a convex 4-sided shape, so each candidate is wrapped in its convex hull first: that ignores
  // dark pictures or shadows that break the outline.
  function findPage(cv, src, minFrac) {
    const W = src.cols, H = src.rows;
    const gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), tmp = new cv.Mat();
    const tryMask = (mask) => {
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const list = [];
      for (let i = 0; i < contours.size(); i++) { const c = contours.get(i); list.push({ c, area: cv.contourArea(c) }); }
      list.sort((x, y) => y.area - x.area);
      let best = null;
      for (const { c } of list.slice(0, 3)) {
        if (best) break;
        const hull = new cv.Mat(); cv.convexHull(c, hull, false, true);
        const area = cv.contourArea(hull);
        if (area >= minFrac * W * H && area <= 0.995 * W * H) {
          const peri = cv.arcLength(hull, true);
          for (const eps of [0.02, 0.03, 0.04, 0.06]) {
            const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * peri, true);
            if (ap.rows === 4) best = order([0, 1, 2, 3].map((k) => ({ x: ap.data32S[k * 2], y: ap.data32S[k * 2 + 1] })));
            ap.delete(); if (best) break;
          }
          if (!best) {   // rounded corners etc.: use the tightest rotated rectangle around it
            const q = order(cv.RotatedRect.points(cv.minAreaRect(hull)).map((p) => ({ x: p.x, y: p.y })));
            if (quadArea(q) < area * 1.2) best = q;
          }
        }
        hull.delete();
      }
      list.forEach(({ c }) => c.delete()); contours.delete(); hier.delete();
      return best && isConvex(best) ? best : null;
    };
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      // 1) outline by edges
      cv.Canny(blur, edges, 40, 120);
      cv.dilate(edges, edges, k, new cv.Point(-1, -1), 2);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
      let q = tryMask(edges);
      // 2) outline by brightness (pages are usually lighter than the table)
      if (!q) { cv.threshold(blur, tmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); cv.morphologyEx(tmp, tmp, cv.MORPH_OPEN, k); q = tryMask(tmp); }
      k.delete();
      return q;
    } finally { gray.delete(); blur.delete(); edges.delete(); tmp.delete(); }
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
    const srcSmall = cv.imread(small);
    let q;
    try { q = findPage(cv, srcSmall, minFrac); } finally { srcSmall.delete(); }
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
