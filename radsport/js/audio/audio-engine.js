/**
 * @file audio-engine.js
 * Web Audio engine for the race-bib page ("Startnummern") on tjansn.com v3.
 *
 * Vanilla ES module, no dependencies. The only network access is the optional
 * same-origin clip manifest and the clips it lists. Every sound has a procedural
 * fallback, so the engine is complete without a single audio file.
 *
 * Quick start:
 *   import { RaceAudio } from './audio-engine.js';
 *   const audio = new RaceAudio();
 *   audio.init('audio/manifest.json');                 // never rejects
 *   toggle.onclick = () => audio.setEnabled(!audio.isEnabled()); // user gesture
 *   audio.ambience('wall');
 *   bib.onpointerenter = () => audio.hover(bib.dataset.id);
 *   bib.onpointerleave = () => audio.unhover();
 *   bib.onclick = () => audio.open('be');  // dialog close: audio.close()
 *   const ctl = audio.replay({ t, w, cad, kph }, { speed: 60 });
 *   ctl.onprogress((p) => drawCursor(p.fraction)).onend(() => resetUi());
 *
 * Signal flow:
 *   ambience ─┐
 *   sfx ──────┤
 *   voice ─ megaphone (bandpass, saturation, slap echo) ─┤
 *   replay ───┼─> mix ─> compressor ─> limiter ─> master (mute/volume) ─> out
 *   sends ─> convolver (generated IR: street / hall / forest) ─┘
 *
 * Privacy: sound is OFF until the visitor opts in. The choice is stored in
 * localStorage 'tj-rs-sound' ('on' | 'off'). No AudioContext is created before
 * the first user gesture with sound enabled.
 *
 * Vendored for radsport.html (WP8) from kb/code/audio-engine.js with these patches:
 *   - oncue(fn): every audible cue raised by _fire / _playClip reports
 *     { name, clipId, scene, delaySec, tag, cue, voice } so the page can caption it
 *     (random bed events included). clipId is the clip that sounds (for speaker /
 *     radio synths: the voice line they used), null for pure synthesis.
 *   - replay controller: pause(), resume(), setSpeed(x), isPaused(), state().
 *   - open(scene, mods): weather mods on the dossier bed; weather_rain / weather_wind
 *     clip layers when mods.rain / mods.wind > 1.
 *   - speaker / radio synths accept a voice hint (o.voice); stings use it so the
 *     line they speak is predictable (captions quote it).
 *   - new RaceAudio({ context }): adopt an AudioContext created inside the opt-in
 *     gesture (iOS unlock before the dynamic import resolves).
 *   - setDucked(on) (offscreen), level() (meter), preload(scene).
 *   - navigator.audioSession.type = 'playback' where supported (iOS mute switch).
 *   - integration: 'tt-countdown' (the entry countdown: three short beeps 0.5 s apart and one long, about 2 s,
 *     the clock's speaker timbre) and 'clack' (a lamp switch) synths.
 */

const STORAGE_KEY = 'tj-rs-sound';
const MAX_VOICES = 24;
const VSR = 24000; // sample rate for voice-like and low-band buffers
const TAU = Math.PI * 2;
const C_SOUND = 343;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dbGain = (db) => Math.pow(10, db / 20);
const noop = () => {};
const HAS_WIN = typeof window !== 'undefined';
let DEBUG = false;
const warn = (e) => { if (DEBUG && typeof console !== 'undefined') console.warn('[RaceAudio]', e); };
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function hashSeed(v) {
  const s = typeof v === 'number' && isFinite(v) ? 'n' + Math.round(v * 1000) : String(v == null ? '' : v);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rr = (r, a, b) => a + (b - a) * r();
const pick = (r, a) => a[(r() * a.length) | 0];
const expo = (r, mean) => -Math.log(1 - r() * 0.999999) * mean;

function readFlag() {
  try { return HAS_WIN && window.localStorage.getItem(STORAGE_KEY) === 'on'; } catch (e) { return false; }
}
function writeFlag(on) {
  try { if (HAS_WIN) window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
}

// ============================================================================
// 1. Offline DSP helpers (render short buffers in plain JS, deterministic)
// ============================================================================

function bqCoefs(type, f, q, sr, gainDb) {
  const w = (TAU * clamp(f, 10, sr * 0.45)) / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else { const A = Math.pow(10, (gainDb || 0) / 40); b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
/** In-place biquad over a Float32Array. */
function filt(x, type, f, q, sr, g) {
  const c = bqCoefs(type, f, q, sr, g), b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
/** Filter a loop seamlessly: run over two periods, keep the second. */
function filtLoop(x, type, f, q, sr, g) {
  const n = x.length, d = new Float32Array(n * 2);
  d.set(x); d.set(x, n); filt(d, type, f, q, sr, g);
  x.set(d.subarray(n));
  return x;
}
/** Two-pole resonator driven by x, added into y. Impulse response amplitude = amp. */
function reson(x, y, f, t60, amp, sr) {
  const w = (TAU * f) / sr;
  if (w >= Math.PI * 0.98 || amp === 0) return;
  const r = Math.exp(-6.9078 / (t60 * sr)), a1 = 2 * r * Math.cos(w), a2 = r * r, g = amp * Math.sin(w);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = g * x[i] + a1 * y1 - a2 * y2; y2 = y1; y1 = v; y[i] += v; }
}
function peakOf(chs) {
  let m = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > m) m = a; }
  return m;
}
function normalize(chs, peak) {
  const m = peakOf(chs);
  if (m > 1e-9) { const k = peak / m; for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k; }
  return chs;
}
function fadeOut(x, sec, sr) {
  const n = Math.min(x.length, Math.round(sec * sr));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
}
/** x has length L+xf: crossfade the tail into the head, return a seamless loop of length L. */
function loopify(x, xf) {
  const L = x.length - xf, y = x.slice(0, L);
  for (let i = 0; i < xf; i++) { const a = (i / xf) * Math.PI * 0.5; y[i] = x[i] * Math.sin(a) + x[L + i] * Math.cos(a); }
  return y;
}
function panInto(L, R, x, at, pan, gain) {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  for (let i = 0; i < x.length; i++) { const j = at + i; if (j >= L.length) break; if (j >= 0) { L[j] += x[i] * gl; R[j] += x[i] * gr; } }
}
function mixInto(y, x, at, gain) {
  for (let i = 0; i < x.length; i++) { const j = at + i; if (j >= y.length) break; if (j >= 0) y[j] += x[i] * gain; }
}
function noiseArr(n, r) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = r() * 2 - 1; return x; }
function softClipArr(x, drive) { const k = Math.tanh(drive); for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k; }

// ---------------------------------------------------------------------------
// 1a. Freewheel pawls, paper, clicks
// ---------------------------------------------------------------------------

/** Hub shell / rim resonances of one wheel. [freq, t60, amp] */
function hubModes(r) {
  const k = rr(r, 0.88, 1.12);
  return [[1250, 0.022, 0.35], [2700, 0.014, 1], [4150, 0.01, 0.75], [5900, 0.007, 0.55], [8200, 0.005, 0.4], [11300, 0.0035, 0.22]]
    .map((m) => [m[0] * k * rr(r, 0.97, 1.03), m[1] * rr(r, 0.8, 1.2), m[2] * rr(r, 0.8, 1.2)]);
}
function tickExcite(ex, i0, a, cl, r, n, wrap) {
  for (let j = 0; j < cl; j++) {
    let idx = i0 + j;
    if (wrap) idx %= n; else if (idx >= n) break;
    ex[idx] += a * (r() * 2 - 1) * Math.exp(-j / (cl * 0.3));
  }
}
function tickRing(ex, sr, modes) {
  const y = new Float32Array(ex.length);
  for (let m = 0; m < modes.length; m++) reson(ex, y, modes[m][0], modes[m][1], modes[m][2], sr);
  const d = Float32Array.from(ex); filt(d, 'highpass', 2800, 0.7, sr);
  for (let i = 0; i < y.length; i++) y[i] = y[i] * 0.22 + d[i] * 0.55;
  if (sr > 32000) filt(y, 'lowpass', 14500, 0.7, sr);
  return y;
}
/** One-shot pawl clicks with a time-varying click rate. */
function renderTickBurst(sr, r, dur, rateAt, ampAt, modes) {
  const n = Math.ceil((dur + 0.08) * sr), ex = new Float32Array(n);
  const cl = Math.max(6, Math.round(sr * 0.0005));
  const pawls = 2 + ((r() * 2) | 0), pg = [1, rr(r, 0.68, 0.85), rr(r, 0.8, 0.95)];
  let t = 0.004, k = 0;
  while (t < dur) {
    tickExcite(ex, Math.round(t * sr), ampAt(t) * pg[k % pawls] * rr(r, 0.8, 1), cl, r, n, false);
    k++; t += rr(r, 0.97, 1.03) / Math.max(1, rateAt(t));
  }
  return tickRing(ex, sr, modes);
}
/** Seamless loop of `count` pawl clicks at `rate` clicks/s (count multiple of 3). */
function renderTickLoop(sr, r, rate, count, modes) {
  const n = Math.round((count / rate) * sr), ex = new Float32Array(n);
  const cl = Math.max(6, Math.round(sr * 0.0005)), pg = [1, rr(r, 0.7, 0.85), rr(r, 0.82, 0.95)];
  for (let k = 0; k < count; k++) {
    const t = (k + (r() - 0.5) * 0.08) / rate;
    tickExcite(ex, ((Math.round(t * sr) % n) + n) % n, pg[k % 3] * rr(r, 0.8, 1), cl, r, n, true);
  }
  const ex2 = new Float32Array(n * 2); ex2.set(ex); ex2.set(ex, n);
  return tickRing(ex2, sr, modes).slice(n);
}
/** Crackly paper / Tyvek rustle: heavy-tailed impulse grains plus a soft swish. */
function renderRustle(sr, r, dur, inten) {
  const n = Math.ceil(dur * sr), x = new Float32Array(n), sw = new Float32Array(n);
  const nb = r() < 0.55 ? 1 : 2, bc = [], bw = [], ba = [];
  for (let b = 0; b < nb; b++) {
    bc.push(dur * (nb === 1 ? rr(r, 0.3, 0.45) : b ? rr(r, 0.62, 0.75) : rr(r, 0.2, 0.32)));
    bw.push(dur * rr(r, 0.1, 0.2)); ba.push(b ? rr(r, 0.5, 0.9) : 1);
  }
  const env = (t) => { let e = 0; for (let b = 0; b < nb; b++) { const u = (t - bc[b]) / bw[b]; e += ba[b] * Math.exp(-u * u); } return e > 1 ? 1 : e; };
  const rate = 2600 * (inten || 1);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - r() * 0.999999) / rate;
    if (t >= dur) break;
    const e = env(t);
    if (r() > e) continue;
    const i0 = (t * sr) | 0, a = e * Math.min(1, 0.012 * Math.pow(r() + 1e-4, -1.35)) * (r() < 0.5 ? -1 : 1);
    const len = 1 + ((r() * 5) | 0);
    for (let j = 0; j < len && i0 + j < n; j++) x[i0 + j] += a * (1 - j / len) * (r() * 0.6 + 0.4);
  }
  for (let i = 0; i < n; i++) { const e = env(i / sr); sw[i] = (r() * 2 - 1) * e * e; }
  filt(x, 'highpass', 1100, 0.7, sr); filt(x, 'peaking', 4800, 0.9, sr, 5);
  if (sr > 30000) filt(x, 'lowpass', 13000, 0.7, sr);
  filt(sw, 'bandpass', 2600, 0.7, sr);
  for (let i = 0; i < n; i++) x[i] += sw[i] * 0.07;
  return x;
}
/** Hover: a hand flicks the wheel (pawl ticks) and the paper bib rustles. Varies by seed. */
function renderHover(sr, seed) {
  const r = makeRng(seed * 7 + 3), modes = hubModes(r), v = seed % 3;
  let dur, rate, amp;
  if (v === 0) {
    const R = rr(r, 36, 52); dur = rr(r, 0.22, 0.3);
    rate = () => R; amp = (t) => Math.min(1, t / 0.015, (dur - t) / 0.06 + 0.15);
  } else if (v === 1) {
    const r0 = rr(r, 60, 85), k = rr(r, 3.2, 4.5); dur = rr(r, 0.45, 0.6);
    rate = (t) => Math.max(9, r0 * Math.exp(-k * t)); amp = (t) => Math.exp(-2.2 * t) * Math.min(1, t / 0.01);
  } else {
    const r0 = rr(r, 90, 120); dur = rr(r, 0.3, 0.38);
    rate = (t) => Math.max(20, r0 * Math.exp(-3 * t)); amp = (t) => Math.exp(-4 * t) * Math.min(1, t / 0.006);
  }
  const ticks = renderTickBurst(sr, r, dur, rate, amp, modes);
  normalize([ticks], 0.8);
  const rus = renderRustle(sr, r, rr(r, 0.16, 0.24), 0.7);
  normalize([rus], 0.42);
  const off = Math.round(rr(r, 0, 0.03) * sr), y = new Float32Array(Math.max(ticks.length, off + rus.length));
  y.set(ticks); mixInto(y, rus, off, 1);
  fadeOut(y, 0.02, sr);
  return y;
}
/** Struck modal object: impulses at strike times through a resonator bank. */
function renderStruck(sr, dur, modes, strikes, r, clankHz) {
  const n = Math.ceil(dur * sr), ex = new Float32Array(n);
  for (const s of strikes) {
    const i0 = Math.round(s[0] * sr), len = Math.max(2, Math.round(sr * (0.0003 + 0.0012 * (1 - (s[2] == null ? 0.7 : s[2])))));
    for (let j = 0; j < len && i0 + j < n; j++) ex[i0 + j] += s[1] * (1 - j / len) * (j === 0 ? 1 : r() * 0.6 + 0.4);
  }
  const y = new Float32Array(n);
  for (const m of modes) reson(ex, y, m[0], m[1], m[2], sr);
  if (clankHz) {
    const c = new Float32Array(n), cl = Math.round(0.004 * sr), tau = 0.0008 * sr;
    for (const s of strikes) { const i0 = Math.round(s[0] * sr); for (let j = 0; j < cl && i0 + j < n; j++) c[i0 + j] += s[1] * (r() * 2 - 1) * Math.exp(-j / tau); }
    filt(c, 'highpass', clankHz, 0.7, sr);
    for (let i = 0; i < n; i++) y[i] += c[i] * 0.3;
  }
  return y;
}
// Risset bell partials: [ratio, amp, duration factor, detune Hz]
const RISSET = [[0.56, 1, 1, 0], [0.56, 0.67, 0.9, 1], [0.92, 1, 0.65, 0], [0.92, 1.8, 0.55, 1.7], [1.19, 2.67, 0.325, 0], [1.7, 1.67, 0.35, 0], [2, 1.46, 0.25, 0], [2.74, 1.33, 0.2, 0], [3, 1.33, 0.15, 0], [3.76, 1, 0.1, 0], [4.07, 1.33, 0.075, 0]];
function bellModes(f, T, sr, gain) {
  const m = [];
  for (const p of RISSET) { const fr = p[0] * f + p[3] * 1.5; if (fr < sr * 0.45) m.push([fr, p[2] * T, p[1] * gain]); }
  return m;
}
/** The last-lap bell: a brass hand bell rung hard, clapper hitting both sides. */
function renderLapBell(sr, seed) {
  const r = makeRng(seed), f = rr(r, 1080, 1320), T = rr(r, 2.2, 2.8);
  const strikes = [], ring = rr(r, 1.8, 2.6);
  let t = 0.01, k = 0;
  while (t < ring) { strikes.push([t, (0.75 + 0.25 * r()) * (t > ring - 0.4 ? 0.6 : 1), rr(r, 0.6, 0.9)]); t += k % 2 ? rr(r, 0.15, 0.19) : rr(r, 0.11, 0.14); k++; }
  const y = renderStruck(sr, ring + T * 0.7, bellModes(f, T, sr, 0.35), strikes, r, 2500);
  fadeOut(y, 0.3, sr);
  return y;
}
/** Village church bell, a few slow strikes (rendered at VSR, played far away). */
function renderChurchBell(sr, seed) {
  const r = makeRng(seed), f = rr(r, 250, 320), T = rr(r, 7, 9), strikes = [], nS = 3 + ((r() * 3) | 0);
  for (let k = 0; k < nS; k++) strikes.push([0.02 + k * rr(r, 2, 2.3), rr(r, 0.85, 1), 0.2]);
  const y = renderStruck(sr, strikes[nS - 1][0] + T * 0.6, bellModes(f, T, sr, 0.3), strikes, r, 900);
  fadeOut(y, 1.2, sr);
  return y;
}
/** Spectator's bicycle bell: "dring dring". */
function renderBikeBell(sr, seed) {
  const r = makeRng(seed), k = rr(r, 0.93, 1.07);
  const modes = [[3150 * k, 1.0, 1], [3163 * k, 0.9, 0.7], [4830 * k, 0.7, 0.6], [7300 * k, 0.45, 0.35], [9900 * k, 0.3, 0.2]].filter((m) => m[0] < sr * 0.45);
  const strikes = [];
  for (const t0 of [0.01, rr(r, 0.4, 0.5)]) for (let q = 0; q < 9; q++) strikes.push([t0 + q / 28 + rr(r, 0, 0.004), rr(r, 0.55, 1), 0.9]);
  const y = renderStruck(sr, 1.9, modes, strikes, r, 4000);
  fadeOut(y, 0.4, sr);
  return y;
}
/** Swiss-style cowbells being shaken (stereo, 2-3 bells). */
function renderCowbells(sr, seed, dur) {
  const r = makeRng(seed); dur = dur || 3.2;
  const n = Math.ceil((dur + 1) * sr), L = new Float32Array(n), R = new Float32Array(n);
  const nb = 2 + ((r() * 2) | 0), base = [380, 470, 560, 690, 820];
  for (let b = 0; b < nb; b++) {
    const f0 = pick(r, base) * rr(r, 0.97, 1.03), sheet = r() < 0.6, tk = sheet ? 0.45 : 1.1;
    const modes = [[1, 0.5, 1], [1.505, 0.35, 0.8], [2.06, 0.25, 0.6], [2.6, 0.2, 0.45], [3.35, 0.12, 0.3], [4.1, 0.08, 0.2]]
      .map((m) => [f0 * m[0] * rr(r, 0.985, 1.015), m[1] * tk * rr(r, 0.8, 1.2), m[2] * 0.35]);
    const sw = rr(r, 1.6, 2.4), strikes = [];
    let t = rr(r, 0, 0.3);
    const t1 = dur * rr(r, 0.75, 1);
    while (t < t1) {
      const env = Math.min(1, t / 0.3, (t1 - t) / 0.8 + 0.1);
      if (r() > 0.15) {
        const a = env * rr(r, 0.6, 1); strikes.push([t, a, rr(r, 0.5, 0.9)]);
        if (r() < 0.3) strikes.push([t + rr(r, 0.02, 0.045), a * 0.35, 0.5]);
      }
      t += (0.5 / sw) * rr(r, 0.85, 1.15);
    }
    const y = renderStruck(sr, dur + 1, modes, strikes, r, 2200);
    panInto(L, R, y, 0, rr(r, -0.8, 0.8), rr(r, 0.6, 1));
  }
  fadeOut(L, 0.5, sr); fadeOut(R, 0.5, sr);
  return [L, R];
}
/** Derailleur shift: lever index click, chain rattle, clunk as it seats. */
function renderShift(sr, seed) {
  const r = makeRng(seed), n = Math.ceil(0.42 * sr), y = new Float32Array(n), ex = new Float32Array(n);
  const imp = (arr, t, a, len) => { const i0 = Math.round(t * sr); for (let j = 0; j < len; j++) if (i0 + j < n) arr[i0 + j] += a * (r() * 2 - 1) * (1 - j / len); };
  const l2 = 0.004 + rr(r, 0.008, 0.013);
  imp(ex, 0.004, 1, 6); imp(ex, l2, 0.55, 6);
  for (const m of [[3300, 0.012, 1], [5200, 0.008, 0.7], [7800, 0.005, 0.4]]) reson(ex, y, m[0] * rr(r, 0.95, 1.05), m[1], m[2], sr);
  const g = new Float32Array(n);
  let t = 0.05;
  const tEnd = rr(r, 0.11, 0.15);
  while (t < tEnd) { imp(g, t, rr(r, 0.2, 0.6), 3); t += expo(r, 1 / 380); }
  filt(g, 'bandpass', 2600, 1.2, sr);
  for (let i = 0; i < n; i++) y[i] += g[i] * 0.5;
  const ex2 = new Float32Array(n);
  imp(ex2, tEnd, 1, Math.round(0.0015 * sr));
  for (const m of [[180, 0.03, 0.35], [520, 0.05, 1], [1350, 0.03, 0.6], [2450, 0.02, 0.45], [3900, 0.012, 0.3]]) reson(ex2, y, m[0] * rr(r, 0.95, 1.05), m[1], m[2], sr);
  fadeOut(y, 0.05, sr);
  return y;
}
/** Safety pin through paper, clasp snapping shut. */
function renderPin(sr, seed) {
  const r = makeRng(seed), n = Math.ceil(0.2 * sr), y = new Float32Array(n);
  const pr = renderRustle(sr, r, 0.05, 0.6); normalize([pr], 0.25); mixInto(y, pr, 0, 1);
  const ex = new Float32Array(n), i0 = Math.round(0.052 * sr), i1 = i0 + Math.round(rr(r, 0.006, 0.011) * sr);
  for (let j = 0; j < 4; j++) { ex[i0 + j] += (1 - j / 4) * (r() * 2 - 1); ex[i1 + j] += 0.35 * (1 - j / 4) * (r() * 2 - 1); }
  for (const m of [[4300, 0.014, 1], [6900, 0.01, 0.7], [9800, 0.006, 0.45], [1850, 0.02, 0.3]]) if (m[0] < sr * 0.45) reson(ex, y, m[0] * rr(r, 0.95, 1.05), m[1], m[2], sr);
  const d = Float32Array.from(ex); filt(d, 'highpass', 3000, 0.7, sr);
  for (let i = 0; i < n; i++) y[i] += d[i] * 0.4;
  fadeOut(y, 0.03, sr);
  return y;
}
/** Entry countdown (integration): 3 short beeps 0.5 s apart, then 1 long (go), same speaker as renderClock. */
function renderCountdown(sr) {
  const y = new Float32Array(Math.ceil(2.25 * sr));
  const beep = (t0, len, f) => {
    const i0 = Math.round(t0 * sr), n = Math.round(len * sr), a = 0.004 * sr, d = 0.012 * sr;
    for (let i = 0; i < n; i++) {
      const t = i / sr, e = Math.min(1, i / a, (n - i) / d);
      y[i0 + i] += 0.5 * e * (Math.sin(TAU * f * t) + 0.12 * Math.sin(TAU * 2 * f * t) + 0.06 * Math.sin(TAU * 3 * f * t));
    }
  };
  for (let k = 0; k < 3; k++) beep(0.02 + k * 0.5, 0.11, 1000);
  beep(1.52, 0.6, 1000);
  filt(y, 'peaking', 2000, 1, sr, 4); filt(y, 'highpass', 350, 0.7, sr);
  softClipArr(y, 1.4);
  return y;
}
/** A lamp switch (integration): rocker click and contact, a short body thump. */
function renderClack(sr) {
  const r = makeRng(71), n = Math.ceil(0.3 * sr), y = new Float32Array(n), ex = new Float32Array(n);
  const imp = (t, a, len) => { const i0 = Math.round(t * sr); for (let j = 0; j < len; j++) if (i0 + j < n) ex[i0 + j] += a * (r() * 2 - 1) * (1 - j / len); };
  imp(0.004, 1, 7); imp(0.016, 0.6, 6);
  for (const m of [[1150, 0.03, 1], [2300, 0.022, 0.7], [4200, 0.012, 0.45], [6900, 0.006, 0.25]]) if (m[0] < sr * 0.45) reson(ex, y, m[0], m[1], m[2], sr);
  for (let i = 0; i < n; i++) { const t = i / sr; y[i] += 0.55 * Math.sin(TAU * 92 * t) * Math.exp(-t / 0.045) * Math.min(1, t / 0.002); }
  fadeOut(y, 0.05, sr);
  return y;
}
/** Time-trial start clock: 5 short beeps, 1 long, through a small speaker. */
function renderClock(sr) {
  const y = new Float32Array(Math.ceil(6.1 * sr));
  const beep = (t0, len, f) => {
    const i0 = Math.round(t0 * sr), n = Math.round(len * sr), a = 0.004 * sr, d = 0.006 * sr;
    for (let i = 0; i < n; i++) {
      const t = i / sr, e = Math.min(1, i / a, (n - i) / d);
      y[i0 + i] += 0.5 * e * (Math.sin(TAU * f * t) + 0.12 * Math.sin(TAU * 2 * f * t) + 0.06 * Math.sin(TAU * 3 * f * t));
    }
  };
  for (let k = 0; k < 5; k++) beep(0.05 + k, 0.11, 1000);
  beep(5.05, 0.75, 1000);
  filt(y, 'peaking', 2000, 1, sr, 4); filt(y, 'highpass', 350, 0.7, sr);
  softClipArr(y, 1.4);
  return y;
}

