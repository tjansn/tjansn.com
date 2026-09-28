/**
 * wall/stage.js (WP4): camera and wall <-> screen transforms (spec 3.5).
 *   createStage(el, { size, img, data, store, reducedMotion }) -> { mode ('fit' | 'pan'), toScreen(x, y),
 *     toWall(px, py), toLocal(x, y), quadToScreen(quad), u(), view(), panTo(x, y, { animate }), ensureVisible(bibId),
 *     isVisible(bibId), dolly(bibId, { dur }), restore(), on('change', fn), wasDrag(), camera(), drift(), destroy() }
 * Screen = viewport CSS px. The wall point (cam.x, cam.y) sits at the stage centre, zoom cam.z (1 = CSS fit); all
 * wall layers share one CSS transform (--rs-cam-x/-y/-z, wall.css). Phones: horizontal drag pans with momentum,
 * vertical drags stay with the page; a tap that stops a glide only stops it (wasDrag()). view(): visible wall rect.
 * change payload { reason: layout | pan | dolly | restore | drift, input (pans): drag | glide | wheel | tween,
 * dx, dy: view shift in wall px } lets a renderer keep its lamp on the same screen spot while the visitor pans.
 */

export const W = 4789;
export const H = 3527;
export const U = W / 2000;                        // wall px per unit u

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** CSS cubic-bezier() as a function of progress (Newton steps on x). */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const e = ((ax * t + bx) * t + cx) * t - x;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(e) < 1e-5 || !d) break;
      t -= e / d;
    }
    t = clamp(t, 0, 1);
    return ((ay * t + by) * t + cy) * t;
  };
}
export const EASE = { cine: bezier(0.65, 0, 0.35, 1), out: bezier(0.2, 0.7, 0.2, 1) };   // 5.1 tokens

const GEO = new WeakMap();
/** Cached geometry of a bib: bbox [x0, y0, x1, y1] and anchor (most interior point, else centroid). */
export function geo(bib) {
  let g = GEO.get(bib);
  if (g) return g;
  const poly = bib.poly || [];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let sx = 0; let sy = 0;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    sx += x; sy += y;
  }
  const n = poly.length || 1;
  g = { box: [x0, y0, x1, y1], anchor: Array.isArray(bib.anchor) ? bib.anchor : [sx / n, sy / n] };
  GEO.set(bib, g);
  return g;
}

