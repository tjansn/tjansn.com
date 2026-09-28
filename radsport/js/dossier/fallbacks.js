/**
 * fallbacks.js (WP6, moved out of sections.js in round 2): static stand-ins for the lazy parts of the dossier
 * (power chart, weather board, locator, photo prints) when a WP7 module is missing or fails. dossier.js loads this
 * only then, so it costs nothing at interactive. (series | weather | race | photos, ctx) -> HTML string.
 */
import { esc } from './status.js';
import { countryCodes } from './sections.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const Lx = (ctx, v) => (v == null ? '' : typeof v === 'object' ? ctx.i18n.L(v) : String(v));
const countryText = (race, i18n) => countryCodes(race).map((c) => i18n.fmt.country(c)).join(', ');

export function powerStatic(series, ctx) {
  const { i18n } = ctx; const f = i18n.fmt; const s = series.summary || {}; const b = series.bests || {};
  const kv = [
    [i18n.t('d.meta.distance'), s.distance_km != null ? f.km(s.distance_km, 1) : ''],
    [i18n.t('d.pw.dur'), s.duration_s != null ? f.dur(s.duration_s) : ''],
    [i18n.t('d.pw.avg'), s.avg_w != null ? f.w(s.avg_w) : ''],
    [i18n.t('d.pw.np'), s.np_w != null ? f.w(s.np_w) : ''],
    [i18n.t('d.pw.gain'), s.elev_gain_m != null ? `${f.num(s.elev_gain_m)} m` : ''],
  ].filter((x) => x[1]);
  const bests = ['5s', '1m', '5m', '20m', '60m'].filter((k) => b[k] && b[k].w).map((k) => `<div><dt>${esc(k.replace('m', ' min').replace('s', ' s'))}</dt><dd>${esc(f.w(b[k].w))}</dd></div>`).join('');
  return `<p class="rs-d-note">${esc(i18n.t('d.power.static'))}</p><dl class="rs-d-kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
    + (bests ? `<p class="rs-d-note">${esc(i18n.t('d.bests'))}</p><dl class="rs-d-kv">${bests}</dl>` : '');
}

export function weatherStatic(w, ctx) {
  const { i18n } = ctx; const f = i18n.fmt;
  const days = arr(w && w.days).filter((d) => d && d.summary);
  if (!days.length) return '';
  const rows = days.map((d) => `<li>${esc(f.date(d.date, 'long'))}: ${esc(i18n.t('d.wx.day', { min: f.num(d.summary.tempMin, 0), max: f.num(d.summary.tempMax, 0), p: f.num(d.summary.precipSum, 1), w: f.num(d.summary.windMax, 0) }))}</li>`).join('');
  const credit = w.source && w.source.credit ? `<p class="rs-d-note">${esc(i18n.L(w.source.credit))}</p>` : '';
  return `<ul class="rs-d-list">${rows}</ul>${credit}`;
}

export function placeStatic(race, ctx) {
  return `<p class="rs-d-prose">${esc([ctx.i18n.L(race.place), countryText(race, ctx.i18n)].filter(Boolean).join(', '))}</p>`;
}

export function photosStatic(list, ctx) {
  return `<ul class="rs-d-phs" aria-labelledby="rs-d-h-photos">${arr(list).map((p) => `<li><img src="${esc(ctx.assetURL(`${p.file}-480.webp`))}" alt="${esc(Lx(ctx, p.alt))}" loading="lazy" decoding="async"><span>${esc(Lx(ctx, p.caption))}</span></li>`).join('')}</ul>`;
}
