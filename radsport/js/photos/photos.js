/* radsport/js/photos/photos.js (WP7): photo prints strip and lightbox (FINAL_SPEC 1.5, 3.10, 4.6, 5.3; D4).
 * createPrints(el, photos, { i18n, review, base }) -> { count, destroy() }
 * openLightbox(photos, index, { i18n, review, base, from, returnFocus }) -> Promise (resolves on close)
 * visiblePhotos(photos, { review }) -> photos that may render
 * Rights (D4): 'own' | 'licensed' with people 'none' | 'tom' | 'others_ok' (and not `ships: false`) render ('licensed':
 * credit on the print too, D21);
 * 'pending', people 'review' or `ships: false` only in local review mode (?review=1) with the badge "nur lokal:
 * Rechte offen"; anything else (unknown, family) never. Files: <file>-<w>.webp, w from `sizes`, `widths` or
 * 480/960/1600 up to `w`. History: the open lightbox owns one entry (same URL, state.rsLb): Back closes only
 * the lightbox, Esc / × / backdrop close it and step back, Forward reopens it while its strip exists.
 */
import { makeT, esc, RS_BASE, observeRoot, prefersReducedMotion } from '../charts/strings.js';

const OK_RIGHTS = new Set(['own', 'licensed']);
const OK_PEOPLE = new Set(['none', 'tom', 'others_ok']);
const WIDTHS = [480, 960, 1600];
const TILT = [-2.2, 1.6, -0.9, 2.1, -1.5, 0.8];

// D4: pending photos only in LOCAL review mode; on the site ?review=1 does nothing (same host test as data.js, art.js)
export function reviewMode() {
  try {
    const h = location.hostname;
    const local = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.local');
    return local && new URLSearchParams(location.search).get('review') === '1';
  } catch (e) { return false; }
}
const okPeople = (p) => OK_PEOPLE.has(p.people || 'none') || p.people === 'review';
function isCleared(p) { return OK_RIGHTS.has(p.rights) && OK_PEOPLE.has(p.people || 'none') && p.ships !== false; }
function isPending(p) { return (p.rights === 'pending' || OK_RIGHTS.has(p.rights)) && okPeople(p) && !isCleared(p); }

export function visiblePhotos(photos, { review } = {}) {
  const rv = review == null ? reviewMode() : !!review;
  return (photos || []).filter((p) => p && p.file && (isCleared(p) || (rv && isPending(p))));
}

function widthsOf(p) { const w = p.sizes || p.widths || WIDTHS.filter((x) => !p.w || x <= p.w); return w.length ? w : [WIDTHS[0]]; }
function src(p, w, base) { return new URL(`${p.file}-${w}.webp`, base || RS_BASE).href; }
function srcset(p, base, max) { return widthsOf(p).filter((w) => !max || w <= max).map((w) => `${src(p, w, base)} ${w}w`).join(', '); }
// "Sulzbach-Rosenberg, 19.08.2011": the date wraps as a whole
function capHTML(s) {
  const m = /^(.*),\s+([^,]*\d[^,]*)$/.exec(s);
  return m ? `${esc(m[1])}, <span class="rs-print__date">${esc(m[2])}</span>` : esc(s);
}

