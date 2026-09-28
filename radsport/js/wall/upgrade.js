/**
 * wall/upgrade.js: a sharper wall file for the DOM tier (spec 8.1), loaded by main.js after idle, never in the WebGL tier
 * (its canvas covers the <img>, and renderer-gl.js albedo() fetches its own 2000 w texture when the <img> holds less).
 *
 * Phones take the 1200 w file for the LCP (render_static.py SIZES announces 300 px on phones). Here the <img> moves up
 * to the smallest srcset file that covers the wall's width in device pixels, at most 2000 w; never with Save-Data, never
 * to a smaller file. Where the browser reports LCP, the swap waits for the first input (after it the browser reports no
 * more LCP): a swapped file would otherwise count as a new, late LCP whenever the wall grew by a pixel after its first
 * paint. The file is decoded before the swap, so the wall does not flash, and with a normal cache the swap costs no
 * second request. renderer-dom.js refreshes its paper faces on the img's load event.
 *
 *   upgradeWall(img, { saveData, ready }) -> Promise<boolean>   ready: the wall's first load (main.js wallReady())
 */
const lcpReported = (() => { try { return PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint'); } catch (_) { return false; } })();

/** Resolves on the first input; at once if the page has had one (the Event Timing "first-input" entry, which only a real
 *  pointerdown or key creates; sticky user activation would not do: automation that evaluates with a user gesture sets it). */
function firstInput() {
  let had = false;
  try { had = performance.getEntriesByType('first-input').length > 0; } catch (_) { had = false; }
  if (had) return Promise.resolve();
  return new Promise((resolve) => {
    const evs = ['pointerdown', 'keydown', 'wheel', 'scroll'];
    const done = () => { for (const ev of evs) removeEventListener(ev, done, { capture: true }); resolve(); };
    for (const ev of evs) addEventListener(ev, done, { capture: true, passive: true });
  });
}

let running = null;

export function upgradeWall(img, { saveData = false, ready = null } = {}) {
  if (running) return running;
  running = (async () => {
    if (!img || saveData) return false;
    if (lcpReported) await firstInput();
    if (ready) await ready;
    const set = (img.getAttribute('srcset') || '').split(',').map((s) => s.trim().split(/\s+/))
      .map(([u, w]) => ({ u, abs: u ? new URL(u, document.baseURI).href : '', w: parseInt(w, 10) || 0 }))
      .filter((c) => c.u && c.w).sort((a, b) => a.w - b.w);
    if (set.length < 2) return false;
    const cur = img.currentSrc || img.src || '';
    const shown = set.find((c) => c.abs === cur);
    const px = shown ? shown.w : img.naturalWidth || 0;          // naturalWidth is CSS px with w descriptors
    const want = Math.min(2000, (img.offsetWidth || 0) * (window.devicePixelRatio || 1));
    const pick = set.find((c) => c.w >= want) || set[set.length - 1];
    if (!pick || pick.w <= px) return false;
    const pre = new Image();
    pre.decoding = 'async';
    pre.fetchPriority = 'low';                                  // the same click may be loading the sound engine
    pre.src = pick.abs;
    try { await pre.decode(); } catch (_) { return false; }    // offline or broken: the LCP file stays
    const swapped = new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
    img.srcset = `${pick.u} ${pick.w}w`;
    await Promise.race([swapped, new Promise((r) => setTimeout(r, 4000))]);
    if (img.decode) await img.decode().catch(() => {});
    return img.currentSrc === pick.abs;
  })().catch(() => false);
  return running;
}

export default { upgradeWall };
