/**
 * captions.js: one caption line for everything the page makes audible (spec 6, 7).
 *
 *   captions.mount(el)                    -> unmount()   (el is marked aria-hidden)
 *   captions.push({ id, text, level, ms, quote, lang }) -> boolean (shown or queued)
 *   captions.setMode('auto' | 'on' | 'off'); captions.mode(); captions.toggle()
 *   captions.setSound(on)                 // 'auto' shows captions only while sound is on
 *   captions.visible()                    // would a pushed caption show right now?
 *   captions.onShow(fn) / captions.onChange(fn) -> off()
 *   captions.text(id, vars?)              // dictionary lookup -> { de, en }
 *   captions.pending()                    // QA: { queued: [ids], held: [ids] }
 *
 * Priorities: scene > event > minor > ambient ('ambient' = random bed events: any cue the visitor
 * triggers replaces them at once; styled like minor). A caption is protected for 2.3 s: a lower or equal
 * priority caption waits in the queue (and is dropped when it would come too late: 1.2 s for
 * ambient, 1.8 s minor, 3 s event, 4 s scene, because the sound it describes is over). A higher priority caption replaces it at once.
 * Text is { de, en } (or a plain string); `quote` + `lang` mark a foreign-language quote, which
 * is rendered in a <span lang>. The element is aria-hidden: screen readers get the live region
 * of the page instead (spec 7).
 *
 * Room line (spec 7: nothing covers the lit bib): a line mounted in the wall room (.rs-room, not in a
 * dialog) keeps clear of the museum label or touch card and of the lit bib. It stays home (its HUD spot
 * from the CSS) while that is free, else it takes the nearest free spot in the visible room (up, down or
 * sideways), clear of the HUD. With the touch card up and no free spot anywhere, minor and ambient captions wait
 * until the card closes or a spot frees up (dropped after 5 / 8 s: the sound is over by then), and scene
 * and event captions dock to the card's edge as a strip. The line moves by CSS custom properties only
 * (--rs-cap-dx, --rs-cap-dy, --rs-cap-w; audio.css). Lines in a dialog (the dossier) never move.
 * No dependencies; storage wrapped in try/catch; no network.
 */

const PRIO = { ambient: 0, minor: 1, event: 2, scene: 3 };
const DEFAULT_MS = { ambient: 3000, minor: 3200, event: 3800, scene: 4800 };
const PROTECT_MS = 2300;
// a queued caption is dropped when the sound it describes is over (short sounds expire sooner)
const STALE_MS = { ambient: 1200, minor: 1800, event: 3000, scene: 4000 };
// room line: captions that may wait for the touch card to close, and for how long
const HOLD_MS = { ambient: 5000, minor: 8000 };
const RELEASE_MS = 160;           // after the card closes (it fades in 120 ms); a dossier opening claims the line first
const KEY = 'tj-rs-cc';
const MODES = ['auto', 'on', 'off'];

// what the room line keeps clear of (markup of the shell and the wall modules, read only)
const ROOM = '.rs-room';
const LABEL = '.rs-label';                                  // museum label (desktop) or touch card (data-mode="card")
const LABEL_BOX = '.rs-label__card';
const LIT = '.rs-hit a[data-hover]:not([data-halo])';       // the hovered, focused or tapped bib
const STAGE = '.rs-stage';                                  // camera (pan, dolly) writes its style
const HUD = '.rs-hud__room, .rs-hud__controls, .rs-ask, .rs-rail, .rs-season-card--hud';
const HEADER = '.gl-site-header';                           // sticky: covers the room top when the page scrolls
const GAP = 8;                                              // px to the card, the HUD and the room top
const DOCK = 'rs-cap__text--dock';
const WATCH_ATTRS = ['class', 'style', 'data-hover', 'data-mode', 'data-pos', 'data-compact', 'data-via'];

