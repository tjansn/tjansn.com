/**
 * sections.js (WP6): pure render functions of the dossier (spec 1.5, 1.9, 3.8): (race, bib, ctx) -> HTML string.
 * head, meta, result, story, power, weather, photos, place, facts, sources, unassigned; plus
 * exhibit, body, foot, bar (the static fallbacks for the lazy parts are fallbacks.js, loaded only when a WP7 module
 * is missing or fails). Sections render only what exists and every
 * shown value carries its sources. Lazy parts (power, weather, place, photos) return a mount point.
 * Round 3 (Tom's decisions): no status of how a number was matched to its race (D23: no chips, reasons or field
 * marks, no source confidence, no date notes that explain a guessed date) and no purely descriptive text (D24: the
 * section on what is printed on the number, with its wall-photo note, is gone). Round 3 fixes: „Quellen“ lists only
 * the sources something on the sheet cites (the evidence of the retired identification went with it), and the
 * „Noch offen“ row is gone (the Datenlage dots say what exists).
 * ctx: { i18n, cites, mode, stage, photos, review, dl, nb, label(target), short(target), assetURL, getBib,
 *        getRace, getSource, power: { ref, stage, stages, asked, src }, weatherRef }
 */
import { esc, srcKind, isMe, cleared } from './status.js';

export { esc } from './status.js';
export { datenlage, dlHTML, createCites } from './status.js';

/** Dossier strings (DE primary, EN secondary); dossier.js registers them with the page i18n. */
export const STRINGS = {
  de: {
    'd.cite.one': 'Quelle', 'd.cite.many': 'Quellen', 'd.cite.to': 'bis', 'd.back': 'Zurück zum Text', 'd.skip': 'Zu den Quellen',
    'd.stageN': '{n}. Etappe',
    'd.card.none': 'Von diesem Rennen hängt keine Nummer an der Wand.',
    'd.credit': 'Foto: {c}', 'd.pending': 'nur lokal: Rechte offen',
    'd.also': 'Auch an der Wand:', 'd.nav': 'Weitere Rennen', 'd.meta.bib': 'Startnummer',
    'd.src.accessed': 'abgerufen am {date}', 'd.res.overall': 'Gesamt',
    'd.original': 'Original', 'd.translated': 'Übersetzung aus dem Deutschen', 'd.course': 'Strecke',
    'd.meta.field': 'Feld', 'd.fld.e': '{n} gemeldet', 'd.fld.s': '{n} am Start', 'd.fld.f': '{n} im Ziel',
    'd.power.stages': 'Etappen mit Leistungsdaten', 'd.power.none': 'Für diese Etappe gibt es keine Leistungsdatei.',
    'd.power.failed': 'Die Leistungsdatei ließ sich gerade nicht laden.',
    'd.power.static': 'Das Diagramm ist gerade nicht verfügbar. Die wichtigsten Werte:',
    'd.pw.dur': 'Dauer', 'd.pw.avg': 'Ø Leistung', 'd.pw.np': 'Normalisierte Leistung', 'd.pw.gain': 'Höhenmeter',
    'd.wx.day': '{min} bis {max} °C, Niederschlag {p} mm, Wind bis {w} km/h',
    'd.review': 'Prüfmodus: Fotos mit offenen Rechten sind nur hier lokal zu sehen.',
    'd.photos.days': 'Fotos von den Renntagen', 'd.photos.eve': 'Fotos vom Vortag', 'd.photos.around': 'Fotos rund um das Rennen',
    'd.switched': 'Jetzt: {title}', 'd.closeLabel': 'Dossier schließen',
    'd.soundLabel': 'Ton', 'd.ccLabel': 'UT, Untertitel', 'd.with': 'mit {name}', 'd.gap.st': 'zeitgleich',
    'd.pos.wall': 'Rennen {i}\u00a0von\u00a0{n} an der Wand', 'd.pos.list': '{i}\u00a0von\u00a0{n} Rennen',
    'd.cf.result': 'Ergebnis', 'd.cf.start': 'Start', 'd.cf.name': 'Name', 'd.cf.numbering': 'Zählung der Etappen',
    'd.cf.field': 'Feldgröße', 'd.cf.winnerTime': 'Zeit des Siegers', 'd.cf.stageCount': 'Zahl der Etappen',
    'd.cf.status': 'Teilnahme', 'd.cf.edition': 'Ausgabe', 'd.cf.year': 'Jahr', 'd.cf.crash': 'Datum des Sturzes',
    'd.cf.gcAfter': 'Gesamtwertung nach der {stage}', 'd.cf.gcPro': 'Gesamtwertung nach dem Prolog', 'd.results': 'Ergebnisliste',
  },
  en: {
    'd.cite.one': 'Source', 'd.cite.many': 'Sources', 'd.cite.to': 'to', 'd.back': 'Back to the text', 'd.skip': 'Skip to the sources',
    'd.stageN': 'Stage {n}',
    'd.card.none': 'No number from this race hangs on the wall.',
    'd.credit': 'Photo: {c}', 'd.pending': 'local only: rights pending',
    'd.also': 'Also on the wall:', 'd.nav': 'More races', 'd.meta.bib': 'Race number',
    'd.src.accessed': 'accessed {date}', 'd.res.overall': 'Overall',
    'd.original': 'original', 'd.translated': 'Translated from German', 'd.course': 'Course',
    'd.meta.field': 'Field', 'd.fld.e': '{n} entries', 'd.fld.s': '{n} starters', 'd.fld.f': '{n} finishers',
    'd.power.stages': 'Stages with power data', 'd.power.none': 'There is no power file for this stage.',
    'd.power.failed': 'The power file could not be loaded just now.',
    'd.power.static': 'The chart is not available just now. The key values:',
    'd.pw.dur': 'Duration', 'd.pw.avg': 'Avg power', 'd.pw.np': 'Normalised power', 'd.pw.gain': 'Climbing',
    'd.wx.day': '{min} to {max} °C, precipitation {p} mm, wind up to {w} km/h',
    'd.review': 'Review mode: photos with open rights show only here, locally.',
    'd.photos.days': 'Photos from the race days', 'd.photos.eve': 'Photos from the day before', 'd.photos.around': 'Photos around the race',
    'd.switched': 'Now: {title}', 'd.closeLabel': 'Close dossier',
    'd.soundLabel': 'Sound', 'd.ccLabel': 'CC, captions', 'd.with': 'with {name}', 'd.gap.st': 'same time',
    'd.pos.wall': 'Race {i}\u00a0of\u00a0{n} on the wall', 'd.pos.list': '{i}\u00a0of\u00a0{n} races',
    'd.cf.result': 'Result', 'd.cf.start': 'Start', 'd.cf.name': 'Name', 'd.cf.numbering': 'Stage numbering',
    'd.cf.field': 'Field size', 'd.cf.winnerTime': 'Winning time', 'd.cf.stageCount': 'Number of stages',
    'd.cf.status': 'Participation', 'd.cf.edition': 'Edition', 'd.cf.year': 'Year', 'd.cf.crash': 'Date of the crash',
    'd.cf.gcAfter': 'Overall after {stage}', 'd.cf.gcPro': 'Overall after the prologue', 'd.results': 'Results',
  },
};

