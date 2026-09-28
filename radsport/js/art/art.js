/**
 * art/art.js (round 2, package ui): the drawn exhibit of the dossier (D13, D14, D16, D17). Which bibs have a drawing,
 * how the photo crop sits inside it (photoRect), the exhibit card, the photo -> drawing hand-over and the
 * „Ergänztes zeigen“ hatch. The WebGL reveal itself is reveal.js (loaded at the first reveal). Loaded with the dossier
 * renderers (idle, first hover or first open), so none of this counts at interactive.
 *
 *   artInfo(bib, getBib) -> Promise<Art | null>   metadata of the bib's drawing (cached); null: keep the photo crop
 *   artKnown(bibId) -> Art | null | undefined      the same, synchronous (undefined: not asked yet)
 *   createExhibit(opts) -> exhibit controller for the dossier (see there)
 *   artImages(art), loadImg(url), devfix; the hatch itself is art/hatch.js (loaded at the first use of the toggle)
 *
 * Art: { id, src, w, h, rect: { x, y, w, h } (photo crop inside the drawing, drawing px) | null, registered (rect from
 *        the data), order, recon (urls or null), paper: [r, g, b] 0..1, alias (bibId or null), digits }
 *
 * Where drawings come from, first hit wins:
 *   1. bibs.json `art` of the bib (build_data.py writes it when radsport/img/bibs-art/<id>.json exists; paths relative
 *      to radsport/). The version of #rs-build `art` (render_static.py hashes the bib's files) busts the cache.
 *   2. #rs-build `art` = { bibId: version } alone -> radsport/img/bibs-art/<id>.json?v=<version>; files resolve next to it
 *   3. ?devfix on a local host: radsport/data/fixtures/art/index.json and <id>.json (never shipped)
 * Accepted spellings: w|width, h|height (else read from the image); photoRect|photo_rect|photo_crop_in_drawing|rect as
 * {x,y,w,h} or [x,y,w,h] in drawing px (fractions <= 1 work too); file|files.art|src|image (default <id>.webp);
 * order|files.order|orderMap|order_map|layers.order_webp; recon|files.recon|reconMask|recon_mask as a mask image
 * (alpha, else brightness, white = completed; a number is the reconstructed share and ignored: the order map's B
 * channel is the mask then); paper|paper_rgb (0..255 or 0..1); aliasOf|alias_of|twinOf (a twin shares that bib's
 * drawing and keeps its own photoRect); digits.
 */

const RS = new URL('../../', import.meta.url);
const ART_DIR = new URL('img/bibs-art/', RS);
const FIX_DIR = new URL('data/fixtures/art/', RS);

const BUILD = (() => {
  try {
    const el = document.getElementById('rs-build');
    return el ? JSON.parse(el.textContent || '{}') : {};
  } catch (_) {
    return {};
  }
})();

function devHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.local');
}
export const devfix = (() => { try { return devHost() && new URLSearchParams(location.search).has('devfix'); } catch (_) { return false; } })();

const warn = (id, what) => { try { console.warn(`[radsport] art ${id}: ${what}`); } catch (_) { /* no console */ } };
const own = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const later = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => { setTimeout(() => r(fallback), ms); })]);
const mm = (q) => { try { return matchMedia(q).matches; } catch (_) { return false; } };

const STR = {
  de: {
    caption: 'Gezeichnet nach dem Wandfoto (2017). Verdecktes ist ergänzt.', toggle: 'Ergänztes zeigen',
    alt: '{n}, als Buntstift- und Aquarellzeichnung mit einem Bildmodell erzeugt; Verdecktes ist ergänzt.',
    twin: 'Vorlage ist die andere Nummer desselben Rennens an der Wand.',
    sketch: ', die {d} nur skizziert', and: ' und die ', unknown: ', die übrigen Ziffern unbekannt',
  },
  en: {
    caption: 'Drawn from the wall photo (2017). Hidden parts are completed.', toggle: 'Show completed parts',
    alt: '{n}, generated as a coloured-pencil and watercolour drawing with an image model; hidden parts are completed.',
    twin: 'Drawn after the other number from the same race on the wall.',
    sketch: ', the {d} only sketched', and: ' and the ', unknown: ', the other digits unknown',
  },
};

