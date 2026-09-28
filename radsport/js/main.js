/**
 * main.js: boot of the Startnummern page (spec 8.2) and the wiring hub between the packages.
 *
 * 1. tier detection (8.3: ?tier=high|medium|dom, ?nogl, Save-Data, forced colours, ...), store, i18n
 * 2. data (bibs.json, races.json), router, career (seasons, list), wall (WP4: stage, hitlayer, label,
 *    renderer-dom), dossier (WP6; only if it is missing or fails, the minimal sheet of fallback-sheet.js), audio (WP8)
 * 3. requestIdleCallback: WebGL renderer (WP5) if the tier allows; any failure keeps the DOM tier
 * Optional modules are imported with import() inside try/catch and only if render_static.py listed them
 * in #rs-build (no 404s during development). Without them the page still shows the wall and the list.
 *
 * Contracts used here (see $S/build/notes/wp3.md, "Wiring"):
 *   createStage(stageEl, { size, room, img, reducedMotion })
 *   createHitLayer(svg, bibs, { stage, i18n, data, bus, store })  bibs = array, also has get(id)/has(id)/size
 *     hit.onHover(fn), hit.onActivate(fn): fn({ bibId, via }) or fn(bibId, via); main.js emits wall:* on the bus
 *   label module: createLabel(labelEl, { stage, i18n, data, bus, store, onOpen }) -> { show(bibId, o), hide(), relabel() }
 *   renderer-dom / renderer-gl: createRenderer(opts) -> WallRenderer (spec 3.6); init({ stage, bibs, textures })
 *   createDossier(dialogEl, { data, i18n, bus, flight, charts, store, router, audio, wall, lightbox, announce })
 *     main.js calls dossier.open()/close(); the dossier emits dossier:opened, dossier:closed, dossier:switch
 *   audio (audio-bridge.js): configure, bindControls(hud), enable, disable, hover, unhover, wall, duck
 */
import { store, bus } from './state.js';
import i18n, { t } from './i18n.js';
import { router, parseHash } from './router.js';
import * as data from './data.js';

const doc = document;
const root = doc.documentElement;
const $ = (s, el = doc) => el.querySelector(s);
const W = 4789;
const H = 3527;

function readJSON(id) {
  try { return JSON.parse($(`#${id}`)?.textContent || '{}'); } catch (_) { return {}; }
}
const BUILD = readJSON('rs-build');
const MODULES = Array.isArray(BUILD.modules) ? new Set(BUILD.modules) : null;

const pref = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage off */ } };
const warn = (where, e) => { try { console.warn(`[radsport] ${where}:`, e); } catch (_) { /* */ } };
const safe = (fn, where) => { try { return fn(); } catch (e) { warn(where, e); return null; } };
const call = (obj, name, ...args) => {
  if (!obj || typeof obj[name] !== 'function') return undefined;
  try { return obj[name](...args); } catch (e) { warn(name, e); return undefined; }
};
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(r, ms))]);
const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 900));

async function optional(path) {
  if (MODULES && !MODULES.has(path)) return null;
  try {
    return await import(`./${path}`);
  } catch (e) {
    warn(`import ${path}`, e);
    return null;
  }
}
const factory = (mod, names) => {
  if (!mod) return null;
  for (const n of names) {
    if (typeof mod[n] === 'function') return mod[n];
    if (mod.default && typeof mod.default[n] === 'function') return mod.default[n];
  }
  return typeof mod.default === 'function' ? mod.default : null;
};

const el = {
  room: $('[data-rs-room]'),
  stage: $('[data-rs-stage]'),
  img: $('.rs-wall'),
  canvas: $('.rs-gl'),
  lamp: $('.rs-lamp'),
  svg: $('.rs-hit'),
  lift: $('.rs-lift'),
  label: $('.rs-label'),
  intro: $('[data-rs-intro]'),
  hud: $('[data-rs-hud]'),
  count: $('[data-rs-count]'),
  captions: $('[data-rs-captions]'),
  countdown: $('[data-rs-countdown]'),
  rail: $('[data-rs-rail]'),
  hudCard: $('[data-rs-season-card]'),
  sectionCard: $('[data-rs-season-card-section]'),
  strip: $('[data-rs-strip]'),
  list: $('[data-rs-list]'),
  filters: $('[data-rs-filters]'),
  dossier: $('dialog.rs-dossier'),
  lightbox: $('dialog.rs-lightbox'),
  flight: $('.rs-flight'),
  live: $('[data-rs-live]'),
  light: $('[data-rs-light]'),
  sound: $('[data-rs-sound]'),
  cc: $('[data-rs-cc]'),
  header: $('.gl-site-header'),
};

// ------------------------------------------------------------------ environment and tier (8.3)
const TIERS = ['dom', 'medium', 'high'];
function detectEnv() {
  const q = new URLSearchParams(location.search);
  const mm = (s) => { try { return matchMedia(s).matches; } catch (_) { return false; } };
  const reduced = mm('(prefers-reduced-motion: reduce)');
  const forced = mm('(forced-colors: active)');
  const saveData = Boolean(navigator.connection && navigator.connection.saveData);
  const plain = mm('(prefers-reduced-transparency: reduce)') || mm('(prefers-contrast: more)');
  const fine = mm('(pointer: fine)');
  const gl2 = typeof window.WebGL2RenderingContext !== 'undefined';
  const cores = navigator.hardwareConcurrency || 0;
  const mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || mm('(max-width: 759px)');
  let tier;
  let reason;
  const forcedTier = q.get('tier');
  if (TIERS.includes(forcedTier)) { tier = forcedTier; reason = 'param'; }
  else if (q.has('nogl')) { tier = 'dom'; reason = 'nogl'; }
  else if (!gl2) { tier = 'dom'; reason = 'no-webgl2'; }
  else if (saveData) { tier = 'dom'; reason = 'save-data'; }
  else if (forced) { tier = 'dom'; reason = 'forced-colors'; }
  else if (plain) { tier = 'dom'; reason = 'preference'; }
  else if (fine && !mobile && (cores >= 8 || !cores)) { tier = 'high'; reason = 'capable'; }
  else { tier = 'medium'; reason = mobile ? 'mobile' : 'modest'; }
  let cap = null;
  try { cap = sessionStorage.getItem('rs-tier-cap'); } catch (_) { /* */ }
  if (reason !== 'param' && TIERS.includes(cap) && TIERS.indexOf(cap) < TIERS.indexOf(tier)) { tier = cap; reason = 'watchdog'; }
  return { tier, reason, reduced, forced, saveData, fine, mobile };
}

