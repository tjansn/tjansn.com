/* radsport/js/charts/strings.js (WP7)
 * Shared DE/EN strings and formatters for the WP7 modules (charts, replay, weather, photos, map).
 * Uses the page i18n (spec 3.3) for lang(); strings come from this file's DE/EN dictionary
 * (page i18n.t() only for keys not in it), so the modules also run on the dev page.
 * No em dashes in any string (house rule). */

const DICT = {
  de: {
    // power chart
    'pc.power': 'Leistung', 'pc.speed': 'Geschwindigkeit',
    'pc.cap.power': 'Leistung und Höhe über {axis}',
    'pc.cap.speed': 'Geschwindigkeit und Höhe über {axis}',
    'pc.axis.km': 'die Distanz', 'pc.axis.t': 'die Zeit',
    'pc.key.trend': '5-min-Mittel', 'pc.key.fine': '30-s-Mittel',
    'pc.aria.power': 'Diagramm: Leistung in Watt und Höhe in Metern über {axis}, {dist}, Ø {avg} W.',
    'pc.aria.speed': 'Diagramm: Geschwindigkeit in km/h und Höhe in Metern über {axis}, {dist}, Ø {avg} km/h.',
    'pc.slider': 'Position im Rennen. Pfeiltasten: {step}, Bild auf/ab: {big}, Leertaste: abspielen oder anhalten.',
    'pc.valuetext.km': 'km {km} von {total}', 'pc.valuetext.time': 'Rennzeit {time}',
    'pc.valuetext.t': 'Rennzeit {time} von {total}',
    'pc.table.show': 'Als Tabelle', 'pc.table.hide': 'Tabelle ausblenden',
    'pc.table.summary': 'Zusammenfassung des Rennabschnitts', 'pc.table.bests': 'Beste Leistungen im Rennabschnitt',
    'pc.table.moments': 'Momente', 'pc.table.profile': 'Verlauf in Abschnitten', 'pc.th.dur': 'Dauer', 'pc.th.time': 'Rennzeit',
    'pc.th.type': 'Art', 'pc.th.desc': 'Beschreibung', 'pc.th.section': 'Abschnitt', 'pc.th.altEnd': 'Höhe am Ende',
    'pc.s.duration': 'Dauer (Rennabschnitt)', 'pc.s.distance': 'Distanz', 'pc.s.avgw': 'Ø Leistung',
    'pc.s.np': 'Normalisierte Leistung', 'pc.s.kj': 'Arbeit', 'pc.s.cad': 'Ø Trittfrequenz',
    'pc.s.kph': 'Ø Tempo (in Bewegung)', 'pc.s.maxkph': 'Höchsttempo ({res}-s-Mittel)', 'pc.s.gain': 'Höhenmeter',
    'pc.s.temp': 'Temperatur am Rad (Ø)',
    'pc.bests': 'Bestwerte', 'pc.raw': 'roh, {res} s', 'pc.mean30': '30-s-Mittel',
    'pc.localtime': '{clock} Uhr',
    'm.climb': 'Anstieg', 'm.attack': 'Härteste Minute', 'm.sprint': 'Antritt', 'm.finale': 'Finale',
    'm.descent': 'Abfahrt', 'm.bell': 'Glocke', 'm.break': 'Ausreißversuch', 'm.other': 'Moment', 'm.topspeed': 'Höchsttempo {v} km/h',
    // readouts
    'rd.km': 'km', 'rd.w': 'W · Ø 30 s', 'rd.kph30': 'km/h · Ø 30 s', 'rd.cad': 'rpm', 'rd.kph': 'km/h', 'rd.alt': 'Höhe', 'rd.time': 'Rennzeit',
    'rd.label': 'Werte an der Wiedergabeposition', 'rd.whole': 'Ganzes Rennen',
    'rd.s.w': 'Ø W', 'rd.s.cad': 'Ø rpm', 'rd.s.kph': 'Ø km/h', 'rd.s.alt': 'max. Höhe',
    // replay
    'rp.play': 'Rennen abspielen', 'rp.pause': 'Anhalten', 'rp.resume': 'Weiter', 'rp.again': 'Nochmal abspielen',
    'rp.speed': 'Tempo der Wiedergabe', 'rp.speedN': '{n}-fach', 'rp.dur': 'etwa {d}',
    'rp.gap': 'Datenlücke: {d} übersprungen', 'rp.end': 'Ende der Aufzeichnung', 'rp.finish': 'Ende des Rennabschnitts',
    'rp.controls': 'Wiedergabe',
    // weather
    'wx.title': 'Wetter stündlich', 'wx.hour': 'Uhrzeit', 'wx.temp': 'Temperatur', 'wx.tempU': '°C',
    'wx.precip': 'Niederschlag', 'wx.precipU': 'mm', 'wx.sky': 'Himmel', 'wx.wind': 'Wind', 'wx.windU': 'km/h',
    // round 3 (D24): the board's caption names the race hours, it does not explain the highlight or the wind arrows
    'wx.race': 'Rennen', 'wx.raceHours': 'Rennen {a} bis {b} Uhr', 'wx.raceHoursDay': '',
    'wx.now': '{clock} Uhr Ortszeit', 'wx.nowReplay': '{clock} Uhr Ortszeit, Wiedergabe',
    'wx.windFrom': 'aus {dir}', 'wx.calm': 'fast still', 'wx.gust': 'Böen {g}', 'wx.cloud': '{c} % Wolken',
    'wx.day': '{date}: {min} bis {max} °C, Niederschlag {p} mm, Wind bis {w} km/h',
    // round 3 (D24): no explanatory note under the weather board (grid point, "no measurement", local time: the licence
    // credit of the data says "Modellwerte für den nächsten Gitterpunkt", the day labels name the towns, the board the time)
    'wx.model': '', 'wx.modelAt': '',
    'wx.measured': 'Am Rad gemessen ({device}): Ø {t} °C.',
    'wx.scroll': 'Wetter stündlich, seitlich scrollbar',
    'wx.arrow': '',
    // photos
    'ph.open': 'Foto vergrößern: {alt}', 'ph.strip': 'Fotos vom Renntag',
    'ph.pending': 'nur lokal: Rechte offen', 'ph.credit': 'Foto: {c}',
    'ph.prev': 'Vorheriges Foto', 'ph.next': 'Nächstes Foto', 'ph.close': 'Schließen', 'ph.count': '{i} von {n}', 'ph.hint': 'Pfeiltasten oder Wischen: blättern. Esc: schließen.',
    'ph.live': '{n}: {alt}. {cap}',
    // map
    'map.credit': 'Karte: Natural Earth (gemeinfrei)', 'map.home': 'Aachen',
    'map.aria': 'Karte: {place}{country}.', 'map.homeRef': ' Zum Vergleich: Aachen.',
    'map.prec.town': 'Ort', 'map.prec.region': 'ungefähre Lage (Region)', 'map.prec.country': 'ungefähre Lage (Land)', 'map.stages': 'Etappen {list}', 'map.range': '{a} bis {b}',
  },
  en: {
    'pc.power': 'Power', 'pc.speed': 'Speed',
    'pc.cap.power': 'Power and altitude over {axis}',
    'pc.cap.speed': 'Speed and altitude over {axis}',
    'pc.axis.km': 'distance', 'pc.axis.t': 'time',
    'pc.key.trend': '5 min average', 'pc.key.fine': '30 s average',
    'pc.aria.power': 'Chart: power in watts and altitude in metres over {axis}, {dist}, avg {avg} W.',
    'pc.aria.speed': 'Chart: speed in km/h and altitude in metres over {axis}, {dist}, avg {avg} km/h.',
    'pc.slider': 'Position in the race. Arrow keys: {step}, Page up/down: {big}, Space: play or pause.',
    'pc.valuetext.km': 'km {km} of {total}', 'pc.valuetext.time': 'race time {time}',
    'pc.valuetext.t': 'Race time {time} of {total}',
    'pc.table.show': 'Show as table', 'pc.table.hide': 'Hide table',
    'pc.table.summary': 'Summary of the race section', 'pc.table.bests': 'Best efforts in the race section',
    'pc.table.moments': 'Moments', 'pc.table.profile': 'Profile in sections', 'pc.th.dur': 'Duration', 'pc.th.time': 'Race time',
    'pc.th.type': 'Type', 'pc.th.desc': 'Description', 'pc.th.section': 'Section', 'pc.th.altEnd': 'Altitude at end',
    'pc.s.duration': 'Duration (race section)', 'pc.s.distance': 'Distance', 'pc.s.avgw': 'Avg power',
    'pc.s.np': 'Normalized power', 'pc.s.kj': 'Work', 'pc.s.cad': 'Avg cadence',
    'pc.s.kph': 'Avg speed (moving)', 'pc.s.maxkph': 'Top speed ({res} s average)', 'pc.s.gain': 'Elevation gain',
    'pc.s.temp': 'Temperature at the bike (avg)',
    'pc.bests': 'Best efforts', 'pc.raw': 'raw, {res} s', 'pc.mean30': '30 s average',
    'pc.localtime': '{clock}',
    'm.climb': 'Climb', 'm.attack': 'Hardest minute', 'm.sprint': 'Kick', 'm.finale': 'Finale',
    'm.descent': 'Descent', 'm.bell': 'Bell', 'm.break': 'Breakaway', 'm.other': 'Moment', 'm.topspeed': 'Top speed {v} km/h',
    'rd.km': 'km', 'rd.w': 'W · 30 s avg', 'rd.kph30': 'km/h · 30 s avg', 'rd.cad': 'rpm', 'rd.kph': 'km/h', 'rd.alt': 'Altitude', 'rd.time': 'Race time',
    'rd.label': 'Values at the replay position', 'rd.whole': 'Whole race',
    'rd.s.w': 'avg W', 'rd.s.cad': 'avg rpm', 'rd.s.kph': 'avg km/h', 'rd.s.alt': 'max. altitude',
    'rp.play': 'Play the race', 'rp.pause': 'Pause', 'rp.resume': 'Resume', 'rp.again': 'Play again',
    'rp.speed': 'Replay speed', 'rp.speedN': '{n} times', 'rp.dur': 'about {d}',
    'rp.gap': 'Data gap: {d} skipped', 'rp.end': 'End of the recording', 'rp.finish': 'End of the race section',
    'rp.controls': 'Replay',
    'wx.title': 'Hourly weather', 'wx.hour': 'Time', 'wx.temp': 'Temperature', 'wx.tempU': '°C',
    'wx.precip': 'Precipitation', 'wx.precipU': 'mm', 'wx.sky': 'Sky', 'wx.wind': 'Wind', 'wx.windU': 'km/h',
    'wx.race': 'Race', 'wx.raceHours': 'Race {a} to {b}', 'wx.raceHoursDay': '',
    'wx.now': '{clock} local time', 'wx.nowReplay': '{clock} local time, replay',
    'wx.windFrom': 'from {dir}', 'wx.calm': 'almost calm', 'wx.gust': 'gusts {g}', 'wx.cloud': '{c}% cloud',
    'wx.day': '{date}: {min} to {max} °C, precipitation {p} mm, wind up to {w} km/h',
    'wx.model': '', 'wx.modelAt': '',
    'wx.measured': 'Measured at the bike ({device}): avg {t} °C.',
    'wx.scroll': 'Hourly weather, scrolls sideways',
    'wx.arrow': '',
    'ph.open': 'Enlarge photo: {alt}', 'ph.strip': 'Photos from the race day',
    'ph.pending': 'local only: rights pending', 'ph.credit': 'Photo: {c}',
    'ph.prev': 'Previous photo', 'ph.next': 'Next photo', 'ph.close': 'Close', 'ph.count': '{i} of {n}', 'ph.hint': 'Arrow keys or swipe: browse. Esc: close.',
    'ph.live': '{n}: {alt}. {cap}',
    'map.credit': 'Map: Natural Earth (public domain)', 'map.home': 'Aachen',
    'map.aria': 'Map: {place}{country}.', 'map.homeRef': ' For reference: Aachen.',
    'map.prec.town': 'Place', 'map.prec.region': 'approximate location (region)', 'map.prec.country': 'approximate location (country)', 'map.stages': 'stages {list}', 'map.range': '{a} to {b}',
  },
};

