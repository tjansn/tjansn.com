/**
 * wall/room.js (round 3, D29): the old Belgian café around the collage. main.js imports it after the wall photo has
 * loaded (the photo stays the LCP), never at boot.
 *   createRoom({ el, stage, data, i18n, bus, store, router, v, lamp, away, saveData }) -> { ready, info(), on('change', fn),
 *     relabel(), dispose() }
 * Layers (all move with the camera like the photo; room.json has every size, place and light, in u):
 *   .rs-room-back (z -1, static markup): the brick wall (LQIP at first paint, then the full file), the board's contact
 *     shadow, the framed pictures with their shadows and a static glass sheen, the brass picture lamps and their light
 *     (colour-dodge pools); house light, framing and the away state dim it (room.css)
 *   .rs-room-glow (z -1): the lamps' bulbs          .rs-board (z 0, over the photo's edges): the black board frame
 *   .rs-room-hits (z 4, over the WebGL canvas): one hit area per shown picture: a link to the race for Tom's own photos
 *     (the dossier as an index card), aria-hidden for the others; the caption shows on hover and focus
 * The big textures are border-images: the browser never counts them as the largest contentful paint. A picture shows
 * only while the fitted room shows it whole with its lamp (desktop); phones pan and show none. The WebGL tier draws the
 * same room itself (renderer-gl.js reads info() and the 'change' event) and hides these layers under its canvas.
 */
import { U } from './stage.js';

const CW = 2000;                        // the collage in u
const CH = 1473;
const STRINGS = {
  de: { 'room.link': 'Foto im Rahmen: {c}. Rennen öffnen.', 'room.open': 'Rennen öffnen' },
  en: { 'room.link': 'Framed photo: {c}. Open the race.', 'room.open': 'Open the race' },
};
const pc = (v, of) => `${((v / of) * 100).toFixed(4)}%`;
/** The page's phone layouts (radsport.css): the pictures stay out, the HUD needs the margins there. */
const phone = () => { try { return matchMedia('(max-width: 759px), (orientation: landscape) and (max-height: 520px) and (max-width: 1023px)').matches; } catch (_) { return false; } };
const warn = (w, e) => { try { console.warn(`[radsport] room ${w}:`, e); } catch (_) { /* */ } };