const env = detectEnv();
root.setAttribute('data-rs-tier', env.tier);
store.set({ tier: env.tier, reducedMotion: env.reduced, lang: i18n.lang(), theme: i18n.theme(), houseLight: pref('rs-house') === '1' });
try {
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => store.set({ reducedMotion: e.matches }));
} catch (_) { /* old Safari */ }

// ------------------------------------------------------------------ shared state of the wiring
let index = null;
let stageObj = null;
let hit = null;
let label = null;
let domRenderer = null;
let renderer = null;
let dossier = null;
let audio = null;
let captions = null;
let career = null;
let lit = [];
let lastTrigger = null;
let roomVisible = true;
let introOpen = false;
let wantSound = false;
let entry = null;               // the running entry moment (lights out, countdown, lamp on)
let entryT0 = 0;                // its click time (performance.now), shared with the audio bridge
let unknownAt = -1e9;
let coldDeep = false;           // a first visit arrived on a deep link: an unknown id brings the intro back
let seasonFocus = null;         // the year a pointer or keyboard previews on the rail or the strip
let hoverVia = null;

/** Polite live message; while the modal dossier is open (the page region is hidden then) its own region speaks. */
function announce(text) {
  if (!text) return;
  const own = el.dossier && el.dossier.open ? el.dossier.querySelector('[data-d-live]') : null;
  const region = own || el.live;
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 60);
}

function measureHeader() {
  const h = el.header ? Math.round(el.header.getBoundingClientRect().height) : 0;
  if (h) root.style.setProperty('--rs-header-h', `${h}px`);
}

// ------------------------------------------------------------------ intro and entry (1.1)
function dismissIntro() {
  if (!el.room) return;
  introOpen = false;
  el.room.classList.add('is-entered');
  call(renderer, 'setWander', false);
  if (audio && audio.isOn && audio.isOn()) call(audio, 'wall');   // the bridge holds the bed back during a countdown
}

// Entry moment ("like jumping into a different world"): after "Mit Ton eintreten" the room goes dark (400 ms), the
// start clock counts down (3 · 2 · 1: three short beeps and a long one, about 2 s), then the lamp clacks on with the
// sweep and the bunch rushes past. "Ohne Ton": lights out, lamp on. Any click, key or pointer drag skips straight to the
// end state. Reduced motion and forced colours: no countdown, the light is simply there. Times in ms after the click;
// the audio bridge schedules its beeps on the same clock (audio-bridge.js ENTRY).
const ENTRY_MS = { steps: [400, 900, 1400], go: 1900, lights: 2500, quietLights: 650 };
const SKIP_EVENTS = ['pointerdown', 'keydown', 'pointermove'];

function countdownStep(i) {
  if (!el.countdown) return;
  el.countdown.classList.toggle('is-go', i >= 3);        // the long beep: the ring turns red, the "1" stays
  for (const s of el.countdown.querySelectorAll('[data-n]')) {
    const k = 3 - Number(s.getAttribute('data-n'));      // 3 -> 0, 2 -> 1, 1 -> 2
    s.classList.toggle('is-on', i >= 3 ? k === 2 : k === i);   // one digit at a time
  }
}

function runEntry(withSound, t0) {
  const room = el.room;
  if (!room) return;
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, Math.max(0, ms - (performance.now() - t0))));
  const skip = (e) => {
    if (e.type === 'pointermove' && !e.buttons) return;     // a drag skips, a plain move does not
    lightsOn(true);
  };
  entry = { withSound, timers, skip };
  countdownStep(-1);
  room.classList.add('is-dark');
  if (withSound) {
    room.classList.add('is-counting');
    ENTRY_MS.steps.forEach((ms, i) => at(ms, () => countdownStep(i)));
    at(ENTRY_MS.go, () => countdownStep(3));
  }
  at(withSound ? ENTRY_MS.lights : ENTRY_MS.quietLights, () => lightsOn(false));
  for (const ev of SKIP_EVENTS) addEventListener(ev, skip, { capture: true, passive: true });
}

/** The lamp clacks on: end of the entry moment (skipped: no sweep, no bunch, the lamp is simply there). */
function lightsOn(skipped) {
  const e = entry;
  if (!e) return;
  entry = null;
  for (const id of e.timers) clearTimeout(id);
  for (const ev of SKIP_EVENTS) removeEventListener(ev, e.skip, { capture: true });
  if (el.room) el.room.classList.remove('is-dark', 'is-counting');
  if (e.withSound && audio) call(audio, 'entryLights', { skipped });
  if (!skipped && !store.get().reducedMotion) {
    const v = call(stageObj, 'view') || { x0: 0, y0: 0, w: W, h: H };   // the visible wall: phones pan
    call(renderer, 'sweep', { from: [v.x0 + v.w * 0.12, v.y0 + v.h * 0.16], to: [v.x0 + v.w * 0.74, v.y0 + v.h * 0.72], dur: 2400 });
  }
}