const arr = (v) => (Array.isArray(v) ? v : []);
const has = (r) => Boolean(r && arr(r.src).length);
const D = (i) => ` data-deal style="--deal:${i}"`;
const Lx = (ctx, v) => (v == null ? '' : typeof v === 'object' ? ctx.i18n.L(v) : String(v));
const sec = (key, i, h, inner, cls = '', lazy = false) => `<section class="rs-d-sec${cls ? ` ${cls}` : ''}" data-sec="${key}"${lazy ? ' data-lazy' : ''}${D(i)}><h3 id="rs-d-h-${key}">${esc(h)}</h3>${inner}</section>`;
const quote = (ctx, s, lang) => ((lang || ctx.i18n.lang()) === 'de' ? `„${s}“` : `“${s}”`);

/** Text + chip: the chip never starts a line alone (glued to the last word). */
function tail(text, cites = '') {
  const s = String(text == null ? '' : text).replace(/\s+$/, '');
  if (!cites) return esc(s);
  const m = /(\S+)$/.exec(s);
  if (!m) return `${esc(s)}${cites}`;
  let glue = m[1];
  if (glue.length > 16) {
    const k = Math.max(glue.lastIndexOf('-'), glue.lastIndexOf('/'));
    glue = k >= 0 && k < glue.length - 1 && glue.length - k - 1 <= 16 ? glue.slice(k + 1) : glue.slice(-16);
  }
  return `${esc(s.slice(0, s.length - glue.length))}<span class="rs-nw">${esc(glue)}${cites}</span>`;
}

/** A line of sources alone starts with a word ("Quelle 3"), hidden from screen readers: the chip's name has it. */
function srcLine(ctx, ids, cls = 'rs-d-marks') {
  const n = ctx.cites.ref(ids).length;
  return n ? `<p class="${cls}"><span class="rs-mk" aria-hidden="true">${esc(ctx.i18n.t(n > 1 ? 'd.cite.many' : 'd.cite.one'))}</span>${ctx.cites.html(ids)}</p>` : '';
}

/** All countries of a race that crosses borders (race.countries), else its one country. */
export function countryCodes(race) {
  const list = arr(race && race.countries).filter(Boolean);
  if (list.length > 1) return list;
  return race && race.country ? [race.country] : [];
}
const countryText = (race, i18n) => countryCodes(race).map((c) => i18n.fmt.country(c)).join(', ');

function stageName(ctx, race, n) {
  const st = arr(race && race.stages).find((s) => Number(s.n) === Number(n));
  if (st && st.name) return Lx(ctx, st.name);
  return Number(n) === 0 ? ctx.i18n.t('d.prologue') : ctx.i18n.t('d.stageN', { n: (st && st.label) || n });
}

function cleanNumber(bib) {
  return bib && bib.number != null ? String(bib.number).replace(/\?+$/, '') : '';
}

/** Exhibit slot: the bib crop (hatch behind, hidden parts transparent), else the day's best photo, else a plate.
 *  (A bib with a drawing shows art/art.js's exhibit instead; this crop is its stand-in.) */