/** Caption dictionary (cue sheet, spec 6). No em dashes; German quotes „…“. */
const T = {
  // S1 / S2
  'sound.on': { de: 'Ton an: Wind und fernes Publikum', en: 'Sound on: wind and a distant crowd' },
  'sound.off': { de: 'Ton aus', en: 'Sound off' },
  entry: { de: 'Das Feld rauscht vorbei: Ketten, Freiläufe, Reifen', en: 'The bunch rushes past: chains, freewheels, tyres' },
  'entry.clock': { de: 'Startuhr: drei kurze Töne, ein langer, dann das Klacken des Lichtschalters', en: 'Start clock: three short beeps, one long, then the click of the light switch' },
  // S5 / S6 / S7
  'dwell.be': { de: 'Von fern eine Hommage an den Rodania-Wagen', en: 'Far away, a homage to the Rodania car' },
  'dwell.fr': { de: 'Von fern Hupen der Werbekarawane', en: 'Far away, publicity caravan horns' },
  pins: { de: 'Nadeln springen auf', en: 'Pins pop open' },
  // S8 open stings (per scene) and the bunch after them
  'scene.be': { de: 'Lautsprecherwagen vor dem Feld, eine Hommage an den Rodania-Wagen: „Rodania!“', en: 'Loudspeaker car ahead of the race, a homage to the Rodania car: “Rodania!”' },
  'scene.fr': { de: 'Rennfunk: „{q}“, dann Hupen der Werbekarawane', en: 'Race radio: “{q}”, then publicity caravan horns', q: 'Radio Tour, information course', lang: 'fr' },
  'scene.fr.noq': { de: 'Rennfunk, dann Hupen der Werbekarawane', en: 'Race radio, then publicity caravan horns' },
  'scene.de': { de: 'Streckensprecher: „{q}“, dann die Glocke', en: 'Announcer: “{q}”, then the bell', q: 'Achtung, das Feld kommt!', lang: 'de' },
  'scene.de.noq': { de: 'Streckensprecher, dann die Glocke', en: 'Announcer, then the bell' },
  'scene.nl': { de: 'Streckensprecher: „{q}“, eine Fahrradklingel', en: 'Announcer: “{q}”, a bike bell', q: 'Opgelet, de renners komen!', lang: 'nl' },
  'scene.nl.noq': { de: 'Streckensprecher, eine Fahrradklingel', en: 'Announcer, a bike bell' },
  'scene.lu': { de: 'Streckensprecher, im Hintergrund eine Kirchenglocke', en: 'Announcer, a church bell in the background' },
  'scene.es': { de: 'Streckensprecher: „{q}“, Rufe am Straßenrand', en: 'Announcer: “{q}”, shouts at the roadside', q: '¡Vamos, vamos, vamos!', lang: 'es' },
  'scene.es.noq': { de: 'Streckensprecher, Rufe am Straßenrand', en: 'Announcer, shouts at the roadside' },
  'scene.ch': { de: 'Kuhglocken und ein Ruf: „Hopp!“', en: 'Cowbells and a shout: “Hopp!”' },
  'scene.other': { de: 'Streckensprecher und Publikum', en: 'Announcer and crowd' },
  'scene.mtb': { de: 'Nachts im Wald: eine Eule, ein Mountainbike kommt näher', en: 'At night in the forest: an owl, a mountain bike coming closer' },
  'scene.tt': { de: 'Startuhr piept, Fahrer rollt aus dem Starthaus', en: 'Start clock beeps, a rider rolls off the ramp' },
  'scene.bunch': { de: 'Das Feld rauscht vorbei', en: 'The bunch rushes past' },
  // S10 / S11 / S12
  result: { de: 'Zielfoto', en: 'Photo finish' },
  'result.win': { de: 'Glocke und Jubel: Sieg', en: 'Bell and cheering: a win' },
  'weather.rain': { de: 'Regen auf der Straße', en: 'Rain on the road' },
  'weather.wind': { de: 'Starker Wind', en: 'Strong wind' },
  replay: { de: 'Wiedergabe: Kette, Freilauf und Fahrtwind folgen meinen Daten', en: 'Replay: chain, freewheel and wind follow my data' },
  // S13 to S18 (replay moments)
  'moment.climb': { de: 'Anstieg: Kuhglocken am Straßenrand', en: 'Climb: cowbells at the roadside' },
  'moment.attack': { de: 'Antritt: das Begleitmotorrad zieht vorbei', en: 'Attack: the race motorbike passes' },
  'moment.descent': { de: 'Abfahrt: Fahrtwind', en: 'Descent: wind' },
  'moment.bell': { de: 'Glocke: letzte Runde', en: 'Bell: last lap' },
  'moment.bell.q': { de: 'Glocke: letzte Runde. Sprecher: „{q}“', en: 'Bell: last lap. Announcer: “{q}”' },
  'moment.sprint': { de: 'Zielsprint: Jubel und Streckensprecher', en: 'Final sprint: cheering and announcer' },
  'replay.end': { de: 'Ziel', en: 'Finish' },
  // S3 and scene beds: sparse random events by synth name (minor). Wall events get the "Fern:" form.
  'ev.cowbells': { de: 'Kuhglocken', en: 'Cowbells' },
  'ev.motorbike': { de: 'Ein Motorrad zieht vorbei', en: 'A motorbike passes' },
  'ev.scooter': { de: 'Ein Motorroller knattert vorbei', en: 'A scooter rattles past' },
  'ev.helicopter': { de: 'Der Fernsehhubschrauber', en: 'The TV helicopter' },
  'ev.rodania': { de: 'Der Lautsprecherwagen, eine Hommage an den Rodania-Wagen', en: 'The loudspeaker car, a homage to the Rodania car' },
  'ev.caravan': { de: 'Hupen der Werbekarawane', en: 'Publicity caravan horns' },
  'ev.caravan-horn': { de: 'Hupe der Werbekarawane', en: 'A caravan horn' },
  'ev.peloton': { de: 'Das Feld rauscht vorbei', en: 'The bunch rushes past' },
  'ev.bird': { de: 'Ein Vogel', en: 'A bird' },
  'ev.swift': { de: 'Mauersegler', en: 'Swifts' },
  'ev.gull': { de: 'Möwen', en: 'Gulls' },
  'ev.koel': { de: 'Ein Vogel ruft', en: 'A bird calls' },
  'ev.owl': { de: 'Eine Eule', en: 'An owl' },
  'ev.bell': { de: 'Die Glocke', en: 'The bell' },
  'ev.church-bell': { de: 'Eine Kirchenglocke', en: 'A church bell' },
  'ev.bike-bell': { de: 'Eine Fahrradklingel', en: 'A bike bell' },
  'ev.cheer': { de: 'Jubel', en: 'Cheering' },
  'ev.applause': { de: 'Applaus', en: 'Applause' },
  'ev.crowd': { de: 'Publikum', en: 'Crowd' },
  'ev.speaker': { de: 'Ein Streckensprecher', en: 'An announcer' },
  'ev.radio': { de: 'Rennfunk', en: 'Race radio' },
  'ev.shout': { de: 'Rufe am Straßenrand', en: 'Shouts at the roadside' },
  'ev.car-horn': { de: 'Ein Begleitwagen hupt', en: 'A team car honks' },
  'ev.car': { de: 'Ein Auto fährt vorbei', en: 'A car drives past' },
  'ev.mtb-rider': { de: 'Ein Mountainbike kommt näher und fährt vorbei', en: 'A mountain bike comes closer and passes' },
  'ev.disc': { de: 'Ein Zeitfahrer mit Scheibenrad rauscht vorbei', en: 'A time trial rider on a disc wheel rushes past' },
  'ev.tt-start': { de: 'Startuhr piept, ein Fahrer rollt aus dem Starthaus', en: 'Start clock beeps, a rider rolls off the ramp' },
  'ev.tt-clock': { de: 'Startuhr piept', en: 'Start clock beeps' },
  'ev.wind': { de: 'Wind', en: 'Wind' },
  'ev.tyre': { de: 'Reifen rauschen vorbei', en: 'Tyres hiss past' },
  'ev.chain': { de: 'Eine Kette surrt', en: 'A chain whirs' },
};