function enter(withSound) {
  setPref('rs-seen', '1');
  const plain = store.get().reducedMotion || env.forced;
  const t0 = performance.now();
  if (withSound) {
    wantSound = plain ? 'plain' : 'countdown';
    if (audio) call(audio, 'enable', plain ? { entry: true } : { entry: 'countdown', t0 });
  } else {
    wantSound = false;
    if (audio) call(audio, 'disable');
    else setPref('tj-rs-sound', 'off');
  }
  dismissIntro();
  if (!plain) runEntry(withSound, t0);
  entryT0 = t0;
  if (el.room) el.room.focus({ preventScroll: true });
}

function initIntro() {
  const deep = parseHash(location.hash);
  const seen = pref('rs-seen') === '1';
  // the head script hid the card for a deep link; one the router rejects must not hide it
  if (!deep && !seen) root.classList.remove('rs-skip-intro');
  coldDeep = Boolean(deep && !seen);
  if (deep || seen) {
    el.room && el.room.classList.add('is-entered');
    introOpen = false;
    if (seen && !deep && el.room) {
      el.room.classList.add('is-ask');
      setTimeout(() => el.room.classList.remove('is-ask'), 5200);
    }
  } else {
    introOpen = true;
  }
  for (const b of doc.querySelectorAll('[data-rs-enter]')) {
    b.addEventListener('click', () => enter(b.getAttribute('data-rs-enter') === 'sound'));
  }
}

/** A first visit on a deep link whose id does not exist: the wall is shown, so the intro comes back. */
function reopenIntro() {
  coldDeep = false;
  if (!el.room || pref('rs-seen') === '1' || store.get().open) return;
  root.classList.remove('rs-skip-intro');
  el.room.classList.remove('is-entered');
  introOpen = true;
  call(renderer, 'setWander', true);
}

// ------------------------------------------------------------------ house light (Saallicht)
function applyHouse() {
  const { houseLight, theme } = store.get();
  if (el.light) el.light.setAttribute('aria-pressed', String(Boolean(houseLight)));
  if (el.room) el.room.setAttribute('data-house', houseLight ? 'on' : 'off');
  // light 0.10 (spec 1.2: 0.14, lowered for the lamp's drama), dark 0.08, Saallicht 0.60
  call(renderer, 'setHouse', houseLight ? 0.6 : theme === 'dark' ? 0.08 : 0.1, theme === 'dark' ? 'cool' : 'warm');
}
function initHud() {
  if (el.light) {
    el.light.addEventListener('click', () => {
      const on = !store.get().houseLight;
      store.set({ houseLight: on });
      setPref('rs-house', on ? '1' : '0');
      applyHouse();
      announce(t(on ? 'live.houseOn' : 'live.houseOff'));
    });
  }
  applyHouse();
}

function renderCount() {
  if (!el.count || !index) return;
  // confirmed and presumed apart (round 2 fix): „33 zugeordnet“ overclaimed for the guesses
  const c = index.bibList.filter((b) => b.raceId && b.ident && b.ident.status === 'confirmed').length;
  const o = index.stats.bibs - index.stats.bibsMatched;
  el.count.textContent = t('hud.count', { n: index.stats.bibs, c, l: index.stats.bibsMatched - c }) + (o > 0 ? t('hud.count.open', { o }) : '');
}

// ------------------------------------------------------------------ wall (WP4) and renderers (WP4, WP5)
function listLike(arr) {
  const out = arr.slice();
  const map = new Map(arr.map((b) => [b.id, b]));
  Object.defineProperties(out, {
    get: { value: (id) => map.get(id) || null },
    has: { value: (id) => map.has(id) },
    size: { get: () => map.size },
  });
  return out;
}

function setRenderer(r, kind) {
  renderer = r;
  if (el.room) {
    if (r) el.room.setAttribute('data-renderer', kind);
    else el.room.removeAttribute('data-renderer');
  }
  if (!r) return;
  applyHouse();
  const s = store.get();
  call(r, 'setWander', introOpen);
  call(r, 'setHover', s.hover);
  call(r, 'setLit', lit);
  if (s.open && s.open.bibId) call(r, 'vacate', s.open.bibId);
}

function norm(a, b) {
  if (a && typeof a === 'object' && !Array.isArray(a)) return { bibId: a.bibId ?? a.id ?? null, via: a.via || b || 'pointer' };
  return { bibId: a || null, via: b || 'pointer' };
}

let prefetchTimer = 0;
const prefetched = new Set();
function prefetch(bibId) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (!bibId || prefetched.has(bibId)) return;
    prefetched.add(bibId);
    const bib = data.getBib(bibId);
    if (bib && bib.crop && bib.crop.file) { const im = new Image(); im.decoding = 'async'; im.src = data.assetURL(bib.crop.file); }
    const race = data.raceForBib(bibId);
    if (!race) return;
    const st = race.stages.find((s) => s.power) || null;
    const pw = (race.power && race.power.file) || (st && st.power);
    if (pw) data.loadPower(pw);
    const wx = race.weather || (race.stages.find((s) => s.weather) || {}).weather;
    if (wx) data.loadWeather(wx);
  }, 160);
}

function onHover(p) {
  const { bibId, via } = p;
  if (store.get().hover === bibId) return;
  // a tap before choosing enters quietly (as a click does); keyboard focus only moves the intro aside (CSS)
  if (bibId && introOpen && via === 'touch') dismissIntro();
  store.set({ hover: bibId });
  hoverVia = via;
  bus.emit('wall:hover', { bibId, via });
  call(renderer, 'setHover', bibId);
  if (label) {
    if (bibId && (via === 'touch' || el.hudCard?.hidden !== false)) call(label, 'show', bibId, { via });   // season card up: touch only
    else call(label, 'hide');
  }
  if (audio) {
    if (bibId && !entry) call(audio, 'hover', bibId, { bib: data.getBib(bibId) });   // silent while the start clock counts
    else call(audio, 'unhover');
  }
  if (bibId) prefetch(bibId);
}

