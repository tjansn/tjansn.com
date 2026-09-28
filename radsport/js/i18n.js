/**
 * i18n.js: language and theme observers, dynamic UI dictionary, formatters (spec 3.3).
 *
 *   lang() -> 'de' | 'en'          html[lang] (commercial-pages.js flips it); observed live
 *   theme() -> 'light' | 'dark'    html.dark (site theme toggle); observed live
 *   t(key, vars) -> string         dictionary below (DE and EN), {var} placeholders
 *   tn(key, n, vars) -> string     like t() but picks `${key}.one` for n === 1
 *   L(obj) -> obj[lang()] ?? obj.de   for { de, en } data fields (strings pass through)
 *   fmt.date(iso, 'short'|'long'), fmt.range(a, b, style), fmt.num(v, digits), fmt.ord(n),
 *   fmt.dur(s), fmt.country(cc), fmt.km(v, digits), fmt.w(v), fmt.time(iso), fmt.list(arr)
 *   onLangChange(fn) -> off; onThemeChange(fn) -> off
 *   extend({ de: {...}, en: {...} })   other packages may register their own strings
 *   bibLabel(bib, race) -> the full aria-label of a wall link (same text as render_static.py)
 *
 * German is primary, English secondary. No em dashes; German quotes „…“.
 */