export function createPrints(el, photos, opts = {}) {
  const T = makeT(opts.i18n);
  const review = opts.review == null ? reviewMode() : !!opts.review;
  const list = visiblePhotos(photos, { review });
  const reduced = prefersReducedMotion();
  const wrap = document.createElement('div');
  wrap.className = 'rs-prints';
  el.innerHTML = '';
  el.appendChild(wrap);
  if (!list.length) return { destroy() { wrap.remove(); }, count: 0 };

  function render() {
    wrap.setAttribute('role', 'list');
    wrap.setAttribute('aria-label', T.t('ph.strip'));
    wrap.innerHTML = list.map((p, i) => {
      const pend = !isCleared(p);
      const w0 = widthsOf(p)[0];
      const ratio = p.w && p.h ? p.h / p.w : 0.667;
      const cap = T.L(p.caption);
      const lic = !pend && p.rights === 'licensed';
      const badge = pend ? T.t('ph.pending') : '', credit = pend || lic ? T.t('ph.credit', { c: T.L(p.credit) || '?' }) : '';
      // the name starts with the visible text (WCAG 2.5.3)
      const name = [cap, badge, credit].filter(Boolean).map((s) => s.replace(/[.\s]+$/, '') + '. ').join('') + T.t('ph.open', { alt: T.L(p.alt) });
      return `<div class="rs-print-wrap" role="listitem"><button type="button" class="rs-print${pend ? ' is-pending' : ''}${lic ? ' is-licensed' : ''}" data-i="${i}" style="--tilt:${reduced ? 0 : TILT[i % TILT.length]}deg;--ratio:${ratio.toFixed(4)}" aria-label="${esc(name)}">` +
        // prints take the 480 w file only (spec 8.1: <= 40 KB); a DPR 3 phone picked the 960 w one (75 KB on average)
        `<span class="rs-print__img"><img src="${esc(src(p, w0, opts.base))}" srcset="${esc(srcset(p, opts.base, 480))}" sizes="(max-width: 759px) 46vw, 220px" alt="" loading="lazy" decoding="async"` +
        `${p.w && p.h ? ` width="${Math.round(w0)}" height="${Math.round(w0 * ratio)}"` : ''}></span>` +
        `<span class="rs-print__cap">${capHTML(cap)}</span>` +
        (pend ? `<span class="rs-print__badge">${esc(badge)}</span>` : '') +
        (credit ? `<span class="rs-print__credit">${esc(credit).replace(/\//g, '/<wbr>')}</span>` : '') +
        `</button></div>`;
    }).join('');
  }
  function onClick(e) {
    const b = e.target.closest('.rs-print');
    if (!b) return;
    const i = +b.dataset.i;
    // looked up at close time: a language switch re-renders the buttons
    openLightbox(list, i, Object.assign({}, opts, { review, from: b.querySelector('img'), returnFocus: () => wrap.querySelector(`.rs-print[data-i="${i}"]`), _filtered: true, _owner: wrap }));
  }
  render();
  wrap.addEventListener('click', onClick);
  const offRoot = observeRoot(() => render(), null);
  return {
    count: list.length,
    destroy() {
      offRoot(); wrap.removeEventListener('click', onClick);
      if (LB && LB.owner === wrap) LB.close(true);   // never outlives its strip
      wrap.remove();
    },
  };
}

// ---- lightbox (one per page)
let LB = null, last = null, seq = 0, listening = false;

const stateOf = () => { try { return history.state && typeof history.state === 'object' ? history.state : null; } catch (e) { return null; } };
// Forward onto the entry of a lightbox that Back closed: reopen it on the same photo
function onHistory() {
  const st = stateOf();
  if (LB || !last || !st || st.rsLb !== last.token || !(last.opts._owner && last.opts._owner.isConnected)) return;
  openLightbox(last.list, last.i, Object.assign({}, last.opts, { _token: last.token }));
}

function ensureDialog() {
  let dlg = document.querySelector('dialog.rs-lightbox');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.className = 'rs-lightbox'; document.body.appendChild(dlg); }
  if (!dlg.querySelector('.rs-lb')) {
    dlg.innerHTML =
      `<div class="rs-lb"><figure class="rs-lb__fig"><div class="rs-lb__stage"><img class="rs-lb__img" alt="" decoding="async"></div>` +
      `<figcaption class="rs-lb__cap" id="rs-lb-cap"><span class="rs-lb__text"></span><span class="rs-lb__meta"><span class="rs-lb__credit"></span>` +
      `<span class="rs-lb__badge" hidden></span><span class="rs-lb__count"></span></span></figcaption></figure>` +
      `<button type="button" class="rs-lb__btn rs-lb__prev"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg></button>` +
      `<button type="button" class="rs-lb__btn rs-lb__next"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5"/></svg></button>` +
      `<button type="button" class="rs-lb__btn rs-lb__close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button>` +
      `<p class="rs-lb__hint rs-sr" id="rs-lb-hint"></p><p class="rs-lb__live rs-sr" aria-live="polite"></p></div>`;
  }
  dlg.setAttribute('aria-labelledby', 'rs-lb-cap');
  return dlg;
}

