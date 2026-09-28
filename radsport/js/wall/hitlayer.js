/**
 * wall/hitlayer.js (WP4): the wall's real links (spec 1.3, 1.9, 3.5, 7).
 *   createHitLayer(svg, bibs, { stage, i18n, data, bus, store }) -> { setHover(id), away(on), focus(id), setLit(ids),
 *     setVacated(id), relabel(), onHover(fn), onActivate(fn), neighbour(id, dir), order, link(id), current() }
 *   fn({ bibId, via }), via = 'pointer' | 'focus' | 'touch' | 'click' | 'keyboard'; main.js emits wall:*.
 * One SVG <a href> per visible polygon, DOM order = reading order, arrows = spatial neighbours (the opposite arrow
 * comes back), Enter and Space open. Pointer, focus and touch give one hover state. Touch: first tap hovers (card),
 * second tap opens; the empty wall, the card's × (bus 'label:dismiss') or a pan drops it; a "touch" click without
 * a real press here (VoiceOver's double tap) opens at once; after a dossier closes no keyboard label comes back.
 * Halos: pan mode and coarse pointers (wall.css). .rs-hit__dash: the dashes of the two-tone focus ring.
 */
import { geo } from './stage.js';

const NS = 'http://www.w3.org/2000/svg';
const KEYS = { ArrowLeft: ['left', -1, 0], ArrowRight: ['right', 1, 0], ArrowUp: ['up', 0, -1], ArrowDown: ['down', 0, 1] };