function mk(tag, cls, parent, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
/** Place a box given in u (collage top-left = 0, 0) inside a layer that has the collage's size. */
function place(n, x, y, w, h) {
  const s = n.style;
  s.left = pc(x, CW); s.top = pc(y, CH); s.width = pc(w, CW); s.height = pc(h, CH);
}
/** Axis-aligned bounds of a box rotated about its centre (deg clockwise). */
function bounds(x, y, w, h, deg) {
  const a = ((deg || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)); const s = Math.abs(Math.sin(a));
  const bw = w * c + h * s; const bh = w * s + h * c;
  const cx = x + w / 2; const cy = y + h / 2;
  return [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
}
const decoded = (src) => new Promise((resolve) => {
  const im = new Image();
  im.decoding = 'async';
  im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(im));
  im.onerror = () => resolve(null);
  im.src = src;
});

export function createRoom(o = {}) {
  const { el: stageEl, stage, data, i18n, bus, store, router } = o;
  const room = stageEl.closest('.rs-room') || stageEl.parentElement;
  const q = new URLSearchParams(location.search);
  const saveData = Boolean(o.saveData);
  const url = (f) => { const u = data.assetURL(f); return o.v ? `${u}?v=${o.v}` : u; };
  const fns = new Set();
  const offs = [];
  const pics = new Map();              // id -> { p, el, hit, fix, pool, glow, lit }
  let json = null;
  let shown = [];
  let rev = 0;
  let back = stageEl.querySelector('.rs-room-back');
  let bricks = back ? back.querySelector('.rs-bricks') : null;
  let glow = null; let board = null; let hits = null; let shade = null;
  let opened = null;                   // the picture link that opened the dossier, and the scroll position then
  let disposed = false;

  if (i18n && typeof i18n.extend === 'function') i18n.extend(STRINGS);
  const T = (k, vars) => (i18n && typeof i18n.t === 'function' ? i18n.t(k, vars) : STRINGS.de[k]);
  const L = (obj) => (i18n && typeof i18n.L === 'function' ? i18n.L(obj) : (obj && obj.de) || '');

  function emit() { rev += 1; for (const fn of [...fns]) { try { fn(api.info()); } catch (e) { warn('change', e); } } }

  // ---------------------------------------------------------------- layers
  function layers() {
    if (!back) {                                    // the static markup is missing (older page): build it
      back = mk('div', 'rs-room-back', null, { 'aria-hidden': 'true' });
      stageEl.insertBefore(back, stageEl.firstChild);
    }
    if (!bricks) { bricks = mk('div', 'rs-bricks', back); for (let i = 0; i < 3; i += 1) mk('i', '', bricks); }
    glow = mk('div', 'rs-room-glow', null, { 'aria-hidden': 'true' });
    back.after(glow);
    board = mk('div', 'rs-board', null, { 'aria-hidden': 'true' });
    const img = stageEl.querySelector('.rs-wall');
    if (img) img.after(board); else stageEl.appendChild(board);
    hits = mk('div', 'rs-room-hits');
    const svg = stageEl.querySelector('.rs-hit');
    if (svg) svg.after(hits); else stageEl.appendChild(hits);
  }

  /** Brick file: 1600 (0.5 px per u) on phones, with Save-Data and wherever it is sharp enough (up to 0.56 device px
   *  per u, e.g. 1440 x 900 at DPR 1), else 3200 (1 px per u); r3 fix: WebGL at its canvas DPR (renderer-gl resize()) */
  function brickFile() {
    const alb = (json.bricks && json.bricks.albedo) || [];
    const tier = store && typeof store.get === 'function' ? store.get().tier : 'dom';
    let k = window.devicePixelRatio || 1;
    if (tier === 'high' || tier === 'medium') {
      const r = stageEl.getBoundingClientRect(); const a = Math.max(1, r.width * r.height);
      k = Math.min(k, tier === 'high' ? 1.75 : a < 520000 ? 2 : 1.5, Math.sqrt(3.6e6 / a));
    }
    const dpu = stage.camera().s * U * k;
    const small = saveData || stage.mode === 'pan' || phone() || !(dpu > 0.56);
    const pick = alb.find((a) => (small ? a.pxPerU < 1 : a.pxPerU >= 1)) || alb[0];
    return pick ? pick.file : null;
  }

  const settled = () => room.hasAttribute('data-rs-gl-settled');
  async function loadBricks() {
    const f = brickFile();
    if (!f || !bricks || settled()) return;
    const im = await decoded(url(f));
    if (!im || disposed || settled()) return;
    bricks.style.setProperty('--rs-bricks-full', `url("${im.src}")`);
    requestAnimationFrame(() => bricks.classList.add('is-in'));
  }

  function loadBoard() {
    const b = json.board || {};
    if (b.shadow && b.shadow.file) {
      const [x, y, w, h] = b.shadow.rect;
      const [dx, dy] = b.shadow.offsetU || [0, 0];
      if (!shade) shade = mk('i', 'rs-board-shadow', null);
      back.insertBefore(shade, bricks ? bricks.nextSibling : back.firstChild);
      place(shade, x + dx, y + dy, w, h);
      shade.style.opacity = String(b.shadow.opacity ?? 0.9);
      shade.style.setProperty('--src', `url("${url(b.shadow.file)}")`);
    }
    if (b.frame && b.frame.file) {                  // [-40, -40, 2080, 1553]: room.css centres it on the collage
      board.style.setProperty('--src', `url("${url(b.frame.file)}")`);
      board.style.setProperty('--slice', String(b.frame.slicePx || 40));
    }
  }

  /** r3 fix: under the settled WebGL canvas the layers leave the render tree and drop their images; DOM brings them back */
  let settleT = 0;
  function settle(on) {
    clearTimeout(settleT);
    if (on) {
      settleT = setTimeout(() => {
        if (disposed) return;
        room.setAttribute('data-rs-gl-settled', '');
        for (const n of [board, shade]) if (n) n.style.removeProperty('--src');
        if (bricks) { bricks.style.removeProperty('--rs-bricks-full'); bricks.classList.remove('is-in'); }
      }, 1300);
    } else if (settled()) {
      room.removeAttribute('data-rs-gl-settled');
      loadBoard();
      loadBricks();
    }
  }

  // ---------------------------------------------------------------- pictures
  const raceOf = (p) => { const r = p.link && data.getRace ? data.getRace(p.link) : null; return r && r.status === 'raced' ? r : null; };

  function build(p) {
    const e = { p, lit: null };
    const box = mk('div', 'rs-pic', null, { 'data-pic': p.id, 'data-kind': p.kind || '' });
    place(box, p.x, p.y, p.w, p.h);
    if (p.rotation) box.style.transform = `rotate(${p.rotation}deg)`;
    const s = p.shadow || {};
    for (const [k, v] of [['--dx', s.dx ?? 3], ['--dy', s.dy ?? 14], ['--bl', s.blur ?? 16], ['--op', s.opacity ?? 0.6]]) box.style.setProperty(k, String(v));
    const im = mk('img', '', box, { alt: '', decoding: 'async', draggable: 'false' });
    im.src = url(p.file);
    if (Array.isArray(p.glass)) {
      const [gx, gy, gw, gh] = p.glass;
      const g = mk('i', 'rs-pic__glass', box);
      g.style.left = pc(gx, p.w); g.style.top = pc(gy, p.h); g.style.width = pc(gw, p.w); g.style.height = pc(gh, p.h);
    }
    e.el = box;
    const fx = (json.fixtures || []).find((f) => f.for === p.id);
    if (fx) {
      const f = mk('div', 'rs-fix', null);
      place(f, fx.x, fx.y, fx.w, fx.h);
      mk('img', '', f, { alt: '', decoding: 'async', draggable: 'false' }).src = url(fx.file);
      e.fix = f;
      if (fx.bulb) {
        const r = (fx.glow && fx.glow.r) || 14;
        const gl = mk('i', 'rs-bulb', glow);
        place(gl, fx.bulb[0] - r * 6, fx.bulb[1] - r * 6, r * 12, r * 12);
        e.glow = gl;
      }
    }
    const lt = (json.lights || []).find((l) => l.for === p.id);
    if (lt) {
      // where the light's axis meets the wall, and the pool its cone throws there (an ellipse, longer downwards)
      const [x, y, z] = lt.pos; const [, dy, dz] = lt.dir;
      const t = dz < -0.05 ? z / -dz : z;
      const hx = x; const hy = y + dy * t;
      const rx = Math.max(p.w * 0.84, z * Math.tan(((lt.out || 40) * Math.PI) / 180) * 1.5);
      const ry = Math.max(p.h * 0.7, rx * 1.15);
      const pool = mk('i', 'rs-pool', null);
      place(pool, hx - rx, hy - ry, rx * 2, ry * 2);   // r3 fix: centred where the lamp aims
      pool.style.setProperty('--k', String(Math.min(1.2, (lt.pow || 1.6) / 1.7)));
      if (p.content === 'own-photo') pool.style.setProperty('--h', '1.25');
      e.pool = pool;
    }
    const race = raceOf(p);
    const cap = L(p.caption);
    let hit;
    if (race && !p.decorative) {
      hit = mk('a', 'rs-pic-hit', null, { href: `#race=${race.id}`, 'data-pic': p.id, 'data-race': race.id });
      hit.setAttribute('aria-label', T('room.link', { c: cap }));
      hit.addEventListener('click', (ev) => {
        if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        opened = { a: hit, y: window.scrollY };
        if (router && typeof router.open === 'function') router.open({ raceId: race.id }, { from: 'list' });
      });
      hit.addEventListener('focus', () => {
        if (typeof o.lamp === 'function') o.lamp((p.x + p.w / 2) * U, (p.y + p.h * 0.45) * U);
      });
    } else {
      hit = mk('div', 'rs-pic-hit', null, { 'data-pic': p.id, 'aria-hidden': 'true' });
    }
    place(hit, p.x, p.y, p.w, p.h);
    if (p.rotation) hit.style.transform = `rotate(${p.rotation}deg)`;
    hit.setAttribute('data-side', p.x + p.w / 2 < CW / 2 ? 'l' : 'r');   // r3 fix: the caption grows to the board
    // DOM tier: the torch on a picture already in its lamp's pool would dodge it twice (blown out): the pool steps back
    // (r3 fix: also while the torch is near, near())
    const torch = () => {
      if (e.pool) e.pool.toggleAttribute('data-torch', Boolean(e.ptr || e.foc || e.near));
      room.toggleAttribute('data-rs-near', [...pics.values()].some((x) => (x.near || x.foc) && x.el.isConnected));
    };
    e.torch = torch;
    // round 3 integration: a number that keeps the hover (focus is back on it after a dossier closed) would keep its
    // label beside this caption and, in the DOM tier, its framing, which leaves this picture dark under the torch
    const away = (ev, on) => { if (ev.pointerType !== 'touch' && typeof o.away === 'function') o.away(on); };
    hit.addEventListener('pointerenter', (ev) => { e.ptr = true; torch(); away(ev, true); });
    hit.addEventListener('pointerleave', (ev) => { e.ptr = false; torch(); away(ev, false); });
    hit.addEventListener('focus', () => { e.foc = true; torch(); });
    hit.addEventListener('blur', () => { e.foc = false; torch(); });
    const c = mk('span', 'rs-pic-cap', hit, { 'aria-hidden': 'true' });
    mk('b', '', c).textContent = cap;
    if (hit.tagName === 'A') mk('span', '', c).textContent = T('room.open');
    e.hit = hit;
    pics.set(p.id, e);
    return e;
  }

  function attach(e) {
    // paint order inside the back layer: shadows and bricks first, then pictures, lamps, and the light pools last
    const pools = back.querySelector('.rs-pool');
    back.insertBefore(e.el, pools);
    if (e.fix) back.insertBefore(e.fix, pools);
    if (e.pool) back.appendChild(e.pool);
    hits.appendChild(e.hit);
    if (e.glow) glow.appendChild(e.glow);
  }
  function detach(e) {
    for (const n of [e.el, e.fix, e.pool, e.hit, e.glow]) if (n && n.parentNode) n.remove();
  }

  /** Pictures the fitted room shows whole, with their lamps (desktop only; none while the wall pans). */
  function fits() {
    if (!json || stage.mode === 'pan' || saveData || q.has('noroom') || phone()) return [];
    const c = stage.camera();
    const pu = c.s * U;                                    // CSS px per u at the fitted camera
    if (!(pu > 0)) return [];
    const m = 10 / pu;
    const x0 = CW / 2 - c.w / 2 / pu + m; const x1 = CW / 2 + c.w / 2 / pu - m;
    const y0 = CH / 2 - c.h / 2 / pu + m; const y1 = CH / 2 + c.h / 2 / pu - m;
    const out = [];
    for (const p of json.pictures || []) {
      const b = bounds(p.x, p.y, p.w, p.h, p.rotation);
      const fx = (json.fixtures || []).find((f) => f.for === p.id);
      if (fx) { b[0] = Math.min(b[0], fx.x); b[1] = Math.min(b[1], fx.y); b[2] = Math.max(b[2], fx.x + fx.w); b[3] = Math.max(b[3], fx.y + fx.h); }
      if (b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1) out.push(p);
    }
    return out.sort((a, b) => (a.priority || 1) - (b.priority || 1));
  }

  function update() {
    if (!json || disposed) return;
    const next = fits();
    const ids = next.map((p) => p.id);
    if (ids.join() === shown.join()) return;
    for (const [id, e] of pics) if (!ids.includes(id)) detach(e);
    for (const p of next) attach(pics.get(p.id) || build(p));
    shown = ids;
    room.toggleAttribute('data-rs-pics', ids.length > 0);
    emit();
  }
  let upT = 0;
  const later = () => { clearTimeout(upT); upT = setTimeout(update, 120); };

  // r3 fix, DOM tier: the torch within 380 u of a picture bleached the print (two dodges): the picture's pool steps
  // back and the torch goes to half (room.css [data-rs-near])
  const near = (ev) => {
    const w = ev && ev.pointerType !== 'touch' && shown.length && room.dataset.renderer === 'dom' ? stage.toWall(ev.clientX, ev.clientY) : null;
    for (const e of pics.values()) {
      const n = Boolean(w && e.el.isConnected && Math.hypot(w[0] / U - e.p.x - e.p.w / 2, w[1] / U - e.p.y - e.p.h / 2) < 380);
      if (n !== Boolean(e.near)) { e.near = n; e.torch(); }
    }
  };
  for (const [t, fn] of [['pointermove', near], ['pointerleave', () => near()]]) {
    stageEl.addEventListener(t, fn, { passive: true });
    offs.push(() => stageEl.removeEventListener(t, fn));
  }

  function relabel() {
    for (const e of pics.values()) {
      const cap = L(e.p.caption);
      const c = e.hit.querySelector('.rs-pic-cap');
      if (c) { c.firstChild.textContent = cap; if (c.children[1]) c.children[1].textContent = T('room.open'); }
      if (e.hit.tagName === 'A') e.hit.setAttribute('aria-label', T('room.link', { c: cap }));
    }
  }

  // ---------------------------------------------------------------- load
  const ready = (async () => {
    const res = await fetch(url('img/room/room.json'), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`room.json: ${res.status}`);
    json = await res.json();
    if (disposed) return null;
    layers();
    if (o.css) await Promise.race([o.css, new Promise((r) => setTimeout(r, 1500))]);
    room.setAttribute('data-rs-room', 'on');
    loadBoard();
    const bricksP = loadBricks();
    update();
    await bricksP;
    return json;
  })().catch((e) => { warn('load', e); return null; });

  if (stage && typeof stage.on === 'function') offs.push(stage.on('change', (c) => { if (c && c.reason === 'layout') later(); }));
  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('lang:change', relabel));
    offs.push(bus.on('dossier:closed', () => {
      // a picture opened it as an index card: back to the picture (the dossier returns index cards to the list)
      const w = opened;
      opened = null;
      if (!w || !w.a.isConnected) return;
      try { window.scrollTo({ top: w.y, behavior: 'instant' }); } catch (_) { window.scrollTo(0, w.y); }
      try { w.a.focus({ preventScroll: true }); } catch (_) { /* */ }
    }));
    offs.push(bus.on('dossier:open', (d) => { if (opened && d && d.from !== 'list') opened = null; }));
    offs.push(bus.on('tier:change', (d) => { if (d && d.tier === 'dom') settle(false); else if (d && d.reason === 'webgl-ready') settle(true); }));
  }
  void store;

  const api = {
    ready,
    /** For the WebGL tier: the parsed room.json, file URLs, the pictures shown now (with their lamps and lights). */
    info() {
      if (!json) return null;
      const set = new Set(shown);
      return {
        json, rev, url,
        bricks: brickFile(),
        pictures: (json.pictures || []).filter((p) => set.has(p.id)),
        fixtures: (json.fixtures || []).filter((f) => set.has(f.for)),
        lights: (json.lights || []).filter((l) => set.has(l.for)),
      };
    },
    on(type, fn) {
      if (type !== 'change' || typeof fn !== 'function') return () => {};
      fns.add(fn);
      return () => fns.delete(fn);
    },
    relabel,
    dispose() {
      disposed = true;
      clearTimeout(upT); clearTimeout(settleT);
      room.removeAttribute('data-rs-gl-settled'); room.removeAttribute('data-rs-near');
      for (const off of offs.splice(0)) { try { off(); } catch (_) { /* */ } }
      for (const e of pics.values()) detach(e);
      for (const n of [glow, board, hits, shade]) if (n) n.remove();
      room.removeAttribute('data-rs-room');
      room.removeAttribute('data-rs-pics');
      fns.clear();
    },
  };
  return api;
}

export default { createRoom };