const WMO = {
  0: ['klar', 'clear', 'sun'], 1: ['überwiegend klar', 'mainly clear', 'sun'], 2: ['teils bewölkt', 'partly cloudy', 'part'],
  3: ['bedeckt', 'overcast', 'cloud'], 45: ['Nebel', 'fog', 'fog'], 48: ['Reifnebel', 'rime fog', 'fog'],
  51: ['leichter Niesel', 'light drizzle', 'drizzle'], 53: ['Niesel', 'drizzle', 'drizzle'], 55: ['dichter Niesel', 'dense drizzle', 'drizzle'],
  56: ['gefrierender Niesel', 'freezing drizzle', 'drizzle'], 57: ['gefrierender Niesel', 'freezing drizzle', 'drizzle'],
  61: ['leichter Regen', 'light rain', 'rain'], 63: ['Regen', 'rain', 'rain'], 65: ['starker Regen', 'heavy rain', 'rain'],
  66: ['gefrierender Regen', 'freezing rain', 'rain'], 67: ['gefrierender Regen', 'freezing rain', 'rain'],
  71: ['leichter Schneefall', 'light snow', 'snow'], 73: ['Schneefall', 'snow', 'snow'], 75: ['starker Schneefall', 'heavy snow', 'snow'],
  77: ['Schneegriesel', 'snow grains', 'snow'], 80: ['Regenschauer', 'rain showers', 'rain'], 81: ['Regenschauer', 'rain showers', 'rain'],
  82: ['heftige Regenschauer', 'violent rain showers', 'rain'], 85: ['Schneeschauer', 'snow showers', 'snow'], 86: ['Schneeschauer', 'snow showers', 'snow'],
  95: ['Gewitter', 'thunderstorm', 'storm'], 96: ['Gewitter mit Hagel', 'thunderstorm with hail', 'storm'], 99: ['Gewitter mit Hagel', 'thunderstorm with hail', 'storm'],
};

