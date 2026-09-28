/* radsport/js/charts/replay.js (WP7): replay "Rennen abspielen" (FINAL_SPEC 1.6, 3.9).
 * createReplay({ series, chart, weather, audio, bus, scene, live, i18n, controls, finish })
 *   -> { play, pause, toggle, seek(fraction), setSpeed(x), state, relabel, destroy }; owns its button bar.
 * Plays the race window (start to finish; the data run about 1 min longer on both sides, spec 4.4) on its own
 * clock (a frame gap > 250 ms counts as a pause, so a hidden tab never jumps), with or without sound; the clock
 * shows race time against the header's duration; started past the finish it plays to the end of the data.
 * Speeds 60/120/240x (auto: 60 to 90 s), plus 480x/960x while 240x would last over 2 min (24 h races).
 * Data gaps over 2 min are skipped with a note. Audio (WP8 bridge, may be null; it handles sound off itself):
 * audio.replay(data, { speed, scene, finish }) -> { stop, seek [, pause, resume, setSpeed] }; without the
 * optional three a pause is stop and resume a new replay + seek; restarted on bus 'sound:change'; at the
 * natural end it runs out by itself (finish cue S18). Moments fire once: chart.flash, bus 'replay:moment',
 * the live region, audio.moment (bus 'caption' without audio). weather.setTime(localIso) on each new local
 * hour. fraction = t / t_last (as chart and engine). Frames move the chart with { playing: true }.
 */
import { makeT, hms, hmsS, nb, raceWindow, localPlus } from './strings.js';

const BASE_SPEEDS = [60, 120, 240];
const GAP_SKIP_S = 120;

/** 60/120/240x; 480x and 960x are added only while the next slower speed would last over 2 min
 * (24 h and ultra races). */
export function speedsFor(durationS) {
  const list = BASE_SPEEDS.slice();
  while (list[list.length - 1] < 960 && durationS / list[list.length - 1] > 120) list.push(list[list.length - 1] * 2);
  return list;
}
export function autoSpeed(durationS) {
  const list = speedsFor(durationS);
  for (const s of list) if (durationS / s <= 90) return s;
  return list[list.length - 1];
}