// ---------------------------------------------------------------------------
// 1b. Formant voice: babble, PA announcers, shouts, cheering crowds
// ---------------------------------------------------------------------------

const VOW = { a: [730, 1090, 2440], e: [390, 2300, 2900], E: [550, 1770, 2490], i: [280, 2250, 2890], o: [450, 830, 2380], O: [590, 880, 2540], u: [310, 870, 2250], y: [300, 1650, 2200], '@': [500, 1400, 2450], 9: [470, 1400, 2300] };
// consonant classes: s = voiceless stop, S = voiced stop, f = fricative (high), x = fricative (mid),
// F = voiced fricative, n = nasal, l = liquid, j/w = glides, h = aspiration
const CONS = { p: 's', t: 's', k: 's', b: 'S', d: 'S', g: 'S', s: 'f', f: 'f', x: 'x', v: 'F', z: 'F', m: 'n', n: 'n', l: 'l', r: 'l', h: 'h', j: 'j', w: 'w' };
const LANGS = {
  nl: { v: 'aaEe@oiuy9', c: 'tkdpbvxlrmnsh  ', f0: 118, rate: 1.05 },
  fr: { v: 'aEeoOiuy@9', c: 'tpkdlrmnsvz  ', f0: 125, rate: 1.15 },
  de: { v: 'aaEe@iouy', c: 'tkdpbglrmnsfh  ', f0: 112, rate: 1.0 },
  lu: { v: 'aaE@eiou', c: 'tkdpblrmnsfx  ', f0: 115, rate: 1.05 },
  en: { v: 'aE@eiouO', c: 'tkdpbwlrmnsfh  ', f0: 115, rate: 1.05 },
  es: { v: 'aaeeoiu', c: 'tkdpbglrmnsx   ', f0: 125, rate: 1.2 },
  it: { v: 'aaeEoOiu', c: 'tkdpbglrmnsv   ', f0: 128, rate: 1.15 },
  gr: { v: 'aaeoiu', c: 'tkpdlrmnsxv   ', f0: 122, rate: 1.15 },
  hr: { v: 'aaeoiu', c: 'tkpdbvlrmnsz  ', f0: 118, rate: 1.1 },
  hu: { v: 'aEeo9yiu', c: 'tkpdbvlrmnsh  ', f0: 116, rate: 1.05 },
  ru: { v: 'aao@Eiuy', c: 'tkpdbvlrmnsz  ', f0: 112, rate: 1.05 },
  kr: { v: 'aE@oiu', c: 'tkpgdbmnsh  ', f0: 125, rate: 1.15 },
  th: { v: 'aEeoiu@', c: 'tkpmnlwjh  ', f0: 130, rate: 1.1, tonal: true },
};
/**
 * Control tracks for the formant synth. syl = [{c, v, d, st, a} | {pause, phrase}]
 * o = {f0, fs (formant scale), decl, boost, contour(u), drift}
 */
function buildTracks(sr, syl, o, r) {
  const hop = 48, dt = hop / sr, fs = o.fs || 1;
  let total = 0.06;
  for (const s of syl) total += s.pause || s.d + 0.1;
  const nf = Math.ceil(total / dt) + 8;
  const T = { hop, n: nf, f0: new Float32Array(nf), F1: new Float32Array(nf), F2: new Float32Array(nf), F3: new Float32Array(nf), av: new Float32Array(nf), an: new Float32Array(nf), af: new Float32Array(nf), ft: new Float32Array(nf) };
  const stress = new Float32Array(nf), marks = [0];
  const set = (k0, k1, av, an, af, ft, F) => {
    for (let q = k0; q < k1 && q < nf; q++) {
      T.av[q] = av; T.an[q] = an; T.af[q] = af; T.ft[q] = ft;
      if (F) { T.F1[q] = F[0]; T.F2[q] = F[1]; T.F3[q] = F[2]; }
    }
  };
  const fr = (sec) => Math.max(1, Math.round(sec / dt));
  let k = fr(0.02);
  for (const s of syl) {
    if (s.pause) { const kk = k + fr(s.pause); set(k, kk, 0, 0, 0, 0, null); k = kk; if (s.phrase) marks.push(k); continue; }
    const V = VOW[s.v] || VOW['@'], F = [V[0] * fs, V[1] * fs, V[2] * fs], ct = CONS[s.c];
    if (ct === 's' || ct === 'S') {
      const cl = fr(ct === 's' ? 0.045 : 0.03); set(k, k + cl, ct === 'S' ? 0.07 : 0, 0, 0, 0, F); k += cl;
      const b = fr(0.012); set(k, k + b, 0, 0, 0.9, 0, F); k += b;
      if (ct === 's') { const a = fr(0.018); set(k, k + a, 0, 0.5, 0, 0, F); k += a; }
    } else if (ct === 'f' || ct === 'x' || ct === 'F') {
      const d = fr(ct === 'F' ? 0.06 : 0.085); set(k, k + d, ct === 'F' ? 0.3 : 0, 0, ct === 'F' ? 0.3 : 0.55, ct === 'x' ? 1 : 0, F); k += d;
    } else if (ct === 'n') { const d = fr(0.065); set(k, k + d, 0.35, 0, 0, 0, [280 * fs, 1150 * fs, 2350 * fs]); k += d; }
    else if (ct === 'l') { const d = fr(0.055); set(k, k + d, 0.55, 0, 0, 0, [360 * fs, 1150 * fs, 2600 * fs]); k += d; }
    else if (ct === 'j' || ct === 'w') { const d = fr(0.05); set(k, k + d, 0.5, 0, 0, 0, ct === 'j' ? [280 * fs, 2200 * fs, 2900 * fs] : [300 * fs, 700 * fs, 2300 * fs]); k += d; }
    else if (ct === 'h') { const d = fr(0.06); set(k, k + d, 0, 0.6, 0, 0, F); k += d; }
    const vd = fr(s.d), a = s.a == null ? 1 : s.a;
    set(k, k + vd, a, 0, 0, 0, F);
    if (s.st) for (let q = k; q < k + vd && q < nf; q++) stress[q] = s.st;
    if (o.tonal) { const sh = rr(r, -0.25, 0.25); for (let q = k; q < k + vd && q < nf; q++) stress[q] += sh * ((q - k) / vd - 0.5) * 2; }
    k += vd;
  }
  marks.push(nf);
  // forward/backward fill formants through silences
  let lastF = null;
  for (let q = 0; q < nf; q++) { if (T.F1[q] > 0) lastF = q; else if (lastF !== null) { T.F1[q] = T.F1[lastF]; T.F2[q] = T.F2[lastF]; T.F3[q] = T.F3[lastF]; } }
  let first = 0; while (first < nf && T.F1[first] === 0) first++;
  for (let q = 0; q < first && first < nf; q++) { T.F1[q] = T.F1[first]; T.F2[q] = T.F2[first]; T.F3[q] = T.F3[first]; }
  // pitch: declination per phrase, stress bumps, slow drift, optional contour
  const base = o.f0 || 120, decl = o.decl == null ? 0.18 : o.decl, boost = o.boost == null ? 0.18 : o.boost;
  let drift = 0;
  for (let m = 0; m < marks.length - 1; m++) {
    const a = marks[m], b = marks[m + 1];
    for (let q = a; q < b; q++) {
      const u = (q - a) / Math.max(1, b - a);
      drift += (r() - 0.5) * 0.004 - drift * 0.01;
      const c = o.contour ? o.contour(q / nf) : 1;
      T.f0[q] = base * c * (1 + decl * (0.5 - u)) * (1 + drift);
    }
  }
  // smoothing (coarticulation)
  const aF = 1 - Math.exp(-dt / 0.02), aA = 1 - Math.exp(-dt / 0.006), aP = 1 - Math.exp(-dt / 0.04);
  let s1 = T.F1[0], s2 = T.F2[0], s3 = T.F3[0], sv = 0, sn = 0, sf = 0, sp = T.f0[0], st = 0;
  for (let q = 0; q < nf; q++) {
    s1 += aF * (T.F1[q] - s1); s2 += aF * (T.F2[q] - s2); s3 += aF * (T.F3[q] - s3);
    sv += aA * (T.av[q] - sv); sn += aA * (T.an[q] - sn); sf += aA * (T.af[q] - sf);
    st += aP * (stress[q] - st); sp += aP * (T.f0[q] - sp);
    T.F1[q] = s1; T.F2[q] = s2; T.F3[q] = s3; T.av[q] = sv; T.an[q] = sn; T.af[q] = sf; T.f0[q] = sp * (1 + boost * st);
  }
  return T;
}
/** Glottal pulse source through a cascade of 4 formant resonators (Klatt style). */
function speak(T, sr, r, o) {
  const hop = T.hop, nf = T.n, y = new Float32Array(nf * hop);
  const oq = o.oq || 0.6, cq = 0.18, breath = o.breath == null ? 0.04 : o.breath, jit = o.jitter == null ? 0.012 : o.jitter;
  const fs = o.fs || 1, bw = o.bw || 1, Fb = [70 * bw, 100 * bw, 150 * bw, 250 * bw], F4 = Math.min(3300 * fs, sr * 0.42);
  const s1 = new Float64Array(4), s2 = new Float64Array(4), c1 = new Float64Array(4), c2 = new Float64Array(4), gg = new Float64Array(4);
  const mr = Math.exp((-Math.PI * 1400) / sr), mc1 = 2 * mr * Math.cos((TAU * Math.min(2400, sr * 0.4)) / sr), mc2 = -mr * mr;
  let ph = 0, gPrev = 0, perJ = 1, nz1 = 0, m1 = 0, m2 = 0, shim = 1;
  for (let k = 0; k < nf; k++) {
    const Fk0 = Math.min(T.F1[k], sr * 0.42), Fk1 = Math.min(T.F2[k], sr * 0.42), Fk2 = Math.min(T.F3[k], sr * 0.42);
    for (let j = 0; j < 4; j++) {
      const f = j === 0 ? Fk0 : j === 1 ? Fk1 : j === 2 ? Fk2 : F4;
      const rj = Math.exp((-Math.PI * Fb[j]) / sr);
      c1[j] = 2 * rj * Math.cos((TAU * f) / sr); c2[j] = -rj * rj; gg[j] = 1 - c1[j] - c2[j];
    }
    const av = T.av[k], an = T.an[k] + breath * av, af = T.af[k], ft = T.ft[k], f0 = T.f0[k];
    const base = k * hop;
    for (let s = 0; s < hop; s++) {
      ph += (f0 * perJ) / sr;
      if (ph >= 1) { ph -= 1; perJ = 1 + (r() - 0.5) * 2 * jit; shim = 1 + (r() - 0.5) * 0.12; }
      let g;
      if (ph < oq) g = 0.5 - 0.5 * Math.cos((Math.PI * ph) / oq);
      else if (ph < oq + cq) g = Math.cos((0.5 * Math.PI * (ph - oq)) / cq);
      else g = 0;
      const dg = g - gPrev; gPrev = g;
      const w = r() * 2 - 1;
      let x = dg * av * 6 * shim + w * an * 0.02;
      for (let j = 0; j < 4; j++) { const v = gg[j] * x + c1[j] * s1[j] + c2[j] * s2[j]; s2[j] = s1[j]; s1[j] = v; x = v; }
      if (af > 0.001) {
        const w2 = r() * 2 - 1, hi = w2 - nz1; nz1 = w2;
        const mv = 0.3 * w2 + mc1 * m1 + mc2 * m2; m2 = m1; m1 = mv;
        x += af * (ft < 0.5 ? hi * 0.09 : mv * 0.05);
      }
      y[base + s] = x;
    }
  }
  return y;
}
/** Random syllables that sound like speech in the given language (nonsense on purpose). */
function babbleSyl(r, lang, seconds, energy) {
  const L = LANGS[lang] || LANGS.de, out = [], sp = L.rate * (1 + (energy || 0) * 0.2);
  let t = 0;
  while (t < seconds) {
    const words = 2 + ((r() * 4) | 0);
    for (let w = 0; w < words && t < seconds; w++) {
      const ns = 1 + ((r() * 3) | 0);
      for (let s = 0; s < ns; s++) {
        const c = L.c[(r() * L.c.length) | 0], v = L.v[(r() * L.v.length) | 0], d = rr(r, 0.07, 0.15) / sp;
        out.push({ c: c === ' ' ? '' : c, v, d, st: s === 0 && r() < 0.6 ? 1 : 0, a: rr(r, 0.75, 1) });
        t += d + 0.06;
      }
      if (r() < 0.35) { const p = rr(r, 0.04, 0.12); out.push({ pause: p }); t += p; }
    }
    const p = rr(r, 0.25, 0.55); out.push({ pause: p, phrase: true }); t += p;
  }
  return out;
}
/** A PA announcement / race-radio voice: nonsense phrases with announcer prosody. */
function renderBabble(sr, seed, lang, seconds, energy) {
  const r = makeRng(seed), L = LANGS[lang] || LANGS.de, female = r() < 0.25;
  const T = buildTracks(sr, babbleSyl(r, lang, seconds, energy), {
    f0: L.f0 * (female ? 1.75 : 1) * (1 + energy * 0.35), fs: female ? 1.15 : 1, decl: 0.22 + energy * 0.1, boost: 0.18 + energy * 0.22, tonal: L.tonal,
  }, r);
  const y = speak(T, sr, r, { oq: 0.55 - energy * 0.08, breath: 0.03, fs: female ? 1.15 : 1 });
  filt(y, 'highpass', 110, 0.7, sr); filt(y, 'peaking', 2400, 0.8, sr, 7); filt(y, 'peaking', 500, 1, sr, -3);
  normalize([y], 0.85);
  return y;
}
const SHOUTS = {
  allez: [{ c: '', v: 'a', d: 0.1 }, { c: 'l', v: 'e', d: 0.3, st: 1 }],
  hup: [{ c: 'h', v: '9', d: 0.16, st: 1 }, { pause: 0.08 }, { c: 'h', v: '9', d: 0.18, st: 1 }],
  he: [{ c: 'h', v: 'e', d: 0.3, st: 1 }],
  ho: [{ c: 'h', v: 'o', d: 0.3, st: 1 }],
  go: [{ c: 'g', v: 'o', d: 0.32, st: 1 }],
  vamos: [{ c: 'v', v: 'a', d: 0.12, st: 1 }, { c: 'm', v: 'o', d: 0.24 }],
  dai: [{ c: 'd', v: 'a', d: 0.18, st: 1 }, { c: 'j', v: 'i', d: 0.12 }],
  hopp: [{ c: 'h', v: 'O', d: 0.15, st: 1 }, { pause: 0.07 }, { c: 'h', v: 'O', d: 0.17, st: 1 }],
  links: [{ c: 'l', v: 'i', d: 0.2, st: 1 }],
  ja: [{ c: 'j', v: 'a', d: 0.35, st: 1 }],
};
const SHOUT_BY_LANG = { fr: ['allez', 'allez', 'he', 'ho'], nl: ['hup', 'ja', 'he', 'allez'], de: ['hopp', 'ja', 'links', 'he'], es: ['vamos', 'vamos', 'he'], it: ['dai', 'dai', 'he'], en: ['go', 'he', 'ho'] };
function renderShout(sr, seed, word) {
  const r = makeRng(seed), female = r() < 0.3, syl = SHOUTS[word] || SHOUTS.he;
  const T = buildTracks(sr, syl, { f0: rr(r, 200, 270) * (female ? 1.5 : 1), fs: female ? 1.2 : 1.08, decl: 0.1, boost: 0.25, contour: (u) => 1 + 0.12 * Math.sin(Math.PI * Math.min(1, u * 1.4)) }, r);
  const y = speak(T, sr, r, { oq: 0.45, breath: 0.07, jitter: 0.02, fs: female ? 1.2 : 1.08, bw: 1.3 });
  filt(y, 'highpass', 110, 0.7, sr);
  normalize([y], 0.85);
  return y;
}
/** Cheering crowd swell: sustained voices, roar, claps and whistles (stereo). */
function renderCheer(sr, seed, dur, onlyClaps) {
  const r = makeRng(seed); dur = dur || 3.6;
  const n = Math.ceil(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  const swell = (t) => Math.min(1, t / 0.35) * Math.min(1, Math.max(0, (dur - t) / (dur * 0.45)));
  if (!onlyClaps) {
    const nv = 12;
    for (let v = 0; v < nv; v++) {
      const female = r() < 0.4, st = rr(r, 0, 0.35), len = rr(r, 1.3, Math.max(1.4, dur - 0.4 - st));
      const vow = pick(r, 'aaaEoO'), peak = rr(r, 0.35, 0.6);
      const syl = [{ c: r() < 0.5 ? 'h' : '', v: vow, d: len, st: 1 }];
      const T = buildTracks(sr, syl, { f0: female ? rr(r, 230, 330) : rr(r, 140, 210), fs: female ? 1.2 : 1.1, decl: 0.05, boost: 0.1, contour: (u) => 1 + 0.18 * Math.sin(Math.PI * Math.min(1, u / peak) * 0.5) - 0.12 * Math.max(0, u - peak) }, r);
      const y = speak(T, sr, r, { oq: 0.45, breath: 0.12, jitter: 0.025, fs: female ? 1.2 : 1.1, bw: 1.4 });
      filt(y, 'highpass', 120, 0.7, sr);
      const ln = y.length;
      for (let i = 0; i < ln; i++) { const u = i / ln; y[i] *= Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.45); }
      normalize([y], 1);
      panInto(L, R, y, Math.round(st * sr), rr(r, -0.8, 0.8), rr(r, 0.35, 0.7));
    }
    // breathy roar
    const roar = noiseArr(n, r);
    filt(roar, 'bandpass', 900, 0.6, sr); filt(roar, 'highpass', 200, 0.7, sr); filt(roar, 'peaking', 2500, 1, sr, 4);
    for (let i = 0; i < n; i++) { const e = swell(i / sr) * 0.5; L[i] += roar[i] * e; R[i] += roar[(i + 331) % n] * e; }
    // whistles
    const nw = 1 + ((r() * 2) | 0);
    for (let w = 0; w < nw; w++) {
      const t0 = rr(r, 0.3, dur * 0.5), d = rr(r, 0.35, 0.7), i0 = Math.round(t0 * sr), m = Math.round(d * sr), x = new Float32Array(m);
      const fa = rr(r, 2100, 2500), fb = rr(r, 3000, 3400);
      let ph = 0;
      for (let i = 0; i < m; i++) { const u = i / m, f = u < 0.3 ? fa + (fb - fa) * (u / 0.3) : fb - (fb - fa) * 0.25 * ((u - 0.3) / 0.7); ph += (TAU * f * (1 + 0.01 * Math.sin(TAU * 6 * i / sr))) / sr; x[i] = Math.sin(ph) * Math.min(1, u / 0.08, (1 - u) / 0.15) * 0.35; }
      panInto(L, R, x, i0, rr(r, -0.6, 0.6), 0.8);
    }
  }
  // claps
  const cl = Math.round(0.03 * sr);
  let t = onlyClaps ? 0.05 : 0.3;
  while (t < dur - 0.1) {
    const e = onlyClaps ? Math.min(1, t / 0.3, (dur - t) / 0.8) : swell(t);
    t += 1 / Math.max(2, 34 * e + 2);
    if (r() > e + 0.1) continue;
    const f = rr(r, 900, 2200), c = new Float32Array(cl), tau = rr(r, 0.001, 0.002) * sr, tr = rr(r, 0.006, 0.012) * sr, ph = r() * TAU;
    for (let i = 0; i < cl; i++) c[i] = (r() * 2 - 1) * Math.exp(-i / tau) + 0.5 * Math.sin(ph + (TAU * f * i) / sr) * Math.exp(-i / tr);
    panInto(L, R, c, Math.round(t * sr), rr(r, -0.9, 0.9), rr(r, 0.15, 0.4));
  }
  fadeOut(L, 0.3, sr); fadeOut(R, 0.3, sr);
  normalize([L, R], 0.85);
  return [L, R];
}
/** One murmuring conversation voice for the crowd loop. */
function addMurmurVoice(L, R, sr, r, seconds) {
  const lang = pick(r, ['de', 'nl', 'fr', 'en', 'lu']), female = r() < 0.45, syl = [];
  let t = rr(r, 0, 1.5);
  syl.push({ pause: t });
  while (t < seconds) {
    const talk = rr(r, 1.2, 3.5), part = babbleSyl(r, lang, talk, 0);
    for (const s of part) syl.push(s);
    const gap = rr(r, 0.8, 2.6); syl.push({ pause: gap, phrase: true }); t += talk + gap;
  }
  const T = buildTracks(sr, syl, { f0: (LANGS[lang].f0 + rr(r, -12, 12)) * (female ? 1.7 : 1), fs: female ? 1.15 : 1, decl: 0.15, boost: 0.12 }, r);
  const y = speak(T, sr, r, { oq: 0.6, breath: 0.06, fs: female ? 1.15 : 1 });
  filt(y, 'highpass', 110, 0.7, sr);
  normalize([y], 1);
  if (r() < 0.5) filt(y, 'lowpass', rr(r, 1200, 2500), 0.7, sr);
  panInto(L, R, y.subarray(0, Math.min(y.length, L.length)), 0, rr(r, -0.9, 0.9), rr(r, 0.25, 0.8));
}
/** Short conversational fragments used as random crowd "blips". */
function renderBlip(sr, seed) {
  const r = makeRng(seed), lang = pick(r, ['de', 'nl', 'fr', 'en']), female = r() < 0.45;
  const syl = babbleSyl(r, lang, rr(r, 0.3, 0.9), 0).filter((s) => !s.phrase);
  const T = buildTracks(sr, syl, { f0: LANGS[lang].f0 * (female ? 1.7 : 1) * rr(r, 0.9, 1.15), fs: female ? 1.15 : 1 }, r);
  const y = speak(T, sr, r, { oq: 0.58, breath: 0.05, fs: female ? 1.15 : 1 });
  filt(y, 'highpass', 110, 0.7, sr);
  fadeOut(y, 0.05, sr); normalize([y], 0.8);
  return y;
}

