/**
 * audio-bridge.js: the page's only door to sound (spec 3.11, cue sheet 6, BUILD_BRIEF D8).
 *
 * Importing this module creates no AudioContext and makes no request. The engine
 * (audio-engine.js) and the clip manifest load only inside enable(), which must be called
 * from a user gesture (click, tap, key). Every audible cue raises a caption through the
 * engine's oncue hook; with sound off and captions on ("UT"), the same captions describe
 * what would sound (no-sound parity).
 *
 *   import { audio, sceneFor, weatherMods } from './audio/audio-bridge.js';
 *   audio.configure({ bus, store, getRace, getBib });     // optional, any time
 *   audio.bindControls(document.querySelector('.rs-hud')); // [data-rs-sound] [data-rs-cc] [data-rs-meter]
 *   enterBtn.onclick = () => audio.enable({ entry: true }); // "Mit Ton eintreten"
 *   audio.enable({ entry: 'countdown' }); audio.entryLights({ skipped }); // entry moment (integration, see ENTRY)
 *   audio.wall(); audio.hover('b18'); audio.unhover(); audio.dwell(bib);
 *   audio.pins([-0.3, 0.3]); audio.land(); audio.open('be', { weather }); audio.close();
 *   audio.result({ win: true }); const ctl = audio.replay(powerFile, { speed: 120 });
 *   audio.moment({ type: 'climb' }, { scene: 'es' }); audio.duck(true);
 */
import { captions } from './captions.js';

export { captions };

const FLAG_KEY = 'tj-rs-sound';     // shared with the engine (spec 1.1)
const DWELL_KEY = 'rs-dwell';       // sessionStorage: dwell cues already played
const DWELL_MS = 900;
export const SCENE_IDS = ['wall', 'be', 'nl', 'lu', 'fr', 'de', 'es', 'it', 'gr', 'ch', 'hr', 'si', 'hu', 'ru', 'kr', 'th', 'uk', 'mtb', 'tt'];
const COUNTRY_SCENE = { BE: 'be', NL: 'nl', LU: 'lu', FR: 'fr', DE: 'de', AT: 'de', ES: 'es', IT: 'it', GR: 'gr', CH: 'ch', HR: 'hr', SI: 'si', HU: 'hu', RU: 'ru', KR: 'kr', TH: 'th', GB: 'uk', UK: 'uk' };
const SPEAKER_LANG = { be: 'nl', nl: 'nl', lu: 'lu', fr: 'fr', de: 'de', es: 'es', it: 'it', gr: 'gr', ch: 'de', uk: 'en', wall: 'de', mtb: 'de', tt: 'de' };
// sounds that are UI texture, never captioned (S4 hover, S9 land, S19 close)
const UI_SOUNDS = new Set(['whoosh', 'paper', 'pin', 'shift', 'freewheel', 'hover', 'clack']);
const SILENT_LABELS = new Set(['land', 'close']);
// voice lines the bridge plays itself (known without the manifest, for the no-sound path)
const STING_VOICES = ['vo_de_achtung', 'vo_nl_opgelet', 'vo_fr_radiotour', 'vo_fr_radiotour_f', 'vo_es_vamos'];
const LAST_LAP = { be: ['vo_nl_laatste', 'De laatste ronde!', 'nl'], nl: ['vo_nl_laatste', 'De laatste ronde!', 'nl'], de: ['vo_de_letzte', 'Letzte Runde!', 'de'] };

const HAS_WIN = typeof window !== 'undefined';
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const validScene = (s) => SCENE_IDS.indexOf(s) >= 0;

// Entry moment (integration): after "Mit Ton eintreten" the room goes dark, the start clock counts down (three short
// beeps from 0.4 s, 0.5 s apart, one long at 1.9 s), and at 2.5 s the page switches the lamp on: entryLights() plays the
// switch clack, starts the wall bed and lets the bunch pass 0.2 s later. Seconds after the click.
const ENTRY = { beeps: 0.4, lights: 2.5, bunch: 0.2 };

const st = {
  on: false, engine: null, loading: null, ctx: null, clipCaps: new Map(),
  wallMods: null, openScene: null, openMods: null, openLive: null, ducked: false, entry: null,
  dwellTimer: 0, dwellFr: false, dwellBe: new Set(), preloaded: new Set(),
  pending: new Map(), cueFns: [], timers: new Set(),
  cfg: { bus: null, store: null, getRace: null, getBib: null, manifestUrl: null },
  ui: { sound: [], cc: [], meter: [] }, meterRaf: 0, meterLast: 0, armed: false,
};