const nfCache = new Map();
function nfmt(lang, d) {
  const k = lang + d;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
  return nfCache.get(k);
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** h:mm:ss for seconds (no leading hour padding). */
export function hms(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0');
}

/** h:mm:ss, with a minus before the start. */
export const hmsS = (s) => (s <= -0.5 ? '−' + hms(-s) : hms(s));

/** Numbers never wrap away from their unit or "Ø" (no-break space). */
const UNIT_RX = /(\d)\s+(?=(?:°C|km\/h|km|mm|min|Hm|rpm|kJ|W|m|h|s|%)(?![\p{L}\d/]))/gu;
export const nb = (s) => String(s == null ? '' : s).replace(UNIT_RX, '$1 ').replace(/Ø\s+(?=\d)/g, 'Ø ');

/** Race window in data seconds (spec 4.4: data from t0 - 60 s to t1 + 60 s, restarted at 0). */
export function raceWindow(series) {
  const t = (series.data && series.data.t) || [], tMax = t.length ? t[t.length - 1] : 0;
  const w = series.window || {}, off = w.offset_s;
  let r0 = w.t0 != null && off != null ? w.t0 - off : 0, r1 = w.t1 != null && off != null ? w.t1 - off : tMax;
  if (!(r0 >= 0 && r0 < tMax)) r0 = 0;
  r1 = Math.min(tMax, r1 > r0 ? r1 : tMax);
  const sd = series.summary && series.summary.duration_s;
  return { r0, r1, tMax, dur: sd > 0 ? sd : r1 - r0 };
}

/** "YYYY-MM-DDTHH:MM:SS" local wall clock plus seconds, without time-zone conversion. */
export function localPlus(iso, seconds) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + Math.round(seconds || 0) * 1000);
  return d.toISOString().slice(0, 19);
}