// ---------------------------------------------------------------------------
// 1c. Birds and insects
// ---------------------------------------------------------------------------

function sweepTone(y, sr, t0, dur, f0, f1, amp, curve, h2) {
  const i0 = Math.round(t0 * sr), n = Math.round(dur * sr);
  let ph = 0;
  for (let i = 0; i < n && i0 + i < y.length; i++) {
    const u = i / n, f = f0 * Math.pow(f1 / f0, curve ? Math.pow(u, curve) : u);
    ph += (TAU * f) / sr;
    const e = Math.sin(Math.PI * u);
    y[i0 + i] += amp * e * e * (Math.sin(ph) + (h2 || 0) * Math.sin(2 * ph));
  }
}
function renderBird(sr, seed) {
  const r = makeRng(seed), y = new Float32Array(Math.ceil(1.9 * sr)), base = rr(r, 2600, 3600), notes = 4 + ((r() * 6) | 0);
  let t = 0.02;
  for (let k = 0; k < notes && t < 1.6; k++) {
    const ty = r();
    if (ty < 0.35) { const d = rr(r, 0.04, 0.08); sweepTone(y, sr, t, d, base * rr(r, 0.8, 1), base * rr(r, 1.3, 1.6), rr(r, 0.5, 1), 0.7, 0.05); t += d + rr(r, 0.03, 0.07); }
    else if (ty < 0.6) { const d = rr(r, 0.05, 0.1); sweepTone(y, sr, t, d, base * rr(r, 1.4, 1.7), base * rr(r, 0.8, 1), rr(r, 0.5, 1), 1.3, 0.05); t += d + rr(r, 0.03, 0.06); }
    else if (ty < 0.85) { const m = 4 + ((r() * 5) | 0), f = base * rr(r, 1.1, 1.4); for (let q = 0; q < m; q++) { sweepTone(y, sr, t, 0.022, f * 1.08, f * 0.92, 0.7, 0, 0.03); t += 0.03; } t += 0.05; }
    else { const d = rr(r, 0.12, 0.2); sweepTone(y, sr, t, d, base * 0.9, base * 0.95, 0.8, 0, 0.08); t += d + 0.08; }
  }
  normalize([y], 0.7);
  return y;
}
function renderSwifts(sr, seed) {
  const r = makeRng(seed), y = new Float32Array(Math.ceil(1.6 * sr)), nb = 2 + ((r() * 3) | 0);
  for (let b = 0; b < nb; b++) {
    const t0 = rr(r, 0, 0.5), d = rr(r, 0.35, 0.7), fc = rr(r, 5600, Math.min(7200, sr * 0.4)), i0 = Math.round(t0 * sr), n = Math.round(d * sr), fm = rr(r, 60, 90), am = rr(r, 120, 170);
    let ph = 0;
    for (let i = 0; i < n && i0 + i < y.length; i++) {
      const u = i / n, f = fc * (1 + 0.08 * Math.sin((TAU * fm * i) / sr)) * (1 - 0.1 * u);
      ph += (TAU * f) / sr;
      y[i0 + i] += 0.5 * Math.pow(Math.sin(Math.PI * u), 0.6) * (0.6 + 0.4 * Math.sin((TAU * am * i) / sr)) * (Math.sin(ph) + 0.3 * (r() - 0.5));
    }
  }
  normalize([y], 0.7);
  return y;
}
function gullNote(y, sr, t0, dur, fa, fb, fc, r) {
  const i0 = Math.round(t0 * sr), n = Math.round(dur * sr), amps = [0.5, 1, 0.8, 0.5, 0.3, 0.15];
  let ph = 0;
  for (let i = 0; i < n && i0 + i < y.length; i++) {
    const u = i / n, f = u < 0.25 ? fa + (fb - fa) * (u / 0.25) : fb + (fc - fb) * ((u - 0.25) / 0.75);
    ph += (TAU * f) / sr;
    let s = 0;
    for (let h = 0; h < 6; h++) if (f * (h + 1) < sr * 0.45) s += amps[h] * Math.sin(ph * (h + 1));
    y[i0 + i] += s * Math.min(1, u / 0.12, (1 - u) / 0.3) * 0.3 + (r() - 0.5) * 0.02;
  }
}
function renderGull(sr, seed) {
  const r = makeRng(seed), y = new Float32Array(Math.ceil(2.6 * sr)), f = rr(r, 750, 950), calls = 3 + ((r() * 4) | 0);
  gullNote(y, sr, 0.02, 0.45, f, f * 1.7, f * 1.25, r);
  let t = 0.6;
  for (let k = 0; k < calls; k++) { const d = rr(r, 0.16, 0.24) * (1 - k * 0.06); gullNote(y, sr, t, d, f * 1.05, f * 1.55, f * 1.1, r); t += d + rr(r, 0.05, 0.1); }
  normalize([y], 0.7);
  return y;
}
function renderKoel(sr, seed) {
  const r = makeRng(seed), calls = 3 + ((r() * 3) | 0), y = new Float32Array(Math.ceil((calls * 0.85 + 0.3) * sr));
  let f = rr(r, 650, 760), t = 0.02;
  for (let k = 0; k < calls; k++) {
    sweepTone(y, sr, t, 0.13, f, f * 0.97, 0.7, 0, 0.08);
    sweepTone(y, sr, t + 0.16, 0.3, f * 1.22, f * 1.45, 0.9, 0.8, 0.08);
    t += 0.46 + rr(r, 0.25, 0.4); f *= rr(r, 1.03, 1.07);
  }
  normalize([y], 0.7);
  return y;
}
function renderOwl(sr, seed) {
  const r = makeRng(seed), y = new Float32Array(Math.ceil(3.4 * sr)), f = rr(r, 370, 420);
  const hoot = (t0, d, fa, fb, trem) => {
    const i0 = Math.round(t0 * sr), n = Math.round(d * sr);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n, fr = fa + (fb - fa) * u + (trem ? 12 * Math.sin((TAU * 18 * i) / sr) : 0);
      ph += (TAU * fr) / sr;
      const e = Math.min(1, u / 0.15, (1 - u) / 0.3) * (trem ? 0.8 + 0.2 * Math.sin((TAU * 9 * i) / sr) : 1);
      y[i0 + i] += e * (Math.sin(ph) + 0.15 * Math.sin(2 * ph)) * 0.6 + (r() - 0.5) * 0.03 * e;
    }
  };
  hoot(0.02, 0.5, f, f * 0.95, false);
  hoot(1.45, 0.12, f * 0.9, f * 0.92, false);
  hoot(1.72, 0.12, f * 0.95, f * 0.98, false);
  hoot(1.98, 1.2, f, f * 0.93, true);
  filt(y, 'lowpass', 1600, 0.7, sr);
  normalize([y], 0.7);
  return y;
}
/** Seamless loop of chirping field crickets (stereo). */
function renderCrickets(sr, seed, dur) {
  const r = makeRng(seed); dur = dur || 6;
  const n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let c = 0; c < 5; c++) {
    const fc = rr(r, 4200, Math.min(5300, sr * 0.4)), k = Math.max(3, Math.round(dur * rr(r, 1.6, 3))), per = dur / k, off = r() * per, np = 3 + ((r() * 2) | 0);
    const a = rr(r, 0.3, 1), pan = rr(r, -0.9, 0.9), gl = Math.cos(((pan + 1) * Math.PI) / 4) * a, gr = Math.sin(((pan + 1) * Math.PI) / 4) * a;
    const pl = Math.round(0.014 * sr);
    for (let j = 0; j < k; j++) for (let p = 0; p < np; p++) {
      const i0 = Math.round((off + j * per + p * 0.03) * sr), f = fc * (1 - 0.02 * p);
      for (let i = 0; i < pl; i++) { const e = Math.sin((Math.PI * i) / pl), s = e * e * Math.sin((TAU * f * i) / sr), idx = (i0 + i) % n; L[idx] += s * gl; R[idx] += s * gr; }
    }
  }
  normalize([L, R], 0.6);
  return [L, R];
}
/** Seamless loop of cicadas: pulsed band noise with slow swells (stereo). */
function renderCicadas(sr, seed, dur) {
  const r = makeRng(seed); dur = dur || 6;
  const n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let c = 0; c < 2; c++) {
    const x = noiseArr(n, r), fc = rr(r, 4600, Math.min(6200, sr * 0.4)), pr = rr(r, 180, 260), pan = c ? rr(r, 0.2, 0.8) : rr(r, -0.8, -0.2), ph = r();
    filtLoop(x, 'bandpass', fc, 3, sr); filtLoop(x, 'bandpass', fc, 3, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr, puls = Math.pow(Math.abs(Math.sin(Math.PI * pr * t)), 3), sw = 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * (t / dur + ph)), 2);
      x[i] *= puls * sw;
    }
    panInto(L, R, x, 0, pan, 1);
  }
  normalize([L, R], 0.6);
  return [L, R];
}
/** Seamless loop of a helicopter: blade slaps, rumble, tail rotor, turbine whine. */
function renderHeliLoop(sr, seed) {
  const r = makeRng(seed), bpf = 19.5, count = 39, n = Math.round((count / bpf) * sr), y = new Float32Array(n), len = Math.round(0.03 * sr);
  for (let k = 0; k < count; k++) {
    const i0 = Math.round((k / bpf) * sr), a = (0.8 + 0.2 * Math.sin((TAU * k * 3) / count)) * rr(r, 0.9, 1);
    for (let j = 0; j < len; j++) { const t = j / sr; y[(i0 + j) % n] += a * ((r() * 2 - 1) * Math.exp(-t / 0.004) * 0.6 + Math.sin(TAU * 95 * t) * Math.exp(-t / 0.012)); }
  }
  filtLoop(y, 'lowpass', 1400, 0.7, sr);
  const rum = loopify(noiseArr(n + 4000, r), 4000);
  let b = 0;
  for (let i = 0; i < n; i++) { b = (b + 0.02 * rum[i]) / 1.02; rum[i] = b * 3.5; }
  filtLoop(rum, 'lowpass', 180, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr, saw = ((104 * t) % 1) * 2 - 1;
    y[i] += rum[i] * 0.5 + saw * 0.04 + 0.02 * Math.sin(TAU * 3650 * t) + 0.01 * Math.sin(TAU * 5480 * t);
  }
  normalize([y], 0.8);
  return y;
}
/** Seamless loop of a distant diesel generator (24 h race camp). */
function renderGenerator(sr, seed) {
  const r = makeRng(seed), n = Math.round(2 * sr), y = new Float32Array(n), len = Math.round(0.03 * sr);
  for (let k = 0; k < 50; k++) {
    const i0 = Math.round(k * 0.04 * sr), a = rr(r, 0.7, 1);
    for (let j = 0; j < len; j++) { const t = j / sr; y[(i0 + j) % n] += a * (Math.sin(TAU * 115 * t) * Math.exp(-t / 0.012) + (r() - 0.5) * 0.5 * Math.exp(-t / 0.004)); }
  }
  const mech = loopify(noiseArr(n + 2000, r), 2000);
  filtLoop(mech, 'bandpass', 1200, 1.5, sr);
  for (let i = 0; i < n; i++) { const t = i / sr; y[i] += 0.1 * Math.sin(TAU * 100 * t) + 0.08 * Math.sin(TAU * 150 * t) + 0.04 * Math.sin(TAU * 200 * t) + mech[i] * 0.06; }
  filtLoop(y, 'lowpass', 900, 0.7, sr); filtLoop(y, 'highpass', 80, 0.7, sr);
  normalize([y], 0.7);
  return y;
}
/** MTB rider on gravel: knobby crunch, freewheel buzz, chain slap. */
function renderMtb(sr, seed) {
  const r = makeRng(seed), dur = 3.2, n = Math.ceil(dur * sr), y = new Float32Array(n);
  const cr = new Float32Array(n);
  let t = 0;
  for (;;) { t += expo(r, 1 / 900); if (t >= dur) break; const i0 = (t * sr) | 0, a = Math.min(1, 0.03 * Math.pow(r() + 1e-4, -1.2)), l = 2 + ((r() * 8) | 0); for (let j = 0; j < l && i0 + j < n; j++) cr[i0 + j] += a * (r() * 2 - 1); }
  filt(cr, 'bandpass', 1100, 0.6, sr); filt(cr, 'lowpass', 3500, 0.7, sr);
  const coast = rr(r, 0.9, 1.6), fw = renderTickBurst(sr, r, dur, () => 70, (tt) => (tt > coast && tt < coast + 0.9 ? 1 : 0.05), hubModes(r));
  normalize([fw], 0.5);
  for (let i = 0; i < n; i++) y[i] = cr[i] * 0.6 + fw[i];
  const ex = new Float32Array(n);
  for (let k = 0; k < 5; k++) { const i0 = Math.round(rr(r, 0.1, dur - 0.2) * sr); ex[i0] += rr(r, 0.4, 1); }
  reson(ex, y, 1850, 0.03, 0.4, sr); reson(ex, y, 3100, 0.02, 0.3, sr);
  normalize([y], 0.8);
  return y;
}

// ---------------------------------------------------------------------------
// 1d. Generated impulse responses
// ---------------------------------------------------------------------------

function renderIR(sr, kind, seed) {
  const r = makeRng(seed || 5);
  const P = kind === 'hall' ? { rt: 1.25, len: 1.8, early: 20, eMin: 0.005, eMax: 0.035, flutter: 0, hiA: 7000, hiB: 2500, diff: 0.9 }
    : kind === 'forest' ? { rt: 0.9, len: 1.4, early: 30, eMin: 0.01, eMax: 0.08, flutter: 0, hiA: 5000, hiB: 1500, diff: 0.6 }
      : { rt: 1.5, len: 2.2, early: 6, eMin: 0.012, eMax: 0.05, flutter: rr(r, 0.055, 0.075), hiA: 9000, hiB: 1300, diff: 0.35 };
  const n = Math.ceil(P.len * sr), out = [];
  for (let ch = 0; ch < 2; ch++) {
    const x = new Float32Array(n), pre = 0.008, tau = P.rt / 6.91;
    for (let i = Math.round(pre * sr); i < n; i++) {
      const t = i / sr - pre;
      x[i] = (r() * 2 - 1) * Math.exp(-t / tau) * P.diff * Math.min(1, t / 0.03);
    }
    for (let e = 0; e < P.early; e++) { const t = rr(r, P.eMin, P.eMax), i = Math.round(t * sr); if (i < n) x[i] += (r() < 0.5 ? -1 : 1) * rr(r, 0.3, 0.8) * Math.exp(-t / tau); }
    if (P.flutter) for (let k = 1; k <= 10; k++) { const t = pre + k * P.flutter * rr(r, 0.97, 1.03), i = Math.round(t * sr); if (i < n) x[i] += ((k + ch) % 2 ? 0.85 : 0.45) * Math.pow(0.72, k) * (r() < 0.5 ? -1 : 1); }
    // time-varying one-pole lowpass: darker as it decays
    let yv = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n, fc = P.hiA * Math.pow(P.hiB / P.hiA, u), a = 1 - Math.exp((-TAU * fc) / sr);
      yv += a * (x[i] - yv); x[i] = yv;
    }
    fadeOut(x, 0.1, sr);
    out.push(x);
  }
  return out;
}

// ============================================================================
// 2. Web Audio plumbing
// ============================================================================

function decodeAudio(ctx, data) {
  return new Promise((res, rej) => {
    try {
      const p = ctx.decodeAudioData(data, res, rej);
      if (p && typeof p.then === 'function') p.then(res, rej);
    } catch (e) { rej(e); }
  });
}

/** Build the bus graph on any BaseAudioContext (live or offline). */
function buildGraph(ctx) {
  const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const F = (type, f, q, gain) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; if (gain != null) b.gain.value = gain; return b; };
  const mix = G(1), master = G(0), sub = F('highpass', 38, 0.7);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 18; comp.ratio.value = 2.5; comp.attack.value = 0.02; comp.release.value = 0.3;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
  const trim = G(0.8);
  mix.connect(sub); sub.connect(comp); comp.connect(lim); lim.connect(trim); trim.connect(master); master.connect(ctx.destination);
  const rev = G(1), conv = ctx.createConvolver(), revRet = G(0.5);
  rev.connect(conv); conv.connect(revRet); revRet.connect(mix);
  const amb = G(0.55), sfx = G(0.85), replay = G(0.8), voice = G(1);
  amb.connect(mix); sfx.connect(mix); replay.connect(mix);
  // megaphone / PA: bandpass, saturation, slap echo off the facades
  const hp = F('highpass', 560, 0.9), hp2 = F('highpass', 300, 0.7), pk = F('peaking', 2000, 0.9, 10), sh = ctx.createWaveShaper(), lp = F('lowpass', 4500, 0.9), vpost = G(0.5);
  const curve = new Float32Array(2049), kk = Math.tanh(2.4);
  for (let i = 0; i < 2049; i++) { const x = (i / 1024) - 1; curve[i] = Math.tanh(x * 2.4) / kk; }
  sh.curve = curve; try { sh.oversample = '2x'; } catch (e) { /* old engines */ }
  voice.connect(hp2); hp2.connect(hp); hp.connect(pk); pk.connect(sh); sh.connect(lp); lp.connect(vpost); vpost.connect(mix);
  const dl = ctx.createDelay(1), dlp = F('lowpass', 2800, 0.5), fb = G(0.24), slap = G(0.3), vrev = G(0.3);
  dl.delayTime.value = 0.115;
  vpost.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(slap); slap.connect(mix);
  vpost.connect(vrev); vrev.connect(rev);
  const rsend = G(0.06); replay.connect(rsend); rsend.connect(rev);
  return { mix, master, comp, lim, trim, rev, conv, revRet, amb, sfx, replay, voice };
}

/** A group of nodes that plays once and cleans itself up. */
class Voice {
  constructor(kit, dest, gain, tag) {
    const c = kit.ctx;
    this.kit = kit; this.c = c; this.nodes = []; this.srcs = []; this.end = 0; this.last = null; this.done = false; this.tag = tag || '';
    this.out = c.createGain(); this.out.gain.value = gain; this.out.connect(dest); this.nodes.push(this.out);
  }
  add(n) { this.nodes.push(n); return n; }
  src(n, t0, t1, off) {
    this.nodes.push(n); this.srcs.push(n);
    try { if (off) n.start(t0, off); else n.start(t0); } catch (e) { /* ignore */ }
    if (t1 != null) {
      try { n.stop(t1); } catch (e) { /* ignore */ }
      if (t1 >= this.end) { this.end = t1; this.last = n; }
    }
    return n;
  }
  seal() {
    if (this.last) this.last.onended = () => this.dispose();
    this.kit.track(this);
    return this;
  }
  /** Fade out and release. */
  stop(fade) {
    if (this.done) return;
    fade = fade || 0.08;
    const t = this.c.currentTime, g = this.out.gain;
    try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.setTargetAtTime(0, t, fade / 3); } catch (e) { /* ignore */ }
    for (const s of this.srcs) { try { s.stop(t + fade + 0.05); } catch (e) { /* ignore */ } }
    this.kit.later(() => this.dispose(), fade + 0.4);
  }
  dispose() {
    if (this.done) return;
    this.done = true;
    for (const s of this.srcs) { s.onended = null; try { s.stop(); } catch (e) { /* not started or already stopped */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    this.nodes.length = 0; this.srcs.length = 0;
    this.kit.untrack(this);
  }
}

/** Physically inspired pass-by: distance, Doppler, pan, air absorption. */
function motion(o) {
  const N = o.N || 80, dur = o.dur, near = Math.max(0.5, o.near || 3), v = o.speed || 12, tc = o.tc != null ? o.tc : dur / 2, dir = o.dir || 1;
  const gain = new Float32Array(N), pan = new Float32Array(N), lp = new Float32Array(N), rate = new Float32Array(N);
  const gRef = Math.pow(3 / Math.max(3, near), 0.9) * (o.gain || 1);
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1), t = u * dur, x = v * (t - tc), d = Math.sqrt(x * x + near * near), vr = (v * x) / d;
    rate[i] = C_SOUND / (C_SOUND + vr);
    const e = Math.min(1, u / 0.06, (1 - u) / 0.06), edge = e * e * (3 - 2 * e);
    gain[i] = gRef * (near / d) * edge;
    pan[i] = clamp(dir * (x / d) * 0.9, -1, 1);
    lp[i] = clamp(18000 * Math.pow(3 / d, 0.75), 380, 18000);
  }
  return { N, dur, gain, pan, lp, rate, rateAt: (t) => rate[clamp(Math.round((t / dur) * (N - 1)), 0, N - 1)], panAt: (t) => pan[clamp(Math.round((t / dur) * (N - 1)), 0, N - 1)] };
}
function scaled(arr, k, pow) { const o = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = (pow ? Math.pow(arr[i], pow) : arr[i]) * k; return o; }

