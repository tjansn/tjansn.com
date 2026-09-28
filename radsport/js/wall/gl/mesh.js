/**
 * wall/gl/mesh.js (WP5): the paper model after concept C. Sheet geometry in u, grid meshes with weights
 * w = smoothstep(0, 88 u, distance to pins and held edges), shadow masks, the pin glyph, springs, a CPU mirror of
 * the vertex shader.
 */

export const W = 4789;
export const H = 3527;
export const U = W / 2000;
export const WU = 2000;
export const HU = H / U;
export const R_PIN = 88;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Spring {
  constructor(w, z, x = 0) { this.w = w; this.z = z; this.x = x; this.v = 0; this.t = x; }
  step(dt) {
    const n = dt > 0.012 ? 2 : 1;
    const h = dt / n;
    for (let i = 0; i < n; i += 1) {
      this.v += (this.w * this.w * (this.t - this.x) - 2 * this.z * this.w * this.v) * h;
      this.x += this.v * h;
    }
  }
  busy(e = 1e-3) { return Math.abs(this.t - this.x) > e || Math.abs(this.v) > e * 4; }
  set(v) { this.x = v; this.t = v; this.v = 0; }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

export function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** = liftGeo() of renderer-dom.js (WP4): lift origin near the held edges and pins, amount 0.55 to 1 (wall px). */
export function liftOrigin(bib) {
  const poly = bib.poly || [];
  const n = poly.length;
  const held = new Set(bib.held || []);
  let per = 0; let free = 0; let hx = 0; let hy = 0; let hw = 0;
  for (let i = 0; i < n; i += 1) {
    const a = poly[i]; const c = poly[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    per += len;
    if (held.has(i)) { hx += ((a[0] + c[0]) / 2) * len; hy += ((a[1] + c[1]) / 2) * len; hw += len; } else free += len;
  }
  for (const p of bib.pins || []) { const w = per * 0.08; hx += p[0] * w; hy += p[1] * w; hw += w; }
  let an = bib.anchor;
  if (!Array.isArray(an)) { an = [0, 0]; for (const p of poly) { an[0] += p[0] / (n || 1); an[1] += p[1] / (n || 1); } }
  const origin = hw ? [an[0] + (hx / hw - an[0]) * 0.85, an[1] + (hy / hw - an[1]) * 0.85] : an.slice();
  return { origin, amount: clamp(0.55 + (0.45 * free) / (per || 1), 0.55, 1) };
}

/** Geometry in u; `index` = position in bibs.json (id map R = index + 1). */
export function prepBib(bib, index, idx) {
  const u = (p) => [p[0] / U, p[1] / U];
  const poly = (bib.poly || []).map(u);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const c = Array.isArray(bib.anchor) ? u(bib.anchor) : [(x0 + x1) / 2, (y0 + y1) / 2];
  let R = 1;
  for (const [x, y] of poly) R = Math.max(R, Math.hypot(x - c[0], y - c[1]));
  const cover = new Float32Array(64);
  for (const id of bib.coveredBy || []) { const k = idx.get(id); if (k != null && k + 1 < 64) cover[k + 1] = 1; }
  const n = poly.length;
  const held = (bib.held || []).filter((e) => e >= 0 && e < n).map((e) => [poly[e], poly[(e + 1) % n]]);
  const lo = liftOrigin(bib);
  return {
    id: bib.id, i: index, idx: index + 1, poly, c, R, box: [x0, y0, x1, y1], z: bib.z ?? index, o: u(lo.origin), amount: lo.amount,
    gloss: bib.gloss ?? 0.3, pins: (bib.pins || []).map(u), held, cover,
    quad: Array.isArray(bib.quad) && bib.quad.length === 4 ? bib.quad.map(u) : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    angle: ((bib.obb && bib.obb.angle) || 0) * Math.PI / 180,
    ex: null,
  };
}

/** 0 at held edges and pins, 1 from 88 u away. */
export function weight(g, x, y) {
  if (!g.pins.length && !g.held.length) return 1;
  let d = Infinity;
  for (const p of g.pins) d = Math.min(d, Math.hypot(x - p[0], y - p[1]));
  for (const [a, b] of g.held) d = Math.min(d, segDist(x, y, a[0], a[1], b[0], b[1]));
  return smooth(0, R_PIN, d);
}

export function buildGrid(g) {
  const [bx0, by0, bx1, by1] = g.box;
  const x0 = bx0 - 2; const y0 = by0 - 2; const bw = bx1 - bx0 + 4; const bh = by1 - by0 + 4;
  const cols = clamp(Math.round(bw / 13), 8, 44); const rows = clamp(Math.round(bh / 13), 8, 44);
  const verts = new Float32Array((cols + 1) * (rows + 1) * 5);
  let k = 0;
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const x = x0 + (bw * i) / cols; const y = y0 + (bh * j) / rows;
      const w = weight(g, x, y);
      verts[k++] = x; verts[k++] = y; verts[k++] = w;
      verts[k++] = (weight(g, x + 2, y) - w) / 2; verts[k++] = (weight(g, x, y + 2) - w) / 2;
    }
  }
  const idx = new Uint16Array(cols * rows * 6);
  k = 0;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * (cols + 1) + i; const c = a + cols + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = c; idx[k++] = c + 1;
    }
  }
  return { verts, idx };
}

