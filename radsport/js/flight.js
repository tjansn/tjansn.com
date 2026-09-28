/**
 * flight.js (WP6): the DOM flyer between the wall and the exhibit slot (spec 1.4, 3.7, 5.3 to 5.5).
 *
 *   quadToMatrix3d(w, h, quad) -> string   matrix3d that maps the w x h box onto a screen quad [TL, TR, BR, BL]
 *   flyToSlot({ bibId, fromQuad, slotEl, crop: { src, w, h }, reduced, layer, rotate, dur, onStart, toQuad, remeasure, remeasureAt }) -> Promise<HTMLElement>
 *     toQuad: the slot measured before the sheet's entrance transform (else measured now)
 *     remeasure(): the slot again late in the flight; a moved slot bends the rest of the path onto it
 *   flyBack({ el, toQuad, reduced, fromEl, rotate, dur, delay, fromQuad, shadow0, remeasure }) -> Promise
 *     remeasure(): the target again at 94 % (a camera still settling); a moved target bends the last bit of the path
 * Additions: slotQuad(el, deg), quadVisible(quad, share), redirect(el, { toQuad, dur, rotate, remeasure }) -> Promise
 *   (Esc during the flight: from where the flyer is to toQuad; it replaced reverseFlight/finishFlight, which nothing used)
 *
 * The flyer is laid out at slot size and transformed down onto the wall quad at t = 0, so it stays sharp when it
 * lands. The path is sampled into WAAPI keyframes (compositor thread): centre, angle and size interpolate apart, so
 * a tilted number turns instead of shearing, plus a 3D arc toward the viewer (apex at 46 %). Every await races a
 * timeout (duration + 400 ms), so a hidden tab never leaves a flyer half way.
 */

const EASE_FLIGHT = [0.22, 0.72, 0.18, 1];
const EASE_CINE = [0.65, 0, 0.35, 1];
const PERSPECTIVE = 1200;
const lerp = (a, b, t) => a + (b - a) * t;

function cubic([x1, y1, x2, y2]) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0; let hi = 1; let t = x;
    for (let i = 0; i < 40; i += 1) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** Heckbert's square-to-quad projection: (u, v) in [0,1]^2 -> quad [TL, TR, BR, BL]. */
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dy1 = y1 - y2; const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

const num = (v) => (Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(12)));

export function quadToMatrix3d(w, h, quad) {
  const [a, b, c, d, e, f, g, k] = squareToQuad(quad);
  // column-major: x' = a/w x + b/h y + c, y' = d/w x + e/h y + f, w' = g/w x + k/h y + 1
  return `matrix3d(${[a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, c, f, 0, 1].map(num).join(',')})`;
}

const center = (q) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

/** Centre, angle, size and the normalised residual shape of a quad (so paths can turn instead of shear). */
function frameOf(q) {
  const c = center(q);
  const top = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  const bot = [q[2][0] - q[3][0], q[2][1] - q[3][1]];
  const ang = Math.atan2(top[1] + bot[1], top[0] + bot[0]);
  const w = (Math.hypot(top[0], top[1]) + Math.hypot(bot[0], bot[1])) / 2 || 1;
  const h = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2 || 1;
  const cs = Math.cos(-ang); const sn = Math.sin(-ang);
  const r = q.map(([x, y]) => { const dx = x - c[0]; const dy = y - c[1]; return [(dx * cs - dy * sn) / w, (dx * sn + dy * cs) / h]; });
  return { c, ang, w, h, r };
}

function mixFrames(A, B, t) {
  let da = B.ang - A.ang;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const ang = A.ang + da * t; const w = lerp(A.w, B.w, t); const h = lerp(A.h, B.h, t);
  const cx = lerp(A.c[0], B.c[0], t); const cy = lerp(A.c[1], B.c[1], t);
  const cs = Math.cos(ang); const sn = Math.sin(ang);
  return A.r.map((p, i) => {
    const x = lerp(p[0], B.r[i][0], t) * w; const y = lerp(p[1], B.r[i][1], t) * h;
    return [cx + x * cs - y * sn, cy + x * sn + y * cs];
  });
}

