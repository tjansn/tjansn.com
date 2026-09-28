/**
 * career/career.js: season rail (HUD), season card, the "Saisons." strip and the race list (spec 1.7, 1.10, 3.10).
 *
 *   createSeasonRail(el, data, { bus })            -> { select(year), relabel(), destroy() }
 *   createSeasonCard(el, data)                     -> { show(year), hide(), relabel(), year() }
 *   createSeasonStrip(el, data, { bus })           -> { select(year), relabel(), destroy() }   (WP3 addition)
 *   enhanceList(listEl, data, { bus, router, filtersEl }) -> { setYear(y), reset(), relabel(), count() }
 *
 * `data` is the index from data.loadIndex() (or the data module: its getIndex() is used).
 * Events: hovering (a real pointer move, never a DOM swap under a resting pointer) or keyboard focus on a year
 * emits 'season:focus' {year|null}; clicking emits 'season:select' {year|null} (toggle). Selecting updates the
 * buttons in place, so the pressed year keeps focus. The list emits 'list:filter' {count, total, filters} after
 * every change. List rows are real links (#race=) once enhanced; the pre-rendered no-JS rows are plain
 * text. A click opens through router.open(target, { from: 'list' }).
 * Round 3 (D23): rows never say how a number was matched to its race, and there is no group of numbers without a
 * race (every wall number has one, D22; a number without one would still hang on the wall).
 * Every string comes from i18n.js; everything re-renders on relabel() (language change).
 */
import { t, tn, L, fmt, numberShort, resultShort, stagesFinished } from '../i18n.js';
import { resultClass, hasPower, raceDays } from '../data.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const idx = (data) => (data && data.races instanceof Map ? data : (data && (data.index || (data.getIndex && data.getIndex()))) || null);

function seasonSummary(s) {
  const bits = [];
  if (s.team && s.team.name) bits.push(s.team.name);
  bits.push(s.races.length ? tn('season.days', s.raceDays) : t('season.none'));
  if (s.wins) bits.push(tn('season.wins', s.wins));
  if (s.podiums > s.wins) bits.push(tn('season.podiums', s.podiums));
  if (s.bibs.length) bits.push(tn('season.bibs', new Set(s.bibs).size));
  return bits.join(', ');
}

/** Accessible name of a year button; a year without races offers no action (it is aria-disabled). */
function yearLabel(s, pressed) {
  const summary = s.races.length ? `${seasonSummary(s)}. ${t(pressed ? 'season.unfilter' : 'season.filter', { year: s.year })}` : seasonSummary(s);
  return t('season.aria', { year: s.year, summary });
}

/**
 * Hover and keyboard focus of the year buttons in `el` -> onChange(year | null). Hover needs a real pointer move:
 * Chrome fires pointerover when nodes change under a resting pointer, which must not light another year. The
 * latest input wins (a resting pointer does not override keyboard focus); mouse clicks do not count as focus
 * (only :focus-visible does).
 */
function trackYears(el, sel, onChange) {
  let pointerYear = null;
  let focusYear = null;
  let last = 'pointer';
  let current = null;
  const yearOf = (target) => {
    const b = target && target.closest ? target.closest(sel) : null;
    return b && el.contains(b) ? Number(b.dataset.year) : null;
  };
  const update = () => {
    const y = last === 'focus' ? (focusYear ?? pointerYear) : (pointerYear ?? focusYear);
    if (y === current) return;
    current = y;
    onChange(y);
  };
  const visible = (b) => { try { return b.matches(':focus-visible'); } catch (_) { return true; } };
  const onMove = (e) => {
    if (e.pointerType === 'touch') return;
    const y = yearOf(e.target);
    if (y == null) return;                          // gaps between the columns keep the last year
    pointerYear = y;
    last = 'pointer';
    update();
  };
  const onLeave = (e) => {
    if (e.pointerType === 'touch') return;
    pointerYear = null;
    update();
  };
  const onFocusIn = (e) => {
    const b = e.target && e.target.closest ? e.target.closest(sel) : null;
    focusYear = b && visible(b) ? Number(b.dataset.year) : null;
    if (focusYear != null) last = 'focus';
    update();
  };
  const onFocusOut = (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    focusYear = null;
    update();
  };
  el.addEventListener('pointermove', onMove, { passive: true });
  el.addEventListener('pointerleave', onLeave, { passive: true });
  el.addEventListener('focusin', onFocusIn);
  el.addEventListener('focusout', onFocusOut);
  return {
    current: () => current,
    destroy() {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    },
  };
}