/** Per-context toolkit: cached buffers, node factories, voice tracking. */
class Kit {
  constructor(ctx, g, engine, offline) {
    this.ctx = ctx; this.g = g; this.sr = ctx.sampleRate; this.engine = engine || null; this.offline = !!offline;
    this.cache = new Map(); this.voices = []; this.sync = !!offline; this.jobs = new Set(); this.irKind = '';
    this.bus = { amb: g.amb, sfx: g.sfx, voice: g.voice, replay: g.replay, rev: g.rev };
    this.curves = new Map();
  }
  get now() { return this.ctx.currentTime; }
  later(fn, sec) { if (!this.offline) setTimeout(fn, Math.max(0, sec * 1000)); }
  memo(key, make) { let v = this.cache.get(key); if (v === undefined) { v = make(); this.cache.set(key, v); } return v; }
  buffer(chs, sr) {
    const b = this.ctx.createBuffer(chs.length, chs[0].length, sr || this.sr);
    for (let c = 0; c < chs.length; c++) { if (b.copyToChannel) b.copyToChannel(chs[c], c); else b.getChannelData(c).set(chs[c]); }
    return b;
  }
  /** Render something heavy off the critical path (sync in offline mode). */
  defer(key, steps, finish) {
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.sync) { for (const s of steps) s(); const v = finish(); this.cache.set(key, v); return v; }
    if (this.jobs.has(key)) return null;
    this.jobs.add(key);
    let i = 0;
    const run = () => {
      const t0 = nowMs();
      while (i < steps.length && nowMs() - t0 < 10) steps[i++]();
      if (i < steps.length) { setTimeout(run, 20); return; }
      try { this.cache.set(key, finish()); } catch (e) { /* ignore */ }
      this.jobs.delete(key);
    };
    setTimeout(run, 30);
    return null;
  }
  white() { return this.memo('white', () => this.buffer([noiseArr(this.sr * 2, makeRng(11))])); }
  pink() {
    return this.memo('pink', () => {
      const n = this.sr * 5, xf = Math.round(this.sr * 0.3), chs = [];
      for (let c = 0; c < 2; c++) {
        const r = makeRng(21 + c), x = new Float32Array(n + xf);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < n + xf; i++) {
          const w = r() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
        }
        chs.push(loopify(x, xf));
      }
      return this.buffer(chs);
    });
  }
  brown() {
    return this.memo('brown', () => {
      const n = this.sr * 4, xf = Math.round(this.sr * 0.3), r = makeRng(31), x = new Float32Array(n + xf);
      let b = 0;
      for (let i = 0; i < n + xf; i++) { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; x[i] = b * 3.5; }
      return this.buffer([loopify(x, xf)]);
    });
  }
  gain(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  filter(type, f, q, gainDb) {
    const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
    if (q != null) b.Q.value = q; if (gainDb != null) b.gain.value = gainDb;
    return b;
  }
  panner(p) {
    const c = this.ctx;
    if (c.createStereoPanner) { const s = c.createStereoPanner(); s.pan.value = clamp(p || 0, -1, 1); return s; }
    const pn = c.createPanner(); pn.panningModel = 'equalpower';
    const a = (clamp(p || 0, -1, 1) * Math.PI) / 2;
    if (pn.setPosition) pn.setPosition(Math.sin(a), 0, -Math.cos(a));
    return pn;
  }
  curve(k) {
    let c = this.curves.get(k);
    if (!c) { c = new Float32Array(2049); const kk = Math.tanh(k); for (let i = 0; i < 2049; i++) c[i] = Math.tanh((i / 1024 - 1) * k) / kk; this.curves.set(k, c); }
    return c;
  }
  shaper(k) { const w = this.ctx.createWaveShaper(); w.curve = this.curve(k); try { w.oversample = '2x'; } catch (e) { /* ignore */ } return w; }
  osc(type, f) { const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; }
  /** Looping noise source ('white' | 'pink' stereo | 'brown') owned by voice v; start it with v.src(). */
  noise(v, kind) {
    const b = kind === 'pink' ? this.pink() : kind === 'brown' ? this.brown() : this.white();
    const s = v.add(this.ctx.createBufferSource()); s.buffer = b; s.loop = true;
    return s;
  }
  voice(bus, o, tag) {
    o = o || {};
    const dest = o.dest || this.bus[bus] || this.bus.sfx;
    return new Voice(this, dest, dbGain(o.gainDb || 0) * (o.gain == null ? 1 : o.gain), tag || o.tag);
  }
  /** Static placement: distance (1 = close, 10 = far away), pan, reverb send. */
  place(v, o, dest) {
    o = o || {};
    const dist = Math.max(1, o.dist || 1), inp = v.add(this.gain(Math.pow(dist, -0.85)));
    let node = inp;
    if (dist > 1.2) { const lp = v.add(this.filter('lowpass', clamp(18000 * Math.pow(dist, -0.75), 450, 18000), 0)); node.connect(lp); node = lp; }
    const p = v.add(this.panner(o.pan || 0)); node.connect(p); p.connect(dest || v.out);
    const send = o.send != null ? o.send : clamp(0.1 + 0.2 * Math.log2(dist), 0.06, 0.75);
    if (send > 0.001) { const s = v.add(this.gain(send)); p.connect(s); s.connect(this.bus.rev); }
    return inp;
  }
  /** Moving placement from motion() curves. */
  move(v, t, mc, send) {
    const inp = v.add(this.ctx.createGain()), lp = v.add(this.filter('lowpass', 18000, 0)), p = v.add(this.panner(0));
    try {
      inp.gain.setValueCurveAtTime(mc.gain, t, mc.dur);
      lp.frequency.setValueCurveAtTime(mc.lp, t, mc.dur);
      if (p.pan) p.pan.setValueCurveAtTime(mc.pan, t, mc.dur);
    } catch (e) { /* ignore */ }
    inp.connect(lp); lp.connect(p); p.connect(v.out);
    const s = v.add(this.gain(send == null ? 0.18 : send)); p.connect(s); s.connect(this.bus.rev);
    return inp;
  }
  /** Play an AudioBuffer as a one-shot with placement or Doppler motion. */
  playBuf(buf, t, o) {
    o = o || {};
    const v = this.voice(o.bus || 'sfx', o), s = v.add(this.ctx.createBufferSource());
    s.buffer = buf;
    const off = o.offset || 0, rate = o.rate || 1, dur = (o.dur || buf.duration - off) / rate;
    let inp;
    if (o.doppler) {
      const d = o.doppler === true ? {} : o.doppler;
      const mc = motion({ dur: dur + 0.15, tc: d.tc, speed: d.speed || 14, near: d.near || 3 * (o.dist || 1), dir: d.dir || ((o.pan || 0) < 0 ? -1 : 1) });
      inp = this.move(v, t, mc, d.send);
      try { s.playbackRate.setValueCurveAtTime(scaled(mc.rate, rate), t, mc.dur); } catch (e) { /* ignore */ }
    } else {
      if (rate !== 1) s.playbackRate.value = rate;
      inp = this.place(v, o);
    }
    s.connect(inp);
    v.src(s, t, t + dur * 1.06 + 0.05, off);
    return v.seal();
  }
  track(v) {
    this.voices.push(v);
    let active = 0;
    for (let i = 0; i < this.voices.length; i++) if (!this.voices[i].stopping) active++;
    // over the cap: steal the oldest ambient voices first, stings and the replay last
    for (let pass = 0; pass < 2 && active > MAX_VOICES; pass++) {
      for (let i = 0; i < this.voices.length && active > MAX_VOICES; i++) {
        const o = this.voices[i];
        if (o.stopping || o === v || (pass === 0 && (o.tag === 'sting' || o.tag === 'replay'))) continue;
        o.stopping = true; o.stop(0.05); active--;
      }
    }
  }
  untrack(v) { const i = this.voices.indexOf(v); if (i >= 0) this.voices.splice(i, 1); }
  stopTag(tag, fade) { for (const v of this.voices.slice()) if (v.tag === tag) v.stop(fade); }
  setIR(kind) {
    kind = kind || 'street';
    if (kind === this.irKind) return;
    const first = !this.irKind;
    this.irKind = kind;
    const buf = this.memo('ir:' + kind, () => this.buffer(renderIR(this.sr, kind)));
    const g = this.g.revRet.gain, t = this.now;
    if (first || this.offline) { this.g.conv.buffer = buf; return; }
    try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.15); g.linearRampToValueAtTime(0.5, t + 0.6); } catch (e) { /* ignore */ }
    this.later(() => { try { this.g.conv.buffer = buf; } catch (e) { /* ignore */ } }, 0.17);
  }
  // ---- cached renders ----
  fwLoop(fast, variant) {
    const key = 'fwl' + (fast ? 'f' : 's') + variant;
    return this.memo(key, () => { const r = makeRng(900 + variant * 13 + (fast ? 7 : 0)), y = renderTickLoop(this.sr, r, fast ? 110 : 30, 36 * (fast ? 4 : 1), hubModes(r)); normalize([y], 0.7); return this.buffer([y]); });
  }
  babble(lang, variant, energy, secs) {
    return this.memo('bab:' + lang + variant + ':' + energy, () => this.buffer([renderBabble(VSR, 700 + variant * 31 + hashSeed(lang) % 97, lang, secs || 3.2, energy)], VSR));
  }
  shoutBuf(word, variant) { return this.memo('sh:' + word + variant, () => this.buffer([renderShout(VSR, 300 + variant * 17 + hashSeed(word) % 51, word)], VSR)); }
  blip(i) { return this.memo('blip' + i, () => this.buffer([renderBlip(VSR, 500 + i)], VSR)); }
  murmur() {
    const hit = this.cache.get('murmur');
    if (hit) return hit;
    if (this.jobs.has('murmur')) return null;
    const secs = 8, xf = 0.6, n = Math.ceil((secs + xf) * VSR), L = new Float32Array(n), R = new Float32Array(n), r = makeRng(77), steps = [];
    for (let i = 0; i < 14; i++) steps.push(() => addMurmurVoice(L, R, VSR, r, secs + xf));
    return this.defer('murmur', steps, () => { const l = loopify(L, Math.round(xf * VSR)), rr2 = loopify(R, Math.round(xf * VSR)); normalize([l, rr2], 0.8); return this.buffer([l, rr2], VSR); });
  }
  /** Cached buffer from BUFS. */
  get(name, variant) { const s = variant | 0; return this.memo(name + ':' + s, () => BUFS[name](this, s)); }
  /** Pre-render buffers a list of synths will need, one per idle slice (keeps clicks and animations smooth). */
  warm(synths, lang) {
    const q = this.warmQ || (this.warmQ = []);
    for (const n of synths) {
      for (const need of NEEDS[n] || []) for (let i = 0; i < need[1]; i++) { const b = need[0], v = i; if (!this.cache.has(b + ':' + v)) q.push(() => this.get(b, v)); }
      if ((n === 'speaker' || n === 'radio') && lang) for (let i = 0; i < 3; i++) q.push(n === 'radio' ? () => this.babble(lang, i, 0.7, 2.6) : () => this.babble(lang, i, 1, 3.4));
      if (n === 'peloton') for (let i = 0; i < 3; i++) q.push(() => this.fwLoop(true, i));
    }
    if (this.warming || this.offline || !q.length) return;
    this.warming = true;
    const ric = HAS_WIN && window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 1500 }) : (f) => setTimeout(f, 60);
    const step = () => {
      const f = q.shift();
      if (f) { try { f(); } catch (e) { warn(e); } }
      if (q.length) ric(step); else this.warming = false;
    };
    ric(step);
  }
}

// ============================================================================
// 3. Synth voices (each: (kit, time, opts) -> Voice)
// ============================================================================

function seedOf(o, mod) { return hashSeed(o && o.seed != null ? o.seed : Math.random()) % (mod || 16); }

/** Horn note: formant "pouet" (bulb/caravan horn) or brassy musical air horn. */
function hornNote(k, v, dest, t, f, dur, o) {
  const c = k.ctx, g = v.add(c.createGain()), pre = v.add(k.gain(0.3));
  g.gain.value = 0;
  const types = o.types || ['sawtooth', 'square', 'sawtooth'], det = o.det || [0, 7, -6];
  for (let i = 0; i < types.length; i++) {
    const os = k.osc(types[i], f);
    os.detune.setValueAtTime(det[i] + (o.scoop == null ? -70 : o.scoop), t);
    os.detune.setTargetAtTime(det[i], t, o.scoopT || 0.018);
    os.connect(pre); v.src(os, t, t + dur + 0.05);
  }
  const sh = v.add(k.shaper(o.drive || 2)); pre.connect(sh);
  if (o.pouet) {
    const f1 = v.add(k.filter('bandpass', 330, 4)), f2 = v.add(k.filter('bandpass', 880, 6)), f3 = v.add(k.filter('bandpass', 2500, 7));
    f1.frequency.setValueAtTime(320, t); f1.frequency.linearRampToValueAtTime(560, t + dur * 0.65);
    f2.frequency.setValueAtTime(850, t); f2.frequency.linearRampToValueAtTime(1800, t + dur * 0.65);
    const a = v.add(k.gain(1.2)), b = v.add(k.gain(0.9)), cc = v.add(k.gain(0.35));
    sh.connect(f1); sh.connect(f2); sh.connect(f3); f1.connect(a); f2.connect(b); f3.connect(cc); a.connect(g); b.connect(g); cc.connect(g);
  } else {
    const hp = v.add(k.filter('highpass', 260, 0.7)), pk = v.add(k.filter('peaking', o.formant || 1250, 1.4, 9)), lp = v.add(k.filter('lowpass', 5200, 0));
    sh.connect(hp); hp.connect(pk); pk.connect(lp); lp.connect(g);
  }
  const amp = o.amp || 0.8, att = o.att || 0.012;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + att);
  g.gain.setValueAtTime(amp * 0.92, t + Math.max(att + 0.01, dur - 0.04)); g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(dest);
}
// Original fanfare for the "Rodania-style" car. The real call (trumpet playing the opening of
// Beethoven's Fifth with a singer on "Rodaniaaa", from the car's loudspeakers; source: VRT NWS,
// 2020-09-08 and 2021-04-07) is deliberately NOT used: this is a different, pentatonic motif,
// played on a trumpet through a car loudspeaker so it evokes the moment without copying it.
const FANFARE = [[0, 74, 0.16], [0.19, 78, 0.16], [0.38, 81, 0.36], [0.78, 78, 0.16], [0.97, 76, 0.16], [1.16, 74, 0.16], [1.35, 69, 0.16], [1.54, 74, 0.62]];
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** Trumpet-like note: two saws, brightness envelope (brass "blat"), pitch scoop, late vibrato. */
function trumpetNote(k, v, dest, t, f, dur, vib) {
  const g = v.add(k.gain(0)), lp = v.add(k.filter('lowpass', 900, 1)), o1 = k.osc('sawtooth', f), o2 = k.osc('sawtooth', f);
  o1.detune.setValueAtTime(-35, t); o1.detune.setTargetAtTime(0, t, 0.02);
  o2.detune.setValueAtTime(-29, t); o2.detune.setTargetAtTime(6, t, 0.02);
  o1.connect(lp); o2.connect(lp);
  if (vib) {
    const l = k.osc('sine', 5.6), ld = v.add(k.gain(0));
    ld.gain.setValueAtTime(0, t + 0.12); ld.gain.linearRampToValueAtTime(16, t + dur);
    l.connect(ld); ld.connect(o1.detune); ld.connect(o2.detune); v.src(l, t, t + dur + 0.05);
  }
  lp.frequency.setValueAtTime(700, t); lp.frequency.linearRampToValueAtTime(3800, t + 0.035);
  lp.frequency.setTargetAtTime(2500, t + 0.04, 0.08); lp.frequency.setTargetAtTime(900, t + dur - 0.03, 0.02);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.025); g.gain.setTargetAtTime(0.4, t + 0.03, 0.05);
  g.gain.setValueAtTime(0.4, t + dur - 0.035); g.gain.linearRampToValueAtTime(0, t + dur);
  lp.connect(g); g.connect(dest);
  v.src(o1, t, t + dur + 0.05); v.src(o2, t, t + dur + 0.05);
}

/** Continuous drivetrain: chain mesh whirr pulsing with cadence, pitch with speed. */
class Drivetrain {
  constructor(k, v, dest) {
    this.k = k;
    const n = k.noise(v, 'white');
    this.sum = v.add(k.gain(1));
    this.bands = [[520, 2.5, 0.5], [1150, 3, 0.8], [2400, 3.5, 1], [4700, 3, 0.6], [8200, 2.5, 0.25]].map((b) => {
      const f = v.add(k.filter('bandpass', b[0], b[1])), g = v.add(k.gain(b[2]));
      n.connect(f); f.connect(g); g.connect(this.sum); f.base = b[0];
      return f;
    });
    this.am = v.add(k.gain(0.55)); this.pm = v.add(k.gain(0.7)); this.level = v.add(k.gain(0));
    this.tooth = k.osc('triangle', 80); this.toothD = v.add(k.gain(0.45)); this.tooth.connect(this.toothD); this.toothD.connect(this.am.gain);
    this.ped = k.osc('sine', 3); this.pedD = v.add(k.gain(0.25)); this.ped.connect(this.pedD); this.pedD.connect(this.pm.gain);
    this.whine = k.osc('sawtooth', 80); const wb = v.add(k.filter('bandpass', 1900, 4)), wg = v.add(k.gain(0.05));
    this.whine.connect(wb); wb.connect(wg); wg.connect(this.am);
    this.sum.connect(this.am); this.am.connect(this.pm); this.pm.connect(this.level); this.level.connect(dest);
    this.n = n;
  }
  start(v, t, t1) { v.src(this.n, t, t1, Math.random() * 1.5); v.src(this.tooth, t, t1); v.src(this.ped, t, t1); v.src(this.whine, t, t1); }
  /** w watts, cad rpm, kph km/h; tc = smoothing time constant */
  set(t, w, cad, kph, tc, gain) {
    const on = w > 3 && cad > 5, lvl = on ? clamp(Math.pow(w / 320, 0.7), 0.05, 1.4) * 0.55 * (gain || 1) : 0;
    this.level.gain.setTargetAtTime(lvl, t, tc);
    const tooth = Math.max(10, (cad / 60) * 50);
    this.tooth.frequency.setTargetAtTime(tooth, t, tc); this.whine.frequency.setTargetAtTime(tooth, t, tc);
    this.ped.frequency.setTargetAtTime(Math.max(0.5, cad / 30), t, tc);
    this.pedD.gain.setTargetAtTime(clamp(0.1 + w / 1400, 0.1, 0.55), t, tc);
    const sp = 0.75 + clamp(kph, 0, 70) / 90;
    for (let i = 0; i < this.bands.length; i++) this.bands[i].frequency.setTargetAtTime(this.bands[i].base * sp, t, tc);
  }
}

const mono = (k, y, peak, sr) => { if (peak) normalize([y], peak); return k.buffer([y], sr); };
/** Cached one-shot buffers: name -> (kit, variant) => AudioBuffer. Access with kit.get(name, variant). */
const BUFS = {
  hov: (k, s) => mono(k, renderHover(k.sr, s)),
  fw: (k, s) => {
    const r = makeRng(s + 101), r0 = rr(r, 80, 110);
    const y = renderTickBurst(k.sr, r, 1.5, (tt) => Math.max(6, r0 * Math.exp(-2.1 * tt)), (tt) => Math.exp(-1.1 * tt) * Math.min(1, tt / 0.01), hubModes(r));
    fadeOut(y, 0.05, k.sr);
    return mono(k, y, 0.8);
  },
  pap: (k, s) => { const r = makeRng(s + 41); return mono(k, renderRustle(k.sr, r, rr(r, 0.25, 0.45), 1), 0.8); },
  shift: (k, s) => mono(k, renderShift(k.sr, 60 + s), 0.8),
  pin: (k, s) => mono(k, renderPin(k.sr, 80 + s), 0.8),
  bell: (k, s) => mono(k, renderLapBell(k.sr, 90 + s), 0.8),
  church: (k, s) => mono(k, renderChurchBell(VSR, 110 + s), 0.8, VSR),
  bikebell: (k, s) => mono(k, renderBikeBell(k.sr, 120 + s), 0.7),
  cow: (k, s) => k.buffer(normalize(renderCowbells(k.sr, 130 + s), 0.8)),
  clock: (k) => mono(k, renderClock(k.sr)),
  countdown: (k) => mono(k, renderCountdown(k.sr)),
  clack: (k) => mono(k, renderClack(k.sr), 0.8),
  cheer: (k, s) => k.buffer(renderCheer(VSR, 800 + s, 3.6, false), VSR),
  clap: (k, s) => k.buffer(renderCheer(VSR, 850 + s, 3.2, true), VSR),
  bird: (k, s) => mono(k, renderBird(k.sr, 140 + s)),
  swift: (k, s) => mono(k, renderSwifts(k.sr, 150 + s)),
  gull: (k, s) => mono(k, renderGull(k.sr, 160 + s)),
  koel: (k, s) => mono(k, renderKoel(k.sr, 170 + s)),
  owl: (k, s) => mono(k, renderOwl(VSR, 180 + s), 0, VSR),
  mtb: (k, s) => mono(k, renderMtb(k.sr, 200 + s)),
  heli: (k) => mono(k, renderHeliLoop(VSR, 190), 0, VSR),
  gen: (k) => mono(k, renderGenerator(VSR, 230), 0, VSR),
  crickets: (k) => k.buffer(renderCrickets(k.sr, 210)),
  cicadas: (k) => k.buffer(renderCicadas(k.sr, 220)),
};
// which cached buffers a synth needs: [bufName, variants]
const NEEDS = {
  freewheel: [['fw', 2]], paper: [['pap', 2]], shift: [['shift', 2]], pin: [['pin', 2]], bell: [['bell', 3]], 'church-bell': [['church', 2]],
  'bike-bell': [['bikebell', 2]], cowbells: [['cow', 4]], 'tt-clock': [['clock', 1]], cheer: [['cheer', 3]], applause: [['clap', 2]],
  bird: [['bird', 4]], swift: [['swift', 2]], gull: [['gull', 2]], koel: [['koel', 2]], owl: [['owl', 2]], 'mtb-rider': [['mtb', 2]],
  helicopter: [['heli', 1]], 'tt-start': [['clock', 1], ['shift', 2]], peloton: [['shift', 2]],
  'tt-countdown': [['countdown', 1]], clack: [['clack', 1]],
};

