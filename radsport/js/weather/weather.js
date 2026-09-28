/* radsport/js/weather/weather.js (WP7): hourly weather board (FINAL_SPEC 1.5, 3.10, 4.5), a real <table>:
 * hours as columns (local time); temperature, precipitation, sky (icon + words) and wind (arrow to where it
 * blows) as rows; race hours highlighted; setTime() marks the replay hour and updates the "now" line. Credit:
 * model values, no measurement; with one point per stage town (days[].at) each day names its town.
 * createWeatherBoard(el, weather, { i18n, measured: { tempC, device } }) -> { setTime(localIso|null, meta), relabel(), destroy() }
 */
import { makeT, esc, nb, observeRoot, prefersReducedMotion } from '../charts/strings.js';

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  part: '<path d="M8.5 4.5v1.6M3.9 9.1h1.6M5.3 5.9l1.1 1.1"/><path d="M11.4 8.6a3.6 3.6 0 0 0-5.6 3"/><path d="M8 19h9.5a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.3A2.9 2.9 0 0 0 8 19z"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .3-8 6 6 0 0 0-11.5 1.8A3.2 3.2 0 0 0 7 18.5z"/>',
  fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
  drizzle: '<path d="M7 14.5h10.5a3.6 3.6 0 0 0 .3-7.2 5.4 5.4 0 0 0-10.4 1.6A2.9 2.9 0 0 0 7 14.5z"/><path d="M9 17.5v1M13 17.5v1M17 17.5v1"/>',
  rain: '<path d="M7 13.5h10.5a3.6 3.6 0 0 0 .3-7.2 5.4 5.4 0 0 0-10.4 1.6A2.9 2.9 0 0 0 7 13.5z"/><path d="M8.5 16.5l-1 3M12.5 16.5l-1 3M16.5 16.5l-1 3"/>',
  snow: '<path d="M7 13.5h10.5a3.6 3.6 0 0 0 .3-7.2 5.4 5.4 0 0 0-10.4 1.6A2.9 2.9 0 0 0 7 13.5z"/><path d="M9 18h.01M12 20h.01M15 18h.01"/>',
  storm: '<path d="M7 13.5h10.5a3.6 3.6 0 0 0 .3-7.2 5.4 5.4 0 0 0-10.4 1.6A2.9 2.9 0 0 0 7 13.5z"/><path d="M12.5 14.5l-2 3.5h3l-2 3.5"/>',
};
const icon = (k) => `<svg class="rs-wx__icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ICONS.cloud}</svg>`;
const ARROW = '<svg class="rs-wx__arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l3.5 9L8 9.6l-3.5 1.9z"/></svg>';