/** Rotate the quad in 3D about its centre (rotateX, rotateY), move it toward the viewer and project it back. */
function lift3d(q, rx, ry, z) {
  const c = center(q);
  const cx = Math.cos(rx); const sx = Math.sin(rx); const cy = Math.cos(ry); const sy = Math.sin(ry);
  return q.map(([x, y]) => {
    const X = x - c[0]; const Y = y - c[1];
    const X1 = X * cy; const Z1 = -X * sy;
    const Y2 = Y * cx - Z1 * sx; const Z2 = Y * sx + Z1 * cx + z;
    const k = PERSPECTIVE / Math.max(80, PERSPECTIVE - Z2);
    return [c[0] + X1 * k, c[1] + Y2 * k];
  });
}

const bump = (u, apex) => Math.sin(Math.PI * (u <= apex ? (0.5 * u) / apex : 0.5 + (0.5 * (u - apex)) / (1 - apex)));
const RAD = Math.PI / 180;

/** WAAPI keyframes along the path; `fix` { d, u0 } bends the rest after progress u0 by the corner offsets d. */
function keyframes(from, to, w, h, dur, { ease, z = 0, rx = 0, ry = 0, apex = 0.5, fix = null }) {
  const A = frameOf(from); const B = frameOf(to); const E = cubic(ease);
  const n = Math.max(12, Math.round(dur / 28));
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    let q = mixFrames(A, B, E(u));
    const s = i === 0 || i === n ? 0 : bump(u, apex);
    if (s > 1e-4) q = lift3d(q, rx * s * RAD, ry * s * RAD, z * s);
    if (fix && u > fix.u0) {
      const k = Math.min(1, (u - fix.u0) / Math.max(1e-6, 1 - fix.u0));
      const b = k * k * (3 - 2 * k);
      q = q.map((p, j) => [p[0] + fix.d[j][0] * b, p[1] + fix.d[j][1] * b]);
    }
    out.push({ offset: u, transform: quadToMatrix3d(w, h, q) });
  }
  return out;
}

const quadGap = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

/** On-screen quad of a box that CSS rotates by `deg` about its centre (layout size + bounding-box centre). */
export function slotQuad(el, deg = 0) {
  const r = el.getBoundingClientRect();
  const w = el.offsetWidth || r.width; const h = el.offsetHeight || r.height;
  const c = [r.left + r.width / 2, r.top + r.height / 2];
  const a = deg * RAD; const cs = Math.cos(a); const sn = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs]);
}

/** True when at least `share` of the quad's box lies inside the viewport. */
export function quadVisible(quad, share = 0.35) {
  if (!validQuad(quad)) return false;
  const xs = quad.map((p) => p[0]); const ys = quad.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const vw = Math.max(0, Math.min(x1, innerWidth) - Math.max(x0, 0));
  const vh = Math.max(0, Math.min(y1, innerHeight) - Math.max(y0, 0));
  return (vw * vh) / area >= share;
}

export function validQuad(q) {
  return Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function settle(anims, ms) {
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { for (const a of anims) { try { a.finish(); } catch (_) { /* cancelled */ } } end(); }, ms);
    Promise.all(anims.map((a) => a.finished.catch(() => null))).then(end);
  });
}

/** After the next frame (50 ms in a hidden tab): the end pose is painted once before the hand-off. */
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (!done) { done = true; resolve(); } };
    try { requestAnimationFrame(end); } catch (_) { end(); }
    setTimeout(end, 50);
  });
}

function defaultLayer() {
  return document.querySelector('dialog[open] [data-d-flight]') || document.querySelector('.rs-flight') || document.body;
}