export function exhibit(race, bib, ctx) {
  const { i18n } = ctx; const t = i18n.t;
  if (bib && bib.crop && bib.crop.file) {
    const w = bib.crop.w || 600; const h = bib.crop.h || 600;
    // alt: the number (D24: no description of the paper and print), the figcaption says how it was made
    const alt = i18n.numberPhrase(bib);
    return {
      kind: 'bib', ar: w / h,
      html: `<span class="rs-d-card__hatch" aria-hidden="true"></span><img src="${esc(ctx.assetURL(bib.crop.file))}" width="${w}" height="${h}" alt="${esc(alt)}" decoding="async">`,
      caption: t('d.exhibit.caption'),
    };
  }
  const ph = arr(ctx.photos)[0];
  if (ph) {
    const ws = arr(ph.sizes).length ? ph.sizes : [480, 960, 1600].filter((x) => !ph.w || x <= ph.w);
    const src = (x) => ctx.assetURL(`${ph.file}-${x}.webp`);
    const pend = !cleared(ph);
    const cap = [Lx(ctx, ph.caption), ph.credit ? t('d.credit', { c: Lx(ctx, ph.credit) }) : ''].filter(Boolean).join(' · ');
    return {
      kind: 'photo', ar: ph.w && ph.h ? ph.w / ph.h : 1.5,
      html: `<img src="${esc(src(ws[Math.min(1, ws.length - 1)]))}" srcset="${esc(ws.map((x) => `${src(x)} ${x}w`).join(', '))}" sizes="(max-width: 759px) 55vw, 340px" alt="${esc(Lx(ctx, ph.alt))}" decoding="async">`
        + (pend ? `<span class="rs-d-card__badge">${esc(t('d.pending'))}</span>` : ''),
      caption: cap,
    };
  }
  const year = race ? race.year || i18n.fmt.year(race.date) : '';
  return {
    kind: 'plate', ar: 1.414,
    html: `<span class="rs-d-plate" aria-hidden="true"><span class="rs-d-plate__k">${esc(t('d.indexcard'))}</span><span class="rs-d-plate__y">${esc(year)}</span><span class="rs-d-plate__cc">${esc(countryCodes(race).join(' · '))}</span></span>`,
    caption: t('d.card.none'),
  };
}

/** Kicker, title, date and place line, other bibs of the race (D23: no status line, no status chips). */
export function head(race, bib, ctx) {
  const { i18n } = ctx; const t = i18n.t; const L = i18n.L;
  const kind = race && race.kind && i18n.has(`kind.${race.kind}`) ? t(`kind.${race.kind}`) : '';
  const cat = race && race.category ? Lx(ctx, race.category) : '';
  const flat = (x) => String(x).toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
  const kick = race ? [cat, race.ageClass, kind && !flat(cat).includes(flat(kind)) ? kind : ''].filter(Boolean).join(' · ') : '';
  const title = race ? L(race.name) : t('label.unassigned');
  const off = race && race.officialName ? Lx(ctx, race.officialName) : '';
  const when = race
    ? [i18n.raceDate(race, 'long'), L(race.place), countryText(race, i18n)].filter(Boolean).join(' · ')
    : i18n.numberPhrase(bib);
  let out = (kick ? `<p class="rs-d-kick"${D(0)}>${esc(kick)}</p>` : '')
    + `<h2 class="rs-d-title" id="rs-d-title" tabindex="-1"${D(0)}>${esc(title)}</h2>`
    + (off && off.toLowerCase() !== title.toLowerCase() ? `<p class="rs-d-official"${D(0)}>${esc(off)}</p>` : '')
    + `<p class="rs-d-when" id="rs-d-desc"${D(0)}>${esc(when)}</p>`;
  const others = race && bib ? arr(race.bibs).filter((b) => b !== bib.id).map((b) => ctx.getBib(b)).filter(Boolean) : [];
  if (others.length) {
    out += `<p class="rs-d-also"${D(1)}>${esc(t('d.also'))} ${others.map((b) => `<button type="button" class="rs-d-link" data-d-bib="${esc(b.id)}">${esc(i18n.numberShort(b))}</button>`).join(' ')}</p>`;
  }
  return out;
}

/** Meta strip: only what the head does not say already. D23: no field marks, no date line for a guessed date and no
 *  date note (race.dateNote says where a date comes from, i.e. why it is a guess). */
export function meta(race, bib, ctx) {
  if (!race) return '';
  const { i18n } = ctx; const t = i18n.t;
  const items = [];
  const add = (k, v, cites = '') => { if (v) items.push(`<div><dt>${esc(t(k))}</dt><dd>${tail(v, cites)}</dd></div>`); };
  if (race.distanceKm) add('d.meta.distance', i18n.fmt.km(race.distanceKm, race.distanceKm % 1 ? 1 : 0));
  if (race.team && race.team.name && has(race.team)) add('d.meta.team', race.team.name, ctx.cites.html(race.team.src));
  // the number the top bar and the drawing show (i18n numberText: the full number once it is known)
  const shown = bib ? (i18n.numberText ? i18n.numberText(bib) : cleanNumber(bib)) : '';
  const bn = race.bibNumber;
  // the race number of the result lists, when the sheet does not show it complete already
  if (bn && bn.number && has(bn) && String(bn.number) !== shown) add('d.meta.bib', String(bn.number), ctx.cites.html(bn.src));
  const f = race.field;
  if (f && has(f) && (f.entrants || f.starters || f.finishers)) {
    const n = (v) => i18n.fmt.num(v, 0);
    add('d.meta.field', [f.entrants ? t('d.fld.e', { n: n(f.entrants) }) : '', f.starters ? t('d.fld.s', { n: n(f.starters) }) : '', f.finishers ? t('d.fld.f', { n: n(f.finishers) }) : ''].filter(Boolean).join(' · '), ctx.cites.html(f.src));
  }
  return items.length ? `<dl class="rs-d-meta"${D(1)}>${items.join('')}</dl>` : '';
}