const SYN = {
  hover(k, t, o) {
    const s = hashSeed(o.seed == null ? 1 : o.seed) % 24;
    return k.playBuf(k.get('hov', s), t, o);
  },
  freewheel(k, t, o) {
    return k.playBuf(k.get('fw', seedOf(o, 12)), t, o);
  },
  paper(k, t, o) {
    return k.playBuf(k.get('pap', seedOf(o, 12)), t, o);
  },
  shift(k, t, o) { return k.playBuf(k.get('shift', seedOf(o, 6)), t, o); },
  pin(k, t, o) { return k.playBuf(k.get('pin', seedOf(o, 6)), t, o); },
  bell(k, t, o) { return k.playBuf(k.get('bell', seedOf(o, 3)), t, Object.assign({ dist: 1.5 }, o)); },
  'church-bell'(k, t, o) { return k.playBuf(k.get('church', seedOf(o, 2)), t, Object.assign({ dist: 7 }, o)); },
  'bike-bell'(k, t, o) { return k.playBuf(k.get('bikebell', seedOf(o, 2)), t, Object.assign({ dist: 2 }, o)); },
  cowbells(k, t, o) { return k.playBuf(k.get('cow', seedOf(o, 4)), t, Object.assign({ dist: 2 }, o)); },
  'tt-clock'(k, t, o) { return k.playBuf(k.get('clock', 0), t, Object.assign({ dist: 1.4 }, o)); },
  'tt-countdown'(k, t, o) { return k.playBuf(k.get('countdown', 0), t, Object.assign({ dist: 1.2 }, o)); },
  clack(k, t, o) { return k.playBuf(k.get('clack', 0), t, Object.assign({ dist: 0.9 }, o)); },
  cheer(k, t, o) { return k.playBuf(k.get('cheer', seedOf(o, 3)), t, Object.assign({ dist: 2.5 }, o)); },
  applause(k, t, o) { return k.playBuf(k.get('clap', seedOf(o, 2)), t, Object.assign({ dist: 2.5 }, o)); },
  bird(k, t, o) { return k.playBuf(k.get('bird', seedOf(o, 4)), t, Object.assign({ dist: 3, pan: (Math.random() - 0.5) * 1.4 }, o)); },
  swift(k, t, o) { return k.playBuf(k.get('swift', seedOf(o, 2)), t, Object.assign({ dist: 2, doppler: { speed: 16, near: 6 } }, o)); },
  gull(k, t, o) { return k.playBuf(k.get('gull', seedOf(o, 2)), t, Object.assign({ dist: 3.5, pan: (Math.random() - 0.5) * 1.2 }, o)); },
  koel(k, t, o) { return k.playBuf(k.get('koel', seedOf(o, 2)), t, Object.assign({ dist: 4, pan: (Math.random() - 0.5) * 1.2 }, o)); },
  owl(k, t, o) { return k.playBuf(k.get('owl', seedOf(o, 2)), t, Object.assign({ dist: 5, pan: (Math.random() - 0.5) * 1.4 }, o)); },
  shout(k, t, o) {
    const list = SHOUT_BY_LANG[o.lang] || SHOUT_BY_LANG.fr, word = o.word || list[(Math.random() * list.length) | 0];
    return k.playBuf(k.shoutBuf(word, seedOf(o, 3)), t, Object.assign({ dist: 1.8 }, o));
  },
  /** PA announcer through the megaphone bus (clip from the manifest if available). */
  speaker(k, t, o) {
    const lang = o.lang || 'de', clip = k.engine && k.engine._voiceClip(o.scene || lang, o.voice || 'speaker');
    const buf = clip || k.babble(lang, seedOf(o, 4), 1, 3.4);
    return k.playBuf(buf, t, Object.assign({ dist: 2.5, pan: (Math.random() - 0.5) * 0.8 }, o, { bus: 'voice', gainDb: (o.gainDb || 0) + (clip ? clip.gainDb || 0 : -2) }));
  },
  /** Race radio: squelch, compressed voice through a narrow radio band, roger beep. */
  radio(k, t, o) {
    const v = k.voice('sfx', o), inp = k.place(v, { pan: o.pan == null ? 0.25 : o.pan, dist: o.dist || 1.6, send: 0.08 });
    const hp = v.add(k.filter('highpass', 450, 0.7)), pk = v.add(k.filter('peaking', 1700, 1, 6)), sh = v.add(k.shaper(3)), lp = v.add(k.filter('lowpass', 3000, 0));
    hp.connect(pk); pk.connect(sh); sh.connect(lp); lp.connect(inp);
    const clip = k.engine && k.engine._voiceClip(o.scene || 'fr', o.voice || 'radio');
    const buf = clip || k.babble(o.lang || 'fr', seedOf(o, 3), 0.7, 2.6);
    const t1 = t + 0.09, tEnd = t1 + buf.duration;
    const squelch = (at, len) => {
      const s = k.noise(v, 'white'), bp = v.add(k.filter('bandpass', 2200, 0.8)), g = v.add(k.gain(0));
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.5, at + 0.005); g.gain.setValueAtTime(0.5, at + len * 0.7); g.gain.linearRampToValueAtTime(0, at + len);
      s.connect(bp); bp.connect(g); g.connect(hp); v.src(s, at, at + len + 0.02, Math.random());
    };
    squelch(t, 0.08);
    const vs = v.add(k.ctx.createBufferSource()); vs.buffer = buf; const vg = v.add(k.gain(clip ? dbGain(clip.gainDb || 0) : 0.9));
    vs.connect(vg); vg.connect(hp); v.src(vs, t1, tEnd + 0.02);
    const hs = k.noise(v, 'white'), hh = v.add(k.filter('highpass', 2000, 0.7)), hg = v.add(k.gain(0.025));
    hs.connect(hh); hh.connect(hg); hg.connect(hp); v.src(hs, t, tEnd + 0.05, Math.random());
    squelch(tEnd + 0.03, 0.12);
    const beep = k.osc('sine', 1250), bg = v.add(k.gain(0));
    bg.gain.setValueAtTime(0, tEnd + 0.17); bg.gain.linearRampToValueAtTime(0.25, tEnd + 0.175); bg.gain.setValueAtTime(0.25, tEnd + 0.23); bg.gain.linearRampToValueAtTime(0, tEnd + 0.235);
    beep.connect(bg); bg.connect(hp); v.src(beep, tEnd + 0.16, tEnd + 0.26);
    return v.seal();
  },
  /** Crowd murmur one-shot (4 s). */
  crowd(k, t, o) {
    const v = k.voice('sfx', o), inp = k.place(v, Object.assign({ dist: 2.5 }, o)), dur = o.dur || 4, env = v.add(k.gain(0));
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.6); env.gain.setValueAtTime(1, t + dur - 1); env.gain.linearRampToValueAtTime(0, t + dur);
    env.connect(inp);
    const n = k.noise(v, 'white');
    const nh = v.add(k.filter('highpass', 150, 0)); nh.connect(env);
    for (const b of [[300, 1.2, 0.5], [520, 1.5, 0.45], [1000, 1.6, 0.3], [2200, 2, 0.12]]) { const f = v.add(k.filter('bandpass', b[0], b[1])), g = v.add(k.gain(b[2] * 0.4)); n.connect(f); f.connect(g); g.connect(nh); }
    v.src(n, t, t + dur + 0.05, Math.random());
    const m = k.murmur();
    if (m) { const s = v.add(k.ctx.createBufferSource()); s.buffer = m; s.loop = true; s.connect(env); v.src(s, t, t + dur + 0.05, Math.random() * 6); }
    for (let i = 0; i < 5; i++) { const b = k.blip((Math.random() * 12) | 0), s = v.add(k.ctx.createBufferSource()), p = v.add(k.panner((Math.random() - 0.5) * 1.6)), g = v.add(k.gain(0.35)); s.buffer = b; s.connect(g); g.connect(p); p.connect(env); v.src(s, t + Math.random() * (dur - 1), t + dur); }
    return v.seal();
  },
  wind(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 4, n = k.noise(v, 'pink'), lp = v.add(k.filter('lowpass', 400, 0)), hp = v.add(k.filter('highpass', 80, 0)), g = v.add(k.gain(0));
    lp.frequency.setValueAtTime(350, t); lp.frequency.linearRampToValueAtTime(1300, t + dur * 0.45); lp.frequency.linearRampToValueAtTime(450, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + dur * 0.45); g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(lp); lp.connect(hp); hp.connect(g); g.connect(v.out); v.src(n, t, t + dur + 0.05, Math.random() * 4);
    return v.seal();
  },
  tyre(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 2.6, mc = motion({ dur, speed: 11, near: 1.5 * (o.dist || 1), dir: o.dir || 1 }), inp = k.move(v, t, mc);
    const n = k.noise(v, 'white'), hp = v.add(k.filter('highpass', 700, 0.7)), lp = v.add(k.filter('lowpass', 5200, 0)), g = v.add(k.gain(0.45));
    n.connect(hp); hp.connect(lp); lp.connect(g); g.connect(inp);
    const b = k.noise(v, 'brown'), bl = v.add(k.filter('lowpass', 180, 0)), bh = v.add(k.filter('highpass', 55, 0)), bg = v.add(k.gain(0.35));
    b.connect(bl); bl.connect(bh); bh.connect(bg); bg.connect(inp);
    v.src(n, t, t + dur, Math.random()); v.src(b, t, t + dur, Math.random() * 3);
    return v.seal();
  },
  /** Air whoosh of something passing close (Doppler, pan, filter sweep). */
  whoosh(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 1.5, dir = o.dir || (Math.random() < 0.5 ? -1 : 1);
    const mc = motion({ dur, speed: o.speed || 18, near: 1.4 * (o.dist || 1), dir }), inp = k.move(v, t, mc, 0.12);
    const n = k.noise(v, 'pink'), bp = v.add(k.filter('bandpass', 900, 0.6)), g = v.add(k.gain(1.1));
    try { n.playbackRate.setValueCurveAtTime(mc.rate, t, mc.dur); bp.frequency.setValueCurveAtTime(scaled(mc.gain, 2600 / Math.max(1e-3, peakOf([mc.gain])), 1.5).map((x) => x + 350), t, mc.dur); } catch (e) { /* ignore */ }
    n.connect(bp); bp.connect(g); g.connect(inp);
    const b = k.noise(v, 'brown'), bl = v.add(k.filter('lowpass', 240, 0)), bh = v.add(k.filter('highpass', 65, 0)), bg = v.add(k.gain(0.3));
    b.connect(bl); bl.connect(bh); bh.connect(bg); bg.connect(inp);
    v.src(n, t, t + mc.dur, Math.random() * 3); v.src(b, t, t + mc.dur, Math.random() * 3);
    return v.seal();
  },
  /** Drivetrain whirr one-shot (cadence 95, 38 km/h). */
  chain(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 2.6, inp = k.place(v, Object.assign({ send: 0.05 }, o)), env = v.add(k.gain(0));
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.4); env.gain.setValueAtTime(1, t + dur - 0.6); env.gain.linearRampToValueAtTime(0, t + dur);
    env.connect(inp);
    const d = new Drivetrain(k, v, env);
    d.set(t, o.w || 300, o.cad || 95, o.kph || 38, 0.02, 1.6);
    d.start(v, t, t + dur + 0.05);
    return v.seal();
  },
  /** The bunch goes by: tyre roar, freewheels, chains, shouts, a gear change. */
  peloton(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 7, dist = Math.max(1, o.dist || 1), dir = o.dir || (Math.random() < 0.5 ? -1 : 1), r = makeRng(hashSeed(o.seed == null ? Math.random() : o.seed));
    const speed = o.speed || rr(r, 11.5, 13.5), near = 2.2 * dist, len = rr(r, 25, 45), tc = rr(r, 1.8, 2.4), N = 96;
    const riders = [];
    for (let i = 0; i < 40; i++) riders.push([Math.pow(r(), 1.3) * len, near + rr(r, 0, 6)]);
    const g = new Float32Array(N), pan = new Float32Array(N), rate = new Float32Array(N), lp = new Float32Array(N);
    let gm = 0;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1), tt = u * dur;
      let E = 0, P = 0, Rt = 0;
      for (const rd of riders) { const x = speed * (tt - tc) - rd[0], d2 = x * x + rd[1] * rd[1], d = Math.sqrt(d2), w = 1 / d2; E += w; P += (w * x) / d; Rt += (w * C_SOUND) / (C_SOUND + (speed * x) / d); }
      const e = Math.min(1, u / 0.07, (1 - u) / 0.1), edge = e * e * (3 - 2 * e);
      g[i] = Math.sqrt(E) * edge; pan[i] = clamp((dir * P) / E, -1, 1) * 0.9; rate[i] = Rt / E;
      if (g[i] > gm) gm = g[i];
    }
    const gRef = Math.pow(1 / dist, 0.9);
    for (let i = 0; i < N; i++) { g[i] = (g[i] / gm) * gRef; lp[i] = clamp(18000 * Math.pow(g[i] / gRef, 0.9) * Math.pow(1 / dist, 0.6), 500, 18000); }
    const mc = { N, dur, gain: g, pan, lp, rate };
    const inp = k.move(v, t, mc, clamp(0.12 + 0.1 * Math.log2(dist), 0.1, 0.6));
    // tyre + air roar
    const n = k.noise(v, 'white'), hp = v.add(k.filter('highpass', 380, 0.7)), hl = v.add(k.filter('lowpass', 6500, 0)), hg = v.add(k.gain(0.5));
    n.connect(hp); hp.connect(hl); hl.connect(hg); hg.connect(inp); v.src(n, t, t + dur, r() * 1.5);
    const b = k.noise(v, 'brown'), bl = v.add(k.filter('lowpass', 260, 0)), bh = v.add(k.filter('highpass', 60, 0)), bg = v.add(k.gain(0.3));
    b.connect(bl); bl.connect(bh); bh.connect(bg); bg.connect(inp); v.src(b, t, t + dur, r() * 3);
    const sing = v.add(k.filter('bandpass', 1300, 1.2)), sg = v.add(k.gain(0.35)); n.connect(sing); sing.connect(sg); sg.connect(inp);
    // chains
    for (let c = 0; c < 2; c++) {
      const cn = k.noise(v, 'white'), cb = v.add(k.filter('bandpass', rr(r, 1800, 2800), 2.5)), am = v.add(k.gain(0.5)), lfo = k.osc('square', rr(r, 70, 90)), ld = v.add(k.gain(0.45)), cg = v.add(k.gain(0.6));
      lfo.connect(ld); ld.connect(am.gain); cn.connect(cb); cb.connect(am); am.connect(cg); cg.connect(inp);
      v.src(cn, t, t + dur, r() * 1.5); v.src(lfo, t, t + dur);
    }
    // individual freewheels (coasting riders) with their own pass-by
    const fwOut = v.add(k.gain(1)); fwOut.connect(v.out);
    for (let i = 0; i < 7; i++) {
      const rd = riders[(r() * riders.length) | 0], rtc = tc + rd[0] / speed, fmc = motion({ dur, tc: rtc, speed, near: rd[1], dir, gain: gRef * 0.8 });
      const s = v.add(k.ctx.createBufferSource()); s.buffer = k.fwLoop(true, i % 3); s.loop = true;
      const clickRate = ((speed / 2.1) * 24) / 110 * rr(r, 0.85, 1.15);
      try { s.playbackRate.setValueCurveAtTime(scaled(fmc.rate, clickRate), t, dur); } catch (e) { /* ignore */ }
      const coast = v.add(k.gain(0)), c0 = t + rtc - rr(r, 0.8, 1.5), c1 = c0 + rr(r, 0.8, 2);
      coast.gain.setValueAtTime(0, t); coast.gain.setValueAtTime(0, Math.max(t, c0)); coast.gain.linearRampToValueAtTime(0.8, Math.max(t, c0) + 0.08); coast.gain.setValueAtTime(0.8, Math.max(t + 0.1, c1)); coast.gain.linearRampToValueAtTime(0, Math.max(t + 0.1, c1) + 0.1);
      s.connect(coast); coast.connect(k.move(v, t, fmc, 0.1));
      v.src(s, t, t + dur, r());
    }
    // voices and a gear change
    const lang = o.lang || 'fr';
    const list = SHOUT_BY_LANG[lang] || SHOUT_BY_LANG.fr;
    const ns = o.shouts == null ? 2 : o.shouts;
    for (let i = 0; i < ns; i++) {
      const at = tc + rr(r, -0.2, 1.8), sb = k.shoutBuf(pick(r, list), i % 3), s = v.add(k.ctx.createBufferSource()), p = v.add(k.panner(dir * clamp((speed * (at - tc) - 4) / 8, -0.9, 0.9))), sg = v.add(k.gain(0.55 * gRef));
      s.buffer = sb; s.connect(sg); sg.connect(p); p.connect(v.out); v.src(s, t + at, t + at + sb.duration + 0.05);
    }
    for (let i = 0; i < 2; i++) {
      const at = tc + rr(r, -0.3, 1.5), sb = k.get('shift', i);
      const s = v.add(k.ctx.createBufferSource()), sg = v.add(k.gain(0.3 * gRef)), p = v.add(k.panner(dir * rr(r, -0.5, 0.5)));
      s.buffer = sb; s.connect(sg); sg.connect(p); p.connect(v.out); v.src(s, t + at, t + at + 0.5);
    }
    return v.seal();
  },
  /** Two-tone caravan horn: "pou-et" formant glide on detuned saw/square. */
  'caravan-horn'(k, t, o) {
    const v = k.voice('sfx', o), inp = k.place(v, Object.assign({ dist: 1.5 }, o)), f = o.f || 400 + (seedOf(o, 8) * 30);
    hornNote(k, v, inp, t, f, 0.22, { pouet: true, amp: 0.8 });
    hornNote(k, v, inp, t + 0.29, f * 1.26, 0.3, { pouet: true, amp: 0.8 });
    return v.seal();
  },
  /** Publicity caravan: a few vehicles rolling by, each with its own horn. */
  caravan(k, t, o) {
    const v = k.voice('sfx', o), dist = Math.max(1, o.dist || 1.5), dir = o.dir || 1, r = makeRng(hashSeed(o.seed == null ? Math.random() : o.seed));
    const nV = 3 + ((r() * 2) | 0);
    let at = 0;
    for (let i = 0; i < nV; i++) {
      const dur = 5, mc = motion({ dur, speed: rr(r, 7, 9), near: 3.5 * dist, dir }), inp = k.move(v, t + at, mc);
      const f = rr(r, 340, 640), pat = (r() * 4) | 0, h0 = at + rr(r, 1.7, 2.3);
      const hn = (tt, ff, d) => hornNote(k, v, inp, t + tt, ff * mc.rateAt(tt - at), d, { pouet: true, amp: 0.95 });
      if (pat === 0) { hn(h0, f, 0.2); hn(h0 + 0.28, f, 0.26); }
      else if (pat === 1) { hn(h0, f, 0.14); hn(h0 + 0.2, f, 0.14); hn(h0 + 0.4, f, 0.28); }
      else if (pat === 2) { for (let q = 0; q < 4; q++) hn(h0 + q * 0.3, q % 2 ? f * 1.335 : f, 0.24); }
      else { hn(h0, f, 0.55); }
      const eng = k.noise(v, 'brown'), el = v.add(k.filter('lowpass', 320, 0)), eh = v.add(k.filter('highpass', 70, 0)), eg = v.add(k.gain(0.1));
      eng.connect(el); el.connect(eh); eh.connect(eg); eg.connect(inp); v.src(eng, t + at, t + at + dur, r() * 3);
      at += rr(r, 1.8, 2.8);
    }
    return v.seal();
  },
  /** The Rodania-style car: an original trumpet fanfare from its roof loudspeaker, driving past. */
  rodania(k, t, o) {
    const v = k.voice('sfx', o), dist = Math.max(1, o.dist || 1.3), dur = o.dur || 6.5, dir = o.dir || (Math.random() < 0.5 ? -1 : 1);
    const mc = motion({ dur, tc: dur * 0.5, speed: 9.5, near: 4 * dist, dir }), inp = k.move(v, t, mc, 0.25);
    // the car's horn loudspeaker: band-limited, a little driven
    const hp = v.add(k.filter('highpass', 350, 0.7)), pk = v.add(k.filter('peaking', 2000, 1, 6)), sh = v.add(k.shaper(1.8)), lp = v.add(k.filter('lowpass', 4800, 0)), lv = v.add(k.gain(1.3));
    hp.connect(pk); pk.connect(sh); sh.connect(lp); lp.connect(lv); lv.connect(inp);
    const tr = o.transpose || 0;
    for (const start of [0.35, 2.75]) {
      for (const nt of FANFARE) {
        const at = start + nt[0], f = midiHz(nt[1] + tr) * mc.rateAt(at);
        trumpetNote(k, v, hp, t + at, f, nt[2] + 0.03, nt[2] > 0.3);
      }
    }
    const eng = k.noise(v, 'brown'), el = v.add(k.filter('lowpass', 320, 0)), eh = v.add(k.filter('highpass', 70, 0)), eg = v.add(k.gain(0.12));
    eng.connect(el); el.connect(eh); eh.connect(eg); eg.connect(inp); v.src(eng, t, t + dur, Math.random() * 3);
    return v.seal();
  },
  /** Team car toot: two electric horns sounding together. */
  'car-horn'(k, t, o) {
    const v = k.voice('sfx', o), inp = k.place(v, Object.assign({ dist: 1.8 }, o));
    const note = (at, d) => hornNote(k, v, inp, t + at, 420, d, { types: ['square', 'square'], det: [0, 330], scoop: -20, drive: 2.5, amp: 0.35, formant: 1800 });
    note(0, 0.12); note(0.2, 0.2);
    return v.seal();
  },
  car(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 4.5, dir = o.dir || (Math.random() < 0.5 ? -1 : 1), mc = motion({ dur, speed: o.speed || 14, near: 4 * (o.dist || 1), dir }), inp = k.move(v, t, mc);
    const f = rr(Math.random, 70, 95), os = k.osc('sawtooth', f), ol = v.add(k.filter('lowpass', 420, 1)), og = v.add(k.gain(0.3));
    try { os.frequency.setValueCurveAtTime(scaled(mc.rate, f), t, dur); } catch (e) { /* ignore */ }
    os.connect(ol); ol.connect(og); og.connect(inp); v.src(os, t, t + dur);
    const n = k.noise(v, 'white'), hp = v.add(k.filter('highpass', 600, 0.7)), nl = v.add(k.filter('lowpass', 4000, 0)), ng = v.add(k.gain(0.3));
    n.connect(hp); hp.connect(nl); nl.connect(ng); ng.connect(inp); v.src(n, t, t + dur, Math.random());
    return v.seal();
  },
  /** Race motorbike (boxer twin) or a two-stroke scooter passing. */
  motorbike(k, t, o) {
    const scooter = o.kind === 'scooter', v = k.voice('sfx', o), dur = o.dur || 5, dir = o.dir || (Math.random() < 0.5 ? -1 : 1);
    const f = scooter ? rr(Math.random, 95, 130) : rr(Math.random, 62, 82);
    const mc = motion({ dur, speed: scooter ? 11 : rr(Math.random, 16, 21), near: 3 * (o.dist || 1), dir }), inp = k.move(v, t, mc);
    const o1 = k.osc('sawtooth', f), o2 = k.osc('square', f / 2), g1 = v.add(k.gain(0.5)), g2 = v.add(k.gain(scooter ? 0.04 : 0.12)), sh = v.add(k.shaper(3)), lp = v.add(k.filter('lowpass', scooter ? 2200 : 1500, 1)), pk = v.add(k.filter('peaking', scooter ? 900 : 480, 1.2, 5)), hp = v.add(k.filter('highpass', 95, 0)), eg = v.add(k.gain(scooter ? 0.3 : 0.4));
    try { o1.frequency.setValueCurveAtTime(scaled(mc.rate, f), t, dur); o2.frequency.setValueCurveAtTime(scaled(mc.rate, f / 2), t, dur); } catch (e) { /* ignore */ }
    o1.connect(g1); o2.connect(g2); g1.connect(sh); g2.connect(sh); sh.connect(lp); lp.connect(pk); const hp2 = v.add(k.filter('highpass', 95, 0)); pk.connect(hp); hp.connect(hp2); hp2.connect(eg); eg.connect(inp);
    const n = k.noise(v, 'white'), nb = v.add(k.filter('bandpass', scooter ? 700 : 350, 0.9)), am = v.add(k.gain(0.3)), ad = v.add(k.gain(0.25));
    o1.connect(ad); ad.connect(am.gain); n.connect(nb); nb.connect(am); am.connect(inp);
    v.src(o1, t, t + dur); v.src(o2, t, t + dur); v.src(n, t, t + dur, Math.random());
    return v.seal();
  },
  scooter(k, t, o) { return SYN.motorbike(k, t, Object.assign({}, o, { kind: 'scooter' })); },
  /** TV helicopter hovering or crossing slowly, far away. */
  helicopter(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 14, dir = o.dir || (Math.random() < 0.5 ? -1 : 1), dist = Math.max(1, o.dist || 6);
    const mc = motion({ dur, speed: 12, near: 6 * dist, dir }), inp = k.move(v, t, mc, 0.3);
    const s = v.add(k.ctx.createBufferSource()); s.buffer = k.get('heli', 0); s.loop = true;
    try { s.playbackRate.setValueCurveAtTime(mc.rate, t, dur); } catch (e) { /* ignore */ }
    const g = v.add(k.gain(Math.pow(dist, -0.2) * 2.2)); s.connect(g); g.connect(inp); v.src(s, t, t + dur, Math.random() * 2);
    return v.seal();
  },
  /** Time trial rider on a disc wheel: deep "wom wom" plus chain and air. */
  disc(k, t, o) {
    const v = k.voice('sfx', o), dur = o.dur || 2.8, dir = o.dir || (Math.random() < 0.5 ? -1 : 1), mc = motion({ dur, tc: o.tc, speed: o.speed || 14, near: 2.2 * (o.dist || 1), dir }), inp = k.move(v, t, mc, 0.12);
    const b = k.noise(v, 'brown'), bl = v.add(k.filter('lowpass', 420, 0)), bh = v.add(k.filter('highpass', 60, 0)), am = v.add(k.gain(0.6)), lfo = k.osc('sine', 6.8), ld = v.add(k.gain(0.35)), bg = v.add(k.gain(1.1));
    lfo.connect(ld); ld.connect(am.gain); b.connect(bl); bl.connect(bh); bh.connect(am); am.connect(bg); bg.connect(inp);
    const n = k.noise(v, 'white'), nb = v.add(k.filter('bandpass', 1400, 0.6)), ng = v.add(k.gain(0.3));
    n.connect(nb); nb.connect(ng); ng.connect(inp);
    const d = new Drivetrain(k, v, inp); d.set(t, 420, 98, 50, 0.02, 1);
    v.src(b, t, t + dur, Math.random() * 3); v.src(lfo, t, t + dur); v.src(n, t, t + dur, Math.random()); d.start(v, t, t + dur);
    return v.seal();
  },
  'mtb-rider'(k, t, o) { return k.playBuf(k.get('mtb', seedOf(o, 2)), t, Object.assign({ doppler: { speed: 6.5, near: 2.5 * (o.dist || 1) } }, o)); },
  /** TT start: the last beeps of the start clock, then the rider sprints away. */
  'tt-start'(k, t, o) {
    SYN['tt-clock'](k, t, Object.assign({}, o, { offset: 2 }));
    SYN.shift(k, t + 3.35, Object.assign({}, o, { gainDb: (o.gainDb || 0) - 6, dist: 1.3 }));
    return SYN.disc(k, t + 3.0, Object.assign({}, o, { tc: 0.25, speed: 7, dur: 3.2, dir: o.dir || 1 }));
  },
};