export function openLightbox(photos, index = 0, opts = {}) {
  const review = opts.review == null ? reviewMode() : !!opts.review;
  const list = opts._filtered ? photos : visiblePhotos(photos, { review });
  if (!list.length) return Promise.resolve();
  if (LB) LB.close(true);
  const T = makeT(opts.i18n);
  const reduced = prefersReducedMotion();
  const dlg = ensureDialog();
  const $ = (s) => dlg.querySelector(s);
  const img = $('.rs-lb__img'), stage = $('.rs-lb__stage'), live = $('.rs-lb__live');
  const prevB = $('.rs-lb__prev'), nextB = $('.rs-lb__next'), closeB = $('.rs-lb__close');
  const rf = opts.returnFocus || document.activeElement;
  const token = opts._token || `lb${++seq}.${Date.now().toString(36)}`;
  let i = Math.max(0, Math.min(list.length - 1, index)), closing = false, resolveClose, pushed = false;
  if (!listening) { listening = true; window.addEventListener('popstate', onHistory); }
  last = { token, list, i, opts };
  if (live) live.textContent = '';

  function labels() {
    prevB.setAttribute('aria-label', T.t('ph.prev'));
    nextB.setAttribute('aria-label', T.t('ph.next'));
    closeB.setAttribute('aria-label', T.t('ph.close'));
    $('.rs-lb__hint').textContent = T.t('ph.hint');
    dlg.setAttribute('aria-describedby', 'rs-lb-hint');   // the caption names the dialog
  }
  function show(k, anim, say) {
    i = (k + list.length) % list.length;
    if (last && last.token === token) last.i = i;
    const p = list[i];
    img.src = src(p, widthsOf(p)[Math.min(1, widthsOf(p).length - 1)], opts.base);
    img.srcset = srcset(p, opts.base);
    img.sizes = '(max-width: 759px) 100vw, min(1400px, 88vw)';
    img.alt = T.L(p.alt);
    if (p.w && p.h) { img.width = p.w; img.height = p.h; }
    $('.rs-lb__text').textContent = T.L(p.caption);
    $('.rs-lb__credit').textContent = p.credit ? T.t('ph.credit', { c: T.L(p.credit) }) : '';   // credit: string or { de, en }
    const badge = $('.rs-lb__badge');
    badge.hidden = isCleared(p);
    badge.textContent = T.t('ph.pending');
    const count = list.length > 1 ? T.t('ph.count', { i: i + 1, n: list.length }) : '';
    $('.rs-lb__count').textContent = count;
    prevB.hidden = nextB.hidden = list.length < 2;
    // announce a new photo (focus stays on the button; a dialog's name change is silent)
    if (say && live) live.textContent = T.t('ph.live', { n: count, alt: String(T.L(p.alt)).replace(/[.\s]+$/, ''), cap: T.L(p.caption) }).replace(/^:\s*/, '');
    if (anim && !reduced && img.animate) img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }
  function flipFrom(fromEl) {
    if (reduced || !fromEl || !img.animate) { if (img.animate) img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 1 : 160 }); return; }
    const a = fromEl.getBoundingClientRect(), b = img.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const s = a.width / b.width;
    const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
    img.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.6 }, { transform: 'none', opacity: 1 }],
      { duration: 360, easing: 'cubic-bezier(.16,1,.3,1)' });
    dlg.animate([{ backgroundColor: 'rgba(8,8,8,0)' }, { backgroundColor: 'rgba(8,8,8,1)' }], { duration: 300, easing: 'ease-out' });
  }
  function onKey(e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); show(i + 1, true, true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); show(i - 1, true, true); }
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); show(0, true, true); }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); show(list.length - 1, true, true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') {
      const f = [...dlg.querySelectorAll('button:not([hidden])')];
      if (!f.length) return;
      const first = f[0], lastB = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastB.focus(); }
      else if (!e.shiftKey && document.activeElement === lastB) { e.preventDefault(); first.focus(); }
      e.stopPropagation();
    } else e.stopPropagation();
  }
  function onCancel(e) { e.preventDefault(); close(); }
  function onClickBackdrop(e) { if (e.target === dlg || e.target === $('.rs-lb') || e.target === stage) close(); }
  // Back left our entry: close only the lightbox (the dossier keeps its own entry)
  function onPop() { const st = stateOf(); if (!st || st.rsLb !== token) close(true, true); }
  function pushEntry() {
    if (closing || pushed) return;
    try { history.pushState(Object.assign({}, stateOf() || {}, { rsLb: token }), '', location.href); pushed = true; } catch (e) { return; }
    window.addEventListener('popstate', onPop);
  }
  // swipe
  let sx = null, sy = 0, sid = null;
  function onDown(e) { if (e.button != null && e.button !== 0) return; sx = e.clientX; sy = e.clientY; sid = e.pointerId; }
  function onMove(e) {
    if (sx == null || e.pointerId !== sid) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 6 && !reduced) img.style.setProperty('--swipe', dx * 0.6 + 'px');
  }
  function onUp(e) {
    if (sx == null || e.pointerId !== sid) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    img.style.setProperty('--swipe', '0px');
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2 && list.length > 1) {
      show(i + (dx < 0 ? 1 : -1), true, true);
      e.preventDefault();
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 50);
    }
  }
  let swallowClick = false;
  function onStageClick(e) { if (swallowClick) { e.stopPropagation(); return; } onClickBackdrop(e); }

  function close(instant, fromHistory) {
    if (closing) return;
    closing = true;
    window.removeEventListener('popstate', onPop);
    if (pushed && !fromHistory) { const st = stateOf(); if (st && st.rsLb === token) try { history.back(); } catch (e) { /* ignore */ } }
    const done = () => {
      dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('cancel', onCancel);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      dlg.removeEventListener('click', onStageClick);
      prevB.onclick = nextB.onclick = closeB.onclick = null;
      offRoot();
      if (dlg.open) dlg.close();
      document.documentElement.classList.remove('rs-lb-open');
      if (LB === api) LB = null;
      // back to the print only while it is live; after the dossier closed, it returns focus itself
      const f = typeof rf === 'function' ? rf() : rf;
      const host = f && f.closest && f.closest('dialog');
      if (f && f.focus && f.isConnected && (!host || host.open)) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
      if (resolveClose) resolveClose();
    };
    if (instant || reduced || !dlg.animate) return done();
    const a = dlg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in' });
    const t = setTimeout(done, 400);
    a.finished.then(() => { clearTimeout(t); done(); }, () => { clearTimeout(t); done(); });
  }

  const api = { close, owner: opts._owner || null };
  LB = api;
  labels();
  show(i, false);
  dlg.addEventListener('keydown', onKey);
  dlg.addEventListener('cancel', onCancel);
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  dlg.addEventListener('click', onStageClick);
  prevB.onclick = () => show(i - 1, true, true);
  nextB.onclick = () => show(i + 1, true, true);
  closeB.onclick = () => close();
  const offRoot = observeRoot(() => { labels(); show(i, false); }, null);
  if (opts._token) { pushed = true; window.addEventListener('popstate', onPop); }   // Forward: the entry exists
  else pushEntry();
  if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
  document.documentElement.classList.add('rs-lb-open');
  (list.length > 1 ? nextB : closeB).focus({ preventScroll: true });
  const run = () => flipFrom(opts.from);
  if (img.complete && img.naturalWidth) run();
  else { let ran = false; const go = () => { if (!ran) { ran = true; run(); } }; img.addEventListener('load', go, { once: true }); setTimeout(go, 250); }
  return new Promise((r) => { resolveClose = r; });
}