function stageTable(race, ctx) {
  const stages = arr(race.stages);
  if (!stages.length) return '';
  const { i18n } = ctx; const t = i18n.t;
  const srcs = [];
  const rows = stages.map((s) => {
    const r = has(s.result) ? s.result : null;
    if (r) srcs.push(...r.src);
    const cur = ctx.stage != null && Number(ctx.stage) === Number(s.n);
    const date = s.date ? i18n.fmt.date(s.date, 'short').replace(/\d{4}$/, '').trim() : '';
    const res = r ? i18n.resultShort(r) || (r.text ? Lx(ctx, r.text) : '') : '';
    return `<li${cur ? ' class="is-current" aria-current="true"' : ''}><span class="rs-d-stg__n">${esc(stageName(ctx, race, s.n))}</span>`
      + `<span class="rs-d-stg__d">${esc(date)}</span><span class="rs-d-stg__km">${s.distanceKm ? esc(i18n.fmt.km(s.distanceKm, s.distanceKm % 1 ? 1 : 0)) : ''}</span>`
      + `<span class="rs-d-stg__r">${esc(res)}</span><span class="rs-d-stg__g">${r && r.gap ? esc(String(r.gap).replace(/^\+?(?=\d)/, '+')) : ''}</span></li>`;
  }).join('');
  return `<div class="rs-d-stg"><p class="rs-d-stg__h">${tail(t('d.stages'), ctx.cites.html(srcs))}</p><ol>${rows}</ol></div>`;
}

/** Ergebnis: big placing with the photo-finish reveal, field size, gap or winner, its sources, stages, conflicts. */
export function result(race, bib, ctx) {
  if (!race) return '';
  const { i18n } = ctx; const t = i18n.t;
  const st = ctx.stage != null ? arr(race.stages).find((s) => Number(s.n) === Number(ctx.stage)) : null;
  const res = st && has(st.result) ? st.result : has(race.result) ? race.result : null;
  const table = stageTable(race, ctx);
  const conflicts = arr(race.conflicts).filter((c) => c && RESULTISH.test(String(c.field || '')));
  if (!res && !table) return '';
  let board = '';
  if (res) {
    const ty = res.type;
    const pos = (ty === 'place' || ty === 'gc') && res.pos ? res.pos : null;
    const big = pos ? i18n.fmt.ord(pos) : ['dnf', 'dns', 'dsq', 'finished'].includes(ty) ? t(`res.short.${ty}`) : '';
    const lab = st ? stageName(ctx, race, st.n) : ty === 'gc' ? t('d.gc') : '';
    const line = [];
    if (pos && res.of) line.push(t('res.of', { n: res.of }));
    if (['dnf', 'dns', 'dsq', 'started'].includes(ty)) line.push(t(`res.${ty}`));
    if (res.gap && pos !== 1) line.push(/^\+?\d/.test(String(res.gap)) ? t('d.gap', { gap: String(res.gap).replace(/^\+/, '') }) : /^s\.?\s?t\.?$/i.test(String(res.gap)) ? t('d.gap.st') : String(res.gap));
    if (res.time) line.push(String(res.time));
    const win = pos === 1;
    board = `<div class="rs-d-res__board${win ? ' is-win' : ''}${big ? '' : ' is-quiet'}" data-type="${esc(ty)}"${big ? ' data-d-reveal' : ''}>`
      + (lab ? `<p class="rs-d-res__lab">${esc(lab)}</p>` : '')
      + (big ? `<p class="rs-d-res__big"><span class="rs-d-res__num">${esc(big)}</span><i class="rs-d-res__slit" aria-hidden="true"></i></p>` : '')
      + (line.length ? `<p class="rs-d-res__line">${esc(line.join(' · '))}</p>` : '')
      + '</div>';
    const text = res.text ? Lx(ctx, res.text) : '';
    if (text && text !== big) board += `<p class="rs-d-res__text">${esc(text)}</p>`;
    board += srcLine(ctx, res.src);
    if (st && has(race.result)) board += `<p class="rs-d-res__all">${esc(t('d.res.overall'))}: ${tail(i18n.resultPhrase(race.result) || Lx(ctx, race.result.text), ctx.cites.html(race.result.src))}</p>`;
    if (!st && race.winner && race.winner.name && has(race.winner) && !win) {
      board += `<p class="rs-d-res__win">${esc(t('d.winner'))}: ${who(race.winner, ctx, ctx.cites.html(race.winner.src))}</p>`;
    }
  }
  return sec('result', 2, t('d.result'), board + table + conflicts.map((c) => conflictHTML(c, race, ctx)).join(''), 'rs-d-res');
}

const RESULTISH = /result|^stage/i;