// ============================================================================
// 4. Scenes: ambience beds + sparse random events
// ============================================================================

const LANG_OF = { be: 'nl', nl: 'nl', lu: 'lu', fr: 'fr', de: 'de', es: 'es', it: 'it', gr: 'gr', ch: 'de', hr: 'hr', si: 'hr', hu: 'hu', ru: 'ru', kr: 'kr', th: 'th', uk: 'en', mtb: 'de', tt: 'de', wall: 'de' };
// ev: [synth, events per minute, distance, extra opts]
const SCENES = {
  wall: { ir: 'street', bed: { wind: 0.22, crowd: 0.06, road: 0.05, leaves: 0.05 }, ev: [['cowbells', 1.0, 9], ['motorbike', 1.0, 7], ['helicopter', 0.5, 7], ['rodania', 0.3, 7], ['caravan', 0.35, 6], ['peloton', 0.55, 6], ['bird', 1.8, 4], ['bell', 0.3, 9], ['cheer', 0.4, 8], ['speaker', 0.5, 9]] },
  be: { ir: 'street', bed: { wind: 0.45, crowd: 0.3, road: 0.08 }, ev: [['peloton', 1.4, 2.5], ['speaker', 3, 3], ['cheer', 1.2, 3], ['bell', 0.6, 4], ['rodania', 0.5, 3], ['motorbike', 1.4, 3], ['car-horn', 0.8, 4]] },
  nl: { ir: 'street', bed: { wind: 0.65, crowd: 0.25, road: 0.06 }, ev: [['peloton', 1.4, 2.5], ['speaker', 3, 3], ['bike-bell', 1.5, 3], ['cheer', 1, 3], ['motorbike', 1, 3]] },
  lu: { ir: 'street', bed: { wind: 0.3, crowd: 0.22, road: 0.06 }, ev: [['speaker', 2.5, 3], ['church-bell', 0.5, 8], ['peloton', 1.2, 2.5], ['cheer', 1, 3], ['motorbike', 1, 3]] },
  fr: { ir: 'street', bed: { wind: 0.3, crowd: 0.3, road: 0.06 }, ev: [['caravan', 1.6, 2], ['radio', 2.2, 2], ['helicopter', 0.8, 5], ['motorbike', 1.5, 3], ['peloton', 1, 2.5], ['cheer', 1.2, 3], ['shout', 2, 3]] },
  de: { ir: 'street', bed: { wind: 0.3, crowd: 0.28, road: 0.06 }, ev: [['speaker', 3.5, 3], ['bell', 1, 4], ['peloton', 1.5, 2.5], ['cheer', 1, 3], ['motorbike', 1, 3], ['applause', 0.8, 3]] },
  es: { ir: 'street', bed: { wind: 0.35, crowd: 0.22, road: 0.05 }, ev: [['speaker', 2, 3], ['swift', 3, 3], ['car-horn', 1, 4], ['peloton', 1, 2.5], ['motorbike', 1.2, 3], ['church-bell', 0.4, 8], ['shout', 1.5, 3]] },
  it: { ir: 'street', bed: { wind: 0.3, crowd: 0.25, road: 0.05 }, ev: [['speaker', 2, 3], ['car-horn', 1.2, 4], ['scooter', 1.2, 3], ['peloton', 1, 2.5], ['church-bell', 0.4, 8], ['cheer', 1, 3], ['shout', 1.5, 3]] },
  gr: { ir: 'street', bed: { wind: 0.45, sea: 0.25, crowd: 0.15 }, ev: [['speaker', 1.5, 4], ['cowbells', 0.8, 6], ['peloton', 1, 2.5], ['motorbike', 1, 3], ['gull', 0.8, 5]] },
  ch: { ir: 'street', bed: { wind: 0.3, crowd: 0.2, road: 0.04 }, ev: [['cowbells', 3, 2.5], ['speaker', 1.5, 4], ['peloton', 1.2, 2.5], ['cheer', 1, 3], ['shout', 1.5, 3]] },
  hr: { ir: 'street', bed: { wind: 0.4, sea: 0.3, crowd: 0.15 }, ev: [['gull', 2, 4], ['speaker', 1.5, 4], ['peloton', 1, 2.5], ['motorbike', 1, 3]] },
  si: { ir: 'street', bed: { wind: 0.3, crowd: 0.2, road: 0.05 }, ev: [['church-bell', 0.6, 8], ['cowbells', 1, 6], ['speaker', 1.5, 4], ['peloton', 1, 2.5]] },
  hu: { ir: 'forest', bed: { leaves: 0.35, wind: 0.2, crowd: 0.12 }, ev: [['bird', 3, 3], ['speaker', 1.2, 5], ['peloton', 1, 2.5], ['motorbike', 0.8, 3]] },
  ru: { ir: 'street', bed: { traffic: 0.3, wind: 0.3, crowd: 0.15 }, ev: [['speaker', 2, 4], ['car', 2, 4], ['peloton', 1, 2.5], ['motorbike', 1, 3]] },
  kr: { ir: 'street', bed: { traffic: 0.25, wind: 0.2, crowd: 0.2 }, ev: [['speaker', 2.5, 3], ['peloton', 1, 2.5], ['cheer', 1, 3], ['motorbike', 1, 3], ['bird', 1, 4]] },
  th: { ir: 'street', bed: { insects: 0.2, traffic: 0.15, wind: 0.15, crowd: 0.2 }, insects: 'cicada', ev: [['koel', 1.5, 5], ['scooter', 2, 3], ['speaker', 2, 4], ['peloton', 1, 2.5]] },
  uk: { ir: 'street', bed: { wind: 0.35, crowd: 0.15, leaves: 0.1 }, ev: [['applause', 1.2, 3], ['speaker', 1.5, 4], ['bird', 2, 4], ['peloton', 1, 2.5], ['motorbike', 0.8, 3]] },
  mtb: { ir: 'forest', bed: { insects: 0.3, leaves: 0.25, generator: 0.14, crowd: 0.05 }, insects: 'cricket', ev: [['owl', 1, 6], ['mtb-rider', 3, 1.5], ['speaker', 0.8, 8], ['cheer', 0.4, 8]] },
  tt: { ir: 'street', bed: { wind: 0.25, crowd: 0.18, road: 0.05 }, ev: [['tt-start', 1.5, 1.8], ['disc', 2, 2], ['speaker', 2, 3], ['motorbike', 1, 3], ['car', 1, 3]] },
};
const BIG = { peloton: 1, rodania: 1, caravan: 1, helicopter: 1, 'tt-start': 1, radio: 1, speaker: 1 };

/** Scene bed: continuous layers + random events, crossfaded on scene changes. */
class Bed {
  constructor(k, id, mods) {
    const def = SCENES[id] || SCENES.wall;
    this.k = k; this.id = id; this.def = def; this.lang = LANG_OF[id] || 'de';
    this.v = k.voice('amb', { gain: 0 }, 'bed');
    this.out = this.v.out;
    this.r = makeRng(hashSeed(id) ^ ((Math.random() * 1e9) | 0));
    this.mods = mods || {};
    this.gusts = []; this.sea = null; this.crowd = null; this.nextBlip = 0; this.lastBig = -99;
    const t = k.now, bed = Object.assign({}, def.bed), m = this.mods;
    if (m.wind != null) bed.wind = (bed.wind || 0.2) * m.wind;
    if (m.crowd != null) bed.crowd = (bed.crowd || 0.1) * m.crowd;
    if (m.rain) bed.rain = 0.35 * m.rain;
    if (m.insects) { bed.insects = bed.insects || 0.2; }
    const ins = m.insects || def.insects;
    for (const key of Object.keys(bed)) if (bed[key] > 0) this['_' + key] && this['_' + key](bed[key], t, ins);
    const far = id === 'wall';
    this.ev = (def.ev || []).map((e) => ({ name: e[0], rate: e[1], dist: e[2], big: !!BIG[e[0]], next: t + (far ? rr(this.r, 3, 0.5 * 60 / e[1]) : rr(this.r, 2, 0.6 * 60 / e[1])) }));
  }
  _src(buf, loop, off) { const s = this.v.add(this.k.ctx.createBufferSource()); s.buffer = buf; s.loop = loop !== false; this.v.src(s, this.k.now, null, off == null ? Math.random() * Math.max(0, buf.duration - 0.1) : off); return s; }
  _wind(lvl) {
    const k = this.k, v = this.v, s = this._src(k.pink()), lp = v.add(k.filter('lowpass', 500, 0)), hp = v.add(k.filter('highpass', 75, 0)), wh = v.add(k.filter('bandpass', 1100, 8)), whg = v.add(k.gain(0.12)), g = v.add(k.gain(lvl * 0.6));
    s.connect(lp); lp.connect(hp); hp.connect(g); s.connect(wh); wh.connect(whg); whg.connect(g); g.connect(this.out);
    this.gusts.push({ g, lp, lvl, next: 0, wh });
  }
  _leaves(lvl) {
    const k = this.k, v = this.v, s = this._src(k.pink()), bp = v.add(k.filter('bandpass', 3800, 0.5)), hp = v.add(k.filter('highpass', 1200, 0.7)), g = v.add(k.gain(lvl * 0.5));
    s.connect(bp); bp.connect(hp); hp.connect(g); g.connect(this.out);
    this.gusts.push({ g, lp: null, lvl: lvl * 1.2, next: 0 });
  }
  _road(lvl) { const k = this.k, v = this.v, s = this._src(k.brown()), lp = v.add(k.filter('lowpass', 240, 0)), hp = v.add(k.filter('highpass', 75, 0)), g = v.add(k.gain(lvl * 0.8)); s.connect(lp); lp.connect(hp); hp.connect(g); g.connect(this.out); }
  _traffic(lvl) {
    const k = this.k, v = this.v, s = this._src(k.brown()), lp = v.add(k.filter('lowpass', 450, 0)), g = v.add(k.gain(lvl));
    const p = this._src(k.pink()), bp = v.add(k.filter('bandpass', 900, 0.5)), pg = v.add(k.gain(lvl * 0.25));
    s.connect(lp); lp.connect(g); g.connect(this.out); p.connect(bp); bp.connect(pg); pg.connect(this.out);
    this.gusts.push({ g, lp: null, lvl, next: 0, slow: true });
  }
  _rain(lvl) {
    const k = this.k, v = this.v, s = this._src(k.white()), hp = v.add(k.filter('highpass', 900, 0.7)), lp = v.add(k.filter('lowpass', 9000, 0)), g = v.add(k.gain(lvl * 0.35));
    s.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.out);
    const b = this._src(k.brown()), bl = v.add(k.filter('lowpass', 300, 0)), bg = v.add(k.gain(lvl * 0.4));
    b.connect(bl); bl.connect(bg); bg.connect(this.out);
  }
  _sea(lvl) {
    const k = this.k, v = this.v, s = this._src(k.brown()), lp = v.add(k.filter('lowpass', 500, 0)), g = v.add(k.gain(lvl * 0.3));
    const p = this._src(k.pink()), hp = v.add(k.filter('highpass', 1500, 0.7)), hg = v.add(k.gain(lvl * 0.05));
    s.connect(lp); lp.connect(g); g.connect(this.out); p.connect(hp); hp.connect(hg); hg.connect(this.out);
    this.sea = { g, hg, lvl, next: 0 };
  }
  /** Start a looped cached buffer now if rendered, else after an idle-time render. */
  _loopLayer(name, connect) {
    const k = this.k, key = name + ':0';
    if (k.cache.has(key) || k.offline) { connect(this._src(k.get(name, 0))); return; }
    (this.pending || (this.pending = [])).push({ key, connect });
    (k.warmQ || (k.warmQ = [])).unshift(() => k.get(name, 0));
    k.warm([], null);
  }
  _insects(lvl, t, kind) {
    const cr = kind === 'cricket', g = this.v.add(this.k.gain(lvl * (cr ? 0.5 : 0.35)));
    g.connect(this.out);
    this._loopLayer(cr ? 'crickets' : 'cicadas', (s) => s.connect(g));
  }
  _generator(lvl) {
    const k = this.k, v = this.v, lp = v.add(k.filter('lowpass', 700, 0)), g = v.add(k.gain(lvl * 0.8));
    lp.connect(g); g.connect(this.out);
    this._loopLayer('gen', (s) => s.connect(lp));
  }
  _crowd(lvl) {
    const k = this.k, v = this.v, s = this._src(k.white()), sum = v.add(k.gain(1)), lp = v.add(k.filter('lowpass', 3000, 0)), hp = v.add(k.filter('highpass', 150, 0)), g = v.add(k.gain(lvl * 0.5));
    this.crowd = { lvl, bands: [], g, mur: null, murG: v.add(k.gain(0)) };
    for (const b of [[260, 1.2, 0.5], [520, 1.5, 0.45], [1000, 1.6, 0.3], [2200, 2, 0.12]]) {
      const f = v.add(k.filter('bandpass', b[0], b[1])), bg = v.add(k.gain(b[2]));
      s.connect(f); f.connect(bg); bg.connect(sum); this.crowd.bands.push({ g: bg, base: b[2], next: 0 });
    }
    sum.connect(lp); lp.connect(hp); hp.connect(g); g.connect(this.out);
    this.crowd.murG.connect(this.out);
  }
  fade(to, dur) {
    const g = this.out.gain, t = this.k.now;
    try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.setTargetAtTime(to, t, dur / 3); } catch (e) { /* ignore */ }
  }
  stop(dur) { this.fade(0, dur); this.stopped = true; this.k.later(() => this.v.dispose(), dur + 0.5); }
  /** Called ~5x per second with lookahead; schedules modulation and events. */
  tick(now, horizon) {
    const k = this.k, r = this.r;
    if (this.pending && this.pending.length) {
      for (let i = this.pending.length - 1; i >= 0; i--) { const p = this.pending[i]; if (k.cache.has(p.key)) { p.connect(this._src(k.cache.get(p.key))); this.pending.splice(i, 1); } }
    }
    for (let i = 0; i < this.gusts.length; i++) {
      const gu = this.gusts[i];
      if (now < gu.next) continue;
      const x = gu.lvl * (0.35 + 0.65 * Math.pow(r(), 1.3)), tc = gu.slow ? rr(r, 2, 4) : rr(r, 0.6, 1.6);
      gu.g.gain.setTargetAtTime(x * 0.6, now, tc);
      if (gu.lp) gu.lp.frequency.setTargetAtTime(250 + 1100 * (x / gu.lvl), now, tc * 1.3);
      gu.next = now + (gu.slow ? rr(r, 4, 9) : rr(r, 1.2, 4));
    }
    if (this.sea && now >= this.sea.next) {
      const s = this.sea, pk = s.lvl * rr(r, 0.35, 0.6);
      s.g.gain.setTargetAtTime(pk, now, 0.9); s.g.gain.setTargetAtTime(s.lvl * 0.12, now + 2.2, 1.3);
      s.hg.gain.setTargetAtTime(s.lvl * rr(r, 0.12, 0.25), now + 1.7, 0.2); s.hg.gain.setTargetAtTime(s.lvl * 0.03, now + 2.5, 0.9);
      s.next = now + rr(r, 5.5, 9);
    }
    const c = this.crowd;
    if (c) {
      for (const b of c.bands) if (now >= b.next) { b.g.gain.setTargetAtTime(b.base * rr(r, 0.5, 1.3), now, rr(r, 0.4, 1.2)); b.next = now + rr(r, 0.5, 2); }
      if (!c.mur) {
        const m = k.murmur();
        if (m) { c.mur = this._src(m, true); c.mur.connect(c.murG); c.murG.gain.setTargetAtTime(c.lvl * 1.1, now, 1.5); }
      }
      if (now >= this.nextBlip) {
        const at = Math.max(now, this.nextBlip);
        k.playBuf(k.blip((r() * 12) | 0), at, { dest: this.out, gain: c.lvl * rr(r, 0.4, 1), dist: rr(r, 1.5, 4), pan: rr(r, -0.9, 0.9) });
        this.nextBlip = at + expo(r, 1 / (0.6 + c.lvl * 6));
      }
    }
    if (this.stopped) return;
    for (let i = 0; i < this.ev.length; i++) {
      const e = this.ev[i];
      if (e.next > now + horizon) continue;
      const when = Math.max(e.next, now + 0.05);
      if (!(e.big && when - this.lastBig < 6)) {
        if (e.big) this.lastBig = when;
        const dist = e.dist * rr(r, 0.8, 1.3);
        const o = { dist, pan: rr(r, -0.8, 0.8), dir: r() < 0.5 ? -1 : 1, lang: this.lang, scene: this.id, seed: (r() * 1e6) | 0, gainDb: this.id === 'wall' ? -3 : 0 };
        if (k.engine) k.engine._fire(e.name, when, o); else fire(k, e.name, when, o);
      }
      e.next = when + Math.max(1.5, expo(r, 60 / e.rate));
    }
  }
}
function fire(k, name, t, o) {
  const f = SYN[name];
  if (!f) return null;
  try { return f(k, t, o || {}); } catch (e) { warn(e); return null; }
}