export function createWeatherBoard(el, weather, opts = {}) {
  const T = makeT(opts.i18n);
  const reduced = prefersReducedMotion();
  const measured = opts.measured || null;
  let nowKey = null, nowIsReplay = false;

  // columns: per day from 2 h before to 2 h after the race hours (min 8 columns)
  const cols = [];
  const days = (weather && weather.days) || [];
  days.forEach((d, di) => {
    const rh = d.raceHours && d.raceHours.length === 2 ? d.raceHours.map((x) => parseInt(x, 10)) : [10, 18];
    let a = Math.max(0, rh[0] - 2), b = Math.min(23, rh[1] + 2);
    if (days.length > 1 && di < days.length - 1 && rh[1] >= 22) b = 23;
    if (days.length > 1 && di > 0 && rh[0] <= 1) a = 0;
    while (b - a + 1 < 8) { if (a > 0) a--; if (b - a + 1 < 8 && b < 23) b++; if (a === 0 && b === 23) break; }
    const byHour = new Map((d.hours || []).map((h) => [parseInt(h.t.slice(11, 13), 10), h]));
    for (let h = a; h <= b; h++) {
      const x = byHour.get(h);
      if (!x) continue;
      cols.push(Object.assign({ key: x.t.slice(0, 13), hour: h, date: d.date, di, race: h >= rh[0] && h <= rh[1], dayStart: h === a }, x));
    }
  });
  // one weather point per day (stage towns) or one for the whole race?
  const locOf = (d) => (d.at && d.at.lat != null ? `${(+d.at.lat).toFixed(2)},${(+d.at.lon).toFixed(2)}` : '');
  const multi = days.length > 1 && new Set(days.map(locOf)).size > 1;
  const placeOf = (d) => (multi && d.at && d.at.place) || '';
  const dayLab = (d) => T.date(d.date, 'weekday') + (placeOf(d) ? `, ${placeOf(d)}` : '');
  const temps = cols.map((c) => c.temp).filter((v) => v != null);
  const tMin = Math.min(...temps), tMax = Math.max(...temps), tSpan = Math.max(4, tMax - tMin);
  const pMax = Math.max(2, ...cols.map((c) => c.precip || 0));

  const root = document.createElement('div');
  root.className = 'rs-wx';
  el.innerHTML = '';
  el.appendChild(root);

  const calm = (c) => c.wind == null || c.dir == null || Math.round(c.wind) < 1;
  const fromTxt = (c) => (calm(c) ? T.t('wx.calm') : T.t('wx.windFrom', { dir: T.compass(c.dir) }));
  function cellClass(c) { return (c.race ? ' is-race' : '') + (c.key === nowKey ? ' is-now' : '') + (c.dayStart && c.di > 0 ? ' is-daystart' : ''); }

  function render() {
    if (!cols.length) { root.innerHTML = ''; return; }
    const L = T.lang();
    const hourLab = (c) => (L === 'en' ? String(c.hour).padStart(2, '0') : String(c.hour));
    // day header cells
    const dayCells = [];
    days.forEach((d, di) => {
      const span = cols.filter((c) => c.di === di).length;
      if (span) dayCells.push(`<th scope="colgroup" colspan="${span}" class="rs-wx__daylab"><span class="rs-wx__stick">${esc(dayLab(d))}</span></th>`);
    });
    const raceCells = [];
    let k = 0;
    while (k < cols.length) {
      let j = k; while (j + 1 < cols.length && cols[j + 1].race === cols[k].race && cols[j + 1].di === cols[k].di) j++;
      raceCells.push(cols[k].race ? `<td colspan="${j - k + 1}" class="rs-wx__band"><span class="rs-wx__stick">${esc(T.t('wx.race'))}</span></td>` : `<td colspan="${j - k + 1}"></td>`);
      k = j + 1;
    }
    const head = `<thead><tr class="rs-wx__days"><th scope="row" class="rs-wx__rh"><span class="rs-sr">${esc(T.t('wx.hour'))}</span></th>${dayCells.join('')}</tr>` +
      `<tr class="rs-wx__bandrow" aria-hidden="true"><td class="rs-wx__rh"></td>${raceCells.join('')}</tr>` +
      `<tr class="rs-wx__hours"><th scope="row" class="rs-wx__rh">${esc(T.t('wx.hour'))}</th>` +
      cols.map((c, i) => `<th scope="col" data-col="${i}" class="rs-wx__h${cellClass(c)}"><span class="rs-sr">${esc(T.date(c.date, 'short'))}, </span>${hourLab(c)}${L === 'en' ? ':00' : '<span class="rs-wx__u"> h</span>'}</th>`).join('') + `</tr></thead>`;
    const tempRow = `<tr class="rs-wx__temp"><th scope="row" class="rs-wx__rh">${esc(T.t('wx.temp'))} <span class="rs-wx__u">${esc(T.t('wx.tempU'))}</span></th>` +
      cols.map((c, i) => `<td data-col="${i}" class="${cellClass(c).trim()}"><span class="rs-wx__dot" style="--y:${c.temp == null ? 0 : ((c.temp - tMin) / tSpan).toFixed(3)}"></span><span class="rs-wx__num">${T.nf(c.temp, 0)}°</span></td>`).join('') + `</tr>`;
    const precipRow = `<tr class="rs-wx__precip"><th scope="row" class="rs-wx__rh">${esc(T.t('wx.precip'))} <span class="rs-wx__u">${esc(T.t('wx.precipU'))}</span></th>` +
      cols.map((c, i) => `<td data-col="${i}" class="${cellClass(c).trim()}"><span class="rs-wx__bar" style="--h:${Math.min(1, (c.precip || 0) / pMax).toFixed(3)}"></span><span class="rs-wx__num">${c.precip ? T.nf(c.precip, 1) : '<span class="rs-wx__zero">0</span>'}</span></td>`).join('') + `</tr>`;
    const skyRow = `<tr class="rs-wx__sky"><th scope="row" class="rs-wx__rh">${esc(T.t('wx.sky'))}</th>` +
      cols.map((c, i) => {
        const w = T.wmo(c.code);
        const night = c.hour < 6 || c.hour >= 21;
        const ic = night && (w.icon === 'sun') ? 'moon' : w.icon;
        return `<td data-col="${i}" class="${cellClass(c).trim()}">${icon(ic)}<span class="rs-sr">${esc(w.text)}, ${esc(T.t('wx.cloud', { c: T.nf(c.cloud) }))}</span></td>`;
      }).join('') + `</tr>`;
    const windRow = `<tr class="rs-wx__wind"><th scope="row" class="rs-wx__rh">${esc(T.t('wx.wind'))} <span class="rs-wx__u">${esc(T.t('wx.windU'))}</span></th>` +
      cols.map((c, i) => `<td data-col="${i}" class="${cellClass(c).trim()}"><span class="rs-wx__dir${calm(c) ? ' is-calm' : ''}" style="--dir:${((c.dir || 0) + 180) % 360}deg">${ARROW}</span><span class="rs-wx__num">${T.nf(c.wind, 0)}</span>` +
        `<span class="rs-sr">${esc(fromTxt(c))}, ${esc(T.t('wx.gust', { g: T.nf(c.gust, 0) }))} km/h</span></td>`).join('') + `</tr>`;
    // summaries
    const lines = days.map((d) => {
      const s = d.summary || {};
      return nb(T.t('wx.day', { date: dayLab(d), min: T.nf(s.tempMin, 0), max: T.nf(s.tempMax, 0), p: T.nf(s.precipSum, 1), w: T.nf(s.windMax, 0) }));
    });
    const g = (weather && weather.grid) || {};
    const credit = weather && weather.source && weather.source.credit ? String(T.L(weather.source.credit)).replace(/[.\s]+$/, '') : '';   // joined with '. ' below
    // weather.grid is the first day's point only: with a point per stage town, name the towns
    const towns = [...new Set(days.map((d) => d.at && d.at.place).filter(Boolean))].join(', ');
    const model = multi ? T.t('wx.modelAt', { list: towns }).replace(' ()', '')
      : g.lat != null ? T.t('wx.model', { lat: T.lat(g.lat), lon: T.lon(g.lon), elev: g.elev_m != null ? `, ${T.nf(g.elev_m)} m` : '' }) : '';
    const meas = measured && measured.tempC != null ? T.t('wx.measured', { device: measured.device || (T.lang() === 'en' ? 'bike computer' : 'Radcomputer'), t: T.nf(measured.tempC, 1) }) : '';
    // "Rennen 13:00 bis 18:00 Uhr" only when every day has the same hours
    const rhs = days.filter((d) => d.raceHours && d.raceHours.length === 2).map((d) => d.raceHours);
    const raceHrs = !rhs.length ? '' : new Set(rhs.map((r) => r.join())).size === 1 ? T.t('wx.raceHours', { a: rhs[0][0], b: rhs[0][1] }) : T.t('wx.raceHoursDay');
    root.innerHTML =
      `<p class="rs-wx__now" aria-live="off"></p>` +
      `<div class="rs-wx__scroll" tabindex="0" role="region" aria-label="${esc(T.t('wx.scroll'))}">` +
      `<table class="rs-wx__board"><caption class="rs-sr">${esc([T.t('wx.title'), raceHrs, T.t('wx.arrow')].filter(Boolean).map((x) => x.replace(/[.\s]+$/, '') + '.').join(' '))}</caption>${head}<tbody>${tempRow}${precipRow}${skyRow}${windRow}</tbody></table></div>` +
      `<p class="rs-wx__sum">${lines.map(esc).join('<br>')}${meas ? '<br>' + esc(nb(meas)) : ''}</p>` +
      `<p class="rs-wx__src">${esc(credit)}${credit ? '. ' : ''}${esc(nb(model))}</p>`;
    renderNow();
  }

  function colFor(key) { return key ? cols.find((c) => c.key === key) : null; }
  function renderNow() {
    const p = root.querySelector('.rs-wx__now');
    if (!p) return;
    const c = colFor(nowKey) || cols.find((x) => x.race) || cols[0];
    if (!c) { p.textContent = ''; return; }
    const w = T.wmo(c.code);
    const night = c.hour < 6 || c.hour >= 21;
    const clock = `${String(c.hour).padStart(2, '0')}:00`;
    const time = T.t(nowIsReplay && nowKey ? 'wx.nowReplay' : 'wx.now', { clock });
    const wind = `${T.t('wx.wind')} ${calm(c) ? T.t('wx.calm') : `${fromTxt(c)} ${T.nf(c.wind, 0)} km/h`}, ${T.t('wx.gust', { g: T.nf(c.gust, 0) })} km/h`;
    p.innerHTML = `${icon(night && w.icon === 'sun' ? 'moon' : w.icon)}<b class="rs-wx__nowtemp">${T.nf(c.temp, 1)}\u00a0°C</b>` +
      `<span>${esc(w.text)}</span><span>${esc(nb(wind))}</span>` +
      `<span>${esc(nb(`${T.t('wx.precip')} ${T.nf(c.precip || 0, 1)} mm`))}</span><span>${esc(nb(T.t('wx.cloud', { c: T.nf(c.cloud) })))}</span><span class="rs-wx__nowtime">${esc(time)}</span>`;
  }

  function setTime(localIso, meta) {
    const key = localIso ? localIso.slice(0, 13) : null;
    nowIsReplay = !!(meta && meta.replay);
    if (key === nowKey) return;
    nowKey = colFor(key) ? key : null;
    root.querySelectorAll('.is-now').forEach((n) => n.classList.remove('is-now'));
    if (nowKey) {
      const idx = cols.findIndex((c) => c.key === nowKey);
      root.querySelectorAll(`[data-col="${idx}"]`).forEach((n) => n.classList.add('is-now'));
      const sc = root.querySelector('.rs-wx__scroll'), th = root.querySelector(`th[data-col="${idx}"]`);
      if (sc && th) {
        const rh = root.querySelector('.rs-wx__rh');
        const pad = rh ? rh.offsetWidth : 0;
        const left = th.offsetLeft, right = left + th.offsetWidth;
        if (left - pad < sc.scrollLeft || right > sc.scrollLeft + sc.clientWidth) {
          const to = Math.max(0, left - pad - (sc.clientWidth - pad) / 2 + th.offsetWidth / 2);
          try { sc.scrollTo({ left: to, behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { sc.scrollLeft = to; }
        }
      }
    }
    renderNow();
  }

  render();
  const offRoot = observeRoot(() => render(), null);
  return {
    setTime, relabel: render,
    destroy() { offRoot(); root.remove(); },
  };
}