/** A person (my own row reads "Ich" / "Me"); `cites` glued to the last piece. */
function who(p, ctx, cites = '') {
  const t = ctx.i18n.t;
  const bits = [];
  if (isMe(p)) {
    const partner = p.partner && (typeof p.partner === 'object' ? p.partner.name : p.partner);
    bits.push(['strong', 'rs-d-me', t('d.me')]);
    if (partner) bits.push(['span', 'rs-d-team', t('d.with', { name: partner })]);
    if (p.team) bits.push(['span', 'rs-d-team', p.team]);
  } else {
    bits.push(['span', 'rs-d-who', p.name]);
    if (p.team) bits.push(['span', 'rs-d-team', p.team]);
    if (p.cc) bits.push(['span', 'rs-d-cc', p.cc]);
  }
  return bits.map(([tag, cls, txt], i) => `<${tag} class="${cls}">${i === bits.length - 1 ? tail(txt, cites) : esc(txt)}</${tag}>`).join(' ');
}

// ------------------------------------------------------------------ conflicts
/** Words for the last segment of a conflict's field path. */
const CF_FIELD = {
  tom_result: 'd.cf.result', result: 'd.cf.result', km: 'd.meta.distance', distance_km: 'd.meta.distance',
  date: 'd.meta.date', dates: 'd.meta.date', from: 'd.cf.start', start_town: 'd.cf.start', name: 'd.cf.name',
  name_official: 'd.cf.name', numbering: 'd.cf.numbering', venue: 'd.meta.place', of: 'd.cf.field', field: 'd.cf.field',
  team: 'd.meta.team', category: 'd.meta.category', status: 'd.cf.status', edition: 'd.cf.edition', year: 'd.cf.year',
  podium: 'd.podium', winner: 'd.winner',
};
const CF_PLAIN = { 'crash date': 'd.cf.crash', 'number of stages': 'd.cf.stageCount', 'stage numbering': 'd.cf.numbering', 'winner time': 'd.cf.winnerTime' };

const isoOf = (s) => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(s)); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };

/** Stage of "stages[i].x" (notes count from 0 or 1): explicit label, else matching values, else the usual count. */
function conflictStage(c, race, i, field, paren) {
  const stages = arr(race.stages);
  const byN = (n) => stages.find((s) => String(s.n) === String(n));
  if (paren) {
    const hit = stages.find((s) => s.name && (typeof s.name === 'object' ? s.name.de : s.name) === paren);
    if (hit) return hit.n;
    if (/^prolog/i.test(paren) && byN(0)) return 0;
  }
  const cands = (byN(0) ? [i, i + 1] : [i + 1, i]).filter((n) => byN(n));
  if (cands.length < 2) return cands.length ? cands[0] : null;
  const vals = arr(c.values).map((v) => (v && v.v != null ? (typeof v.v === 'object' ? v.v.de || v.v.en || '' : String(v.v)) : ''));
  const nums = vals.map((s) => parseFloat(String(s).replace(',', '.'))).filter(Number.isFinite);
  const fits = (s) => {
    if (/result/.test(field)) return Boolean(s.result && s.result.pos != null && nums.includes(Number(s.result.pos)));
    if (/km|distance/.test(field)) return s.distanceKm != null && nums.some((x) => Math.abs(x - s.distanceKm) < 0.05);
    if (/date/.test(field)) return Boolean(s.date && vals.some((x) => isoOf(x) === s.date));
    if (/from/.test(field)) return Boolean(s.from && vals.some((x) => x.trim() === String(s.from)));
    return false;
  };
  const hits = cands.filter((n) => fits(byN(n)));
  return hits.length === 1 ? hits[0] : cands[0];
}

/** Subject of a conflict ("1. Etappe · Ergebnis", "Gesamtwertung nach der 2. Etappe"). */
function conflictSubject(c, race, ctx) {
  const { t } = ctx.i18n;
  const raw = String(c.field || '').trim();
  const pm = /\s*\(([^)]+)\)\s*$/.exec(raw);
  const paren = pm ? pm[1].trim() : '';
  const base = pm ? raw.slice(0, pm.index) : raw;
  const low = base.toLowerCase();
  if (CF_PLAIN[low]) return t(CF_PLAIN[low]);
  const segs = low.split('.');
  const last = segs[segs.length - 1].replace(/\[.*$/, '').trim();
  const word = CF_FIELD[last] ? t(CF_FIELD[last]) : '';
  const sm = /^stages\[([^\]]*)\]/.exec(low);
  if (sm) {
    const many = !/^\d+$/.test(sm[1]) || (low.match(/stages\[/g) || []).length > 1;
    const n = many ? null : conflictStage(c, race, Number(sm[1]), last, paren);
    if (/gc/.test(last)) {
      if (n == null) return t('d.gc');
      if (Number(n) === 0) return t('d.cf.gcPro');
      return t('d.cf.gcAfter', { stage: stageName(ctx, race, n).replace(/^Stage\b/, 'stage') });
    }
    const where = n != null ? stageName(ctx, race, n) : t('d.stages');
    return [where, word].filter(Boolean).join(' · ');
  }
  if (/gesamt/i.test(paren)) return [t('d.gc'), word].filter(Boolean).join(' · ');
  const pre = /^podium/.test(low) ? t('d.podium') : /^winner\./.test(low) ? t('d.winner') : /^bib\./.test(low) ? t('d.meta.bib') : '';
  return pre === word ? pre : [pre, word].filter(Boolean).join(' · ');
}