function makeFlyer(src, w, h, layer) {
  const el = document.createElement('div');
  el.className = 'rs-flyer';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--w', `${w}px`);
  el.style.setProperty('--h', `${h}px`);
  el.style.setProperty('--src', `url("${String(src).replace(/"/g, '%22')}")`);
  el.innerHTML = '<img class="rs-flyer__shadow" alt=""><span class="rs-flyer__hatch"></span><img class="rs-flyer__img" alt=""><span class="rs-flyer__sheen"><i></i></span>';
  for (const img of el.querySelectorAll('img')) { img.decoding = 'sync'; img.src = src; }
  (layer || defaultLayer()).appendChild(el);
  el.rs = { anims: [], w, h, quad: null };
  return el;
}

function track(el, anims) {
  el.rs.anims = anims;
  return anims;
}

/** `remeasure()` at `at` of the path: a target that moved meanwhile bends the rest of the path onto it. */
function retarget(el, main, from, to, dur, path, remeasure, at, delay = 0) {
  if (typeof remeasure !== 'function') return 0;
  return setTimeout(() => {
    let q = null;
    try { q = remeasure(); } catch (_) { q = null; }
    if (!validQuad(q) || main.playState !== 'running' || main.playbackRate < 0 || quadGap(q, to) < 0.5) return;
    const u0 = Math.min(0.995, Math.max(0, (Number(main.currentTime) || 0) - delay) / dur);
    try {
      main.effect.setKeyframes(keyframes(from, to, el.rs.w, el.rs.h, dur, { ...path, fix: { u0, d: q.map((p, i) => [p[0] - to[i][0], p[1] - to[i][1]]) } }));
      el.rs.quad = q;
      el.rs.retargeted = quadGap(q, to);
    } catch (_) { /* no setKeyframes: lands on the first measure */ }
  }, Math.max(0, delay + dur * at));
}

/**
 * Wall quad -> exhibit slot (1.4: 900 ms, apex at 46 %: 140 px toward the camera, rotateX 14, rotateY -10; it
 * straightens to `rotate` degrees; the lift shadow fades out on landing, leaving the exhibit's own drop shadow;
 * a sheen crosses once; the hatch fades in). `remeasure()` at `remeasureAt`: a moved slot bends the rest of the path.
 * Resolves with the flyer lying exactly on the slot; the caller swaps it for the exhibit and removes it.
 */
export async function flyToSlot({ fromQuad, slotEl, crop, reduced = false, layer = null, rotate = -2, dur = 900, onStart, toQuad = null, remeasure = null, remeasureAt = 0.86 } = {}) {
  if (!slotEl || !crop || !crop.src) return null;
  const w = slotEl.offsetWidth || 1; const h = slotEl.offsetHeight || 1;
  const to = validQuad(toQuad) ? toQuad : slotQuad(slotEl, rotate);
  const el = makeFlyer(crop.src, w, h, layer);
  el.rs.quad = to;
  if (reduced || !validQuad(fromQuad) || typeof el.animate !== 'function') {
    el.style.setProperty('--m', quadToMatrix3d(w, h, to));
    el.classList.add('is-landed');
    return el;
  }
  el.rs.from = fromQuad;
  const opts = { duration: dur, easing: 'linear', fill: 'both' };
  const path = { ease: EASE_FLIGHT, z: 140, rx: 14, ry: -10, apex: 0.46 };
  const main = el.animate(keyframes(fromQuad, to, w, h, dur, path), opts);
  const anims = track(el, [
    main,
    el.querySelector('.rs-flyer__hatch').animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], opts),
    el.querySelector('.rs-flyer__shadow').animate([
      { transform: 'translate(0, 6px)', opacity: 0.34 },
      { transform: 'translate(10px, 18px)', opacity: 0.22, offset: 0.46 },
      { transform: 'translate(0, 6px)', opacity: 0 },
    ], opts),
    el.querySelector('.rs-flyer__sheen i').animate([
      { transform: 'translateX(-120%)' }, { transform: 'translateX(-120%)', offset: 0.3 }, { transform: 'translateX(120%)', offset: 0.78 }, { transform: 'translateX(120%)' },
    ], opts),
  ]);
  const timer = retarget(el, main, fromQuad, to, dur, path, remeasure, remeasureAt);
  if (typeof onStart === 'function') { try { onStart(el); } catch (_) { /* caller */ } }
  await settle(anims, dur + 400);
  clearTimeout(timer);
  el.classList.add('is-landed');
  await nextFrame();
  return el;
}