/** Keeps focus on the same year button across a full re-render (language change). */
function keepFocus(el, sel, render) {
  const a = document.activeElement;
  const y = a && el.contains(a) && a.dataset ? a.dataset.year : null;
  render();
  if (y) { const b = el.querySelector(`${sel}[data-year="${y}"]`); if (b) b.focus({ preventScroll: true }); }
}

// ------------------------------------------------------------------ season rail (HUD, desktop)
const CAT_WEIGHT = [
  [/HC/i, 1],
  [/\b[12]\.1\b|\b[12]\.1U\b/i, 0.86],
  [/\b[12]\.2|\bNC\b|meister|champion/i, 0.72],
  [/\b[12]\.12|national|U23|Bundesliga/i, 0.52],
];
/** category is a string or { de, en } (build_data.py); the rail weight reads both languages. */
const catText = (c) => (c && typeof c === 'object' ? `${c.de || ''} ${c.en || ''}` : String(c || ''));
function tickHeight(r) {
  let h = 0.36;
  for (const [rx, w] of CAT_WEIGHT) {
    if (rx.test(`${catText(r.category)} ${r.kind === 'championship' ? 'champion' : ''}`)) { h = w; break; }
  }
  if (r.kind === 'stage_race') h = Math.min(1, h + 0.12);
  return h;
}
function dayFraction(r) {
  if (!r.date) return 0.5;
  const y = Number(r.date.slice(0, 4));
  const d = (Date.parse(`${r.date}T12:00:00Z`) - Date.UTC(y, 0, 1)) / 864e5;
  return Math.min(0.97, Math.max(0.03, d / 365));
}

export function createSeasonRail(el, data, { bus } = {}) {
  const ix = idx(data);
  if (!el || !ix || !ix.seasons.size) return { select() {}, relabel() {}, destroy() {} };
  let selected = null;
  const years = [...ix.seasons.keys()];
  const SEL = '.rs-rail__year';

  function render() {
    el.innerHTML = `<div class="rs-rail__years" role="group" aria-label="${esc(t('hud.rail', { first: years[0], last: years[years.length - 1] }))}">${
      years.map((y) => {
        const s = ix.seasons.get(y);
        const ticks = s.races.map((id) => {
          const r = ix.races.get(id);
          const win = resultClass(r.result) === 'win';
          return `<i class="rs-rail__tick${win ? ' is-win' : ''}" style="--x:${(dayFraction(r) * 100).toFixed(1)}%;--h:${Math.round(tickHeight(r) * 100)}%"></i>`;
        }).join('');
        const empty = !s.races.length;
        return `<button type="button" class="rs-rail__year${empty ? ' is-empty' : ''}" data-year="${y}" aria-pressed="${selected === y}"${empty ? ' aria-disabled="true"' : ''} aria-label="${esc(yearLabel(s, selected === y))}">`
          + `<span class="rs-rail__ticks" aria-hidden="true">${ticks}</span><span class="rs-rail__label" aria-hidden="true">${y}</span></button>`;
      }).join('')
    }</div>`;
  }
  /** In place: pressed state and names change, the buttons (and focus, and the node under the pointer) stay. */
  function sync() {
    for (const b of el.querySelectorAll(SEL)) {
      const y = Number(b.dataset.year);
      b.setAttribute('aria-pressed', String(selected === y));
      b.setAttribute('aria-label', yearLabel(ix.seasons.get(y), selected === y));
    }
  }
  render();

  const hover = trackYears(el, SEL, (year) => { if (bus) bus.emit('season:focus', { year, via: 'rail' }); });
  const onClick = (e) => {
    const b = e.target.closest && e.target.closest(SEL);
    const y = b ? Number(b.dataset.year) : null;
    if (!y || !ix.seasons.get(y).races.length) return;
    if (bus) bus.emit('season:select', { year: selected === y ? null : y, via: 'rail' });
  };
  el.addEventListener('click', onClick);

  return {
    select(y) { selected = y || null; sync(); },
    relabel() { keepFocus(el, SEL, render); },
    destroy() {
      hover.destroy();
      el.removeEventListener('click', onClick);
      el.innerHTML = '';
    },
  };
}

