/**
 * router.js: hash grammar, history, deep links (spec 1.8, 3.2).
 *
 *   parseHash(hash) -> { raceId?, bibId?, stage? } | null
 *   toHash({ raceId, bibId, stage }) -> '#race=<id>&bib=<id>&stage=<n>' | '#bib=<id>' | ''
 *   router.start({ data, bus })   hashchange + popstate -> bus 'dossier:open' / 'dossier:close'
 *   router.open(target, { replace, from, silent })   pushState (or replaceState while open)
 *   router.close()                history.back() if the entry is ours, else replaceState to the bare URL
 *   router.current() -> target | null;  router.resolve(target) -> canonical target | null
 *
 * Grammar: #race=<raceId>[&bib=<bibId>][&stage=<n>] or #bib=<bibId>. An assigned #bib= is
 * canonicalized with replaceState to #race=...&bib=... Unknown ids emit 'route:unknown' and fall
 * back to the wall. Opening pushes one entry; while a dossier is open, open() replaces it
 * (prev/next); Back always closes. A cold deep link puts the bare page underneath its entry, so Back
 * closes there too. A page fragment (#liste, #saisons, ...) under a dossier becomes the bare URL, so
 * closing never pulls the page back to that anchor.
 * Emitted 'dossier:open' payloads: { raceId, bibId, stage, from } with from = 'wall' | 'list' |
 * 'deeplink' (cold load and Back/Forward; the latter also carries via: 'history') or whatever
 * the caller of open() passed.
 */

const ID_RX = /^[a-z0-9][a-z0-9-]{2,119}$/;
const BIB_RX = /^b\d{2,3}$/;
const DEEP_RX = /^#?(race|bib)=/;

export function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (!h || !DEEP_RX.test(h)) return null;
  let p;
  try { p = new URLSearchParams(h); } catch (_) { return null; }
  const out = {};
  const raceId = p.get('race');
  const bibId = p.get('bib');
  const stage = p.get('stage');
  if (raceId != null) {
    if (!ID_RX.test(raceId)) return null;
    out.raceId = raceId;
  }
  if (bibId != null) {
    if (!BIB_RX.test(bibId)) return null;
    out.bibId = bibId;
  }
  if (!out.raceId && !out.bibId) return null;
  if (stage != null && out.raceId) {
    if (!/^\d{1,2}$/.test(stage)) return null;
    out.stage = Number(stage);
  }
  return out;
}

export function toHash(target) {
  if (!target) return '';
  const { raceId, bibId, stage } = target;
  if (raceId) {
    let h = `#race=${raceId}`;
    if (bibId) h += `&bib=${bibId}`;
    if (stage != null && stage !== '') h += `&stage=${stage}`;
    return h;
  }
  return bibId ? `#bib=${bibId}` : '';
}

const keyOf = (t) => (t ? toHash(t) : '');
const bare = () => `${location.pathname}${location.search}`;

let data = null;
let bus = null;
let current = null;
let started = false;

function stateTag() {
  try { return history.state && history.state.rs; } catch (_) { return null; }
}

function setState(tag, url, push) {
  try {
    const st = { ...(history.state && typeof history.state === 'object' ? history.state : {}), rs: tag };
    if (push) history.pushState(st, '', url);
    else history.replaceState(st, '', url);
  } catch (_) { /* sandboxed iframes may refuse */ }
}