/**
 * Exhibit slot -> wall quad (close, 5.3: 640 ms cine ease, gentle counter-tilt 3 deg, the hatch fades out so the
 * number lands matching the wall). `el` may be the landed flyer; without it one is built from `fromEl` (the card).
 */
export async function flyBack({ el = null, toQuad, reduced = false, fromEl = null, rotate = -2, dur = 640, delay = 0, layer = null, fromQuad = null, shadow0 = null, remeasure = null } = {}) {
  let flyer = el;
  let from = null;
  if (fromEl) {
    const img = fromEl.querySelector('img');
    const w = fromEl.offsetWidth || 1; const h = fromEl.offsetHeight || 1;
    from = slotQuad(fromEl, rotate);
    if (!flyer && img) flyer = makeFlyer(img.currentSrc || img.src, w, h, layer);
  }
  if (!flyer) return null;
  from = validQuad(fromQuad) ? fromQuad : from || flyer.rs.quad;
  const { w, h } = flyer.rs;
  if (!validQuad(toQuad) || !validQuad(from) || reduced || typeof flyer.animate !== 'function') {
    if (validQuad(toQuad)) flyer.style.setProperty('--m', quadToMatrix3d(w, h, toQuad));
    return flyer;
  }
  flyer.classList.remove('is-landed');
  const opts = { duration: dur, delay, easing: 'linear', fill: 'both' };
  const path = { ease: EASE_CINE, z: 60, rx: -3, ry: 3, apex: 0.5 };
  const main = flyer.animate(keyframes(from, toQuad, w, h, dur, path), opts);
  const anims = track(flyer, [
    main,
    flyer.querySelector('.rs-flyer__hatch').animate([{ opacity: 1 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }], opts),
    // takes off from the exhibit with only its resting shadow (or its shadow in mid-air), the lift shadow grows in
    flyer.querySelector('.rs-flyer__shadow').animate([
      shadow0 || { transform: 'translate(0, 6px)', opacity: 0 }, { transform: 'translate(6px, 14px)', opacity: 0.24, offset: 0.5 }, { transform: 'translate(0, 4px)', opacity: 0.3 },
    ], opts),
  ]);
  flyer.rs.quad = toQuad;
  const timer = retarget(flyer, main, from, toQuad, dur, path, remeasure, 0.94, delay);
  await settle(anims, dur + delay + 400);
  clearTimeout(timer);
  await nextFrame();
  return flyer;
}

/** Esc during the flight (5.5): the flyer turns round where it is (matrix, lift shadow) and flies to `toQuad`; the
 *  path played backwards ended on the hand-off quad, which the camera dolly had moved on meanwhile. */
export function redirect(el, { toQuad, dur = 640, rotate = -2, remeasure = null } = {}) {
  if (!el || !el.rs) return Promise.resolve(el);
  const { w, h } = el.rs;
  let from = null;
  try {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    from = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => { const p = m.transformPoint(new DOMPoint(x, y)); return [p.x / p.w, p.y / p.w]; });
  } catch (_) { from = null; }
  const sh = el.querySelector('.rs-flyer__shadow');
  const cs = sh && getComputedStyle(sh);
  const shadow0 = cs ? { transform: cs.transform === 'none' ? 'translate(0, 6px)' : cs.transform, opacity: Number(cs.opacity) || 0 } : null;
  for (const a of el.rs.anims) { try { a.cancel(); } catch (_) { /* gone */ } }
  el.rs.anims = [];
  if (validQuad(from)) el.style.setProperty('--m', quadToMatrix3d(w, h, from));
  return flyBack({ el, fromQuad: from, toQuad, rotate, dur, shadow0, remeasure });
}

export default { quadToMatrix3d, flyToSlot, flyBack, redirect, slotQuad, quadVisible, validQuad };
