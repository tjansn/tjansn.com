/**
 * data.js: loads races.json and bibs.json, builds indexes, lazy power and weather (spec 3.4, 4).
 *
 *   loadIndex() -> Promise<{ races: Map, bibs: Map, order: string[], seasons: Map, ... }>
 *   getRace(id); getBib(id); raceForBib(bibId); bibsForRace(raceId); neighbours(raceId | bibId)
 *   loadPower(ref) -> Promise<Series | null>; loadWeather(ref) -> Promise<Weather | null>
 *
 * Additions (WP3): getSource(id), targetFor(id), isWin(result), resultClass(result), hasPower(race),
 * hasPhotos(race), raceDays(race), sortKey(race); the index also carries listOrder, raceList,
 * bibList, stats, sources, config, meta, fixtures.
 *
 * order = races with at least one bib on the wall, chronological (stage races by start date),
 * then the bibs without a race in wall reading order. neighbours() walks `order` for those and
 * the chronological list of all raced races (listOrder) for races without a bib.
 *
 * Fixtures (radsport/data/fixtures/, never shipped) are used only on a local dev host: when the real
 * file is missing there, or with ?fixtures in the URL (ignored on any other host). If races come from the fixtures while
 * bibs.json is real, the fixture's raceId/ident/leads are overlaid on the real geometry.
 */

const DATA = new URL('../data/', import.meta.url);
const FIXTURES = new URL('fixtures/', DATA);

function readBuild() {
  try {
    const el = typeof document !== 'undefined' && document.getElementById('rs-build');
    return el ? JSON.parse(el.textContent || '{}') : {};
  } catch (_) {
    return {};
  }
}
const BUILD = readBuild();
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

/** Fixtures load only on a local development host (never in normal mode on the site, whatever the URL says). */
function devHost() {
  if (typeof location === 'undefined') return false;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.local');
}

function versioned(url, fixture) {
  const v = BUILD.data;
  return v && !fixture ? `${url}${url.includes('?') ? '&' : '?'}v=${v}` : url;
}