// Scene stings for open(): what you hear when you "jump into" a race.
const STINGS = {
  be: (A, t) => { A._fire('rodania', t + 0.15, { dist: 1.2, tag: 'sting' }); return 3.6; },
  fr: (A, t) => { A._fire('radio', t + 0.1, { tag: 'sting', scene: 'fr', voice: 'radiotour' }); A._fire('caravan', t + 1.4, { dist: 1.2, tag: 'sting' }); return 5; },
  de: (A, t) => { A._fire('speaker', t + 0.1, { lang: 'de', scene: 'de', dist: 2, tag: 'sting', voice: 'achtung' }); A._fire('bell', t + 2.2, { dist: 2, tag: 'sting' }); return 3.4; },
  nl: (A, t) => { A._fire('speaker', t + 0.1, { lang: 'nl', scene: 'nl', dist: 2, tag: 'sting', voice: 'opgelet' }); A._fire('bike-bell', t + 1.8, { dist: 1.6, tag: 'sting' }); return 3.2; },
  lu: (A, t) => { A._fire('speaker', t + 0.1, { lang: 'lu', scene: 'lu', dist: 2, tag: 'sting' }); A._fire('church-bell', t + 0.6, { dist: 6, tag: 'sting' }); return 3.2; },
  ch: (A, t) => { A._fire('cowbells', t + 0.1, { dist: 1.3, tag: 'sting' }); A._fire('shout', t + 0.8, { lang: 'de', word: 'hopp', tag: 'sting' }); return 2.6; },
  it: (A, t) => { A._fire('car-horn', t + 0.1, { tag: 'sting' }); A._fire('speaker', t + 0.5, { lang: 'it', scene: 'it', dist: 2, tag: 'sting' }); return 3.4; },
  es: (A, t) => { A._fire('speaker', t + 0.1, { lang: 'es', scene: 'es', dist: 2, tag: 'sting', voice: 'vamos' }); A._fire('shout', t + 1.4, { lang: 'es', tag: 'sting' }); return 3.2; },
  uk: (A, t) => { A._fire('applause', t + 0.1, { dist: 2, tag: 'sting' }); A._fire('speaker', t + 0.8, { lang: 'en', scene: 'uk', dist: 2.5, tag: 'sting' }); return 3.4; },
  mtb: (A, t) => { A._fire('owl', t + 0.2, { dist: 4, tag: 'sting' }); A._fire('mtb-rider', t + 0.9, { dist: 1, tag: 'sting' }); return 0; },
  tt: (A, t) => { A._fire('tt-start', t + 0.1, { dist: 1.2, tag: 'sting' }); return 0; },
  wall: () => 0,
};
function defaultSting(A, t, id) { A._fire('speaker', t + 0.1, { lang: LANG_OF[id] || 'de', scene: id, dist: 2.2, tag: 'sting' }); A._fire('cheer', t + 1.6, { dist: 2.5, tag: 'sting' }); return 3.4; }

// ============================================================================
// 5. Power replay sonification
// ============================================================================

function normSeries(s) {
  s = s || {};
  const n = Math.max((s.t || []).length, (s.w || []).length, (s.kph || []).length, (s.cad || []).length);
  const num = (a, i, d) => { const v = a ? +a[i] : NaN; return isFinite(v) ? v : d; };
  const t = new Float64Array(n), w = new Float32Array(n), cad = new Float32Array(n), kph = new Float32Array(n);
  let estKph = !s.kph || !s.kph.length, lastT = -Infinity;
  for (let i = 0; i < n; i++) {
    let ti = num(s.t, i, i);
    if (ti <= lastT) ti = lastT + 1e-3;
    lastT = ti; t[i] = ti;
    w[i] = Math.max(0, num(s.w, i, 0));
    cad[i] = Math.max(0, num(s.cad, i, w[i] > 0 ? 88 : 0));
    kph[i] = estKph ? Math.cbrt(Math.max(0, w[i]) / 0.192) * 3.6 : Math.max(0, num(s.kph, i, 0));
  }
  return { n, t, w, cad, kph };
}

/** Audio layers for the replay (drivetrain, air, tyres, freewheel). */
class ReplayVoice {
  constructor(k, dest) {
    const v = (this.v = k.voice('replay', { dest }, 'replay')), t = k.now + 0.02;
    this.k = k;
    this.drive = new Drivetrain(k, v, v.out);
    const p = k.noise(v, 'pink'), wl = v.add(k.filter('lowpass', 400, 0)); this.wind = v.add(k.gain(0)); this.windLp = wl;
    p.connect(wl); wl.connect(this.wind); this.wind.connect(v.out);
    const b = k.noise(v, 'brown'), bl = v.add(k.filter('lowpass', 200, 0)), bh = v.add(k.filter('highpass', 60, 0)); this.buffet = v.add(k.gain(0));
    b.connect(bl); bl.connect(bh); bh.connect(this.buffet); this.buffet.connect(v.out);
    const n = k.noise(v, 'white'), th = v.add(k.filter('highpass', 600, 0.7)); this.tyreLp = v.add(k.filter('lowpass', 3000, 0)); this.tyre = v.add(k.gain(0));
    n.connect(th); th.connect(this.tyreLp); this.tyreLp.connect(this.tyre); this.tyre.connect(v.out);
    this.fw = v.add(k.gain(0)); this.fw.connect(v.out);
    this.fwS = v.add(k.ctx.createBufferSource()); this.fwS.buffer = k.fwLoop(false, 0); this.fwS.loop = true;
    this.fwF = v.add(k.ctx.createBufferSource()); this.fwF.buffer = k.fwLoop(true, 0); this.fwF.loop = true;
    this.fwSg = v.add(k.gain(0)); this.fwFg = v.add(k.gain(0));
    this.fwS.connect(this.fwSg); this.fwF.connect(this.fwFg); this.fwSg.connect(this.fw); this.fwFg.connect(this.fw);
    this.drive.start(v, t, null);
    v.src(p, t, null, Math.random() * 3); v.src(b, t, null, Math.random() * 3); v.src(n, t, null, Math.random()); v.src(this.fwS, t, null); v.src(this.fwF, t, null);
    v.out.gain.value = 0; v.out.gain.setTargetAtTime(1, t, 0.15);
    this.ratio = 0; this.lastShift = -9;
  }
  update(t, w, cad, kph, tc) {
    const moving = kph > 2, coasting = w < 1 && moving;
    this.drive.set(t, w, cad, kph, tc, 1);
    const sp = clamp(kph / 45, 0, 1.8);
    this.wind.gain.setTargetAtTime(moving ? sp * sp * 0.35 : 0, t, tc);
    this.windLp.frequency.setTargetAtTime(200 + kph * 22, t, tc);
    this.buffet.gain.setTargetAtTime(moving ? sp * sp * 0.3 : 0, t, tc);
    this.tyre.gain.setTargetAtTime(moving ? sp * 0.1 : 0, t, tc);
    this.tyreLp.frequency.setTargetAtTime(1500 + kph * 80, t, tc);
    // freewheel: clicks/s = wheel revs/s x 24 engagement points
    const cps = (kph / 3.6 / 2.1) * 24;
    this.fw.gain.setTargetAtTime(coasting ? 0.5 : 0, t, coasting ? 0.03 : 0.06);
    const fast = cps > 60;
    this.fwSg.gain.setTargetAtTime(fast ? 0 : 1, t, 0.05); this.fwFg.gain.setTargetAtTime(fast ? 1 : 0, t, 0.05);
    this.fwS.playbackRate.setTargetAtTime(clamp(cps / 30, 0.3, 2.2), t, tc);
    this.fwF.playbackRate.setTargetAtTime(clamp(cps / 110, 0.5, 2.4), t, tc);
    // gear change: the speed/cadence ratio jumps while pedalling
    if (w > 30 && cad > 45 && kph > 8) {
      const ratio = kph / cad;
      if (this.ratio > 0 && Math.abs(ratio / this.ratio - 1) > 0.07 && t - this.lastShift > 1.3) { SYN.shift(this.k, t + 0.02, { bus: 'replay', gainDb: -10, seed: (Math.random() * 6) | 0 }); this.lastShift = t; }
      this.ratio += (ratio - this.ratio) * (this.ratio > 0 ? 0.5 : 1);
    }
  }
  stop(fade) { this.v.stop(fade || 0.25); }
}

/**
 * Controller returned by RaceAudio#replay.
 * @typedef {Object} ReplayController
 * @property {() => void} stop            Stop playback (fires onend with {completed:false}).
 * @property {(cb:(p:ReplayProgress)=>void) => ReplayController} onprogress  Per-frame progress (object is reused, copy if you keep it).
 * @property {(cb:(e:{completed:boolean})=>void) => ReplayController} onend  Called once at the end.
 * @property {(fraction:number) => void} seek  Jump to 0..1 of the series.
 * @typedef {Object} ReplayProgress
 * @property {number} fraction 0..1   @property {number} index  sample index
 * @property {number} t data time (s) @property {number} w watts
 * @property {number} cad rpm         @property {number} kph km/h
 */
class Replay {
  constructor(eng, series, o) {
    this.eng = eng; this.s = normSeries(series); this.speed = Math.max(0.1, (o && o.speed) || 60);
    this.prog = []; this.ends = []; this.i = 0; this.done = false; this.audio = null; this.lastAudio = 0;
    this.p = { fraction: 0, index: 0, t: 0, w: 0, cad: 0, kph: 0 };
    const S = this.s;
    this.t0 = S.n ? S.t[0] : 0; this.t1 = S.n ? S.t[S.n - 1] : 0;
    this.clock0 = nowMs(); this.base = this.t0; this.lastFrame = this.clock0;
    this._frame = this._frame.bind(this);
    this.paused = false;
    this.api = {
      stop: () => this._finish(false),
      onprogress: (cb) => { if (typeof cb === 'function') this.prog.push(cb); return this.api; },
      onend: (cb) => { if (typeof cb === 'function') this.ends.push(cb); return this.api; },
      seek: (f) => {
        this.base = this.t0 + clamp(+f || 0, 0, 1) * (this.t1 - this.t0); this.clock0 = nowMs(); this.i = 0;
        if (this.paused && !this.done && S.n >= 2) { this._sample(this.base); this._emit(); }
      },
      // WP8 patch: pause / resume / speed without losing the position
      pause: () => {
        if (this.done || this.paused) return;
        this.base = this._td(nowMs()); this.paused = true;
        this._cancel();
        if (this.audio) { this.audio.stop(0.2); this.audio = null; this.eng._duck(false); }
      },
      resume: () => {
        if (this.done || !this.paused) return;
        this.paused = false; this.clock0 = nowMs(); this.lastFrame = this.clock0;
        this._raf(this._frame);
      },
      setSpeed: (x) => {
        const now = nowMs();
        this.base = this._td(now); this.clock0 = now;
        this.speed = Math.max(0.1, +x || this.speed);
      },
      isPaused: () => this.paused,
      state: () => ({ playing: !this.done && !this.paused, paused: this.paused, done: this.done, speed: this.speed, fraction: this.p.fraction, t: this.p.t }),
    };
    if (S.n < 2) { setTimeout(() => this._finish(true), 0); return; }
    this._raf(this._frame);
  }
  _td(now) { return this.paused ? this.base : this.base + ((now - this.clock0) / 1000) * this.speed; }
  _cancel() { if (this.h) { if (HAS_WIN && window.cancelAnimationFrame) window.cancelAnimationFrame(this.h); clearTimeout(this.h); this.h = 0; } }
  _raf(fn) { if (HAS_WIN && window.requestAnimationFrame) this.h = window.requestAnimationFrame(fn); else this.h = setTimeout(fn, 33); }
  _frame() {
    if (this.done || this.paused) return;
    try {
      const now = nowMs();
      if (now - this.lastFrame > 250) this.clock0 += now - this.lastFrame - 16; // tab was hidden: pause
      this.lastFrame = now;
      const S = this.s, td = this._td(now);
      if (td >= this.t1) { this._sample(this.t1); this._emit(); this._finish(true); return; }
      this._sample(td); this._emit();
      const live = this.eng._live();
      if (live && !this.audio) { this.audio = new ReplayVoice(this.eng.kit, null); this.eng._duck(true); }
      if (this.audio && live && now - this.lastAudio > 45) {
        this.lastAudio = now;
        this.audio.update(this.eng.kit.now, this.p.w, this.p.cad, this.p.kph, 0.06);
      }
    } catch (e) { warn(e); }
    this._raf(this._frame);
  }
  _sample(td) {
    const S = this.s;
    let i = this.i;
    if (S.t[i] > td) i = 0;
    while (i < S.n - 2 && S.t[i + 1] <= td) i++;
    this.i = i;
    const a = S.t[i], b = S.t[i + 1], u = b > a ? clamp((td - a) / (b - a), 0, 1) : 0, p = this.p;
    // coasting is binary: use the nearest sample for watts == 0
    p.index = i; p.t = td; p.fraction = (td - this.t0) / Math.max(1e-9, this.t1 - this.t0);
    p.w = S.w[i] === 0 || S.w[i + 1] === 0 ? S.w[u < 0.5 ? i : i + 1] : S.w[i] + (S.w[i + 1] - S.w[i]) * u;
    p.cad = S.cad[i] + (S.cad[i + 1] - S.cad[i]) * u;
    p.kph = S.kph[i] + (S.kph[i + 1] - S.kph[i]) * u;
  }
  _emit() { for (let i = 0; i < this.prog.length; i++) { try { this.prog[i](this.p); } catch (e) { /* ignore */ } } }
  _finish(completed) {
    if (this.done) return;
    this.done = true;
    this._cancel();
    if (this.audio) { this.audio.stop(0.3); this.eng._duck(false); }
    if (this.eng._replay === this) this.eng._replay = null;
    const e = { completed };
    for (const cb of this.ends) { try { cb(e); } catch (er) { /* ignore */ } }
  }
}

// ============================================================================
// 6. Public engine
// ============================================================================

/** Scene ids understood by ambience() and open(). */
export const SCENE_IDS = Object.keys(SCENES);
/** Procedural sound names understood by play(). */
export const SYNTH_NAMES = Object.keys(SYN).filter((n) => n !== 'hover');

/**
 * The race-day sound engine.
 * All methods are safe to call at any time: without Web Audio, before init, or with
 * sound disabled they quietly do nothing (replay() still drives its progress callbacks).
 */
export class RaceAudio {
  /** @param {{volume?:number}} [opts] */
  constructor(opts) {
    opts = opts || {};
    this._enabled = readFlag();
    this._vol = clamp(opts.volume == null ? 0.8 : opts.volume, 0, 1);
    this._ctx = null; this.kit = null; this._g = null;
    this._manifest = []; this._clipBufs = new Map(); this._clipLoads = new Map(); this._clipFail = new Set(); this._lastClip = '';
    this._scene = null; this._mods = null; this._bed = null; this._openScene = null; this._prevScene = null;
    this._hover = null; this._lastHover = 0; this._replay = null; this._armed = false; this._timer = 0; this._prevMods = null;
    this._supported = HAS_WIN && !!(window.AudioContext || window.webkitAudioContext);
    // WP8 patch state
    this._givenCtx = opts.context || null; this._cueFns = []; this._voiceUsed = null; this._ducked = false; this._an = null; this._anBuf = null;
    this._onGesture = this._onGesture.bind(this); this._onVis = this._onVis.bind(this); this._tick = this._tick.bind(this);
  }

  /**
   * Load the optional clip manifest and restore the stored sound preference.
   * If the visitor opted in earlier, audio starts on their first click/tap/key.
   * @param {string} [manifestUrl] same-origin URL of manifest.json ([{id,file,kind,scene_tags,loop_start,loop_end,gain_db_suggestion}])
   * @returns {Promise<{supported:boolean, enabled:boolean, clips:number}>} never rejects
   */
  init(manifestUrl, preloaded) {
    const done = () => ({ supported: this._supported, enabled: this._enabled, clips: this._manifest.length });
    try {
      if (this._enabled) this._arm();
      if (!manifestUrl || (typeof fetch !== 'function' && !preloaded)) return Promise.resolve(done());
      const base = new URL(manifestUrl, HAS_WIN ? window.location.href : undefined);
      // WP8 patch: the bridge may pass the already fetched manifest (one request, captions read from it)
      const got = preloaded ? Promise.resolve(preloaded) : fetch(base.href).then((r) => (r.ok ? r.json() : []));
      return got.then((list) => {
        const arr = Array.isArray(list) ? list : (list && Array.isArray(list.clips) ? list.clips : []);
        this._manifest = arr.filter((e) => e && e.id && (e.file || (e.files && e.files.length))).map((e) => ({
          id: String(e.id), kind: e.kind || 'oneshot', tags: Array.isArray(e.scene_tags) ? e.scene_tags.map(String) : [],
          url: this._pickUrl(e, base), loopStart: +e.loop_start || 0, loopEnd: +e.loop_end || 0, gainDb: isFinite(+e.gain_db_suggestion) ? +e.gain_db_suggestion : 0,
        })).filter((e) => e.url);
        if (this.kit) { if (this._scene) this._preloadScene(this._scene); for (const e of this._manifest) if (e.tags.indexOf('sting') >= 0) this._loadClip(e).catch(noop); }
        return done();
      }).catch(() => done());
    } catch (e) { return Promise.resolve(done()); }
  }

  /**
   * Turn sound on or off (persisted). Call it from a click/tap handler so browsers allow audio.
   * @param {boolean} on
   */
  setEnabled(on) {
    try {
      on = !!on; this._enabled = on; writeFlag(on);
      if (on) { this._ensureCtx(); this._resume(); this._arm(); }
      else {
        this._applyMaster(0.08);
        if (this._hover) { this._hover.stop(0.05); this._hover = null; }
        const c = this._ctx;
        setTimeout(() => { if (!this._enabled && c && c.state === 'running') { try { c.suspend(); } catch (e) { /* ignore */ } } }, 500);
      }
    } catch (e) { warn(e); }
  }
  /** @returns {boolean} whether the visitor opted in */
  isEnabled() { return this._enabled; }
  /** @param {number} v master volume 0..1 (perceptual curve) */
  setVolume(v) { this._vol = clamp(+v || 0, 0, 1); this._applyMaster(0.05); }

  /**
   * Crossfade to a scene's ambience bed with its sparse random events.
   * @param {string|null} sceneId one of SCENE_IDS ('wall', 'be', 'fr', ... 'mtb', 'tt'); null fades everything out
   * @param {{wind?:number, rain?:number, crowd?:number, insects?:'cicada'|'cricket'}} [mods] weather/density tweaks (multipliers, rain 0..1)
   */
  ambience(sceneId, mods) {
    try {
      // while a dossier is open, only remember what close() should return to
      if (this._openScene != null) { this._prevScene = sceneId || null; this._prevMods = mods || null; return; }
      this._scene = sceneId || null; this._mods = mods || null;
      if (this.kit && this._ctx.state === 'running') this._setBed(this._scene, this._mods);
    } catch (e) { warn(e); }
  }

  /**
   * Hover a bib: a short freewheel tick burst and a paper rustle, different per seed.
   * @param {string|number} seed e.g. the bib id; the same seed always sounds the same
   */
  hover(seed) {
    try {
      if (!this._live()) return;
      const t = nowMs();
      if (t - this._lastHover < 45) return;
      this._lastHover = t;
      if (this._hover) this._hover.stop(0.06);
      const h = hashSeed(seed);
      this._hover = SYN.hover(this.kit, this.kit.now + 0.005, { seed: h, pan: ((h % 100) / 100 - 0.5) * 0.6, gainDb: -8, dist: 1, send: 0.05 });
    } catch (e) { warn(e); }
  }
  /** Pointer left the bib: let the ticking die away quickly. */
  unhover() { try { if (this._hover) { this._hover.stop(0.12); this._hover = null; } } catch (e) { warn(e); } }