// ---------------------------------------------------------------- storage helpers
function readFlag() { try { return window.localStorage.getItem(FLAG_KEY); } catch (e) { return null; } }
function writeFlag(on) { try { window.localStorage.setItem(FLAG_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ } }
function readDwell() {
  try { const v = JSON.parse(window.sessionStorage.getItem(DWELL_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}
function writeDwell() {
  try { window.sessionStorage.setItem(DWELL_KEY, JSON.stringify({ be: Array.from(st.dwellBe), fr: st.dwellFr })); } catch (e) { /* ignore */ }
}
(function restoreDwell() { const d = readDwell(); if (Array.isArray(d.be)) d.be.forEach((id) => st.dwellBe.add(String(id))); st.dwellFr = !!d.fr; })();

function manifestUrl() {
  return st.cfg.manifestUrl || new URL('../../audio/manifest.json', import.meta.url).href;
}

// ---------------------------------------------------------------- scene mapping
/**
 * Audio scene for a race, a bib, or an id (spec 3.11). Rules in order: prologue (stage 0) -> tt;
 * kind MTB (marathon, 24 h) -> mtb; time trial -> tt; race.scene if set; country; else 'wall'.
 * Bibs use their race (via getRace) or their sceneHint (unassigned bibs, from the sponsor language).
 * @param {object|string} x race, bib, raceId or bibId
 * @param {{stage?:number, getRace?:Function, getBib?:Function}} [o]
 */
export function sceneFor(x, o) {
  o = o || {};
  const getRace = o.getRace || st.cfg.getRace, getBib = o.getBib || st.cfg.getBib;
  if (!x) return 'wall';
  if (typeof x === 'string') {
    if (validScene(x)) return x;
    const r = getRace ? safe(() => getRace(x)) : null;
    if (r) return sceneFor(r, o);
    const b = getBib ? safe(() => getBib(x)) : null;
    return b ? sceneFor(b, o) : 'wall';
  }
  const isBib = x.poly != null || x.sceneHint !== undefined || x.raceId !== undefined || /^b\d+$/.test(x.id || '');
  if (isBib) {
    const r = x.raceId && getRace ? safe(() => getRace(x.raceId)) : null;
    if (r) return sceneFor(r, o);
    return validScene(x.sceneHint) ? x.sceneHint : 'wall';
  }
  if (o.stage === 0) return 'tt';
  const kind = String(x.kind || '');
  if (kind === 'mtb_marathon' || kind === 'mtb_24h' || kind.indexOf('mtb') === 0) return 'mtb';
  if (kind === 'time_trial') return 'tt';
  if (validScene(x.scene)) return x.scene;
  return COUNTRY_SCENE[String(x.country || '').toUpperCase()] || 'wall';
}
function safe(fn) { try { return fn(); } catch (e) { return null; } }

/**
 * Weather modifiers for a race day (S11): rain 0.6 if precipitation > 0.5 mm/h in the race hours,
 * wind 1.5 if wind > 30 km/h in the race hours. Accepts a weather file (spec 4.5) or ready mods.
 * @returns {{rain?:number, wind?:number}|null}
 */
export function weatherMods(w, o) {
  o = o || {};
  if (!w || typeof w !== 'object') return null;
  if (!w.days && (w.rain != null || w.wind != null)) {
    const m = {};
    if (+w.rain > 0) m.rain = +w.rain;
    if (+w.wind > 0) m.wind = +w.wind;
    return m.rain || m.wind ? m : null;
  }
  const days = Array.isArray(w.days) ? w.days : [];
  const day = days.find((d) => o.stage != null && d.stage === o.stage) || days.find((d) => o.date && d.date === o.date) || days[0];
  if (!day) return null;
  const hr = (s) => { const m = /(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] + +m[2] / 60 : null; };
  const rh = Array.isArray(day.raceHours) && day.raceHours.length === 2 ? day.raceHours : ['10:00', '18:00'];
  const a = hr(rh[0]), b = hr(rh[1]);
  let precip = 0, wind = 0;
  for (const h of day.hours || []) {
    const t = hr(String(h.t || '').split('T')[1]);
    if (t == null || (a != null && t < a) || (b != null && t > b)) continue;
    precip = Math.max(precip, +h.precip || 0);
    wind = Math.max(wind, +h.wind || 0);
  }
  const m = {};
  if (precip > 0.5) m.rain = 0.6;
  if (wind > 30) m.wind = 1.5;
  return m.rain || m.wind ? m : null;
}

// ---------------------------------------------------------------- captions from cues
function later(fn, sec) {
  if (!(sec > 0.02)) { fn(); return; }
  const id = setTimeout(() => { st.timers.delete(id); fn(); }, sec * 1000);
  st.timers.add(id);
}
function pushCap(id, t, level, delaySec) {
  if (!t) return;
  later(() => {
    if (id === 'entry.clock' && !(st.entry && !st.entry.lit)) return;   // the countdown was skipped before it sounded
    captions.push({ id, text: { de: t.de, en: t.en }, level, quote: t.quote, lang: t.lang });
  }, delaySec || 0);
}

/** Caption for a scene's open sting; the voice line that really played is quoted. */
function stingText(scene, clipId) {
  const v = clipId ? st.clipCaps.get(clipId) : null;
  const q = v && v.quote ? { q: v.quote, lang: v.lang } : null;
  switch (scene) {
    case 'be': return captions.text('scene.be');
    case 'fr': return q ? captions.text('scene.fr', q) : captions.text('scene.fr.noq');
    case 'de': return q ? captions.text('scene.de', q) : captions.text('scene.de.noq');
    case 'nl': return q ? captions.text('scene.nl', q) : captions.text('scene.nl.noq');
    case 'es': return q ? captions.text('scene.es', q) : captions.text('scene.es.noq');
    case 'lu': return captions.text('scene.lu');
    case 'ch': return captions.text('scene.ch');
    case 'mtb': return captions.text('scene.mtb');
    case 'tt': return captions.text('scene.tt');
    case 'wall': return null;
    default: return captions.text('scene.other');
  }
}

/** Map one engine cue to { id, text, level } or null (UI texture). Exported for QA. */
export function captionForCue(c) {
  if (!c) return null;
  if (c.cue) {
    const p = st.pending.get(c.cue);
    if (p) return { id: c.cue, text: p.text, level: p.level };
    if (SILENT_LABELS.has(c.cue)) return null;
  }
  if (UI_SOUNDS.has(c.name)) return null;
  if (c.tag === 'sting') {
    if (c.name === 'peloton') return { id: 'scene.bunch', text: captions.text('scene.bunch'), level: 'scene' };
    const t = stingText(c.scene, c.clipId);
    return t ? { id: 'scene.' + c.scene, text: t, level: 'scene' } : null;
  }
  let t = (c.clipId && st.clipCaps.get(c.clipId)) || captions.text('ev.' + c.name);
  if (!t) return null;
  if (!c.scene || c.scene === 'wall') t = captions.far(t);
  return { id: 'ev.' + (c.clipId || c.name), text: t, level: 'ambient' };
}

function onCue(c) {
  const cap = captionForCue(c);
  for (const f of st.cueFns.slice()) { try { f(c, cap); } catch (e) { /* ignore */ } }
  if (cap) pushCap(cap.id, cap.text, cap.level, c.delaySec);
}

const live = () => !!(st.on && st.engine);

/**
 * One cue of the sheet: with sound, run the engine calls (their oncue raises the caption);
 * without sound but with captions visible, show the caption that describes it.
 */
function cue(label, level, text, delaySec, run) {
  if (live()) {
    st.pending.set(label, { text, level });
    if (run) { try { run(label, st.engine); } catch (e) { /* ignore */ } }
  } else if (captions.visible()) pushCap(label, text, level, delaySec);
}

// ---------------------------------------------------------------- entry moment (integration)
/** The start clock: one buffer (3 short beeps, 1 long); joined late, it starts inside the buffer. */
function startCountdown(eng, ent) {
  const el = (now() - ent.t0) / 1000;
  const late = el - ENTRY.beeps;
  if (late < 1.9) {
    const d = Math.max(0, -late);
    cue('entry.clock', 'scene', captions.text('entry.clock'), d, (l, e) => {
      ent.handles.push(e.play('tt-countdown', { when: d, offset: Math.max(0, late), gainDb: -9, cue: l }));
    });
  }
  // the page switches the lamp on at ENTRY.lights; if it never does, start the bed anyway
  ent.timer = setTimeout(() => audio.entryLights({ skipped: false }), Math.max(0, ENTRY.lights + 1.5 - el) * 1000);
}
/** Wall bed, and the open dossier's scene if the engine has not played it yet. */
function bedAndOpen(eng) {
  eng.ambience('wall', st.wallMods);
  if (st.openScene && st.openLive !== st.openScene) { eng.open(st.openScene, st.openMods); st.openLive = st.openScene; }
}
/** The clack right at the lamp, the bunch 0.2 s later (not when skipped or when a dossier is already open). */
function entryExtras(eng, ent) {
  const since = (now() - ent.litAt) / 1000;
  if (since < 0.3) eng.play('clack', { gainDb: -6, cue: 'clack' });
  if (!ent.skipped && !st.openScene && since < 1.2) {
    const d = Math.max(0, ENTRY.bunch - since);
    cue('entry', 'scene', captions.text('entry'), d, (l, e) => e.play('peloton', { when: d, doppler: true, dist: 2, dir: 1, dur: 4.2, cue: l }));
  }
  if (st.entry === ent) st.entry = null;
}
function stopEntry() {
  const ent = st.entry;
  if (!ent) return;
  clearTimeout(ent.timer);
  for (const h of ent.handles) { try { h.stop(0.05); } catch (e) { /* gone */ } }
  st.entry = null;
}

// ---------------------------------------------------------------- engine loading (opt-in only)
function unlockContext() {
  if (!HAS_WIN) return;
  if (st.engine) { st.engine.setEnabled(true); return; }   // engine resumes its context in the gesture
  if (st.ctx) { try { st.ctx.resume(); } catch (e) { /* ignore */ } return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try { st.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { st.ctx = new AC(); } catch (e2) { st.ctx = null; return; } }
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
  try { const p = st.ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  // iOS unlock: one silent sample inside the gesture
  try { const b = st.ctx.createBuffer(1, 1, 22050), s = st.ctx.createBufferSource(); s.buffer = b; s.connect(st.ctx.destination); s.start(0); } catch (e) { /* ignore */ }
}

function loadEngine() {
  if (st.engine) return Promise.resolve(st.engine);
  if (!st.loading) {
    const url = manifestUrl();
    st.loading = Promise.all([
      import('./audio-engine.js'),
      fetch(url).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([mod, list]) => {
      list = Array.isArray(list) ? list : [];
      for (const e of list) if (e && e.id && e.caption) st.clipCaps.set(e.id, e.caption);
      const eng = new mod.RaceAudio({ context: st.ctx, volume: 0.8 });
      st.ctx = null;
      eng.oncue(onCue);
      return eng.init(url, list).then(() => { st.engine = eng; return eng; });
    }).catch(() => { st.loading = null; return null; });
  }
  return st.loading;
}

// ---------------------------------------------------------------- UI: buttons and meter
function syncUi() {
  for (const b of st.ui.sound) { b.setAttribute('aria-pressed', st.on ? 'true' : 'false'); b.classList.toggle('is-on', st.on); }
  const cv = captions.visible();
  for (const b of st.ui.cc) { b.setAttribute('aria-pressed', cv ? 'true' : 'false'); b.classList.toggle('is-on', cv); b.setAttribute('data-mode', captions.mode()); }
  for (const m of st.ui.meter) m.classList.toggle('is-on', st.on);
}
function reducedMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
function meterLevel(rms) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -120;
  return db > -18 ? 4 : db > -28 ? 3 : db > -38 ? 2 : db > -50 ? 1 : 0;
}
function meterFrame(t) {
  st.meterRaf = 0;
  if (!st.on || st.ducked || !st.ui.meter.length) { setMeter(0); return; }
  if (t - st.meterLast > 66) {           // about 15 updates per second
    st.meterLast = t;
    setMeter(reducedMotion() ? 2 : meterLevel(st.engine ? st.engine.level() : 0));
  }
  st.meterRaf = requestAnimationFrame(meterFrame);
}
function setMeter(n) { for (const m of st.ui.meter) if (m.getAttribute('data-level') !== String(n)) m.setAttribute('data-level', String(n)); }
function startMeter() { if (!st.meterRaf && st.ui.meter.length && HAS_WIN && window.requestAnimationFrame) st.meterRaf = requestAnimationFrame(meterFrame); }
function stopMeter() { if (st.meterRaf) cancelAnimationFrame(st.meterRaf); st.meterRaf = 0; setMeter(0); }

function announce() {
  const { bus, store } = st.cfg;
  try { if (store && store.set) store.set({ sound: st.on }); } catch (e) { /* ignore */ }
  try { if (bus && bus.emit) bus.emit('sound:change', { on: st.on }); } catch (e) { /* ignore */ }
}

// returning visitors: arm on the first gesture (spec 1.1); controls that decide themselves are skipped
const GESTURES = ['pointerdown', 'keydown', 'touchend'];
const SELF_DECIDING = '[data-rs-sound],[data-rs-enter],[data-rs-quiet]';
function onArmGesture(ev) {
  if (ev.type === 'keydown' && (ev.key === 'Escape' || ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta')) return;
  const t = ev.target;
  if (t && t.closest && t.closest(SELF_DECIDING)) { disarm(); return; }
  disarm();
  if (readFlag() === 'on' && !st.on) audio.enable();
}
function arm() { if (st.armed || !HAS_WIN) return; st.armed = true; for (const e of GESTURES) window.addEventListener(e, onArmGesture, true); }
function disarm() { if (!st.armed) return; st.armed = false; for (const e of GESTURES) window.removeEventListener(e, onArmGesture, true); }

// ---------------------------------------------------------------- replay without the engine
/** Same controller API as the engine's replay (progress runs, no audio). */
function silentReplay(series, o) {
  const t = (series.t || []).map((v, i) => (Number.isFinite(+v) && v !== null ? +v : i));
  const n = t.length, prog = [], ends = [], S = { w: series.w || [], cad: series.cad || [], kph: series.kph || [] };
  const t0 = n ? t[0] : 0, t1 = n ? t[n - 1] : 0, p = { fraction: 0, index: 0, t: 0, w: 0, cad: 0, kph: 0 };
  let speed = Math.max(0.1, (o && o.speed) || 60), base = t0, clock0 = now(), last = clock0, i = 0, done = false, paused = false, h = 0;
  const num = (a, k) => { const v = a[k]; return v == null || !Number.isFinite(+v) ? 0 : +v; };
  const td = (tm) => (paused ? base : base + ((tm - clock0) / 1000) * speed);
  const sample = (x) => {
    if (t[i] > x) i = 0;
    while (i < n - 2 && t[i + 1] <= x) i++;
    const a = t[i], b = t[i + 1], u = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 0;
    p.index = i; p.t = x; p.fraction = (x - t0) / Math.max(1e-9, t1 - t0);
    const lerp = (arr) => num(arr, i) + (num(arr, i + 1) - num(arr, i)) * u;
    p.w = lerp(S.w); p.cad = lerp(S.cad); p.kph = lerp(S.kph);
  };
  const emit = () => { for (const f of prog) { try { f(p); } catch (e) { /* ignore */ } } };
  const cancel = () => { if (h) cancelAnimationFrame(h); h = 0; };
  const finish = (completed) => { if (done) return; done = true; cancel(); for (const f of ends) { try { f({ completed }); } catch (e) { /* ignore */ } } };
  const frame = () => {
    h = 0;
    if (done || paused) return;
    const tm = now();
    if (tm - last > 250) clock0 += tm - last - 16;   // hidden tab: pause the clock
    last = tm;
    const x = td(tm);
    if (x >= t1) { sample(t1); emit(); finish(true); return; }
    sample(x); emit();
    h = requestAnimationFrame(frame);
  };
  const api = {
    stop: () => finish(false),
    onprogress: (cb) => { if (typeof cb === 'function') prog.push(cb); return api; },
    onend: (cb) => { if (typeof cb === 'function') ends.push(cb); return api; },
    seek: (f) => { base = t0 + Math.min(1, Math.max(0, +f || 0)) * (t1 - t0); clock0 = now(); i = 0; if (paused && n >= 2) { sample(base); emit(); } },
    pause: () => { if (done || paused) return; base = td(now()); paused = true; cancel(); },
    resume: () => { if (done || !paused) return; paused = false; clock0 = now(); last = clock0; h = requestAnimationFrame(frame); },
    setSpeed: (x) => { const tm = now(); base = td(tm); clock0 = tm; speed = Math.max(0.1, +x || speed); },
    isPaused: () => paused,
    state: () => ({ playing: !done && !paused, paused, done, speed, fraction: p.fraction, t: p.t }),
  };
  if (n < 2) setTimeout(() => finish(true), 0); else h = requestAnimationFrame(frame);
  return api;
}
function toSeries(x) {
  const d = x && x.data ? x.data : x || {};
  return { t: d.t || [], w: d.w || [], cad: d.cad || [], kph: d.kph || [] };
}

// ---------------------------------------------------------------- public API
export const audio = {
  /** Optional wiring: { bus, store, getRace, getBib, manifestUrl }. Never loads anything. */
  configure(cfg) {
    Object.assign(st.cfg, cfg || {});
    if (!st.cfg._capsHooked) {
      st.cfg._capsHooked = true;
      captions.onShow((c) => { const b = st.cfg.bus; try { if (b && b.emit) b.emit('caption', c); } catch (e) { /* ignore */ } });
      captions.onChange((c) => { const s = st.cfg.store; try { if (s && s.set) s.set({ captions: c.mode }); } catch (e) { /* ignore */ } syncUi(); });
    }
    if (readFlag() === 'on' && !st.on) arm();
    return audio;
  },

  /** 'on' | 'off' | null: what the visitor chose on an earlier visit. */
  stored() { const v = readFlag(); return v === 'on' || v === 'off' ? v : null; },

  /**
   * Turn sound on. Call synchronously inside a click / tap / key handler: the AudioContext is
   * created and unlocked in the gesture, then the engine and the manifest load (dynamic import).
   * @param {{entry?:boolean}} [o] entry: the bunch passes 1.4 s after the click (S2)
   * @returns {Promise<boolean>}
   */
  enable(o) {
    o = o || {};
    const t0 = now();
    disarm();
    const wasOn = st.on;
    st.on = true; writeFlag(true);
    captions.setSound(true);
    unlockContext();
    syncUi();
    if (!wasOn) announce();
    if (o.entry === 'countdown') st.entry = { t0: Number.isFinite(o.t0) ? o.t0 : t0, lit: false, litAt: 0, skipped: false, handles: [], timer: 0 };
    const ent = o.entry === 'countdown' ? st.entry : null;
    return loadEngine().then((eng) => {
      if (!eng || !st.on) return false;
      eng.setEnabled(true);
      eng.setDucked(st.ducked);
      if (ent && st.entry === ent && !ent.lit) startCountdown(eng, ent);      // the bed waits for the lamp
      else {
        bedAndOpen(eng);
        if (ent && st.entry === ent) entryExtras(eng, ent);                    // the lamp came on while the engine loaded
        else {
          if (!wasOn || o.announce) cue('sound.on', 'minor', captions.text('sound.on'), 0, (l, e) => e.play('whistle_pea', { gainDb: -10, cue: l }));
          if (o.entry === true) {
            const d = Math.max(0, 1.4 - (now() - t0) / 1000);
            cue('entry', 'scene', captions.text('entry'), d, (l, e) => e.play('peloton', { when: d, doppler: true, dist: 2, dir: 1, dur: 4.2, cue: l }));
          }
        }
      }
      startMeter();
      // a replay that started silent (sound came on while it ran) restarts on this second event, now with the engine
      try { if (st.cfg.bus && st.cfg.bus.emit) st.cfg.bus.emit('sound:change', { on: true, ready: true }); } catch (e) { /* ignore */ }
      // the lines the open stings quote (about 80 KB), so a first open from the list speaks them too
      later(() => { if (st.on && st.engine) st.engine.preload(STING_VOICES); }, 1.5);
      return true;
    });
  },

  /** Turn sound off (persisted). Captions in 'auto' mode hide with it. */
  disable() {
    disarm();
    const was = st.on;
    st.on = false; writeFlag(false);
    clearTimeout(st.dwellTimer);
    stopEntry();
    for (const id of st.timers) clearTimeout(id);
    st.timers.clear();
    if (st.engine) st.engine.setEnabled(false);
    captions.setSound(false);
    stopMeter(); syncUi();
    if (was) announce();
  },

  isOn() { return st.on; },

  /**
   * Entry moment: the page switched the lamp on (after the countdown, or at once when the visitor skipped it).
   * Plays the switch clack, starts the wall bed and, unless skipped, lets the bunch pass (S2).
   * @param {{skipped?:boolean}} [o]
   */
  entryLights(o) {
    o = o || {};
    const ent = st.entry;
    if (!ent || ent.lit) return;
    ent.lit = true; ent.litAt = now(); ent.skipped = !!o.skipped;
    clearTimeout(ent.timer);
    if (ent.skipped) {
      for (const h of ent.handles) { try { h.stop(0.04); } catch (e) { /* gone */ } }
      const c = captions.current();
      if (c && c.id === 'entry.clock') captions.clear();                // the clock stopped: its caption goes too
      st.pending.delete('entry.clock');
    }
    if (live()) { bedAndOpen(st.engine); entryExtras(st.engine, ent); }
  },

  /** S3: the room is visible; wall bed with optional mods ({ wind, rain, crowd }). */
  wall(mods) {
    st.wallMods = mods || null;
    if (live() && !st.openScene && !(st.entry && !st.entry.lit)) st.engine.ambience('wall', st.wallMods);   // not during the countdown
  },

  /** S4: pointer or focus enters a bib. Starts the 0.9 s dwell timer and prefetches the scene's sting clips. */
  hover(bibId, o) {
    o = o || {};
    clearTimeout(st.dwellTimer);
    if (live()) st.engine.hover(bibId);
    const scene = o.scene || sceneFor(o.bib || bibId);
    if (live() && !st.preloaded.has(scene)) { st.preloaded.add(scene); st.engine.preload(scene); }
    if (o.dwell !== false) st.dwellTimer = setTimeout(() => audio.dwell(o.bib || bibId, { scene }), DWELL_MS);
  },
  unhover() { clearTimeout(st.dwellTimer); if (live()) st.engine.unhover(); },

  /** S5 / S6: dwelling on a Belgian bib (once per bib per session) or a French bib (once per session). */
  dwell(bib, o) {
    o = o || {};
    const id = String(bib && bib.id ? bib.id : bib);
    const scene = o.scene || sceneFor(bib);
    if (!live() && !captions.visible()) return false;   // keep the once-per-session cue for later
    if (scene === 'be') {
      if (st.dwellBe.has(id)) return false;
      st.dwellBe.add(id); writeDwell();
      cue('dwell.be', 'minor', captions.text('dwell.be'), 0, (l, e) => e.play('rodania_trumpet_motif_pa', { gainDb: -14, dist: 3, cue: l }));
      return true;
    }
    if (scene === 'fr') {
      if (st.dwellFr) return false;
      st.dwellFr = true; writeDwell();
      cue('dwell.fr', 'minor', captions.text('dwell.fr'), 0, (l, e) => e.play('horn_warble_multitone', { gainDb: -16, dist: 3, cue: l }));
      return true;
    }
    return false;
  },

  /** S7: pins pop on click. pinsWithPan: numbers (pan -1..1) or { pan }; at most 4, 62 ms apart. */
  pins(pinsWithPan) {
    clearTimeout(st.dwellTimer);
    const list = (Array.isArray(pinsWithPan) && pinsWithPan.length ? pinsWithPan : [-0.3, -0.1, 0.1, 0.3]).slice(0, 4);
    cue('pins', 'minor', captions.text('pins'), 0, (l, e) => list.forEach((p, i) => e.play('pin', { pan: typeof p === 'number' ? p : +(p && p.pan) || 0, when: i * 0.062, gainDb: -4, seed: i, cue: l })));
  },

  /** S9: the number lands in the dossier (no caption). */
  land() { if (live()) st.engine.play('paper', { gainDb: -12, cue: 'land' }); },

  /**
   * S8 + S11: a dossier opens. scene: id, race or bib. weather: weather file (4.5), mods, or a
   * Promise of either (applied when it resolves).
   */
  open(scene, o) {
    o = o || {};
    const id = typeof scene === 'string' && validScene(scene) ? scene : sceneFor(scene, o);
    const tOpen = now();
    clearTimeout(st.dwellTimer);
    const w = o.weather;
    const isPromise = w && typeof w.then === 'function';
    const mods = isPromise ? null : weatherMods(w, o);
    st.openScene = id; st.openMods = mods;
    if (live()) { st.engine.open(id, mods); st.openLive = id; }
    else if (captions.visible()) {
      // no-sound parity: describe the sting with its intended line
      const t = id === 'wall' ? null : captions.text('scene.' + id) || stingText(id, null);
      pushCap('scene.' + id, t, 'scene', 0.05);
      if (id !== 'mtb' && id !== 'tt' && id !== 'wall') pushCap('scene.bunch', captions.text('scene.bunch'), 'scene', 3.5);
    }
    const wDelay = id === 'mtb' || id === 'tt' || id === 'wall' ? 2.6 : 6.2;   // after the sting and the bunch
    weatherCaptions(mods, wDelay);
    if (isPromise) {
      w.then((res) => {
        if (st.openScene !== id) return;
        const m = weatherMods(res, o);
        if (!m) return;
        st.openMods = m;
        if (live()) st.engine.setMods(m);
        weatherCaptions(m, Math.max(0.3, wDelay - (now() - tOpen) / 1000));
      }, () => {});
    }
    return id;
  },

  /** S19: the dossier closes; back to the wall bed. */
  close() {
    clearTimeout(st.dwellTimer);
    st.openScene = null; st.openMods = null; st.openLive = null;
    if (live()) { st.engine.close(); st.engine.ambience('wall', st.wallMods); }
  },

  /** S10: photo-finish reveal; verified wins get the bell and cheering. */
  result(o) {
    o = o || {};
    const scene = st.openScene || 'wall';
    if (o.win) {
      cue('result.win', 'event', captions.text('result.win'), 0, (l, e) => {
        e.play('tt-clock', { offset: 5.0, gainDb: -8, cue: l });
        e.play('bell', { when: 0.6, scene, cue: l });
        e.play('crowd_cheer_applause', { when: 1.5, gainDb: -4, cue: l });
      });
    } else cue('result', 'event', captions.text('result'), 0, (l, e) => e.play('tt-clock', { offset: 5.0, gainDb: -8, cue: l }));
  },

  /**
   * S12 + S18: sonified replay. series: power file (4.4) or { t, w, cad, kph }. Returns the
   * controller { stop, seek, onprogress, onend, pause, resume, setSpeed, isPaused, state };
   * progress runs with sound off too. o.finish === false (DNF) skips the finish cheer.
   */
  replay(series, o) {
    o = o || {};
    const s = toSeries(series);
    const ctl = st.engine ? st.engine.replay(s, { speed: o.speed }) : silentReplay(s, { speed: o.speed });
    if (live() || captions.visible()) pushCap('replay', captions.text('replay'), 'scene', 0);
    const scene = o.scene || st.openScene || 'wall';
    ctl.onend((e) => {
      if (!e || !e.completed || o.finish === false) return;
      cue('replay.end', 'event', captions.text('replay.end'), 0, (l, eng) => eng.play('cheer', { scene, cue: l }));
    });
    return ctl;
  },

  /** S13 to S17: a replay moment ({ type: climb | attack | descent | bell | sprint | finale }). */
  moment(m, o) {
    o = o || {};
    const type = m && m.type;
    const scene = o.scene || st.openScene || 'wall';
    if (type === 'climb') {
      cue('moment.climb', 'event', captions.text('moment.climb'), 0, (l, e) => {
        e.play('cowbells', { scene, cue: l });
        if (['es', 'it', 'ch', 'gr'].indexOf(scene) >= 0) e.play('amb_cowbells_climb', { dur: 8, gainDb: -6, cue: l });
      });
    } else if (type === 'attack') {
      cue('moment.attack', 'event', captions.text('moment.attack'), 0, (l, e) => { e.play('motorbike', { scene, dist: 1.5, cue: l }); e.play('whoosh', { when: 1.2, dist: 1, gainDb: -4 }); });
    } else if (type === 'descent') {
      cue('moment.descent', 'event', captions.text('moment.descent'), 0, (l, e) => e.play('wind', { gainDb: -6, cue: l }));
    } else if (type === 'bell') {
      const v = LAST_LAP[scene];
      const t = v ? captions.text('moment.bell.q', { q: v[1], lang: v[2] }) : captions.text('moment.bell');
      cue('moment.bell', 'event', t, 0, (l, e) => { e.play('bell_last_lap', { cue: l }); if (v) e.play(v[0], { when: 1.0, cue: l }); });
    } else if (type === 'sprint' || type === 'finale') {
      cue('moment.sprint', 'event', captions.text('moment.sprint'), 0, (l, e) => { e.play('crowd', { scene, cue: l }); e.play('speaker', { lang: SPEAKER_LANG[scene] || 'de', scene, when: 0.6, cue: l }); });
    }
  },

  /** S20: the room left the viewport (true) or came back (false). */
  duck(on) {
    st.ducked = !!on;
    if (st.engine) st.engine.setDucked(st.ducked);
    if (st.ducked) stopMeter(); else if (st.on) startMeter();
  },

  /**
   * HUD wiring (behaviour here, markup from WP3): buttons [data-rs-sound] toggle sound,
   * [data-rs-cc] toggle captions, [data-rs-meter] gets data-level 0..4 (4 bars).
   * Pass a root element or { sound, cc, meter } (elements or arrays).
   */
  bindControls(root) {
    const arr = (x) => (x ? (Array.isArray(x) ? x : x.length != null && !x.nodeType ? Array.from(x) : [x]) : []);
    let sound, cc, meter;
    if (root && root.nodeType) { sound = root.querySelectorAll('[data-rs-sound]'); cc = root.querySelectorAll('[data-rs-cc]'); meter = root.querySelectorAll('[data-rs-meter]'); }
    else { sound = root && root.sound; cc = root && root.cc; meter = root && root.meter; }
    for (const b of arr(sound)) {
      if (st.ui.sound.indexOf(b) >= 0) continue;
      st.ui.sound.push(b);
      b.addEventListener('click', () => { if (st.on) audio.disable(); else audio.enable(); });
    }
    for (const b of arr(cc)) {
      if (st.ui.cc.indexOf(b) >= 0) continue;
      st.ui.cc.push(b);
      b.addEventListener('click', () => { captions.toggle(); syncUi(); });
    }
    for (const m of arr(meter)) {
      if (st.ui.meter.indexOf(m) >= 0) continue;
      st.ui.meter.push(m); m.setAttribute('aria-hidden', 'true'); m.setAttribute('data-level', '0');
      while (m.children.length < 4) m.appendChild(document.createElement('i'));
    }
    syncUi();
    if (st.on) startMeter();
    return audio;
  },

  /** QA / dev: observe every engine cue with the caption it mapped to. fn(cue, caption|null) */
  oncue(fn) { if (typeof fn === 'function') st.cueFns.push(fn); return () => { const i = st.cueFns.indexOf(fn); if (i >= 0) st.cueFns.splice(i, 1); }; },
  /** QA / dev: the engine (null before opt-in). */
  engine() { return st.engine; },
  stats() { return Object.assign({ on: st.on, loaded: !!st.engine, openScene: st.openScene, ducked: st.ducked, captions: captions.mode() }, st.engine ? { engine: st.engine.stats() } : {}); },
};

// ---------------------------------------------------------------- weather captions (S11)
function weatherCaptions(m, delay) {
  if (!m) return;
  if (!live() && !captions.visible()) return;
  const scene = st.openScene;
  // the rain / wind layer sounds for the whole dossier; caption it once the sting has passed
  const push = (id) => later(() => { if (st.openScene === scene) captions.push({ id, text: captions.text(id), level: 'minor' }); }, delay || 0);
  if (m.rain) push('weather.rain');
  if (m.wind) push('weather.wind');
}

// ---------------------------------------------------------------- credits block (Quellen und Klang)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/**
 * HTML for the audio and weather credits from radsport/audio/credits.json (for render_static.py
 * or a runtime render). lang 'de' | 'en'.
 */
export function creditsHTML(credits, lang) {
  if (!credits) return '';
  const L = (o) => (o && typeof o === 'object' ? (o[lang] != null ? o[lang] : o.de) : o);
  const items = ((credits.ccby && credits.ccby.items) || []).map((it) =>
    '<li>' + (lang === 'en' ? '"' + esc(it.title) + '" by ' : '„' + esc(it.title) + '“ von ') + esc(it.author) + ', <a href="' + esc(it.url) + '" rel="noopener">' + esc(it.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a>, ' +
    '<a href="' + esc(credits.ccby.licenseUrl) + '" rel="noopener license">' + esc(it.license) + '</a>, ' + esc(L(it.changes)) + '</li>').join('');
  const cc0 = credits.cc0 && credits.cc0.authors ? '<p>' + esc(L(credits.cc0.title)) + ': ' + credits.cc0.authors.map(esc).join(', ') + '.</p>' : '';
  return '<div class="rs-credits-audio">' +
    '<p>' + esc(L(credits.intro)) + '</p>' +
    '<h3>' + esc(L(credits.ccby.title)) + '</h3><ul>' + items + '</ul>' + cc0 +
    '<p>' + esc(L(credits.voices)) + '</p>' +
    '<p>' + esc(L(credits.own)) + '</p>' +
    (credits.weather ? '<p>' + esc(L(credits.weather)) + '</p>' : '') +
    '</div>';
}

export default audio;