/** "Quellen widersprechen sich": subject, each value once with its sources, the note. */
function conflictHTML(c, race, ctx) {
  const groups = new Map();
  for (const v of arr(c.values)) {
    if (!v || v.v == null) continue;
    const key = Lx(ctx, v.v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...arr(v.src));
  }
  if (groups.size < 2) return '';
  const subject = race ? conflictSubject(c, race, ctx) : '';
  return `<div class="rs-d-conflict">${subject ? `<p class="rs-d-conflict__s">${esc(subject)}</p>` : ''}<p class="rs-d-conflict__h">${esc(ctx.i18n.t('d.conflict'))}</p>`
    + `<ul>${[...groups].map(([v, src]) => `<li>${tail(v, ctx.cites.html(src))}</li>`).join('')}</ul>`
    + (c.note ? `<p>${esc(Lx(ctx, c.note))}</p>` : '') + '</div>';
}

function notesOf(race) {
  const raw = [...arr(race.notes), ...(Array.isArray(race.story) ? race.story : race.story ? [race.story] : [])];
  const out = [];
  for (const n of raw) {
    if (!n) continue;
    const src = arr(n.src);
    if (!src.length && n.author !== 'tom') continue;
    const orig = n.lang || 'de';
    const words = n.kind !== 'notes' && !src.length;
    const lines = arr(n.lines).length ? n.lines : [n.text && typeof n.text === 'object' ? n.text : n];
    lines.forEach((l, i) => {
      if (l && (l.de || l.en)) out.push({ de: l.de || '', en: l.en || '', orig, stage: l.stage ?? n.stage ?? null, src: i === lines.length - 1 ? src : [], words });
    });
  }
  return out;
}

/** Aus meinen Notizen (D10): my own words, verbatim; English shows a marked translation and the original. */
export function story(race, bib, ctx) {
  if (!race) return '';
  const notes = notesOf(race);
  if (!notes.length) return '';
  const { i18n } = ctx; const t = i18n.t; const lang = i18n.lang();
  const items = notes.map((n) => {
    const orig = n[n.orig] || n.de || n.en;
    const shown = n[lang] || orig;
    const translated = lang !== n.orig && n[lang];
    const pre = n.stage != null ? `<span class="rs-d-quote__stage">${esc(stageName(ctx, race, n.stage))}</span>` : '';
    return `<li><blockquote class="rs-d-quote" lang="${translated ? lang : n.orig}"><p>${pre}${esc(quote(ctx, shown, translated ? lang : n.orig))}</p></blockquote>`
      + (translated ? `<p class="rs-d-quote__tr">${esc(t('d.translated'))} · ${esc(t('d.original'))}: <span lang="${esc(n.orig)}">${esc(quote(ctx, orig, n.orig))}</span></p>` : '')
      + srcLine(ctx, n.src, 'rs-d-marks rs-d-quote__src') + '</li>';
  }).join('');
  return sec('story', 4, t(notes.every((n) => n.words) ? 'd.story' : 'd.notes'), `<ul class="rs-d-notes">${items}</ul>`, 'rs-d-notesec');
}

/** Leistungsdaten: stage choice (stages with a power file) and the chart mount point. */
export function power(race, bib, ctx) {
  const p = ctx.power;
  if (!race || !p) return '';
  const { i18n } = ctx; const t = i18n.t;
  const chips = p.stages.length > 1 || (p.asked != null && !p.ref)
    ? `<div class="rs-d-chips" role="group" aria-label="${esc(t('d.power.stages'))}">${p.stages.map((n) => `<button type="button" class="rs-d-chip" data-d-stage="${n}" aria-pressed="${Number(n) === Number(p.stage)}">${esc(stageName(ctx, race, n))}</button>`).join('')}</div>`
    : p.stage != null ? `<p class="rs-d-note">${esc(stageName(ctx, race, p.stage))}</p>` : '';
  const none = p.ref ? '' : `<p class="rs-d-note">${esc(t('d.power.none'))}</p>`;
  return sec('power', 5, t('d.power'), chips + none + (p.ref ? '<div class="rs-d-mount" data-mount="power"></div>' : '') + srcLine(ctx, p.src), 'rs-d-power', true);
}

/** Ergebnisliste (D18, round 2): mount point for results/results.js. Its source ids are numbered here, before
 * „Quellen“ renders, so every classification's chips find their entry. */
export function resultsList(race, bib, ctx) {
  const cl = arr(race && race.results && race.results.classifications).filter((c) => c && arr(c.rows).length);
  if (!cl.length) return '';
  ctx.cites.ref(cl.flatMap((c) => arr(c.src).filter((x) => typeof x === 'string')));
  return sec('results', 5, ctx.i18n.t('d.results'), '<div class="rs-d-mount" data-mount="results"></div>', 'rs-d-rlsec', true);
}

export function weather(race, bib, ctx) {
  if (!race || !ctx.weatherRef) return '';
  return sec('weather', 6, ctx.i18n.t('d.weather'), '<div class="rs-d-mount" data-mount="weather"></div>', 'rs-d-wx', true);
}