function onActivate(p) {
  const { bibId, via } = p;
  if (!bibId) return;
  bus.emit('wall:activate', { bibId, via });
  if (introOpen) dismissIntro();
  const tgt = data.targetFor(bibId);
  if (tgt) router.open(tgt, { from: 'wall' });
}

/** Minimal hit handling when wall/hitlayer.js is not there: the SVG links still work natively. */
function fallbackHits() {
  if (!el.svg) return;
  const bibOf = (e) => { const a = e.target.closest && e.target.closest('a[data-bib]'); return a ? a.getAttribute('data-bib') : null; };
  el.svg.addEventListener('pointerover', (e) => { const id = bibOf(e); if (id) onHover({ bibId: id, via: e.pointerType || 'pointer' }); });
  el.svg.addEventListener('pointerout', (e) => { if (!e.relatedTarget || !el.svg.contains(e.relatedTarget)) onHover({ bibId: null, via: 'pointer' }); });
  el.svg.addEventListener('focusin', (e) => { const id = bibOf(e); if (id) onHover({ bibId: id, via: 'focus' }); });
  el.svg.addEventListener('focusout', (e) => { if (!e.relatedTarget || !el.svg.contains(e.relatedTarget)) onHover({ bibId: null, via: 'focus' }); });
  el.svg.addEventListener('click', (e) => {
    const id = bibOf(e);
    if (!id || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onActivate({ bibId: id, via: 'click' });
  });
}

function relabelLinks() {
  if (!el.svg || !index) return;
  for (const a of el.svg.querySelectorAll('a[data-bib]:not([data-halo])')) {
    const b = data.getBib(a.getAttribute('data-bib'));
    if (b) a.setAttribute('aria-label', i18n.bibLabel(b, data.raceForBib(b.id)));
  }
}

// lamp: pointer, touch and idle (5.2)
let lastInput = performance.now();
let idleTimer = 0;
let sleeping = false;
function wake() {
  lastInput = performance.now();
  if (sleeping) { sleeping = false; if (roomVisible && !doc.hidden) call(renderer, 'resume'); }
  if (el.room) el.room.classList.add('is-tracking');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(checkIdle, 8200);
}
function checkIdle() {
  const quiet = performance.now() - lastInput;
  if (store.get().open) {                        // the sheet is up (replay light may run): no wander, no sleep
    idleTimer = setTimeout(checkIdle, 8000);
    return;
  }
  if (quiet >= 8000) {
    call(renderer, 'setWander', true);
    if (el.room) el.room.classList.remove('is-tracking');
  }
  if (quiet >= 60000) { sleeping = true; call(renderer, 'pause'); return; }
  idleTimer = setTimeout(checkIdle, quiet >= 8000 ? 60000 - quiet + 50 : 8000 - quiet + 50);
}
function initLamp() {
  if (!el.stage) return;
  const move = (e) => {
    wake();
    if (renderer && stageObj && typeof stageObj.toWall === 'function') {
      const p = safe(() => stageObj.toWall(e.clientX, e.clientY), 'stage.toWall');
      if (p) {
        call(renderer, 'setWander', false);
        call(renderer, 'setLamp', p[0] ?? p.x, p[1] ?? p.y, { instant: store.get().reducedMotion });
      }
    } else if (el.room && !renderer) {
      const r = el.room.getBoundingClientRect();
      el.room.style.setProperty('--rs-lamp-x', `${(((e.clientX - r.left) / r.width) * 100).toFixed(2)}%`);
      el.room.style.setProperty('--rs-lamp-y', `${(((e.clientY - r.top) / r.height) * 100).toFixed(2)}%`);
      el.room.classList.add('is-tracking');
    }
  };
  el.stage.addEventListener('pointermove', move, { passive: true });
  el.stage.addEventListener('pointerdown', move, { passive: true });
  doc.addEventListener('keydown', wake, { passive: true });
  idleTimer = setTimeout(checkIdle, 8200);
}

function syncDuck() {
  if (audio) call(audio, 'duck', !roomVisible && !store.get().open);
}
function initVisibility() {
  const update = () => {
    const active = roomVisible && !doc.hidden;
    call(renderer, active && !sleeping ? 'resume' : 'pause');
    syncDuck();
  };
  if ('IntersectionObserver' in window && el.room) {
    new IntersectionObserver((entries) => {
      roomVisible = entries.some((en) => en.isIntersecting);
      update();
    }, { threshold: 0.02 }).observe(el.room);
  }
  doc.addEventListener('visibilitychange', update);
}

let wallReadyP = null;
function wallReady() {
  if (!wallReadyP) {
    const img = el.img;
    wallReadyP = !img ? Promise.resolve() : withTimeout(
      img.complete ? (img.decode ? img.decode().catch(() => {}) : Promise.resolve()) : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }),
      3500,
    );
  }
  return wallReadyP;
}

// DOM tier: a sharper wall file than the phone LCP one, after load (wall/upgrade.js, spec 8.1)
const upgradeWall = () => (env.saveData || !el.img ? Promise.resolve(false)
  : optional('wall/upgrade.js').then((m) => (m ? m.upgradeWall(el.img, { ready: wallReady() }) : false)));

// the café around the wall (round 3, D29): only after the photo (the LCP); the WebGL tier draws the same room
let roomP = null;
const loadRoom = () => roomP || (roomP = wallReady().then(() => optional('wall/room.js')).then((m) => {
  const create = factory(m, ['createRoom']);
  return create && stageObj ? safe(() => create({
    el: el.stage, stage: stageObj, data, i18n, bus, store, router, v: BUILD.room, css: loadLazyCss(), saveData: env.saveData,
    lamp: (x, y) => { call(renderer, 'setWander', false); call(renderer, 'setLamp', x, y); },
    away: (on) => call(hit, 'away', on),       // the pointer is on a framed picture: no number stays hovered
  }), 'room') : null;
}));

