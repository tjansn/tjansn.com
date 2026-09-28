/**
 * dossier.js (WP6): the dossier dialog ("Katalogblatt"): lifecycle, flight hand-off, focus, deal-in, result reveal,
 * prev/next, index-card and unassigned modes (spec 1.4 to 1.10, 3.8, 5.3 to 5.5, 7).
 *
 *   createDossier(dialogEl, { data, i18n, bus, store, router, flight, charts, audio, captions, wall, lightbox, announce })
 *     -> { open({ raceId, bibId, stage, from }) -> Promise, close(reason) -> Promise, switch(dir) -> Promise,
 *          isOpen(), current(), relabel() }
 * main.js calls open() and close(); this module emits dossier:opened, dossier:switch {dir, raceId, bibId, stage}
 * and dossier:closed {bibId, raceId, reason}. open() while open switches (5.5); during the opening it is queued.
 * Every transition runs on a small timeline with absolute times: a hidden tab fast-forwards it, Esc during the
 * opening plays it backwards, every await races a timeout.
 * The renderers (sections.js, status.js) are not needed at interactive: they load when the browser is idle, on the
 * first hover over a number or list row, or at the latest on the first open (spec 8.1 "dossier core").
 */
let S = null;
let loadingS = null;
let installer = null;             // registers the dossier strings with the page i18n once sections.js is there
function loadSections() {
  if (S) return Promise.resolve(S);
  loadArt();
  if (!loadingS) loadingS = import('./sections.js').then((m) => { S = m; if (installer) installer(m); return m; }, (e) => { loadingS = null; throw e; });
  return loadingS;
}
// round 2: drawn exhibit (art.js, loaded with the renderers; reveal.js), results list
const lazyMod = (f) => { let p = null; return () => p || (p = f().catch(() => { p = null; return null; })); };
let A = null;
const loadArt = lazyMod(() => import('../art/art.js').then((m) => { A = m; return m; }));
const loadReveal = lazyMod(() => import('../art/reveal.js'));
const loadResults = lazyMod(() => import('../results/results.js'));
const loadFallbacks = lazyMod(() => import('./fallbacks.js'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SPRING = 'cubic-bezier(0.16, 1, 0.3, 1)';
const OUT = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const CINE = 'cubic-bezier(0.65, 0, 0.35, 1)';
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';


const ICON = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9h4l5-4v14l-5-4H4z"/></svg>',
};

const noop = () => {};
const warn = (where, e) => { try { console.warn(`[radsport] dossier ${where}:`, e); } catch (_) { /* no console */ } };
const call = (obj, name, ...args) => {
  if (!obj || typeof obj[name] !== 'function') return undefined;
  try { return obj[name](...args); } catch (e) { warn(name, e); return undefined; }
};
const later = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => { setTimeout(() => r(fallback), ms); })]);
const mm = (q) => { try { return matchMedia(q).matches; } catch (_) { return false; } };

/** Steps at absolute times plus the animations they start; ffwd() runs everything now (hidden tab, second Esc). */
function createTimeline() {
  const t0 = performance.now();
  const steps = [];
  const anims = new Set();
  let fast = false;
  let dead = false;
  const run = (s) => {
    if (s.done || dead) return;
    s.done = true;
    clearTimeout(s.id);
    try { s.fn(); } catch (e) { warn('step', e); }
  };
  const tl = {
    get fast() { return fast; },
    elapsed: () => performance.now() - t0,
    at(ms, fn) {
      const s = { ms, fn, done: false };
      steps.push(s);
      if (fast) run(s); else s.id = setTimeout(() => run(s), Math.max(0, ms - tl.elapsed()));
      return s;
    },
    add(a) {
      if (!a) return a;
      anims.add(a);
      if (fast) { try { a.finish(); } catch (_) { /* idle */ } }
      return a;
    },
    ffwd() {
      if (dead) return;
      fast = true;
      steps.slice().sort((a, b) => a.ms - b.ms).forEach(run);
      for (const a of anims) { try { a.finish(); } catch (_) { /* idle */ } }
    },
    kill() { dead = true; for (const s of steps) clearTimeout(s.id); },
    anims: () => [...anims],
    wait: (p, ms) => later(p, ms, null),
  };
  return tl;
}