async function getJSON(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Real file first; fixture only in development. BUILD.files tells which real files exist. */
async function loadFile(name) {
  const known = BUILD.files && Object.prototype.hasOwnProperty.call(BUILD.files, name) ? BUILD.files[name] : null;
  const forceFixture = params.has('fixtures') && devHost();
  if (!forceFixture && known !== false) {
    try {
      return { json: await getJSON(versioned(new URL(name, DATA).href, false)), base: DATA, fixture: false };
    } catch (e) {
      if (!devHost()) throw e;
    }
  }
  if (!devHost()) throw new Error(`${name} missing`);
  return { json: await getJSON(new URL(name, FIXTURES).href), base: FIXTURES, fixture: true };
}

let index = null;
let loading = null;
let bases = { bibs: DATA, races: DATA };
const fileCache = new Map();

const arr = (v) => (Array.isArray(v) ? v : []);

function normBib(b) {
  return {
    ...b,
    number: b.number == null || b.number === '' ? null : String(b.number),
    poly: arr(b.poly),
    held: arr(b.held),
    pins: arr(b.pins),
    handwriting: arr(b.handwriting),
    leads: arr(b.leads),
    ident: b.ident || null,
    raceId: b.raceId || null,
    readingOrder: b.readingOrder ?? 999,
  };
}

function normRace(r) {
  const race = {
    ...r,
    stages: arr(r.stages),
    photos: arr(r.photos),
    facts: arr(r.facts),
    podium: arr(r.podium),
    notable: arr(r.notable),
    conflicts: arr(r.conflicts),
    bibs: arr(r.bibs),
    year: r.year ?? (r.date ? Number(String(r.date).slice(0, 4)) : null),
  };
  if (!race.completeness) {
    race.completeness = {
      result: resultClass(race.result) !== 'none' && resultClass(race.result) !== 'other',
      date: Boolean(race.date),
      power: hasPower(race),
      weather: Boolean(race.weather) || race.stages.some((s) => s.weather),
      photos: race.photos.length > 0,
    };
  }
  return race;
}

export function sortKey(race) {
  return `${race.date || `${race.year || 9999}-12-31`}|${race.id}`;
}

export function isWin(result) {
  return Boolean(result && result.src && result.src.length && (result.type === 'place' || result.type === 'gc') && result.pos === 1);
}

/** 'win' | 'podium' | 'top10' | 'finished' | 'dnf' | 'other' | 'none' (list filter classes). */
export function resultClass(result) {
  if (!result || !result.src || !result.src.length) return 'none';
  const pos = result.pos;
  if ((result.type === 'place' || result.type === 'gc') && pos) {
    if (pos === 1) return 'win';
    if (pos <= 3) return 'podium';
    if (pos <= 10) return 'top10';
    return 'finished';
  }
  if (result.type === 'finished') return 'finished';
  if (result.type === 'dnf' || result.type === 'dsq') return 'dnf';
  return 'other';
}

export function hasPower(race) {
  if (!race) return false;
  const p = race.power;
  return Boolean((p && (p.file || arr(p.stagesWithPower).length)) || arr(race.stages).some((s) => s && s.power));
}

export function hasPhotos(race) {
  return Boolean(race && arr(race.photos).length);
}

export function raceDays(race) {
  if (!race) return 0;
  if (arr(race.stages).length) return race.stages.length;
  if (race.date && race.endDate && race.endDate !== race.date) {
    const d = (Date.parse(`${race.endDate}T12:00:00Z`) - Date.parse(`${race.date}T12:00:00Z`)) / 864e5;
    if (d > 0 && d < 40) return Math.round(d) + 1;
  }
  return 1;
}

function overlayAssignments(realBibs, fixtureBibs) {
  const fx = new Map(arr(fixtureBibs && fixtureBibs.bibs).map((b) => [b.id, b]));
  for (const b of realBibs) {
    const f = fx.get(b.id);
    if (!f) continue;
    if (!b.raceId && f.raceId) b.raceId = f.raceId;
    if (!b.ident && f.ident) b.ident = f.ident;
    if ((!b.leads || !b.leads.length) && f.leads) b.leads = f.leads;
  }
}

function buildIndex(bibsDoc, racesDoc, fixtures) {
  const bibList = arr(bibsDoc && bibsDoc.bibs).map(normBib);
  const races = new Map();
  for (const r of arr(racesDoc && racesDoc.races)) {
    if (r && r.id) races.set(r.id, normRace(r));
  }
  const bibs = new Map(bibList.map((b) => [b.id, b]));
  const raced = (id) => {
    const r = races.get(id);
    return r && r.status === 'raced' ? r : null;
  };
  for (const b of bibList) {
    if (b.raceId && !raced(b.raceId)) {
      b.raceIdUnresolved = b.raceId;
      b.raceId = null;
    }
  }
  for (const r of races.values()) {
    const own = bibList.filter((b) => b.raceId === r.id).map((b) => b.id);
    const listed = r.bibs.filter((id) => bibs.has(id) && bibs.get(id).raceId === r.id);
    r.bibs = [...new Set([...listed, ...own])].sort((a, b) => bibs.get(a).readingOrder - bibs.get(b).readingOrder);
    if (!r.primaryBib || !r.bibs.includes(r.primaryBib)) r.primaryBib = r.bibs[0] || null;
  }
  const raceList = [...races.values()].filter((r) => r.status === 'raced').sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  const listOrder = raceList.map((r) => r.id);
  const unassigned = bibList.filter((b) => !b.raceId).sort((a, b) => a.readingOrder - b.readingOrder);
  const order = [...raceList.filter((r) => r.bibs.length).map((r) => r.id), ...unassigned.map((b) => b.id)];

  const years = raceList.map((r) => r.year).filter(Boolean);
  const firstYear = years.length ? Math.min(...years) : null;
  const lastYear = years.length ? Math.max(...years) : null;
  const seasonMeta = (racesDoc && racesDoc.seasons) || {};
  const seasons = new Map();
  if (firstYear) {
    for (let y = firstYear; y <= lastYear; y += 1) {
      seasons.set(y, { year: y, races: [], raceDays: 0, wins: 0, podiums: 0, top10: 0, dnf: 0, bibs: [], countries: [], team: null, best: null });
    }
  }
  const teamCount = new Map();
  for (const r of raceList) {
    const s = seasons.get(r.year);
    if (!s) continue;
    s.races.push(r.id);
    s.raceDays += raceDays(r);
    const cls = resultClass(r.result);
    if (cls === 'win') s.wins += 1;
    if (cls === 'win' || cls === 'podium') s.podiums += 1;
    if (cls === 'win' || cls === 'podium' || cls === 'top10') s.top10 += 1;
    if (cls === 'dnf') s.dnf += 1;
    s.bibs.push(...r.bibs);
    if (r.country && !s.countries.includes(r.country)) s.countries.push(r.country);
    const tn = r.team && r.team.name;
    if (tn) {
      const k = `${r.year}|${tn}`;
      teamCount.set(k, (teamCount.get(k) || 0) + 1);
    }
  }
  for (const s of seasons.values()) {
    const meta = seasonMeta[String(s.year)] || {};
    if (meta.team && meta.team.name) {
      s.team = meta.team;
    } else {
      let best = null;
      for (const [k, n] of teamCount) {
        const [y, name] = k.split('|');
        if (Number(y) === s.year && (!best || n > best.n)) best = { name, n };
      }
      s.team = best ? { name: best.name, derived: true } : null;
    }
    if (meta.best) s.best = meta.best;
  }
  const matched = bibList.filter((b) => b.raceId).length;
  const stats = {
    ...(racesDoc && racesDoc.stats),
    bibs: bibList.length,
    bibsMatched: matched,
    firstYear,
    lastYear,
    raceDays: raceList.reduce((n, r) => n + raceDays(r), 0),
    races: raceList.length,
  };
  return {
    races,
    bibs,
    order,
    seasons,
    listOrder,
    raceList,
    bibList,
    stats,
    sources: (racesDoc && racesDoc.sources) || {},
    config: { showHR: false, showWkg: false, ...((racesDoc && racesDoc.config) || {}) },
    meta: (bibsDoc && bibsDoc.meta) || {},
    space: (bibsDoc && bibsDoc.space) || { w: 4789, h: 3527 },
    fixtures,
  };
}

export function loadIndex() {
  if (index) return Promise.resolve(index);
  if (loading) return loading;
  loading = (async () => {
    const [b, r] = await Promise.all([loadFile('bibs.json'), loadFile('races.json')]);
    bases = { bibs: b.base, races: r.base };
    const fixtures = { bibs: b.fixture, races: r.fixture, overlay: false };
    if (r.fixture && !b.fixture) {
      try {
        overlayAssignments(b.json.bibs || [], await getJSON(new URL('bibs.json', FIXTURES).href));
        fixtures.overlay = true;
      } catch (_) { /* no overlay */ }
    }
    index = buildIndex(b.json, r.json, fixtures);
    if ((fixtures.bibs || fixtures.races) && typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-rs-fixtures', [fixtures.bibs && 'bibs', fixtures.races && 'races'].filter(Boolean).join(' '));
    }
    return index;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function getIndex() {
  return index;
}

export function getRace(id) {
  return (index && id && index.races.get(id)) || null;
}

export function getBib(id) {
  return (index && id && index.bibs.get(id)) || null;
}

export function getSource(id) {
  return (index && id && index.sources[id]) || null;
}

export function raceForBib(bibId) {
  const b = getBib(bibId);
  return b && b.raceId ? getRace(b.raceId) : null;
}

export function bibsForRace(raceId) {
  const r = getRace(raceId);
  return r ? r.bibs.map(getBib).filter(Boolean) : [];
}

/** Canonical target { raceId, bibId } for a race id or a bib id. */
export function targetFor(id) {
  if (!index || !id) return null;
  if (index.races.has(id)) {
    const r = index.races.get(id);
    return { raceId: r.id, bibId: r.primaryBib || null };
  }
  const b = index.bibs.get(id);
  if (!b) return null;
  return b.raceId ? { raceId: b.raceId, bibId: b.id } : { raceId: null, bibId: b.id };
}

export function neighbours(id) {
  const none = { prev: null, next: null, index: -1, total: 0, list: null };
  if (!index || !id) return none;
  let key = id;
  if (!index.races.has(key)) {
    const b = index.bibs.get(key);
    if (!b) return none;
    key = b.raceId || b.id;
  }
  let list = 'wall';
  let seq = index.order;
  let i = seq.indexOf(key);
  if (i < 0) {
    list = 'list';
    seq = index.listOrder;
    i = seq.indexOf(key);
  }
  if (i < 0) return { ...none, total: seq.length, list };
  return { prev: targetFor(seq[i - 1]), next: targetFor(seq[i + 1]), index: i, total: seq.length, list };
}

function refPath(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object') return ref.file || ref.power || ref.weather || ref.path || null;
  return null;
}

async function loadRef(ref) {
  const path = refPath(ref);
  if (!path || /^[a-z]+:|^\/\//i.test(path)) return null;
  const base = bases.races || DATA;
  const fixture = base === FIXTURES;
  const url = versioned(new URL(path, base).href, fixture);
  if (!fileCache.has(url)) {
    fileCache.set(url, getJSON(url).catch(() => null));
  }
  return fileCache.get(url);
}

export function loadPower(ref) {
  return loadRef(ref);
}

export function loadWeather(ref) {
  return loadRef(ref);
}

/** URL of a file inside radsport/ (crops, photos): paths in the data are relative to radsport/. */
export function assetURL(path) {
  if (!path) return null;
  return new URL(path, new URL('../', DATA)).href;
}

export const data = {
  loadIndex, getIndex, getRace, getBib, getSource, raceForBib, bibsForRace, neighbours, targetFor,
  loadPower, loadWeather, assetURL, isWin, resultClass, hasPower, hasPhotos, raceDays, sortKey,
  get index() { return index; },
};

export default data;