async function initWall(mods) {
  const bibs = listLike(index.bibList);
  const ctx = { i18n, data, bus, store, reducedMotion: store.get().reducedMotion, tier: store.get().tier };
  const createStage = factory(mods.stage, ['createStage']);
  if (createStage) stageObj = safe(() => createStage(el.stage, { size: [W, H], room: el.room, img: el.img, ...ctx }), 'createStage');
  const createHit = factory(mods.hitlayer, ['createHitLayer']);
  if (createHit) hit = safe(() => createHit(el.svg, bibs, { stage: stageObj, ...ctx }), 'createHitLayer');
  if (hit) {
    call(hit, 'onHover', (a, b) => onHover(norm(a, b)));
    call(hit, 'onActivate', (a, b) => onActivate(norm(a, b)));
  } else {
    fallbackHits();
  }
  const createLabel = factory(mods.label, ['createLabel', 'createWallLabel']);
  if (createLabel) {
    label = safe(() => createLabel(el.label, { stage: stageObj, onOpen: (bibId) => onActivate({ bibId, via: 'touch' }), ...ctx }), 'createLabel');
  }
  const createDom = factory(mods.rendererDom, ['createRenderer', 'createDomRenderer', 'createRendererDom']);
  if (createDom) {
    const r = safe(() => createDom({ el: el.stage, room: el.room, img: el.img, lamp: el.lamp, svg: el.svg, lift: el.lift, canvas: el.canvas, stage: stageObj, bibs, ...ctx }), 'renderer-dom');
    if (r) {
      try {
        await withTimeout(r.init({ stage: stageObj, bibs, textures: { albedo: el.img } }), 4000);
        domRenderer = r;
        setRenderer(r, 'dom');
      } catch (e) {
        warn('renderer-dom init', e);
      }
    }
  }
  initLamp();
}

function scheduleGL(mods) {
  if (store.get().tier === 'dom' || (MODULES && !MODULES.has('wall/renderer-gl.js'))) {
    idle(upgradeWall);
    return;
  }
  idle(async () => {
    await startGL();
    if (renderer === domRenderer) upgradeWall();          // no WebGL after all
  });
  void mods;
}

async function startGL() {
  const m = await optional('wall/renderer-gl.js');
  const create = factory(m, ['createRenderer', 'createGLRenderer', 'createRendererGL']);
  if (!create) return;
  const bibs = listLike(index.bibList);
  const tx = (index.meta && index.meta.textures) || {};
  let gl = null;
  try {
    gl = create({ canvas: el.canvas, el: el.stage, room: el.room, img: el.img, stage: stageObj, bibs, i18n, data, bus, store, tier: store.get().tier, reducedMotion: store.get().reducedMotion });
    if (!gl) return;
    await wallReady();
    const ok = await withTimeout(Promise.resolve(gl.init({
      stage: stageObj,
      bibs,
      textures: {
        albedo: el.img,
        normal: tx.normal && data.assetURL(tx.normal.file),
        id: tx.id && data.assetURL(tx.id.file),
        meta: tx,
      },
      room: loadRoom(),
    })).then(() => true), 9000);
    if (!ok) { call(gl, 'dispose'); return; }
    if (typeof gl.on === 'function') gl.on('fallback', (reason) => toDom(gl, reason));
    if (el.canvas) {
      el.canvas.hidden = false;
      requestAnimationFrame(() => el.canvas.classList.add('is-ready'));
    }
    call(domRenderer, 'pause');
    setRenderer(gl, 'gl');
    bus.emit('tier:change', { tier: store.get().tier, reason: 'webgl-ready' });
  } catch (e) {
    warn('renderer-gl', e);
    if (gl && renderer !== gl) call(gl, 'dispose');
  }
}

function toDom(gl, reason) {
  if (renderer !== gl) return;
  if (el.canvas) el.canvas.classList.remove('is-ready');
  call(gl, 'dispose');
  try { sessionStorage.setItem('rs-tier-cap', 'dom'); } catch (_) { /* */ }
  store.set({ tier: 'dom' });
  root.setAttribute('data-rs-tier', 'dom');
  call(domRenderer, 'resume');
  setRenderer(domRenderer, domRenderer ? 'dom' : '');
  bus.emit('tier:change', { tier: 'dom', reason: reason || 'fallback' });
  upgradeWall();
}

// ------------------------------------------------------------------ seasons and list (career.js)
function lightSeason(year) {
  const s = year ? index.seasons.get(Number(year)) : null;
  lit = s ? [...new Set(s.bibs)] : [];
  call(renderer, 'setLit', lit);
  if (hit) call(hit, 'setLit', lit);
  else if (el.svg) {
    for (const a of el.svg.querySelectorAll('a[data-bib]')) a.toggleAttribute('data-lit', lit.includes(a.getAttribute('data-bib')));
  }
}
const coarse = () => { try { return matchMedia('(pointer: coarse)').matches; } catch (_) { return false; } };

