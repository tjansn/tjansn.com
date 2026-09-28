/* radsport/js/map/locator.js (WP7): locator on self-hosted Natural Earth SVGs (FINAL_SPEC 1.5, 3.10; D11).
 * It projects lat/lon itself with the SVG's data-lon0/lat0/kx/ky (x = (lon-lon0)*kx, y = (lat0-lat)*ky);
 * europe.svg, else world.svg. The view is cropped around the race; Aachen shows for reference inside the
 * crop (always included outside Europe). Dots and labels are HTML over the SVG (constant size).
 * createLocator(el, { lat, lon | geo, label, country, countries, precision, stages: [{ n, lat, lon | geo, label }] },
 *   { i18n, home, base }) -> { ready: Promise, relabel(), destroy() }
 * `countries` (ISO codes) highlights and names every country of the race, else `country`. geo.xy is ignored.
 */
import { makeT, esc, RS_BASE, observeRoot } from '../charts/strings.js';

const HOME = { lat: 50.7753, lon: 6.0839 }; // Aachen (city level, public on the site)
const cache = new Map();

function loadSvg(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error('map ' + r.status); return r.text(); })
      .catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

const EU = { w: -12, s: 34, e: 42, n: 64 };
const inEurope = (p) => p.lon >= EU.w + 0.5 && p.lon <= EU.e - 0.5 && p.lat >= EU.s + 0.5 && p.lat <= EU.n - 0.5;

const flat = (p) => (p && p.lat == null && p.geo ? Object.assign({}, p, { lat: p.geo.lat, lon: p.geo.lon, precision: p.precision || p.geo.precision }) : p);

const STAGE_PREFIX = /^\s*(?:\d+\s*[.)]?\s*(?:Etappe|Stage)|(?:Etappe|Stage)\s*\d+[a-z]?|Prolog(?:ue)?)\s*[:,-]?\s*/i;