export function place(race, bib, ctx) {
  const g = race && race.geo;
  if (!g || g.lat == null || g.lon == null) return '';
  // the map also marks the stage towns (dossier.js: stages[].geo): their positions are sourced as well
  const st = arr(race.stages).filter((s) => s && s.geo && s.geo.lat != null).flatMap((s) => arr(s.geo.src));
  return sec('place', 7, ctx.i18n.t('d.place'), '<div class="rs-d-mount" data-mount="place"></div>' + srcLine(ctx, [...arr(g.src), ...st]), 'rs-d-place', true);
}

// ------------------------------------------------------------------ photos
const dayOf = (p) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String((p && (p.date || p.id)) || ''))
    || /(\d{4}-\d{2}-\d{2})/.exec(arr(p && p.src).join(' '));
  return m ? m[1] : null;
};
const dayBefore = (iso) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/** Photos heading by their dates: race day(s), the day before, or around the race. */
export function photosTitle(race, list, t) {
  const start = race && race.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || ''))) return t('d.photos');
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(race.endDate || '')) ? race.endDate : start;
  const days = arr(list).map(dayOf).filter(Boolean);
  if (!days.length) return t('d.photos');
  const on = days.filter((d) => d >= start && d <= end);
  if (on.length === days.length) return new Set(on).size > 1 ? t('d.photos.days') : t('d.photos');
  if (days.every((d) => d === dayBefore(start))) return t('d.photos.eve');
  return t('d.photos.around');
}

export function photos(race, bib, ctx) {
  const list = arr(ctx.photos);
  if (!race || !list.length) return '';
  const pend = list.some((p) => !cleared(p));
  const src = []; for (const p of list) src.push(...arr(p.src));
  return sec('photos', 8, photosTitle(race, list, ctx.i18n.t), (pend ? `<p class="rs-d-note rs-d-note--review">${esc(ctx.i18n.t('d.review'))}</p>` : '')
    + '<div class="rs-d-mount" data-mount="photos"></div>' + srcLine(ctx, src), 'rs-d-photos', true);
}

/** Aus dem Rennen: people left; course, facts, conflicts right (a reading measure). */
export function facts(race, bib, ctx) {
  if (!race) return '';
  const { i18n } = ctx; const t = i18n.t;
  const people = [];
  const text = [];
  const podium = arr(race.podium).filter((p) => p && p.name && has(p)).sort((a, b) => (a.pos || 9) - (b.pos || 9));
  if (podium.length) {
    people.push(`<div class="rs-d-fact"><p class="rs-d-fact__k">${esc(t('d.podium'))}</p><ol class="rs-d-podium">${podium.map((p) => `<li${isMe(p) ? ' class="is-me"' : ''}><span class="rs-d-podium__n">${esc(i18n.fmt.ord(p.pos))}</span> <span class="rs-d-podium__p">${who(p, ctx, ctx.cites.html(p.src))}</span></li>`).join('')}</ol></div>`);
  } else if (race.winner && race.winner.name && has(race.winner) && isMe(race.winner)) {
    people.push(`<p class="rs-d-fact"><span class="rs-d-fact__k">${esc(t('d.winner'))}</span> ${who(race.winner, ctx, ctx.cites.html(race.winner.src))}</p>`);
  }
  const notable = arr(race.notable).filter((n) => n && n.name && has(n));
  if (notable.length) {
    people.push(`<div class="rs-d-fact"><p class="rs-d-fact__k">${esc(t('d.notable'))}</p><ul class="rs-d-list">${notable.map((n) => {
      const cites = ctx.cites.html(n.src);
      return `<li>${who(n, ctx, n.note ? '' : cites)}${n.note ? `: ${tail(Lx(ctx, n.note), cites)}` : ''}</li>`;
    }).join('')}</ul></div>`);
  }
  if (race.course && has(race.course)) text.push(`<p class="rs-d-fact"><span class="rs-d-fact__k">${esc(t('d.course'))}</span> ${tail(Lx(ctx, race.course), ctx.cites.html(race.course.src))}</p>`);
  const fx = arr(race.facts).filter((x) => x && x.text && has(x));
  if (fx.length) {
    text.push(`<ul class="rs-d-list rs-d-facts">${fx.map((x) => `<li><span class="rs-d-prose">${tail(Lx(ctx, x.text), ctx.cites.html(x.src))}</span></li>`).join('')}</ul>`);
  }
  const other = arr(race.conflicts).filter((c) => c && !RESULTISH.test(String(c.field || ''))).map((c) => conflictHTML(c, race, ctx)).join('');
  if (other) text.push(other);
  if (!people.length && !text.length) return '';
  const inner = people.length && text.length
    ? `<div class="rs-d-factL">${people.join('')}</div><div class="rs-d-factR">${text.join('')}</div>`
    : `<div class="rs-d-factR">${people.join('')}${text.join('')}</div>`;
  return sec('facts', 9, t('d.facts'), inner, `rs-d-factsec${people.length && text.length ? ' is-pair' : ''}`);
}

/** Quellen: every cited source, numbered in order of first use; links only where public. Only what the sheet cites
 *  (round 3): the dossier file's sourceIds also hold the evidence of the retired identification (D23), e.g. the wall
 *  photo, sponsor registers and start lists, which support nothing that renders. */