// HUD season card (spec 1.7): above the rail, or in the nearest gap between the lit numbers.
/** Horizontal extent [x0, x1] of a polygon inside the band y0..y1, or null. */
function spanIn(poly, y0, y1) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    if (ay >= y0 && ay <= y1) { lo = Math.min(lo, ax); hi = Math.max(hi, ax); }
    for (const yy of [y0, y1]) {
      if ((ay - yy) * (by - yy) < 0) { const x = ax + ((bx - ax) * (yy - ay)) / (by - ay); lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}
function placeHudCard() {
  const card = el.hudCard;
  if (!card || card.hidden || !el.room || !el.hud) return;
  const room = el.room.getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  if (!w || !h || !room.width) return;
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return r.width ? { l: r.left - room.left, t: r.top - room.top, r: r.right - room.left, b: r.bottom - room.top } : null;
  };
  const rail = box(el.rail);
  const ctl = box(el.hud.querySelector('.rs-hud__controls'));
  const line = box(el.hud.querySelector('.rs-hud__room'));
  const gap = 12;
  const W = room.width;
  const H = room.height;
  const pad = line ? line.l : 24;
  const top = (line ? line.b : 24) + gap;
  const low = (rail || ctl ? Math.min(...[rail, ctl].filter(Boolean).map((b) => b.t)) : H) - gap - h;
  const home = [rail ? rail.r - w : W - pad - w, low];   // preferred: above the rail, next to the buttons
  const polys = (stageObj && typeof stageObj.toLocal === 'function')
    ? lit.map((id) => data.getBib(id)).filter(Boolean).map((b) => b.poly.map((q) => stageObj.toLocal(q[0], q[1])))
    : [];
  let best = null;
  // free gaps between the lit numbers in the rows above the rail and under the HUD line, nearest to home
  for (const y of [low, top]) {
    const blocks = polys.map((pg) => spanIn(pg, y, y + h)).filter(Boolean).map(([a, b]) => [a - 8, b + 8]).sort((a, b) => a[0] - b[0]);
    let x0 = 8;
    const gaps = [];
    for (const [a, b] of blocks) { if (a > x0) gaps.push([x0, a]); x0 = Math.max(x0, b); }
    if (x0 < W - 8) gaps.push([x0, W - 8]);
    for (const [a, b] of gaps) {
      if (b - a < w) continue;
      const x = Math.min(Math.max(home[0], a), b - w);
      const dist = Math.hypot(x - home[0], y - home[1]);
      if (!best || dist < best.dist) best = { x, y, dist, hits: 0 };
    }
  }
  if (!best) best = { x: Math.max(8, home[0]), y: home[1], hits: 1 };   // no gap: above the rail, translucent
  card.style.setProperty('--rs-card-x', `${Math.round(best.x)}px`);
  card.style.setProperty('--rs-card-y', `${Math.round(best.y)}px`);
  card.setAttribute('data-placed', '');
  card.toggleAttribute('data-over', best.hits > 0);
}
function showHudCard(year) {
  if (!career || !career.hudCard) return;
  if (hoverVia === 'touch') bus.emit('label:dismiss');
  call(label, 'hide');                           // spec 1.7: the season cue replaces the bib's
  call(career.hudCard, 'show', year);
  placeHudCard();
}
function hideHudCard() {
  if (career) call(career.hudCard, 'hide');
  if (el.hudCard) { el.hudCard.removeAttribute('data-placed'); el.hudCard.removeAttribute('data-over'); }
  const { hover, open } = store.get();
  if (hover && !open && hoverVia !== 'touch') call(label, 'show', hover, { via: hoverVia });
}

function initCareer(mod) {
  if (!mod) return;
  career = {
    rail: safe(() => mod.createSeasonRail(el.rail, index, { bus }), 'season rail'),
    hudCard: safe(() => mod.createSeasonCard(el.hudCard, index), 'season card'),
    card: safe(() => mod.createSeasonCard(el.sectionCard, index), 'season card'),
    strip: mod.createSeasonStrip ? safe(() => mod.createSeasonStrip(el.strip, index, { bus }), 'season strip') : null,
    list: safe(() => mod.enhanceList(el.list, index, { bus, router, filtersEl: el.filters }), 'list'),
  };
  // hover or keyboard focus previews a year (light cue and card); without one the selection shows
  bus.on('season:focus', ({ year, via }) => {
    seasonFocus = year || null;
    const sel = store.get().season;
    const y = year || sel;
    lightSeason(y);
    if (via === 'strip') {
      if (y) call(career.card, 'show', y); else call(career.card, 'hide');
      return;
    }
    if (year) showHudCard(year);
    else if (sel && coarse()) showHudCard(sel);     // touch: the card of the chosen year stays
    else hideHudCard();
  });
  bus.on('season:select', ({ year, via }) => {
    const y = year ? Number(year) : null;
    const was = store.get().season;
    store.set({ season: y });
    if (via !== 'list') call(career.list, 'setYear', y);
    call(career.rail, 'select', y);
    call(career.strip, 'select', y);
    lightSeason(y || seasonFocus);
    if (y) {
      call(career.card, 'show', y);
      if (via === 'rail' && coarse()) showHudCard(y);   // a tap has no hover: the card rises with the choice
      const n = new Set((index.seasons.get(y) || { bibs: [] }).bibs).size;
      announce(n ? t('live.season', { year: y, n }) : t('live.seasonNone', { year: y }));
    } else {
      call(career.card, seasonFocus && via === 'strip' ? 'show' : 'hide', seasonFocus);
      if (coarse() && !seasonFocus) hideHudCard();
      if (was) announce(t('live.seasonOff'));
    }
  });
}

// ------------------------------------------------------------------ dossier (WP6) or the fallback sheet
// The minimal fallback sheet (fallback-sheet.js) loads only when dossier/dossier.js is missing or fails: see initDossier().

const chartsLoader = (() => {
  let p = null;
  return {
    load() {
      if (!p) {
        p = Promise.all(['charts/power-chart.js', 'charts/replay.js', 'weather/weather.js', 'photos/photos.js', 'map/locator.js'].map(optional))
          .then(([pc, rp, wx, ph, mp]) => ({
            createPowerChart: pc && pc.createPowerChart,
            createReplay: rp && rp.createReplay,
            createWeatherBoard: wx && wx.createWeatherBoard,
            createPrints: ph && ph.createPrints,
            openLightbox: ph && ph.openLightbox,
            createLocator: mp && mp.createLocator,
            modules: { powerChart: pc, replay: rp, weather: wx, photos: ph, locator: mp },
          }));
      }
      return p;
    },
  };
})();