  /**
   * Opening a race dossier: whoosh, the scene's sting (Rodania-style car for 'be', race radio
   * and caravan for 'fr', speaker and bell for 'de', ...), then the bunch passes. Switches the
   * ambience to that scene; close() restores the previous one.
   * @param {string} sceneId
   */
  open(sceneId, mods) {
    try {
      const id = SCENES[sceneId] ? sceneId : 'wall';
      if (this._openScene == null) { this._prevScene = this._scene; this._prevMods = this._mods; }
      this._openScene = id;
      this._scene = id; this._mods = mods || null;
      if (!this._live()) return;
      const k = this.kit, t = k.now + 0.03;
      // every sting sound carries the scene id, so scene-tagged clips can stand in for synths
      const A = { _fire: (n, tt, o) => this._fire(n, tt, Object.assign({ scene: id }, o)) };
      k.stopTag('sting', 0.3);
      this._setBed(id, this._mods);
      A._fire('whoosh', t, { dist: 1, gainDb: -4, dur: 1.3, tag: 'sting', dir: 1 });
      A._fire('paper', t, { gainDb: -12, tag: 'sting' });
      const sting = this._clipFor('sting', id);
      let at;
      if (sting) { this._playClip(sting, t + 0.2, { tag: 'sting', bus: sting.kind === 'voice' ? 'voice' : 'sfx', dist: 1.5 }); at = Math.min(4, (this._clipBufs.get(sting.id) || { duration: 3 }).duration + 0.3); }
      else at = (STINGS[id] || ((AA, tt) => defaultSting(AA, tt, id)))(A, t);
      if (id !== 'mtb' && id !== 'tt' && id !== 'wall') A._fire('peloton', t + at, { dist: 1.2, lang: LANG_OF[id], tag: 'sting', gainDb: -1 });
    } catch (e) { warn(e); }
  }
  /** Closing the dossier: fade the sting, rustle, back to the previous ambience. */
  close() {
    try {
      const back = this._prevScene;
      this._openScene = null; this._scene = back || null; this._mods = this._prevMods || null;
      if (!this._live()) return;
      const k = this.kit, t = k.now + 0.02;
      k.stopTag('sting', 0.5);
      this._fire('paper', t, { gainDb: -10, seed: 3 });
      this._fire('whoosh', t, { dist: 1.3, gainDb: -10, dur: 1, dir: -1 });
      this._setBed(this._scene, this._mods);
    } catch (e) { warn(e); }
  }

  /**
   * Play a manifest clip (by id) or a procedural synth (see SYNTH_NAMES).
   * @param {string} idOrSynth
   * @param {{pan?:number, gainDb?:number, doppler?:boolean|{speed?:number,near?:number,dir?:number}, dist?:number, when?:number, seed?:any, lang?:string}} [opts]
   * @returns {{stop:(fade?:number)=>void}} handle (no-op handle when silent)
   */
  play(idOrSynth, opts) {
    const handle = { v: null, cancelled: false, stop: (f) => { handle.cancelled = true; if (handle.v) handle.v.stop(f); } };
    try {
      if (!this._live()) return handle;
      opts = Object.assign({}, opts || {});
      const t = this.kit.now + 0.02 + Math.max(0, opts.when || 0);
      const clip = this._manifest.find((e) => e.id === idOrSynth);
      if (clip) {
        const buf = this._clipBufs.get(clip.id);
        if (buf) handle.v = this._playClip(clip, t, opts);
        else this._loadClip(clip).then(() => { if (!handle.cancelled && this._live()) handle.v = this._playClip(clip, this.kit.now + 0.02, opts); }, noop);
        return handle;
      }
      handle.v = this._fire(idOrSynth, t, opts);
    } catch (e) { warn(e); }
    return handle;
  }

  /**
   * Sonify a ride: drivetrain intensity from watts, chain pulse from cadence, wind and
   * tyres from speed, freewheel ticking when watts == 0. Only one replay runs at a time.
   * Progress callbacks run even with sound off, so the UI can animate a cursor.
   * @param {{t?:number[], w?:number[], cad?:number[], kph?:number[]}} series seconds, watts, rpm, km/h
   * @param {{speed?:number}} [opts] speed = data seconds per real second (default 60)
   * @returns {ReplayController}
   */
  replay(series, opts) {
    try {
      if (this._replay) this._replay._finish(false);
      const r = new Replay(this, series, opts);
      this._replay = r;
      return r.api;
    } catch (e) {
      const api = { stop: noop, onprogress: () => api, onend: () => api, seek: noop, pause: noop, resume: noop, setSpeed: noop, isPaused: () => false, state: () => ({ playing: false, paused: false, done: true }) };
      return api;
    }
  }

  // ------------------------------------------------------------- WP8 patch API
  /**
   * Subscribe to audible cues (captions). fn({ name, clipId, scene, delaySec, tag, cue, voice }).
   * @returns {() => void} unsubscribe
   */
  oncue(fn) {
    if (typeof fn !== 'function') return noop;
    this._cueFns.push(fn);
    return () => { const i = this._cueFns.indexOf(fn); if (i >= 0) this._cueFns.splice(i, 1); };
  }
  /** Change the weather mods of the current bed (dossier open or wall). */
  setMods(mods) {
    try {
      this._mods = mods || null;
      if (this.kit && this._ctx.state === 'running' && this._scene) this._setBed(this._scene, this._mods);
    } catch (e) { warn(e); }
  }
  /** Offscreen ducking: master to silence (true) and back (false). */
  setDucked(on) { this._ducked = !!on; this._applyMaster(on ? 0.15 : 0.35); }
  /** Output level 0..1 (RMS after the master gain), for a level meter. 0 when silent or not running. */
  level() {
    try {
      if (!this._an || !this._ctx || this._ctx.state !== 'running') return 0;
      const b = this._anBuf || (this._anBuf = new Float32Array(this._an.fftSize));
      this._an.getFloatTimeDomainData(b);
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i] * b[i];
      return Math.sqrt(s / b.length);
    } catch (e) { return 0; }
  }
  /**
   * Fetch and decode clips ahead of use. A scene id loads what its open() sting may use (sting clip,
   * voice lines); an array loads those clip ids. Needs a context (after opt-in).
   */
  preload(sceneOrIds) {
    try {
      if (!this._ctx) return;
      const ids = Array.isArray(sceneOrIds) ? sceneOrIds : null;
      for (const e of this._manifest) {
        if (ids ? ids.indexOf(e.id) >= 0 : e.tags.indexOf(sceneOrIds) >= 0 && (e.kind === 'voice' || e.tags.indexOf('sting') >= 0)) this._loadClip(e).catch(noop);
      }
    } catch (e) { warn(e); }
  }
  /** Ids of the clips in the manifest (dev and QA). */
  clipIds() { return this._manifest.map((e) => e.id); }
  _cue(name, clipId, t, o) {
    if (!this._cueFns.length) return;
    o = o || {};
    const c = { name, clipId: clipId || null, scene: o.scene || this._scene || null, delaySec: Math.max(0, (t || 0) - (this._ctx ? this._ctx.currentTime : 0)), tag: o.tag || null, cue: o.cue || null, voice: o.voice || null };
    for (const f of this._cueFns.slice()) { try { f(c); } catch (e) { warn(e); } }
  }

  /** Call from any user gesture (idempotent); useful when the page has its own first-click handler. */
  unlock() { try { if (this._enabled) { this._ensureCtx(); this._resume(); } } catch (e) { warn(e); } }
  /** Log swallowed errors to the console (development only). @param {boolean} on */
  static setDebug(on) { DEBUG = !!on; }
  /** Debug snapshot. */
  stats() {
    const c = this._ctx;
    return { supported: this._supported, enabled: this._enabled, state: c ? c.state : 'none', sampleRate: c ? c.sampleRate : 0, voices: this.kit ? this.kit.voices.length : 0, scene: this._scene, bed: this._bed ? this._bed.id : null, clips: this._manifest.length, clipsLoaded: this._clipBufs.size };
  }
  /** Tear everything down (SPA navigation). */
  dispose() {
    try {
      clearInterval(this._timer); this._disarm();
      if (HAS_WIN) document.removeEventListener('visibilitychange', this._onVis);
      if (this._replay) this._replay._finish(false);
      if (this._ctx && this._ctx.close) this._ctx.close();
    } catch (e) { warn(e); }
    this._ctx = null; this.kit = null; this._bed = null;
  }

  /**
   * Render a synth or scene offline (testing / previews). Name: a synth name,
   * 'scene:<id>', 'open:<id>' or 'replay' (opts.series, opts.speed, opts.from = data seconds to start at).
   * @returns {Promise<AudioBuffer>}
   */
  static renderOffline(name, seconds, opts) {
    opts = opts || {};
    const OAC = HAS_WIN && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext unavailable'));
    const sr = opts.sampleRate || 48000, secs = seconds || 4, ctx = new OAC(2, Math.ceil(sr * secs), sr);
    const g = buildGraph(ctx);
    g.master.gain.value = 1;
    const k = new Kit(ctx, g, null, true);
    const scene = name.indexOf(':') > 0 ? name.split(':')[1] : null;
    k.setIR(scene && SCENES[scene] ? SCENES[scene].ir : opts.ir || 'street');
    if (name.startsWith('scene:')) {
      const bed = new Bed(k, scene, opts.mods);
      bed.out.gain.value = 1;
      for (let t = 0; t < secs; t += 0.2) bed.tick(t, 0.3);
    } else if (name.startsWith('open:')) {
      const A = { _fire: (n, t, o) => fire(k, n, t, o) }, t = 0.05;
      fire(k, 'whoosh', t, { dist: 1, gainDb: -4, dur: 1.3, dir: 1 });
      fire(k, 'paper', t, { gainDb: -12 });
      const at = (STINGS[scene] || ((AA, tt) => defaultSting(AA, tt, scene)))(A, t);
      if (scene !== 'mtb' && scene !== 'tt' && scene !== 'wall') fire(k, 'peloton', t + at, { dist: 1.2, lang: LANG_OF[scene], gainDb: -1 });
    } else if (name === 'replay') {
      const S = normSeries(opts.series), sp = opts.speed || 60, rv = new ReplayVoice(k, null);
      const tmp = { fraction: 0, index: 0, t: 0, w: 0, cad: 0, kph: 0 }, R = { s: S, t0: S.t[0], t1: S.t[S.n - 1], i: 0, p: tmp };
      const from = S.t[0] + (+opts.from || 0);
      for (let t = 0.05; t < secs; t += 0.05) { const td = Math.min(R.t1, from + t * sp); Replay.prototype._sample.call(R, td); rv.update(t, tmp.w, tmp.cad, tmp.kph, 0.06); }
    } else {
      fire(k, name, 0.05, Object.assign({ seed: 1 }, opts));
    }
    return new Promise((res, rej) => {
      ctx.oncomplete = (e) => res(e.renderedBuffer);
      try { const p = ctx.startRendering(); if (p && p.then) p.then(res, rej); } catch (e) { rej(e); }
    });
  }

  // ---------------------------------------------------------------- internals
  _live() { return !!(this._enabled && this._ctx && this.kit && this._ctx.state === 'running'); }
  _ensureCtx() {
    if (this._ctx || !this._supported) return this._ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      let ctx = this._givenCtx && this._givenCtx.state !== 'closed' ? this._givenCtx : null;
      this._givenCtx = null;
      try { if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
      if (!ctx) { try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); } }
      const g = buildGraph(ctx);
      try { this._an = ctx.createAnalyser(); this._an.fftSize = 1024; g.master.connect(this._an); } catch (e) { this._an = null; }
      this._ctx = ctx; this._g = g; this.kit = new Kit(ctx, g, this, false);
      this.kit.setIR('street');
      ctx.onstatechange = () => { if (ctx.state === 'running') this._onRunning(); };
      document.addEventListener('visibilitychange', this._onVis);
      this._timer = setInterval(this._tick, 180);
      // warm the caches a little later, off the click handler
      setTimeout(() => {
        try {
          this.kit.pink(); this.kit.brown(); this.kit.fwLoop(true, 0); this.kit.murmur();
          for (const e of this._manifest) if (e.tags.indexOf('sting') >= 0) this._loadClip(e).catch(noop);
        } catch (e) { warn(e); }
      }, 400);
    } catch (e) { this._supported = false; this._ctx = null; this.kit = null; }
    return this._ctx;
  }
  _resume() {
    const c = this._ctx;
    if (!c) return;
    try {
      if (c.state !== 'running' && c.state !== 'closed') { const p = c.resume(); if (p && p.then) p.then(() => this._onRunning(), noop); }
      else this._onRunning();
      // iOS unlock: play one silent sample inside the gesture
      const b = c.createBuffer(1, 1, c.sampleRate), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) { /* ignore */ }
  }
  _onRunning() {
    if (!this._ctx || this._ctx.state !== 'running') return;
    if (!this._enabled) { this._applyMaster(0.05); return; }
    this._applyMaster(0.25);
    this._disarm();
    if (this._scene && (!this._bed || this._bed.id !== this._scene)) this._setBed(this._scene, this._mods);
  }
  /** Lower the ambience bed while the power replay plays. */
  _duck(on) {
    const g = this._g;
    if (!g) return;
    try { g.amb.gain.setTargetAtTime(on ? 0.2 : 0.55, this._ctx.currentTime, on ? 0.3 : 0.8); } catch (e) { warn(e); }
  }
  _applyMaster(tc) {
    const g = this._g;
    if (!g) return;
    const hidden = HAS_WIN && document.hidden, target = this._enabled && !hidden && !this._ducked ? this._vol * this._vol : 0, t = this._ctx.currentTime;
    try { g.master.gain.cancelScheduledValues(t); g.master.gain.setValueAtTime(g.master.gain.value, t); g.master.gain.setTargetAtTime(target, t, tc || 0.1); } catch (e) { /* ignore */ }
  }
  _arm() {
    if (this._armed || !HAS_WIN) return;
    this._armed = true;
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) window.addEventListener(ev, this._onGesture, true);
  }
  _disarm() {
    if (!this._armed || !HAS_WIN) return;
    this._armed = false;
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) window.removeEventListener(ev, this._onGesture, true);
  }
  _onGesture() { if (this._enabled) { this._ensureCtx(); this._resume(); } }
  _onVis() {
    const c = this._ctx;
    if (!c) return;
    if (document.hidden) {
      this._applyMaster(0.05);
      setTimeout(() => { if (document.hidden && c.state === 'running') { try { c.suspend(); } catch (e) { /* ignore */ } } }, 200);
    } else if (this._enabled) { this._resume(); }
  }
  _tick() {
    try {
      const c = this._ctx;
      if (!c || c.state !== 'running' || !this._enabled || !this._bed) return;
      this._bed.tick(c.currentTime, 0.35);
    } catch (e) { warn(e); }
  }
  _setBed(id, mods) {
    const k = this.kit;
    if (!k) return;
    const key = id + JSON.stringify(mods || {});
    if (this._bed && this._bed.key === key && !this._bed.stopped) return;
    if (this._bed) this._bed.stop(2.2);
    this._bed = null;
    if (!id) return;
    const def = SCENES[id] || SCENES.wall;
    k.setIR(def.ir);
    const b = new Bed(k, SCENES[id] ? id : 'wall', mods);
    b.key = key;
    b.fade(1, 2.5);
    k.warm(b.ev.map((e) => e.name).concat(['cheer', 'shift']), b.lang);
    this._bed = b;
    this._preloadScene(b.id);
    for (const e of this._manifest) {
      if (e.tags.indexOf(b.id) < 0) continue;
      if (e.kind === 'loop') this._addClipLayer(b, e);
      // scene-tagged one-shots that do not stand in for a synth become extra random events
      else if (e.kind === 'oneshot' && e.tags.indexOf('sting') < 0 && !e.tags.some((x) => SYN[x])) b.ev.push({ name: e.id, rate: 0.8, dist: 2.5, big: false, next: k.now + rr(b.r, 4, 40) });
    }
    // WP8 patch: weather clip layers (rain on the road, strong wind), only when the weather says so
    const m = mods || {};
    for (const e of this._manifest) {
      if (e.kind !== 'loop' || e.tags.indexOf(b.id) >= 0) continue;
      if (m.rain > 0 && e.tags.indexOf('weather_rain') >= 0) this._addClipLayer(b, e, clamp(m.rain, 0, 1));
      else if (m.wind > 1 && e.tags.indexOf('weather_wind') >= 0) this._addClipLayer(b, e, clamp(m.wind - 1, 0, 1));
    }
  }
  _addClipLayer(bed, e, amount) {
    this._loadClip(e).then((buf) => {
      if (bed.stopped || !this.kit) return;
      const s = bed.v.add(this.kit.ctx.createBufferSource());
      s.buffer = buf; s.loop = true;
      if (e.loopEnd > e.loopStart) { s.loopStart = e.loopStart; s.loopEnd = e.loopEnd; }
      const g = bed.v.add(this.kit.gain(0)); s.connect(g); g.connect(bed.out);
      g.gain.setTargetAtTime(dbGain(e.gainDb) * (amount == null ? 1 : amount), this.kit.now, 1);
      bed.v.src(s, this.kit.now + 0.05, null, e.loopEnd > e.loopStart ? e.loopStart : 0);
    }, noop);
  }
  _preloadScene(id) { for (const e of this._manifest) if (e.kind !== 'loop' && e.tags.indexOf(id) >= 0) this._loadClip(e).catch(noop); }
  _pickUrl(e, base) {
    const files = [].concat(e.files || [], e.file || []);
    let a = null;
    try { a = document.createElement('audio'); } catch (er) { /* ignore */ }
    const ok = (f) => { if (!a || !a.canPlayType) return true; const ext = (f.split('.').pop() || '').toLowerCase(); const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', webm: 'audio/webm', wav: 'audio/wav', flac: 'audio/flac' }[ext]; return !mime || a.canPlayType(mime) !== ''; };
    const f = files.find(ok) || files[0];
    try { return f ? new URL(f, base).href : null; } catch (er) { return null; }
  }
  _loadClip(e) {
    if (this._clipBufs.has(e.id)) return Promise.resolve(this._clipBufs.get(e.id));
    if (this._clipLoads.has(e.id)) return this._clipLoads.get(e.id);
    if (!this._ctx || this._clipFail.has(e.id)) return Promise.reject(new Error('clip unavailable'));
    const p = fetch(e.url).then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then((ab) => decodeAudio(this._ctx, ab)).then((buf) => { this._clipBufs.set(e.id, buf); return buf; });
    p.catch((err) => { this._clipLoads.delete(e.id); this._clipFail.add(e.id); warn(err); });
    this._clipLoads.set(e.id, p);
    return p;
  }
  _clipFor(kind, scene, hint, not) {
    const list = this._manifest.filter((e) => (kind === 'sting' ? e.tags.indexOf('sting') >= 0 : e.kind === kind) && e.tags.indexOf(scene) >= 0 && (!hint || e.tags.indexOf(hint) >= 0 || e.id.indexOf(hint) >= 0) && (!not || e.tags.indexOf(not) < 0));
    if (!list.length) return null;
    const ready = list.filter((e) => this._clipBufs.has(e.id));
    for (const e of list) if (!this._clipBufs.has(e.id)) this._loadClip(e).catch(noop);
    if (!ready.length) return null;
    const pickable = ready.length > 1 ? ready.filter((e) => e.id !== this._lastClip) : ready;
    const e = pickable[(Math.random() * pickable.length) | 0];
    this._lastClip = e.id;
    return e;
  }
  /** Used by synths: a decoded voice clip for this scene (or null → procedural babble). */
  _voiceClip(scene, hint) {
    // integration: an announcer never speaks the Rodania car's line ("Rodania! Rodania!"); only the car itself does
    const e = this._clipFor('voice', scene, hint) || (hint ? this._clipFor('voice', scene, null, hint === 'rodania' ? null : 'rodania') : null);
    if (!e) return null;
    const b = this._clipBufs.get(e.id);
    b.gainDb = e.gainDb;
    this._voiceUsed = e.id;
    return b;
  }
  /** Play a decoded clip and report it as a cue. */
  _playClip(e, t, o) {
    const v = this._playClipRaw(e, t, o);
    if (v) this._cue(e.id, e.id, t, o);
    return v;
  }
  _playClipRaw(e, t, o) {
    const buf = this._clipBufs.get(e.id);
    if (!buf || !this.kit) return null;
    o = Object.assign({ bus: e.kind === 'voice' ? 'voice' : 'sfx' }, o);
    o.gainDb = (o.gainDb || 0) + e.gainDb;
    if (e.kind === 'loop' && o.loop !== false) {
      const v = this.kit.voice(o.bus, o), s = v.add(this.kit.ctx.createBufferSource());
      s.buffer = buf; s.loop = true;
      if (e.loopEnd > e.loopStart) { s.loopStart = e.loopStart; s.loopEnd = e.loopEnd; }
      s.connect(this.kit.place(v, o)); v.src(s, t, t + (o.dur || 8));
      return v.seal();
    }
    return this.kit.playBuf(buf, t, o);
  }
  _fire(name, t, o) {
    o = o || {};
    if (!this.kit) return null;
    // 1. a clip tagged with this scene and this synth name stands in for the synth
    if (o.scene && SYN[name]) {
      const alt = this._manifest.filter((e) => e.kind !== 'loop' && e.tags.indexOf(name) >= 0 && (e.tags.indexOf(o.scene) >= 0 || e.tags.indexOf('all') >= 0));
      const ready = alt.filter((e) => this._clipBufs.has(e.id));
      for (const e of alt) if (!this._clipBufs.has(e.id)) this._loadClip(e).catch(noop);
      if (ready.length && Math.random() < 0.75) {
        const e = ready[(Math.random() * ready.length) | 0], v = this._playClipRaw(e, t, o);
        if (v) this._cue(name, e.id, t, o);
        return v;
      }
    }
    // 2. a clip whose id is the requested name
    const clip = this._manifest.find((e) => e.id === name);
    if (clip && this._clipBufs.has(clip.id)) { const v = this._playClipRaw(clip, t, o); if (v) this._cue(name, clip.id, t, o); return v; }
    if (clip) this._loadClip(clip).catch(noop);
    // 3. the procedural synth (speaker / radio may use a voice clip: report it as clipId)
    this._voiceUsed = null;
    const v = fire(this.kit, name, t, o);
    if (v) this._cue(name, this._voiceUsed, t, o);
    this._voiceUsed = null;
    return v;
  }
}

/** @private test hook */
RaceAudio._internals = { Kit, buildGraph, SYN, SCENES, renderIR, renderCheer, renderBabble, renderCowbells, renderChurchBell, renderHeliLoop, renderCrickets, renderCicadas, renderGenerator, renderHover, renderLapBell, renderTickLoop, renderMtb, VSR };

export default RaceAudio;