const DICT = {
  de: {
    'hud.room': 'Die Wand',
    // D23 (round 3): the count names the numbers only, never how they were identified; main.js still passes {c} {l} {o}
    'hud.count': '{n} Nummern',
    'hud.count.open': '',
    'hud.sound': 'Ton',
    'hud.sound.turnOn': 'Ton einschalten',
    'hud.sound.turnOff': 'Ton ausschalten',
    'hud.sound.ask': 'Ton an?',
    'hud.cc': 'UT',
    'hud.cc.show': 'Untertitel einblenden',
    'hud.cc.hide': 'Untertitel ausblenden',
    'hud.light': 'Saallicht',
    'hud.light.on': 'Saallicht einschalten',
    'hud.light.off': 'Saallicht ausschalten',
    'hud.list': 'Liste',
    'hud.rail': 'Saisons {first} bis {last}',

    'dl.title': 'Datenlage',
    'dl.result': 'Ergebnis',
    'dl.date': 'Datum',
    'dl.power': 'Leistung',
    'dl.weather': 'Wetter',
    'dl.photos': 'Fotos',
    'dl.aria': 'Datenlage: {have} von 5 vorhanden',
    'dl.have': 'Vorhanden',
    'dl.on': 'vorhanden',
    'dl.off': 'nicht vorhanden',                     // round 3: „offen“ is a retired status word (D23)

    'label.kicker': 'Nr. {n} · {country} · {year}',
    'label.cta': 'Enter oder Klick: von der Wand nehmen',
    'label.ctaTouch': 'Noch einmal tippen zum Öffnen',
    'label.open': 'Öffnen',
    'label.unassigned': 'Rennen unbekannt',

    'bib.number': 'Startnummer {n}',
    'bib.numberHidden': 'Startnummer unbekannt',
    'bib.short': 'Nr. {n}',
    'bib.shortHidden': 'Nr. ?',
    'bib.take': 'Von der Wand nehmen.',

    'res.place': '{ord} Platz',
    'res.gc': '{ord} Platz in der Gesamtwertung',
    'res.win': 'Sieg',
    'res.dnf': 'nicht im Ziel',
    'res.dns': 'nicht gestartet',
    'res.dsq': 'disqualifiziert',
    'res.finished': 'im Ziel',
    'res.started': 'gestartet, Ergebnis unbekannt',
    'res.of': 'von {n}',
    'res.short.dnf': 'DNF',
    'res.short.dns': 'DNS',
    'res.short.dsq': 'DSQ',
    'res.short.finished': 'im Ziel',
    'res.short.started': 'gestartet',
    'res.stages': '{n} Etappen',
    'res.stages.one': '1 Etappe',

    'kind.one_day': 'Eintagesrennen',
    'kind.stage_race': 'Etappenrennen',
    'kind.criterium': 'Kriterium',
    'kind.kermesse': 'Kermesse',
    'kind.championship': 'Meisterschaft',
    'kind.hill_climb': 'Bergrennen',
    'kind.time_trial': 'Zeitfahren',
    'kind.mtb_marathon': 'MTB-Marathon',
    'kind.mtb_24h': '24-Stunden-MTB',
    'kind.sportive': 'Radmarathon',
    'kind.other': 'Sonstiges',

    'list.filters': 'Filter',
    'list.filters.aria': 'Liste filtern',
    'list.year': 'Jahr',
    'list.year.all': 'Alle Jahre',
    'list.country': 'Land',
    'list.country.all': 'Alle Länder',
    'list.kind': 'Art',
    'list.kind.all': 'Alle Arten',
    'list.result': 'Ergebnis',
    'list.result.all': 'Alle',
    'list.result.win': 'Sieg',
    'list.result.podium': 'Podium',
    'list.result.top10': 'Top 10',
    'list.result.finished': 'beendet',
    'list.result.dnf': 'DNF',
    'list.has': 'Nur Rennen mit',
    'list.has.power': 'Leistungsdaten',
    'list.has.photos': 'Fotos',
    'list.has.wall': 'Nummer an der Wand',
    'list.count': '{shown} von {total} Rennen',
    'list.count.one': '1 von {total} Rennen',
    'list.reset': 'Filter zurücksetzen',
    'list.empty': 'Keine Rennen für diese Auswahl.',
    'list.mark.wall': 'Nr. {n} an der Wand',
    'list.mark.wallHidden': 'Nummer an der Wand',
    'list.mark.power': 'Leistungsdaten',
    'list.mark.photos': 'Fotos',
    'list.th.date': 'Datum',
    'list.th.race': 'Rennen',
    'list.th.result': 'Ergebnis',

    'season.days': '{n} Renntage',
    'season.days.one': '1 Renntag',
    'season.wins': '{n} Siege',
    'season.wins.one': '1 Sieg',
    'season.podiums': '{n} Podien',
    'season.podiums.one': '1 Podium',
    'season.top10': '{n}× Top 10',
    'season.bibs': '{n} Nummern an der Wand',
    'season.bibs.one': '1 Nummer an der Wand',
    'season.team': 'Team',
    'season.k': 'Saison {year}',
    'season.best': 'Beste Werte der Saison',
    'season.filter': 'Liste auf {year} filtern',
    'season.unfilter': 'Filter {year} aufheben',
    'season.none': 'Keine Rennen erfasst',
    'season.aria': '{year}: {summary}',
    'season.strip': 'Saisons {first} bis {last}',

    'live.opened': 'Dossier geöffnet: {title}',
    'live.closed': 'Dossier geschlossen',
    'live.unknown': 'Diesen Eintrag gibt es nicht. Hier ist die Wand.',
    'live.season': 'Saison {year}: {n} Nummern leuchten',
    'live.seasonNone': 'Saison {year}: keine Nummer an der Wand',
    'live.seasonOff': 'Saisonfilter aufgehoben',
    'live.houseOn': 'Saallicht an',
    'live.houseOff': 'Saallicht aus',
    'live.list': 'Liste gefiltert: {count}',

    'd.close': 'Schließen',
    'd.prev': 'Vorheriges Rennen',
    'd.next': 'Nächstes Rennen',
    'd.prevTo': 'Vorheriges Rennen: {name}',
    'd.nextTo': 'Nächstes Rennen: {name}',
    'd.position': '{i} von {n}',
    'd.keys': 'Pfeiltasten: blättern · Esc: schließen',
    'd.exhibit.caption': 'Freigestellt aus dem Wandfoto (2017). Schraffiert: verdeckt.',
    'd.meta.date': 'Datum',
    'd.meta.place': 'Ort',
    'd.meta.category': 'Kategorie',
    'd.meta.distance': 'Distanz',
    'd.meta.team': 'Team',
    'd.result': 'Ergebnis',
    'd.story': 'In meinen Worten',
    'd.notes': 'Aus meinen Notizen',
    'd.translation': 'Übersetzung',
    'd.power': 'Leistungsdaten',
    'd.replay': 'Rennen abspielen',
    'd.replay.pause': 'Anhalten',
    'd.table': 'Als Tabelle',
    'd.weather': 'Wetter am Renntag',
    'd.weather.measured': 'am Rad gemessen',
    'd.place': 'Ort',
    'd.photos': 'Fotos vom Renntag',
    'd.facts': 'Aus dem Rennen',
    'd.sources': 'Quellen',
    'd.missing': 'Nicht vorhanden',
    'd.ask': 'Weißt du, welches Rennen das war? Schreib mir.',
    'd.conflict': 'Quellen widersprechen sich',
    'd.me': 'Ich',
    'd.winner': 'Sieger',
    'd.podium': 'Podium',
    'd.notable': 'Im Feld',
    'd.src.local': 'eigene Unterlagen',
    'd.src.web': 'Web',
    'd.src.photo': 'Foto',
    'd.stage': 'Etappe',
    'd.stages': 'Etappen',
    'd.prologue': 'Prolog',
    'd.gc': 'Gesamtwertung',
    'd.gap': '{gap} Rückstand',
    'd.bests': 'Bestwerte',
    'd.window': 'Rennabschnitt',
    'd.indexcard': 'Karteikarte',
  },
  en: {
    'hud.room': 'The wall',
    'hud.count': '{n} numbers',
    'hud.count.open': '',
    'hud.sound': 'Sound',
    'hud.sound.turnOn': 'Turn sound on',
    'hud.sound.turnOff': 'Turn sound off',
    'hud.sound.ask': 'Sound on?',
    'hud.cc': 'CC',
    'hud.cc.show': 'Show captions',
    'hud.cc.hide': 'Hide captions',
    'hud.light': 'House lights',
    'hud.light.on': 'Turn house lights on',
    'hud.light.off': 'Turn house lights off',
    'hud.list': 'List',
    'hud.rail': 'Seasons {first} to {last}',

    'dl.title': 'Data',
    'dl.result': 'Result',
    'dl.date': 'Date',
    'dl.power': 'Power',
    'dl.weather': 'Weather',
    'dl.photos': 'Photos',
    'dl.aria': 'Data: {have} of 5 available',
    'dl.have': 'Available',
    'dl.on': 'available',
    'dl.off': 'not available',

    'label.kicker': 'No. {n} · {country} · {year}',
    'label.cta': 'Enter or click: take it off the wall',
    'label.ctaTouch': 'Tap again to open',
    'label.open': 'Open',
    'label.unassigned': 'Race unknown',

    'bib.number': 'Race number {n}',
    'bib.numberHidden': 'Race number unknown',
    'bib.short': 'No. {n}',
    'bib.shortHidden': 'No. ?',
    'bib.take': 'Take it off the wall.',

    'res.place': '{ord} place',
    'res.gc': '{ord} place overall',
    'res.win': 'Win',
    'res.dnf': 'did not finish',
    'res.dns': 'did not start',
    'res.dsq': 'disqualified',
    'res.finished': 'finished',
    'res.started': 'started, result unknown',
    'res.of': 'of {n}',
    'res.short.dnf': 'DNF',
    'res.short.dns': 'DNS',
    'res.short.dsq': 'DSQ',
    'res.short.finished': 'finished',
    'res.short.started': 'started',
    'res.stages': '{n} stages',
    'res.stages.one': '1 stage',

    'kind.one_day': 'One-day race',
    'kind.stage_race': 'Stage race',
    'kind.criterium': 'Criterium',
    'kind.kermesse': 'Kermesse',
    'kind.championship': 'Championship',
    'kind.hill_climb': 'Hill climb',
    'kind.time_trial': 'Time trial',
    'kind.mtb_marathon': 'MTB marathon',
    'kind.mtb_24h': '24-hour MTB',
    'kind.sportive': 'Sportive',
    'kind.other': 'Other',

    'list.filters': 'Filters',
    'list.filters.aria': 'Filter the list',
    'list.year': 'Year',
    'list.year.all': 'All years',
    'list.country': 'Country',
    'list.country.all': 'All countries',
    'list.kind': 'Type',
    'list.kind.all': 'All types',
    'list.result': 'Result',
    'list.result.all': 'All',
    'list.result.win': 'Win',
    'list.result.podium': 'Podium',
    'list.result.top10': 'Top 10',
    'list.result.finished': 'finished',
    'list.result.dnf': 'DNF',
    'list.has': 'Only races with',
    'list.has.power': 'power data',
    'list.has.photos': 'photos',
    'list.has.wall': 'number on the wall',
    'list.count': '{shown} of {total} races',
    'list.count.one': '1 of {total} races',
    'list.reset': 'Reset filters',
    'list.empty': 'No races match these filters.',
    'list.mark.wall': 'No. {n} on the wall',
    'list.mark.wallHidden': 'Number on the wall',
    'list.mark.power': 'Power data',
    'list.mark.photos': 'Photos',
    'list.th.date': 'Date',
    'list.th.race': 'Race',
    'list.th.result': 'Result',

    'season.days': '{n} race days',
    'season.days.one': '1 race day',
    'season.wins': '{n} wins',
    'season.wins.one': '1 win',
    'season.podiums': '{n} podiums',
    'season.podiums.one': '1 podium',
    'season.top10': '{n}× top 10',
    'season.bibs': '{n} numbers on the wall',
    'season.bibs.one': '1 number on the wall',
    'season.team': 'Team',
    'season.k': 'Season {year}',
    'season.best': 'Best efforts of the season',
    'season.filter': 'Filter the list to {year}',
    'season.unfilter': 'Clear the {year} filter',
    'season.none': 'No races recorded',
    'season.aria': '{year}: {summary}',
    'season.strip': 'Seasons {first} to {last}',

    'live.opened': 'Dossier opened: {title}',
    'live.closed': 'Dossier closed',
    'live.unknown': 'This entry does not exist. Here is the wall.',
    'live.season': 'Season {year}: {n} numbers lit',
    'live.seasonNone': 'Season {year}: no number on the wall',
    'live.seasonOff': 'Season filter cleared',
    'live.houseOn': 'House lights on',
    'live.houseOff': 'House lights off',
    'live.list': 'List filtered: {count}',

    'd.close': 'Close',
    'd.prev': 'Previous race',
    'd.next': 'Next race',
    'd.prevTo': 'Previous race: {name}',
    'd.nextTo': 'Next race: {name}',
    'd.position': '{i} of {n}',
    'd.keys': 'Arrow keys: browse · Esc: close',
    'd.exhibit.caption': 'Cut out from the wall photo (2017). Hatched: hidden.',
    'd.meta.date': 'Date',
    'd.meta.place': 'Place',
    'd.meta.category': 'Category',
    'd.meta.distance': 'Distance',
    'd.meta.team': 'Team',
    'd.result': 'Result',
    'd.story': 'In my words',
    'd.notes': 'From my notes',
    'd.translation': 'Translation',
    'd.power': 'Power data',
    'd.replay': 'Play the race',
    'd.replay.pause': 'Pause',
    'd.table': 'As a table',
    'd.weather': 'Weather on race day',
    'd.weather.measured': 'measured on the bike',
    'd.place': 'Place',
    'd.photos': 'Photos from race day',
    'd.facts': 'From the race',
    'd.sources': 'Sources',
    'd.missing': 'Not available',
    'd.ask': 'Do you know which race this was? Write to me.',
    'd.conflict': 'Sources disagree',
    'd.me': 'Me',
    'd.winner': 'Winner',
    'd.podium': 'Podium',
    'd.notable': 'In the field',
    'd.src.local': 'my own records',
    'd.src.web': 'web',
    'd.src.photo': 'photo',
    'd.stage': 'Stage',
    'd.stages': 'Stages',
    'd.prologue': 'Prologue',
    'd.gc': 'General classification',
    'd.gap': '{gap} behind',
    'd.bests': 'Best efforts',
    'd.window': 'Race section',
    'd.indexcard': 'Index card',
  },
};

