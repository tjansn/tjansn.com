/**
 * art/hatch.js (round 2 fixes, package ui): „Ergänztes zeigen“ / "Show completed parts", loaded at the first use of the
 * toggle. A fine 135 deg hatch (1.25 px line every 7 CSS px) over the parts that are hidden on the wall photo, plus a
 * faint veil; graphite over light paper, light over dark print, nothing outside the sheet.
 *
 *   paintHatch(canvas, key, { draw, order, recon, full }, cssW, cssH, alive) -> Promise<boolean>
 *     key    the drawing (the card's exhibit key): the result is kept per key and size, so off and on again is free
 *     mask   recon (alpha when it has transparency, else brightness; white = completed), else the order map's B channel;
 *            full: the whole sheet (a twin's drawing, every line of it is completed for this number)
 *     alive  () -> false stops the work (the card was rebuilt or the toggle switched off)
 *   false: no mask, or stopped
 *
 * The per-pixel pass runs in slices of about 8 ms with a yield in between: in one task it took 80 to 136 ms on a
 * mid-range phone (the toggle's own response).
 */

const kept = new Map();          // `${key}|${W}x${H}` -> ImageData, the last two
const pause = () => (globalThis.scheduler && typeof scheduler.yield === 'function' ? scheduler.yield() : new Promise((r) => { setTimeout(r, 0); }));

export async function paintHatch(canvas, key, { draw, order, recon, full = false }, cssW, cssH, alive = () => true) {
  const mask = full ? draw : recon || order;
  if (!canvas || !draw || !mask || !(cssW > 0 && cssH > 0)) return false;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const W = Math.max(1, Math.round(cssW * dpr));
  const H = Math.max(1, Math.round(cssH * dpr));
  const id = `${key}|${W}x${H}|${full ? 1 : 0}`;
  let img = kept.get(id);
  if (!img) {
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const c = off.getContext('2d', { willReadFrequently: true });
    if (!c) return false;
    let m;
    let d;
    try {
      c.drawImage(mask, 0, 0, W, H);
      m = c.getImageData(0, 0, W, H).data;
      c.clearRect(0, 0, W, H);
      c.drawImage(draw, 0, 0, W, H);
      d = c.getImageData(0, 0, W, H).data;
    } catch (_) {
      return false;
    }
    let alphaMask = false;
    if (recon && !full) for (let i = 3; i < m.length; i += 4 * 7) { if (m[i] < 250) { alphaMask = true; break; } }
    img = new ImageData(W, H);
    const o = img.data;
    const period = 7 * Math.SQRT2 * dpr;      // 7 CSS px between the lines, measured across them
    const half = 0.625 * dpr;                 // half line width (1.25 CSS px)
    let t0 = performance.now();
    for (let y = 0; y < H; y += 1) {
      if (performance.now() - t0 > 8) {
        await pause();
        if (!alive()) return false;
        t0 = performance.now();
      }
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const a = d[i + 3] / 255;
        if (a < 0.02) continue;
        const raw = full ? 255 : recon ? (alphaMask ? m[i + 3] : (m[i] + m[i + 1] + m[i + 2]) / 3) : m[i + 2];
        let k = (raw / 255 - 0.35) / 0.3;
        if (k <= 0) continue;
        k = k >= 1 ? 1 : k * k * (3 - 2 * k);
        const f = (x + y) % period;
        const dist = Math.min(f, period - f) / Math.SQRT2;            // distance to the nearest line, in device px
        const line = Math.max(0, Math.min(1, half + 0.5 - dist));
        const under = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        const dark = under < 0.45;
        const alpha = k * a * (0.08 + (dark ? 0.62 : 0.5) * line);
        o[i] = dark ? 246 : 58;
        o[i + 1] = dark ? 243 : 55;
        o[i + 2] = dark ? 238 : 52;
        o[i + 3] = Math.round(alpha * 255);
      }
    }
    kept.set(id, img);
    while (kept.size > 2) kept.delete(kept.keys().next().value);
  }
  if (!alive()) return false;
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return true;
}

export default { paintHatch };