export function createHitLayer(svg, bibs, opts = {}) {
  const { stage = null, i18n = null, data = null, bus = null, store = null } = opts;
  const stageEl = svg.closest('.rs-stage') || svg.parentElement;
  const list = [...(bibs || [])].sort((a, b) => (a.readingOrder ?? 999) - (b.readingOrder ?? 999));
  const byId = new Map(list.map((b) => [b.id, b]));
  const links = new Map();
  const hoverFns = new Set();
  const actFns = new Set();
  const offs = [];
  let hovered = null;
  let via = null;
  let overId = null;
  let leaveT = 0;
  let down = { id: null, type: 'mouse', t: -1e9 };
  let input = 'mouse';                               // last input on the page: pointer type or 'keyboard'
  let step = null;                                   // last arrow move, so the opposite arrow comes back
  let arrowing = false;

  const linkOf = (t) => (t && t.closest ? t.closest('a[data-bib]') : null);
  const idOf = (a) => (a && svg.contains(a) ? a.getAttribute('data-bib') : null);
  const isOpen = () => Boolean(store && store.get().open);
  const panMode = () => Boolean(stage && stage.mode === 'pan');
  const raceOf = (id) => (data && typeof data.raceForBib === 'function' ? data.raceForBib(id) : null);

  // ---------------------------------------------------------------- links
  function make(b, halo) {
    const a = document.createElementNS(NS, 'a');
    const r = raceOf(b.id);
    a.setAttribute('href', r ? `#race=${r.id}&bib=${b.id}` : `#bib=${b.id}`);
    a.setAttribute('data-bib', b.id);
    if (halo) {
      a.setAttribute('class', 'rs-halo-link');
      a.setAttribute('data-halo', '');
      a.setAttribute('tabindex', '-1');
      a.setAttribute('aria-hidden', 'true');
    }
    const p = document.createElementNS(NS, 'polygon');
    if (halo) p.setAttribute('class', 'rs-halo');
    p.setAttribute('points', (halo ? b.halo : b.poly).map((q) => `${Math.round(q[0])},${Math.round(q[1])}`).join(' '));
    a.appendChild(p);
    return a;
  }

  /** Two-tone focus ring: the link's polygon draws the dark band, this copy the dashes (wall.css). */
  function dash(a) {
    const p = a.querySelector('polygon');
    if (!p || a.querySelector('.rs-hit__dash')) return;
    const d = document.createElementNS(NS, 'polygon');
    d.setAttribute('class', 'rs-hit__dash');
    d.setAttribute('points', p.getAttribute('points'));
    a.appendChild(d);
  }

  function build() {
    const found = new Map();
    const halos = new Map();
    for (const a of svg.querySelectorAll('a[data-bib]')) (a.hasAttribute('data-halo') ? halos : found).set(a.getAttribute('data-bib'), a);
    const seq = list.map((b) => {
      const a = found.get(b.id) || make(b, false);
      links.set(b.id, a);
      dash(a);
      return a;
    });
    for (const b of list) if (Array.isArray(b.halo) && b.halo.length > 2 && !halos.has(b.id)) halos.set(b.id, make(b, true));
    const now = [...svg.querySelectorAll('a[data-bib]')];
    const want = [...seq, ...halos.values()];
    const extra = now.filter((a) => !want.includes(a));
    if (now.length !== want.length + extra.length || want.some((a, i) => now[i] !== a)) {
      for (const a of want) svg.insertBefore(a, extra[0] || null);   // reading order, then halos on top
    }
  }

  function relabel() {
    if (!i18n || typeof i18n.bibLabel !== 'function') return;
    for (const [id, a] of links) a.setAttribute('aria-label', i18n.bibLabel(byId.get(id), raceOf(id)));
  }

  function mark(attr, ids) {
    const set = new Set((ids || []).filter(Boolean));
    for (const a of svg.querySelectorAll('a[data-bib]')) a.toggleAttribute(attr, set.has(a.getAttribute('data-bib')));
  }

  // ---------------------------------------------------------------- state out
  function emit(id, how) {
    if (id && isOpen()) return;
    const same = id === hovered;
    hovered = id;
    via = id ? how : null;
    const a = id ? links.get(id) : null;
    stageEl.toggleAttribute('data-rs-ring', Boolean(a && how === 'focus' && document.activeElement === a && safeMatch(a, ':focus-visible')));
    if (same) return;
    mark('data-hover', [id]);
    for (const fn of [...hoverFns]) {
      try { fn({ bibId: id, via: how }); } catch (e) { console.warn('[radsport] hit hover:', e); }
    }
  }

  function activate(id, how) {
    if (!id || isOpen()) return;
    for (const fn of [...actFns]) {
      try { fn({ bibId: id, via: how }); } catch (e) { console.warn('[radsport] hit activate:', e); }
    }
  }

  function safeMatch(el, sel) {
    try { return el.matches(sel); } catch (_) { return true; }
  }

  // ---------------------------------------------------------------- spatial neighbours (A's cone search as fallback)
  function neighbour(id, dir) {
    const d = typeof dir === 'string' ? Object.values(KEYS).find((k) => k[0] === dir) : dir;
    const b = byId.get(id);
    if (!b || !d) return null;
    const nb = b.neighbours;
    if (nb && Object.prototype.hasOwnProperty.call(nb, d[0])) return byId.has(nb[d[0]]) ? nb[d[0]] : null;
    const c = geo(b).anchor;
    let best = null;
    let bs = Infinity;
    for (const o of list) {
      if (o === b) continue;
      const p = geo(o).anchor;
      const vx = p[0] - c[0];
      const vy = p[1] - c[1];
      const dist = Math.hypot(vx, vy) || 1;
      const cos = (vx * d[1] + vy * d[2]) / dist;
      if (cos < 0.35) continue;
      const sc = dist * (2 - cos);
      if (sc < bs) { bs = sc; best = o.id; }
    }
    return best;
  }

  function focus(id, { reveal = true } = {}) {
    const a = links.get(id);
    if (!a) return null;
    try { a.focus({ preventScroll: true }); } catch (_) { a.focus(); }
    if (reveal && panMode() && stage.ensureVisible) stage.ensureVisible(id);
    return a;
  }

  // ---------------------------------------------------------------- input
  function settle() {
    if (overId) return;
    const a = document.activeElement;
    const fid = idOf(linkOf(a));
    if (fid && !a.hasAttribute('data-halo') && safeMatch(a, ':focus-visible')) emit(fid, 'focus');
    else if (via !== 'touch') emit(null, 'pointer');
  }

  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); offs.push(() => target.removeEventListener(type, fn, o)); };

  on(stageEl, 'pointerdown', (e) => {
    down = { id: idOf(linkOf(e.target)), type: e.pointerType || 'mouse', t: performance.now() };
  }, { passive: true, capture: true });
  on(document, 'pointerdown', (e) => { input = e.pointerType || 'mouse'; }, { passive: true, capture: true });
  on(document, 'keydown', () => { input = 'keyboard'; }, { passive: true, capture: true });

  // hover needs real movement: Chrome fires pointerover under a resting pointer when the layout changes
  // (for example when the intro card fades), which must not steal the entry sweep
  on(svg, 'pointermove', (e) => {
    const id = idOf(linkOf(e.target));
    if (!id || e.pointerType === 'touch') return;
    clearTimeout(leaveT);
    if (overId === id && hovered === id) return;
    overId = id;
    emit(id, 'pointer');
  }, { passive: true });

  on(svg, 'pointerout', (e) => {
    if (e.pointerType === 'touch' || !idOf(linkOf(e.target))) return;
    if (idOf(linkOf(e.relatedTarget))) return;       // the next pointermove takes it
    overId = null;
    clearTimeout(leaveT);
    leaveT = setTimeout(settle, 90);                  // no flicker across the thin gaps between numbers
  });

  on(svg, 'focusin', (e) => {
    const id = idOf(linkOf(e.target));
    if (!arrowing) step = null;
    if (!id || isOpen()) return;
    if (down.id === id && performance.now() - down.t < 900) return;   // pointer or tap owns this one
    if (input !== 'touch') emit(id, 'focus');        // no keyboard label after a touch visit
    if (panMode() && stage.ensureVisible) stage.ensureVisible(id);
  });

  on(svg, 'focusout', (e) => {
    if (idOf(linkOf(e.relatedTarget))) return;
    stageEl.removeAttribute('data-rs-ring');
    if (via === 'focus' && !overId) emit(null, 'focus');
  });

  on(svg, 'keydown', (e) => {
    const id = idOf(linkOf(e.target));
    if (!id || e.altKey || e.ctrlKey || e.metaKey || (e.shiftKey && e.key === 'Enter')) return;   // native new tab / window
    const d = KEYS[e.key];
    if (d) {
      e.preventDefault();
      const back = step && step.to === id && step.dir[1] === -d[1] && step.dir[2] === -d[2];
      const n = back ? step.from : neighbour(id, d);
      step = n ? { from: id, to: n, dir: d } : null;
      if (n) { arrowing = true; focus(n); arrowing = false; }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const b = e.key === 'Home' ? list[0] : list[list.length - 1];
      if (b) focus(b.id);
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activate(id, 'keyboard');
    }
  });

  on(svg, 'click', (e) => {
    const id = idOf(linkOf(e.target));
    if (!id || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // new tab etc. stay native
    e.preventDefault();
    if (stage && stage.wasDrag && stage.wasDrag()) return;          // a pan, or a tap that stopped a fling
    const pressed = (down.id === id || !down.id) && performance.now() - down.t < 1500;   // a real press (or in a gap)
    const type = e.pointerType || (pressed ? down.type : '');
    if (type === 'touch') {
      // no real touch press here: assistive tech (VoiceOver's double tap), which cannot see the card, so open
      if (!pressed || down.type !== 'touch') { activate(id, 'touch'); return; }
      if (hovered !== id || via !== 'touch') { emit(null, 'touch'); emit(id, 'touch'); return; }
      activate(id, 'touch');
      return;
    }
    activate(id, e.detail === 0 && !type ? 'keyboard' : 'click');
  });

  on(stageEl, 'click', (e) => {                       // a tap on the empty wall drops the touch card
    if (linkOf(e.target) || (e.target.closest && e.target.closest('button, a, .rs-label'))) return;
    if (via === 'touch' && !(stage && stage.wasDrag && stage.wasDrag())) emit(null, 'touch');
  });

  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('dossier:open', () => { clearTimeout(leaveT); overId = null; if (hovered) emit(null, 'dossier'); }));
    offs.push(bus.on('dossier:closed', () => setTimeout(() => {   // focus is back on a bib: hover again (not for touch)
      const id = idOf(linkOf(document.activeElement));
      if (id && !isOpen() && !overId && input !== 'touch') emit(id, 'focus');
    }, 30)));
    offs.push(bus.on('label:dismiss', () => { if (hovered && via === 'touch') emit(null, 'touch'); }));   // the card's ×
  }
  if (stage && typeof stage.on === 'function') {                 // a horizontal pan drops the touch card
    offs.push(stage.on('change', (c) => { if (c && c.input === 'drag' && hovered && via === 'touch') emit(null, 'touch'); }));
  }

  build();
  relabel();

  return {
    setHover(id) { mark('data-hover', [id]); },
    /** Round 3: the pointer is on a framed picture of the room (wall/room.js): no number stays hovered there (a
     *  focused one would keep its label and, in the DOM tier, its framing over the picture); leaving settles again. */
    away(on) {
      clearTimeout(leaveT);
      overId = null;
      if (!on) settle();
      else if (hovered && via !== 'touch') emit(null, 'pointer');
    },
    focus,
    setLit(ids) { mark('data-lit', ids); },
    setVacated(id) { mark('data-vacated', [id]); },
    relabel,
    onHover(fn) { hoverFns.add(fn); return () => hoverFns.delete(fn); },
    onActivate(fn) { actFns.add(fn); return () => actFns.delete(fn); },
    neighbour,
    order: list.map((b) => b.id),
    link: (id) => links.get(id) || null,
    current: () => ({ bibId: hovered, via }),
    destroy() {
      clearTimeout(leaveT);
      for (const off of offs.splice(0)) { try { off(); } catch (_) { /* */ } }
      hoverFns.clear();
      actFns.clear();
      stageEl.removeAttribute('data-rs-ring');
    },
  };
}

export default { createHitLayer };