/** Canonical target for the known data, or null when an id is unknown. */
function resolve(target) {
  if (!target) return null;
  if (!data) return { ...target };
  const getRace = (id) => (typeof data.getRace === 'function' ? data.getRace(id) : data.races && data.races.get(id));
  const getBib = (id) => (typeof data.getBib === 'function' ? data.getBib(id) : data.bibs && data.bibs.get(id));
  if (target.raceId) {
    const race = getRace(target.raceId);
    if (!race || race.status !== 'raced') return null;
    const out = { raceId: race.id };
    if (target.bibId) {
      const bib = getBib(target.bibId);
      if (bib && bib.raceId === race.id) out.bibId = bib.id;
    }
    if (target.stage != null && Array.isArray(race.stages) && race.stages.some((s) => Number(s.n) === Number(target.stage))) {
      out.stage = Number(target.stage);
    }
    return out;
  }
  if (target.bibId) {
    const bib = getBib(target.bibId);
    if (!bib) return null;
    const race = bib.raceId ? getRace(bib.raceId) : null;
    return race && race.status === 'raced' ? { raceId: race.id, bibId: bib.id } : { bibId: bib.id };
  }
  return null;
}

function emitOpen(target, from, extra) {
  if (bus) bus.emit('dossier:open', { raceId: target.raceId || null, bibId: target.bibId || null, stage: target.stage ?? null, from, ...extra });
}

function onNavigate() {
  const hash = location.hash;
  const parsed = parseHash(hash);
  if (!parsed) {
    if (DEEP_RX.test(hash)) {
      if (bus) bus.emit('route:unknown', { hash });
      setState(null, bare(), false);
    }
    if (current) {
      current = null;
      if (bus) bus.emit('dossier:close', { reason: 'history' });
    }
    return;
  }
  const target = resolve(parsed);
  if (!target) {
    if (bus) bus.emit('route:unknown', { hash });
    if (current) {
      current = null;
      if (bus) bus.emit('dossier:close', { reason: 'history' });
    }
    setState(null, bare(), false);
    return;
  }
  if (keyOf(target) === keyOf(current)) return;          // popstate + hashchange for one navigation
  // A native link click or Forward created this entry inside the page: Back may go back to it.
  const tag = stateTag() || 'nav';
  setState(tag, `${bare()}${toHash(target)}`, false);
  current = target;
  emitOpen(target, 'deeplink', { via: 'history' });
}

export const router = {
  start({ data: d, bus: b } = {}) {
    data = d || data;
    bus = b || bus;
    if (started) return current;
    started = true;
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    const hash = location.hash;
    const parsed = parseHash(hash);
    if (parsed) {
      const target = resolve(parsed);
      if (target) {
        // the bare page goes underneath and the canonical link is pushed on top: Back closes the dossier
        // (spec 1.8), a second Back leaves the page, Forward reopens it
        setState(null, bare(), false);
        setState('push', `${bare()}${toHash(target)}`, true);
        current = target;
        emitOpen(target, 'deeplink');
      } else {
        setState(null, bare(), false);
        if (bus) bus.emit('route:unknown', { hash });
      }
    } else if (DEEP_RX.test(hash)) {
      setState(null, bare(), false);
      if (bus) bus.emit('route:unknown', { hash });
    }
    return current;
  },

  open(target, { replace = false, from = 'wall', silent = false } = {}) {
    const t = resolve(target);
    if (!t) {
      if (bus) bus.emit('route:unknown', { hash: toHash(target) });
      return null;
    }
    const url = `${bare()}${toHash(t)}`;
    if (keyOf(t) !== keyOf(current) || location.hash !== toHash(t)) {
      if (replace || current) setState(stateTag() || 'push', url, false);
      else {
        // #liste and the other page anchors: returning to such an entry scrolls to its anchor, so the entry
        // under the dossier becomes the bare URL (the browser then restores where the visitor was)
        if (location.hash && !DEEP_RX.test(location.hash)) setState(stateTag(), bare(), false);
        setState('push', url, true);
      }
    }
    current = t;
    if (!silent) emitOpen(t, from);
    return t;
  },

  close() {
    const had = current || parseHash(location.hash);
    current = null;
    if (!had) return;
    const tag = stateTag();
    if (tag === 'push' || tag === 'nav') {
      try { history.back(); return; } catch (_) { /* fall through */ }
    }
    setState(null, bare(), false);
  },

  current: () => current,
  resolve,
  href: (target) => toHash(resolve(target) || target),
};

export default router;