export function createReplay({ series, chart, weather = null, audio = null, bus = null, scene = null, live = null, i18n = null, controls = null, finish: finishCheer = true } = {}) {
  const T = makeT(i18n);
  const D = series.data || {};
  const n = (D.t || []).length;
  const res = series.resolution_s || 5;
  const tMax = n ? D.t[n - 1] : 0;
  const moments = (series.moments || []).slice().sort((a, b) => a.t - b.t);
  const primary = D.w || D.kph || D.alt || [];
  const RW = raceWindow(series);

  // gap runs (index ranges without data) longer than GAP_SKIP_S
  const gaps = [];
  for (let i = 0; i < n; i++) {
    if (primary[i] != null || (D.kph && D.kph[i] != null) || (D.alt && D.alt[i] != null)) continue;
    let j = i;
    while (j + 1 < n && primary[j + 1] == null && !(D.kph && D.kph[j + 1] != null) && !(D.alt && D.alt[j + 1] != null)) j++;
    if ((j - i + 1) * res > GAP_SKIP_S && j + 1 < n) gaps.push([i, j + 1]);
    i = j;
  }

  // playing time excludes the skipped gaps
  const playS = Math.max(1, tMax - gaps.reduce((a, [i, j]) => a + (D.t[j] - D.t[i]), 0));
  const SPEEDS = speedsFor(playS);
  let playing = false, done = false, t = RW.r0, speed = autoSpeed(playS), base = 0, clock0 = 0, lastFrame = 0, raf = 0, tStop = RW.r1;
  let mIdx = 0, ctl = null, lastState = 0, lastHour = null, started = false, dead = false;

  // ---- controls
  const host = controls || (chart && chart.controls) || null;
  const bar = document.createElement('div');
  bar.className = 'rs-rp';
  bar.setAttribute('role', 'group');
  bar.innerHTML =
    `<button type="button" class="rs-rp__play" data-state="play"><svg class="rs-rp__ico" viewBox="0 0 20 20" aria-hidden="true">` +
    `<path class="i-play" d="M6 4.5v11l9-5.5z"/><path class="i-pause" d="M6.5 4.5v11M13.5 4.5v11"/>` +
    `<path class="i-again" d="M4.5 10a5.5 5.5 0 1 0 1.8-4.1M4.5 3.5v3.4h3.4"/></svg><span class="rs-rp__label"></span></button>` +
    `<div class="rs-rp__speeds" role="group">` + SPEEDS.map((s) => `<button type="button" class="rs-rp__speed" data-speed="${s}" aria-pressed="false">×${s}</button>`).join('') + `</div>` +
    `<span class="rs-rp__clock" aria-hidden="true"></span>`;
  if (host) host.appendChild(bar);
  const playBtn = bar.querySelector('.rs-rp__play'), playLab = bar.querySelector('.rs-rp__label');
  const clockEl = bar.querySelector('.rs-rp__clock'), speedGroup = bar.querySelector('.rs-rp__speeds');
  const liveEl = live || document.querySelector('.rs-live');

  function setUI() {
    const st = done ? 'again' : playing ? 'pause' : started ? 'resume' : 'play';
    playBtn.dataset.state = st;
    playLab.textContent = T.t('rp.' + st);
    for (const b of speedGroup.children) b.setAttribute('aria-pressed', String(+b.dataset.speed === speed));
    clockEl.textContent = nb(`${hmsS(t - RW.r0)} / ${hms(RW.dur)} · ${T.t('rp.dur', { d: T.dur(playS / speed) })}`);
  }
  function relabel() {
    bar.setAttribute('aria-label', T.t('rp.controls'));
    speedGroup.setAttribute('aria-label', T.t('rp.speed'));
    for (const b of speedGroup.children) b.setAttribute('title', T.t('rp.speedN', { n: b.dataset.speed }));
    setUI();
  }

  // ---- audio
  const payload = Object.assign({}, D, { data: D, resolution_s: res, schema: series.schema });
  const hasAudio = !!(audio && typeof audio.replay === 'function');
  function startAudio() {
    stopAudio();
    if (!hasAudio) return;
    try {
      ctl = audio.replay(payload, { speed, scene, finish: finishCheer });
      if (ctl && typeof ctl.seek === 'function') ctl.seek(tMax ? t / tMax : 0);
    } catch (e) { console.error(e); ctl = null; }
  }
  function stopAudio() {
    if (!ctl) return;
    const c = ctl; ctl = null;
    try { c.stop && c.stop(); } catch (e) { /* ignore */ }
  }

  // ---- clock
  const frac = () => (tMax ? t / tMax : 0);
  function emitState(force) {
    const now = performance.now();
    if (!force && now - lastState < 83) return;
    lastState = now;
    const i = Math.min(n - 1, Math.round(t / res));
    const detail = { playing, fraction: frac(), t, speed, done, w: D.w ? D.w[i] : null, kph: D.kph ? D.kph[i] : null };
    if (bus) try { bus.emit('replay:state', detail); } catch (e) { console.error(e); }
  }
  function syncWeather(force) {
    if (!weather || typeof weather.setTime !== 'function' || !series.startLocal) return;
    const iso = localPlus(series.startLocal, t);
    const hour = iso ? iso.slice(0, 13) : null;
    if (!force && hour === lastHour) return;
    lastHour = hour;
    try { weather.setTime(iso ? iso.slice(0, 16) : null, { replay: true }); } catch (e) { console.error(e); }
  }
  function skipMomentsBefore(tt) { mIdx = 0; while (mIdx < moments.length && moments[mIdx].t < tt) mIdx++; }
  function fire(m) {
    const text = T.L(m.label);
    try { chart && chart.flash && chart.flash(m); } catch (e) { console.error(e); }
    if (bus) try { bus.emit('replay:moment', { moment: m }); } catch (e) { console.error(e); }
    if (liveEl) liveEl.textContent = text;
    if (audio && typeof audio.moment === 'function') { try { audio.moment(m, { scene }); } catch (e) { console.error(e); } }
    else if (bus) try { bus.emit('caption', { id: 'rs-moment-' + m.t, text, level: 'event', ms: 3400 }); } catch (e) { console.error(e); }
  }
  function note(text) {
    try { chart && chart.flash && chart.flash({ t, label: { de: text, en: text } }); } catch (e) { /* ignore */ }
  }

  function frame(now) {
    if (!playing || dead) return;
    if (now - lastFrame > 250) clock0 += now - lastFrame - 16; // hidden tab or stall: time stands still
    lastFrame = now;
    let td = base + ((now - clock0) / 1000) * speed;
    // skip long gaps
    const gi = Math.floor(td / res);
    const g = gaps.find(([a, b]) => gi >= a && gi < b);
    if (g) {
      const to = D.t[g[1]];
      note(T.t('rp.gap', { d: T.dur(to - D.t[g[0]]) }));
      base = to; clock0 = now; td = to;
      skipMomentsBefore(td);
      if (ctl && ctl.seek) try { ctl.seek(tMax ? td / tMax : 0); } catch (e) { /* ignore */ }
    }
    if (td >= tStop) td = tStop;
    while (mIdx < moments.length && moments[mIdx].t <= td) fire(moments[mIdx++]);
    t = td;
    if (chart) chart.setCursor(frac(), { playing: true });
    syncWeather(false);
    emitState(false);
    setUIThrottled(now);
    if (t >= tStop) { finish(); return; }
    raf = requestAnimationFrame(frame);
  }
  let lastUI = 0;
  function setUIThrottled(now) { if (now - lastUI > 250) { lastUI = now; setUI(); } }

  function finish() {
    playing = false; done = true;
    cancelAnimationFrame(raf);
    // the audio controller runs out by itself (finish cue); stop it only if it still runs a moment later
    const c = ctl; ctl = null;
    if (c) setTimeout(() => { try { c.stop && c.stop(); } catch (e) { /* ignore */ } }, 1500);
    if (chart) chart.setCursor(frac());   // slider value current again
    setUI(); emitState(true);
    if (bus) try { bus.emit('replay:end', { completed: true }); } catch (e) { /* ignore */ }
    if (liveEl) liveEl.textContent = T.t(t < tMax ? 'rp.finish' : 'rp.end');
  }

  // ---- API
  function play() {
    if (dead || !n) return;
    // first play and "again" start at the race start; past the finish it plays to the data's end
    if (done || !started || t >= tMax) { done = false; t = RW.r0; skipMomentsBefore(t); }
    tStop = t >= RW.r1 - res ? tMax : RW.r1;
    playing = true; started = true;
    base = t; clock0 = performance.now(); lastFrame = clock0;
    if (chart) chart.setCursor(frac());
    if (ctl && ctl.resume && ctl.isPaused && ctl.isPaused()) {
      try { ctl.seek(tMax ? t / tMax : 0); ctl.resume(); } catch (e) { startAudio(); }
    } else startAudio();
    setUI(); emitState(true); syncWeather(true);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    if (ctl && ctl.pause && ctl.isPaused) { try { ctl.pause(); } catch (e) { stopAudio(); } } else stopAudio();
    if (chart) chart.setCursor(frac());
    setUI(); emitState(true);
  }
  function toggle() { if (playing) pause(); else play(); }
  function seek(fraction) {
    const f = Math.max(0, Math.min(1, +fraction || 0));
    t = f * tMax;
    started = true;
    if (done && t < tMax) done = false;
    if (playing) tStop = t >= RW.r1 - res ? tMax : RW.r1;
    skipMomentsBefore(t + 1e-6);
    if (playing) { base = t; clock0 = performance.now(); }
    if (ctl && ctl.seek) try { ctl.seek(f); } catch (e) { /* ignore */ }
    if (chart) chart.setCursor(f);
    syncWeather(true); emitState(true); setUI();
  }
  function setSpeed(x) {
    const s = SPEEDS.includes(+x) ? +x : speed;
    if (s === speed) { setUI(); return; }
    speed = s;
    if (playing) { base = t; clock0 = performance.now(); }
    if (ctl && ctl.setSpeed) { try { ctl.setSpeed(s); ctl.seek(frac()); } catch (e) { if (playing) startAudio(); } }
    else if (playing) startAudio();
    setUI(); emitState(true);
  }
  function state() { return { playing, done, fraction: frac(), t, speed }; }

  playBtn.addEventListener('click', toggle);
  speedGroup.addEventListener('click', (e) => { const b = e.target.closest('[data-speed]'); if (b) setSpeed(+b.dataset.speed); });
  const offScrub = chart && chart.onScrub ? chart.onScrub((f) => seek(f)) : null;
  const offToggle = chart && chart.onToggle ? chart.onToggle(() => toggle()) : null;
  const offSound = bus && bus.on ? bus.on('sound:change', () => { if (playing) startAudio(); else stopAudio(); }) : null;
  const mo = new MutationObserver(() => relabel());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  relabel();

  return {
    play, pause, toggle, seek, setSpeed, state, relabel,
    destroy() {
      dead = true; playing = false;
      cancelAnimationFrame(raf); stopAudio();
      if (offScrub) offScrub(); if (offToggle) offToggle(); if (typeof offSound === 'function') offSound();
      mo.disconnect(); bar.remove();
    },
  };
}