let fixIndex = null;
function fixtures() {
  if (!devfix) return Promise.resolve({});
  if (!fixIndex) fixIndex = fetch(new URL('index.json', FIX_DIR).href).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return fixIndex;
}

const withV = (url, v) => (v ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}` : url);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : v && typeof v === 'object' && typeof (v.file || v.src) === 'string' ? (v.file || v.src) : null);

function rectOf(r, W, H) {
  if (!r) return null;
  const a = Array.isArray(r) ? { x: r[0], y: r[1], w: r[2], h: r[3] } : { x: r.x ?? r.left, y: r.y ?? r.top, w: r.w ?? r.width, h: r.h ?? r.height };
  const q = { x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h) };
  if ([q.x, q.y, q.w, q.h].some((v) => v == null) || q.w <= 0 || q.h <= 0) return null;
  if (q.w <= 1.5 && q.h <= 1.5 && W > 4 && H > 4) return { x: q.x * W, y: q.y * H, w: q.w * W, h: q.h * H };   // fractions
  return q;
}

function paperOf(p) {
  if (!Array.isArray(p) || p.length < 3) return [0.97, 0.96, 0.94];
  const v = p.slice(0, 3).map((x) => num(x) ?? 0);
  return v.some((x) => x > 1.001) ? v.map((x) => Math.max(0, Math.min(1, x / 255))) : v;
}

/** One per-bib record in any of the accepted spellings -> Art (without alias resolution). */
function normalize(id, j, base, v, defFile = `${id}.webp`) {
  const size = j.size && typeof j.size === 'object' ? j.size : j.webp && typeof j.webp === 'object' ? j.webp : {};
  const w = num(j.w ?? j.width ?? (Array.isArray(j.size) ? j.size[0] : size.w ?? size.width));
  const h = num(j.h ?? j.height ?? (Array.isArray(j.size) ? j.size[1] : size.h ?? size.height));
  const files = j.files && typeof j.files === 'object' ? j.files : {};
  const layers = j.layers && typeof j.layers === 'object' ? j.layers : {};
  const file = str(j.file) || str(files.art) || str(j.src) || str(j.image) || (typeof j.webp === 'string' ? j.webp : null) || defFile;
  const order = str(j.order) || str(files.order) || str(j.orderMap) || str(j.order_map) || str(layers.order_webp) || str(layers.order);
  const recon = str(j.recon) || str(files.recon) || str(j.reconMask) || str(j.recon_mask) || str(layers.recon);
  const url = (f) => (f && /\.(webp|png|avif|jpe?g)(\?|$)/i.test(f) ? withV(new URL(f, base).href, v) : null);
  const rect = rectOf(j.photoRect || j.photo_rect || j.photoRectPx || j.photo_crop_in_drawing || j.rect, w, h);
  return {
    id, src: url(file), w, h, rect, registered: Boolean(rect), order: url(order), recon: url(recon),
    paper: paperOf(j.paper || j.paper_rgb || j.paperRGB), alias: str(j.aliasOf) || str(j.alias_of) || str(j.twinOf) || null,
    digits: j.digits ?? null,
  };
}

async function resolveArt(id, bib, depth, getBib) {
  const map = BUILD.art && typeof BUILD.art === 'object' ? BUILD.art : null;
  const v = own(map, id) ? map[id] : null;
  let a = null;
  if (bib && bib.art && typeof bib.art === 'object') {
    a = normalize(id, bib.art, RS, v, `img/bibs-art/${id}.webp`);
  } else {
    let url = null;
    if (v) url = new URL(`${id}.json`, ART_DIR);
    else if (own(await fixtures(), id)) url = new URL(`${id}.json`, FIX_DIR);
    if (!url) return null;
    const res = await fetch(withV(url.href, v), { credentials: 'same-origin' });
    if (!res.ok) { warn(id, `${res.status} for its JSON`); return null; }
    a = normalize(id, await res.json(), url, v);
  }
  if (a.alias && a.alias !== id) {
    if (depth > 1) return null;
    const twin = await resolveArt(a.alias, getBib ? getBib(a.alias) : null, depth + 1, getBib);
    if (!twin) { warn(id, `aliasOf ${a.alias} has no drawing`); return null; }
    // a twin is a different sheet: the host's mask of completed parts is not its own. Without a mask of its own the
    // whole drawing counts as completed (integration round 2: before, the host's mask was hatched)
    return { ...twin, id, alias: a.alias, rect: a.rect || null, registered: Boolean(a.rect), digits: a.digits ?? twin.digits, recon: a.recon || null, full: !a.recon };
  }
  if (!a.src) { warn(id, 'no drawing file'); return null; }
  if (!(a.w > 0 && a.h > 0)) {
    const im = await loadImg(a.src);
    a.w = im.naturalWidth;
    a.h = im.naturalHeight;
  }
  return a;
}

const cache = new Map();
const known = new Map();

/** Metadata of the bib's drawing, or null. `getBib` resolves twins (aliasOf) whose bib carries inline art. */
export function artInfo(bib, getBib = null) {
  const id = bib && (typeof bib === 'string' ? bib : bib.id);
  if (!id) return Promise.resolve(null);
  if (!cache.has(id)) {
    const p = resolveArt(id, typeof bib === 'object' ? bib : null, 0, getBib)
      .catch((e) => { warn(id, e && e.message ? e.message : 'failed'); return null; })
      .then((a) => { known.set(id, a); return a; });
    cache.set(id, p);
  }
  return cache.get(id);
}

export function artKnown(id) {
  return known.has(id) ? known.get(id) : undefined;
}

// the last few images only (the shown drawing, its maps, the neighbours); an evicted one comes back from the HTTP cache
const imgs = new Map();
export function loadImg(url) {
  let p = imgs.get(url);
  if (p) imgs.delete(url);
  else {
    p = new Promise((resolve, reject) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => { im.onload = im.onerror = null; resolve(im); };
      im.onerror = () => { im.onload = im.onerror = null; reject(new Error(`image ${url}`)); };
      im.src = url;
    }).then((im) => (typeof im.decode === 'function' ? im.decode().then(() => im, () => im) : im));
    p.catch(() => { if (imgs.get(url) === p) imgs.delete(url); });
  }
  imgs.set(url, p);
  while (imgs.size > 6) imgs.delete(imgs.keys().next().value);
  return p;
}

// the reveal's textures, decoded off the main thread as stored (no premultiply, no colour conversion): the upload needs
// no second decode (a long frame at the landing on phones). Only the bib being opened; closed after its reveal.
const bitmaps = new Map();
function bitmap(url) {
  if (!url) return Promise.resolve(null);
  if (typeof createImageBitmap !== 'function') return loadImg(url).catch(() => null);
  if (!bitmaps.has(url)) {
    bitmaps.set(url, fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
      .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .catch(() => loadImg(url).catch(() => null)));
  }
  return bitmaps.get(url);
}
function freeBitmaps() {
  for (const p of bitmaps.values()) p.then((b) => { if (b && typeof b.close === 'function') b.close(); });
  bitmaps.clear();
}

/** Drawing plus the maps (each map may fail on its own: the reveal then synthesises the order). */
export function artImages(art, { maps = true } = {}) {
  return Promise.all([
    loadImg(art.src),
    maps && art.order ? loadImg(art.order).catch(() => null) : null,
    maps && art.recon ? loadImg(art.recon).catch(() => null) : null,
  ]).then(([draw, order, recon]) => ({ draw, order, recon }));
}

const imgReady = (img, ms) => {
  if (!img || (img.complete && !img.naturalWidth && img.getAttribute('src'))) return Promise.resolve(false);   // missing or broken
  if (img.complete && img.naturalWidth) return typeof img.decode === 'function' ? later(img.decode().then(() => true, () => true), ms, true) : Promise.resolve(true);
  return later(new Promise((r) => { img.addEventListener('load', () => r(true), { once: true }); img.addEventListener('error', () => r(false), { once: true }); }), ms, false);
};

// „Ergänztes zeigen“ lives in art/hatch.js, loaded at the first use of the toggle
let hatchMod = null;
const loadHatch = () => hatchMod || (hatchMod = import('./hatch.js').catch(() => { hatchMod = null; return null; }));

const REVEAL_MS = 2400;
const easeReveal = (x) => Math.sin((x * Math.PI) / 2);   // starts at once after the landing, the wash settles slowly
const easeOut = (x) => 1 - (1 - x) ** 2;

/**
 * The dossier's exhibit card: card states data-art = photo (the crop the flight carried, at photoRect) | reveal
 * (WebGL canvas) | drawn. dossier.js keeps the lifecycle; this owns the card.
 *   opts: { dialog, el ({ card, excap }), i18n, data, store, reduced(), tl() (the dossier's timeline, for ffwd),
 *           cur() (the shown { raceId, bibId, bib }), nbOf(id) ({ prev, next }), loadReveal() (-> reveal.js module) }
 *   exhibit(race, bib, ctx) -> ex | null   the drawing's exhibit, or null (the dossier renders the photo crop)
 *   show(ex, bib, start)    build the card, or keep it when the same drawing is there (a reveal may run); start:
 *                           'photo' (a reveal follows) | 'drawn'
 *   slot()                  where the flight lands and starts back: the photo crop in the drawing, else the card
 *   prime(bib)              opening, or the touch card of a tapped number: fetch reveal.js and decode the reveal's
 *                           images off the main thread now (the flight takes 1.2 s); the crossfade: the drawing only
 *   begin(line)             landed or entered: the reveal (about 2.4 s), or a 200 ms crossfade (reduced motion, DOM
 *                           tier chosen by the visitor or the device, no WebGL); a lost context: the drawing at once
 *   ready(ms)               the shown drawing decoded (prev/next turn the card back with it on)
 *   ahead(dir)              after prev/next: the drawing of the next number in that direction
 *   revert() -> ms          closing: back to the photo crop (<= 250 ms) before the fly-back
 *   settle(), reset(), toggle(button)
 */
export function createExhibit(o) {
  const { i18n } = o;
  const card = o.el.card;
  const excap = o.el.excap;
  const lang = () => (i18n && typeof i18n.lang === 'function' && i18n.lang() === 'en' ? 'en' : 'de');
  const s = (k, v) => (STR[lang()][k] || '').replace(/\{(\w+)\}/g, (m, x) => (v && v[x] != null ? String(v[x]) : m));
  let seq = 0;              // bumps whenever the card is rebuilt or a reveal is cut short
  let reveal = null;        // { ctl, canvas } while the WebGL reveal runs
  let anims = [];           // running crossfades (WAAPI)
  let recon = false;        // „Ergänztes zeigen“, kept while the page lives
  let lock = null;          // { bibId, kind }: a shown bib keeps its exhibit kind (a late drawing never swaps in)
  const artOf = () => { const c = o.cur(); return c && c.bib ? artKnown(c.bib.id) : null; };
  // The reveal has a short-lived WebGL context of its own. A DOM tier chosen by the visitor or the device (?nogl,
  // Save-Data, a calmer display) keeps it off; one the wall fell back to at run time (lost context, slow frames, the
  // session cap) does not: without WebGL createReveal returns null and the crossfade follows.
  const glOk = () => {
    if (mm('(forced-colors: active)')) return false;
    const st = o.store && o.store.get ? o.store.get() : null;
    if (!(st && st.tier === 'dom')) return true;
    let q = null;
    try { q = new URLSearchParams(location.search); } catch (_) { /* no URL */ }
    return !((q && (q.has('nogl') || q.get('tier') === 'dom')) || (navigator.connection && navigator.connection.saveData)
      || mm('(prefers-reduced-transparency: reduce)') || mm('(prefers-contrast: more)'));
  };

  function exhibit(race, bib, ctx) {
    const art = bib && !(lock && lock.bibId === bib.id && lock.kind !== 'art') ? artKnown(bib.id) : null;
    if (!art || !art.src || !(art.w > 0 && art.h > 0)) return null;
    const W = art.w; const H = art.h;
    const crop = bib.crop && bib.crop.file ? ctx.assetURL(bib.crop.file) : null;
    let r = art.rect;
    if (!r && crop && bib.crop.w && bib.crop.h) {
      // a twin without its own photoRect: the crop fitted into the middle (the hand-over is then a crossfade)
      const k = Math.min(W / bib.crop.w, H / bib.crop.h);
      r = { x: (W - bib.crop.w * k) / 2, y: (H - bib.crop.h * k) / 2, w: bib.crop.w * k, h: bib.crop.h * k };
    }
    const pc = (v, d) => `${((v / d) * 100).toFixed(4)}%`;
    const photo = crop && r
      ? `<span class="rs-d-art__photo" style="--px:${pc(r.x, W)};--py:${pc(r.y, H)};--pw:${pc(r.w, W)};--ph:${pc(r.h, H)}"><img src="${esc(crop)}" alt="" decoding="async"></span>`
      : '';
    const alt = s('alt', { n: drawnNumber(bib, art) });
    return {
      kind: 'art', key: `${bib.id}|${art.src}`, ar: W / H, alt, photo: Boolean(photo), toggle: Boolean(art.full || art.recon || art.order),
      html: `<img class="rs-d-art__draw" src="${esc(art.src)}" width="${W}" height="${H}" alt="${esc(alt)}" decoding="async">${photo}`
        + '<canvas class="rs-d-art__hatch" aria-hidden="true" hidden></canvas>',
      caption: s('caption') + (art.alias ? ` ${s('twin')}` : ''),   // D24: no word on how hidden the number is
    };
  }

  /** The number as the drawing shows it (D15, integration round 2): the alt text described the wall photo before
   *  („Startnummer 1…, teilweise verdeckt“ under a drawn, complete 162). Sketched digits are named, unknown ones left open. */
  function drawnNumber(bib, art) {
    const full = String((bib && bib.numberFull) || '');
    const st = Array.isArray(bib && bib.digitStates) && bib.digitStates.length ? bib.digitStates
      : Array.isArray(art.digits) ? art.digits.map((d) => (d && typeof d === 'object' ? d.state : d)) : [];
    if (!full || st.length !== full.length) return i18n.numberPhrase(bib);
    const k = st.findIndex((x, i) => x === 'unknown' || full[i] === '?');
    if (k === 0) return i18n.numberPhrase(bib);
    const known = k < 0 ? full : full.slice(0, k);
    const sk = known.split('').filter((c, i) => st[i] === 'sketch');
    return i18n.t('bib.number', { n: k < 0 ? full : `${known}…` })
      + (sk.length ? s('sketch', { d: sk.join(s('and')) }) : '') + (k > 0 ? s('unknown') : '');
  }

  function show(ex, bib, start) {
    const key = `${ex.kind}|${ex.key || (bib && bib.id) || ''}`;
    o.dialog.dataset.exhibit = ex.kind;
    if (ex.kind === 'art' && card.dataset.exKey === key) {
      const im = card.querySelector('.rs-d-art__draw');
      if (im && ex.alt) im.alt = ex.alt;
    } else {
      stop(false);
      card.dataset.kind = ex.kind;
      card.dataset.exKey = key;
      card.style.setProperty('--ar', String(ex.ar));
      card.innerHTML = ex.html;
      if (ex.kind === 'art') card.dataset.art = ex.photo ? start : 'drawn';
      else delete card.dataset.art;
    }
    lock = bib ? { bibId: bib.id, kind: ex.kind } : null;
    if (ex.kind !== 'art') { excap.textContent = ex.caption; return; }
    excap.innerHTML = `<span class="rs-d-excap__t">${esc(ex.caption)}</span>`
      + (ex.toggle ? `<button type="button" class="rs-d-excap__tg" data-d-recon aria-pressed="${recon}"><span class="rs-d-excap__sw" aria-hidden="true"></span>${esc(s('toggle'))}</button>` : '');
    if (ex.toggle && recon) hatch(true);
  }

  const art = () => card.dataset.kind === 'art';
  const slot = () => (art() ? card.querySelector('.rs-d-art__photo') : card);

  function dropReveal() {
    const r = reveal;
    reveal = null;
    if (!r) return;
    try { r.ctl.destroy(); } catch (_) { /* gone */ }
    r.canvas.remove();
  }
  /** Cancel everything running on the card (it is rebuilt or closed); `finish` lets crossfades end instead. */
  function stop(finish) {
    seq += 1;
    dropReveal();
    for (const a of anims) { try { if (finish) a.finish(); else a.cancel(); } catch (_) { /* idle */ } }
    anims = [];
  }
  function fade(to, ms = 200) {
    const ph = card.querySelector('.rs-d-art__photo');
    const dr = card.querySelector('.rs-d-art__draw');
    const was = card.dataset.art;
    card.dataset.art = to;
    if (!ph || !dr || was === to || document.hidden || !ms) return Promise.resolve();
    const opt = { duration: ms, easing: 'linear' };
    const list = to === 'drawn'
      ? [dr.animate([{ opacity: 0 }, { opacity: 1 }], opt), ph.animate([{ opacity: 1 }, { opacity: 0 }], opt)]
      : [dr.animate([{ opacity: 1 }, { opacity: 0 }], opt), ph.animate([{ opacity: 0 }, { opacity: 1 }], opt)];
    anims.push(...list);
    const tl = o.tl && o.tl();
    if (tl) for (const a of list) tl.add(a);
    return Promise.all(list.map((a) => a.finished.catch(() => null)));
  }

  let primed = null;
  /** Opening, or a tapped number's card: fetch what the landing needs now (the flight takes 1.2 s). */
  function prime(bib) {
    const a = bib && artKnown(bib.id);
    if (!a) return;
    if (!glOk() || o.reduced() || !a.registered) { loadImg(a.src).catch(() => null); return; }   // the crossfade: the drawing only
    o.loadReveal();
    if (primed !== bib.id) { freeBitmaps(); primed = bib.id; }
    const crop = bib.crop && bib.crop.file && o.data && o.data.assetURL ? new URL(o.data.assetURL(bib.crop.file), document.baseURI).href : null;
    for (const u of [a.src, a.order, crop]) bitmap(u);
  }

  async function begin(line) {
    if (!art() || card.dataset.art !== 'photo' || !o.cur()) return;
    const my = ++seq;
    if (document.hidden || (line && line.fast)) { card.dataset.art = 'drawn'; return; }
    const dr = card.querySelector('.rs-d-art__draw');
    const phImg = card.querySelector('.rs-d-art__photo img');
    const a = artOf();
    if (!o.reduced() && a && a.registered && phImg && glOk()) {
      const tex = Promise.all([bitmap(a.src), a.order ? bitmap(a.order) : null, bitmap(phImg.currentSrc || phImg.src)]);
      const [mod, t, okPh] = await Promise.all([later(o.loadReveal(), 2500, null), later(tex, 3000, null), imgReady(phImg, 1500)]);
      if (my !== seq || !o.cur()) return;
      let ctl = null;
      const canvas = mod && mod.createReveal && t && t[0] && t[2] && okPh ? document.createElement('canvas') : null;
      if (canvas) {
        canvas.className = 'rs-d-art__gl';
        canvas.setAttribute('aria-hidden', 'true');
        try { ctl = mod.createReveal(canvas, { photo: t[2], draw: t[0], order: t[1], rect: a.rect, paper: a.paper }); } catch (e) { warn(a.id, e && e.message); }
      }
      if (ctl) {
        const pc = (v) => `${(v * 100).toFixed(4)}%`;
        canvas.style.setProperty('--gx', pc(ctl.box.fx));
        canvas.style.setProperty('--gy', pc(ctl.box.fy));
        canvas.style.setProperty('--gw', pc(ctl.box.fw));
        canvas.style.setProperty('--gh', pc(ctl.box.fh));
        card.insertBefore(canvas, card.querySelector('.rs-d-art__hatch'));
        canvas.rsReveal = ctl;          // QA handle (like window.__rs): seek(t) freezes a frame
        const mine = { ctl, canvas };
        reveal = mine;
        card.dataset.art = 'reveal';
        const done = await ctl.play({ to: 1, ms: REVEAL_MS, ease: easeReveal });
        if (my !== seq || reveal !== mine) return;
        if (ctl.lost) {
          // the GPU dropped the context (a reset, memory pressure): the drawing now, never an empty exhibit
          dropReveal();
          freeBitmaps();
          card.dataset.art = 'drawn';
          if (dr) anims.push(dr.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' }));
          return;
        }
        if (!done) return;
        await imgReady(dr, 800);
        if (my !== seq || reveal !== mine) return;
        card.dataset.art = 'drawn';
        dropReveal();
        freeBitmaps();
        primed = null;
        neighbours();
        return;
      }
    }
    // reduced motion, DOM tier or no WebGL: a 200 ms crossfade once the drawing is decoded (a broken one: the photo stays)
    const ok = await imgReady(dr, 3000);
    if (!ok) warn(a ? a.id : '?', 'drawing did not load, the photo crop stays');
    if (!ok || my !== seq || !o.cur() || card.dataset.art !== 'photo') return;
    await fade('drawn', 200);
    neighbours();
  }

  function revert() {
    if (!art() || !card.querySelector('.rs-d-art__photo')) return 0;
    const st = card.dataset.art;
    if (st === 'photo') return 0;
    seq += 1;
    for (const a of anims) { try { a.cancel(); } catch (_) { /* idle */ } }
    anims = [];
    const r = reveal;
    if (st === 'reveal' && r && !r.ctl.lost) {
      const ms = Math.max(90, Math.min(250, Math.round(250 * r.ctl.t)));
      r.ctl.play({ to: 0, ms, ease: easeOut }).then(() => { if (reveal === r) { card.dataset.art = 'photo'; dropReveal(); } });
      return ms;
    }
    dropReveal();
    card.dataset.art = 'drawn';
    fade('photo', 200);
    return 200;
  }

  function settle() {
    if (!art()) return;
    for (const a of anims) { try { a.finish(); } catch (_) { /* idle */ } }
    anims = [];
    if (reveal) { seq += 1; card.dataset.art = 'drawn'; dropReveal(); }
  }

  function reset() {
    stop(false);
    lock = null;
    delete card.dataset.exKey;
    freeBitmaps();
    primed = null;
  }

  // shown only once the drawing is on (dossier.css: the card's data-art is "drawn"), so it never lies over the landing
  // photo crop or a running reveal
  async function hatch(on) {
    const cv = card.querySelector('.rs-d-art__hatch');
    if (!cv) return;
    if (!on) { cv.hidden = true; return; }
    const a = artOf();
    if (!a) return;
    const key = card.dataset.exKey;
    const alive = () => recon && card.dataset.exKey === key && cv.isConnected;
    const [m, im] = await Promise.all([later(loadHatch(), 4000, null), later(artImages(a), 4000, null)]);
    if (!m || !im || !alive()) return;
    if (await m.paintHatch(cv, key, { ...im, full: Boolean(a.full) }, card.offsetWidth, card.offsetHeight, alive)) cv.hidden = false;
  }
  // the hatch is drawn in CSS px: redraw it when the card changes size
  if (typeof ResizeObserver === 'function') {
    let rw = 0;
    let rq = 0;
    new ResizeObserver(() => {
      const w = card.offsetWidth;
      if (!recon || !w || w === rw) return;
      rw = w;
      cancelAnimationFrame(rq);
      rq = requestAnimationFrame(() => hatch(true));
    }).observe(card);
  }

  /**
   * The neighbours' drawings, so the card turn of prev/next shows them at once. After a reveal: both, but only with a
   * fine pointer on a fast connection (phone visitors mostly go back to the wall; about 300 KB per reveal); `only`
   * ('prev' | 'next', after a switch): the next one in the direction of travel. Never with Save-Data or on 2g/3g.
   */
  function neighbours(only) {
    const c = o.cur();
    const cn = navigator.connection;
    if (!c || (cn && (cn.saveData || /2g|3g/.test(cn.effectiveType || ''))) || (!only && !mm('(pointer: fine)'))) return;
    const nb = o.nbOf(c.raceId || c.bibId) || {};
    for (const tg of only ? [nb[only]] : [nb.prev, nb.next]) {
      const b = tg && tg.bibId ? o.data.getBib(tg.bibId) : null;
      if (b) artInfo(b, o.data.getBib).then((x) => { if (x) loadImg(x.src).catch(() => null); });
    }
  }

  return {
    exhibit, show, slot, prime, begin, revert, settle, reset,
    ahead: (dir) => neighbours(dir === 'prev' || dir < 0 ? 'prev' : 'next'),
    ready: (ms) => imgReady(art() ? card.querySelector('.rs-d-art__draw') : null, ms),
    toggle(btn) {
      recon = !recon;
      if (btn) btn.setAttribute('aria-pressed', String(recon));
      hatch(recon);
    },
  };
}

export default { artInfo, artKnown, artImages, loadImg, createExhibit, devfix };