export function createStage(el, opts = {}) {
  const [SW, SH] = opts.size || [W, H];
  const img = opts.img || el.querySelector('.rs-wall');
  const store = opts.store || null;
  const data = opts.data || null;
  const reduced = () => Boolean(store ? store.get().reducedMotion : opts.reducedMotion);
  const bibOf = (id) => (id && data && typeof data.getBib === 'function' ? data.getBib(id) : null);

  const cam = { x: SW / 2, y: SH / 2, z: 1 };
  const drift = [0, 0];
  const fns = new Set();
  let box = { w: 1, h: 1 };
  let s = 1;                                      // CSS px per wall px at z = 1
  let mode = 'fit';
  let tween = null;
  let saved = null;                               // camera before the dolly
  let raf = 0;
  let glide = null;                               // pan momentum { v (wall px per ms), t }
  let drag = null;
  let moved = false;
  const seen = [cam.x, cam.y];                    // view centre at the last change, for the payload's dx / dy

  const k = () => s * cam.z;

  function emit(reason, input) {
    const vx = cam.x + drift[0];
    const vy = cam.y + drift[1];
    const c = { reason, input, dx: vx - seen[0], dy: vy - seen[1] };
    seen[0] = vx;
    seen[1] = vy;
    for (const fn of [...fns]) {
      try { fn(c); } catch (e) { console.warn('[radsport] stage change:', e); }
    }
  }

  function write(reason, input) {
    const kk = k();
    const st = el.style;
    st.setProperty('--rs-cam-x', `${(-(cam.x + drift[0] - SW / 2) * kk).toFixed(2)}px`);
    st.setProperty('--rs-cam-y', `${(-(cam.y + drift[1] - SH / 2) * kk).toFixed(2)}px`);
    st.setProperty('--rs-cam-z', cam.z.toFixed(4));
    st.setProperty('--rs-u', `${(kk * U).toFixed(4)}px`);
    emit(reason, input);
  }

  /** The visible part of the wall in wall px (clamped to the photo), for lamp wander and the like. */
  function view() {
    const kk = k();
    const hx = box.w / 2 / kk;
    const hy = box.h / 2 / kk;
    const cx = cam.x + drift[0];
    const cy = cam.y + drift[1];
    const x0 = clamp(cx - hx, 0, SW);
    const x1 = clamp(cx + hx, 0, SW);
    const y0 = clamp(cy - hy, 0, SH);
    const y1 = clamp(cy + hy, 0, SH);
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  function limit(c) {                             // pan mode: keep the wall across the room, up to the board's edge
    if (mode !== 'pan') return c;
    const kk = s * c.z;
    const hx = box.w / 2 / kk;
    const hy = box.h / 2 / kk;
    const e = 64 * U;                             // round 3: the 40 u frame and a strip of the café's bricks show at the ends
    c.x = SW > 2 * hx ? clamp(c.x, hx - e, SW - hx + e) : SW / 2;
    c.y = SH > 2 * hy ? clamp(c.y, hy, SH - hy) : SH / 2;
    return c;
  }

  function measure() {
    const r = el.getBoundingClientRect();
    box = { w: r.width || 1, h: r.height || 1 };
    let w = img ? parseFloat(getComputedStyle(img).width) : 0;
    if (!(w > 0)) w = Math.min(box.w, (box.h * SW) / SH);
    s = w / SW;
    const m = w > box.w + 1 ? 'pan' : 'fit';
    if (m !== mode) {
      mode = m;
      if (!saved && !tween) { cam.x = SW / 2; cam.y = SH / 2; }
    }
    el.setAttribute('data-rs-mode', mode);
    if (!saved && !tween) limit(cam);
    write('layout');
  }

  // ---------------------------------------------------------------- transforms
  function toLocal(x, y) {
    const kk = k();
    return [box.w / 2 + (x - cam.x - drift[0]) * kk, box.h / 2 + (y - cam.y - drift[1]) * kk];
  }
  function toScreen(x, y) {
    const r = el.getBoundingClientRect();
    const p = toLocal(x, y);
    return [p[0] + r.left, p[1] + r.top];
  }
  function toWall(px, py) {
    const r = el.getBoundingClientRect();
    const kk = k();
    return [(px - r.left - box.w / 2) / kk + cam.x + drift[0], (py - r.top - box.h / 2) / kk + cam.y + drift[1]];
  }

  // ---------------------------------------------------------------- camera animation
  function loop() { if (!raf) raf = requestAnimationFrame(frame); }
  function moving(on) { el.toggleAttribute('data-rs-moving', Boolean(on || tween || glide || (drag && drag.on))); }

  function finish(jump) {
    if (!tween) return;
    const tw = tween;
    tween = null;
    clearTimeout(tw.timer);
    if (jump) { Object.assign(cam, tw.to); write(tw.reason, 'tween'); }
    moving();
    tw.resolve();
  }

  function animateTo(to, dur, ease, reason) {
    finish(false);
    if (!(dur > 0) || reduced()) {
      Object.assign(cam, to);
      write(reason, 'tween');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // every awaited transition races a timeout (hidden tabs stop requestAnimationFrame)
      tween = { from: { ...cam }, to, t0: performance.now(), dur, ease, reason, resolve, timer: setTimeout(() => finish(true), dur + 400) };
      moving(true);
      loop();
    });
  }

  function frame(now) {
    raf = 0;
    let busy = false;
    if (tween) {
      const q = Math.min(1, (now - tween.t0) / tween.dur);
      if (q >= 1) finish(true);
      else {
        const e = tween.ease(q);
        const { from, to } = tween;
        cam.x = from.x + (to.x - from.x) * e;
        cam.y = from.y + (to.y - from.y) * e;
        cam.z = from.z + (to.z - from.z) * e;
        write(tween.reason, 'tween');
        busy = true;
      }
    }
    if (glide) {
      const dt = Math.min(48, now - glide.t);
      glide.t = now;
      const before = cam.x;
      cam.x += glide.v * dt;
      limit(cam);
      glide.v *= Math.exp(-dt / 325);            // friction: about 1 s to rest
      write('pan', 'glide');
      if (Math.abs(glide.v * k()) < 0.02 || cam.x === before) { glide = null; moving(); } else busy = true;
    }
    if (busy) loop();
  }

  function stopGlide() { if (glide) { glide = null; moving(); } }

  function panTo(x, y, { animate = true } = {}) {
    stopGlide();
    const to = limit({ x, y: y == null ? cam.y : y, z: cam.z });
    return animateTo(to, animate ? 420 : 0, EASE.out, 'pan');
  }

  function isVisible(bibId) {
    const bib = bibOf(bibId);
    if (!bib) return false;
    const p = toLocal(...geo(bib).anchor);
    return p[0] >= 0 && p[0] <= box.w && p[1] >= 0 && p[1] <= box.h;
  }

  function ensureVisible(bibId) {
    const bib = bibOf(bibId);
    if (!bib) return Promise.resolve(false);
    if (mode !== 'pan' || saved) return Promise.resolve(true);
    const [x0, , x1] = geo(bib).box;
    const hx = box.w / 2 / k();
    const m = hx * 0.12;
    const lo = cam.x - hx + m;
    const hi = cam.x + hx - m;
    if (x0 >= lo && x1 <= hi) return Promise.resolve(true);
    let x = geo(bib).anchor[0];
    if (x1 - x0 <= 2 * (hx - m)) x = x0 < lo ? x0 + hx - m : x1 - hx + m;
    return panTo(x, cam.y, { animate: !reduced() }).then(() => true);
  }

  function dolly(bibId, { dur = 640 } = {}) {
    const bib = bibOf(bibId);
    if (!bib || reduced()) return Promise.resolve();
    stopGlide();
    if (!saved) saved = { ...cam };
    const a = geo(bib).anchor;
    const pan = mode === 'pan' ? 0.25 : 0.4;
    const zoom = mode === 'pan' ? 1.06 : 1.12;
    const to = { x: saved.x + (a[0] - saved.x) * pan, y: saved.y + (a[1] - saved.y) * pan, z: saved.z * zoom };
    return animateTo(to, dur, EASE.cine, 'dolly');
  }

  function restore({ dur = 600 } = {}) {
    if (!saved) return Promise.resolve();
    const to = limit({ ...saved });
    saved = null;
    return animateTo(to, dur, EASE.cine, 'restore');
  }

  // ---------------------------------------------------------------- phone pan (drag + momentum, wheel)
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        drag.on = true;
        moved = true;
        finish(false);
        moving(true);
      } else if (Math.abs(dy) > 12) { end(); return; } else return;
    }
    const dt = e.timeStamp - drag.t;
    if (dt > 0) drag.v = drag.v * 0.5 + ((e.clientX - drag.lx) / dt) * 0.5;
    drag.t = e.timeStamp;
    drag.lx = e.clientX;
    cam.x = drag.cx - dx / k();
    limit(cam);
    write('pan', 'drag');
  }
  function end() {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', end);
    drag = null;
    moving();
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { on, v, t } = drag;
    end();
    if (on && !reduced() && e.timeStamp - t < 90 && Math.abs(v) > 0.08) {
      glide = { v: -v / k(), t: performance.now() };
      moving(true);
      loop();
    }
  }
  function onDown(e) {
    moved = Boolean(glide);                       // a tap that stops the momentum only stops it (native scrollers)
    stopGlide();
    if (mode !== 'pan' || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest && e.target.closest('button, input, select, textarea, .rs-label')) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, cx: cam.x, on: false, t: e.timeStamp, lx: e.clientX, v: 0 };
    addEventListener('pointermove', onMove, { passive: true });
    addEventListener('pointerup', onUp, { passive: true });
    addEventListener('pointercancel', end, { passive: true });
  }
  function onWheel(e) {
    if (mode !== 'pan' || saved || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    stopGlide();
    finish(false);
    cam.x += (e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX) / k();
    limit(cam);
    write('pan', 'wheel');
  }
  el.addEventListener('pointerdown', onDown, { passive: true });
  el.addEventListener('wheel', onWheel, { passive: false });

  // the room clips instead of scrolling (wall.css: overflow: clip); older engines: undo any focus scroll
  const room = el.closest('.rs-room');
  const unscroll = () => { if (room && (room.scrollLeft || room.scrollTop)) { room.scrollLeft = 0; room.scrollTop = 0; } };
  if (room) room.addEventListener('scroll', unscroll, { passive: true });

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
    if (img) ro.observe(img);
  } else addEventListener('resize', measure, { passive: true });

  el.setAttribute('data-rs-cam', '');
  measure();

  return {
    get mode() { return mode; },
    el,
    toScreen,
    toWall,
    toLocal,
    quadToScreen: (quad) => (quad || []).map((p) => toScreen(p[0], p[1])),
    u: () => k() * U,
    view,
    panTo,
    ensureVisible,
    isVisible,
    dolly,
    restore,
    wasDrag: () => moved,
    camera: () => ({ x: cam.x, y: cam.y, z: cam.z, s, k: k(), w: box.w, h: box.h, mode, drift: [...drift], dollied: Boolean(saved) }),
    /** Extra camera offset in wall px (GL parallax drift); the DOM tier leaves it at 0. */
    drift(dx = 0, dy = 0) { drift[0] = dx; drift[1] = dy; write('drift'); },
    measure,
    on(type, fn) {
      if (type !== 'change' || typeof fn !== 'function') return () => {};
      fns.add(fn);
      return () => fns.delete(fn);
    },
    destroy() {
      finish(false);
      stopGlide();
      end();
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); else removeEventListener('resize', measure);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('wheel', onWheel);
      if (room) room.removeEventListener('scroll', unscroll);
      for (const p of ['--rs-cam-x', '--rs-cam-y', '--rs-cam-z', '--rs-u']) el.style.removeProperty(p);
      for (const a of ['data-rs-cam', 'data-rs-mode', 'data-rs-moving']) el.removeAttribute(a);
      fns.clear();
    },
  };
}

export default { createStage, geo, bezier, EASE, W, H, U, clamp };