export function wmo(code) { return WMO[code] || WMO[Math.floor((code || 0) / 10) * 10] || WMO[3]; }

/** Bind helpers to the page i18n (or the document language when none is passed). */
export function makeT(i18n) {
  const lang = () => {
    try { const l = i18n && typeof i18n.lang === 'function' ? i18n.lang() : null; if (l) return l === 'en' ? 'en' : 'de'; } catch (e) { /* fall through */ }
    return /^en/i.test(document.documentElement.lang || '') ? 'en' : 'de';
  };
  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k])) : s);
  // Own dictionary first (so the page i18n never logs "missing key" for WP7 strings);
  // the page i18n is asked only for keys this file does not know.
  const t = (key, vars) => {
    const L = lang();
    const s = (DICT[L] && DICT[L][key]) != null ? DICT[L][key] : DICT.de[key];
    if (s != null) return fill(s, vars);
    if (i18n && typeof i18n.t === 'function') {
      try { const r = i18n.t(key, vars); if (typeof r === 'string' && r) return r; } catch (e) { /* ignore */ }
    }
    return key;
  };
  const L = (obj) => {
    if (obj == null) return '';
    if (typeof obj === 'string') return obj;
    const l = lang();
    return obj[l] != null ? obj[l] : obj.de != null ? obj.de : '';
  };
  const nf = (v, d = 0) => (v == null || !isFinite(v) ? '–' : nfmt(lang(), d).format(v));
  const date = (iso, style = 'long') => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    const o = style === 'short' ? { day: 'numeric', month: 'short' } : style === 'weekday' ? { weekday: 'short', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' };
    return new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : 'de-DE', Object.assign({ timeZone: 'UTC' }, o)).format(d);
  };
  const clock = (iso) => (iso ? iso.slice(11, 16) : '');
  const dur = (s) => {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h >= 1) return lang() === 'en' ? `${h} h ${m} min` : `${h}:${String(m).padStart(2, '0')} h`;
    if (s >= 90) return `${Math.round(s / 60)} min`;
    return `${s} s`;
  };
  const country = (cc) => {
    try { return new Intl.DisplayNames([lang() === 'en' ? 'en-GB' : 'de-DE'], { type: 'region' }).of(cc); } catch (e) { return cc; }
  };
  const compass = (deg) => {
    const de = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'], en = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
    return (lang() === 'en' ? en : de)[i];
  };
  const coord = (v, pos, neg) => nf(Math.abs(v), 2) + '° ' + (v >= 0 ? pos : neg);
  const lat = (v) => coord(v, 'N', lang() === 'en' ? 'S' : 'S');
  const lon = (v) => coord(v, lang() === 'en' ? 'E' : 'O', 'W');
  // "A, B und C" / "A, B and C"
  const list = (a) => {
    try { return new Intl.ListFormat(lang() === 'en' ? 'en-GB' : 'de-DE', { type: 'conjunction' }).format(a); } catch (e) { return a.join(', '); }
  };
  return { lang, t, L, nf, date, clock, dur, hms, country, compass, lat, lon, list, wmo: (c) => { const w = wmo(c); return { text: lang() === 'en' ? w[1] : w[0], icon: w[2] }; } };
}

/** Observe html[lang] and html.class; returns an off() function. */
export function observeRoot(onLang, onTheme) {
  const root = document.documentElement;
  let lang = root.lang, dark = root.classList.contains('dark');
  const mo = new MutationObserver(() => {
    if (root.lang !== lang) { lang = root.lang; try { onLang && onLang(); } catch (e) { console.error(e); } }
    const d = root.classList.contains('dark');
    if (d !== dark) { dark = d; try { onTheme && onTheme(); } catch (e) { console.error(e); } }
  });
  mo.observe(root, { attributes: true, attributeFilter: ['lang', 'class'] });
  return () => mo.disconnect();
}

export function prefersReducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

/** Base URL of the radsport/ folder, resolved from this module (works from any page depth). */
export const RS_BASE = new URL('../../', import.meta.url);
