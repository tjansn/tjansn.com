/**
 * wall/renderer-dom.js (WP4): DOM/CSS tier of the WallRenderer interface (spec 3.6, 1.2 to 1.4, 5); wind, tug,
 * release and breathe are no-ops (GL only, like relief and dust). Lamp: colour-dodge pool on a critically damped
 * spring (pans keep its screen spot, the wander stays on screen); framing: even-odd dim path; lift: photo copy
 * clipped to the visible polygon, growing only across free edges; pins glint, pop and return; vacated spot: wall,
 * dust rim, pin holes.
 */
import { W, H, U, clamp, geo, EASE } from './stage.js';

const NS = 'http://www.w3.org/2000/svg';
const LAMP = [1, 240 / 255, 216 / 255];            // --rs-lamp #fff0d8
const RAISE = 48 / 36;                              // open: the paper rises from 36 u to 48 u
const DROP = 12 / 36;                               // close: it drops the last 12 u and slaps
const MARGIN = 64 * U;                              // free edges may grow this far (paper and shadow)
const HOLD_MS = 1500;                               // after a click the paper waits this long for detach()
let uid = 0;

const LG = new WeakMap();
/** Lift geometry of a bib: slot box, outer (held-aware) clip, origin, lift amount. */
function liftGeo(b) {
  let g = LG.get(b);
  if (g) return g;
  const poly = b.poly;
  const n = poly.length;
  const held = new Set(b.held || []);
  let area = 0;
  for (let i = 0; i < n; i += 1) { const p = poly[i]; const q = poly[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const sg = area >= 0 ? 1 : -1;
  const lines = [];
  let per = 0; let free = 0; let hx = 0; let hy = 0; let hw = 0;
  for (let i = 0; i < n; i += 1) {
    const a = poly[i];
    const c = poly[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    const v = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
    const nn = [sg * v[1], -sg * v[0]];            // outward normal
    const d = held.has(i) ? 0 : MARGIN;
    lines.push({ p: [a[0] + nn[0] * d, a[1] + nn[1] * d], v, nn, d });
    per += len;
    if (held.has(i)) { hx += ((a[0] + c[0]) / 2) * len; hy += ((a[1] + c[1]) / 2) * len; hw += len; } else free += len;
  }
  const outer = poly.map((p, i) => {
    const A = lines[(i - 1 + n) % n];
    const B = lines[i];
    const lim = 2.5 * Math.max(A.d, B.d);
    const cr = A.v[0] * B.v[1] - A.v[1] * B.v[0];
    if (!lim) return p;
    let q;
    if (Math.abs(cr) < 0.05) { const L = A.d >= B.d ? A : B; q = [p[0] + L.nn[0] * L.d, p[1] + L.nn[1] * L.d]; } else {
      const t = ((B.p[0] - A.p[0]) * B.v[1] - (B.p[1] - A.p[1]) * B.v[0]) / cr;
      q = [A.p[0] + A.v[0] * t, A.p[1] + A.v[1] * t];
    }
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const dist = Math.hypot(dx, dy);
    return dist > lim ? [p[0] + (dx / dist) * lim, p[1] + (dy / dist) * lim] : q;
  });
  for (const pin of b.pins || []) { const w = per * 0.08; hx += pin[0] * w; hy += pin[1] * w; hw += w; }
  const an = geo(b).anchor;
  const origin = hw ? [an[0] + (hx / hw - an[0]) * 0.85, an[1] + (hy / hw - an[1]) * 0.85] : an;
  const [x0, y0, x1, y1] = geo(b).box;
  const box = [x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN];
  g = { box, bw: box[2] - box[0], bh: box[3] - box[1], outer, origin, amount: clamp(0.55 + (0.45 * free) / (per || 1), 0.55, 1) };
  LG.set(b, g);
  return g;
}

export function createRenderer(opts = {}) {
  const stageEl = opts.el;
  const stage = opts.stage;
  const img = opts.img || stageEl.querySelector('.rs-wall');
  const lampEl = opts.lamp || stageEl.querySelector('.rs-lamp');
  const liftEl = opts.lift || stageEl.querySelector('.rs-lift');
  const hitEl = opts.svg || stageEl.querySelector('.rs-hit');
  const store = opts.store || null;
  const bus = opts.bus || null;
  const list = [...(opts.bibs || [])];
  const byId = new Map(list.map((b) => [b.id, b]));
  const reduced = () => Boolean(store ? store.get().reducedMotion : opts.reducedMotion);
  const id0 = `rsdl${(uid += 1)}`;
  const offs = [];
  const nodes = [];
  const slots = new Map();
  const pinsets = new Map();
  const recesses = new Map();
  const fallbackFns = new Set();
  let hovered = null;
  let lit = [];
  let vacated = null;
  let hold = null;
  let sw = null;
  let raf = 0;
  let last = 0;
  let paused = false;
  let built = false;
  const lamp = { x: W * 0.38, y: H * 0.44, vx: 0, vy: 0, tx: W * 0.38, ty: H * 0.44, mode: 'rest', at: -1e9 };

  const photo = () => (img && (img.currentSrc || img.src)) || '';
  const now = () => performance.now();

  // ---------------------------------------------------------------- DOM
  function mk(tag, attrs, parent, svg) {
    const e = svg ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  function plane(cls, before) {
    const s = mk('svg', { class: `rs-plane ${cls}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' }, null, true);
    stageEl.insertBefore(s, before || null);
    nodes.push(s);
    return s;
  }
  const pts = (poly) => poly.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(' ');

  let tint; let under; let dimSvg; let dimPath; let litSvg; let litImg; let litClip; let liftPlane; let pinsSvg;
  function build() {
    if (built) return;
    built = true;
    tint = mk('div', { class: 'rs-dl-tint', 'aria-hidden': 'true' });
    stageEl.insertBefore(tint, lampEl);
    nodes.push(tint);
    under = plane('rs-dl-under', lampEl);
    mk('filter', { id: `${id0}-rim`, x: '-10%', y: '-10%', width: '120%', height: '120%' }, mk('defs', {}, under, true), true)
      .appendChild(mk('feGaussianBlur', { stdDeviation: String(9 * U) }, null, true));
    dimSvg = plane('rs-dl-dim', hitEl);
    const f = mk('filter', { id: `${id0}-soft`, filterUnits: 'userSpaceOnUse', x: -120, y: -120, width: W + 240, height: H + 240 }, mk('defs', {}, dimSvg, true), true);
    mk('feGaussianBlur', { stdDeviation: String(3.5 * U) }, f, true);   // soft 7 u edge
    dimPath = mk('path', { 'fill-rule': 'evenodd', filter: `url(#${id0}-soft)` }, dimSvg, true);
    litSvg = plane('rs-dl-litsvg', hitEl);
    litClip = mk('clipPath', { id: `${id0}-lit` }, mk('defs', {}, litSvg, true), true);
    litImg = mk('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', 'clip-path': `url(#${id0}-lit)` }, litSvg, true);
    liftPlane = mk('div', { class: 'rs-plane rs-dl-lift', 'aria-hidden': 'true' }, liftEl);
    nodes.push(liftPlane);
    pinsSvg = plane('rs-dl-pins', liftEl ? liftEl.nextSibling : null);
    pinsSvg.innerHTML = `<defs><linearGradient id="${id0}-st" x1="0" y1="-4" x2="0" y2="4" gradientUnits="userSpaceOnUse">`
      + '<stop offset="0" stop-color="#eef1f3"/><stop offset=".5" stop-color="#9aa2a9"/><stop offset="1" stop-color="#5d646b"/></linearGradient>'
      + `<filter id="${id0}-ps" x="-20%" y="-80%" width="140%" height="260%"><feDropShadow dx="1.2" dy="2" stdDeviation="1.4" flood-color="#000" flood-opacity=".55"/></filter>`
      + `<symbol id="${id0}-pin" viewBox="-8 -10 70 20" overflow="visible"><g filter="url(#${id0}-ps)">`
      + '<path d="M2 3.4 L48.5 1.3" stroke="#858c93" stroke-width="2.1" stroke-linecap="round" fill="none"/>'
      + `<path d="M2 -3.4 A3.4 3.4 0 1 0 2 3.4" stroke="url(#${id0}-st)" stroke-width="2.1" fill="none"/>`
      + `<path d="M2 -3.4 L50 -1.5" stroke="url(#${id0}-st)" stroke-width="2.1" stroke-linecap="round" fill="none"/>`
      + '<circle cx="-0.6" cy="0" r="1.9" fill="none" stroke="#a4abb2" stroke-width="1"/>'
      + `<path d="M45.5 -4.6 h7 a4.6 4.6 0 0 1 0 9.2 h-7 z" fill="url(#${id0}-st)" stroke="#737a81" stroke-width=".7"/></g></symbol></defs>`;
    const lampPos = firstPaintLamp();
    if (lampPos) { [lamp.x, lamp.y] = lampPos; lamp.tx = lamp.x; lamp.ty = lamp.y; }
    writeLamp();
    setDim();
  }

  /** Start where the CSS first-paint lamp is (registered --rs-lamp-x/y in % of the room). */
  function firstPaintLamp() {
    try {
      const cs = getComputedStyle(lampEl);
      const px = parseFloat(cs.getPropertyValue('--rs-lamp-x'));
      const py = parseFloat(cs.getPropertyValue('--rs-lamp-y'));
      if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
      const r = stageEl.getBoundingClientRect();
      return stage.toWall(r.left + (r.width * px) / 100, r.top + (r.height * py) / 100);
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------- frame loop (render on demand)
  function kick() {
    if (raf || paused || !built) return;
    last = now();
    raf = requestAnimationFrame(frame);
  }
  function frame(t) {
    raf = 0;
    const dt = clamp((t - last) / 1000, 0, 0.05);
    last = t;
    const a = stepLamp(dt, t);
    const b = stepSlots(dt, t);
    if ((a || b) && !paused) raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- lamp
  function writeLamp() {
    if (!stage || !lampEl) return;
    const [x, y] = stage.toLocal(lamp.x, lamp.y);
    lampEl.style.setProperty('--rs-dl-x', `${x.toFixed(1)}px`);
    lampEl.style.setProperty('--rs-dl-y', `${y.toFixed(1)}px`);
  }
  function endSweep() {
    if (!sw) return;
    const s = sw;
    sw = null;
    clearTimeout(s.timer);
    if (lamp.mode === 'sweep') { lamp.mode = 'rest'; [lamp.tx, lamp.ty] = s.to; }
    s.resolve();
  }
  function lampTarget(t) {
    if (sw) {
      const q = (t - sw.t0) / sw.dur;
      if (q >= 1) endSweep();
      else {
        const e = EASE.cine(q);
        const { from, to, start } = sw;
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const arc = 0.07 * Math.sin(Math.PI * q);                   // a torch never walks a ruler line
        const px = from[0] + dx * e + dy * arc;
        const py = from[1] + dy * e - dx * arc;
        const k = Math.min(1, q / 0.22);
        const kk = k * k * (3 - 2 * k);                            // ease in from wherever the lamp was
        return [start[0] + (px - start[0]) * kk, start[1] + (py - start[1]) * kk];
      }
    }
    if (lamp.mode === 'wander') {                                   // Lissajous over 40 % of the view
      const s = t / 1000;
      const v = stage && typeof stage.view === 'function' ? stage.view() : { x0: 0, y0: 0, w: W, h: H };
      return [v.x0 + v.w * (0.5 + 0.2 * Math.sin((2 * Math.PI * s) / 23)), v.y0 + v.h * (0.47 + 0.2 * Math.sin((2 * Math.PI * s) / 17.7 + 1.1))];
    }
    return [lamp.tx, lamp.ty];
  }
  function stepLamp(dt, t) {
    const [tx, ty] = lampTarget(t);
    if (reduced()) {
      lamp.x = tx; lamp.y = ty; lamp.vx = 0; lamp.vy = 0;
      writeLamp();
      return false;
    }
    const w = lamp.mode === 'wander' ? 2.4 : 7.5;                  // critically damped
    lamp.vx += (w * w * (tx - lamp.x) - 2 * w * lamp.vx) * dt;
    lamp.vy += (w * w * (ty - lamp.y) - 2 * w * lamp.vy) * dt;
    lamp.x += lamp.vx * dt;
    lamp.y += lamp.vy * dt;
    writeLamp();
    return Boolean(sw) || lamp.mode === 'wander' || Math.abs(tx - lamp.x) > 0.5 || Math.abs(ty - lamp.y) > 0.5 || Math.hypot(lamp.vx, lamp.vy) > 2;
  }

  // ---------------------------------------------------------------- lift slots
  function slotFor(b, create) {
    let sl = slots.get(b.id);
    if (sl || !create) return sl || null;
    const g = liftGeo(b);
    const { box, bw, bh } = g;
    const pc = (p) => `${(((p[0] - box[0]) / bw) * 100).toFixed(2)}% ${(((p[1] - box[1]) / bh) * 100).toFixed(2)}%`;
    const el = mk('div', { class: 'rs-dl-slot', 'data-bib': b.id });
    const st = el.style;
    st.setProperty('--x', `${((box[0] / W) * 100).toFixed(3)}%`);
    st.setProperty('--y', `${((box[1] / H) * 100).toFixed(3)}%`);
    st.setProperty('--w', `${((bw / W) * 100).toFixed(3)}%`);
    st.setProperty('--h', `${((bh / H) * 100).toFixed(3)}%`);
    st.setProperty('--co', `polygon(${g.outer.map(pc).join(',')})`);
    st.setProperty('--cp', `polygon(${b.poly.map(pc).join(',')})`);
    st.setProperty('--ox', `${(((g.origin[0] - box[0]) / bw) * 100).toFixed(2)}%`);
    st.setProperty('--oy', `${(((g.origin[1] - box[1]) / bh) * 100).toFixed(2)}%`);
    st.setProperty('--bs', `${((W / bw) * 100).toFixed(3)}% ${((H / bh) * 100).toFixed(3)}%`);
    st.setProperty('--bp', `${((box[0] / (W - bw)) * 100).toFixed(3)}% ${((box[1] / (H - bh)) * 100).toFixed(3)}%`);
    const clip = mk('div', { class: 'rs-dl-clip' }, el);             // held edges stay put
    mk('i', {}, mk('div', { class: 'rs-dl-shadow' }, clip));
    const face = mk('i', { class: 'rs-dl-face' }, mk('div', { class: 'rs-dl-paper' }, clip));
    setFace(face);
    const ring = mk('svg', { class: 'rs-dl-ring', viewBox: `${box[0]} ${box[1]} ${bw} ${bh}`, preserveAspectRatio: 'none' }, el, true);
    mk('polygon', { class: 'rs-dl-ring__under', points: pts(b.poly) }, ring, true);   // focus ring: outside the clip, same
    mk('polygon', { points: pts(b.poly) }, ring, true);                // transform; a dark band under light dashes
    sl = { b, g, el, face, h: 0, hv: 0, ht: 0, rx: 0, ry: 0, rvx: 0, rvy: 0, a: 0, at: 0, fr: 0, fast: false, away: false, drop: 0, hideT: 0 };
    const after = [...slots.values()].find((o) => (o.b.z ?? 0) > (b.z ?? 0));
    liftPlane.insertBefore(el, after ? after.el : null);             // paint in stacking order
    slots.set(b.id, sl);
    return sl;
  }
  function setFace(face) {
    const src = photo();
    if (src) face.style.setProperty('--bg', `url("${src.replace(/"/g, '%22')}")`);
  }
  function dropSlot(sl) {
    clearTimeout(sl.hideT);
    sl.el.remove();
    slots.delete(sl.b.id);
  }

  function spring(x, v, target, w, z, dt) {
    const acc = w * w * (target - x) - 2 * z * w * v;
    const nv = v + acc * dt;
    return [x + nv * dt, nv];
  }

  function stepSlots(dt, t) {
    let busy = false;
    const uL = stage.camera().s * U;                              // layout px per u inside the wall plane
    const rm = reduced();
    for (const sl of [...slots.values()]) {
      if (sl.drop) {                                             // attach: fall the last 12 u, slap, bounce 0.25
        const q = t - sl.drop;
        if (q < 130) sl.h = DROP * (1 - (q / 130) ** 2);                          // 5.3: 220 ms in all
        else if (q < 220) sl.h = DROP * 0.25 * Math.sin((Math.PI * (q - 130)) / 90);
        else { sl.drop = 0; sl.h = 0; sl.hv = 0; settleAfterDrop(sl); }
      } else if (rm) { sl.h = sl.ht; sl.hv = 0; } else [sl.h, sl.hv] = spring(sl.h, sl.hv, sl.ht, 11, 0.72, dt);
      let tx = 0;
      let ty = 0;
      if (!rm && sl.b.id === hovered && !sl.away && lamp.mode === 'pointer') {
        const [x0, y0, x1, y1] = geo(sl.b).box;
        const c = geo(sl.b).anchor;
        tx = clamp((lamp.ty - c[1]) / Math.max(1, (y1 - y0) / 2), -1, 1) * 4 * sl.g.amount;
        ty = -clamp((lamp.tx - c[0]) / Math.max(1, (x1 - x0) / 2), -1, 1) * 4 * sl.g.amount;
      }
      if (rm) { sl.rx = 0; sl.ry = 0; } else {
        [sl.rx, sl.rvx] = spring(sl.rx, sl.rvx, tx, 11, 0.72, dt);
        [sl.ry, sl.rvy] = spring(sl.ry, sl.rvy, ty, 11, 0.72, dt);
      }
      const rate = sl.at > sl.a ? 14 : sl.fast ? 40 : 9;
      sl.a = rm ? sl.at : sl.a + (sl.at - sl.a) * (1 - Math.exp(-rate * dt));
      if (Math.abs(sl.at - sl.a) < 0.004) sl.a = sl.at;
      const ft = +sl.away;                                       // feather relaxed off the wall (GL u_relax)
      sl.fr = rm ? ft : clamp(sl.fr + (ft ? dt / 0.25 : -dt / 0.45), 0, 1);
      draw(sl, uL);
      const still = !sl.drop && Math.abs(sl.ht - sl.h) < 0.002 && Math.abs(sl.hv) < 0.004 && sl.a === sl.at && sl.fr === ft
        && Math.abs(sl.rx - tx) < 0.02 && Math.abs(sl.ry - ty) < 0.02 && Math.abs(sl.rvx) + Math.abs(sl.rvy) < 0.05;
      if (!still) busy = true;
      else if (sl.at === 0 && sl.ht === 0 && !sl.away) dropSlot(sl);
    }
    return busy;
  }

  function draw(sl, uL) {
    const h = sl.h;
    const hp = Math.max(0, h);
    const sc = 1 + 0.03 * h * sl.g.amount;
    const st = sl.el.style;
    st.setProperty('--a', sl.a.toFixed(3));
    st.setProperty('--rs-fr', sl.fr.toFixed(3));
    st.setProperty('--pt', `translate3d(0,${(-4 * uL * hp).toFixed(2)}px,0) rotateX(${sl.rx.toFixed(2)}deg) rotateY(${sl.ry.toFixed(2)}deg) scale(${sc.toFixed(4)})`);
    const c = geo(sl.b).anchor;
    let dx = c[0] - lamp.x;
    let dy = c[1] - lamp.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 0.3; dy = 0.95; } else { dx /= len; dy /= len; }
    const off = (5 + 14 * hp) * uL;
    st.setProperty('--st', `translate3d(${(dx * off).toFixed(2)}px,${(dy * off + 5 * hp * uL).toFixed(2)}px,0) scale(${sc.toFixed(4)})`);
    st.setProperty('--so', clamp(0.18 + 0.5 * hp, 0, 0.72).toFixed(3));
  }

  function settleAfterDrop(sl) {
    const on = sl.b.id === hovered;
    sl.ht = on ? 1 : 0;
    sl.at = on ? 1 : 0;
    sl.fast = false;
    if (on) sl.el.classList.add('is-current');
  }

  // ---------------------------------------------------------------- pins
  function pinset(b, create) {
    let g = pinsets.get(b.id);
    if (g || !create || !(b.pins && b.pins.length)) return g || null;
    g = mk('g', { class: 'rs-dl-pinset', 'data-bib': b.id }, pinsSvg, true);
    const ang = (b.obb && b.obb.angle) || 0;
    const cx = geo(b).anchor[0];
    b.pins.forEach((p, i) => {
      const outer = mk('g', { class: 'rs-dl-pin' }, g, true);
      outer.style.setProperty('--d', `${i * 62}ms`);
      outer.style.setProperty('--d2', `${60 + i * 75}ms`);
      outer.style.setProperty('--dx', `${(p[0] >= cx ? 1 : -1) * (50 + i * 22)}px`);
      const place = mk('g', { transform: `translate(${p[0]} ${p[1]}) rotate(${(ang + (i % 2 ? 38 : -34) + ((i * 17) % 11)).toFixed(1)}) scale(2.2)` }, outer, true);
      const inner = mk('g', { class: 'rs-dl-pin__i' }, place, true);
      mk('use', { href: `#${id0}-pin`, x: -8, y: -10, width: 70, height: 20 }, inner, true);
      mk('circle', { class: 'rs-dl-glint', cx: 0, cy: 0, r: 4.5 }, inner, true);
    });
    pinsets.set(b.id, g);
    return g;
  }
  function pinsState(b, cls) {
    const g = pinset(b, cls !== 'off');
    if (!g) return;
    clearTimeout(g.rsT);
    g.classList.remove('is-pop', 'is-back');
    if (cls === 'off') {
      g.classList.remove('is-on');
      g.rsT = setTimeout(() => { g.remove(); pinsets.delete(b.id); }, 420);
      return;
    }
    void g.getBoundingClientRect();
    if (cls === 'on') g.classList.add('is-on');
    else if (cls === 'pop') {
      g.classList.add('is-on', 'is-pop');
      g.rsT = setTimeout(() => { g.remove(); pinsets.delete(b.id); }, reduced() ? 0 : 520 + b.pins.length * 62);
    } else if (cls === 'back') {
      g.classList.add('is-on', 'is-back');
      g.rsT = setTimeout(() => { g.classList.remove('is-back'); if (b.id !== hovered) pinsState(b, 'off'); }, 520 + b.pins.length * 75);
    }
  }

  // ---------------------------------------------------------------- recess (vacated spot)
  function setVacated(id, delay) {
    if (id === vacated) return;
    const prev = vacated;
    vacated = id && byId.has(id) ? id : null;
    if (prev && recesses.has(prev)) {
      const r = recesses.get(prev);
      recesses.delete(prev);
      r.classList.remove('is-on');
      setTimeout(() => r.remove(), reduced() ? 0 : 360);
    }
    if (!vacated) return;
    const b = byId.get(vacated);
    const g = mk('g', { class: 'rs-dl-recess' }, under, true);
    g.style.setProperty('--rs-rd', `${delay || 0}ms`);
    const cid = `${id0}-rc-${b.id}`;
    mk('polygon', { points: pts(b.poly) }, mk('clipPath', { id: cid }, g, true), true);
    mk('polygon', { class: 'rs-dl-recess__fill', points: pts(b.poly) }, g, true);
    mk('polygon', { class: 'rs-dl-recess__rim', points: pts(b.poly), 'clip-path': `url(#${cid})`, filter: `url(#${id0}-rim)` }, g, true);
    for (const p of b.pins || []) mk('circle', { class: 'rs-dl-hole', cx: Math.round(p[0]), cy: Math.round(p[1]), r: 5.5 }, g, true);
    recesses.set(b.id, g);
    void g.getBoundingClientRect();
    g.classList.add('is-on');
  }

  // ---------------------------------------------------------------- framing projector
  function setAway(on) {                                     // a number is off the wall: house light to 30 %
    stageEl.toggleAttribute('data-rs-dl-away', Boolean(on));
    setDim();
  }
  function setDim() {
    if (!built) return;
    const away = stageEl.hasAttribute('data-rs-dl-away');
    const holes = away ? [] : [...new Set([hovered, ...lit].filter(Boolean))];
    let d = `M-96 -96H${W + 96}V${H + 96}H-96Z`;                 // the photo and its 40 u board frame (room.css dims the room)
    for (const id of holes) { const p = byId.get(id).poly; d += `M${p.map((q) => `${Math.round(q[0])} ${Math.round(q[1])}`).join('L')}Z`; }
    dimPath.setAttribute('d', d);
    stageEl.toggleAttribute('data-rs-dl-hover', Boolean(hovered && !away));
  }

  function setLit(ids) {
    const next = (Array.isArray(ids) ? ids : []).filter((id) => byId.has(id));
    lit = next;
    if (!built) return;
    clearTimeout(litClip.rsT);
    if (next.length) {
      litClip.innerHTML = next.map((id) => `<polygon points="${pts(byId.get(id).poly)}"/>`).join('');
      litImg.setAttribute('href', photo());
    } else litClip.rsT = setTimeout(() => { if (!lit.length) litClip.innerHTML = ''; }, 420);
    stageEl.toggleAttribute('data-rs-dl-lit', next.length > 0);
    setDim();
  }

  // ---------------------------------------------------------------- hover
  function lower(id) {
    const sl = slots.get(id);
    if (sl && !sl.away && !sl.drop) { sl.ht = 0; sl.at = 0; sl.el.classList.remove('is-current'); }
    const b = byId.get(id);
    if (b) pinsState(b, 'off');
  }
  function setHover(id) {
    const next = id && byId.has(id) ? id : null;
    if (next === hovered) return;
    const prev = hovered;
    hovered = next;
    if (prev && !(hold && hold.id === prev && now() - hold.t < HOLD_MS)) lower(prev);
    if (next) {
      const b = byId.get(next);
      const sl = slotFor(b, true);
      for (const o of slots.values()) o.el.classList.toggle('is-current', o === sl);
      if (!sl.away && !sl.drop) {
        sl.ht = 1; sl.at = 1; sl.fast = false;
        if (reduced()) { sl.h = 1; sl.hv = 0; sl.a = 1; }
        pinsState(b, 'on');
      }
      if (now() - lamp.at > 350 && !sw) { lamp.mode = 'focus'; [lamp.tx, lamp.ty] = geo(b).anchor; }   // keyboard: the lamp comes along
    }
    setDim();
    kick();
  }

  // ---------------------------------------------------------------- open / close / switch
  function detach(id) {
    const b = byId.get(id);
    if (!b || !built) return null;
    hold = null;
    const sl = slotFor(b, true);
    const rm = reduced();
    sl.away = true; sl.drop = 0; sl.ht = RAISE; sl.at = 1; sl.fast = false;
    if (rm) { sl.h = RAISE; sl.hv = 0; sl.a = 1; } else if (sl.h < 0.2) sl.hv += 4;
    sl.el.classList.remove('is-current');
    const g = liftGeo(b);
    const sc = 1 + 0.03 * RAISE * g.amount;
    const rise = -4 * U * RAISE;
    const o = g.origin;
    const q = Array.isArray(b.quad) && b.quad.length === 4 ? b.quad : [[g.box[0], g.box[1]], [g.box[2], g.box[1]], [g.box[2], g.box[3]], [g.box[0], g.box[3]]];
    const quad = q.map(([x, y]) => stage.toScreen(o[0] + (x - o[0]) * sc, o[1] + (y - o[1]) * sc + rise));
    const k = stage.camera().k;
    const off = (5 + 14 * RAISE) * U * k;
    const c = geo(b).anchor;
    const len = Math.hypot(c[0] - lamp.x, c[1] - lamp.y) || 1;
    const shadow = { x: ((c[0] - lamp.x) / len) * off, y: ((c[1] - lamp.y) / len) * off + 5 * RAISE * U * k, blur: 9 * U * k, alpha: 0.6 };
    pinsState(b, 'pop');
    setAway(true);
    clearTimeout(sl.hideT);
    sl.hideT = setTimeout(() => { if (sl.away) { sl.at = 0; sl.fast = true; kick(); } }, rm ? 0 : 300);   // hand-off to the flyer
    setVacated(id, rm ? 0 : 80);
    kick();
    return { quad, shadow };
  }

  function attach(id, { slap = true } = {}) {
    const b = byId.get(id);
    if (!b || !built) return Promise.resolve();
    setAway(false);
    const sl = slotFor(b, true);
    clearTimeout(sl.hideT);
    sl.away = false; sl.fast = false; sl.a = 1; sl.at = 1; sl.hv = 0;
    const rm = reduced() || !slap;
    sl.fr = +!rm;                                                // hand-back: the flyer's unfeathered look
    if (rm) { sl.h = 0; sl.drop = 0; settleAfterDrop(sl); if (rm && sl.ht === 0) { sl.a = 0; sl.at = 0; } } else { sl.h = DROP; sl.drop = now(); }
    draw(sl, stage.camera().s * U);
    if (b.pins && b.pins.length) pinsState(b, rm ? (b.id === hovered ? 'on' : 'off') : 'back');
    setTimeout(() => { if (vacated === id) setVacated(null); }, rm ? 0 : 90);
    kick();
    return new Promise((resolve) => setTimeout(resolve, rm ? 0 : 320));
  }

  // ---------------------------------------------------------------- the interface
  const api = {
    tier: 'dom',
    init() { build(); kick(); return Promise.resolve(); },
    setLamp(x, y, { instant = false } = {}) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      lamp.at = now();
      if (sw) {                                                  // the pointer takes over as soon as it really moves
        if (!sw.ref) { sw.ref = [x, y]; return; }
        if (Math.hypot(x - sw.ref[0], y - sw.ref[1]) < 3 * U) return;
        endSweep();
      }
      lamp.mode = 'pointer';
      lamp.tx = x;
      lamp.ty = y;
      if (instant || reduced()) { lamp.x = x; lamp.y = y; lamp.vx = 0; lamp.vy = 0; writeLamp(); }
      kick();
    },
    setWander(on) {
      if (on && !reduced()) { if (lamp.mode !== 'wander' && !sw) { lamp.mode = 'wander'; kick(); } } else if (!on && lamp.mode === 'wander') { lamp.mode = 'rest'; lamp.tx = lamp.x; lamp.ty = lamp.y; }
    },
    sweep({ from, to, dur = 2400 } = {}) {
      endSweep();
      if (reduced() || !Array.isArray(from) || !Array.isArray(to)) return Promise.resolve();
      return new Promise((resolve) => {
        sw = { from, to, dur, t0: now(), start: [lamp.x, lamp.y], resolve, ref: null };
        sw.timer = setTimeout(endSweep, dur + 400);
        lamp.mode = 'sweep';
        kick();
      });
    },
    setHouse(level, tint) {
      // r3 fix: a darker room (0.24 light, 0.22 dark) and a hot lamp core that restores the paper to about 1.8 times
      // its colour (the WebGL lamp's pool), easing to 1 as Saallicht lights the room, so the pool reads as a lamp in a
      // café at night; "more contrast" keeps the brighter room it had
      let hc = false;
      try { hc = matchMedia('(prefers-contrast: more)').matches; } catch (_) { /* */ }
      const lv = Number.isFinite(+level) ? +level : 0.14;
      const dim = hc ? clamp(0.2 + lv, 0.22, 0.9) : clamp(0.14 + lv, 0.2, 0.9);
      const hot = hc ? 1 : 1 + 0.8 * clamp((0.6 - dim) / 0.36, 0, 1);
      stageEl.style.setProperty('--rs-wall-dim', dim.toFixed(3));
      stageEl.style.setProperty('--rs-dl-c0', `rgb(${LAMP.map((l) => Math.round(clamp(1 - dim / (l * hot), 0, 1) * 255)).join(' ')})`);
      stageEl.setAttribute('data-rs-dl-tint', tint === 'cool' ? 'cool' : 'warm');
    },
    setHover,
    setLit,
    wind() {},
    tug() {},
    release() {},
    breathe() {},
    detach,
    attach,
    vacate(id) {
      const next = id && byId.has(id) ? id : null;
      if (next === vacated) return;
      if (vacated) { const sl = slots.get(vacated); if (sl && sl.away) dropSlot(sl); }
      const sl = next && slots.get(next);
      if (sl && !sl.away) {                                     // the number is off the wall: no paper over the recess
        hold = null;
        sl.away = true; sl.at = 0; sl.fast = true; sl.drop = 0;
        sl.el.classList.remove('is-current');
        pinsState(sl.b, 'off');
        kick();
      }
      setVacated(next, 0);
      setAway(Boolean(next));
    },
    pause() { paused = true; cancelAnimationFrame(raf); raf = 0; },
    resume() { paused = false; kick(); },
    dispose() {
      api.pause();
      endSweep();
      for (const off of offs.splice(0)) { try { off(); } catch (_) { /* */ } }
      for (const sl of [...slots.values()]) dropSlot(sl);
      for (const n of nodes.splice(0)) n.remove();
      for (const a of ['data-rs-dl-hover', 'data-rs-dl-lit', 'data-rs-dl-away', 'data-rs-dl-tint']) stageEl.removeAttribute(a);
      for (const p of ['--rs-wall-dim', '--rs-dl-c0']) stageEl.style.removeProperty(p);
      if (lampEl) { lampEl.style.removeProperty('--rs-dl-x'); lampEl.style.removeProperty('--rs-dl-y'); }
      built = false;
      fallbackFns.clear();
    },
    on(type, fn) {
      if (type !== 'fallback' || typeof fn !== 'function') return () => {};
      fallbackFns.add(fn);                                        // the DOM tier never falls back
      return () => fallbackFns.delete(fn);
    },
    /** QA: state of the lamp and the lifted numbers. */
    debug: () => ({ lamp: { ...lamp }, hovered, lit: [...lit], vacated, sweep: Boolean(sw), running: Boolean(raf), slots: [...slots.values()].map((s) => ({ id: s.b.id, h: +s.h.toFixed(3), a: +s.a.toFixed(3), away: s.away })) }),
  };

  if (stage && typeof stage.on === 'function') {
    offs.push(stage.on('change', (c) => {
      // pans (drag, fling, wheel) keep the lamp's screen spot; aimed (keyboard) or wandering, it stays with the wall
      if (c && c.reason === 'pan' && (c.input === 'drag' || c.input === 'glide' || c.input === 'wheel') && !sw
        && (lamp.mode === 'pointer' || lamp.mode === 'rest')) {
        const dx = +c.dx || 0;
        const dy = +c.dy || 0;
        lamp.x += dx; lamp.tx += dx; lamp.y += dy; lamp.ty += dy;
      }
      writeLamp();
    }));
  }
  if (img) {
    const onload = () => { for (const sl of slots.values()) setFace(sl.face); if (lit.length && litImg) litImg.setAttribute('href', photo()); };
    img.addEventListener('load', onload);
    offs.push(() => img.removeEventListener('load', onload));
  }
  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('wall:activate', ({ bibId } = {}) => {        // keep the paper up until the dossier detaches it
      hold = bibId ? { id: bibId, t: now() } : null;
      setTimeout(() => {
        if (!hold || hold.id !== bibId) return;
        hold = null;
        const sl = slots.get(bibId);
        if (sl && !sl.away && bibId !== hovered) { lower(bibId); kick(); }
      }, HOLD_MS);
    }));
  }
  return api;
}

export { createRenderer as createDomRenderer };
export default { createRenderer };
