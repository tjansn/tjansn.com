/**
 * wall/label.js (WP4): museum label (desktop) and card (touch, phones), spec 1.3 and 7.
 *   createLabel(el, { stage, onOpen(bibId), i18n, data, bus, store }) -> { show(bibId, { via }), hide(), relabel() }
 * Label: beside the bib, never over it, clear of every visible HUD box (measured, so any HUD layout works).
 * Card: bottom or top band, whichever leaves the bib free; compact, then tight, then just below or above the bib
 * when needed. A touch card is a surface: a tap on it opens, × closes (bus 'label:dismiss'). aria-hidden (the links
 * carry the text); a polite live region outside it tells screen-reader touch users that a second tap opens.
 */
import { clamp } from './stage.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DL = ['result', 'date', 'power', 'weather', 'photos'];
const HUD = '.rs-rail, .rs-hud__controls, .rs-season-card--hud';
const GAP = 12;                                      // px between the label and a HUD box

/** Polygon clipped to the rectangle [x0, y0, x1, y1] (Sutherland-Hodgman). */
function clip(pts, [x0, y0, x1, y1]) {
  let p = pts;
  const cut = (k, v, keep) => {
    const out = [];
    p.forEach((a, i) => {
      const b = p[(i + 1) % p.length];
      if (keep(a[k], v)) out.push(a);
      if (keep(a[k], v) !== keep(b[k], v)) { const t = (v - a[k]) / (b[k] - a[k]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    });
    p = out;
  };
  const ge = (a, v) => a >= v;
  const le = (a, v) => a <= v;
  cut(0, x0, ge); cut(0, x1, le); cut(1, y0, ge); cut(1, y1, le);
  return p;
}
function areaIn(pts, r) {
  const p = clip(pts, r);
  let s = 0;
  p.forEach((a, i) => { const b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; });
  return Math.abs(s) / 2;
}

export function createLabel(el, opts = {}) {
  const { stage = null, onOpen = null, i18n, data, bus = null, store = null } = opts;
  const room = el.closest('.rs-room');
  if (room && el.parentElement !== room) room.insertBefore(el, room.querySelector('.rs-hud'));
  el.setAttribute('aria-hidden', 'true');
  const live = room ? room.appendChild(document.createElement('p')) : null;
  if (live) { live.className = 'rs-sr'; live.setAttribute('aria-live', 'polite'); live.setAttribute('data-rs-label-live', ''); }
  const offs = [];
  let cur = null;
  let via = 'pointer';
  let shown = false;
  let raf = 0;
  let sayT = 0;
  let boxes = null;                                  // visible HUD boxes in room px (per show and layout)

  const t = (k, v) => i18n.t(k, v);
  const title = (race) => (race ? i18n.L(race.name) : t('label.unassigned'));

  /** Kicker, race and result, Datenlage, the call to action. Round 3: no match status (D23) and no
   *  description of the printed number (D24). */
  function content(id) {
    const bib = data.getBib(id);
    const race = data.raceForBib(id);
    if (!bib) return '';
    const year = race ? race.year || i18n.fmt.year(race.date) : '';
    const kicker = [i18n.numberShort(bib), race && race.country ? i18n.fmt.country(race.country) : '', year].filter(Boolean);
    const short = race && race.result ? i18n.resultShort(race.result, race) : '';
    const res = short !== t('res.short.started') ? short : '';            // outcomes only ("im Ziel" of a stage race too)
    const comp = (race && race.completeness) || {};
    const touch = via === 'touch';
    return `<div class="rs-label__card">`
      + (touch ? `<button type="button" class="rs-label__close" data-rs-close tabindex="-1" aria-label="${esc(t('d.close'))}">`
        + '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>' : '')
      + `<p class="rs-label__k">${kicker.map(esc).join(' · ')}</p>`
      + `<p class="rs-label__t">${esc(title(race))}${res ? ` <span class="rs-label__res">${esc(res)}</span>` : ''}</p>`
      + `<p class="rs-label__dl"><span>${DL.map((k) => `<i${comp[k] ? ' class="is-on"' : ''}></i>`).join('')}</span>${esc(t('dl.title'))}</p>`
      + (touch
        ? `<p class="rs-label__act"><button type="button" class="rs-label__open" data-rs-open tabindex="-1">${esc(t('label.open'))}</button><span>${esc(t('label.ctaTouch'))}</span></p>`
        : `<p class="rs-label__cta">${esc(t('label.cta'))}</p>`)
      + `</div>`;
  }

  function say(text) {
    if (!live) return;
    live.textContent = '';
    clearTimeout(sayT);
    sayT = setTimeout(() => { live.textContent = text; }, 60);
  }

  // ---------------------------------------------------------------- placement
  function hudBoxes(hr) {
    const seen = (e) => {
      if (e.hidden || !e.getClientRects().length || (!e.childElementCount && !e.textContent.trim())) return false;
      for (let n = e; n && n !== room; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
      }
      return true;
    };
    return (room ? [...room.querySelectorAll(HUD)] : []).filter(seen).map((e) => e.getBoundingClientRect())
      .map((r) => [r.left - hr.left, r.top - hr.top, r.right - hr.left, r.bottom - hr.top]);
  }

  /** Top of a label over [x, x + lw] nearest to yp inside [lo, hi] and clear of the HUD boxes; null: no room. */
  function freeY(x, lw, lh, yp, lo, hi) {
    const cuts = boxes.filter(([l, , r]) => x < r + GAP && x + lw > l - GAP).map(([, a, , b]) => [a - GAP, b + GAP]).sort((a, b) => a[0] - b[0]);
    let best = null;
    let a = lo;
    for (const [g0, g1] of [...cuts, [hi, Infinity]]) {
      const b = Math.min(g0, hi);
      if (b - a >= lh) { const y = clamp(yp, a, b - lh); if (best == null || Math.abs(y - yp) < Math.abs(best - yp)) best = y; }
      a = Math.max(a, g1);
      if (a >= hi) break;
    }
    return best;
  }

  function place() {
    raf = 0;
    const bib = shown && cur && stage ? data.getBib(cur) : null;
    if (!bib) return;
    const host = el.offsetParent || room || el.parentElement;
    const rw = host.clientWidth;
    const rh = host.clientHeight;
    if (!boxes) boxes = hudBoxes(host.getBoundingClientRect());
    const poly = bib.poly.map((p) => stage.toLocal(p[0], p[1]));
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const lw = el.offsetWidth;
    const px = (k, v) => el.style.setProperty(k, `${Math.round(v)}px`);

    if (el.dataset.mode === 'card') {
      // bands: above the HUD boxes under the card, below the room line. Full card, compact (short rooms start
      // here), tight: in a band, else just below or above the bib; else the least covered band
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const cx0 = el.offsetLeft;
      const cx1 = cx0 + lw;
      let bot = 4.4 * rem;
      let top = 2.6 * rem;
      for (const [l, a, r, b] of boxes) if (cx0 < r && cx1 > l) { if (a > rh / 2) bot = Math.max(bot, rh - a + 10); else top = Math.max(top, b + 10); }
      px('--rs-card-b', bot);
      px('--rs-card-t', top);
      const under = clip(poly, [cx0, -1e5, cx1, 1e5]).map((q) => q[1]);   // the bib under the card's width
      const set = (lv) => (lv == null ? el.removeAttribute('data-compact') : el.setAttribute('data-compact', lv));
      let pick = null;
      for (const lv of rh < 640 ? ['', 'tight'] : [null, '', 'tight']) {
        set(lv);
        const h = el.offsetHeight;
        const cb = areaIn(poly, [cx0, rh - bot - h, cx1, rh - bot]);
        const ct = areaIn(poly, [cx0, top, cx1, top + h]);
        if (cb <= 0.5 || ct <= 0.5) { pick = { lv, pos: cb <= 0.5 ? 'bottom' : 'top' }; break; }
        const free = lv == null || !under.length ? [] : [Math.max(...under) + 8, Math.min(...under) - 8 - h].filter((y) => y >= top && y + h <= rh - bot);
        if (free.length) { pick = { lv, pos: 'free', y: Math.max(...free) }; break; }
        if (!pick || Math.min(cb, ct) < pick.c) pick = { lv, pos: ct < cb ? 'top' : 'bottom', c: Math.min(cb, ct) };
      }
      set(pick.lv);
      if (pick.pos === 'free') px('--rs-card-y', pick.y);
      el.dataset.pos = pick.pos;
      return;
    }

    // beside the bib, else below or above it: the first spot clear of the HUD, off the bib and near it wins;
    // no spot at all: clamped, over the HUD (wall.css)
    const lh = el.offsetHeight;
    const g = 18;
    const m = 16;
    const lo = 44;                                   // below the room line
    const hi = rh - 76;                              // above the button row and the caption line
    const sR = rw - m - (x1 + g);
    const sL = x0 - g - m;
    const cands = (sR >= sL ? [[sR, x1 + g], [sL, x0 - g - lw]] : [[sL, x0 - g - lw], [sR, x1 + g]]).filter(([s]) => s >= lw).map(([, x]) => [x, y0 + 6]);
    const cx = clamp((x0 + x1) / 2 - lw / 2, m, Math.max(m, rw - m - lw));
    cands.push(...(hi - (y1 + g) >= y0 - g - lo ? [[cx, y1 + g], [cx, y0 - g - lh]] : [[cx, y0 - g - lh], [cx, y1 + g]]));
    const area = Math.max(1, areaIn(poly, [x0, y0, x1, y1]));
    let best = null;
    for (const [x, yp] of cands) {
      const y = freeY(x, lw, lh, yp, lo, hi);
      if (y == null) continue;
      const off = Math.max(0, x0 - (x + lw), x - x1) + Math.max(0, y0 - (y + lh), y - y1);
      const score = (areaIn(poly, [x, y, x + lw, y + lh]) / area > 0.01 ? 2 : 0) + (off > 48 ? 1 : 0);
      if (!best || score < best.score) best = { x, y, score };
    }
    if (!best) best = { x: cands[0][0], y: clamp(cands[0][1], lo, Math.max(lo, hi - lh)) };
    px('--rs-lx', clamp(best.x, m, Math.max(m, rw - m - lw)));
    px('--rs-ly', best.y);
  }

  function schedule() { if (shown && !raf) raf = requestAnimationFrame(place); }

  function show(id, o = {}) {
    if (!id || (store && store.get().open) || !data.getBib(id)) { hide(); return; }
    const was = shown ? cur : null;
    const told = was === id && via === 'touch';
    cur = id;
    via = o.via || 'pointer';
    el.dataset.mode = via === 'touch' || (stage && stage.mode === 'pan') ? 'card' : 'museum';
    el.dataset.via = via === 'touch' ? 'touch' : via === 'focus' || via === 'keyboard' ? 'focus' : 'pointer';
    if (el.dataset.mode !== 'card') el.removeAttribute('data-compact');
    el.innerHTML = content(id);
    shown = true;
    boxes = null;
    cancelAnimationFrame(raf);
    place();
    el.classList.add('is-on');
    if (via === 'touch' && !told) say(`${i18n.numberShort(data.getBib(id))}, ${title(data.raceForBib(id))}. ${t('label.ctaTouch')}.`);
    if (was && was !== id && el.animate && !(store && store.get().reducedMotion)) {
      el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }

  function hide() {
    shown = false;
    cur = null;
    cancelAnimationFrame(raf);
    raf = 0;
    el.classList.remove('is-on');
    if (live && live.textContent) { clearTimeout(sayT); sayT = setTimeout(() => { if (!shown) live.textContent = ''; }, 1500); }
  }

  function on(target, type, fn, o) { target.addEventListener(type, fn, o); offs.push(() => target.removeEventListener(type, fn, o)); }

  on(el, 'click', (e) => {                           // (touch card) × closes, a tap anywhere else opens
    if (!cur) return;
    e.preventDefault();
    e.stopPropagation();
    const id = cur;
    if (!(e.target.closest && e.target.closest('[data-rs-close]'))) { if (typeof onOpen === 'function') onOpen(id); return; }
    hide();
    if (bus && typeof bus.emit === 'function') bus.emit('label:dismiss', { bibId: id });
  });
  on(el, 'mousedown', (e) => e.preventDefault());   // a tap never focuses into the aria-hidden card

  if (stage && typeof stage.on === 'function') offs.push(stage.on('change', (c) => { if (c && c.reason === 'layout') boxes = null; schedule(); }));
  on(window, 'resize', () => { boxes = null; schedule(); }, { passive: true });
  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('wall:activate', hide));
    offs.push(bus.on('dossier:open', hide));
  }

  return {
    show,
    hide,
    relabel() { if (shown && cur) { el.innerHTML = content(cur); boxes = null; place(); } },
    get current() { return cur; },
    destroy() {
      hide();
      clearTimeout(sayT);
      if (live) live.remove();
      for (const off of offs.splice(0)) { try { off(); } catch (_) { /* */ } }
    },
  };
}

export default { createLabel };