// ------------------------------------------------------------------ season card
function bestLine(best) {
  if (!best || typeof best !== 'object') return '';
  const order = [['5s', '5 s'], ['1m', '1 min'], ['5m', '5 min'], ['20m', '20 min'], ['60m', '60 min']];
  const parts = order.filter(([k]) => best[k] && best[k].w).map(([k, label]) => `${label} ${fmt.w(best[k].w)}`);
  return parts.length ? `${t('season.best')}: ${parts.join(' · ')}` : '';
}

export function createSeasonCard(el, data) {
  const ix = idx(data);
  let year = null;
  function render() {
    if (!el || !ix) return;
    const s = year != null ? ix.seasons.get(year) : null;
    if (!s) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const stats = [];
    const bold = (text, n) => esc(text).replace(String(n), `<b>${n}</b>`);
    stats.push(s.races.length ? bold(tn('season.days', s.raceDays), s.raceDays) : esc(t('season.none')));
    if (s.wins) stats.push(bold(tn('season.wins', s.wins), s.wins));                       // zero counts stay out
    if (s.podiums > s.wins) stats.push(bold(tn('season.podiums', s.podiums), s.podiums));  // podiums include wins
    const nb = new Set(s.bibs).size;
    const best = bestLine(s.best);
    el.innerHTML = `<span class="rs-season-card__k">${esc(t('season.k', { year: s.year }))}</span>`
      + (s.team && s.team.name ? `<span class="rs-season-card__t">${esc(s.team.name)}</span>` : '')
      + `<span class="rs-season-card__line">${stats.join(' · ')}</span>`
      + (nb ? `<span class="rs-season-card__line">${esc(tn('season.bibs', nb))}</span>` : '')
      + (best ? `<span class="rs-season-card__line">${esc(best)}</span>` : '');
    el.hidden = false;
  }
  return {
    show(y) { year = y == null ? null : Number(y); render(); },
    hide() { year = null; render(); },
    relabel: render,
    year: () => year,
  };
}

// ------------------------------------------------------------------ Saisons. strip (profile)
/** Short team names for the strip labels (the full name stays in the title, the season card and the aria labels). */
const TEAM_SHORT = {
  'RG Albert-Richter-Köln-Kaarst': 'Albert Richter',
  'Team Wurzener Sachsen U23': 'Wurzen',
  'Team PZ Racing Aachen': 'PZ Racing',
  'Team Vlassenroot': 'Vlassenroot',
  'Team Kuota - Indeland': 'Kuota',
  'Team Seven Stones': 'Seven Stones',
  'RC Zugvogel 09 Aachen': 'Zugvogel',
  'DJK Frankenberg 1912 Aachen': 'Frankenberg',
  'AminoSkin Cycling Team': 'AminoSkin',
};
function teamShort(name) {
  if (!name) return '';
  return TEAM_SHORT[name] || name.replace(/^(Team|RG|RC|RSC|RSV|RV|DJK|SC)\s+/, '').replace(/\s+(Cycling Team|Team)$/, '') || name;
}