const finished = (list) => Promise.all(list.filter(Boolean).map((a) => a.finished.catch(() => null)));
/** After n frames (100 ms at most: hidden tabs have none). */
const frames = (n) => new Promise((r) => { let k = 0; const f = () => { k += 1; if (k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(r, 100); });
const yieldTask = () => (globalThis.scheduler && typeof scheduler.yield === 'function' ? scheduler.yield() : new Promise((r) => { setTimeout(r, 0); }));
const mid = (q) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
const span = (q) => Math.hypot(q[2][0] - q[0][0], q[2][1] - q[0][1]) + Math.hypot(q[3][0] - q[1][0], q[3][1] - q[1][1]);
/** The camera only zooms and pans: carry quad q along the change that took quad a (then) to quad b (now). */
function follow(q, a, b) {
  const ca = mid(a); const cb = mid(b); const k = span(b) / (span(a) || 1);
  return q.map(([x, y]) => [cb[0] + (x - ca[0]) * k, cb[1] + (y - ca[1]) * k]);
}

export function createDossier(dialog, deps = {}) {
  const { data, i18n, bus } = deps;
  const wall = deps.wall || {};
  const flight = deps.flight && typeof deps.flight.flyToSlot === 'function' ? deps.flight : null;
  const audio = deps.audio || null;
  const charts = deps.charts || null;
  const lightbox = deps.lightbox || document.querySelector('dialog.rs-lightbox');
  const t = (k, v) => i18n.t(k, v);
  installer = (m) => { if (typeof i18n.extend === 'function' && m.STRINGS) i18n.extend(m.STRINGS); };
  if (S) installer(S);
  // D4: pending photos only in local review mode
  const review = (() => {
    try { const h = location.hostname; return /^(localhost|127\.0\.0\.1|\[?::1\]?)$|\.local$/.test(h) && new URLSearchParams(location.search).get('review') === '1'; } catch (_) { return false; }
  })();

  // ---- skeleton (built once)
  dialog.classList.add('rs-d');
  dialog.setAttribute('aria-labelledby', 'rs-d-title');
  dialog.setAttribute('aria-describedby', 'rs-d-desc');
  dialog.removeAttribute('data-rs-fallback');
  dialog.innerHTML = '<div class="rs-d-scrim" data-d-scrim></div>'
    + '<div class="rs-d-sheet" data-d-sheet>'
    + '<div class="rs-d-top"><p class="rs-d-top__k" data-d-k></p><span class="rs-d-top__dl" data-d-dl></span><span class="rs-d-top__sp"></span>'
    + `<button type="button" class="rs-d-ib rs-d-ib--nav" data-d-act="prev">${ICON.prev}</button><button type="button" class="rs-d-ib rs-d-ib--nav" data-d-act="next">${ICON.next}</button>`
    + `<button type="button" class="rs-d-tb" data-d-sound aria-pressed="false">${ICON.sound}<span class="rs-d-tb__meter" data-d-meter aria-hidden="true"></span><span class="rs-d-tb__t" data-d-t="hud.sound"></span></button>`
    + '<button type="button" class="rs-d-tb" data-d-cc aria-pressed="false"><span class="rs-d-tb__t" data-d-t="hud.cc"></span></button>'
    + `<button type="button" class="rs-d-ib rs-d-ib--x" data-d-act="close">${ICON.close}</button></div>`
    + '<div class="rs-d-scroll" data-d-scroll><div class="rs-d-head"><figure class="rs-d-exhibit"><div class="rs-d-card" data-d-card></div><figcaption class="rs-d-excap" data-d-excap data-deal style="--deal:1"></figcaption></figure>'
    + '<div class="rs-d-headtext" data-d-headtext></div></div><div class="rs-d-body" data-d-body></div><div class="rs-d-foot" data-d-foot></div></div>'
    // captions: a strip of their own under the scroll area, never over text or focus
    + '<div class="rs-d-caps"><p data-d-caption></p></div><div class="rs-d-bar" data-d-bar></div></div>'
    + '<div class="rs-d-flight" data-d-flight aria-hidden="true"></div><p class="rs-sr" aria-live="polite" data-d-live></p>';
  const $ = (s) => dialog.querySelector(s);
  const el = {
    scrim: $('[data-d-scrim]'), sheet: $('[data-d-sheet]'), k: $('[data-d-k]'), dl: $('[data-d-dl]'),
    prev: $('.rs-d-top [data-d-act="prev"]'), next: $('.rs-d-top [data-d-act="next"]'), x: $('[data-d-act="close"]'),
    sound: $('[data-d-sound]'), cc: $('[data-d-cc]'), scroll: $('[data-d-scroll]'), card: $('[data-d-card]'), excap: $('[data-d-excap]'),
    headtext: $('[data-d-headtext]'), body: $('[data-d-body]'), foot: $('[data-d-foot]'), bar: $('[data-d-bar]'),
    cap: $('[data-d-caption]'), flight: $('[data-d-flight]'), live: $('[data-d-live]'),
  };
  if (audio && typeof audio.bindControls === 'function') call(audio, 'bindControls', { sound: [el.sound], cc: [el.cc], meter: [$('[data-d-meter]')] });
  else { el.sound.hidden = true; el.cc.hidden = true; }
  if (deps.captions) {
    call(deps.captions, 'mount', el.cap);
    // the caption strip takes its room while captions are on, so it never covers anything
    const capsOn = (v) => dialog.classList.toggle('has-caps', Boolean(v));
    capsOn(call(deps.captions, 'visible'));
    call(deps.captions, 'onChange', (s) => capsOn(s && s.visible));
  }

  // ---- state
  let phase = 'closed';           // closed | opening | open | switching | closing
  let cur = null;                 // { raceId, bibId, stage, race, bib, mode }
  let from = 'wall';
  let seq = 0;
  let tl = null;
  let flyer = null;
  let handed = null;              // bib id taken off the wall (detach or vacate) by this dossier
  let restQuad = null;            // its spot before the camera dolly
  let pending = null;             // target of a running switch
  let parked = null;              // a flyer back on the wall, until the room shows the bib
  let dollied = false;
  let trigger = null;
  let queued = null;
  let closing = null;
  let ctxLast = null;
  let lazy = null;
  let inerted = [];
  let lastEsc = 0;
  let soundTimer = 0;
  let back = null;                // { top, chip } before the last jump to "Quellen"
  let AX = null;                  // exhibit controller (art.js)
  const ax = () => AX || (A && (AX = A.createExhibit({ dialog, el, i18n, data, store: deps.store, reduced, tl: () => tl, cur: () => cur, nbOf, loadReveal })));
  /** The bib's drawing metadata, when not known yet (else null). */
  const artWait = (bib) => (bib && !(A && A.artKnown(bib.id) !== undefined) ? loadArt().then((m) => m && m.artInfo(bib, data.getBib)) : null);
  const extras = new Map();       // raceId -> Promise of the dossier file (WP2: long fields live in data/dossiers/)
  const extraOf = new Map();      // raceId -> loaded dossier file or null
  const shown = new Map();        // raceId -> bib last shown: prev/next return to it, not to the race's primary bib
  const nbOf = (id) => {
    const nb = data.neighbours(id);
    const own = (tg) => (tg && shown.has(tg.raceId) ? { ...tg, bibId: shown.get(tg.raceId) } : tg);
    return { ...nb, prev: own(nb.prev), next: own(nb.next) };
  };

  function loadExtra(race) {
    if (!race || !race.dossier) return Promise.resolve(null);
    if (!extras.has(race.id)) {
      const load = typeof data.loadDossier === 'function' ? data.loadDossier : data.loadPower;
      extras.set(race.id, later(load(race.dossier), 8000, null).then((d) => { extraOf.set(race.id, d || null); return d || null; }));
    }
    return extras.get(race.id);
  }
  function prefetch(id) {
    loadSections().catch(noop);
    const bib = data.getBib(id);
    const race = data.getRace(id) || (bib && data.getRace(bib.raceId));
    if (race) loadExtra(race);
    artWait(bib || (race && data.getBib(race.primaryBib)));
  }
  /** The race row merged with its dossier file (course, podium, notable, facts, field, conflicts, review photos). */
  function withExtra(race) {
    const d = race && extraOf.get(race.id);
    if (!d) return race;
    const pick = (k) => (d[k] != null ? d[k] : race[k]);
    return {
      ...race, course: pick('course'), podium: pick('podium') || [], notable: pick('notable') || [], facts: pick('facts') || [],
      field: pick('field'), conflicts: pick('conflicts') || [], photosReview: d.photosReview || [], sourceIds: d.sourceIds || race.sourceIds, extraSources: d.sources || null,
      results: pick('results'),
    };
  }

  const reduced = () => Boolean((deps.store && deps.store.get && deps.store.get().reducedMotion) || mm('(prefers-reduced-motion: reduce)'));
  const phone = () => mm('(max-width: 759px)');
  const current = () => (cur ? { raceId: cur.raceId, bibId: cur.bibId, stage: cur.stage } : null);

  function resolve(tg) {
    if (!tg) return null;
    let race = tg.raceId ? data.getRace(tg.raceId) : null;
    let bib = tg.bibId ? data.getBib(tg.bibId) : null;
    if (race && race.status !== 'raced') return null;
    if (bib && race && bib.raceId !== race.id) bib = null;
    if (!race && bib && bib.raceId) race = data.getRace(bib.raceId);
    if (!bib && race && race.primaryBib) bib = data.getBib(race.primaryBib);
    if (!race && !bib) return null;
    const stage = race && tg.stage != null && (race.stages || []).some((s) => Number(s.n) === Number(tg.stage)) ? Number(tg.stage) : null;
    return { raceId: race ? race.id : null, bibId: bib ? bib.id : null, stage, race, bib, mode: !race ? 'unassigned' : bib ? 'wall' : 'card' };
  }
  const same = (a, b) => a && b && a.raceId === b.raceId && a.bibId === b.bibId && a.stage === b.stage;

  function visiblePhotos(race) {
    const ok = (p) => p && p.file && p.people !== 'family' && p.people !== 'children'
      && ((['own', 'licensed'].includes(p.rights) && ['none', 'tom', 'others_ok', undefined].includes(p.people) && p.ships !== false)
        || (review && ['own', 'licensed', 'pending'].includes(p.rights) && ['none', 'tom', 'others_ok', 'review', undefined].includes(p.people)));
    const all = ((race && race.photos) || []).concat(review && race && race.photosReview ? race.photosReview : []);
    const list = all.filter(ok);
    return list.sort((a, b) => (a.rights === 'own' || a.rights === 'licensed' ? 0 : 1) - (b.rights === 'own' || b.rights === 'licensed' ? 0 : 1));
  }

  function powerPlan(race, stage) {
    if (!race) return null;
    const p = race.power || {};
    const src = p.src || [];
    if (p.file) return { ref: p.file, stage: null, stages: [], asked: stage, src };
    const withP = (race.stages || []).filter((s) => s && s.power).map((s) => s.n);
    if (!withP.length) return null;
    const pick = stage != null ? (withP.includes(stage) ? stage : null) : withP[0];
    const st = pick != null ? race.stages.find((s) => s.n === pick) : null;
    return { ref: st ? st.power : null, stage: pick, stages: withP, asked: stage, src };
  }

  function weatherRef(race, stage) {
    if (!race) return null;
    if (race.weather) return race.weather;
    const st = (race.stages || []).find((s) => s && s.weather && (stage == null || s.n === stage)) || (race.stages || []).find((s) => s && s.weather);
    return st ? st.weather : null;
  }

  // the number as it is known (i18n numberText, round 3: also a number the wall photo hides, e.g. 2311 of b07)
  const known = (bib) => Boolean(bib && (i18n.numberText ? i18n.numberText(bib) : bib.number));
  function targetLabel(tg) {
    const race = tg.raceId ? data.getRace(tg.raceId) : null;
    const bib = tg.bibId ? data.getBib(tg.bibId) : null;
    const num = known(bib) ? i18n.numberShort(bib) : '';
    return [num, race ? i18n.L(race.name) : t('label.unassigned')].filter(Boolean).join(' · ');
  }
  /** Phone bar label: the number, else the race name (never a bare year). */
  function targetShort(tg) {
    const bib = tg.bibId ? data.getBib(tg.bibId) : null;
    if (known(bib)) return i18n.numberShort(bib);
    const race = tg.raceId ? data.getRace(tg.raceId) : null;
    return race ? i18n.L(race.name) || String(race.year || '') : bib ? i18n.numberShort(bib) : '';
  }
  /** One country code for the top bar; none for a race across borders. */
  const oneCountry = (race) => (race && !((race.countries || []).filter(Boolean).length > 1) ? race.country || '' : '');

  // ---- render
  function render(nx, keep, start = 'drawn') {
    const { bib } = nx;
    const race = withExtra(nx.race);
    const photos = visiblePhotos(race);
    const dl = S.datenlage(race, photos);
    if (race && bib) shown.set(race.id, bib.id);
    const nb = nbOf(race ? race.id : bib.id);
    const getSource = (id) => (race && race.extraSources && race.extraSources[id]) || data.getSource(id);
    const ctx = {
      i18n, cites: S.createCites(getSource, i18n), mode: nx.mode, stage: nx.stage, photos, review, dl, nb,
      label: targetLabel, short: targetShort, assetURL: data.assetURL, getBib: data.getBib, getRace: data.getRace, getSource,
      power: nx.mode === 'unassigned' ? null : powerPlan(race, nx.stage), weatherRef: weatherRef(race, nx.stage),
    };
    ctxLast = ctx;
    back = null;
    dialog.dataset.mode = nx.mode;
    dialog.dataset.detail = race && race.detail === 'compact' ? 'compact' : 'full';
    const kick = [bib ? i18n.numberShort(bib) : race && race.year, oneCountry(race)].filter(Boolean).map(esc).join(' · ');
    el.k.innerHTML = kick + (nb.index >= 0 ? `<span class="rs-d-top__pos">${kick ? ' · ' : ''}${nb.index + 1} / ${nb.total}</span>` : '');
    el.dl.innerHTML = S.dlHTML(dl, i18n);        // D23 (round 3): no status chip next to it
    for (const dir of ['prev', 'next']) {
      const b = el[dir];
      b.disabled = !nb[dir];
      b.setAttribute('aria-label', nb[dir] ? t(`d.${dir}To`, { name: targetLabel(nb[dir]) }) : t(`d.${dir}`));
      b.title = b.getAttribute('aria-label');
    }
    el.x.setAttribute('aria-label', t('d.closeLabel'));
    el.x.title = t('d.close');
    for (const n of dialog.querySelectorAll('[data-d-t]')) n.textContent = t(n.getAttribute('data-d-t'));
    el.sound.setAttribute('aria-label', t('d.soundLabel'));
    el.cc.setAttribute('aria-label', t('d.ccLabel'));
    const ex = (ax() && AX.exhibit(race, bib, ctx)) || S.exhibit(race, bib, ctx);
    if (AX) AX.show(ex, bib, start);
    else {
      el.card.dataset.kind = ex.kind;
      el.card.style.setProperty('--ar', String(ex.ar));
      el.card.innerHTML = ex.html;
      el.excap.textContent = ex.caption;
    }
    el.headtext.innerHTML = S.head(race, bib, ctx) + S.meta(race, bib, ctx);
    el.body.innerHTML = S.body(race, bib, ctx);
    // first Tab stop after the title: skip to "Quellen" (visible while focused)
    if (el.body.querySelector('[data-sec="sources"]')) {
      const when = el.headtext.querySelector('.rs-d-when');
      if (when) when.insertAdjacentHTML('afterend', `<button type="button" class="rs-d-skip" data-d-skip>${esc(t('d.skip'))}<span aria-hidden="true">↓</span></button>`);
    }
    if (keep) {
      for (const m of el.body.querySelectorAll('[data-mount]')) {
        const old = keep[m.getAttribute('data-mount')];
        if (old) m.replaceWith(old);
      }
    }
    el.foot.innerHTML = S.foot(race, bib, ctx);
    el.bar.innerHTML = S.bar(race, bib, ctx);
  }

  const title = () => dialog.querySelector('#rs-d-title');
  function focusTitle() {
    const h = title();
    if (h) { try { h.focus({ preventScroll: true }); } catch (_) { h.focus(); } }
  }
  function say(text) {
    if (!el.live || !text) return;
    el.live.textContent = '';
    setTimeout(() => { el.live.textContent = text; }, 80);
  }

  // ---- lazy parts (WP7) with static fallbacks
  /** Stop the replay now, destroy the components later (after the content has left, so nothing flickers). */
  function detachLazy() {
    const old = lazy;
    lazy = null;
    if (old) call(old.replay, 'pause');
    call(wall.renderer, 'breathe', 0, 0);
    return old;
  }
  function destroyLazy(old) {
    if (old) for (const k of ['replay', 'chart', 'wx', 'map', 'prints', 'results']) call(old[k], 'destroy');
  }
  let stale = null;
  function teardown() {
    destroyLazy(stale);
    stale = null;
    destroyLazy(detachLazy());
  }

  /** Module sections, each in a task of its own; `soon`: the opening tap paints first (INP). */
  function mountLazy(nx, soon = false) {
    teardown();
    const mine = { nx, want: false, drawn: false };
    lazy = mine;
    mountRun(mine, soon);
  }
  async function mountRun(mine, soon) {
    const { nx } = mine;
    const race = nx.race;
    const q = (k) => el.body.querySelector(`[data-mount="${k}"]`);
    const mP = q('power'); const mW = q('weather'); const mM = q('place'); const mF = q('photos'); const mR = q('results');
    if (!race || !(mP || mW || mM || mF || mR)) return;
    const ctx = ctxLast;
    if (soon) await frames(2);
    const [mods, series, weather, rl] = await Promise.all([
      charts && typeof charts.load === 'function' ? later(charts.load(), 6000, {}) : {},
      mP && ctx.power && ctx.power.ref ? later(data.loadPower(ctx.power.ref), 9000, null) : null,
      mW && ctx.weatherRef ? later(data.loadWeather(ctx.weatherRef), 9000, null) : null,
      mR ? later(loadResults(), 6000, null) : null,
    ]);
    const next = async () => { await yieldTask(); return lazy === mine; };
    if (!(await next())) return;
    const m = mods || {};
    const safe = (fn) => { try { return fn(); } catch (e) { warn('mount', e); return null; } };
    // a WP7 module missing or failing: its static stand-in (fallbacks.js, loaded only then); an empty one hides the section
    const fb = (node, fn, ...a) => loadFallbacks().then((F) => {
      if (lazy !== mine || !F) return;
      node.innerHTML = F[fn](...a, ctx);
      if (!node.innerHTML.trim()) node.closest('[data-sec]').hidden = true;
    });
    if (mR && !(mine.results = rl && safe(() => rl.mount(mR, withExtra(race), { i18n, data, stage: nx.stage, cites: () => ctxLast && ctxLast.cites })))) mR.closest('[data-sec]').hidden = true;
    if (mW && !(await next())) return;
    if (mW) {
      if (weather && m.createWeatherBoard) {
        const s = series && series.summary;
        mine.wx = safe(() => m.createWeatherBoard(mW, weather, { i18n, measured: s && s.temp_device_c != null ? { tempC: s.temp_device_c, device: series.device } : null }));
      }
      if (!mine.wx && weather) fb(mW, 'weatherStatic', weather);
      else if (!mine.wx) mW.closest('[data-sec]').hidden = true;
    }
    if (mP && !(await next())) return;
    if (mP) {
      if (series && m.createPowerChart) {
        mine.chart = safe(() => m.createPowerChart(mP, series, { i18n, reducedMotion: reduced() }));
        if (mine.chart && m.createReplay) {
          mine.replay = safe(() => m.createReplay({
            series, chart: mine.chart, weather: mine.wx || null, audio, bus, i18n, live: el.live,
            scene: race.scene || null, finish: !(race.result && race.result.type === 'dnf'),
          }));
        }
      }
      if (!mine.chart && series) fb(mP, 'powerStatic', series);
      else if (!mine.chart) mP.innerHTML = `<p class="rs-d-note">${esc(t('d.power.failed'))}</p>`;
      drawChart(mine);
    }
    if (mM && !(await next())) return;
    if (mM) {
      // the stage point is its start town (WP2 stages[].geo): label it with that town, not with "Stage n"
      const stages = (race.stages || []).filter((s) => s && s.geo && s.geo.lat != null).map((s) => ({ n: s.n, lat: s.geo.lat, lon: s.geo.lon, label: s.from ? { de: s.from, en: s.from } : s.name }));
      const countries = (race.countries || []).filter(Boolean);
      if (m.createLocator) mine.map = safe(() => m.createLocator(mM, { geo: race.geo, label: race.place, country: race.country, countries: countries.length > 1 ? countries : null, precision: race.geo.precision, stages }, { i18n }));
      if (!mine.map) fb(mM, 'placeStatic', race);
    }
    if (mF && !(await next())) return;
    if (mF) {
      if (m.createPrints) mine.prints = safe(() => m.createPrints(mF, ctx.photos, { i18n, review }));
      if (!mine.prints) fb(mF, 'photosStatic', ctx.photos);
      // named by the section heading ("Fotos vom Vortag"), aria-labelledby wins over its aria-label
      const strip = mF.querySelector('.rs-prints, .rs-d-phs');
      if (strip) strip.setAttribute('aria-labelledby', 'rs-d-h-photos');
    }
  }

  function drawChart(mine = lazy) {
    if (!mine || !mine.chart || !mine.want || mine.drawn) return;
    mine.drawn = true;
    call(mine.chart, 'draw', { reveal: 1, animate: !reduced() && !document.hidden });
  }
  function wantChart() {
    if (!lazy) return;
    lazy.want = true;
    drawChart(lazy);
  }

  /** Photo-finish slit over the result (1500 to 2450 ms); verified wins get the bell (S10). */
  function revealResult(animate, withSound = true) {
    const board = el.body.querySelector('[data-d-reveal]');
    const res = cur && cur.race ? cur.race.result : null;
    const quiet = Boolean(tl && tl.fast);          // fast-forwarded (quick prev/next, hidden tab): no clock tick
    const sound = () => { if (withSound && !quiet && audio && res && res.src && res.src.length) call(audio, 'result', { win: res.win === true }); };
    if (!board) return;
    if (!animate || !tl || tl.fast) { board.classList.remove('is-armed', 'is-revealing'); board.classList.add('is-revealed'); sound(); return; }
    board.classList.add('is-revealing');
    const mine = tl;
    mine.at(mine.elapsed() + 950, () => { board.classList.remove('is-armed', 'is-revealing'); board.classList.add('is-revealed'); sound(); });
  }
  function armReveal(on) {
    const board = el.body.querySelector('[data-d-reveal]');
    if (board) board.classList.toggle('is-armed', on);
  }

  // ---- wall geometry
  function norm(q) {
    if (!Array.isArray(q) || q.length !== 4) return null;
    const out = q.map((p) => (Array.isArray(p) ? [p[0], p[1]] : p && typeof p === 'object' ? [p.x, p.y] : null));
    return out.every((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? out : null;
  }
  function toScreen(pts) {
    const viaStage = norm(call(wall, 'quadToScreen', pts));
    if (pts.length === 4 && viaStage) return viaStage;
    const svg = document.querySelector('svg.rs-hit');
    const m = svg && svg.getScreenCTM && svg.getScreenCTM();
    if (m && svg.getBoundingClientRect().width > 0) return pts.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
    const img = document.querySelector('img.rs-wall');
    const r = img && img.getBoundingClientRect();
    if (!r || !r.width) return null;
    return pts.map(([x, y]) => [r.left + (x / 4789) * r.width, r.top + (y / 3527) * r.height]);
  }
  const wallQuad = (bib) => (bib && Array.isArray(bib.quad) && bib.quad.length === 4 ? norm(toScreen(bib.quad)) : null);
  function pans(bib) {
    const pts = bib && Array.isArray(bib.pins) && bib.pins.length ? toScreen(bib.pins) : null;
    const w = innerWidth || 1;
    return pts ? pts.slice(0, 4).map((p) => Math.max(-1, Math.min(1, (p[0] / w) * 2 - 1))) : undefined;
  }
  const roomVisible = () => wall.visible !== false && !(document.documentElement.classList.contains('rs-list-only'));

  // ---- dialog shell
  function inertOutside(on) {
    if (on) {
      for (const n of document.body.children) {
        if (n === dialog || n.tagName === 'SCRIPT' || n.tagName === 'DIALOG' || n.matches('[data-rs-live], .rs-live, .rs-flight') || n.inert) continue;
        n.inert = true;
        inerted.push(n);
      }
    } else {
      for (const n of inerted) n.inert = false;
      inerted = [];
    }
  }

  function showShell() {
    if (!dialog.open) {
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }
    }
    inertOutside(true);
    window.addEventListener('keydown', onKey, true);
    el.scroll.scrollTop = 0;
  }

  function cancelShellAnims() {
    for (const n of [dialog, el.scrim, el.sheet, el.headtext, el.body, el.foot, el.card, el.excap]) {
      for (const a of n.getAnimations ? n.getAnimations() : []) { try { a.cancel(); } catch (_) { /* gone */ } }
    }
  }

  function removeFlyer() {
    if (flyer) { flyer.remove(); flyer = null; }
    el.flight.textContent = '';
  }

  function soundOpen(nx, delay = 0) {
    if (!audio) return;
    clearTimeout(soundTimer);
    const go = () => {
      if (!cur || cur !== nx) return;
      const ref = weatherRef(nx.race, nx.stage);
      call(audio, 'open', nx.race || nx.bib, { weather: ref ? data.loadWeather(ref) : null, stage: nx.stage });
    };
    if (delay) soundTimer = setTimeout(go, delay); else go();
  }

  // ---- open
  async function openFresh(nx, origin) {
    const my = ++seq;
    phase = 'opening';
    from = origin || 'wall';
    cur = nx;
    queued = null;
    const a = document.activeElement;
    trigger = a && a !== document.body && !dialog.contains(a) ? a : null;
    tl = createTimeline();
    const line = tl;
    const hidden = document.hidden;
    const rm = reduced();
    if (!S) {
      try { await later(loadSections(), 6000, null); } catch (e) { warn('sections', e); }
      if (my !== seq) return;
      if (!S) { phase = 'closed'; cur = null; if (bus) bus.emit('dossier:closed', { bibId: nx.bibId, raceId: nx.raceId, reason: 'error' }); return; }
    }
    const waitX = Boolean(nx.race && nx.race.dossier) && !extraOf.has(nx.race.id);
    const artP = artWait(nx.bib);
    if (waitX || artP) {
      await later(Promise.all([waitX && loadExtra(nx.race), artP]), hidden ? 0 : 350, null);
      if (my !== seq) return;
      if (waitX && !extraOf.has(nx.race.id)) loadExtra(nx.race).then(() => { if (cur === nx && phase !== 'closed') lateExtra(); });
    }
    render(nx, null, hidden ? 'drawn' : 'photo');
    el.sheet.classList.remove('is-dealt', 'is-instant');
    el.card.classList.remove('is-waiting');
    const bib = nx.bib;
    const slotEl = AX ? AX.slot() : el.card;
    if (AX && !rm && !hidden) AX.prime(bib);
    const quad = !rm && !hidden && flight && bib && slotEl && from !== 'list' && roomVisible() ? wallQuad(bib) : null;
    const fly = Boolean(quad && flight.quadVisible(quad, from === 'wall' ? 0.2 : undefined));   // 0.2: b50 on phones
    const card = nx.mode === 'card' || from === 'list';
    dialog.dataset.entry = hidden ? 'instant' : rm ? 'fade' : fly ? 'flight' : card ? 'card' : 'rise';
    armReveal(!rm && !hidden);
    showShell();
    focusTitle();
    call(wall.label, 'hide');
    mountLazy(nx, true);
    if (audio && fly) call(audio, 'pins', pans(bib));
    soundOpen(nx);

    if (hidden || rm) {
      el.sheet.classList.add('is-dealt', 'is-instant');
      if (bib) { handed = bib.id; call(wall, 'vacate', bib.id); }
      if (rm && !hidden) {
        line.add(el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear', fill: 'backwards' }));
        await line.wait(finished([line.add(el.sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear', fill: 'backwards' }))]), 700);
      }
      if (my !== seq) return;
      opened(line, false);
      return;
    }

    if (fly) {
      el.card.classList.add('is-waiting');
      const slot = flight.slotQuad ? flight.slotQuad(slotEl, -2) : null;    // before the sheet's entrance transform
      line.add(el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 640, delay: 60, easing: CINE, fill: 'backwards' }));
      line.add(el.sheet.animate(phone()
        ? [{ transform: 'translateY(100%)' }, { transform: 'none' }]
        : [{ opacity: 0, transform: 'translateY(28px) scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: 450, easing: SPRING, fill: 'backwards' }));
      // t = 0: pins pop, the paper rises to 48 u, the spot goes dark (renderer); its own hand-off is at +300 ms
      const det = call(wall, 'detach', bib.id);
      handed = bib.id;
      const lifted = det && norm(det.quad);
      const q0 = wallQuad(bib) || quad;
      restQuad = q0;
      line.at(60, () => { dollied = true; call(wall, 'dolly', bib.id, { dur: 640 }); });
      let land;
      const landed = new Promise((r) => { land = r; });
      line.at(300, async () => {
        const q1 = wallQuad(bib) || q0;
        const q = lifted && q0 ? follow(lifted, q0, q1) : q1;
        const img = slotEl.querySelector('img');
        if (my !== seq) { land(null); return; }
        try {
          const f = await flight.flyToSlot({
            bibId: bib.id, fromQuad: q, slotEl, crop: { src: img ? img.currentSrc || img.src : data.assetURL(bib.crop.file), w: bib.crop.w, h: bib.crop.h },
            reduced: false, layer: el.flight, rotate: -2, dur: 900, toQuad: slot,
            // remeasured after the sheet's entrance: a moved slot bends the path (no snap at the hand-off)
            remeasure: () => (el.sheet.getAnimations().some((a) => a.playState === 'running') ? null : flight.slotQuad(slotEl, -2)),
            remeasureAt: 0.88,
            onStart: (fl) => { flyer = fl; for (const an of fl.rs.anims) line.add(an); },
          });
          land(f);
        } catch (e) { warn('flight', e); land(null); }
      });
      await line.wait(landed, 3200);
      if (my !== seq) return;
      el.card.classList.remove('is-waiting');
      removeFlyer();
      call(audio, 'land');
      el.sheet.classList.add('is-dealt');
      opened(line, true);
      return;
    }

    // no flight: the sheet rises (wall number off-screen) or slides in from the right (index card, list)
    line.add(el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: OUT, fill: 'backwards' }));
    const k = phone()
      ? [{ transform: 'translateY(100%)' }, { transform: 'none' }]
      : card ? [{ opacity: 0, transform: 'translateX(min(40vw, 480px))' }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0, transform: 'translateY(28px) scale(0.985)' }, { opacity: 1, transform: 'none' }];
    const sheetIn = line.add(el.sheet.animate(k, { duration: card ? 420 : 600, easing: SPRING, fill: 'backwards' }));
    if (bib) { handed = bib.id; call(wall, 'vacate', bib.id); }
    line.at(card ? 180 : 260, () => el.sheet.classList.add('is-dealt'));
    await line.wait(finished([sheetIn]), 1400);
    if (my !== seq) return;
    el.sheet.classList.add('is-dealt');
    opened(line, true);
  }

  /** Landed (or entered): deal-in runs, result reveal at +300 ms, chart at +400 ms, then queued actions. */
  function opened(line, animate) {
    phase = 'open';
    const base = line.elapsed();
    line.at(base + (animate ? 300 : 0), () => revealResult(animate));
    line.at(base + (animate ? 400 : 0), wantChart);
    line.at(base, () => AX && AX.begin(line));
    if (!dialog.contains(document.activeElement) || document.activeElement === dialog) focusTitle();
    if (bus) bus.emit('dossier:opened', { ...current(), from });
    runQueued();
  }

  function runQueued() {
    const q = queued;
    queued = null;
    if (!q || phase !== 'open') return;
    if (q.type === 'close') api.close(q.reason);
    else if (q.type === 'go') go(q.target, q.dir);
  }

  function lateExtra() {
    if (!S || !dialog.open) return;
    const top = el.scroll.scrollTop;
    const hadFocus = dialog.contains(document.activeElement);
    teardown();
    render(cur);
    el.scroll.scrollTop = top;
    if (phase === 'open') { revealResult(false, false); mountLazy(cur); wantChart(); } else mountLazy(cur);
    if (hadFocus && !dialog.contains(document.activeElement)) focusTitle();
  }

  // ---- switch (prev/next, list while open, other bib, stage)
  async function go(target, dir) {
    const nx = target && target.race !== undefined ? target : resolve(target);
    if (!nx) return;
    if (phase === 'opening' || phase === 'switching') {
      queued = { type: 'go', target: nx, dir };
      if (phase === 'switching' && tl) tl.ffwd();
      return;
    }
    if (phase !== 'open' || !cur) return;
    if (same(nx, cur)) return;
    if (nx.raceId === cur.raceId && nx.bibId === cur.bibId) { setStage(nx.stage); return; }
    const my = ++seq;
    phase = 'switching';
    pending = nx;
    const line = tl = createTimeline();
    const d = dir === 'prev' || dir < 0 ? -1 : 1;
    const prev = cur;
    const instant = reduced() || document.hidden;
    stale = detachLazy();
    if (prev.bibId && prev.bibId !== nx.bibId && handed === prev.bibId) { call(wall, 'attach', prev.bibId, { slap: false }); handed = null; }
    if (nx.bibId) {
      handed = nx.bibId;
      call(wall, 'vacate', nx.bibId);
      if (dollied) call(wall, 'dolly', nx.bibId, { dur: 720 });
    }
    const parts = [el.headtext, el.body, el.foot];
    const extraP = nx.race && nx.race.dossier && !extraOf.has(nx.race.id) ? loadExtra(nx.race) : null;
    const artP = artWait(nx.bib);
    if (!instant) {
      const outs = parts.map((n) => line.add(n.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-48 * d}px)` }], { duration: 170, easing: EASE_IN, fill: 'forwards' })));
      outs.push(line.add(el.card.animate([{ transform: 'rotate(-2deg) rotateY(0deg)' }, { transform: `rotate(-2deg) rotateY(${90 * d}deg)` }], { duration: 180, easing: EASE_IN, fill: 'forwards' })));
      outs.push(line.add(el.excap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE_IN, fill: 'forwards' })));
      await line.wait(finished(outs), 700);
      if (my !== seq) return;
    }
    if (extraP || artP) {
      await later(Promise.all([extraP, artP]), instant ? 0 : 300, null);
      if (my !== seq) return;
      if (extraP && !extraOf.has(nx.race.id)) extraP.then(() => { if (cur === nx && phase !== 'closed') lateExtra(); });
    }
    cur = nx;
    pending = null;
    destroyLazy(stale);
    stale = null;
    render(nx);
    el.scroll.scrollTop = 0;
    if (!instant && AX) { await AX.ready(260); if (my !== seq) return; }
    armReveal(!instant);
    for (const n of [...parts, el.card, el.excap]) for (const an of n.getAnimations()) an.cancel();
    focusTitle();
    const ins = instant ? [] : parts.map((n) => line.add(n.animate([{ opacity: 0, transform: `translateX(${48 * d}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: SPRING, fill: 'backwards' })));
    if (!instant) {
      ins.push(line.add(el.card.animate([{ transform: `rotate(-2deg) rotateY(${-90 * d}deg)` }, { transform: 'rotate(-2deg) rotateY(0deg)' }], { duration: 180, easing: OUT, fill: 'backwards' })));
      ins.push(line.add(el.excap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: OUT, fill: 'backwards' })));
    }
    if (AX) AX.ahead(d);
    if (bus) bus.emit('dossier:switch', { dir: d < 0 ? 'prev' : 'next', ...current() });
    say(t('d.switched', { title: nx.race ? i18n.L(nx.race.name) : t('label.unassigned') }));
    mountLazy(nx);
    soundOpen(nx, 450);
    line.at(instant ? 0 : 250, () => revealResult(!instant));
    line.at(instant ? 0 : 320, wantChart);
    if (ins.length) await line.wait(finished(ins), 900);
    if (my !== seq) return;
    phase = 'open';
    runQueued();
  }

  function setStage(n) {
    if (!cur || !cur.race) return;
    const focusKey = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-d-stage');
    const top = el.scroll.scrollTop;
    cur = { ...cur, stage: n == null ? null : Number(n) };
    teardown();
    render(cur);
    el.sheet.classList.add('is-dealt');
    el.scroll.scrollTop = top;
    revealResult(false, false);
    mountLazy(cur);
    wantChart();
    const back = focusKey != null ? el.body.querySelector(`[data-d-stage="${n}"]`) : null;
    if (back) back.focus({ preventScroll: true }); else if (!dialog.contains(document.activeElement)) focusTitle();
    if (bus) bus.emit('dossier:switch', { dir: 'stage', ...current() });
  }

  // ---- close
  function close(reason = 'button') {
    if (phase === 'closed') return Promise.resolve();
    if (phase === 'closing') {
      if (tl) tl.ffwd();
      return closing || Promise.resolve();
    }
    if (phase === 'switching') {
      queued = { type: 'close', reason };
      if (tl) tl.ffwd();
      return Promise.resolve();
    }
    closing = phase === 'opening' ? reverseOpen(reason) : closeAnimated(reason);
    return closing;
  }

  /** Esc, × or Back during the opening (5.5): scrim and sheet play backwards, the camera returns now, a number in
   *  flight turns round where it is and lands on its spot as the camera arrives (restQuad). */
  async function reverseOpen(reason) {
    const my = ++seq;
    phase = 'closing';
    const line = tl;
    line.kill();
    const toQuad = flyer && flyer.rs && cur && cur.bib ? restQuad || wallQuad(cur.bib) : null;
    const fl = toQuad && typeof flight.redirect === 'function' ? flyer : null;
    const own = new Set(fl ? fl.rs.anims : []);
    const live = line.anims().filter((a) => a.playState !== 'idle' && !own.has(a));
    let longest = 0;
    for (const a of live) {
      try { longest = Math.max(longest, Number(a.currentTime) || 0); a.reverse(); } catch (_) { /* no fill */ }
    }
    const back = createTimeline();
    for (const a of live) back.add(a);
    tl = back;
    if (dollied) { dollied = false; call(wall, 'restore'); }
    const waits = [finished(live)];
    if (fl) {
      const { bib } = cur;
      longest = Math.max(longest, 640);
      waits.push(flight.redirect(fl, { toQuad, remeasure: () => wallQuad(bib) }).then(() => handOver(my)));
    } else if (handed && !flyer) { call(wall, 'attach', handed, { slap: dialog.dataset.entry === 'flight' }); handed = null; }
    await back.wait(Promise.all(waits), Math.min(1600, longest + 400));
    if (my !== seq) return;
    if (handed) { call(wall, 'attach', handed, { slap: Boolean(flyer) }); handed = null; }
    finalize(reason);
  }

  /** Back on the spot: the wall bib takes over under the flyer, parked on the page until the room shows the bib. */
  function handOver(my) {
    if (my !== seq || !flyer) return;
    if (handed) { call(wall, 'attach', handed, { slap: true }); handed = null; }
    const page = document.querySelector('.rs-flight');
    if (page) { page.appendChild(flyer); parked = flyer; flyer = null; }
  }

  async function closeAnimated(reason) {
    const my = ++seq;
    phase = 'closing';
    if (tl) tl.kill();
    const line = tl = createTimeline();
    const nx = cur;
    const rm = reduced();
    const hidden = document.hidden;
    stale = detachLazy();
    clearTimeout(soundTimer);
    call(audio, 'close');
    const toQuad = !rm && !hidden && flight && nx.bib && handed === nx.bibId && from !== 'list' && roomVisible() ? wallQuad(nx.bib) : null;
    const backEl = AX ? AX.slot() : el.card;
    const fly = Boolean(toQuad && backEl && flight.quadVisible(toQuad, 0.2) && backEl.querySelector('img'));
    const d0 = fly && !hidden && AX ? AX.revert() : 0;
    if (!hidden) {
      const dur = rm ? 160 : 400;
      const sheetOut = phone() && !rm
        ? [{ transform: 'none' }, { transform: 'translateY(100%)' }]
        : from === 'list' && !rm && !fly ? [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(min(30vw, 360px))' }]
          : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: rm ? 'none' : 'translateY(20px)' }];
      const anims = [
        line.add(el.scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: rm ? 160 : 560, delay: d0, easing: OUT, fill: 'forwards' })),
        line.add(el.sheet.animate(sheetOut, { duration: dur, delay: d0, easing: rm ? 'linear' : CINE, fill: 'forwards' })),
      ];
      if (!rm) for (const n of [el.headtext, el.body, el.foot]) anims.push(line.add(n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: OUT, fill: 'forwards' })));
      if (fly) {
        let done;
        const flown = new Promise((r) => { done = r; });
        line.at(d0 || 120, async () => {
          el.card.classList.add('is-waiting');
          try {
            const f = await flight.flyBack({ fromEl: backEl, toQuad, rotate: -2, dur: 640, layer: el.flight });
            flyer = f;
            if (f && f.rs) for (const an of f.rs.anims) line.add(an);
          } catch (e) { warn('flyBack', e); }
          done();
        });
        anims.push({ finished: flown });
      }
      await line.wait(Promise.all(anims.map((a) => a.finished.catch(() => null))), (fly ? 1500 : 900) + d0);
      if (my !== seq) return;
    }
    if (fly && !hidden) handOver(my);
    if (handed) { call(wall, 'attach', handed, { slap: fly }); handed = null; }
    finalize(reason);
  }

  function finalize(reason) {
    const done = cur;
    const origin = from;
    teardown();
    if (AX) AX.reset();
    if (tl) tl.kill();
    tl = null;
    removeFlyer();
    phase = 'closed';
    cur = null;
    queued = null;
    pending = null;
    restQuad = null;
    closing = null;
    clearTimeout(soundTimer);
    window.removeEventListener('keydown', onKey, true);
    if (dialog.open) { try { dialog.close(); } catch (_) { dialog.removeAttribute('open'); } }
    cancelShellAnims();
    el.sheet.classList.remove('is-dealt', 'is-instant');
    el.card.classList.remove('is-waiting');
    el.body.textContent = '';
    inertOutside(false);
    if (dollied) { dollied = false; call(wall, 'restore'); }
    returnFocus(done, origin);
    if (parked) { const f = parked; parked = null; frames(3).then(() => f.remove()); }
    if (bus) bus.emit('dossier:closed', { bibId: done ? done.bibId : null, raceId: done ? done.raceId : null, reason });
  }

  /** Focus after closing: list row, bib on the wall, else the room or row in view; never off screen. */
  function returnFocus(done, origin) {
    const row = (id) => (id ? document.querySelector(`.rs-row[data-id="${String(id).replace(/"/g, '')}"] .rs-row__link`) : null);
    const visible = (n) => n && n.isConnected && n.getClientRects().length > 0;
    const inView = (n) => { const r = n.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
    let target = null;
    if (done && origin === 'list') target = row(done.raceId || done.bibId);
    if (!visible(target) && done && done.bibId && origin !== 'list') {
      const link = call(wall, 'link', done.bibId);
      if (link) {
        call(wall, 'ensureVisible', done.bibId);
        if (wall.hit && typeof wall.hit.focus === 'function') { call(wall, 'focus', done.bibId); return; }
        target = link;
      }
    }
    if (!visible(target) && done && !done.bibId && origin !== 'list') {
      const r = row(done.raceId);
      const room = document.getElementById('wand');
      target = visible(r) && inView(r) ? r : visible(room) && inView(room) ? room : r;
    }
    if (!visible(target) && done) target = row(done.raceId || done.bibId);
    if (!visible(target)) target = trigger;
    trigger = null;
    if (target && target.isConnected) {
      try { target.focus({ preventScroll: true }); } catch (_) { /* detached */ }
      if (visible(target) && !inView(target)) {
        try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) { target.scrollIntoView(); }
      }
    }
  }

  // ---- input
  const lightboxOpen = () => Boolean(lightbox && lightbox.open);
  /** Focus inside something that scrolls sideways (weather board, tables): the arrows scroll it. */
  function scrollsX(node) {
    for (let n = node; n && n.nodeType === 1 && n !== el.scroll && n !== dialog; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
    }
    return false;
  }
  function onKey(e) {
    if (phase === 'closed' || e.defaultPrevented || lightboxOpen()) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      lastEsc = performance.now();
      close('esc');
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const tg = e.target;
      if (tg && (tg.isContentEditable || (tg.closest && tg.closest('input, select, textarea, [role="slider"], [role="tablist"], [role="region"][tabindex], [data-rl-wrap], .rs-d-chips, .rs-wx__scroll')))) return;
      if (tg && tg !== document.body && !dialog.contains(tg)) return;
      if (tg && dialog.contains(tg) && scrollsX(tg)) return;
      e.preventDefault();
      api.switch(e.key === 'ArrowLeft' ? 'prev' : 'next');
    }
  }

  /** Citation chip: scroll to its sources, highlight them, offer "Zurück zum Text" (position and focus restored). */
  function dropBack() {
    for (const b of el.body.querySelectorAll('[data-d-back]')) b.remove();
    back = null;
  }
  function jumpToSource(chip) {
    const nums = String(chip.getAttribute('data-cites') || chip.getAttribute('data-cite') || '').split(/\s+/).filter(Boolean);
    const lis = nums.map((n) => el.body.querySelector(`#rs-d-src-${n}`)).filter(Boolean);
    const li = lis[0];
    if (!li) return;
    dropBack();
    back = { top: el.scroll.scrollTop, chip };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rs-d-src__back';
    btn.setAttribute('data-d-back', '');
    btn.innerHTML = `<span aria-hidden="true">↑</span>${esc(t('d.back'))}`;
    li.prepend(btn);                                  // first in the row: Tab, Enter goes back
    const top = li.getBoundingClientRect().top - el.scroll.getBoundingClientRect().top + el.scroll.scrollTop - 24;
    el.scroll.scrollTo({ top, behavior: reduced() ? 'auto' : 'smooth' });
    for (const n of el.body.querySelectorAll('.rs-d-src li.is-hit')) n.classList.remove('is-hit');
    void li.offsetWidth;
    for (const n of lis) n.classList.add('is-hit');
    try { li.focus({ preventScroll: true }); } catch (_) { /* old */ }
  }
  function toSources() {
    const h = el.body.querySelector('#rs-d-h-sources');
    const li = el.body.querySelector('#rs-d-src-1');
    if (!h || !li) return;
    const top = h.getBoundingClientRect().top - el.scroll.getBoundingClientRect().top + el.scroll.scrollTop - 24;
    el.scroll.scrollTo({ top, behavior: reduced() ? 'auto' : 'smooth' });
    try { li.focus({ preventScroll: true }); } catch (_) { li.focus(); }
  }
  function backToText() {
    const b = back;
    dropBack();
    for (const n of el.body.querySelectorAll('.rs-d-src li.is-hit')) n.classList.remove('is-hit');
    if (!b) return;
    el.scroll.scrollTo({ top: b.top, behavior: reduced() ? 'auto' : 'smooth' });
    const chip = b.chip && b.chip.isConnected ? b.chip : null;
    if (chip) { try { chip.focus({ preventScroll: true }); } catch (_) { chip.focus(); } } else focusTitle();
  }

  dialog.addEventListener('click', (e) => {
    const tg = e.target;
    if (tg === el.scrim || tg === dialog) { if (phase === 'open') close('backdrop'); return; }
    const act = tg.closest && tg.closest('[data-d-act]');
    if (act) {
      const a = act.getAttribute('data-d-act');
      if (a === 'close') close('button'); else api.switch(a);
      return;
    }
    const cite = tg.closest && tg.closest('[data-cite]');
    if (cite) { jumpToSource(cite); return; }
    if (tg.closest && tg.closest('[data-d-back]')) { backToText(); return; }
    if (tg.closest && tg.closest('[data-d-skip]')) { toSources(); return; }
    if (AX && tg.closest && tg.closest('[data-d-recon]')) { AX.toggle(tg.closest('[data-d-recon]')); return; }
    const stg = tg.closest && tg.closest('[data-d-stage]');
    if (stg && phase === 'open') { setStage(Number(stg.getAttribute('data-d-stage'))); return; }
    const other = tg.closest && tg.closest('[data-d-bib]');
    if (other && cur) go({ raceId: cur.raceId, bibId: other.getAttribute('data-d-bib') }, 1);
  });
  dialog.addEventListener('cancel', (e) => {
    if (e.cancelable) e.preventDefault();
    if (performance.now() - lastEsc < 250) return;          // the keydown already handled this Esc
    close('esc');
  });
  // the browser closed the dialog itself (uncancellable close request): clean up without motion
  dialog.addEventListener('close', () => { if (phase !== 'closed') { handed && call(wall, 'attach', handed, { slap: false }); handed = null; finalize('esc'); } });
  el.scrim.addEventListener('mousedown', (e) => e.preventDefault());   // a click on the dimmed room never steals focus
  el.scrim.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  el.scrim.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && tl) tl.ffwd();
    if (document.hidden && phase === 'open' && AX) AX.settle();
  });
  if (bus) {
    bus.on('replay:state', (s) => {
      if (phase === 'closed' || !s) return;
      call(wall.renderer, 'breathe', s.playing ? s.w || 0 : 0, s.playing ? s.kph || 0 : 0);
    });
  }
  if (typeof i18n.onLangChange === 'function') i18n.onLangChange(() => api.relabel());
  if (bus) {
    bus.on('wall:hover', (h) => {
      if (!h || !h.bibId) return;
      prefetch(h.bibId);
      // a tapped number's card: its drawing starts decoding now
      if (h.via === 'touch') { const b = data.getBib(h.bibId); Promise.resolve(artWait(b)).then(() => { if (phase === 'closed' && b && ax()) AX.prime(b); }); }
    });
  }
  document.addEventListener('pointerover', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.rs-row[data-id]') : null;
    if (row) prefetch(row.getAttribute('data-id'));
  }, { passive: true });
  { const m = /[#&]race=([a-z0-9-]+)/.exec(location.hash || ''); if (m) setTimeout(() => prefetch(m[1]), 0); }
  if (/[#&](race|bib)=/.test(location.hash || '')) loadSections().catch(noop);
  else if ('requestIdleCallback' in window) requestIdleCallback(() => loadSections().catch(noop), { timeout: 4000 });
  else setTimeout(() => loadSections().catch(noop), 1500);

  // ---- API
  const api = {
    open(target = {}) {
      const nx = resolve(target);
      if (!nx) return Promise.resolve();
      if (phase === 'open' || phase === 'switching' || phase === 'opening') {
        const nb = cur ? nbOf(cur.raceId || cur.bibId) : null;
        const dir = nb && nb.prev && nb.prev.raceId === nx.raceId && nb.prev.bibId === nx.bibId ? -1 : 1;
        return go(nx, dir);
      }
      if (phase === 'closing') {
        if (tl) tl.ffwd();
        return (closing || Promise.resolve()).then(() => openFresh(nx, target.from));
      }
      return openFresh(nx, target.from);
    },
    close,
    switch(dir) {
      // quick presses step on from the target on its way
      const from = (queued && queued.type === 'go' && queued.target) || pending || cur;
      if (!from) return Promise.resolve();
      const nb = nbOf(from.raceId || from.bibId);
      const back = dir === 'prev' || dir < 0;
      const tg = back ? nb.prev : nb.next;
      return tg ? go(tg, back ? -1 : 1) : Promise.resolve();
    },
    isOpen: () => phase === 'opening' || phase === 'open' || phase === 'switching',
    current,
    relabel() {
      if (!S || !cur || phase === 'closed' || !dialog.open) return;
      const keep = {};
      for (const m of el.body.querySelectorAll('[data-mount]')) keep[m.getAttribute('data-mount')] = m;
      const top = el.scroll.scrollTop;
      const f = document.activeElement;
      const hadFocus = dialog.contains(f);
      render(cur, keep);
      el.scroll.scrollTop = top;
      revealResult(false, false);
      // focus inside a kept part (results tab, chart) comes back with it
      if (hadFocus && f.isConnected && dialog.contains(f)) f.focus({ preventScroll: true });
      else if (hadFocus && !dialog.contains(document.activeElement)) focusTitle();
    },
  };
  return api;
}

export default createDossier;
