/**
 * results/results.js (round 2, package ui): the „Ergebnisliste“ / "Results" section of the dossier (D18).
 *
 *   createResults(el, results, { i18n, stage, getSource, cites, team }) -> { relabel(), destroy() }
 *     getSource(id) resolves source ids (the dossier's registry); cites (object or getter) numbers them like the rest
 *     of the dossier (chips that jump to „Quellen“); team: the race's team (my team's row in team lists)
 *   finishersOf(classification) -> the „im Ziel“ count or null (check_radsport.py runs it over every list)
 *
 * results: rs-results/1 in data/dossiers/<raceId>.json (scripts/radsport/build_data.py attach_results()).
 *
 * One classification at a time (tabs up to 8, else a select); an accessible <table>; my row reads „Ich“ / "Me" and is
 * marked (in a team list: my team). D27: up to 30 rows show whole, a longer list the top 20 and my row ±3 with „Alle N
 * anzeigen“. Restricted lists (safe mode only) carry the podium and my row plus „Vollständige Liste bei <Quelle>“.
 * Phones: the box scrolls sideways, place and name stay. Re-renders on a language change.
 */

// `listed` counts every entry, DNF and DNS rows too; `part` links a list the source cuts off, `full` a complete one
const STR = {
  de: {
    tabs: 'Wertungen', pick: 'Wertung', pos: 'Platz', name: 'Name', team: 'Team', nat: 'Land', time: 'Zeit', laps: 'Runden',
    pts: 'Punkte', me: 'Ich', listed: '{n} in der Liste', starters: '{n} am Start', finishers: '{n} im Ziel', dnf: '{n} nicht im Ziel',
    otl: '{n} außerhalb der Karenzzeit', dns: '{n} nicht gestartet', dsq: '{n} disqualifiziert',
    incomplete: 'Liste unvollständig', all: 'Alle {n} anzeigen', fewer: 'Weniger anzeigen', skip: 'Plätze {a} bis {b} ausgelassen',
    skipOne: 'Platz {a} ausgelassen', skipRest: 'weitere Einträge ausgelassen', full: 'Vollständige Liste bei', part: 'Liste bei',
    src: 'Quelle', srcs: 'Quellen',
    notMe: 'Ich stehe nicht in dieser Liste.', scopeTop: 'Die ersten {n} und meine Platzierung', scopeTen: 'Die ersten {n}',
    scopePod: 'Podium und meine Platzierung', scopePod0: 'Podium', region: 'Ergebnisliste {label}, scrollbar',
    teams: '{n} Teams', teamOne: '1 Team', myTeam: 'Mein Team', scopeTeam: 'Die ersten {n} und mein Team', scopeAll: 'Alle {n} Einträge',
  },
  en: {
    tabs: 'Classifications', pick: 'Classification', pos: 'Place', name: 'Name', team: 'Team', nat: 'Nation', time: 'Time', laps: 'Laps',
    pts: 'Points', me: 'Me', listed: '{n} listed', starters: '{n} starters', finishers: '{n} finishers', dnf: '{n} did not finish',
    otl: '{n} outside the time limit', dns: '{n} did not start', dsq: '{n} disqualified',
    incomplete: 'incomplete list', all: 'Show all {n}', fewer: 'Show fewer', skip: 'Places {a} to {b} left out',
    skipOne: 'Place {a} left out', skipRest: 'more entries left out', full: 'Full list at', part: 'List at',
    src: 'Source', srcs: 'Sources',
    notMe: 'I am not on this list.', scopeTop: 'Top {n} and my place', scopeTen: 'Top {n}',
    scopePod: 'Podium and my place', scopePod0: 'Podium', region: 'Results {label}, scrollable',
    teams: '{n} teams', teamOne: '1 team', myTeam: 'My team', scopeTeam: 'Top {n} and my team', scopeAll: 'All {n} entries',
  },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = (v) => (Array.isArray(v) ? v : []);
const SELF = new RegExp(['bon', 'ten', 'ack', 'el'].join(''), 'i');
const isMe = (r) => Boolean(r && (r.me === true || SELF.test(String(r.name || ''))));
const TOP = 20;                 // D27: a long list shows the first 20 ...
const AROUND = 3;               // ... and my row with 3 rows on each side
const SHORT = 30;               // lists up to this length show in full
const SMALL_GAP = 2;            // a gap this small shows its rows
const TABS_MAX = 8;
const FINISH = /^(?:result|prologue|stage|gc|trofeo)(?:-|$)/;   // lists of the riders who finished
let uid = 0;

/** „im Ziel“: the source's count, else the classified rows of a complete finish list, else null (an incomplete or a
 *  points, mountains, youth or team list says how many it lists instead). */
export function finishersOf(c) {
  if (!c || teamList(c)) return null;
  if (c.finishers != null) return c.finishers;
  const k = c.counts || {};
  return c.complete !== false && FINISH.test(String(c.key || '')) && k.finished != null ? k.finished : null;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^team(?=.{4})/, '');
const codeOf = (s) => { const x = String(s || '').trim(); const m = /\(([A-Z0-9]{2,5})\)$/.exec(x); return m ? m[1] : /^[A-Z0-9]{2,5}$/.test(x) ? x : ''; };
const bare = (s) => String(s || '').replace(/\s*\([^)]*\)$/, '').trim();
/** A team list: by its key, or rows that name teams only (Tour de Korea 2007). */
const teamList = (c) => /^team/.test(String((c && c.key) || ''))
  || (!arr(c && c.rows).some((r) => !isMe(r) && String(r.name || '').trim()) && arr(c && c.rows).some((r) => r.team));