export function createSeasonStrip(el, data, { bus } = {}) {
  const ix = idx(data);
  if (!el || !ix || !ix.seasons.size) return { select() {}, relabel() {}, destroy() {} };
  let selected = null;
  const years = [...ix.seasons.keys()];
  const n = years.length;
  const SEL = '.rs-strip__col';

  function render() {
    const seasons = years.map((y) => ix.seasons.get(y));
    const max = Math.max(1, ...seasons.map((s) => s.raceDays));
    const yOf = (s) => 100 - (s.raceDays / max) * 82;
    const pts = seasons.map((s, i) => [i * 100 + 50, yOf(s)]);
    const w = n * 100;
    // line and fill share one outline, from edge to edge like a stage profile
    const outline = `M0 ${pts[0][1].toFixed(1)} ${pts.map(([x, y]) => `L${x} ${y.toFixed(1)}`).join(' ')} L${w} ${pts[n - 1][1].toFixed(1)}`;
    const area = `${outline} L${w} 100 L0 100 Z`;
    const teams = [];
    for (const s of seasons) {
      const name = (s.team && s.team.name) || '';
      const last = teams[teams.length - 1];
      if (last && last.name === name) last.span += 1;
      else teams.push({ name, span: 1 });
    }
    const pi = seasons.findIndex((s) => s.raceDays === max);
    const peak = pi >= 0 && seasons[pi].raceDays
      ? `<span class="rs-strip__peak" data-side="${pi > n / 2 ? 'left' : 'right'}" style="--x:${((pts[pi][0] / w) * 100).toFixed(2)}%;--y:${pts[pi][1].toFixed(1)}%" aria-hidden="true">${esc(tn('season.days', max))}</span>`
      : '';
    el.innerHTML = `<div class="rs-strip__profile">`
      + `<svg class="rs-strip__svg" viewBox="0 0 ${w} 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
      + `<path class="rs-strip__area" d="${area}" /><path class="rs-strip__line" d="${outline}" /><line class="rs-strip__base" x1="0" y1="100" x2="${w}" y2="100" /></svg>`
      + peak
      + `<div class="rs-strip__cols" role="group" aria-label="${esc(t('season.strip', { first: years[0], last: years[n - 1] }))}">${seasons.map((s, i) => {
        const flags = s.wins ? `<span class="rs-strip__flags" style="--y:${pts[i][1].toFixed(1)}%" aria-hidden="true">${'<i class="rs-strip__flag"></i>'.repeat(Math.min(s.wins, 4))}</span>` : '';
        return `<button type="button" class="rs-strip__col" data-year="${s.year}" aria-pressed="${selected === s.year}" aria-label="${esc(yearLabel(s, selected === s.year))}"${s.races.length ? '' : ' disabled'}>${flags}</button>`;
      }).join('')}</div></div>`
      + `<div class="rs-strip__labels" aria-hidden="true">${years.map((y) => `<span class="rs-strip__label${selected === y ? ' is-on' : ''}" data-year="${y}">${y}</span>`).join('')}</div>`
      + `<div class="rs-strip__teams" aria-hidden="true">${teams.map((tm) => `<span class="rs-strip__team" style="--span:${tm.span}"${tm.name ? ` title="${esc(tm.name)}"` : ''}>${esc(teamShort(tm.name))}</span>`).join('')}</div>`;
  }
  function sync() {
    for (const b of el.querySelectorAll(SEL)) {
      const y = Number(b.dataset.year);
      b.setAttribute('aria-pressed', String(selected === y));
      b.setAttribute('aria-label', yearLabel(ix.seasons.get(y), selected === y));
    }
    for (const l of el.querySelectorAll('.rs-strip__label')) l.classList.toggle('is-on', Number(l.dataset.year) === selected);
  }
  render();

  const hover = trackYears(el, SEL, (year) => { if (bus) bus.emit('season:focus', { year, via: 'strip' }); });
  const onClick = (e) => {
    const b = e.target.closest && e.target.closest(SEL);
    const y = b ? Number(b.dataset.year) : null;
    if (y && bus) bus.emit('season:select', { year: selected === y ? null : y, via: 'strip' });
  };
  el.addEventListener('click', onClick);
  return {
    select(y) { selected = y || null; sync(); },
    relabel() { keepFocus(el, SEL, render); },
    destroy() {
      hover.destroy();
      el.removeEventListener('click', onClick);
    },
  };
}

// ------------------------------------------------------------------ list
const RESULT_FILTERS = ['all', 'win', 'podium', 'top10', 'finished', 'dnf'];
const RESULT_MATCH = {
  all: () => true,
  win: (c) => c === 'win',
  podium: (c) => c === 'win' || c === 'podium',
  top10: (c) => c === 'win' || c === 'podium' || c === 'top10',
  finished: (c) => c === 'win' || c === 'podium' || c === 'top10' || c === 'finished',
  dnf: (c) => c === 'dnf',
};

function rowHTML(r, ix) {
  // a stage race of which every stage was finished reads „im Ziel“ (resultShort) and counts as finished for the filter
  const cls = r.result && r.result.type === 'stages' && stagesFinished(r) ? 'finished' : resultClass(r.result);
  const flags = [hasPower(r) ? ' data-power' : '', r.photos.length ? ' data-photos' : '', r.bibs.length ? ' data-wall' : ''].join('');
  const date = r.date ? `<time datetime="${esc(r.date)}">${esc(fmt.date(r.date, 'short'))}</time>` : `<time datetime="${r.year}">${r.year}</time>`;
  const meta = [L(r.place), r.country ? fmt.country(r.country) : '', L(r.category), r.stages.length ? tn('res.stages', r.stages.length) : ''].filter(Boolean);
  const marks = [];
  if (r.bibs.length) {
    const nums = [...new Set(r.bibs.map((id) => numberShort(ix.bibs.get(id))))];
    marks.push(`<span class="rs-mark rs-mark--wall">${esc(nums.join(', '))}</span>`);
  }
  if (hasPower(r)) marks.push(`<span class="rs-mark">${esc(t('list.mark.power'))}</span>`);
  if (r.photos.length) marks.push(`<span class="rs-mark">${esc(t('list.mark.photos'))}</span>`);
  return `<li class="rs-row" data-id="${esc(r.id)}" data-year="${r.year || ''}" data-cc="${esc(r.country || '')}" data-kind="${esc(r.kind || 'other')}" data-res="${cls}"${flags}>`
    + `<a class="rs-row__link" href="#race=${esc(r.id)}">`
    + `<span class="rs-row__date">${date}</span>`
    + `<span class="rs-row__main"><span class="rs-row__name">${esc(L(r.name))}</span>${meta.length ? `<span class="rs-row__meta">${esc(meta.join(' · '))}</span>` : ''}</span>`
    + `<span class="rs-row__res${cls === 'win' ? ' is-win' : ''}">${esc(resultShort(r.result, r))}</span>`
    + `<span class="rs-row__marks">${marks.join('')}</span>`            // always there: the marks own a fixed column
    + '</a></li>';
}

export function enhanceList(listEl, data, { bus, router, filtersEl } = {}) {
  const ix = idx(data);
  if (!listEl || !ix) return { setYear() {}, reset() {}, relabel() {}, count: () => 0 };
  const filters = filtersEl || (listEl.closest('section') && listEl.closest('section').querySelector('[data-rs-filters]'));
  const state = { year: '', cc: '', kind: '', res: 'all', power: false, photos: false, wall: false };
  const total = ix.raceList.length;

  function renderRows() {
    const byYear = new Map();
    for (const r of ix.raceList) {
      if (!byYear.has(r.year)) byYear.set(r.year, []);
      byYear.get(r.year).push(r);
    }
    let html = '';
    for (const [y, races] of [...byYear].filter(([y]) => y).sort((a, b) => a[0] - b[0])) {
      const s = ix.seasons.get(y);
      const team = s && s.team && s.team.name;
      html += `<section class="rs-year" data-year="${y}"><h3 class="rs-year__h" id="rs-y-${y}">${y}${team ? ` <span class="rs-year__team">${esc(team)}</span>` : ''}</h3>`
        + `<ol class="rs-rows">${races.map((r) => rowHTML(r, ix)).join('')}</ol></section>`;
    }
    html += `<p class="rs-list__empty" data-rs-empty hidden>${esc(t('list.empty'))}</p>`;
    const focusedId = document.activeElement && listEl.contains(document.activeElement) ? document.activeElement.closest('.rs-row')?.dataset.id : null;
    listEl.innerHTML = html;
    if (focusedId) {
      const a = listEl.querySelector(`.rs-row[data-id="${CSS.escape(focusedId)}"] a`);
      if (a) a.focus({ preventScroll: true });
    }
  }

  function options(values, all, label) {
    return `<option value="">${esc(all)}</option>${values.map(([v, text]) => `<option value="${esc(v)}">${esc(text || label(v))}</option>`).join('')}`;
  }

  function renderFilters() {
    if (!filters) return;
    const years = [...new Set(ix.raceList.map((r) => r.year).filter(Boolean))].sort((a, b) => b - a).map((y) => [String(y), String(y)]);
    const ccs = [...new Set(ix.raceList.map((r) => r.country).filter(Boolean))].map((c) => [c, fmt.country(c)]).sort((a, b) => a[1].localeCompare(b[1]));
    const kinds = [...new Set(ix.raceList.map((r) => r.kind).filter(Boolean))].map((k) => [k, t(`kind.${k}`)]).sort((a, b) => a[1].localeCompare(b[1]));
    const radio = (v) => `<label class="rs-chip"><input type="radio" name="rs-res" value="${v}"${state.res === v ? ' checked' : ''} /><span>${esc(t(`list.result.${v}`))}</span></label>`;
    const box = (k) => `<label class="rs-chip"><input type="checkbox" name="rs-${k}" value="1"${state[k] ? ' checked' : ''} /><span>${esc(t(`list.has.${k}`))}</span></label>`;
    filters.setAttribute('role', 'search');
    filters.setAttribute('aria-label', t('list.filters.aria'));
    filters.innerHTML = `<label class="rs-field"><span>${esc(t('list.year'))}</span><select class="rs-select" name="year">${options(years, t('list.year.all'), String)}</select></label>`
      + `<label class="rs-field"><span>${esc(t('list.country'))}</span><select class="rs-select" name="cc">${options(ccs, t('list.country.all'), fmt.country)}</select></label>`
      + `<label class="rs-field"><span>${esc(t('list.kind'))}</span><select class="rs-select" name="kind">${options(kinds, t('list.kind.all'), (k) => t(`kind.${k}`))}</select></label>`
      + `<div class="rs-list__chips"><fieldset class="rs-seg rs-seg--result"><legend>${esc(t('list.result'))}</legend><div class="rs-seg__opts">${RESULT_FILTERS.map(radio).join('')}</div></fieldset>`
      + `<fieldset class="rs-seg rs-seg--has"><legend>${esc(t('list.has'))}</legend><div class="rs-seg__opts">${['power', 'photos', 'wall'].map(box).join('')}</div></fieldset></div>`
      + `<div class="rs-list__status"><span class="rs-list__count" data-rs-count-list aria-live="polite"></span><button type="button" class="rs-reset" data-rs-reset>${esc(t('list.reset'))}</button></div>`;
    filters.querySelector('select[name="year"]').value = state.year;
    filters.querySelector('select[name="cc"]').value = state.cc;
    filters.querySelector('select[name="kind"]').value = state.kind;
    filters.hidden = false;
  }

  function active() {
    return Boolean(state.year || state.cc || state.kind || state.res !== 'all' || state.power || state.photos || state.wall);
  }

  function apply({ silent = false } = {}) {
    let shown = 0;
    let anyRow = 0;
    const match = RESULT_MATCH[state.res] || RESULT_MATCH.all;
    for (const sec of listEl.querySelectorAll('.rs-year')) {
      let any = 0;
      for (const row of sec.querySelectorAll('.rs-row')) {
        const d = row.dataset;
        const ok = (!state.year || d.year === state.year) && (!state.cc || d.cc === state.cc) && (!state.kind || d.kind === state.kind)
          && match(d.res) && (!state.power || row.hasAttribute('data-power')) && (!state.photos || row.hasAttribute('data-photos'))
          && (!state.wall || row.hasAttribute('data-wall'));
        if (ok) shown += 1;
        row.hidden = !ok;
        if (ok) { any += 1; anyRow += 1; }
      }
      sec.hidden = !any;
    }
    const empty = listEl.querySelector('[data-rs-empty]');
    if (empty) empty.hidden = anyRow > 0;
    const count = filters && filters.querySelector('[data-rs-count-list]');
    const text = shown === 1 ? t('list.count.one', { total }) : t('list.count', { shown, total });
    if (count) count.textContent = active() ? text : t('list.count', { shown, total });
    const reset = filters && filters.querySelector('[data-rs-reset]');
    if (reset) reset.disabled = !active();
    if (!silent && bus) bus.emit('list:filter', { count: shown, total, filters: { ...state } });
    return shown;
  }

  function onChange(e) {
    const x = e.target;
    if (!x || !x.name) return;
    if (x.name === 'year' || x.name === 'cc' || x.name === 'kind') state[x.name] = x.value;
    else if (x.name === 'rs-res') state.res = x.value;
    else if (x.name.startsWith('rs-')) state[x.name.slice(3)] = x.checked;
    apply();
    if (x.name === 'year' && bus) bus.emit('season:select', { year: state.year ? Number(state.year) : null, via: 'list' });
  }

  function reset() {
    Object.assign(state, { year: '', cc: '', kind: '', res: 'all', power: false, photos: false, wall: false });
    renderFilters();
    apply();
    if (bus) bus.emit('season:select', { year: null, via: 'list' });
  }

  function onFilterClick(e) {
    if (e.target.closest('[data-rs-reset]')) {
      reset();
      const first = filters.querySelector('select');
      if (first) first.focus();
    }
  }

  function onListClick(e) {
    const a = e.target.closest && e.target.closest('a.rs-row__link');
    if (!a || !router || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const row = a.closest('.rs-row');
    e.preventDefault();
    router.open({ raceId: row.dataset.id }, { from: 'list' });
  }

  renderRows();
  renderFilters();
  apply({ silent: true });
  // a cold link to a year heading (#rs-y-2009): the browser's jump went to the static list, before the filters above
  // it appeared (or never ran: the heading was replaced while list.css still held the first paint). Aim again once
  // the list is styled.
  const cold = /^#rs-y-/.test(location.hash) && performance.now() < 5000 && document.getElementById(location.hash.slice(1));
  const listCss = cold && document.querySelector('link[rel="stylesheet"][href*="list.css"]');
  const go = () => cold.scrollIntoView();
  if (listCss && !listCss.sheet) listCss.addEventListener('load', go, { once: true }); else if (cold) go();
  if (filters) {
    filters.addEventListener('change', onChange);
    filters.addEventListener('click', onFilterClick);
  }
  listEl.addEventListener('click', onListClick);

  return {
    setYear(y) {
      const v = y ? String(y) : '';
      if (state.year === v) return;
      state.year = v;
      const sel = filters && filters.querySelector('select[name="year"]');
      if (sel) sel.value = v;
      apply();
    },
    reset,
    relabel() { renderRows(); renderFilters(); apply({ silent: true }); },
    count: () => apply({ silent: true }),
    state: () => ({ ...state }),
  };
}

export default { createSeasonRail, createSeasonCard, createSeasonStrip, enhanceList };