const listeners = { show: [], change: [] };
const targets = [];
const lines = new Map();  // room lines: el -> { room, mo, on }
let mode = readMode();
let soundOn = false;
let cur = null;           // { id, text, level, ms, shownAt, quote, lang }
let queue = [];
let held = [];            // room line: minor / ambient captions waiting for the touch card to close
let hideTimer = 0;
let protectTimer = 0;
let releaseTimer = 0;
let purgeTimer = 0;
let layoutRaf = 0;
let winOn = false;
let langFn = null;
let mo = null;

function readMode() {
  try { const v = window.localStorage.getItem(KEY); return MODES.indexOf(v) >= 0 ? v : 'auto'; } catch (e) { return 'auto'; }
}
function writeMode(v) { try { window.localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function curLang() {
  if (langFn) { try { return langFn() === 'en' ? 'en' : 'de'; } catch (e) { /* fall through */ } }
  const l = (typeof document !== 'undefined' && document.documentElement.getAttribute('lang')) || 'de';
  return l.toLowerCase().indexOf('en') === 0 ? 'en' : 'de';
}

/** Resolve a caption text for the current language. */
function resolve(c) {
  const t = c.text;
  if (t == null) return '';
  if (typeof t === 'string') return t;
  const l = curLang();
  return t[l] != null ? t[l] : (t.de || t.en || '');
}

function pickTarget() {
  const live = targets.filter((el) => el.isConnected);
  const inOpenDialog = live.filter((el) => { const d = el.closest('dialog'); return d && d.open; });
  if (inOpenDialog.length) return inOpenDialog[inOpenDialog.length - 1];
  const outside = live.filter((el) => !el.closest('dialog'));
  return outside.length ? outside[outside.length - 1] : null;
}

function spanOf(tgt) {
  let span = tgt.querySelector('.rs-cap__text');
  if (!span) { span = document.createElement('span'); span.className = 'rs-cap__text'; tgt.textContent = ''; tgt.appendChild(span); }
  return span;
}

/** Write a caption's text into the line's span (a foreign-language quote gets its own <span lang>). */
function fill(span, c) {
  const text = resolve(c);
  span.textContent = '';
  const q = c.quote, i = q ? text.indexOf(q) : -1;
  if (q && i >= 0 && c.lang) {
    span.appendChild(document.createTextNode(text.slice(0, i)));
    const s = document.createElement('span'); s.lang = c.lang; s.textContent = q; span.appendChild(s);
    span.appendChild(document.createTextNode(text.slice(i + q.length)));
  } else span.textContent = text;
}

function render() {
  const tgt = pickTarget();
  // the old text stays in place while it fades out
  for (const el of targets) if (el !== tgt || !cur) el.classList.remove('is-shown');
  if (!tgt || !cur) { syncWatch(); return; }
  const span = spanOf(tgt);
  fill(span, cur);
  tgt.setAttribute('data-level', cur.level);
  // restart the entry transition (a new caption takes its spot without sliding there)
  tgt.classList.remove('is-shown');
  if (lines.has(tgt) && place(tgt, span, cur) === 'hold') { park(); return; }
  void tgt.offsetWidth; tgt.classList.add('is-shown');
  syncWatch();
}

function emit(type, arg) { for (const f of listeners[type].slice()) { try { f(arg); } catch (e) { /* ignore */ } } }

/** Show a caption now; false when it has to wait for the touch card instead (room line, no free spot). */
function show(c) {
  const tgt = pickTarget();
  if (tgt && wouldHold(tgt, c)) { hold(c); return false; }
  clearTimeout(hideTimer); clearTimeout(protectTimer);
  cur = c; c.shownAt = now();
  render();
  if (cur !== c) return false;      // held after all (render parked it)
  emit('show', { id: c.id, text: resolve(c), level: c.level, ms: c.ms });
  hideTimer = setTimeout(hide, c.ms);
  if (queue.length) protectTimer = setTimeout(pump, PROTECT_MS);
  syncWatch();
  return true;
}

function hide() {
  clearTimeout(hideTimer); clearTimeout(protectTimer);
  cur = null;
  render();
  pump();
  syncWatch();
}

function pump() {
  const t = now();
  queue = queue.filter((q) => t - q.at < STALE_MS[q.level]);
  if (!queue.length) { if (!cur) scheduleRelease(); return; }
  if (cur && t - cur.shownAt < PROTECT_MS) { clearTimeout(protectTimer); protectTimer = setTimeout(pump, PROTECT_MS - (t - cur.shownAt) + 5); return; }
  queue.sort((a, b) => (PRIO[b.level] - PRIO[a.level]) || (a.at - b.at));
  while (queue.length) if (show(queue.shift())) return;
  scheduleRelease();
}

// ---------------------------------------------------------------- room line placement
const HOLDABLE = (c) => HOLD_MS[c.level] != null;

function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
}

/** Rect of a HUD piece that is really on screen (not display: none, hidden or faded out). */
function shownRect(el) {
  const r = rectOf(el);
  if (!r) return null;
  const cs = getComputedStyle(el);
  return cs.visibility === 'hidden' || +cs.opacity === 0 ? null : r;
}

/** The label's or card's box where it comes to rest (it rises a few px as it fades in: wall.css `translate`). */
function labelRect(lab) {
  const r = rectOf(lab.querySelector(LABEL_BOX) || lab);
  if (!r) return null;
  const m = /^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/.exec(getComputedStyle(lab).translate || '');
  const tx = m ? +m[1] : 0, ty = m && m[2] != null ? +m[2] : 0;
  return { l: r.l - tx, t: r.t - ty, r: r.r - tx, b: r.b - ty };
}

/** Where the line sits without any move (its layout box; transforms and transitions ignored). */
function homeOf(tgt, span) {
  const box = tgt.offsetParent;
  if (!box) return null;
  const b = box.getBoundingClientRect();
  const l = b.left + tgt.offsetLeft, t = b.top + tgt.offsetTop, w = span.offsetWidth, h = span.offsetHeight;
  return { l, t, r: l + w, b: t + h, w, h };
}

/** The lit bib's visible polygon in screen px (its SVG link is laid over the photo with a scale-and-shift camera). */
function polyOf(a) {
  const pg = a.querySelector('polygon');
  const pts = pg && pg.points;
  if (!pts || pts.numberOfItems < 3) return null;
  let bb;
  try { bb = pg.getBBox(); } catch (e) { return null; }
  const r = a.getBoundingClientRect();
  if (!(bb.width > 0 && bb.height > 0 && r.width > 0 && r.height > 0)) return null;
  const sx = r.width / bb.width, sy = r.height / bb.height, out = [];
  for (let i = 0; i < pts.numberOfItems; i++) { const p = pts.getItem(i); out.push([r.left + (p.x - bb.x) * sx, r.top + (p.y - bb.y) * sy]); }
  return out;
}

function inPoly(x, y, P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Does segment a-b touch rect q (Liang-Barsky)? */
function segHits(a, b, q) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], d = [a[0] - q.l, q.r - a[0], a[1] - q.t, q.b - a[1]];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (d[i] < 0) return false; continue; }
    const t = d[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}