export function createLocator(el, place, opts = {}) {
  const T = makeT(opts.i18n);
  place = flat(place || {});
  const home = opts.home === false ? null : opts.home || HOME;
  const has = (p) => p && p.lat != null && p.lon != null;
  const ccs = [...new Set((Array.isArray(place.countries) && place.countries.length ? place.countries : [place.country]).filter(Boolean).map(String))];
  const st = (place.stages || []).map(flat).filter(has);
  const pts = st.length ? st : [place].filter(has);
  const fig = document.createElement('figure');
  fig.className = 'rs-loc';
  el.innerHTML = '';
  el.appendChild(fig);
  let proj = null, crop = null, offRoot = () => {}, ro = null;

  if (!pts.length) { fig.remove(); return { ready: Promise.resolve(false), relabel() {}, destroy() {} }; }
  const europe = pts.every(inEurope);
  const url = new URL(`img/map/${europe ? 'europe' : 'world'}.svg`, opts.base || RS_BASE).href;

  const toXY = (p) => [(p.lon - proj.lon0) * proj.kx, (proj.lat0 - p.lat) * proj.ky];

  function computeCrop(vbW, vbH) {
    const xy = pts.map(toXY);
    const hxy = home ? toXY(home) : null;
    let x0 = Math.min(...xy.map((p) => p[0])), x1 = Math.max(...xy.map((p) => p[0]));
    let y0 = Math.min(...xy.map((p) => p[1])), y1 = Math.max(...xy.map((p) => p[1]));
    if (!europe && hxy) { x0 = Math.min(x0, hxy[0]); x1 = Math.max(x1, hxy[0]); y0 = Math.min(y0, hxy[1]); y1 = Math.max(y1, hxy[1]); }
    const aspect = 0.72; // height / width of the view
    const minW = europe ? 16 * proj.kx : 60 * proj.kx; // degrees of longitude
    let w = Math.max(minW, (x1 - x0) * 1.5, ((y1 - y0) * 1.5) / aspect);
    w = Math.min(w, vbW);
    let h = Math.min(vbH, w * aspect);
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let x = Math.max(0, Math.min(vbW - w, cx - w / 2)), y = Math.max(0, Math.min(vbH - h, cy - h / 2));
    return { x, y, w, h };
  }

  function pct(xy) { return [((xy[0] - crop.x) / crop.w) * 100, ((xy[1] - crop.y) / crop.h) * 100]; }

  // stage points within 8 % of the view collapse into one dot (Korea on the world map)
  function marks() {
    const xy = pts.map((p) => pct(toXY(p)));
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    if (pts.length < 2 || (Math.max(...xs) - Math.min(...xs) < 8 && Math.max(...ys) - Math.min(...ys) < 8)) {
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      return { multi: false, list: [{ x: cx, y: cy, label: T.L(place.label) }] };
    }
    // several places: stage numbers next to the dots (names go to the caption and aria-label)
    return { multi: true, list: pts.map((p, k) => ({ x: xy[k][0], y: xy[k][1], label: String(p.n != null ? p.n : k + 1) })) };
  }

  function overlay() {
    const old = fig.querySelector('.rs-loc__pins');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.className = 'rs-loc__pins';
    wrap.setAttribute('aria-hidden', 'true');
    const prec = place.precision || 'town';
    const items = [];
    const M = marks();
    M.list.forEach((m) => {
      const side = m.x > 62 ? ' is-left' : '';
      items.push(`<span class="rs-loc__pin rs-loc__pin--${esc(prec)}${M.multi ? ' is-num' : ''}${side}" style="--x:${m.x.toFixed(2)}%;--y:${m.y.toFixed(2)}%">` +
        `<i></i>${m.label ? `<b>${esc(m.label)}</b>` : ''}</span>`);
    });
    if (home) {
      const [hx, hy] = pct(toXY(home));
      const near = M.list.some((m) => Math.abs(m.x - hx) < 7 && Math.abs(m.y - hy) < 7);
      if (hx >= 0 && hx <= 100 && hy >= 0 && hy <= 100 && !near) {
        const side = hx > 62 ? ' is-left' : '';
        items.push(`<span class="rs-loc__pin rs-loc__pin--home${side}" style="--x:${hx.toFixed(2)}%;--y:${hy.toFixed(2)}%"><i></i><b>${esc(T.t('map.home'))}</b></span>`);
      }
    }
    wrap.innerHTML = items.join('');
    fig.querySelector('.rs-loc__map').appendChild(wrap);
    declutter(wrap);
    fig.dataset.marks = M.multi ? 'stages' : 'one';
  }

  // Hide labels that collide with an earlier (higher priority) label or leave the map.
  function declutter(wrap) {
    wrap.querySelectorAll('b.is-hidden').forEach((b) => b.classList.remove('is-hidden'));
    const box = wrap.getBoundingClientRect();
    if (!box.width) return;
    const kept = [];
    for (const b of wrap.querySelectorAll('b')) {
      const r = b.getBoundingClientRect();
      const out = r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1;
      const hit = kept.some((k) => r.left < k.right + 3 && r.right > k.left - 3 && r.top < k.bottom + 2 && r.bottom > k.top - 2);
      if (out || hit) b.classList.add('is-hidden'); else kept.push(r);
    }
  }

  function captions() {
    const cc = ccs.length ? T.list(ccs.map((c) => T.country(c))) : '';
    const lab = T.L(place.label);
    const prec = place.precision || 'town';
    const map = fig.querySelector('.rs-loc__map');
    const homeShown = !!fig.querySelector('.rs-loc__pin--home');
    map.setAttribute('aria-label', T.t('map.aria', { place: lab, country: cc && cc !== lab ? ', ' + cc : '' }) + (homeShown ? T.t('map.homeRef') : ''));
    const cap = fig.querySelector('figcaption');
    let precTxt = prec === 'town' ? '' : ` · ${T.t('map.prec.' + prec)}`;
    if (fig.dataset.marks === 'stages') {
      // "1 Loenhout, 2 Aarschot"; bare stage names ("1. Etappe") drop, a plain run reads "1 bis 7"
      const items = pts.map((p, k) => {
        const n = p.n != null ? p.n : k + 1;
        const rest = p.label ? String(T.L(p.label)).replace(STAGE_PREFIX, '').trim() : '';
        return { n, rest };
      });
      const run = items.length > 2 && items.every((x, i) => !x.rest && (i === 0 || Number(x.n) === Number(items[i - 1].n) + 1));
      const list = run ? T.t('map.range', { a: items[0].n, b: items[items.length - 1].n }) : items.map((x) => (x.rest ? `${x.n}\u00a0${x.rest}` : String(x.n))).join(', ');
      precTxt += ` · ${T.t('map.stages', { list })}`;
      map.setAttribute('aria-label', map.getAttribute('aria-label') + ' ' + T.t('map.stages', { list }) + '.');
    }
    cap.innerHTML = `<span class="rs-loc__place">${esc(lab)}${cc && cc !== lab ? ', ' + esc(cc) : ''}${esc(precTxt)}</span><span class="rs-loc__credit">${esc(T.t('map.credit'))}</span>`;
  }

  const ready = loadSvg(url).then((txt) => {
    if (!fig.isConnected && !el.isConnected) return false;
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('map parse');
    svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    const vb = (svg.getAttribute('viewBox') || '0 0 1000 1000').split(/[\s,]+/).map(Number);
    proj = { lon0: +svg.dataset.lon0, lat0: +svg.dataset.lat0, kx: +svg.dataset.kx, ky: +svg.dataset.ky };
    crop = computeCrop(vb[2], vb[3]);
    svg.setAttribute('viewBox', `${crop.x.toFixed(1)} ${crop.y.toFixed(1)} ${crop.w.toFixed(1)} ${crop.h.toFixed(1)}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('rs-loc__svg');
    svg.querySelectorAll('path[data-cc]').forEach((p) => { if (ccs.includes(p.getAttribute('data-cc'))) p.classList.add('is-cc'); });
    fig.innerHTML = `<div class="rs-loc__map" role="img" style="--ratio:${(crop.h / crop.w).toFixed(4)}"></div><figcaption class="rs-loc__cap"></figcaption>`;
    fig.querySelector('.rs-loc__map').appendChild(document.importNode(svg, true));
    overlay();
    captions();
    offRoot = observeRoot(() => { overlay(); captions(); }, null);
    if (typeof ResizeObserver === 'function') {
      let w0 = 0;
      ro = new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w && w !== w0) { w0 = w; const pins = fig.querySelector('.rs-loc__pins'); if (pins) declutter(pins); } });
      ro.observe(fig.querySelector('.rs-loc__map'));
    }
    return true;
  }).catch((e) => { console.error(e); fig.innerHTML = ''; return false; });

  return {
    ready,
    relabel() { if (crop) { overlay(); captions(); } },
    destroy() { offRoot(); if (ro) ro.disconnect(); fig.remove(); },
  };
}