export function sources(race, bib, ctx) {
  const ids = ctx.cites.list();
  if (!ids.length) return '';
  const { i18n } = ctx; const t = i18n.t;
  const items = ids.map((id, i) => {
    const s = ctx.getSource(id) || {};
    const label = esc(i18n.L(s.label) || id);
    const url = s.public && typeof s.url === 'string' && /^https?:\/\//.test(s.url) ? s.url : '';
    const bits = [t(`d.src.${srcKind(s.kind)}`)];
    if (url && s.accessed) bits.push(t('d.src.accessed', { date: i18n.fmt.date(s.accessed, 'short') }));
    return `<li id="rs-d-src-${i + 1}" tabindex="-1"><span class="rs-d-src__n">${i + 1}</span><span class="rs-d-src__b">`
      + (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span>${label}</span>`)
      + `<span class="rs-d-src__k">${esc(bits.join(' · '))}</span></span></li>`;
  }).join('');
  return sec('sources', 10, t('d.sources'), `<ol class="rs-d-src">${items}</ol>`, 'rs-d-srcsec');
}

/** A bib without a race (every wall bib has one since round 2, D22; kept so such a bib still opens): only the
 *  invitation (D6). D23/D24: no description of the number, no leads or reasons. */
export function unassigned(race, bib, ctx) {
  if (race || !bib) return '';
  return ask(bib, ctx.i18n.t, 2);
}

/** D6: „Weißt du, welches Rennen das war? Schreib mir.“ */
function ask(bib, t, d) {
  const n = cleanNumber(bib);
  return `<p class="rs-d-ask"${D(d)}><a class="plausible-event-name=E-Mail+Kontakt" href="mailto:tom@jansn.de?subject=${encodeURIComponent(n ? `Startnummer ${n}` : 'Startnummer')}">${esc(t('d.ask'))}</a></p>`;
}

/** Body in layout order: left column (result, story), right column (power), the results list (round 2),
 * weather + place, photos, facts, sources (last, so every citation is numbered). */
export function body(race, bib, ctx) {
  if (!race) {
    const u = unassigned(race, bib, ctx);
    return `<div class="rs-d-cols"><div class="rs-d-colL">${u}</div></div>${sources(race, bib, ctx)}`;
  }
  const left = result(race, bib, ctx) + story(race, bib, ctx);
  const rl = resultsList(race, bib, ctx);
  const pw = power(race, bib, ctx);
  const wx = weather(race, bib, ctx);
  const pl = place(race, bib, ctx);
  const ph = photos(race, bib, ctx);
  const fx = facts(race, bib, ctx);
  const src = sources(race, bib, ctx);
  return `<div class="rs-d-cols${pw ? ' has-power' : ''}">${left ? `<div class="rs-d-colL">${left}</div>` : ''}${pw ? `<div class="rs-d-colR">${pw}</div>` : ''}</div>`
    + rl
    + (wx || pl ? `<div class="rs-d-row2${wx && pl ? ' is-pair' : ''}">${wx}${pl}</div>` : '')
    + ph + fx + src;
}

/** Footer navigation: previous and next race, keyboard hint (arrows outside the names). */
export function foot(race, bib, ctx) {
  const { i18n } = ctx; const t = i18n.t; const nb = ctx.nb;
  const item = (dir) => {
    const tg = nb[dir];
    if (!tg) return `<span class="rs-d-foot__${dir}"></span>`;
    const k = dir === 'prev' ? `<span aria-hidden="true">‹ </span>${esc(t('d.prev'))}` : `${esc(t('d.next'))}<span aria-hidden="true"> ›</span>`;
    return `<button type="button" class="rs-d-foot__${dir}" data-d-act="${dir}"><span class="rs-d-foot__k">${k}</span><span class="rs-d-foot__t">${esc(ctx.label(tg))}</span></button>`;
  };
  return `<nav class="rs-d-foot__in" aria-label="${esc(t('d.nav'))}"${D(12)}>${item('prev')}<p class="rs-d-foot__keys">${esc(t('d.keys'))}</p>${item('next')}</nav>`;
}

/** Phone bottom bar: ‹ Nr. 254 · 3 von 33 an der Wand · Nr. 53 › */
export function bar(race, bib, ctx) {
  const { i18n } = ctx; const t = i18n.t; const nb = ctx.nb;
  const btn = (dir) => {
    const tg = nb[dir];
    const arrow = dir === 'prev' ? '<span aria-hidden="true">‹</span>' : '<span aria-hidden="true">›</span>';
    const lab = tg ? ctx.short(tg) : '';
    return `<button type="button" class="rs-d-bar__${dir}" data-d-act="${dir}" aria-label="${esc(tg ? t(`d.${dir}To`, { name: ctx.label(tg) }) : t(`d.${dir}`))}"${tg ? '' : ' disabled'}>${dir === 'prev' ? arrow : ''}<span class="rs-d-bar__t">${esc(lab)}</span>${dir === 'next' ? arrow : ''}</button>`;
  };
  const pos = nb.index >= 0 ? t(nb.list === 'list' ? 'd.pos.list' : 'd.pos.wall', { i: nb.index + 1, n: nb.total }) : '';
  return `${btn('prev')}<span class="rs-d-bar__pos">${esc(pos)}</span>${btn('next')}`;
}