const wallApi = {
  get renderer() { return renderer; },
  get stage() { return stageObj; },
  get hit() { return hit; },
  get label() { return label; },
  get visible() { return roomVisible; },
  detach: (bibId) => call(renderer, 'detach', bibId) ?? null,
  attach: (bibId, o) => call(renderer, 'attach', bibId, o) ?? Promise.resolve(),
  vacate: (bibId) => call(renderer, 'vacate', bibId),
  dolly: (bibId, o) => call(stageObj, 'dolly', bibId, o) ?? Promise.resolve(),
  restore: () => call(stageObj, 'restore') ?? Promise.resolve(),
  ensureVisible: (bibId) => call(stageObj, 'ensureVisible', bibId),
  quadToScreen: (quad) => call(stageObj, 'quadToScreen', quad) ?? null,
  link: (bibId) => (el.svg ? el.svg.querySelector(`a[data-bib="${bibId}"]:not([data-halo])`) : null),
  focus: (bibId) => { if (hit && typeof hit.focus === 'function') return call(hit, 'focus', bibId); const a = wallApi.link(bibId); if (a) a.focus({ preventScroll: true }); return a; },
  ready: wallReady,
};

function sameTarget(a, b) {
  if (!a || !b) return false;
  return (a.raceId || null) === (b.raceId || null) && (a.stage ?? null) === (b.stage ?? null)
    && ((a.bibId || null) === (b.bibId || null) || !b.bibId || !a.bibId);
}

async function initDossier(mods) {
  const deps = { data, i18n, bus, store, router, flight: mods.flight || null, charts: chartsLoader, audio, captions, wall: wallApi, lightbox: el.lightbox, flightEl: el.flight, announce };
  const create = factory(mods.dossier, ['createDossier']);
  if (create && el.dossier) dossier = safe(() => create(el.dossier, deps), 'createDossier');
  if (!dossier && el.dossier) {
    // only now: a working page never needs the minimal sheet (round 2 fix, out of the JS at interactive);
    // boot() waits for it before router.start(), so a cold deep link still opens it
    const createFallback = factory(await optional('fallback-sheet.js'), ['createFallbackDossier']);
    if (createFallback) dossier = safe(() => createFallback(el.dossier, { data, i18n, bus }), 'fallback sheet');
  }

  bus.on('dossier:open', async (d) => {
    if (!dossier) { router.close(); return; }        // neither dossier.js nor the fallback sheet loaded: nothing can open
    const tgt = { raceId: d.raceId || null, bibId: d.bibId || null, stage: d.stage ?? null };
    if (introOpen) dismissIntro();
    const cur = call(dossier, 'isOpen') ? call(dossier, 'current') : null;
    if (cur && sameTarget(cur, tgt)) return;
    if (!cur) lastTrigger = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    await withTimeout(loadLazyCss(), 1500);
    if (d.from === 'deeplink') await wallReady();
    root.classList.add('rs-dossier-open');
    store.set({ open: tgt });
    syncDuck();
    try {
      // no "Dossier geöffnet": focus on the titled dialog says it
      await call(dossier, 'open', { ...tgt, from: d.from || 'wall' });
    } catch (e) {
      warn('dossier.open', e);
    }
  });
  bus.on('dossier:close', (d) => {
    if (call(dossier, 'isOpen')) call(dossier, 'close', (d && d.reason) || 'history');
  });
  const syncUrl = () => {
    const cur = call(dossier, 'isOpen') ? call(dossier, 'current') : null;
    if (cur && (cur.raceId || cur.bibId)) {
      store.set({ open: { raceId: cur.raceId || null, bibId: cur.bibId || null, stage: cur.stage ?? null } });
      router.open(cur, { replace: true, silent: true });
    }
  };
  bus.on('dossier:opened', syncUrl);
  bus.on('dossier:switch', () => setTimeout(syncUrl, 0));
  bus.on('dossier:closed', (d) => {
    root.classList.remove('rs-dossier-open');
    store.set({ open: null });
    syncDuck();
    router.close();
    if (performance.now() - unknownAt > 800) announce(t('live.closed'));
    const trigger = lastTrigger;
    lastTrigger = null;
    setTimeout(() => {
      const active = doc.activeElement;
      if (active && active !== doc.body && !(el.dossier && el.dossier.contains(active))) return;
      const bibLink = d && d.bibId ? wallApi.link(d.bibId) : null;
      const back = trigger && trigger.isConnected ? trigger : bibLink;
      if (back) back.focus({ preventScroll: !(trigger && trigger.isConnected) });
    }, 0);
  });
  bus.on('route:unknown', () => {
    unknownAt = performance.now();
    if (call(dossier, 'isOpen')) {                  // the router closes it: say it on the page once the modal is gone
      let done = false;
      const say = () => { if (!done) { done = true; announce(t('live.unknown')); } };
      bus.once('dossier:closed', () => setTimeout(say, 0));
      setTimeout(say, 1600);
    } else {
      announce(t('live.unknown'));
    }
    if (coldDeep) reopenIntro();
  });
}

// ------------------------------------------------------------------ audio (WP8)
function initAudio(mod) {
  audio = mod ? (mod.audio || (mod.default && mod.default.enable ? mod.default : null)) : null;
  captions = mod ? mod.captions || null : null;
  if (!audio) {
    for (const b of [el.sound, el.cc]) if (b) b.hidden = true;
    return;
  }
  call(audio, 'configure', { bus, store, getRace: data.getRace, getBib: data.getBib });
  if (captions) {
    if (el.captions) call(captions, 'mount', el.captions);
    call(captions, 'setLang', i18n.lang);
  }
  call(audio, 'bindControls', el.hud);
  // the visitor chose "Mit Ton eintreten" before the bridge had loaded (slow network): join the running countdown
  if (wantSound && !call(audio, 'isOn')) call(audio, 'enable', wantSound === 'countdown' && entry ? { entry: 'countdown', t0: entryT0 } : { entry: true });
  if (el.sound) el.sound.addEventListener('click', () => { if (el.room) el.room.classList.remove('is-ask'); if (introOpen) dismissIntro(); });
}