/** Matcher for my team: the team of my rows (with its code, "RG Albert-R (ARK)") and the race's team; by code, name
 *  (without a leading "Team": "Seven Stones") or a cut name ("Team Kuota" of "Team Kuota - Indeland"). */
function myTeam(list, team) {
  const names = new Set();
  const codes = new Set();
  const add = (x) => {
    const c = codeOf(x);
    if (c) codes.add(c);
    const n = norm(bare(x));
    if (n.length >= 4 && n !== norm(c)) names.add(n);
  };
  for (const c of list) for (const r of arr(c.rows)) if (isMe(r) && r.team) add(r.team);
  if (team) add(team);
  return (row) => {
    if ([codeOf(row.name), codeOf(row.team)].some((c) => c && codes.has(c))) return true;
    return [norm(bare(row.name)), norm(bare(row.team))].some((n) => n.length >= 4 && [...names].some((m) => {
      if (n === m) return true;
      const [a, b] = n.length < m.length ? [n, m] : [m, n];
      return a.length >= 5 && b.startsWith(a);
    }));
  };
}

/** Short source name for the link text: "rad-net" of "rad-net: Ergebnis …", else the host. */
function shortSource(s) {
  const label = String((s && s.label) || '').trim();
  const head = label.split(/,|:\s/)[0].trim();   // "mika:timing: …" keeps its brand (r2fix-data)
  if (head && head.length <= 32) return head;
  try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch (_) { return label; }
}

