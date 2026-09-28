/* radsport/js/charts/power-chart.js (WP7): canvas chart of one rs-power/1 series (FINAL_SPEC 3.9, 4.4, 7, 9.1).
 * Two panels share the x axis (km, or time when km is unreliable): power in W from 0 (thin 30 s mean, bold
 * 5 min mean; speed when the file has no power, and it says so) over an altitude strip (climbs darker). Gaps
 * stay gaps; moments get marks and at most 6 labels in a strip above the plot. Tooltip, playhead, readouts,
 * role=slider (arrows, Page up/down, Home/End, Space), table view twin; follows theme, language and size.
 * createPowerChart(el, series, { i18n, x: 'km'|'t', reducedMotion, bests }) -> { draw({ reveal, animate }),
 *   setCursor(fraction|null, { playing }), onScrub(fn), onToggle(fn), resize(), setTheme(), relabel(),
 *   tableHTML(), flash(moment), destroy(), el, controls (hosts the replay bar), xMode, series,
 *   fractionOfIndex(i), sample(fraction) }
 * fraction = t / t_last (as the engine's seek). setCursor(f, { playing: true }) (replay frames) leaves
 * aria-valuetext alone (a focused slider speaks every change); input, pause and end update it at once.
 * "Rennzeit" counts from the race window's start (the data begin about 1 min earlier).
 */
import { makeT, esc, hms, hmsS, nb, raceWindow, localPlus, observeRoot, prefersReducedMotion } from './strings.js';

const PRIORITY = { finale: 0, sprint: 1, climb: 2, attack: 3, descent: 4, bell: 5, break: 6, other: 7 };
const MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
let uid = 0;

/** Centred rolling mean over k samples; null where the sample is missing or the window is
 * less than half covered (gaps stay gaps). */
function smooth(arr, k) {
  const n = arr.length, out = new Array(n).fill(null);
  if (k <= 1) return arr.slice();
  const h0 = Math.floor(k / 2), h1 = k - h0 - 1;
  let s = 0, c = 0, a = 0, b = -1;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h0), hi = Math.min(n - 1, i + h1);
    while (b < hi) { b++; if (arr[b] != null) { s += arr[b]; c++; } }
    while (a < lo) { if (arr[a] != null) { s -= arr[a]; c--; } a++; }
    if (arr[i] != null && c * 2 >= hi - lo + 1) out[i] = s / c;
  }
  return out;
}

function forwardFill(arr, n) {
  const out = new Float64Array(n);
  let last = null;
  for (let i = 0; i < n; i++) {
    const v = arr ? arr[i] : null;
    if (v != null) last = v;
    out[i] = last == null ? 0 : last;
  }
  if (arr) { let first = null; for (let i = 0; i < n; i++) if (arr[i] != null) { first = arr[i]; break; } for (let i = 0; i < n && arr[i] == null; i++) out[i] = first || 0; }
  return out;
}