/** C's blurred mask (the shape off-canvas, its shadow on it). */
export function shadowMask(g) {
  const PAD = 44; const S = 0.5;
  const [x0, y0, x1, y1] = g.box;
  const bx = x0 - PAD; const by = y0 - PAD; const bw = x1 - x0 + 2 * PAD; const bh = y1 - y0 + 2 * PAD;
  const cv = document.createElement('canvas');
  cv.width = Math.max(4, Math.ceil(bw * S)); cv.height = Math.max(4, Math.ceil(bh * S));
  const cx = cv.getContext('2d');
  cx.shadowColor = '#fff'; cx.shadowBlur = 9; cx.shadowOffsetX = 10000;
  cx.scale(S, S); cx.translate(-bx - 10000 / S, -by);
  cx.beginPath();
  g.poly.forEach(([x, y], i) => (i ? cx.lineTo(x, y) : cx.moveTo(x, y)));
  cx.closePath(); cx.fillStyle = '#fff'; cx.fill();
  return { canvas: cv, box: [bx, by, bw, bh] };
}

/** C's safety pin, canvas x -12..66, y -14..14 units. */
export function pinGlyph() {
  const S = 6;
  const cv = document.createElement('canvas');
  cv.width = 78 * S; cv.height = 28 * S;
  const c = cv.getContext('2d');
  c.scale(S, S); c.translate(12, 14);
  const steel = c.createLinearGradient(0, -4.6, 0, 4.6);
  [[0, '#f7f8f9'], [0.42, '#b3b9bf'], [0.58, '#6f767d'], [1, '#dfe3e6']].forEach(([o, s]) => steel.addColorStop(o, s));
  c.shadowColor = 'rgba(0,0,0,0.42)'; c.shadowBlur = 1.6 * S; c.shadowOffsetX = 2 * S; c.shadowOffsetY = 3 * S;
  c.lineCap = 'round'; c.lineWidth = 2.1;
  const stroke = (d, s) => { c.strokeStyle = s; c.stroke(new Path2D(d)); };
  stroke('M2 3.4 L48.5 1.3', '#858c93');
  stroke('M2 -3.4 A3.4 3.4 0 1 0 2 3.4', steel);
  stroke('M2 -3.4 L50 -1.5', steel);
  c.shadowColor = 'transparent';
  c.lineWidth = 1; stroke('M1.3 0 A1.9 1.9 0 1 0 -2.5 0 A1.9 1.9 0 1 0 1.3 0', '#a4abb2');
  const head = new Path2D('M45.5 -4.6 h7 a4.6 4.6 0 0 1 0 9.2 h-7 z');
  c.fillStyle = steel; c.fill(head); c.lineWidth = 0.7; c.strokeStyle = '#737a81'; c.stroke(head);
  return cv;
}

/** CPU mirror of BIB_VS. */
export function deform(g, P, x, y, w0) {
  const w = w0 + (1 - w0) * P.free;
  const dx = x - g.c[0]; const dy = y - g.c[1];
  let z = P.bulge * w * (1 - (0.4 * (dx * dx + dy * dy)) / (g.R * g.R));
  const ph = (x * P.flut[2] + y * P.flut[3]) * 0.021 - P.flut[1];
  z += P.flut[0] * w * (0.5 + 0.5 * Math.sin(ph)) * (0.75 + 0.25 * Math.sin(ph * 0.47 + 1.3));
  const gx = x - P.tug[0]; const gy = y - P.tug[1]; const gs = Math.exp(-(gx * gx + gy * gy) / 28800);
  z += P.tugZ * w * gs + (dx * P.tilt[0] + dy * P.tilt[1]) * w;
  const s = 1 + P.scale * w;
  return [g.o[0] + (x - g.o[0]) * s + (P.tug[2] * gs + P.shift[0]) * w, g.o[1] + (y - g.o[1]) * s + (P.tug[3] * gs + P.shift[1]) * w, Math.max(z, 0) + P.raise];
}