export function createResults(el, results, opts = {}) {
  const i18n = opts.i18n;
  const lang = () => (i18n && typeof i18n.lang === 'function' ? i18n.lang() : 'de');
  const s = (k, v) => {
    const str = (STR[lang()] || STR.de)[k] ?? STR.de[k] ?? k;
    return v ? str.replace(/\{(\w+)\}/g, (m, x) => (v[x] == null ? m : String(v[x]))) : str;
  };
  const L = (o) => (o == null ? '' : typeof o === 'object' ? (i18n && i18n.L ? i18n.L(o) : o.de || o.en || '') : String(o));
  const list = arr(results && results.classifications).filter((c) => c && arr(c.rows).length);
  const id = `rs-rl-${++uid}`;
  if (!el || !list.length) return null;
  // restricted only in safe mode (D18); "full" (D27) never cuts
  const full = Boolean(results && results.mode === 'full');
  const restricted = (c) => Boolean(c && c.restricted) && !full;

  const meIdx = (c) => arr(c.rows).findIndex(isMe);
  const mine = myTeam(list, opts.team);
  const teamIdx = (c) => (teamList(c) ? arr(c.rows).findIndex((r) => !isMe(r) && mine(r)) : -1);
  const focusIdx = (c) => { const m = meIdx(c); return m >= 0 ? m : teamIdx(c); };
  const pick = () => {
    const st = opts.stage;
    if (st != null) {
      const k = Number(st) === 0 ? ['prologue', 'stage-0'] : [`stage-${st}`];
      const hit = list.findIndex((c) => k.includes(String(c.key)));
      if (hit >= 0) return hit;
    }
    // the classification the data names for me (results.tom), if my row is in it; else the main one with my row
    const tomKey = results && results.tom && results.tom.classification;
    const named = list.findIndex((c) => c.key === tomKey && meIdx(c) >= 0);
    if (named >= 0) return named;
    const main = list.findIndex((c) => (c.key === 'gc' || c.key === 'result') && meIdx(c) >= 0);
    if (main >= 0) return main;
    for (let i = list.length - 1; i >= 0; i -= 1) if (/^stage-/.test(String(list[i].key)) && meIdx(list[i]) >= 0) return i;
    const any = list.findIndex((c) => meIdx(c) >= 0);
    if (any >= 0) return any;
    const gc = list.findIndex((c) => c.key === 'gc' || c.key === 'result');
    return gc >= 0 ? gc : 0;
  };
  let sel = pick();
  let open = false;

  // tab: the short head of the label ("1. Etappe" of "1. Etappe: Santander - Maliaño" or "1. Etappe, Burg")
  const tabLabel = (c) => {
    const full = L(c.label) || String(c.key);
    const st = /^(\d+\.\s*Etappe|Stage\s+\d+|Prolog(?:ue)?)\b/i.exec(full);
    return st ? st[1] : full.split(':')[0].trim() || full;
  };
  const ordinal = (n) => (n == null ? '' : lang() === 'de' ? `${n}.` : String(n));
  const status = (r) => {
    const st = String(r.status || '').toLowerCase();
    if (st && st !== 'finished') return st === 'otl' ? 'OTL' : st.toUpperCase().slice(0, 4);
    return '';
  };
  const count = (n) => (i18n && i18n.fmt ? i18n.fmt.num(n, 0) : String(n));

  /** Rows to show: all, or the top 20 plus my row (or my team's) ±3; a gap of 3+ rows becomes one marker row. */
  function visible(c) {
    const rows = arr(c.rows);
    const all = rows.map((r, i) => ({ r, i }));
    if (restricted(c) || rows.length <= SHORT || open) return { rows: all, cut: false };
    const f = focusIdx(c);
    const keep = rows.map((r, i) => i < TOP || (f >= 0 && Math.abs(i - f) <= AROUND));
    let last = -1;
    for (let i = 0; i <= rows.length; i += 1) {          // rows.length: a gap at the end
      if (i < rows.length && !keep[i]) continue;
      if (i - last - 1 <= SMALL_GAP) for (let j = last + 1; j < i; j += 1) keep[j] = true;
      last = i;
    }
    const shown = all.filter(({ i }) => keep[i]);
    return { rows: shown, cut: shown.length < rows.length };
  }

  function counts(c) {
    const bits = [];
    const k = c.counts || {};                      // over the full list, also when the rows are cut
    const fin = finishersOf(c);
    const listed = c.listed != null ? c.listed : arr(c.rows).length;
    const what = teamList(c) ? (listed === 1 ? 'teamOne' : 'teams') : 'listed';
    if (listed !== fin && listed !== c.starters) bits.push(s(what, { n: count(listed) }));
    if (c.starters != null) bits.push(s('starters', { n: count(c.starters) }));
    if (fin != null) bits.push(s('finishers', { n: count(fin) }));
    for (const x of ['dnf', 'otl', 'dns', 'dsq']) if (k[x] > 0) bits.push(s(x, { n: count(k[x]) }));
    if (c.complete === false) bits.push(`<span class="rs-rl__inc">${esc(s('incomplete'))}</span>`);
    return bits.length ? `<p class="rs-rl__counts">${bits.map((b) => (b.startsWith('<') ? b : esc(b))).join('<span aria-hidden="true"> · </span><span class="rs-sr">, </span>')}</p>` : '';
  }

  /** A source: an id of the dossier's sources registry, or { url, label } inline. */
  function source(x) {
    if (typeof x === 'string') {
      const o = typeof opts.getSource === 'function' ? opts.getSource(x) : null;
      return o ? { id: x, url: o.public !== false && typeof o.url === 'string' ? o.url : null, label: L(o.label) || x } : null;
    }
    return x && (x.label || x.url) ? { id: null, url: x.url || null, label: L(x.label) || '' } : null;
  }
  function srcLine(c) {
    const src = arr(c.src).map(source).filter(Boolean);
    if (!src.length) return '';
    const link = (x, text) => (x.url && /^https?:\/\//.test(x.url)
      ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : `<span>${esc(text)}</span>`);
    // ids: the dossier's numbered citations (they jump to „Quellen“, where each source has its label and link)
    const cites = typeof opts.cites === 'function' ? opts.cites() : opts.cites;
    const ids = src.map((x) => x.id).filter(Boolean);
    const chips = cites && typeof cites.html === 'function' && ids.length ? cites.html(ids) : '';
    const line = chips
      ? `<p class="rs-d-marks rs-rl__src"><span class="rs-mk" aria-hidden="true">${esc(s(ids.length > 1 ? 'srcs' : 'src'))}</span>${chips}</p>`
      : `<p class="rs-rl__src"><span class="rs-rl__k">${esc(s(src.length > 1 ? 'srcs' : 'src'))}</span> ${src.map((x) => link(x, x.label || shortSource(x))).join('<span aria-hidden="true"> · </span><span class="rs-sr">, </span>')}</p>`;
    if (!restricted(c)) return line;
    // restricted (D18): only podium and my row ship; the whole list is one link away (fullList: sources with a url)
    const x = arr(c.fullList).map(source).find((y) => y && y.url) || src.find((y) => y.url) || src[0];
    return `<p class="rs-rl__full">${esc(s(c.complete === false ? 'part' : 'full'))} ${link(x, shortSource(x))}${chips}</p>`;
  }

  function table(c) {
    const rows = arr(c.rows);
    const hasLaps = rows.some((r) => r.laps != null);
    const hasPts = rows.some((r) => r.pts != null);
    // a team list that names its teams only in `team` (Tour de Korea 2007): the team is the row's name
    const teams = !rows.some((r) => !isMe(r) && String(r.name || '').trim()) && rows.some((r) => r.team);
    const hasTeam = !teams && rows.some((r) => r.team);
    const hasNat = rows.some((r) => r.nat);
    const hasTime = rows.some((r) => r.time || r.gap);
    const cols = 2 + (hasTime ? 1 : 0) + (hasLaps ? 1 : 0) + (hasPts ? 1 : 0) + (hasTeam ? 1 : 0) + (hasNat ? 1 : 0);
    const { rows: shown, cut } = visible(c);
    const label = L(c.label) || String(c.key);
    const when = c.date && i18n && i18n.fmt ? i18n.fmt.date(c.date, 'long') : '';
    const me0 = meIdx(c) >= 0;
    const tIdx = me0 ? -1 : teamIdx(c);
    // an open long list names its scope too: the head keeps its lines, the toggle stays under the finger
    const scope = restricted(c) ? s(me0 ? 'scopePod' : 'scopePod0')
      : cut ? s(me0 ? 'scopeTop' : tIdx >= 0 ? 'scopeTeam' : 'scopeTen', { n: TOP })
        : open && rows.length > SHORT ? s('scopeAll', { n: count(rows.length) }) : '';
    const body = [];
    const gap = (a, b) => body.push(`<tr class="rs-rl__gap"><td colspan="${cols}"><span aria-hidden="true">…</span><span class="rs-sr">${esc(a != null && b != null
      ? (a === b ? s('skipOne', { a }) : s('skip', { a, b })) : s('skipRest'))}</span></td></tr>`);
    let prev = -1;
    for (const { r, i } of shown) {
      const p = rows[prev];
      if (i > prev + 1) gap(rows[prev + 1] && rows[prev + 1].pos, rows[i - 1] && rows[i - 1].pos);
      // a restricted list carries only the podium and my row: the places in between are left out as well
      else if (restricted(c) && p && p.pos != null && r.pos != null && r.pos > p.pos + 1) gap(p.pos + 1, r.pos - 1);
      prev = i;
      const me = isMe(r);
      const myTeamRow = i === tIdx;
      const st = status(r);
      const place = r.pos != null ? ordinal(r.pos) : st || '';
      const name = (teams ? r.team : r.name) || '';
      const who = me ? `<strong>${esc(s('me'))}</strong>`
        : myTeamRow ? `<strong>${esc(name)}</strong> <span class="rs-rl__tag">${esc(s('myTeam'))}</span>` : esc(name);
      const tm = r.gap || r.time || '';
      body.push(`<tr${me || myTeamRow ? ' class="is-me" data-me' : ''}>`
        + `<td class="rs-rl__pos">${esc(place)}</td>`
        + `<th scope="row" class="rs-rl__name">${who}</th>`
        + (hasTime ? `<td class="rs-rl__time">${esc(tm)}${r.pos != null && st ? ` <span class="rs-rl__st">${esc(st)}</span>` : ''}</td>` : '')
        + (hasLaps ? `<td class="rs-rl__num">${esc(r.laps ?? '')}</td>` : '')
        + (hasPts ? `<td class="rs-rl__num">${esc(r.pts ?? '')}</td>` : '')
        + (hasTeam ? `<td class="rs-rl__team">${esc(r.team || '')}</td>` : '')
        + (hasNat ? `<td class="rs-rl__nat">${esc(r.nat || '')}</td>` : '')
        + '</tr>');
    }
    if (prev < rows.length - 1 && cut) gap(rows[prev + 1] && rows[prev + 1].pos, rows[rows.length - 1].pos);
    const head = `<tr><th scope="col" class="rs-rl__pos">${esc(s('pos'))}</th><th scope="col" class="rs-rl__name">${esc(s(teams ? 'team' : 'name'))}</th>`
      + (hasTime ? `<th scope="col" class="rs-rl__time">${esc(s('time'))}</th>` : '')
      + (hasLaps ? `<th scope="col" class="rs-rl__num">${esc(s('laps'))}</th>` : '')
      + (hasPts ? `<th scope="col" class="rs-rl__num">${esc(s('pts'))}</th>` : '')
      + (hasTeam ? `<th scope="col" class="rs-rl__team">${esc(s('team'))}</th>` : '')
      + (hasNat ? `<th scope="col" class="rs-rl__nat">${esc(s('nat'))}</th>` : '')
      + '</tr>';
    // the caption names the table for screen readers; its visible twin stays above the scroll box
    const capText = [label, when, scope].filter(Boolean).join('. ');
    const cap = `<p class="rs-rl__cap" aria-hidden="true"><span class="rs-rl__cl">${esc(label)}</span>`
      + (when ? `<span class="rs-rl__when">${esc(when)}</span>` : '')
      + (scope ? `<span class="rs-rl__scope">${esc(scope)}</span>` : '') + '</p>';
    return { cap, html: `<table class="rs-rl__t"><caption class="rs-sr">${esc(capText)}</caption><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`, cut, label };
  }

  function switcher() {
    if (list.length < 2) return '';
    if (list.length > TABS_MAX) {
      return `<label class="rs-rl__pick"><span class="rs-rl__k">${esc(s('pick'))}</span><select data-rl-pick>${list.map((c, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(L(c.label) || c.key)}</option>`).join('')}</select></label>`;
    }
    return `<div class="rs-rl__tabs" role="tablist" aria-label="${esc(s('tabs'))}">${list.map((c, i) => `<button type="button" role="tab" id="${id}-t${i}" aria-controls="${id}-p" aria-selected="${i === sel}" tabindex="${i === sel ? 0 : -1}" data-rl-tab="${i}">${esc(tabLabel(c))}</button>`).join('')}</div>`;
  }

  function render({ keepFocus = null, fit = true } = {}) {
    const c = list[sel];
    const t = table(c);
    // a team list lists no riders: no „Ich stehe nicht in dieser Liste.“
    const me = meIdx(c) >= 0 || teamList(c);
    const total = arr(c.rows).length;
    // the toggle only where collapsing hides rows
    const lab = [s('fewer'), s('all', { n: count(total) })];
    if (!open) lab.reverse();                     // the hidden other label keeps the button's width
    const more = !restricted(c) && total > SHORT && (open || t.cut)
      ? `<button type="button" class="rs-rl__more" data-rl-more aria-expanded="${open}" aria-controls="${id}-w"><span>${esc(lab[0])}</span><span class="rs-rl__ghost" aria-hidden="true">${esc(lab[1])}</span></button>` : '';
    const note = L(c.note);
    const tabbed = list.length >= 2 && list.length <= TABS_MAX;
    el.innerHTML = `<div class="rs-rl${open ? ' is-open' : ''}">${switcher()}`
      + `<div class="rs-rl__panel" id="${id}-p"${tabbed ? ` role="tabpanel" aria-labelledby="${id}-t${sel}"` : ''}>`
      // the toggle: above the table, in a column of its own (stays in place)
      + `<div class="rs-rl__head"><div class="rs-rl__meta">${t.cap}${counts(c)}</div>${more}</div>`
      + `<div class="rs-rl__wrap" id="${id}-w" data-rl-wrap>${t.html}</div>`
      + (me ? '' : `<p class="rs-rl__notme">${esc(s('notMe'))}</p>`)
      + (note ? `<p class="rs-rl__note">${esc(note)}</p>` : '')
      + srcLine(c)
      + '</div></div>';
    const wrap = el.querySelector('[data-rl-wrap]');
    if (fit) fitWrap(wrap, t.label);            // the first time: the ResizeObserver, after layout
    if (open) centerMe(wrap);
    // phones: the tab row scrolls; the chosen tab stays in sight
    const tab = el.querySelector('[role="tab"][aria-selected="true"]');
    const bar = tab && tab.parentElement;
    if (bar && bar.scrollWidth > bar.clientWidth + 1) bar.scrollLeft = Math.max(0, tab.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2);
    if (keepFocus) {
      const f = el.querySelector(keepFocus);
      if (f) { try { f.focus({ preventScroll: true }); } catch (_) { f.focus(); } }
    }
  }

  /** A box that scrolls gets a name and a tab stop (keyboard scrolling, axe scrollable-region-focusable). */
  function fitWrap(wrap, label) {
    if (!wrap) return;
    const scrolls = wrap.scrollWidth > wrap.clientWidth + 1 || wrap.scrollHeight > wrap.clientHeight + 1;
    if (scrolls) {
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', s('region', { label }));
    } else {
      wrap.removeAttribute('tabindex');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-label');
    }
  }

  /** My row into view inside the table box only (the dossier itself does not move). */
  function centerMe(wrap) {
    const row = wrap && wrap.querySelector('tr[data-me]');
    if (!row) return;
    const top = row.offsetTop - (wrap.clientHeight - row.offsetHeight) / 2;
    wrap.scrollTop = Math.max(0, top);
  }

  function select(i, focus) {
    if (i === sel || i < 0 || i >= list.length) return;
    sel = i;
    render({ keepFocus: focus ? `[data-rl-tab="${i}"]` : null });
  }

  const onClick = (e) => {
    const tab = e.target.closest && e.target.closest('[data-rl-tab]');
    if (tab) { select(Number(tab.getAttribute('data-rl-tab')), true); return; }
    const more = e.target.closest && e.target.closest('[data-rl-more]');
    if (more) {
      open = !open;
      render({ keepFocus: '[data-rl-more]' });
    }
  };
  const onChange = (e) => {
    if (e.target && e.target.matches && e.target.matches('[data-rl-pick]')) {
      sel = Number(e.target.value) || 0;
      render({ keepFocus: '[data-rl-pick]' });
    }
  };
  const onKey = (e) => {
    const tab = e.target.closest && e.target.closest('[data-rl-tab]');
    if (!tab) return;
    const i = Number(tab.getAttribute('data-rl-tab'));
    let n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    if (n == null) return;
    e.preventDefault();
    e.stopPropagation();
    select(n, true);
  };
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('keydown', onKey);
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { const w = el.querySelector('[data-rl-wrap]'); const c = list[sel]; fitWrap(w, L(c.label) || String(c.key)); });
    ro.observe(el);
  }
  const offLang = i18n && typeof i18n.onLangChange === 'function' ? i18n.onLangChange(() => {
    const a = document.activeElement;
    const f = a && el.contains(a) ? (a.matches('[data-rl-tab]') ? `[data-rl-tab="${a.getAttribute('data-rl-tab')}"]` : a.matches('[data-rl-more]') ? '[data-rl-more]' : a.matches('[data-rl-pick]') ? '[data-rl-pick]' : null) : null;
    render({ keepFocus: f });
  }) : null;
  render({ fit: !ro });

  return {
    relabel() { render(); },
    destroy() {
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
      el.removeEventListener('keydown', onKey);
      if (ro) ro.disconnect();
      if (typeof offLang === 'function') offLang();
    },
  };
}

/** Dossier mount: `race` is the race with its dossier file merged (results, extraSources); ids resolve through the
 * file's registry first, then races.json (`data.getSource`). The section hides itself when nothing renders. */
export function mount(el, race, { i18n, data, stage, cites } = {}) {
  const getSource = (id) => (race && race.extraSources && race.extraSources[id]) || (data && data.getSource ? data.getSource(id) : null);
  const team = race && race.team && race.team.name;
  let c = null;
  try { c = createResults(el, race && race.results, { i18n, stage, getSource, cites, team }); } catch (e) { try { console.warn('[radsport] results:', e); } catch (_) { /* */ } }
  if (!c) { const sec = el && el.closest('[data-sec]'); if (sec) sec.hidden = true; }
  return c;
}

export default { createResults, mount, finishersOf };