function niceStep(range, targetTicks) {
  const raw = range / Math.max(1, targetTicks);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export function createPowerChart(el, series, opts = {}) {
  const T = makeT(opts.i18n);
  const id = 'rs-pc-' + ++uid;
  const D = series.data || {};
  const n = (D.t || []).length;
  const res = series.resolution_s || (n > 1 ? D.t[1] - D.t[0] : 5);
  const tMax = n ? D.t[n - 1] : 0;
  const flags = series.flags || [];
  const hasW = Array.isArray(D.w) && D.w.some((v) => v != null);
  const hasCad = hasW && Array.isArray(D.cad) && D.cad.some((v) => v != null);
  const hasKph = Array.isArray(D.kph) && D.kph.some((v) => v != null);
  const hasKm = Array.isArray(D.km) && D.km.some((v) => v != null) && !flags.includes('km_unreliable');
  const xMode = opts.x === 't' || !hasKm ? 't' : 'km';
  const topKey = hasW ? 'w' : 'kph';
  const topRaw = D[topKey] || new Array(n).fill(null);
  const top = smooth(topRaw, Math.max(1, Math.round(30 / res)));       // 30 s mean (readouts, light line)
  const trend = smooth(topRaw, Math.max(3, Math.round(300 / res)));    // 5 min mean (emphasis line)
  const alt = Array.isArray(D.alt) && D.alt.some((v) => v != null) ? D.alt : null;
  const kmF = hasKm ? forwardFill(D.km, n) : null;
  const totalX = xMode === 'km' ? kmF[n - 1] || 1 : tMax || 1;
  const moments = (series.moments || []).map((m) => Object.assign({}, m, { i: Math.max(0, Math.min(n - 1, Math.round(m.t / res))) }));
  const reduced = opts.reducedMotion != null ? !!opts.reducedMotion : prefersReducedMotion();
  const showBests = opts.bests !== false;
  const RW = raceWindow(series), r0 = RW.r0;
  // race time of a sample; start and finish lie between two samples: the nearest ones read 0:00:00 and the duration
  const rt = (t) => { const v = t - r0; return hmsS(Math.abs(v) < res ? 0 : Math.abs(v - RW.dur) < res ? RW.dur : v); };

  // ---- scales (data)
  let topMaxData = 0;
  for (const v of top) if (v != null && v > topMaxData) topMaxData = v;
  const topStep = topKey === 'w' ? (topMaxData > 650 ? 200 : 100) : topMaxData > 60 ? 20 : 10;
  const topMax = Math.max(topStep * 2, Math.ceil((topMaxData * 1.06) / topStep) * topStep);
  let altMin = Infinity, altMax = -Infinity;
  if (alt) for (const v of alt) if (v != null) { if (v < altMin) altMin = v; if (v > altMax) altMax = v; }
  if (alt) {
    altMin = Math.floor(altMin / 50) * 50; altMax = Math.ceil(altMax / 50) * 50;
    if (altMax - altMin < 100) altMax = altMin + 100;
  }

  // ---- DOM
  el.innerHTML = '';
  const fig = document.createElement('figure');
  fig.className = 'rs-pc';
  fig.id = id;
  fig.innerHTML =
    `<figcaption class="rs-pc__cap"><span class="rs-pc__title"></span><span class="rs-pc__sub"></span>` +
    `<span class="rs-pc__keys" aria-hidden="true"><span class="rs-pc__key rs-pc__key--trend"></span><span class="rs-pc__key rs-pc__key--fine"></span></span></figcaption>` +
    `<div class="rs-pc__bar"></div>` +
    `<div class="rs-pc__stage" role="slider" tabindex="0" aria-valuemin="0">` +
    `<canvas class="rs-pc__base" aria-hidden="true"></canvas><canvas class="rs-pc__top" aria-hidden="true"></canvas>` +
    `<div class="rs-pc__tip" aria-hidden="true" hidden></div><div class="rs-pc__flash" aria-hidden="true"></div></div>` +
    `<div class="rs-pc__readsw"><p class="rs-pc__reads-h" aria-hidden="true"></p><dl class="rs-pc__reads"></dl></div>` +
    (showBests && hasW ? `<div class="rs-pc__bestsw"><p class="rs-pc__bests-h"></p><dl class="rs-pc__bests"></dl></div>` : '') +
    // round 3 (D24): no explanatory note under the chart (line styles, averaging, window method); the legend stays
    `<div class="rs-pc__foot"><button type="button" class="rs-pc__tbtn" aria-expanded="false" aria-controls="${id}-t"></button></div>` +
    `<div class="rs-pc__table" id="${id}-t" hidden></div>` +
    `<span class="rs-pc__probe" aria-hidden="true"></span>`;
  el.appendChild(fig);
  const $ = (s) => fig.querySelector(s);
  const stage = $('.rs-pc__stage'), base = $('.rs-pc__base'), topC = $('.rs-pc__top');
  const tip = $('.rs-pc__tip'), flashEl = $('.rs-pc__flash'), readsEl = $('.rs-pc__reads'), readsH = $('.rs-pc__reads-h');
  const bestsEl = $('.rs-pc__bests'), tBtn = $('.rs-pc__tbtn'), tBox = $('.rs-pc__table'), probe = $('.rs-pc__probe');
  const bctx = base.getContext('2d'), tctx = topC.getContext('2d');

  // ---- state
  let W = 0, H = 0, dpr = 1, P = null, A = null, strip = null, C = {}, reveal = 1, revealRaf = 0;
  let cursorI = null, hoverI = null, lastReadAt = 0, readTimer = 0, flashTimer = 0, labels = [];
  let ariaI = -1, ariaAt = 0, flashAt = -1e9, liveReads = null;
  const scrubFns = new Set(), toggleFns = new Set();

  // ---- helpers
  const xVal = (i) => (xMode === 'km' ? D.km[i] : D.t[i]);
  const xFill = (i) => (xMode === 'km' ? kmF[i] : D.t[i]);
  const px = (xv) => P.x + (xv / totalX) * P.w;
  const yTop = (v) => P.y + P.h - (Math.min(v, topMax) / topMax) * P.h;
  const yAlt = (v) => A.y + A.h - ((v - altMin) / (altMax - altMin)) * A.h;
  const fractionOfIndex = (i) => (tMax ? D.t[i] / tMax : 0);
  const indexOfFraction = (f) => Math.max(0, Math.min(n - 1, Math.round((f * tMax) / res)));
  function indexOfX(xv) {
    if (xMode === 't') return Math.max(0, Math.min(n - 1, Math.round(xv / res)));
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (kmF[mid] < xv) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function color(v, fallback) {
    probe.style.color = '';
    probe.style.color = v || fallback;
    return getComputedStyle(probe).color || fallback;
  }
  function readColors() {
    const cs = getComputedStyle(fig), g = (k, f) => color(cs.getPropertyValue(k).trim(), f);
    C = {
      ink: g('--rs-ch-ink', '#050505'), muted: g('--rs-ch-muted', '#6c655c'), surface: g('--rs-ch-surface', '#f5f3f0'),
      line: g('--rs-ch-line', '#1a1816'), altFill: g('--rs-ch-alt-fill', '#d8d0c2'), altLine: g('--rs-ch-alt-line', '#6c655c'),
      grid: g('--rs-ch-grid', 'rgba(108,101,92,.18)'), mark: g('--rs-ch-mark', '#c12a0b'),
    };
  }
  const localAt = (i) => (series.startLocal ? localPlus(series.startLocal, D.t[i]) : null);

  function shortLabel(m) {
    const v = m.value;
    switch (m.type) {
      case 'climb': return T.t('m.climb') + (v != null && m.unit === 'm' ? ' +' + T.nf(v) + ' m' : '');
      case 'sprint': return T.t('m.sprint') + (v != null && m.unit === 'W' ? ' ' + T.nf(v) + ' W' : '');
      case 'descent': return T.t('m.descent') + (v != null && m.unit === 'km/h' ? ' ' + T.nf(v, 1) + ' km/h' : '');
      case 'attack': case 'finale': case 'bell': case 'break': return T.t('m.' + m.type);
      default: {
        if (m.unit === 'km/h' && v != null) return T.t('m.topspeed', { v: T.nf(v, 1) });
        const s = T.L(m.label).split(':')[0];
        return s.length > 26 ? T.t('m.other') : s;
      }
    }
  }

  // ---- layout
  function layout() {
    const r = stage.getBoundingClientRect();
    W = Math.round(r.width); H = Math.round(r.height);
    if (!W || !H) return false;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [base, topC]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0); tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const narrow = W < 520;
    // labels stay right of the axis gutter (tick labels, unit)
    const padL = narrow ? 38 : 42, padR = 8, stripH = moments.length ? (narrow ? 26 : 34) : 6, axisH = 18;
    const gap = alt ? 10 : 0;
    const altH = alt ? Math.max(28, Math.round((H - stripH - axisH - gap) * 0.24)) : 0;
    strip = { x: padL, y: 2, w: W - padL - padR, h: stripH - 4, rows: narrow ? 1 : 2 };
    P = { x: padL, y: stripH, w: W - padL - padR, h: H - stripH - axisH - gap - altH };
    A = alt ? { x: padL, y: P.y + P.h + gap, w: P.w, h: altH } : null;
    placeLabels();
    return true;
  }

  function placeLabels() {
    labels = [];
    if (!moments.length) return;
    bctx.font = `500 11px ${SANS}`;
    const rows = [[], []], leaders0 = [];
    const order = moments.slice().sort((a, b) => (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9) || (b.value || 0) - (a.value || 0));
    for (const m of order) {
      if (labels.length >= 6) break;
      const text = shortLabel(m), w = bctx.measureText(text).width, x = px(xFill(m.i));
      const minX = P.x, maxX = strip.x + strip.w;
      // candidate anchors: text starting at the mark, then text ending at the mark
      const cands = [x - 1, x - w + 1].map((v) => Math.max(minX, Math.min(maxX - w, v)));
      let placed = false;
      for (let r = 0; r < strip.rows && !placed; r++) {
        for (const lx of cands) {
          const free = rows[r].every((b) => lx + w + 10 < b[0] || lx > b[1] + 10);
          // a row-0 leader runs down through row 1: keep row-1 text clear of it (and vice versa)
          const clear = r === 1 ? !leaders0.some((lx0) => lx0 >= lx - 6 && lx0 <= lx + w + 6) : !rows[1].some((b) => x >= b[0] - 6 && x <= b[1] + 6);
          if (free && clear) {
            rows[r].push([lx, lx + w]);
            if (r === 0) leaders0.push(x);
            labels.push({ m, text, lx, x, row: r, w });
            placed = true;
            break;
          }
        }
      }
    }
  }

  // ---- drawing
  function drawBase() {
    if (!P) return;
    const ctx = bctx;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    // horizontal grid + y labels (top panel)
    ctx.font = `500 10px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (let v = 0; v <= topMax + 0.001; v += topStep) {
      const y = Math.round(yTop(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? C.muted : C.grid; ctx.globalAlpha = v === 0 ? 0.55 : 1;
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = C.muted;
      ctx.fillText(T.nf(v), P.x - 6, y);
    }
    // unit: above the top tick label when moment marks own the plot's top edge, else inside the plot
    ctx.fillStyle = C.muted;
    if (moments.length) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(topKey === 'w' ? 'W' : 'km/h', P.x - 6, P.y - 7); }
    else { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(topKey === 'w' ? 'W' : 'km/h', P.x + 4, Math.round(yTop(topMax)) + 3); }
    // x ticks (time axis: race time from the race start)
    const target = Math.max(3, Math.floor(P.w / 70));
    let step;
    if (xMode === 'km') step = niceStep(totalX, target);
    else { const cands = [300, 600, 900, 1800, 3600, 7200, 10800, 14400]; step = cands.find((c) => totalX / c <= target) || 14400; }
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const yAxis = (A ? A.y + A.h : P.y + P.h) + 5;
    const x0 = xMode === 'km' ? 0 : r0;
    for (let v = x0; v <= totalX + 1e-6; v += step) {
      const x = Math.round(px(v)) + 0.5, first = v === x0;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, A ? A.y + A.h : P.y + P.h); ctx.stroke();
      let lab = xMode === 'km' ? T.nf(v, step < 1 ? 1 : 0) : hms(v - x0).replace(/:00$/, '');
      if (first) lab = xMode === 'km' ? '0 km' : '0:00 h';
      ctx.fillStyle = C.muted;
      ctx.textAlign = first ? 'left' : 'center';
      if (x + ctx.measureText(lab).width / 2 < W) ctx.fillText(lab, first ? Math.max(P.x, x - 0.5) : x, yAxis);
    }
    // altitude strip
    if (A) {
      ctx.save();
      ctx.beginPath(); ctx.rect(A.x, A.y, A.w, A.h); ctx.clip();
      const path = new Path2D();
      let open = false, sx = 0;
      const close = (x) => { path.lineTo(x, A.y + A.h); path.lineTo(sx, A.y + A.h); path.closePath(); };
      let lastX = 0;
      for (let i = 0; i < n; i++) {
        const xv = xVal(i), a = alt[i];
        if (xv == null || a == null) { if (open) { close(lastX); open = false; } continue; }
        const x = px(xv), y = yAlt(a);
        if (!open) { path.moveTo(x, A.y + A.h); path.lineTo(x, y); sx = x; open = true; } else path.lineTo(x, y);
        lastX = x;
      }
      if (open) close(lastX);
      ctx.fillStyle = C.altFill; ctx.fill(path);
      // climbs darker
      for (const m of moments) {
        if (m.type !== 'climb' || !m.duration_s) continue;
        const i1 = Math.min(n - 1, m.i + Math.round(m.duration_s / res));
        const x0 = px(xFill(m.i)), x1 = px(xFill(i1));
        ctx.save(); ctx.beginPath(); ctx.rect(x0, A.y, Math.max(1, x1 - x0), A.h); ctx.clip();
        ctx.globalAlpha = 0.38; ctx.fillStyle = C.altLine; ctx.fill(path); ctx.restore();
      }
      // line
      ctx.strokeStyle = C.altLine; ctx.lineWidth = 1; ctx.lineJoin = 'round';
      strokeSeries(ctx, (i) => (alt[i] == null ? null : yAlt(alt[i])));
      ctx.restore();
      ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText(T.nf(altMax), A.x - 6, A.y - 1);
      ctx.textBaseline = 'bottom'; ctx.fillText(T.nf(altMin), A.x - 6, A.y + A.h + 1);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('m', A.x + 4, A.y + 1);
    }
    // top line (revealed left to right)
    const revealX = P.x + P.w * reveal;
    ctx.save(); ctx.beginPath(); ctx.rect(P.x - 2, P.y - 4, revealX - P.x + 4, P.h + 8); ctx.clip();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = C.line; ctx.globalAlpha = 0.28; ctx.lineWidth = 1;
    strokeSeries(ctx, (i) => (top[i] == null ? null : yTop(top[i])));
    ctx.globalAlpha = 1; ctx.lineWidth = 1.75;
    strokeSeries(ctx, (i) => (trend[i] == null ? null : yTop(trend[i])));
    ctx.restore();
    // moments: marks, dots, labels
    ctx.textBaseline = 'alphabetic';
    for (const m of moments) {
      const x = px(xFill(m.i));
      if (x > revealX + 1) continue;
      ctx.fillStyle = C.mark;
      if (m.duration_s && m.duration_s >= 60 && (m.type === 'climb' || m.type === 'finale')) {
        const i1 = Math.min(n - 1, m.i + Math.round(m.duration_s / res));
        const x1 = px(xFill(i1));
        ctx.fillRect(x, P.y, Math.max(2, x1 - x), 2);
      }
      ctx.beginPath(); ctx.moveTo(x - 4, P.y); ctx.lineTo(x + 4, P.y); ctx.lineTo(x, P.y + 6); ctx.closePath(); ctx.fill();
    }
    ctx.font = `500 11px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (const L of labels) {
      if (L.x > revealX + 1) continue;
      const rowY = strip.y + (strip.rows === 2 ? (L.row === 0 ? 12 : 26) : 12);
      ctx.fillStyle = C.ink; ctx.fillText(L.text, L.lx, rowY);
      ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
      const lx = Math.round(L.x) + 0.5;
      ctx.beginPath(); ctx.moveTo(lx, rowY + 3); ctx.lineTo(lx, P.y); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  function strokeSeries(ctx, yOf) {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const xv = xVal(i), y = xv == null ? null : yOf(i);
      if (y == null) { pen = false; continue; }
      const x = px(xv);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawTop() {
    if (!P) return;
    const ctx = tctx;
    ctx.clearRect(0, 0, W, H);
    const yBot = A ? A.y + A.h : P.y + P.h;
    if (hoverI != null && hoverI !== cursorI) {
      const x = Math.round(px(xFill(hoverI))) + 0.5;
      ctx.strokeStyle = C.ink; ctx.globalAlpha = 0.32; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, yBot); ctx.stroke(); ctx.globalAlpha = 1;
      if (top[hoverI] != null) { ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(x, yTop(top[hoverI]), 3, 0, Math.PI * 2); ctx.fill(); }
    }
    if (cursorI != null) {
      const x = px(xFill(cursorI));
      ctx.strokeStyle = C.mark; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, yBot); ctx.stroke();
      if (top[cursorI] != null) {
        const y = yTop(top[cursorI]);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = C.surface; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = C.mark; ctx.fill();
      }
      if (A && alt[cursorI] != null) {
        ctx.beginPath(); ctx.arc(x, yAlt(alt[cursorI]), 3, 0, Math.PI * 2); ctx.fillStyle = C.mark; ctx.fill();
      }
    }
  }

  // ---- text parts
  function sample(i) {
    return {
      i, t: D.t[i], km: hasKm ? D.km[i] ?? kmF[i] : null, w30: hasW ? top[i] : null, w: hasW ? D.w[i] : null,
      cad: hasCad ? D.cad[i] : null, kph: hasKph ? D.kph[i] : null, kph30: !hasW ? top[i] : null,
      alt: alt ? alt[i] : null, local: localAt(i),
    };
  }

  // before the first play or scrub: the whole race (summary values the file has, max. altitude)
  function renderReads(i) {
    const live = i != null, sm = series.summary || {};
    let s;
    if (live) s = sample(i);
    else {
      let hi = null;
      if (alt) for (let k = 0; k < n; k++) if (alt[k] != null && D.t[k] >= RW.r0 && D.t[k] <= RW.r1 && (hi == null || alt[k] > hi)) hi = alt[k];
      s = { km: sm.distance_km, w: sm.avg_w, cad: sm.avg_cad, kph: sm.avg_kph, alt: hi };
    }
    const f = (v, d = 0) => (v == null ? '–' : T.nf(v, d));
    const items = [];
    if (hasKm) items.push(['km', s.km, f(s.km, 1), 'rd.km']);
    if (hasW) items.push(['w', live ? s.w30 : s.w, f(live ? s.w30 : s.w), live ? 'rd.w' : 'rd.s.w']);
    if (hasCad) items.push(['cad', s.cad, f(s.cad), live ? 'rd.cad' : 'rd.s.cad']);
    const kph = live ? (hasW ? s.kph : s.kph30) : s.kph;
    if (hasKph) items.push(['kph', kph, f(kph, 1), live ? (hasW ? 'rd.kph' : 'rd.kph30') : 'rd.s.kph']);
    if (alt) items.push(['alt', s.alt, s.alt != null ? T.nf(s.alt) + '\u00a0m' : '–', live ? 'rd.alt' : 'rd.s.alt']);
    items.push(['time', 1, live ? rt(s.t) : hms(RW.dur), 'rd.time']);
    readsEl.innerHTML = items.filter((x) => live || x[1] != null).map(([k, , v, key]) => `<div class="rs-pc__read rs-pc__read--${k}"><dt>${esc(T.t(key))}</dt><dd>${esc(v)}</dd></div>`).join('');
    readsEl.classList.toggle('is-live', live);
    readsEl.setAttribute('aria-label', readsH.textContent = T.t(live ? 'rd.label' : 'rd.whole'));
    liveReads = live;
  }

  function updateReads(i) {
    const vals = readsEl.querySelectorAll('dd');
    if (!vals.length || !liveReads) return renderReads(i);
    const s = sample(i), f = (v, d = 0) => (v == null ? '–' : T.nf(v, d));
    let k = 0;
    if (hasKm) vals[k++].textContent = f(s.km, 1);
    if (hasW) vals[k++].textContent = f(s.w30);
    if (hasCad) vals[k++].textContent = f(s.cad);
    if (hasKph) vals[k++].textContent = f(hasW ? s.kph : s.kph30, 1);
    if (alt) vals[k++].textContent = s.alt != null ? T.nf(s.alt) + ' m' : '–';
    vals[k].textContent = rt(s.t);
  }

  function renderBests() {
    if (!bestsEl) return;
    const b = series.bests || {};
    const keys = [['5s', '5 s'], ['1m', '1 min'], ['5m', '5 min'], ['20m', '20 min'], ['60m', '60 min']];
    // the heading sits outside the <dl> (a <dl> holds only dt/dd groups; axe definition-list)
    const items = keys.filter(([k]) => b[k] && b[k].w);
    bestsEl.parentNode.hidden = !items.length;
    bestsEl.parentNode.querySelector('.rs-pc__bests-h').textContent = T.t('pc.bests');
    bestsEl.innerHTML = items.map(([k, lab]) =>
      `<div class="rs-pc__best"><dt>${lab}</dt><dd>${esc(T.nf(b[k].w))}<small> W</small></dd></div>`).join('');
  }

  function setAria(i) {
    stage.setAttribute('aria-valuemax', xMode === 'km' ? totalX.toFixed(1) : String(Math.round(totalX)));
    if (i == null) i = Math.min(n - 1, Math.round(r0 / res));   // before any input: the start
    const s = sample(i);
    stage.setAttribute('aria-valuenow', xMode === 'km' ? (s.km || 0).toFixed(1) : String(s.t));
    const val = top[i] == null ? '' : T.nf(top[i]) + (topKey === 'w' ? ' W' : ' km/h');
    const parts = xMode === 'km'
      ? [T.t('pc.valuetext.km', { km: T.nf(s.km, 1), total: T.nf(totalX, 1) }), val, T.t('pc.valuetext.time', { time: rt(s.t) })]
      : [T.t('pc.valuetext.t', { time: rt(s.t), total: hms(RW.dur) }), val];
    stage.setAttribute('aria-valuetext', parts.filter(Boolean).join(', '));
    ariaI = i; ariaAt = performance.now();
  }

  function relabel() {
    const axis = T.t(xMode === 'km' ? 'pc.axis.km' : 'pc.axis.t');
    const sm = series.summary || {};
    const dist = sm.distance_km != null ? T.nf(sm.distance_km, 1) + ' km' : hms(sm.duration_s || tMax) + ' h';
    $('.rs-pc__title').textContent = T.t(hasW ? 'pc.cap.power' : 'pc.cap.speed', { axis });
    const subs = [];
    if (sm.distance_km != null) subs.push(T.nf(sm.distance_km, 1) + ' km');
    if (sm.duration_s) subs.push(hms(sm.duration_s) + ' h');
    if (hasW && sm.avg_w != null) subs.push('Ø ' + T.nf(sm.avg_w) + ' W');
    if (hasW && sm.np_w != null) subs.push('NP ' + T.nf(sm.np_w) + ' W');
    if (!hasW && sm.avg_kph != null) subs.push('Ø ' + T.nf(sm.avg_kph, 1) + ' km/h');
    if (sm.elev_gain_m != null) subs.push(T.nf(sm.elev_gain_m) + (T.lang() === 'en' ? ' m climbing' : ' Hm'));
    $('.rs-pc__sub').textContent = nb(subs.join(' · '));
    fig.setAttribute('aria-label', T.t(hasW ? 'pc.aria.power' : 'pc.aria.speed', { axis, dist, avg: hasW ? T.nf(sm.avg_w) : T.nf(sm.avg_kph, 1) }));
    const stepLab = xMode === 'km' ? '1 km' : '1 min', bigLab = xMode === 'km' ? '10 km' : '10 min';
    stage.setAttribute('aria-label', T.t('pc.slider', { step: stepLab, big: bigLab }));
    // the compact legend: bold line, thin line (the title names power or speed, and distance or time)
    $('.rs-pc__key--trend').textContent = T.t('pc.key.trend');
    $('.rs-pc__key--fine').textContent = T.t('pc.key.fine');
    tBtn.textContent = T.t(tBox.hidden ? 'pc.table.show' : 'pc.table.hide');
    renderReads(cursorI);
    renderBests();
    setAria(cursorI);
    tBox.innerHTML = tableHTML();
    if (layout()) { drawBase(); drawTop(); }
  }

  // ---- table view
  function tableHTML() {
    const sm = series.summary || {}, rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push([T.t(k, { res: sm.max_w_basis_s || res }), v]); };
    add('pc.s.duration', sm.duration_s ? hms(sm.duration_s) + ' h' : null);
    add('pc.s.distance', sm.distance_km != null ? T.nf(sm.distance_km, 1) + ' km' : null);
    add('pc.s.avgw', sm.avg_w != null ? T.nf(sm.avg_w) + ' W' : null);
    add('pc.s.np', sm.np_w != null ? T.nf(sm.np_w) + ' W' : null);
    add('pc.s.kj', sm.kj != null ? T.nf(sm.kj) + ' kJ' : null);
    add('pc.s.cad', sm.avg_cad != null ? T.nf(sm.avg_cad) + ' rpm' : null);
    add('pc.s.kph', sm.avg_kph != null ? T.nf(sm.avg_kph, 1) + ' km/h' : null);
    add('pc.s.maxkph', sm.max_kph != null ? T.nf(sm.max_kph, 1) + ' km/h' : null);
    add('pc.s.gain', sm.elev_gain_m != null ? T.nf(sm.elev_gain_m) + ' m' : null);
    add('pc.s.temp', sm.temp_device_c != null ? T.nf(sm.temp_device_c, 1) + ' °C' : null);
    let h = `<table class="rs-pc-t"><caption>${esc(T.t('pc.table.summary'))}</caption><tbody>` +
      rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + `</tbody></table>`;
    const b = series.bests || {};
    const bk = [['5s', '5 s'], ['1m', '1 min'], ['5m', '5 min'], ['20m', '20 min'], ['60m', '60 min']].filter(([k]) => b[k] && b[k].w);
    if (bk.length) {
      h += `<table class="rs-pc-t"><caption>${esc(T.t('pc.table.bests'))}</caption><thead><tr><th scope="col">${esc(T.t('pc.th.dur'))}</th>` +
        `<th scope="col">${esc(T.t('pc.power'))}</th><th scope="col">${esc(T.t('pc.th.time'))}</th>${hasKm ? `<th scope="col">km</th>` : ''}</tr></thead><tbody>` +
        bk.map(([k, lab]) => { const i = Math.min(n - 1, Math.round(b[k].t / res)); return `<tr><th scope="row">${lab}</th><td>${T.nf(b[k].w)} W</td><td>${rt(b[k].t)}</td>${hasKm ? `<td>${T.nf(kmF[i], 1)}</td>` : ''}</tr>`; }).join('') +
        `</tbody></table>`;
    }
    if (moments.length) {
      h += `<table class="rs-pc-t"><caption>${esc(T.t('pc.table.moments'))}</caption><thead><tr><th scope="col">${esc(T.t('pc.th.time'))}</th>${hasKm ? '<th scope="col">km</th>' : ''}` +
        `<th scope="col" class="rs-pc-t__txt">${esc(T.t('pc.th.type'))}</th><th scope="col" class="rs-pc-t__txt">${esc(T.t('pc.th.desc'))}</th></tr></thead><tbody>` +
        moments.map((m) => `<tr><td>${rt(m.t)}</td>${hasKm ? `<td>${T.nf(kmF[m.i], 1)}</td>` : ''}<td class="rs-pc-t__txt">${esc(T.t('m.' + (PRIORITY[m.type] != null ? m.type : 'other')))}</td><td class="rs-pc-t__txt">${esc(nb(T.L(m.label)))}</td></tr>`).join('') +
        `</tbody></table>`;
    }
    // profile in sections (the chart's data, coarse)
    const secs = [];
    if (xMode === 'km') {
      const stepKm = totalX > 120 ? 20 : totalX > 50 ? 10 : 5;
      const to = T.lang() === 'en' ? 'to' : 'bis';
      for (let a = 0; a < totalX - 0.05; a += stepKm) {
        const b = Math.min(totalX, a + stepKm);
        secs.push([indexOfX(a), indexOfX(b), `${T.nf(a)} ${to} ${T.nf(b, b < a + stepKm ? 1 : 0)} km`]);
      }
    } else {
      const stepS = totalX > 5 * 3600 ? 3600 : 1800, to = T.lang() === 'en' ? 'to' : 'bis';
      for (let a = r0; a < totalX; a += stepS) { const b = Math.min(totalX, a + stepS); secs.push([indexOfX(a), indexOfX(b), `${rt(a)} ${to} ${rt(b)}`]); }
    }
    const mean = (arr, a, b) => { let s = 0, c = 0; for (let i = a; i <= b; i++) if (arr && arr[i] != null) { s += arr[i]; c++; } return c ? s / c : null; };
    h += `<table class="rs-pc-t"><caption>${esc(T.t('pc.table.profile'))}</caption><thead><tr><th scope="col">${esc(T.t('pc.th.section'))}</th>` +
      (hasW ? `<th scope="col">Ø W</th>` : '') + (hasKph ? `<th scope="col">Ø km/h</th>` : '') + (alt ? `<th scope="col">${esc(T.t('pc.th.altEnd'))}</th>` : '') + `</tr></thead><tbody>` +
      secs.map(([a, b, lab]) => {
        const kk = D.kph ? D.kph.slice(a, b + 1).filter((v) => v != null && v > 2) : [];
        const kph = kk.length ? kk.reduce((s, v) => s + v, 0) / kk.length : null;
        let altEnd = null; if (alt) for (let i = b; i >= a; i--) if (alt[i] != null) { altEnd = alt[i]; break; }
        return `<tr><th scope="row">${esc(lab)}</th>` + (hasW ? `<td>${T.nf(mean(D.w, a, b))}</td>` : '') + (hasKph ? `<td>${T.nf(kph, 1)}</td>` : '') + (alt ? `<td>${altEnd == null ? '–' : T.nf(altEnd) + ' m'}</td>` : '') + `</tr>`;
      }).join('') + `</tbody></table>`;
    return h;
  }

  // ---- tooltip
  function showTip(i) {
    const s = sample(i);
    const lines = [];
    const head = [];
    if (hasKm) head.push('km ' + T.nf(s.km, 1));
    head.push(rt(s.t));
    if (s.local) head.push(T.t('pc.localtime', { clock: s.local.slice(11, 16) }));
    lines.push(`<div class="rs-pc__tip-h">${esc(head.join(' · '))}</div>`);
    if (hasW) {
      lines.push(`<div class="rs-pc__tip-v"><b>${s.w30 == null ? '–' : T.nf(s.w30)} W</b> <span>${esc(T.t('pc.mean30'))}</span></div>`);
      lines.push(`<div class="rs-pc__tip-v"><b>${s.w == null ? '–' : T.nf(s.w)} W</b> <span>${esc(T.t('pc.raw', { res }))}</span></div>`);
    } else if (hasKph) {
      lines.push(`<div class="rs-pc__tip-v"><b>${s.kph30 == null ? '–' : T.nf(s.kph30, 1)} km/h</b> <span>${esc(T.t('pc.mean30'))}</span></div>`);
      lines.push(`<div class="rs-pc__tip-v"><b>${s.kph == null ? '–' : T.nf(s.kph, 1)} km/h</b> <span>${esc(T.t('pc.raw', { res }))}</span></div>`);
    }
    const more = [];
    if (hasCad && s.cad != null) more.push(T.nf(s.cad) + ' rpm');
    if (hasW && hasKph && s.kph != null) more.push(T.nf(s.kph, 1) + ' km/h');
    if (s.alt != null) more.push(T.nf(s.alt) + ' m');
    if (more.length) lines.push(`<div class="rs-pc__tip-m">${esc(nb(more.join(' · ')))}</div>`);
    const near = moments.find((m) => Math.abs(px(xFill(m.i)) - px(xFill(i))) <= 12);
    if (near) lines.push(`<div class="rs-pc__tip-mo">${esc(nb(T.L(near.label)))}</div>`);
    tip.innerHTML = lines.join('');
    tip.hidden = false;
    const x = px(xFill(i)), tw = tip.offsetWidth || 180;
    const left = x + 14 + tw > W ? Math.max(0, x - 14 - tw) : x + 14;
    tip.style.setProperty('--x', left + 'px');
    tip.style.setProperty('--y', P.y + 6 + 'px');
  }
  function hideTip() { tip.hidden = true; }

  // ---- flash (moment label during replay)
  function flash(m) {
    if (!P) return;
    const i = Math.max(0, Math.min(n - 1, Math.round(m.t / res)));
    flashEl.textContent = nb(T.L(m.label));
    flashAt = performance.now();
    flashEl.classList.remove('is-on');
    const x = px(xFill(i));
    const fw = Math.min(W - 8, flashEl.offsetWidth || 220);
    flashEl.style.setProperty('--x', Math.max(4, Math.min(W - fw - 4, x - fw / 2)) + 'px');
    flashEl.style.setProperty('--y', P.y + 12 + 'px');
    void flashEl.offsetWidth;
    flashEl.classList.add('is-on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove('is-on'), 3400);
  }

  // ---- interaction
  const indexAtClientX = (cx) => {
    const r = stage.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (cx - r.left - P.x) / P.w));
    return indexOfX(f * totalX);
  };
  function scrubTo(i) {
    setCursor(fractionOfIndex(i));
    const f = fractionOfIndex(i);
    for (const fn of scrubFns) { try { fn(f); } catch (e) { console.error(e); } }
  }
  // Mouse and pen scrub from the press. Touch (pan-y): a vertical gesture only scrolls; a horizontal drag
  // (|dx| > 8 px and > |dy|) scrubs, a tap (< 250 ms, < 6 px) seeks, pointercancel changes nothing.
  let dragging = false, touch = null;
  function onMove(e) {
    if (!P) return;
    if (touch && !dragging) {
      const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
      if (e.pointerId !== touch.id || Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(dy)) return;
      dragging = true;
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    const i = indexAtClientX(e.clientX);
    if (dragging) scrubTo(i);
    if (e.pointerType !== 'touch' || dragging) { hoverI = i; showTip(i); drawTop(); }
  }
  function onDown(e) {
    if (!P || (e.button != null && e.button !== 0)) return;
    if (e.pointerType === 'touch') { touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }; return; }
    dragging = true;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const i = indexAtClientX(e.clientX);
    hoverI = i; scrubTo(i); showTip(i); drawTop();
  }
  function onUp(e) {
    const tc = touch;
    touch = null;
    if (tc && !dragging && e.type === 'pointerup' && e.pointerId === tc.id && performance.now() - tc.t < 250 &&
      Math.hypot(e.clientX - tc.x, e.clientY - tc.y) < 6) scrubTo(indexAtClientX(e.clientX));
    dragging = false;
    try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.pointerType === 'touch') { hoverI = null; hideTip(); drawTop(); }
  }
  function onLeave() { if (dragging) return; hoverI = null; hideTip(); drawTop(); }
  function onKey(e) {
    const i0 = cursorI == null ? 0 : cursorI;
    let xv = xFill(i0);
    const step = xMode === 'km' ? 1 : 60, big = xMode === 'km' ? 10 : 600;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': xv += step; break;
      case 'ArrowLeft': case 'ArrowDown': xv -= step; break;
      case 'PageUp': xv += big; break;
      case 'PageDown': xv -= big; break;
      case 'Home': xv = 0; break;
      case 'End': xv = totalX; break;
      case ' ': case 'Spacebar':
        e.preventDefault(); e.stopPropagation();
        for (const fn of toggleFns) { try { fn(); } catch (err) { console.error(err); } }
        return;
      default: return;
    }
    e.preventDefault(); e.stopPropagation();
    let i = indexOfX(Math.max(0, Math.min(totalX, xv)));
    if (i === i0 && (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp')) i = Math.min(n - 1, i0 + 1);
    if (i === i0 && (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown')) i = Math.max(0, i0 - 1);
    scrubTo(i);
  }
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('pointerleave', onLeave);
  stage.addEventListener('keydown', onKey);
  stage.addEventListener('blur', () => { if (hoverI != null && !dragging) { hoverI = null; hideTip(); drawTop(); } });
  tBtn.addEventListener('click', () => {
    const open = tBox.hidden;
    tBox.hidden = !open;
    if (open) tBox.innerHTML = tableHTML();
    tBtn.setAttribute('aria-expanded', String(open));
    tBtn.textContent = T.t(open ? 'pc.table.hide' : 'pc.table.show');
  });

  // ---- public
  function setCursor(fraction, meta) {
    if (fraction == null) { cursorI = null; drawTop(); renderReads(null); setAria(null); return; }
    const i = indexOfFraction(fraction);
    const changed = i !== cursorI;
    cursorI = i;
    drawTop();
    // aria-valuetext: at once after input, pause, end; while playing at most every 10 s, not right after a moment
    const now = performance.now();
    if (!(meta && meta.playing)) { if (ariaI !== i) setAria(i); }
    else if (now - ariaAt > 10000 && now - flashAt > 5000) setAria(i);
    if (!changed && liveReads) return;
    const apply = () => { lastReadAt = performance.now(); readTimer = 0; if (cursorI != null) updateReads(cursorI); };
    if (now - lastReadAt >= 83) apply();
    else if (!readTimer) readTimer = setTimeout(apply, 83 - (now - lastReadAt));
  }

  function draw({ reveal: r = 1, animate = false } = {}) {
    cancelAnimationFrame(revealRaf);
    if (!animate || reduced) { reveal = r; drawBase(); drawTop(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const t0 = performance.now(), dur = 1300, from = 0;
      const ease = (x) => 1 - Math.pow(1 - x, 3);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        reveal = from + (r - from) * ease(k);
        drawBase();
        if (k < 1) revealRaf = requestAnimationFrame(step); else resolve();
      };
      revealRaf = requestAnimationFrame(step);
      setTimeout(() => { if (reveal < r) { cancelAnimationFrame(revealRaf); reveal = r; drawBase(); } resolve(); }, dur + 400);
    });
  }

  function resize() { if (layout()) { drawBase(); drawTop(); if (!tip.hidden && hoverI != null) showTip(hoverI); } }
  function setTheme() { readColors(); if (P) { drawBase(); drawTop(); } }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(stage); else window.addEventListener('resize', resize);
  const offRoot = observeRoot(() => relabel(), () => setTheme());
  readColors();
  relabel();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (P && fig.isConnected) { placeLabels(); drawBase(); } });

  return {
    el: fig, controls: $('.rs-pc__bar'), xMode, series,
    draw, setCursor, resize, setTheme, relabel, tableHTML, flash,
    onScrub(fn) { scrubFns.add(fn); return () => scrubFns.delete(fn); },
    onToggle(fn) { toggleFns.add(fn); return () => toggleFns.delete(fn); },
    fractionOfIndex, sample: (f) => sample(indexOfFraction(f)),
    destroy() {
      cancelAnimationFrame(revealRaf); clearTimeout(flashTimer); clearTimeout(readTimer);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      offRoot(); scrubFns.clear(); toggleFns.clear();
      fig.remove();
    },
  };
}