// ------------------------------------------------------------------ language and theme
function relabelAll() {
  renderCount();
  if (hit && typeof hit.relabel === 'function') call(hit, 'relabel'); else relabelLinks();
  call(label, 'relabel');
  if (career) {
    call(career.list, 'relabel');
    call(career.rail, 'relabel');
    call(career.strip, 'relabel');
    call(career.card, 'relabel');
    call(career.hudCard, 'relabel');
  }
  call(captions, 'relabel');
}

// ------------------------------------------------------------------ lazy page stylesheets
// render_static.py links only the room-critical sheets; the list, dossier and chart sheets follow right after boot,
// inserted before audio.css so the cascade order of BUILD_BRIEF 2 is kept. Dossier opens wait for them.
let lazyCssP = null;
function loadLazyCss() {
  if (lazyCssP) return lazyCssP;
  const list = (BUILD.css && Array.isArray(BUILD.css.lazy)) ? BUILD.css.lazy : [];
  const before = doc.querySelector('link[rel="stylesheet"][href*="radsport/css/audio.css"]');
  lazyCssP = Promise.all(list.map((href) => new Promise((resolve) => {
    if (doc.querySelector(`link[rel="stylesheet"][href="${href}"]`)) { resolve(); return; }
    const l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.addEventListener('load', resolve, { once: true });
    l.addEventListener('error', resolve, { once: true });
    if (before) before.before(l); else doc.head.appendChild(l);
  })));
  return lazyCssP;
}

// ------------------------------------------------------------------ boot
// The rail sits left of the button row, whose width depends on the language and on the sound controls.
function initControlsWidth() {
  const c = el.hud && el.hud.querySelector('.rs-hud__controls');
  if (!c) return;
  const set = () => {
    const w = Math.ceil(c.getBoundingClientRect().width);
    if (w) el.hud.style.setProperty('--rs-ctl-w', `${w}px`);
  };
  set();
  if (typeof ResizeObserver === 'function') new ResizeObserver(set).observe(c);
}

// Light theme: the header takes the room palette while the entered room fills most of the viewport (CSS)
function initHeadRoom() {
  if (!el.room || !('IntersectionObserver' in window)) return;
  let share = 0;
  const apply = () => root.classList.toggle('rs-head-room', share >= 0.6 && el.room.classList.contains('is-entered'));
  const steps = Array.from({ length: 21 }, (_, i) => i / 20);
  new IntersectionObserver((entries) => {
    for (const en of entries) share = en.isIntersecting ? en.intersectionRect.height / (innerHeight || 1) : 0;
    apply();
  }, { threshold: steps }).observe(el.room);
  new MutationObserver(apply).observe(el.room, { attributes: true, attributeFilter: ['class'] });
}

// The skip link and the HUD "Liste" move focus to the list heading (after the browser scrolled to #liste).
function initListLinks() {
  const h = doc.getElementById('rs-list-h');
  if (!h) return;
  const go = () => requestAnimationFrame(() => { try { h.focus({ preventScroll: true }); } catch (_) { h.focus(); } });
  for (const a of doc.querySelectorAll('.rs-skip, [data-rs-listlink]')) a.addEventListener('click', go);
}

async function boot() {
  loadLazyCss();
  measureHeader();
  addEventListener('resize', measureHeader, { passive: true });
  addEventListener('resize', () => requestAnimationFrame(placeHudCard), { passive: true });
  initIntro();
  initHud();
  initVisibility();
  initControlsWidth();
  initHeadRoom();
  initListLinks();
  i18n.onLangChange((lang) => { store.set({ lang }); bus.emit('lang:change', { lang }); relabelAll(); });
  i18n.onThemeChange((theme) => { store.set({ theme }); bus.emit('theme:change', { theme }); applyHouse(); });

  const audioP = optional('audio/audio-bridge.js');
  const careerP = optional('career/career.js');
  const modsP = Promise.all([
    optional('wall/stage.js'), optional('wall/hitlayer.js'), optional('wall/label.js'), optional('wall/renderer-dom.js'),
    optional('flight.js'), optional('dossier/dossier.js'),
  ]);
  // the bridge must be there for the first click (iOS); the data wait for it: in parallel they delay the wall image
  initAudio(await audioP);

  try {
    index = await data.loadIndex();
  } catch (e) {
    warn('data', e);
    root.setAttribute('data-rs-static', '');
    return;
  }
  renderCount();
  initCareer(await careerP);
  const [stage, hitlayer, labelMod, rendererDom, flight, dossierMod] = await modsP;
  const mods = { stage, hitlayer, label: labelMod, rendererDom, flight, dossier: dossierMod };
  await initWall(mods);
  await initDossier(mods);
  router.start({ data, bus });
  coldDeep = false;               // only the cold start may bring the intro back
  scheduleGL(mods);
  loadRoom();
  if (!hit) relabelLinks();
  root.setAttribute('data-rs-ready', '');
  bus.emit('page:ready', { tier: store.get().tier });
}

// Dev and QA handle (no secrets): window.__rs.store.get(), window.__rs.bus.emit(...)
window.__rs = { store, bus, router, data, i18n, get dossier() { return dossier; }, get renderer() { return renderer; }, get audio() { return audio; }, get captions() { return captions; }, env };

boot().catch((e) => warn('boot', e));
