/**
 * state.js: tiny store + event bus (spec 3.1). No dependencies.
 *
 *   store.get() -> state            store.set(patch)            store.on(key | '*', fn) -> off
 *   bus.emit(type, detail)          bus.on(type | '*', fn) -> off   bus.once(type, fn) -> off
 *
 * store.on(key, fn) calls fn(value, prev, state) when that key changed (shallow compare);
 * store.on('*', fn) calls fn(state, changedKeys) once per set().
 * Listener errors are caught and reported with console.warn so one broken package cannot
 * stop the others.
 *
 * Events (payload): wall:hover {bibId|null, via} · wall:activate {bibId, via} ·
 * dossier:open {raceId, bibId, stage, from} · dossier:opened · dossier:close {reason} ·
 * dossier:closed {bibId} · dossier:switch {dir} · replay:state {playing, fraction, t, speed} ·
 * replay:moment {moment} · lang:change {lang} · theme:change {theme} · sound:change {on} ·
 * caption {id, text, level, ms} · season:focus {year|null} · tier:change {tier, reason}
 * plus (WP3 additions) route:unknown {hash} · list:filter {count, total, filters}.
 */

function report(where, err) {
  try { console.warn(`[radsport] ${where}:`, err); } catch (_) { /* no console */ }
}

export function createStore(initial = {}) {
  let state = { ...initial };
  const keyed = new Map();
  const any = new Set();

  const on = (key, fn) => {
    if (key === '*') {
      any.add(fn);
      return () => any.delete(fn);
    }
    if (!keyed.has(key)) keyed.set(key, new Set());
    keyed.get(key).add(fn);
    return () => keyed.get(key)?.delete(fn);
  };

  const set = (patch) => {
    if (!patch || typeof patch !== 'object') return state;
    const prev = state;
    const changed = [];
    for (const k of Object.keys(patch)) {
      if (!Object.is(prev[k], patch[k])) changed.push(k);
    }
    if (!changed.length) return state;
    state = { ...prev, ...patch };
    for (const k of changed) {
      const fns = keyed.get(k);
      if (!fns) continue;
      for (const fn of [...fns]) {
        try { fn(state[k], prev[k], state); } catch (e) { report(`store.on(${k})`, e); }
      }
    }
    for (const fn of [...any]) {
      try { fn(state, changed); } catch (e) { report('store.on(*)', e); }
    }
    return state;
  };

  return { get: () => state, set, on };
}

export function createBus() {
  const map = new Map();
  const any = new Set();
  const on = (type, fn) => {
    if (type === '*') {
      any.add(fn);
      return () => any.delete(fn);
    }
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
    return () => map.get(type)?.delete(fn);
  };
  const once = (type, fn) => {
    const off = on(type, (detail) => { off(); fn(detail); });
    return off;
  };
  const emit = (type, detail = {}) => {
    const fns = map.get(type);
    if (fns) {
      for (const fn of [...fns]) {
        try { fn(detail, type); } catch (e) { report(`bus ${type}`, e); }
      }
    }
    for (const fn of [...any]) {
      try { fn(detail, type); } catch (e) { report(`bus * (${type})`, e); }
    }
  };
  return { emit, on, once };
}

export const store = createStore({
  lang: 'de', theme: 'light', tier: 'dom',          // 'dom' | 'medium' | 'high'
  reducedMotion: false, sound: false, captions: 'auto', houseLight: false,
  hover: null, open: null,                           // open: { raceId, bibId, stage }
  replay: { playing: false, fraction: 0, speed: 120 }, season: null,
});

export const bus = createBus();

export default { store, bus, createStore, createBus };