function boxObstacle(r, pad) {
  return { box: r, pad, hits: (q) => q.l < r.r + pad - 0.5 && q.r > r.l - pad + 0.5 && q.t < r.b + pad - 0.5 && q.b > r.t - pad + 0.5 };
}

function polyObstacle(P) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const [x, y] of P) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  const pad = Math.round(4 + 0.03 * Math.max(r - l, b - t));   // the lifted paper grows about 3 % and casts a shadow
  const hits = (q) => {
    const e = { l: q.l - pad + 0.5, t: q.t - pad + 0.5, r: q.r + pad - 0.5, b: q.b + pad - 0.5 };
    if (e.r < l || e.l > r || e.b < t || e.t > b) return false;
    if (inPoly(e.l, e.t, P)) return true;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) if (segHits(P[j], P[i], e)) return true;
    return false;
  };
  return { box: { l, t, r, b }, pad, hits };
}

/** Nearest spot for a w x h line inside the region that touches no obstacle (candidates: edges of everything). */
function spot(home, obst, region) {
  const { w, h } = home;
  const xs = [home.l, region.l, region.r - w], ys = [home.t, region.t, region.b - h];
  for (const o of obst) { xs.push(o.box.r + o.pad, o.box.l - o.pad - w); ys.push(o.box.b + o.pad, o.box.t - o.pad - h); }
  let best = null;
  for (const x of xs) {
    if (x < region.l - 0.5 || x + w > region.r + 0.5) continue;
    for (const y of ys) {
      if (y < region.t - 0.5 || y + h > region.b + 0.5) continue;
      const q = { l: x, t: y, r: x + w, b: y + h };
      if (obst.some((o) => o.hits(q))) continue;
      const d = Math.hypot(x - home.l, y - home.t);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best;
}

/**
 * Where the room line goes for caption c (its text is in the span): { how: 'home' } | { how: 'free', dx, dy }
 * | { how: 'dock', card, side } | { how: 'hold' }. Reads layout only.
 */
function plan(tgt, span, c) {
  const L = lines.get(tgt);
  const room = L && L.room;
  if (!room || !room.isConnected) return { how: 'home' };
  const lab = room.querySelector(LABEL);
  const labOn = !!(lab && lab.classList.contains('is-on'));
  const lit = room.querySelector(LIT);
  if (!labOn && !lit) return { how: 'home' };                // nothing to keep clear of: no layout read
  const home = homeOf(tgt, span);
  if (!home || !home.w) return { how: 'home' };
  const card = labOn ? labelRect(lab) : null;
  const poly = lit ? polyOf(lit) : null;
  const avoid = [];
  if (card) avoid.push(boxObstacle(card, GAP));
  if (poly) avoid.push(polyObstacle(poly));
  if (!avoid.some((o) => o.hits(home))) return { how: 'home' };
  // anywhere in the visible room (the HUD's side margins kept), away from the HUD pieces below
  const rr = room.getBoundingClientRect();
  let top = rr.top;
  const hd = document.querySelector(HEADER);
  if (hd && /^(sticky|fixed)$/.test(getComputedStyle(hd).position)) top = Math.max(top, hd.getBoundingClientRect().bottom);
  const vh = window.innerHeight || document.documentElement.clientHeight || rr.bottom;
  const inset = Math.max(0, home.l - rr.left);
  const region = { l: rr.left + inset, r: rr.right - inset, t: top + GAP, b: Math.min(rr.bottom, vh) - GAP };
  const obst = avoid.slice();
  for (const el of room.querySelectorAll(HUD)) { const r = shownRect(el); if (r) obst.push(boxObstacle(r, GAP)); }
  const best = spot(home, obst, region);
  if (best) return { how: 'free', dx: best.x - home.l, dy: best.y - home.t };
  if (card && lab.getAttribute('data-mode') === 'card') {
    if (HOLDABLE(c)) return { how: 'hold' };
    const cs = getComputedStyle(lab.querySelector(LABEL_BOX) || lab);   // the strip's text lines up with the card's
    return { how: 'dock', card, pad: [cs.paddingLeft, cs.paddingRight], side: (card.t + card.b) / 2 > (rr.top + rr.bottom) / 2 ? 'top' : 'bottom' };
  }
  return { how: 'home' };
}

function setVar(el, k, v) { if (v == null) { if (el.style.getPropertyValue(k)) el.style.removeProperty(k); } else if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); }
function setAttr(el, k, v) { if (v == null) { if (el.hasAttribute(k)) el.removeAttribute(k); } else if (el.getAttribute(k) !== v) el.setAttribute(k, v); }

/** Plan and apply the room line's spot for caption c; returns the plan's how. */
function place(tgt, span, c) {
  span.classList.remove(DOCK);                        // plan with the plain line
  const pl = plan(tgt, span, c);
  if (pl.how === 'hold') return 'hold';
  let dx = 0, dy = 0;
  if (pl.how === 'dock') {                            // a strip on the card's edge, as wide as the card
    setVar(tgt, '--rs-cap-w', `${Math.round(pl.card.r - pl.card.l)}px`);
    setVar(tgt, '--rs-cap-pl', pl.pad[0] || null);
    setVar(tgt, '--rs-cap-pr', pl.pad[1] || null);
    span.classList.add(DOCK);
    const home = homeOf(tgt, span);
    if (home) {
      dx = pl.card.l - home.l;
      dy = pl.side === 'top' ? pl.card.t + 1 - home.h - home.t : pl.card.b - 1 - home.t;
    }
  } else {
    for (const k of ['--rs-cap-w', '--rs-cap-pl', '--rs-cap-pr']) setVar(tgt, k, null);
    if (pl.how === 'free') { dx = pl.dx; dy = pl.dy; }
  }
  setAttr(tgt, 'data-rs-cap', pl.how === 'home' ? null : pl.how);
  setAttr(tgt, 'data-rs-dock', pl.how === 'dock' ? pl.side : null);
  setVar(tgt, '--rs-cap-dx', Math.round(dx) ? `${Math.round(dx)}px` : null);
  setVar(tgt, '--rs-cap-dy', Math.round(dy) ? `${Math.round(dy)}px` : null);
  return pl.how;
}

/** Would caption c have to wait (touch card up, no free spot)? Trial layout; the line looks unchanged afterwards. */
function wouldHold(tgt, c) {
  if (!HOLDABLE(c) || !lines.has(tgt)) return false;
  const lab = lines.get(tgt).room.querySelector(LABEL);
  if (!(lab && lab.classList.contains('is-on') && lab.getAttribute('data-mode') === 'card')) return false;
  const span = spanOf(tgt);
  const keep = Array.from(span.childNodes), level = tgt.getAttribute('data-level'), dock = span.classList.contains(DOCK);
  fill(span, c);
  tgt.setAttribute('data-level', c.level);
  span.classList.remove(DOCK);
  const how = plan(tgt, span, c).how;
  span.replaceChildren(...keep);
  setAttr(tgt, 'data-level', level);
  if (dock) span.classList.add(DOCK);
  return how === 'hold';
}

function hold(c) {
  held = held.filter((h) => h.id !== c.id);
  held.push(c);
  if (held.length > 4) held.shift();
  clearTimeout(purgeTimer);
  purgeTimer = setTimeout(purge, Math.max(...held.map((h) => HOLD_MS[h.level] - (now() - h.at))) + 20);
  syncWatch();
}

function purge() {
  const t = now();
  held = held.filter((h) => t - h.at < HOLD_MS[h.level]);
  if (held.length) purgeTimer = setTimeout(purge, 500); else syncWatch();
}

/** The shown caption lost its spot (render found none): it waits, the queue goes on. */
function park() {
  const c = cur;
  cur = null;
  clearTimeout(hideTimer); clearTimeout(protectTimer);
  for (const el of targets) el.classList.remove('is-shown');
  if (c) hold(c);
  pump();
}

function scheduleRelease() {
  if (!held.length || cur || releaseTimer) return;
  releaseTimer = setTimeout(release, RELEASE_MS);
}

/** Can the room line still speak for the wall (no dossier taking over)? */
function lineFree(tgt) {
  if (document.documentElement.classList.contains('rs-dossier-open') || document.querySelector('dialog[open]')) return false;
  const cs = getComputedStyle(tgt);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

/** The card closed or a spot freed up: the latest held caption shows (older ones are over). */
function release() {
  releaseTimer = 0;
  if (cur || !held.length) return;
  const t = now();
  held = held.filter((h) => t - h.at < HOLD_MS[h.level]);
  const tgt = pickTarget();
  if (!held.length || !tgt || !lines.has(tgt) || !lineFree(tgt)) { held = []; syncWatch(); return; }
  held.sort((a, b) => (PRIO[b.level] - PRIO[a.level]) || (b.at - a.at));
  const c = held.shift();
  if (show(c)) held = [];
  syncWatch();
}

/** A layout change in the room (card, lit bib, camera, resize): move the line, park or release captions. */
function relayout() {
  layoutRaf = 0;
  if (!cur) { scheduleRelease(); return; }
  const tgt = pickTarget();
  if (!tgt || !lines.has(tgt) || !tgt.classList.contains('is-shown')) return;
  const span = tgt.querySelector('.rs-cap__text');
  if (span && place(tgt, span, cur) === 'hold') park();
}

function schedule() {
  if (layoutRaf || (!cur && !held.length) || typeof requestAnimationFrame === 'undefined') return;
  layoutRaf = requestAnimationFrame(relayout);
}

function onRoomChange(el, records) {
  for (const r of records) {
    const n = r.target;
    if (!n || el.contains(n)) continue;                          // the line itself
    if (r.type === 'childList') { if (n.closest && n.closest(LABEL)) { schedule(); return; } continue; }
    if (r.attributeName === 'style' && !(n.matches && n.matches(`${STAGE}, ${LABEL}`))) continue;   // the lamp etc.
    schedule();
    return;
  }
}

/** Watch the room only while a caption shows or waits. */
function syncWatch() {
  const need = held.length > 0 || !!(cur && lines.has(pickTarget()));
  for (const [, L] of lines) {
    if (need && !L.on && L.room.isConnected) { L.on = true; L.mo.observe(L.room, { subtree: true, childList: true, attributes: true, attributeFilter: WATCH_ATTRS }); }
    else if (!need && L.on) { L.on = false; L.mo.disconnect(); }
  }
  const want = need && lines.size > 0;
  if (want !== winOn && typeof window !== 'undefined') {
    winOn = want;
    const f = want ? 'addEventListener' : 'removeEventListener';
    window[f]('resize', schedule, { passive: true });
    window[f]('scroll', schedule, { passive: true });
  }
}

function visible() { return mode === 'on' || (mode === 'auto' && soundOn); }

function observeLang() {
  if (mo || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  mo = new MutationObserver(() => { if (cur) render(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}

/** Fill `{q}` placeholders; returns { de, en, quote, lang } or null. */
function text(id, vars) {
  const e = T[id];
  if (!e) return null;
  const q = vars && vars.q != null ? vars.q : e.q;
  const lang = vars && vars.lang ? vars.lang : e.lang;
  if (e.de.indexOf('{q}') < 0) return { de: e.de, en: e.en };
  return { de: e.de.replace('{q}', q), en: e.en.replace('{q}', q), quote: q, lang };
}

/** Far-away form for wall-bed events ("Fern: ein Motorrad zieht vorbei"). */
function far(t) {
  if (!t) return t;
  const low = (s, re) => s.replace(re, (m) => m.toLowerCase());
  const de = /^(Von fern|Fern:)/.test(t.de) ? t.de : 'Fern: ' + low(t.de, /^(Ein|Eine|Der|Die|Das)\b/);
  const en = /^Far away/.test(t.en) ? t.en : 'Far away: ' + low(t.en, /^(A|An|The)\b/);
  return Object.assign({}, t, { de, en });
}

export const captions = {
  mount(el) {
    if (!el) return () => {};
    el.setAttribute('aria-hidden', 'true');
    el.classList.add('rs-cap');
    if (targets.indexOf(el) < 0) targets.push(el);
    observeLang();
    // a caption line inside a <dialog> takes over while the dialog is open (dossier): follow open / close
    const dlg = el.closest('dialog');
    let dmo = null;
    if (dlg && typeof MutationObserver !== 'undefined') {
      dmo = new MutationObserver(() => {
        if (dlg.open && held.length) { held = []; syncWatch(); }   // the wall's waiting captions are over
        if (cur) render();
      });
      dmo.observe(dlg, { attributes: true, attributeFilter: ['open'] });
    }
    // a line in the wall room keeps clear of the label / touch card and the lit bib (see the header)
    const room = !dlg && el.closest(ROOM);
    if (room && !lines.has(el) && typeof MutationObserver !== 'undefined') {
      lines.set(el, { room, on: false, mo: new MutationObserver((recs) => onRoomChange(el, recs)) });
      syncWatch();
    }
    if (cur) render();
    return () => {
      const i = targets.indexOf(el); if (i >= 0) targets.splice(i, 1);
      el.classList.remove('is-shown');
      if (dmo) dmo.disconnect();
      const L = lines.get(el);
      if (L) { L.mo.disconnect(); lines.delete(el); syncWatch(); }
    };
  },
  /** Show a caption. text: { de, en } | string; level: 'scene' | 'event' | 'minor' | 'ambient'. */
  push(c) {
    if (!c || !c.text || !visible()) return false;
    const level = PRIO[c.level] != null ? c.level : 'minor';
    const item = { id: c.id || String(Math.random()), text: c.text, level, ms: c.ms || DEFAULT_MS[level], quote: c.quote || null, lang: c.lang || null, at: now() };
    if (cur && cur.id === item.id && now() - cur.shownAt < cur.ms) return true;   // same caption already up
    if (queue.some((q) => q.id === item.id)) return true;
    const waiting = held.find((h) => h.id === item.id);
    if (waiting) { waiting.at = item.at; return true; }                          // same sound again: still waiting
    if (!cur) { show(item); return true; }
    const elapsed = now() - cur.shownAt;
    if (PRIO[level] > PRIO[cur.level] || elapsed >= PROTECT_MS) { show(item); return true; }
    queue.push(item);
    clearTimeout(protectTimer); protectTimer = setTimeout(pump, PROTECT_MS - elapsed + 5);
    return true;
  },
  clear() { queue = []; held = []; hide(); },
  setMode(m) {
    if (MODES.indexOf(m) < 0) return;
    mode = m; writeMode(m);
    if (!visible()) { queue = []; held = []; clearTimeout(hideTimer); clearTimeout(protectTimer); cur = null; render(); syncWatch(); }
    emit('change', { mode, visible: visible() });
  },
  mode() { return mode; },
  /** UT button: flip what the visitor currently sees. */
  toggle() { captions.setMode(visible() ? 'off' : 'on'); return visible(); },
  setSound(on) {
    soundOn = !!on;
    if (!visible()) { held = []; if (cur) { queue = []; clearTimeout(hideTimer); cur = null; render(); } syncWatch(); }
    emit('change', { mode, visible: visible() });
  },
  /** QA: ids waiting in the queue and held for the touch card. */
  pending() { return { queued: queue.map((q) => q.id), held: held.map((h) => h.id) }; },
  visible,
  onShow(fn) { listeners.show.push(fn); return () => { const i = listeners.show.indexOf(fn); if (i >= 0) listeners.show.splice(i, 1); }; },
  onChange(fn) { listeners.change.push(fn); return () => { const i = listeners.change.indexOf(fn); if (i >= 0) listeners.change.splice(i, 1); }; },
  setLang(fn) { langFn = typeof fn === 'function' ? fn : null; if (cur) render(); },
  relabel() { if (cur) render(); },
  current() { return cur ? { id: cur.id, text: resolve(cur), level: cur.level } : null; },
  text,
  far,
  has(id) { return !!T[id]; },
  ids() { return Object.keys(T); },
};

export default captions;