const MONTHS = {
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const MONTHS_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LOCALE = { de: 'de-DE', en: 'en-GB' };

const root = typeof document !== 'undefined' ? document.documentElement : null;

export function lang() {
  const l = ((root && root.getAttribute('lang')) || 'de').toLowerCase();
  return l.startsWith('en') ? 'en' : 'de';
}

export function theme() {
  return root && root.classList.contains('dark') ? 'dark' : 'light';
}

export function locale() {
  return LOCALE[lang()];
}

function fill(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

export function t(key, vars) {
  const l = lang();
  const s = DICT[l][key] ?? DICT.de[key];
  return s == null ? key : fill(s, vars);
}

export function tn(key, n, vars = {}) {
  const l = lang();
  const one = n === 1 ? (DICT[l][`${key}.one`] ?? DICT.de[`${key}.one`]) : null;
  const s = one ?? DICT[l][key] ?? DICT.de[key];
  return s == null ? key : fill(s, { n, ...vars });
}

export function has(key) {
  return key in DICT.de || key in DICT.en;
}

export function L(obj) {
  if (obj == null) return '';
  if (typeof obj !== 'object') return String(obj);
  const v = obj[lang()];
  return v ?? obj.de ?? obj.en ?? '';
}

/** Register more strings: extend({ de: {...}, en: {...} }). Existing keys are overwritten. */
export function extend(dict) {
  if (!dict) return;
  for (const l of ['de', 'en']) {
    if (dict[l]) Object.assign(DICT[l], dict[l]);
  }
}

// ------------------------------------------------------------------ formatters
function parts(iso) {
  if (!iso) return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(String(iso));
  if (!m) return null;
  return { y: +m[1], m: m[2] ? +m[2] : null, d: m[3] ? +m[3] : null };
}
const pad = (n) => String(n).padStart(2, '0');

function dateOne(p, style, l) {
  if (!p.m) return String(p.y);
  if (!p.d) return l === 'de' ? `${MONTHS.de[p.m - 1]} ${p.y}` : `${MONTHS.en[p.m - 1]} ${p.y}`;
  if (style === 'long') return l === 'de' ? `${p.d}. ${MONTHS.de[p.m - 1]} ${p.y}` : `${p.d} ${MONTHS.en[p.m - 1]} ${p.y}`;
  return l === 'de' ? `${pad(p.d)}.${pad(p.m)}.${p.y}` : `${p.d} ${MONTHS_SHORT_EN[p.m - 1]} ${p.y}`;
}

function range(a, b, style = 'long') {
  const l = lang();
  const pa = parts(a);
  const pb = parts(b);
  if (!pa) return '';
  if (!pb || a === b || !pa.d || !pb.d) return dateOne(pa, style, l);
  const long = style === 'long';
  if (l === 'de') {
    const to = ' bis ';
    if (long) {
      if (pa.y === pb.y && pa.m === pb.m) return `${pa.d}.${to}${pb.d}. ${MONTHS.de[pb.m - 1]} ${pb.y}`;
      if (pa.y === pb.y) return `${pa.d}. ${MONTHS.de[pa.m - 1]}${to}${pb.d}. ${MONTHS.de[pb.m - 1]} ${pb.y}`;
      return `${dateOne(pa, 'long', l)}${to}${dateOne(pb, 'long', l)}`;
    }
    if (pa.y === pb.y) return `${pad(pa.d)}.${pad(pa.m)}.${to}${pad(pb.d)}.${pad(pb.m)}.${pb.y}`;
    return `${dateOne(pa, 'short', l)}${to}${dateOne(pb, 'short', l)}`;
  }
  const to = ' to ';
  const names = long ? MONTHS.en : MONTHS_SHORT_EN;
  if (pa.y === pb.y && pa.m === pb.m) return `${pa.d}${to}${pb.d} ${names[pb.m - 1]} ${pb.y}`;
  if (pa.y === pb.y) return `${pa.d} ${names[pa.m - 1]}${to}${pb.d} ${names[pb.m - 1]} ${pb.y}`;
  return `${dateOne(pa, style, l)}${to}${dateOne(pb, style, l)}`;
}

const numCache = new Map();
function num(v, digits = 0) {
  if (v == null || Number.isNaN(+v)) return '';
  const key = `${lang()}|${digits}`;
  if (!numCache.has(key)) {
    numCache.set(key, new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return numCache.get(key).format(+v);
}

function ord(n) {
  if (n == null) return '';
  if (lang() === 'de') return `${n}.`;
  const v = Math.abs(n) % 100;
  const s = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
  return `${n}${s}`;
}

function dur(s) {
  if (s == null || Number.isNaN(+s)) return '';
  const total = Math.round(Math.abs(+s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const regionCache = new Map();
const REGION_FIX = { UK: 'GB', EL: 'GR' };
function country(cc) {
  if (!cc) return '';
  const code = REGION_FIX[String(cc).toUpperCase()] || String(cc).toUpperCase();
  const l = lang();
  try {
    if (!regionCache.has(l)) regionCache.set(l, new Intl.DisplayNames([LOCALE[l]], { type: 'region' }));
    return regionCache.get(l).of(code) || code;
  } catch (_) {
    return code;
  }
}

function time(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
  return m ? `${m[1]}:${m[2]}` : '';
}

function list(arr) {
  const items = (arr || []).filter(Boolean).map(String);
  try {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items);
  } catch (_) {
    return items.join(', ');
  }
}

export const fmt = {
  date: (iso, style = 'short') => { const p = parts(iso); return p ? dateOne(p, style, lang()) : ''; },
  range,
  num,
  ord,
  dur,
  country,
  km: (v, digits = 1) => (v == null ? '' : `${num(v, digits)} km`),
  w: (v) => (v == null ? '' : `${num(Math.round(+v), 0)} W`),
  time,
  list,
  year: (iso) => { const p = parts(iso); return p ? String(p.y) : ''; },
};

// ------------------------------------------------------------------ observers
const langFns = new Set();
const themeFns = new Set();
let lastLang = null;
let lastTheme = null;
let observer = null;

function ensureObserver() {
  if (observer || !root || typeof MutationObserver === 'undefined') return;
  lastLang = lang();
  lastTheme = theme();
  observer = new MutationObserver(() => {
    const l = lang();
    if (l !== lastLang) {
      lastLang = l;
      numCache.clear();
      for (const fn of [...langFns]) {
        try { fn(l); } catch (e) { console.warn('[radsport] onLangChange:', e); }
      }
    }
    const th = theme();
    if (th !== lastTheme) {
      lastTheme = th;
      for (const fn of [...themeFns]) {
        try { fn(th); } catch (e) { console.warn('[radsport] onThemeChange:', e); }
      }
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ['lang', 'class'] });
}

export function onLangChange(fn) {
  ensureObserver();
  langFns.add(fn);
  return () => langFns.delete(fn);
}

export function onThemeChange(fn) {
  ensureObserver();
  themeFns.add(fn);
  return () => themeFns.delete(fn);
}

// ------------------------------------------------------------------ shared phrases
/** The number as known (round 3, D24: no word on what the wall hides): numberFull when every digit is drawn in ink
 *  (2311 of b07), else the digits the wall shows or the known lead of numberFull plus "…" ("14…"); render_static.py
 *  number_text() is the same rule. */
export function numberText(bib) {
  if (!bib) return '';
  const full = bib.numberFull != null ? String(bib.numberFull) : '';
  const st = Array.isArray(bib.digitStates) ? bib.digitStates : [];
  if (/^\d+$/.test(full) && st.length === full.length && st.every((x) => x === 'ink')) return full;
  const wall = bib.number != null ? String(bib.number) : '';
  const src = /^\d/.test(wall) ? wall : full;
  const m = /^\d+/.exec(src);
  return m ? m[0] + (m[0].length < src.length ? '…' : '') : '';
}

/** "Startnummer 53" / "Startnummer 14…". */
export function numberPhrase(bib) {
  const n = numberText(bib);
  return n ? t('bib.number', { n }) : t('bib.numberHidden');
}

/** "Nr. 53" or "Nr. 14…". */
export function numberShort(bib) {
  const n = numberText(bib);
  return n ? t('bib.short', { n }) : t('bib.shortHidden');
}

/** Date of a race for running text: long range, single long date, or the year. */
export function raceDate(race, style = 'long') {
  if (!race) return '';
  if (race.date) return race.endDate && race.endDate !== race.date ? range(race.date, race.endDate, style) : fmt.date(race.date, style);
  return race.year ? String(race.year) : '';
}

/** Result for running text ("8. Platz", "nicht im Ziel") or '' when nothing is sourced. */
export function resultPhrase(result) {
  if (!result || !result.src || !result.src.length) return '';
  switch (result.type) {
    case 'place': return result.pos ? t('res.place', { ord: ord(result.pos) }) : '';
    case 'gc': return result.pos ? t('res.gc', { ord: ord(result.pos) }) : '';
    case 'dnf': case 'dns': case 'dsq': case 'finished': case 'started':
      return t(`res.${result.type}`);
    case 'stages': return result.text ? L(result.text) : '';
    default: return '';
  }
}

/** Every stage of a stage race, up to its last day, finished ("4 von 4 Etappen beendet"). */
export function stagesFinished(race) {
  const st = (race && Array.isArray(race.stages) ? race.stages : []).slice().sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  if (!st.length || !st.every((s) => s && s.result && ['place', 'gc', 'finished'].includes(s.result.type))) return false;
  if (st.some((s, i) => i > 0 && s.n !== st[i - 1].n + 1)) return false;
  const last = st.reduce((a, s) => (s.date && s.date > a ? s.date : a), '');
  return !race.endDate || last === race.endDate;
}

/** Compact result for list rows and labels: "8.", "1.", "DNF", "im Ziel", "gestartet" (round 3: "stages" and
 *  "unknown" too, every raced row shows one). */
export function resultShort(result, race = null) {
  if (!result || !result.src || !result.src.length) return '';
  switch (result.type) {
    case 'place': case 'gc': return result.pos ? ord(result.pos) : '';
    case 'dnf': case 'dns': case 'dsq': case 'finished': case 'started':
      return t(`res.short.${result.type}`);
    case 'stages': return t(stagesFinished(race) ? 'res.short.finished' : 'res.short.started');
    case 'unknown': return t('res.short.started');
    default: return '';
  }
}

/** Full accessible label of a wall link (spec 7): number, race, date, result. render_static.py builds the same text.
 *  D23 (round 3): no match status (the data keeps bib.ident, nothing of it is read here). */
export function bibLabel(bib, race) {
  const n = numberPhrase(bib);
  let s = /…$/.test(n) ? n : `${n}.`;                  // "14… Rennen", never "14…. Rennen"
  if (race) {
    const bits = [L(race.name)];
    const d = raceDate(race, 'long');
    if (d) bits.push(d);
    const r = resultPhrase(race.result);
    if (r) bits.push(r);
    s += ` ${bits.filter(Boolean).join(', ')}.`;
  } else {
    s += ` ${t('label.unassigned')}.`;
  }
  return `${s} ${t('bib.take')}`;
}

export const i18n = {
  lang, theme, locale, t, tn, has, L, fmt, extend, onLangChange, onThemeChange,
  numberText, numberPhrase, numberShort, raceDate, resultPhrase, resultShort, stagesFinished, bibLabel,
};

export default i18n;
