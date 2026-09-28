/**
 * wall/renderer-gl.js (WP5): the WebGL2 tier of the wall (spec 3.6, 1.2 to 1.4, 5.2, 8.3), same WallRenderer
 * interface as renderer-dom.js. Wall px in and out; detach's quad in viewport px like stage.quadToScreen.
 * Each frame: wall pass (relief, lamp, house light, framing and recess from the id map, haze, ACES), paper
 * meshes of the moving sheets with shadows, pins, dust. z = 0 follows stage.toScreen, so the canvas stays in
 * register with the <img> and the hit layer. Details and deviations: build/notes/wp5.md.
 * Round 3 (D29): init({ room }) takes wall/room.js (or a promise of it); the wall pass then draws the café around
 * the photo from room.json: bricks relit through their normal map, the board frame and its contact shadow, the
 * pictures the room shows (a texture array), their brass lamps, lights, glass glare and bulbs.
 */
import { PROGRAMS } from './gl/shaders.js';
import {
  W, H, U, WU, HU, clamp, smooth, Spring, inPoly, prepBib, weight, buildGrid, shadowMask, pinGlyph, deform,
} from './gl/mesh.js';

const TIERS = {
  high: { dpr: 1.75, dust: 1500, fog: 6, flutter: true, tug: true, breathe: true },
  medium: { dpr: 1.5, dust: 400, fog: 0, flutter: false, tug: false, breathe: false },
};
const DEG = Math.PI / 180;
const FOV = 28 * DEG;
const LAMP = [-150, -760, 860];                  // lamp relative to its target: above left, in front (u)
const COS_IN = Math.cos(5.5 * DEG);
const COS_OUT = Math.cos(12.5 * DEG);
const HOVER_Z = 36;
const TAKEOFF_Z = 48;
const DROP_Z = 12;
const RISE = -4 * (TAKEOFF_Z / HOVER_Z);           // DOM tier: 4 u up per hover height
const TILT = Math.tan(4 * DEG);
const BOARD = [0.3, 0.315, 0.345];              // wall behind a vacated sheet (photo gaps, darker)
const NOBOX = [0, 0, -1, -1];
const lin = (hex) => [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
// r3: house light = room.json look.houseTint (set when the room loads); dark theme: a warm neutral, not blue
const WARM = lin('#ffe2bd');
const COOL = lin('#f1e6d6');
const LAMP_COL = lin('#fff0d8');
const FRAME_B = 136;                              // u: the board frame's strips (40 u, 54 at the bottom, its occlusion)

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const e = ((ax * t + bx) * t + cx) * t - x; const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(e) < 1e-5 || !d) break;
      t -= e / d;
    }
    t = clamp(t, 0, 1);
    return ((ay * t + by) * t + cy) * t;
  };
}
const cine = bezier(0.65, 0, 0.35, 1);
const easeOut = bezier(0.2, 0.7, 0.2, 1);
const gravity = bezier(0.5, 0, 0.9, 0.45);
const springy = bezier(0.16, 1, 0.3, 1);
const warn = (w, e) => { try { console.warn(`[radsport] renderer-gl ${w}:`, e); } catch (_) { /* */ } };
const xy = (p) => (Array.isArray(p) ? p : p ? [p.x, p.y] : null);

export function createRenderer(opts = {}) {
  const canvas = opts.canvas || document.querySelector('canvas.rs-gl');
  const host = opts.el || (canvas && canvas.parentElement);
  const img = opts.img || null;
  const store = opts.store || null;
  const bus = opts.bus || null;
  const q = new URLSearchParams(location.search);
  const forced = Boolean(TIERS[q.get('tier')]);
  const watch = q.has('watchdog') ? q.get('watchdog') !== '0' : !forced;
  let tier = opts.tier === 'medium' ? 'medium' : 'high';
  let cfg = TIERS[tier];
  let reduced = Boolean(store && store.get ? store.get().reducedMotion : opts.reducedMotion);
  let stage = opts.stage || null;

  let gl = null; let P = null; let vao = null; let tex = null;
  let B = [];
  const byId = new Map();
  const fallbacks = new Set();
  const offs = [];
  let ready = false; let paused = false; let disposed = false; let fell = null; let lost = false;
  let raf = 0; let last = 0; let skip = false; let frames = 0; let draftT = 0; let drag = null; let suppressT = 0;
  let inFrame = false; let again = false; let snaps = [];
  let extWind = false;
  const wd = { buf: new Float32Array(120), n: 0, prev: 0, skip: 8 };
  const F = { u_bib: new Float32Array(256), u_holes: new Float32Array(24) };
  const cache = { fb: null, tex: null, w: 0, h: 0, ok: false, key: new Float32Array(300), prev: new Float32Array(300), at: new Float32Array(300) };
  const st = {
    w: 1, h: 1, k: 1, m: { ox: 0, oy: 0, sx: 1, sy: 1, left: 0, top: 0 }, D: 3000, scaleX: 0,
    lamp: { tx: WU * 0.42, ty: HU * 0.4, sx: new Spring(7.5, 1, WU * 0.42), sy: new Spring(7.5, 1, HU * 0.4) },
    lampIn: null, aim: null, wander: false, wk: 0, wFrom: [0, 0], sweep: null,
    house: 0.14, houseT: 0.14, houseK: 1, houseSet: false, pool: 1, tint: WARM.slice(), tintFrom: WARM, tintTo: WARM, tintT0: 0,
    hover: null, pending: undefined, lit: new Set(), tugI: null, time: 0, lastInput: performance.now(), fast: 0,
    br: { on: false, p: 0, pT: 0, kph: 0, x: 0 }, drift: [0, 0], ptr: null, ptrIn: false, ptrWall: null, ptrT: 0,
    fine: typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches,
  };
  const idx = (id) => (id != null && byId.has(id) ? byId.get(id) : -1);
  // the room (round 3): textures, the pictures and lamps drawn (uniform arrays), their lights and bulbs
  const RM = {
    on: 0, rev: 0, info: null, t: null, done: new Set(), busy: null, np: 0, nl: 0, L: [0, 0, 0, 0], files: {},
    pa: new Float32Array(40), pb: new Float32Array(40), pu: new Float32Array(40), ps: new Float32Array(40), bulb: new Float32Array(16),
    lp: new Float32Array(16), ld: new Float32Array(16), lc: new Float32Array(8), lcol: lin('#ffcf8f'), glow: lin('#ffe2b0'),
    brickR: [-600, -263.5, 3200, 2000], frameR: [-40, -40, 2080, 1553], bshR: [-160, -160, 2320, 1793], bshad: [6, 24, 0.9, 0],
  };

  // -- GL plumbing
  function program(name) {
    const [vs, fs] = PROGRAMS[name];
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    ['a_p', 'a_w', 'a_wg'].forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.bindAttribLocation(p, 0, 'a_q');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i += 1) {
      const a = gl.getActiveUniform(p, i);
      u[a.name.replace(/\[0\]$/, '')] = { l: gl.getUniformLocation(p, a.name), t: a.type, n: a.size };
    }
    return { p, u };
  }
  function set(pr, name, v) {
    const u = pr.u[name];
    if (!u) return;
    switch (u.t) {
      case gl.FLOAT: if (u.n > 1) gl.uniform1fv(u.l, v); else gl.uniform1f(u.l, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.l, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.l, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.l, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.l, false, v); break;
      default: gl.uniform1i(u.l, v);
    }
  }
  const COMMON = ['u_res', 'u_map', 'u_wall', 'u_eye', 'u_lampPos', 'u_spotDir', 'u_lampCol', 'u_houseCol', 'u_cosIn', 'u_cosOut',
    'u_lampPow', 'u_range', 'u_house', 'u_pool', 'u_fog', 'u_time', 'u_vign', 'u_relief', 'u_bib', 'u_nl', 'u_lp', 'u_ld', 'u_lc', 'u_lcol', 'u_plk'];
  function use(pr) {
    gl.useProgram(pr.p);
    for (const k of COMMON) if (pr.u[k]) set(pr, k, F[k]);
  }
  /** kinds: alb (sRGB), nrm, id (nearest), pin, brick (sRGB) and bnrm (both repeat in x), lin (premultiplied sRGB
   *  values, decoded in the shader: correct edges under mipmapping) */
  function mkTex(src, kind) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE5);                     // spare unit
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, kind === 'pin');
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, kind === 'id' || kind === 'nrm' || kind === 'bnrm' ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, kind === 'alb' || kind === 'brick' ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const near = kind === 'id';
    if (!near) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, kind === 'brick' || kind === 'bnrm' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (/^(alb|nrm|brick|bnrm|lin)$/.test(kind)) aniso();
    return t;
  }
  function aniso() {
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  function buffer(data, attrs, index) {
    const v = gl.createVertexArray();
    gl.bindVertexArray(v);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const stride = attrs.reduce((s, n) => s + n, 0) * 4;
    let off = 0;
    attrs.forEach((n, i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, stride, off); off += n * 4; });
    if (index) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW); }
    gl.bindVertexArray(null);
    return v;
  }
  async function bitmap(url, raw, pm) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return createImageBitmap(await res.blob(), { premultiplyAlpha: pm ? 'premultiply' : 'none', colorSpaceConversion: raw ? 'none' : 'default' });
  }
  /**
   * The <img> itself when its file is sharp enough for the lamp (and the dolly), else the next size of its srcset
   * (>= 2000), never a smaller file than the one on screen (spec 8.1: the albedo reuses the <img> source).
   * With w descriptors naturalWidth is density-corrected (CSS px, the sizes value: 300 on a phone for any file), so the
   * real pixel width is the w of the srcset candidate that currentSrc names. Phones show the 1200 w LCP file, so the
   * tier fetches 2000 w here (a real upgrade); tablets and desktops show 2000 w or 2800 w, which it reuses.
   */
  async function albedo(el) {
    const need = Math.max(2000, st.m.sx * WU * st.k * 1.12 * 0.9);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    if (el && el.decode) await el.decode().catch(() => {});
    const set0 = ((el && el.getAttribute('srcset')) || '').split(',').map((s) => s.trim().split(/\s+/))
      .map(([u, w]) => ({ u: u ? new URL(u, document.baseURI).href : '', w: parseInt(w, 10) || 0 }))
      .filter((c) => c.u && c.w).sort((a, b) => a.w - b.w);
    const cur = (el && (el.currentSrc || el.src)) || '';
    const shown = set0.find((c) => c.u === cur);
    const px = shown ? shown.w : (el && el.naturalWidth) || 0;
    if (el && px >= need && px <= max) return el;
    const fit = set0.filter((c) => c.w <= max);
    const pick = fit.find((c) => c.w >= need) || fit[fit.length - 1];
    if (!pick || (el && pick.w <= px && px <= max)) return el;
    return bitmap(pick.u, false);
  }

  // -- the room (round 3, D29): 1 x 1 stand-ins first (no sampler of the wall pass is ever unbound), then room.json's
  // files; pictures and their lamp share one texture array per map (layer = index in room.json, the lamp last)
  const A2 = () => gl.TEXTURE_2D_ARRAY;
  function bindNew(target) { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE5); gl.bindTexture(target, t); return t; }
  function tex1(c, srgb) {
    const t = bindNew(gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(c));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    return t;
  }
  function texArr(w, h, n) {
    const t = bindNew(A2()); const lv = Math.floor(Math.log2(Math.max(w, h, 1))) + 1;
    gl.texStorage3D(A2(), lv, gl.RGBA8, w, h, n);
    gl.texParameteri(A2(), gl.TEXTURE_MIN_FILTER, lv > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(A2(), p, gl.CLAMP_TO_EDGE);
    return Object.assign(t, { w, h });
  }
  function roomTex() {
    RM.t = { brick: tex1([3, 3, 3, 255], true), brickN: tex1([128, 128, 255, 255]), frame: tex1([0, 0, 0, 0]), frameN: tex1([128, 128, 0, 255]),
      frameV: tex1([0, 0, 0, 0]), frameNV: tex1([128, 128, 0, 255]), bsh: tex1([0, 0, 0, 0]), pics: texArr(1, 1, 1), picsN: texArr(1, 1, 1) };
  }
  function swapTex(key, t) { gl.deleteTexture(RM.t[key]); RM.t[key] = t; }
  /** r3: only the board frame's strips go to the GPU (about 5 instead of 17 MB); the shader's frameAt() picks one */
  async function strips(b) {
    const W = b.width; const H = b.height; const d = Math.round((FRAME_B * W) / 2080);
    const cut = (x, y, w, h) => createImageBitmap(b, x, y, w, h);
    const [t, bo, l, r] = await Promise.all([cut(0, 0, W, d), cut(0, H - d, W, d), cut(0, d, d, H - 2 * d), cut(W - d, d, d, H - 2 * d)]);
    const up = (w, h, parts) => {
      const x = bindNew(gl.TEXTURE_2D);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
      for (const [m, ox, oy] of parts) gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, gl.RGBA, gl.UNSIGNED_BYTE, m);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      aniso();
      return x;
    };
    const out = gl && !disposed ? [up(W, 2 * d, [[t, 0, 0], [bo, 0, d]]), up(2 * d, H - 2 * d, [[l, 0, 0], [r, d, 0]])] : null;
    for (const m of [t, bo, l, r]) close(m);
    return out;
  }
  const close = (b) => b && b.close && b.close();
  /** Load what the room shows now (serialised); then the uniforms; kick. */
  function roomLoad(info) {
    RM.busy = (RM.busy || Promise.resolve()).then(async () => {
      if (!info || !gl || disposed || lost) return;
      const j = info.json; const url = info.url; const jobs = []; const later = [];
      // r3: relief maps follow (lazy); phones (pan: thin strips of bricks) never fetch them
      const file = (key, f, kind, raw, pm, lazy) => {
        if (!f || RM.files[key] === f || RM.files[key] === `~${f}`) return;
        if (lazy) RM.files[key] = `~${f}`;
        (lazy ? later : jobs).push(bitmap(url(f), raw, pm).then(async (b) => {
          const two = /^frame/.test(key) && gl && !disposed ? await strips(b) : null;
          if (gl && !disposed) {
            if (two) { swapTex(key, two[0]); swapTex(`${key}V`, two[1]); } else swapTex(key, mkTex(b, kind));
            RM.files[key] = f;
          }
          close(b);
        }));
      };
      const b = j.board || {}; const flat = stage && stage.mode === 'pan';
      file('brick', info.bricks, 'brick');
      if (!flat) file('brickN', j.bricks && j.bricks.normal && j.bricks.normal.file, 'bnrm', true, false, true);
      file('frame', b.frame && b.frame.file, 'lin', false, true);
      if (!flat) file('frameN', b.normal && b.normal.file, 'nrm', true, false, true);
      file('bsh', b.shadow && b.shadow.file, 'lin', false, true);
      if (later.length) Promise.all(later).then(() => { if (gl && !disposed) { RM.rev += 1; kick(); } }, (e) => warn('room', e));
      const pics = j.pictures || [];
      const lamp = (j.fixtures || [])[0];
      const all = lamp ? [...pics, lamp] : pics;
      const want = info.pictures.map((p) => pics.indexOf(p)).concat(lamp && info.fixtures.length ? [pics.length] : []).filter((k) => k >= 0 && !RM.done.has(k));
      if (want.length) {
        if (!RM.sz) {                                  // one array per map, sized for the largest picture
          const mx = (f) => [Math.max(...all.map((p) => f(p)[0])), Math.max(...all.map((p) => f(p)[1]))];
          const [aw, ah] = mx((p) => p.px || [512, 512]); const [nw, nh] = mx((p) => p.pxNormal || p.px || [256, 256]);
          swapTex('pics', texArr(aw, ah, all.length)); swapTex('picsN', texArr(nw, nh, all.length));
          RM.sz = []; RM.szN = [];
        }
        const up = (t, k, bmp) => {
          const w = Math.min(bmp.width, t.w); const h = Math.min(bmp.height, t.h);
          gl.activeTexture(gl.TEXTURE5); gl.bindTexture(A2(), t);
          gl.texSubImage3D(A2(), 0, 0, 0, k, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          return [w, h];
        };
        await Promise.all(want.map(async (k) => {
          const p = all[k];
          const [a, n] = await Promise.all([bitmap(url(p.file), false, true), bitmap(url(p.normal || p.file), true)]);
          if (gl && !disposed) { RM.sz[k] = up(RM.t.pics, k, a); RM.szN[k] = up(RM.t.picsN, k, n); RM.done.add(k); }
          close(a); close(n);
        }));
        if (!gl || disposed) return;
        for (const t of [RM.t.pics, RM.t.picsN]) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(A2(), t); gl.generateMipmap(A2()); }
      }
      await Promise.all(jobs);
      if (!gl || disposed) return;
      roomUniforms(info, pics);
      kick();
    }).catch((e) => warn('room', e));
    return RM.busy;
  }
  function roomUniforms(info, pics) {
    const j = info.json; const b = j.board || {}; const br = j.bricks || {}; const sh = b.shadow || {};
    if (br.originU && br.sizeU) RM.brickR = [...br.originU, ...br.sizeU];
    if (b.frame && b.frame.rect) RM.frameR = b.frame.rect;
    if (sh.rect) RM.bshR = sh.rect;
    RM.bshad = [...(sh.offsetU || [6, 24]), RM.files.bsh ? sh.opacity ?? 0.9 : 0, 0];
    let n = 0;
    const put = (p, k, kind, sh) => {
      if (!RM.done.has(k) || n >= 10) return;
      const a = ((p.rotation || 0) * Math.PI) / 180; const T = RM.t;
      RM.pa.set([p.x + p.w / 2, p.y + p.h / 2, p.w / 2, p.h / 2], n * 4);
      RM.pb.set([Math.cos(a), Math.sin(a), k, kind], n * 4);
      RM.pu.set([RM.sz[k][0] / T.pics.w, RM.sz[k][1] / T.pics.h, RM.szN[k][0] / T.picsN.w, RM.szN[k][1] / T.picsN.h], n * 4);
      RM.ps.set([sh.dx ?? 3, sh.dy ?? 12, sh.blur ?? 14, sh.opacity ?? 0.6], n * 4);
      n += 1;
    };
    if (j.look && /^#[0-9a-f]{6}$/i.test(j.look.houseTint || '')) WARM.splice(0, 3, ...lin(j.look.houseTint));
    // kind 2: no lamp of its own
    for (const p of info.pictures) put(p, pics.indexOf(p), info.lights.some((l) => l.for === p.id) ? 0 : 2, p.shadow || {});
    for (const f of info.fixtures) put(f, pics.length, 1, { dx: 2, dy: 9, blur: 10, opacity: 0.5 });
    RM.np = n;
    RM.bulb.fill(0); RM.lp.fill(0); RM.ld.fill(0); RM.lc.fill(0);
    let nb = 0;
    for (const f of info.fixtures) if (RM.done.has(pics.length) && f.bulb && nb < 4) RM.bulb.set([f.bulb[0], f.bulb[1], (f.glow && f.glow.r) || 14, 1], 4 * nb++);
    let nl = 0;
    for (const l of info.lights) {
      if (nl >= 4 || !info.pictures.some((p) => p.id === l.for && RM.done.has(pics.indexOf(p)))) continue;
      const d = Math.hypot(...l.dir) || 1;
      RM.lp.set([...l.pos, (l.pow ?? 1.6) * 0.82], nl * 4);   // a touch under the mock: the page's lamps sit on a flat wall
      RM.ld.set([l.dir[0] / d, l.dir[1] / d, l.dir[2] / d, l.range ?? 420], nl * 4);
      RM.lc.set([Math.cos(((l.out ?? 40) * Math.PI) / 180), Math.cos(((l.in ?? 16) * Math.PI) / 180)], nl * 2);
      if (l.col) RM.lcol = lin(l.col);
      nl += 1;
    }
    RM.nl = nl;
    RM.on = RM.files.brick ? 1 : 0;
    RM.rev += 1;
  }
  /** init's part: wait (bounded) for wall/room.js and its first files, so the canvas fades in with the room drawn. */
  async function roomStart(src, until) {
    const left = () => new Promise((r) => setTimeout(r, Math.max(0, until - performance.now())));
    try {
      const r = await Promise.race([Promise.resolve(src), left().then(() => null)]);
      if (!r || disposed) return;
      await Promise.race([r.ready, left()]);
      if (typeof r.on === 'function') offs.push(r.on('change', (inf) => roomLoad(inf)));
      await Promise.race([roomLoad(r.info && r.info()), left()]);
    } catch (e) { warn('room', e); }
  }

  // -- mapping (stage) and projection
  function measure() {
    const r = host.getBoundingClientRect();
    let a = null; let b = null;
    if (stage && typeof stage.toScreen === 'function') {
      try { a = xy(stage.toScreen(0, 0)); b = xy(stage.toScreen(W, H)); } catch (_) { a = null; }
    }
    if (!a || !b || !(b[0] - a[0] > 0)) {
      const ir = img ? img.getBoundingClientRect() : r;
      a = [ir.left, ir.top]; b = [ir.right, ir.bottom];
    }
    const m = st.m;
    m.left = r.left; m.top = r.top; m.ox = a[0] - r.left; m.oy = a[1] - r.top;
    m.sx = (b[0] - a[0]) / WU || 1; m.sy = (b[1] - a[1]) / HU || m.sx;
    st.D = (st.h / 2) / Math.tan(FOV / 2) / m.sy;
    st.scaleX = Math.max(0, (1.03 * (st.D - HOVER_Z)) / st.D - 1);
  }
  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, r.width); const h = Math.max(1, r.height);
    const cap = tier === 'medium' && w * h < 520000 ? 2 : cfg.dpr;
    const dpr = Math.min(window.devicePixelRatio || 1, cap, Math.sqrt(3.6e6 / (w * h)));
    const cw = Math.max(1, Math.round(w * dpr)); const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    st.w = w; st.h = h; st.k = cw / w;
  }
  /** Off-axis perspective: the plane z = 0 maps exactly as the stage maps the wall; the eye hovers over (ex, ey). */
  function vp(ex, ey) {
    const m = st.m;
    const ax = (2 * m.sx) / st.w; const bx = (2 * m.ox) / st.w - 1; const ay = (-2 * m.sy) / st.h; const by = 1 - (2 * m.oy) / st.h;
    const iD = 1 / st.D;
    return new Float32Array([ax, 0, 0, 0, 0, ay, 0, 0, -(ax * ex + bx) * iD, -(ay * ey + by) * iD, 0, -iD, bx, by, 0, 1]);
  }
  function project(x, y, z, ex, ey) {
    const m = st.m; const k = st.D / (st.D - z);
    return [m.left + m.ox + (ex + (x - ex) * k) * m.sx, m.top + m.oy + (ey + (y - ey) * k) * m.sy];
  }
  function toWallU(cx, cy) {
    let p = null;
    if (stage && typeof stage.toWall === 'function') { try { p = xy(stage.toWall(cx, cy)); } catch (_) { p = null; } }
    if (p) return [p[0] / U, p[1] / U];
    const m = st.m;
    return [(cx - m.left - m.ox) / m.sx, (cy - m.top - m.oy) / m.sy];
  }

  // -- sheets
  function sheet(g) {
    return {
      g, vao: null, count: 0, mask: null, maskBox: null,
      lift: new Spring(11, 0.72), frame: 0, raise: 0, raiseV: 0, free: 0, sk: 0, drop: null, off: null,
      flut: 0, fk: 1.25, phase: Math.random() * 6, dir: [0.8, 0.6], gust: 0,
      tug: [new Spring(13.04, 0.5), new Spring(13.04, 0.5), new Spring(13.04, 0.46)], grab: g.c.slice(), tilt: [0, 0],
      vac: 0, vacT0: 0, hidden: false, detached: false, hold: 0, handT: 0, pins: { mode: 'off', t0: 0, a0: 1 },
      P: { bulge: 0, raise: 0, free: 0, scale: 0, shift: [0, 0], tilt: [0, 0], flut: [0, 0, 1, 0], tug: [0, 0, 0, 0], tugZ: 0 },
    };
  }
  function pose(b) {
    const P0 = b.P; const L = Math.max(0, b.lift.x);
    P0.bulge = HOVER_Z * L + 8 * b.gust;
    P0.raise = b.raise; P0.free = b.free;
    const k48 = st.D / (st.D - TAKEOFF_Z);                // raised pose = the DOM tier's
    P0.scale = st.scaleX * L + ((1 + 0.03 * (TAKEOFF_Z / HOVER_Z) * b.g.amount) / k48 - 1) * b.sk;
    P0.shift[0] = 0; P0.shift[1] = (RISE / k48) * b.sk;
    P0.tilt[0] = b.tilt[0] * L; P0.tilt[1] = b.tilt[1] * L;
    P0.flut[0] = b.flut * 19; P0.flut[1] = b.phase; P0.flut[2] = b.dir[0]; P0.flut[3] = b.dir[1];
    P0.tug[0] = b.grab[0]; P0.tug[1] = b.grab[1]; P0.tug[2] = b.tug[0].x; P0.tug[3] = b.tug[1].x; P0.tugZ = Math.max(0, b.tug[2].x);
    return P0;
  }
  const height = (b) => HOVER_Z * 0.9 * Math.max(0, b.lift.x) + b.raise + b.flut * 12 + Math.max(0, b.tug[2].x) + 8 * b.gust;
  const tugging = (b) => b.tug.some((s) => Math.abs(s.x) > 0.02 || s.busy(0.02));
  const active = (b) => !b.hidden && (b.lift.x > 1e-3 || b.lift.busy() || b.raise > 0.02 || b.free > 1e-3 || b.flut > 0 || b.gust > 0 || tugging(b));
  function mesh(b) {
    if (b.vao) return;
    const { verts, idx: index } = buildGrid(b.g);
    b.vao = buffer(verts, [2, 1, 2], index);
    b.count = index.length;
    const m = shadowMask(b.g);
    b.mask = mkTex(m.canvas, 'mask');
    b.maskBox = m.box;
  }
  function pinsTo(b, mode, t0) {
    const ps = b.pins;
    if (!b.g.pins.length) return;
    if (mode === 'hide') { if (ps.mode === 'off' || ps.mode === 'gone' || ps.mode === 'hide') return; ps.a0 = 1; }
    ps.mode = mode; ps.t0 = t0;
  }

  // -- simulation
  function blow(vx, vy, x, y, dt) {
    if (!cfg.flutter || reduced || !ready) return;
    const sp = Math.hypot(vx, vy);
    const g = smooth(350, 3500, sp);
    if (g <= 0) return;
    const dir = [vx / sp, vy / sp];
    for (const b of B) {
      if (b.hidden || b.g.i === st.hover) continue;
      const inf = Math.exp(-((Math.hypot(b.g.c[0] - x, b.g.c[1] - y) / 320) ** 2));
      if (inf < 0.02) continue;
      b.flut = Math.min(1, b.flut + g * inf * dt * 7); b.fk = 1.25; b.dir = dir;
    }
    kick();
  }
  function noteInput(now) { st.lastInput = now; }
  const hurry = (ms = 1500) => { st.fast = Math.max(st.fast, performance.now() + ms); };   // a transition runs at full rate
  function scheduleDraft(ms) {
    clearTimeout(draftT);
    if (!disposed && !fell) draftT = setTimeout(draft, ms ?? 9000 + Math.random() * 5000);
  }
  function draft() {                                  // 5.2: idle 9-14 s -> one sheet stirs, 6 u, 1.2 s
    const quiet = performance.now() - st.lastInput;
    if (quiet < 9000) { scheduleDraft(9000 - quiet + Math.random() * 5000); return; }
    if (ready && !paused && !reduced && !document.hidden) {
      const c = B.filter((b) => !b.hidden && !b.off && b.g.i !== st.hover && !st.lit.has(b.g.i) && b.flut < 0.05);
      if (c.length) {
        const b = c[Math.floor(Math.random() * c.length)];
        const a = Math.random() * Math.PI * 2;
        b.flut = 6 / 19; b.fk = 3.2; b.dir = [Math.cos(a), Math.sin(a)];
        kick();
      }
    }
    scheduleDraft();
  }
  function endSweep() {
    const s = st.sweep;
    if (!s) return;
    st.sweep = null;
    clearTimeout(s.timer);
    s.resolve();
  }
  function driftStep(dt) {
    if (!stage || typeof stage.drift !== 'function') return false;
    const open = B.some((b) => b.detached || b.off) || Boolean(store && store.get && store.get().open);
    const on = !reduced && st.fine && st.ptrIn && st.ptr && stage.mode !== 'pan' && !open;
    const tx = on ? -((st.ptr[0] - st.m.left) / st.w - 0.5) * 26 * U : 0;
    const ty = on ? -((st.ptr[1] - st.m.top) / st.h - 0.5) * 18 * U : 0;
    const d = st.drift; const k = 1 - Math.exp(-2.2 * dt);
    const nx = d[0] + (tx - d[0]) * k; const ny = d[1] + (ty - d[1]) * k;
    const snap = Math.abs(tx - nx) < 0.05 && Math.abs(ty - ny) < 0.05;
    const fx = snap ? tx : nx; const fy = snap ? ty : ny;
    if (fx === d[0] && fy === d[1]) return false;
    d[0] = fx; d[1] = fy;
    try { stage.drift(fx, fy); } catch (_) { /* older stage */ }
    return !snap;
  }

  function stepSheet(b, dt, now) {
    const g = b.g;
    if (b.detached && !b.hidden && now >= b.handT) { b.hidden = true; b.off = null; }   // the flyer has taken over
    const hov = (st.hover === g.i || now < b.hold) && !b.hidden;
    const fT = (hov || st.lit.has(g.i)) && !b.hidden ? 1 : 0;
    b.frame += (fT - b.frame) * (1 - Math.exp(-(fT > b.frame ? 6 : 9) * dt));
    if (Math.abs(fT - b.frame) < 1e-3) b.frame = fT;
    let busy = b.frame !== fT;
    b.lift.t = hov && !b.off ? 1 : 0;
    if (reduced) b.lift.set(b.lift.t); else b.lift.step(dt);
    if (b.lift.x < 0) { b.lift.x = 0; if (b.lift.v < 0) b.lift.v *= -0.3; }
    if (b.lift.busy()) busy = true;
    let tx = 0; let ty = 0;
    const p = st.ptrWall;
    if (hov && !reduced && p && now - st.ptrT < 4000 && inPoly(p[0], p[1], g.poly)) {
      tx = TILT * clamp((p[0] - g.c[0]) / g.R, -1, 1); ty = TILT * clamp((p[1] - g.c[1]) / g.R, -1, 1);   // pointer side up (as DOM)
    }
    const kt = 1 - Math.exp(-8 * dt);
    b.tilt[0] += (tx - b.tilt[0]) * kt; b.tilt[1] += (ty - b.tilt[1]) * kt;
    if (Math.abs(tx - b.tilt[0]) + Math.abs(ty - b.tilt[1]) > 1e-4) busy = true;
    if (b.off) {                                      // take-off: pins out, the sheet frees itself and rises to 48 u
      const t = now - b.off.t0;
      b.free = Math.max(b.free, smooth(30, 280, t)); b.sk = b.free;
      b.raiseV += (196 * (TAKEOFF_Z - b.raise) - 22.4 * b.raiseV) * dt;
      b.raise += b.raiseV * dt;
      busy = true;
    } else if (b.drop) {                              // attach: gravity from 12 u, one inelastic bounce (0.25)
      b.raiseV -= 496 * dt; b.raise += b.raiseV * dt;
      if (b.raise <= 0) {
        b.raise = 0;
        if (b.drop.slap && b.raiseV < -30) { b.raiseV *= -0.25; b.drop.slap = false; b.flut = Math.max(b.flut, 0.3); b.fk = 2.5; } else { b.raiseV = 0; b.drop = null; }
      }
      busy = true;
    } else if (b.raise > 0 || b.raiseV) {
      b.raiseV += (-170 * b.raise - 23 * b.raiseV) * dt; b.raise += b.raiseV * dt;
      if (b.raise < 0.02 && Math.abs(b.raiseV) < 0.5) { b.raise = 0; b.raiseV = 0; }
      busy = true;
    }
    if (!b.off && !b.hidden && (b.free > 0 || b.sk > 0) && !b.drop && b.pins.mode !== 'back') {
      b.free = Math.max(0, b.free - dt / 0.35); b.sk = Math.max(0, b.sk - dt / 0.35); busy = true;
    }
    if (b.flut > 0) {
      b.flut *= Math.exp(-b.fk * dt); b.phase += dt * (4.5 + 8 * b.flut);
      if (b.flut < 3e-3) b.flut = 0;
      busy = true;
    }
    if (b.gust > 0) { b.gust *= Math.exp(-2.5 * dt); if (b.gust < 3e-3) b.gust = 0; busy = true; }
    for (const s of b.tug) { if (reduced) s.set(0); else s.step(dt); if (s.busy(0.02)) busy = true; }
    if (b.detached || b.off) {
      b.vac = reduced ? 1 : Math.max(b.vac, smooth(80, 400, now - b.vacT0));
      if (b.vac < 1) busy = true;
    } else if (b.vac > 0) { b.vac = Math.max(0, b.vac - dt / 0.3); busy = true; }
    const ps = b.pins; const n = g.pins.length;
    if (n) {
      if (ps.mode === 'show' && now - ps.t0 < (n - 1) * 62 + 760) busy = true;
      else if (ps.mode === 'hide') { if (now - ps.t0 >= 120) ps.mode = 'off'; busy = true; }
      else if (ps.mode === 'pop') { if (now - ps.t0 >= (n - 1) * 62 + 400) ps.mode = 'gone'; busy = true; }
      else if (ps.mode === 'back') {
        if (now - ps.t0 >= (n - 1) * 75 + 640) {
          if (hov) { ps.mode = 'show'; ps.t0 = now - 1e4; } else pinsTo(b, 'hide', now);
        }
        busy = true;
      }
    }
    return busy;
  }

  function step(dt, now) {
    st.time += dt;
    let busy = false;
    const L = st.lamp;
    if (st.sweep) {
      const s = st.sweep; const k = clamp((now - s.t0) / s.dur, 0, 1); const e = cine(k);
      const arc = Math.sin(Math.PI * k) * 60;
      L.tx = s.from[0] + (s.to[0] - s.from[0]) * e + s.n[0] * arc;
      L.ty = s.from[1] + (s.to[1] - s.from[1]) * e + s.n[1] * arc;
      if (cfg.flutter && !reduced) {
        for (const b of B) {
          if (b.hidden) continue;
          const d = Math.hypot(b.g.c[0] - L.tx, b.g.c[1] - L.ty);
          if (d < 200) { const f = 1 - d / 200; b.flut = Math.min(1, b.flut + dt * 8 * f); b.fk = 1.25; b.gust = Math.max(b.gust, f); b.dir = s.dir; }
        }
      }
      if (k >= 1) endSweep();
      busy = true;
    } else if (st.wander) {
      st.wk = Math.min(1, st.wk + dt / 2.5);
      const t = st.time; const e = smooth(0, 1, st.wk);
      const v = stage && typeof stage.view === 'function' ? stage.view() : null;   // R1-wall-7: over what is on screen
      const wx = (v ? v.x0 / U : 0) + (v ? v.w / U : WU) * (0.5 + 0.22 * Math.sin((t * 2 * Math.PI) / 23));
      const wy = (v ? v.y0 / U : 0) + (v ? v.h / U : HU) * (0.46 + 0.2 * Math.sin((t * 2 * Math.PI) / 30.7 + 1.2));
      L.tx = st.wFrom[0] + (wx - st.wFrom[0]) * e; L.ty = st.wFrom[1] + (wy - st.wFrom[1]) * e;
      busy = true;
    }
    let tx = L.tx; let ty = L.ty;
    if (st.aim != null && !st.sweep && B[st.aim]) { tx = B[st.aim].g.c[0]; ty = B[st.aim].g.c[1]; }   // keyboard focus beats the wander
    L.sx.t = tx; L.sy.t = ty;
    if (reduced) { L.sx.set(tx); L.sy.set(ty); } else { L.sx.step(dt); L.sy.step(dt); }
    if (L.sx.busy(0.05) || L.sy.busy(0.05)) busy = true; else { L.sx.set(tx); L.sy.set(ty); }   // settle exactly (wall cache)
    if (driftStep(dt)) busy = true;
    const vac = B.some((b) => b.detached || b.off);
    const hov = st.hover != null && B[st.hover] && !B[st.hover].hidden;
    const kT = vac ? 0.3 : hov ? 0.5 : st.lit.size ? 0.6 : 1;
    const pT = hov ? 0.3 : st.lit.size ? 0 : 1;
    const e3 = 1 - Math.exp(-3 * dt);
    const ease = (v, t, k) => (Math.abs(t - v) < 1e-3 ? t : v + (t - v) * k);
    st.houseK = ease(st.houseK, kT, e3); st.house = ease(st.house, st.houseT, e3); st.pool = ease(st.pool, pT, 1 - Math.exp(-5 * dt));
    if (st.houseK !== kT || st.house !== st.houseT || st.pool !== pT) busy = true;
    const tk = st.tintT0 ? clamp((now - st.tintT0) / 600, 0, 1) : 1;
    for (let i = 0; i < 3; i += 1) st.tint[i] = st.tintFrom[i] + (st.tintTo[i] - st.tintFrom[i]) * tk;
    if (tk < 1) busy = true;
    const br = st.br;
    br.p += ((br.on ? br.pT : 0) - br.p) * (1 - Math.exp(-6 * dt));
    if (!br.on && br.p < 0.01) br.p = 0;
    br.x += br.kph * 16 * dt;
    if (br.on || br.p > 0.01) busy = true;
    for (const b of B) if (stepSheet(b, dt, now)) busy = true;
    return busy;
  }

  // -- drawing
  function pinState(b, k, now, P0) {
    const g = b.g; const p = g.pins[k]; const ps = b.pins;
    const pos = deform(g, P0, p[0], p[1], 0);
    let x = pos[0]; let y = pos[1]; let z = pos[2] + 1.5; let s = 1; let a = 1; let glint = -9;
    let ang = g.angle + ((k % 2 ? 38 : -34) + ((k * 17) % 11)) * DEG;
    if (ps.mode === 'show') {
      const t = now - ps.t0 - k * 62; const qq = reduced ? 1 : clamp(t / 150, 0, 1); const e = easeOut(qq);
      a = qq; s = 0.7 + 0.3 * e; ang -= 10 * DEG * (1 - e); y -= 6 * (1 - e);
      if (!reduced && t > 120 && t < 720) glint = -0.25 + (1.5 * (t - 120)) / 600;
    } else if (ps.mode === 'hide') {
      a = ps.a0 * (1 - clamp((now - ps.t0) / 120, 0, 1));
    } else if (ps.mode === 'pop') {
      const t = now - ps.t0 - k * 62;
      if (t > 0) {
        const qq = clamp(t / 400, 0, 1); const q1 = clamp(qq / 0.22, 0, 1); const q2 = clamp((qq - 0.22) / 0.78, 0, 1); const f = gravity(q2);
        ang -= 26 * DEG * easeOut(q1) + 124 * DEG * f; s = 1 + 0.08 * q1 - 0.18 * q2;
        x += (p[0] > g.c[0] ? 1 : -1) * (26 + k * 9) * q2; y += 90 * f; z += 26 * Math.sin(Math.PI * q2) + 10 * q1;
        a = 1 - smooth(0.6, 1, qq);
      }
    } else if (ps.mode === 'back') {
      const t = now - ps.t0 - k * 75;
      if (t < 0 && !reduced) return null;
      const qq = reduced ? 1 : clamp(t / 340, 0, 1); const e = springy(qq);
      a = clamp(qq * 3, 0, 1); ang += 16 * DEG * (1 - e); s = 1.3 - 0.3 * e; y -= 18 * (1 - e); z += 16 * (1 - e);
    } else return null;
    return { x, y, z, ang, s, a, glint };
  }

  function occlusion(pr, g) {
    set(pr, 'u_self', g.idx); set(pr, 'u_cover', g.cover);
    set(pr, 'u_exBox', g.ex ? g.ex.box : NOBOX); set(pr, 'u_ex', g.ex ? g.ex.v : [-1, 0]);
  }

  function drawSheet(b, gex, gey) {
    mesh(b);
    const g = b.g; const P0 = pose(b); const h = height(b); const Lp = F.u_lampPos;
    if (h > 0.4) {
      const pr = P.shadow; use(pr); occlusion(pr, g);
      const dz = Math.max(Lp[2] - h, 60);
      let ox = ((g.c[0] - Lp[0]) * h) / dz; let oy = ((g.c[1] - Lp[1]) * h) / dz;
      const ol = Math.hypot(ox, oy);
      if (ol > 3 * h) { ox *= (3 * h) / ol; oy *= (3 * h) / ol; }
      set(pr, 'u_vp', vp(gex, gey)); set(pr, 'u_box', b.maskBox); set(pr, 'u_sh', [g.c[0], g.c[1], Lp[2] / dz, 0]); set(pr, 'u_off', [ox, oy]);
      set(pr, 'u_alpha', clamp(h / 18, 0, 1) * 0.55); set(pr, 'u_blur', Math.log2(1 + h / 10)); set(pr, 'u_mask', 3);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, b.mask);
      gl.bindVertexArray(vao.quad); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const pr = P.bib; use(pr); occlusion(pr, g);
    set(pr, 'u_vp', vp(g.o[0], g.o[1])); set(pr, 'u_c', g.c); set(pr, 'u_o', g.o); set(pr, 'u_shift', P0.shift); set(pr, 'u_R', g.R);
    set(pr, 'u_bulge', P0.bulge); set(pr, 'u_raise', P0.raise); set(pr, 'u_free', P0.free); set(pr, 'u_scale', P0.scale);
    set(pr, 'u_tilt', P0.tilt); set(pr, 'u_flut', P0.flut); set(pr, 'u_tug', P0.tug); set(pr, 'u_tugZ', P0.tugZ);
    set(pr, 'u_frameOn', b.frame); set(pr, 'u_gloss', g.gloss); set(pr, 'u_glossK', 1 - 0.4 * clamp(h / 12, 0, 1)); set(pr, 'u_alpha', 1);
    gl.bindVertexArray(b.vao); gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
  }

  function render(now) {
    measure();
    const m = st.m; const cw = canvas.width; const ch = canvas.height; const k = st.k;
    const lx = st.lamp.sx.x; const ly = st.lamp.sy.x;
    const Lp = [lx + LAMP[0], ly + LAMP[1], LAMP[2]];
    const sl = Math.hypot(LAMP[0], LAMP[1], LAMP[2]);
    const gex = (st.w / 2 - m.ox) / m.sx; const gey = (st.h / 2 - m.oy) / m.sy;
    Object.assign(F, {
      u_res: [cw, ch], u_map: [m.ox * k, m.oy * k, m.sx * k, m.sy * k], u_wall: [WU, HU], u_eye: [gex, gey, st.D],
      u_lampPos: Lp, u_spotDir: [-LAMP[0] / sl, -LAMP[1] / sl, -LAMP[2] / sl], u_lampCol: LAMP_COL, u_houseCol: st.tint,
      u_cosIn: COS_IN, u_cosOut: COS_OUT, u_lampPow: 3.8 * (1 + 0.35 * st.br.p), u_range: 1500,
      u_house: st.house * st.houseK, u_pool: st.pool, u_fog: cfg.fog, u_time: st.time, u_vign: 0.5, u_relief: 1,
      u_nl: RM.nl, u_lp: RM.lp, u_ld: RM.ld, u_lc: RM.lc, u_lcol: RM.lcol, u_plk: st.houseK,
    });
    const bs = F.u_bib; bs.fill(0); bs[3] = 0.14;
    F.u_field = B.some((b) => b.frame > 0 || b.vac > 0) ? 1 : 0;
    const hs = F.u_holes; hs.fill(0);
    let nh = 0;
    for (const b of B) {
      const o = b.g.idx * 4;
      if (o + 3 < 256) { bs[o] = b.frame; bs[o + 1] = b.vac; bs[o + 3] = b.g.gloss; }
      if (b.vac > 0.01) for (const p of b.g.pins) if (nh < 8) { hs.set([p[0], p[1], b.vac], nh * 3); nh += 1; }
    }
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.alb);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex.nrm);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex.id);
    const T = RM.t;                                    // the room: units 6 to 12
    [T.brick, T.brickN, T.frame, T.frameN, T.bsh].forEach((t, i) => { gl.activeTexture(gl.TEXTURE6 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
    gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, T.frameV);
    gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, T.frameNV);
    gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D_ARRAY, T.pics);
    gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D_ARRAY, T.picsN);
    // the wall pass is cached while its inputs stand still (idle, dust only, a settled hover): then it is a blit
    const key = cache.key; let n0 = 0;
    for (const a of [F.u_map, F.u_res, F.u_eye, Lp, st.tint, [F.u_lampPow, F.u_house, F.u_pool, F.u_fog, F.u_field, RM.rev], hs, bs]) for (const v of a) key[n0++] = v;
    const same = key.every((v, i) => v === cache.prev[i]);
    cache.prev.set(key);
    if (cache.w !== cw || cache.h !== ch) {
      if (!cache.fb) { cache.fb = gl.createFramebuffer(); cache.tex = gl.createTexture(); }
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, cache.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      cache.w = cw; cache.h = ch; cache.ok = false;
    }
    const hit = cache.ok && key.every((v, i) => v === cache.at[i]);
    if (!hit) {
      if (same) gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fb);
      use(P.wall); set(P.wall, 'u_holes', hs); set(P.wall, 'u_board', BOARD); set(P.wall, 'u_field', F.u_field);
      const W0 = P.wall;
      set(W0, 'u_room', [RM.on, 0, 0, 0]); set(W0, 'u_brickR', RM.brickR); set(W0, 'u_frameR', RM.frameR); set(W0, 'u_bshR', RM.bshR);
      set(W0, 'u_frameB', FRAME_B);
      set(W0, 'u_bshad', RM.bshad); set(W0, 'u_np', RM.np); set(W0, 'u_pa', RM.pa); set(W0, 'u_pb', RM.pb); set(W0, 'u_pu', RM.pu);
      set(W0, 'u_ps', RM.ps); set(W0, 'u_bulb', RM.bulb); set(W0, 'u_glowCol', RM.glow);
      gl.bindVertexArray(vao.tri); gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (same) { cache.at.set(key); cache.ok = true; }
    }
    if (hit || same) {                                 // clear first: the engine's deferred clear would wipe a bare blit
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cache.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    const act = B.filter(active).sort((a, b) => a.g.z - b.g.z);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const b of act) drawSheet(b, gex, gey);
    let pinOn = false;
    for (const b of B) {
      if (!b.g.pins.length || b.pins.mode === 'off' || b.pins.mode === 'gone') continue;
      const P0 = pose(b);
      for (let i = 0; i < b.g.pins.length; i += 1) {
        const d = pinState(b, i, now, P0);
        if (!d || d.a < 0.004) continue;
        if (!pinOn) {
          pinOn = true;
          use(P.pin); set(P.pin, 'u_pinTex', 4);
          gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tex.pin);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.bindVertexArray(vao.quad);
        }
        set(P.pin, 'u_vp', vp(b.g.o[0], b.g.o[1])); set(P.pin, 'u_pin', [d.x, d.y, d.z, d.ang]); set(P.pin, 'u_pinS', d.s);
        set(P.pin, 'u_alpha', d.a); set(P.pin, 'u_glint', d.glint); set(P.pin, 'u_frameOn', b.frame);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    const n = reduced ? Math.floor(cfg.dust / 3) : cfg.dust;
    if (n) {
      const pr = P.dust; gl.useProgram(pr.p);
      const replay = st.br.on || st.br.p > 0.01;
      set(pr, 'u_vp', vp(gex, gey));
      for (const key of ['u_lampPos', 'u_spotDir', 'u_lampCol', 'u_cosIn', 'u_cosOut', 'u_lampPow', 'u_range', 'u_house', 'u_time', 'u_eye']) set(pr, key, F[key]);
      // replay (1.6): head wind across the whole room, near the viewer (shows in the margins)
      const v0 = [-m.ox / m.sx, -m.oy / m.sy]; const v1 = [(st.w - m.ox) / m.sx, (st.h - m.oy) / m.sy];
      set(pr, 'u_b0', replay ? [v0[0] - 150, v0[1] - 100, 400] : [lx - 520, ly - 1000, 20]);
      set(pr, 'u_b1', replay ? [v1[0] + 150, v1[1] + 100, 1800] : [lx + 420, ly + 360, 900]);
      set(pr, 'u_glow', replay ? 0.45 + 0.6 * st.br.p : 0); set(pr, 'u_stream', st.br.x);
      set(pr, 'u_px', 1.1 * m.sx * k); set(pr, 'u_still', reduced ? 1 : 0);
      gl.blendFunc(gl.ONE, gl.ONE); gl.bindVertexArray(vao.dust); gl.drawArrays(gl.POINTS, 0, n);
    }
    gl.bindVertexArray(null);
    frames += 1;
    if (snaps.length) { const url = canvas.toDataURL('image/jpeg', 0.9); for (const fn of snaps.splice(0)) fn(url); }
  }

  // -- loop, watchdog, fallback
  function kick() {
    if (inFrame) { again = true; return; }             // a kick from inside the frame (stage 'change') asks for one more
    if (raf || paused || disposed || fell || lost || !ready) return;
    last = performance.now(); wd.prev = 0;
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function frame(now) {
    raf = 0;
    if (paused || disposed || fell || lost) return;
    const quiet = now - st.lastInput > 20000;
    const dust = tier === 'high' && cfg.dust > 0 && !document.hidden;
    if (st.idle && (skip = !skip)) { raf = requestAnimationFrame(frame); return; }  // 30 fps when only dust moves
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    let busy = false;
    inFrame = true; again = false;
    try {
      busy = step(dt, now);
      render(now);
    } catch (e) {
      inFrame = false;
      warn('frame', e);
      fallback('error');
      return;
    }
    inFrame = false;
    st.idle = quiet && now > st.fast && !st.br.on;       // 8.3: 30 fps after 20 s without input (wander, dust, drafts)
    if (!st.idle) watchdog(now); else wd.prev = 0;
    if ((busy || dust || again) && !raf) raf = requestAnimationFrame(frame);
  }
  function watchdog(now) {
    if (!watch || fell) return;
    if (wd.prev) {
      const d = now - wd.prev;
      if (wd.skip > 0) wd.skip -= 1;
      else if (d > 0 && d < 250) {
        wd.buf[wd.n] = d; wd.n += 1;
        if (wd.n === wd.buf.length) {
          wd.n = 0;
          const med = Array.from(wd.buf).sort((a, b) => a - b)[wd.buf.length >> 1];
          if (med > 22) stepDown(med);
        }
      }
    }
    wd.prev = now;
  }
  function stepDown(med) {
    if (tier === 'high') {
      tier = 'medium'; cfg = TIERS.medium;
      try { sessionStorage.setItem('rs-tier-cap', 'medium'); } catch (_) { /* storage off */ }
      release();
      for (const b of B) { b.flut = 0; b.gust = 0; }
      resize();
      try { document.documentElement.setAttribute('data-rs-tier', tier); } catch (_) { /* */ }
      if (store && store.set) store.set({ tier });
      if (bus && bus.emit) bus.emit('tier:change', { tier, reason: 'watchdog', median: Math.round(med) });
      wd.skip = 30; wd.n = 0;
    } else fallback('watchdog');
  }
  function fallback(reason) {
    if (fell) return;
    fell = reason || 'fallback';
    stopLoop();
    clearTimeout(draftT);
    for (const fn of [...fallbacks]) { try { fn(fell); } catch (e) { warn('fallback listener', e); } }
  }
  function onLost(e) { e.preventDefault(); lost = true; fallback('context-lost'); }

  // -- mouse tug on the stage (high tier)
  function onDown(e) {
    if (!cfg.tug || reduced || !ready || paused || e.pointerType !== 'mouse' || e.button !== 0) return;
    const a = e.target && e.target.closest ? e.target.closest('a[data-bib]') : null;
    const i = a ? idx(a.getAttribute('data-bib')) : -1;
    if (i < 0 || B[i].hidden) return;
    drag = { i, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), grab: toWallU(e.clientX, e.clientY), moved: false };
    addEventListener('pointermove', onDrag, true);
    addEventListener('pointerup', onUp, true);
    addEventListener('pointercancel', onUp, true);
  }
  function onDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= 6) return;
    drag.moved = true;
    const p = toWallU(e.clientX, e.clientY);
    pull(drag.i, p[0] - drag.grab[0], p[1] - drag.grab[1], drag.grab);
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    removeEventListener('pointermove', onDrag, true);
    removeEventListener('pointerup', onUp, true);
    removeEventListener('pointercancel', onUp, true);
    const d = drag;
    drag = null;
    if (d.moved) release();
    if (d.moved || performance.now() - d.t0 >= 600) suppressT = performance.now();   // 1.3: 6 px and 600 ms make a click
    if (st.pending !== undefined) { const h = st.pending; st.pending = undefined; setHover(h); }
  }
  function onClick(e) {
    if (!suppressT || performance.now() - suppressT > 400) return;
    suppressT = 0;
    e.preventDefault();
    e.stopPropagation();
  }
  function pull(i, ux, uy, grab) {
    const b = B[i];
    if (!b || b.hidden || !cfg.tug || reduced) return;
    if (st.tugI != null && st.tugI !== i) release();
    st.tugI = i;
    if (grab) b.grab = grab.slice();
    const len = Math.hypot(ux, uy); const k = 1 / (1 + len / 95);
    b.tug[0].t = ux * k; b.tug[1].t = uy * k; b.tug[2].t = Math.min(28, len * 0.22);
    noteInput(performance.now());
    kick();
  }

  // -- public API
  function setLamp(x, y, o = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const ux = x / U; const uy = y / U; const now = performance.now();
    const lp = st.lampIn;
    if (lp && !extWind && !o.instant) {
      const dt = (now - lp.t) / 1000;
      if (dt > 0.004 && dt < 0.12) blow((ux - lp.x) / dt, (uy - lp.y) / dt, ux, uy, dt);
    }
    st.lampIn = { x: ux, y: uy, t: now };
    st.lamp.tx = ux; st.lamp.ty = uy; st.aim = null;
    if (st.sweep) endSweep();
    if (o.instant || reduced) { st.lamp.sx.set(ux); st.lamp.sy.set(uy); }
    noteInput(now);
    kick();
  }
  function setWander(on) {
    const v = Boolean(on) && !reduced;
    if (v === st.wander) return;
    st.wander = v; st.wk = 0; st.wFrom = [st.lamp.tx, st.lamp.ty];
    kick();
  }
  function sweep(o = {}) {
    endSweep();
    const f = xy(o.from); const t = xy(o.to);
    const from = f ? [f[0] / U, f[1] / U] : [st.lamp.tx, st.lamp.ty];
    const to = t ? [t[0] / U, t[1] / U] : from;
    const dur = Math.max(1, +o.dur || 2400);
    if (reduced || !ready) { st.lamp.tx = to[0]; st.lamp.ty = to[1]; kick(); return Promise.resolve(); }
    const dx = to[0] - from[0]; const dy = to[1] - from[1]; const l = Math.hypot(dx, dy) || 1;
    st.wander = false; st.aim = null;
    hurry(dur + 500);
    return new Promise((resolve) => {
      st.sweep = { from, to, dur, t0: performance.now(), dir: [dx / l, dy / l], n: [dy / l, -dx / l], resolve };
      st.sweep.timer = setTimeout(endSweep, dur + 400);
      kick();
    });
  }
  function setHouse(level, tint) {
    const lv = Number.isFinite(+level) ? clamp(+level, 0, 1) : 0.14;
    const col = tint === 'cool' ? COOL : WARM;
    if (!st.houseSet) { st.houseSet = true; st.house = lv; st.tint = col.slice(); st.tintFrom = col; st.tintTo = col; }
    else if (col !== st.tintTo) { st.tintFrom = st.tint.slice(); st.tintTo = col; st.tintT0 = performance.now(); }
    st.houseT = lv;
    kick();
  }
  function setHover(id) {
    const i = idx(id);
    if (drag) { st.pending = id ?? null; return; }
    const v = i >= 0 ? i : null;
    if (v === st.hover) return;
    const now = performance.now();
    const prev = st.hover != null ? B[st.hover] : null;
    st.hover = v;
    if (prev && !prev.hidden && prev.pins.mode === 'show') pinsTo(prev, 'hide', now);
    st.aim = null;
    if (v != null) {
      const b = B[v];
      if (!b.hidden) {
        if (!reduced) b.lift.v += 1.2;
        if (b.pins.mode === 'off' || b.pins.mode === 'hide') pinsTo(b, 'show', now);
      }
      const p = st.ptrWall;
      const onIt = p && now - st.ptrT < 1500 && inPoly(p[0], p[1], b.g.poly);
      if (!onIt) st.aim = v;                          // keyboard focus: the lamp finds the number
    }
    noteInput(now);
    kick();
  }
  function setLit(ids) {
    st.lit = new Set((Array.isArray(ids) ? ids : []).map(idx).filter((i) => i >= 0));
    hurry(800);
    kick();
  }
  function wind(vx, vy, x, y) {
    extWind = true;
    const now = performance.now();
    const dt = clamp((now - (st.windT || now - 16)) / 1000, 0.008, 0.05);
    st.windT = now;
    blow(vx / U, vy / U, x / U, y / U, dt);
  }
  function tug(id, dx, dy) {
    const i = idx(id);
    if (i < 0 || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    let grab = null;
    if (st.tugI !== i) { const p = st.lampIn; grab = p ? [p.x - dx / U, p.y - dy / U] : B[i].g.c.slice(); }
    pull(i, dx / U, dy / U, grab);
  }
  function release() {
    const i = st.tugI;
    if (i == null) return;
    st.tugI = null;
    const b = B[i];
    b.tug[0].t = 0; b.tug[1].t = 0; b.tug[2].t = 0;
    if (!reduced) b.lift.v += 4;                      // small slap
    kick();
  }
  /** QA: where the GL paper is drawn now, as rest point (u) -> viewport px pairs over the visible sheet. */
  function quadNow(b) {
    measure();
    const g = b.g; const P0 = pose(b); const src = []; const dst = [];
    const add = (x, y) => { const d = deform(g, P0, x, y, weight(g, x, y)); src.push([x, y]); dst.push(project(d[0], d[1], d[2], g.o[0], g.o[1])); };
    for (const p of g.poly) add(p[0], p[1]);
    const [x0, y0, x1, y1] = g.box;
    for (let j = 1; j < 7; j += 1) for (let i = 1; i < 7; i += 1) { const x = x0 + ((x1 - x0) * i) / 7; const y = y0 + ((y1 - y0) * j) / 7; if (inPoly(x, y, g.poly)) add(x, y); }
    return { src, dst, quad: g.quad };
  }
  /** The raised pose (48 u) exactly as renderer-dom.js computes it, through the stage: the flyer's start quad. */
  function raisedQuad(b) {
    const g = b.g; const sc = 1 + 0.03 * (TAKEOFF_Z / HOVER_Z) * g.amount;
    return g.quad.map(([x, y]) => {
      const wx = (g.o[0] + (x - g.o[0]) * sc) * U; const wy = (g.o[1] + (y - g.o[1]) * sc + RISE) * U;
      let p = null;
      if (stage && typeof stage.toScreen === 'function') { try { p = xy(stage.toScreen(wx, wy)); } catch (_) { p = null; } }
      return p || project(wx / U, wy / U, 0, 0, 0);
    });
  }
  function shadowOf(b, h) {
    const g = b.g; const m = st.m;
    const Lp = [st.lamp.sx.x + LAMP[0], st.lamp.sy.x + LAMP[1], LAMP[2]]; const dz = Math.max(Lp[2] - h, 60);
    const r = (v) => Math.round(v * 10) / 10;
    return { x: r((((g.c[0] - Lp[0]) * h) / dz) * m.sx), y: r((((g.c[1] - Lp[1]) * h) / dz) * m.sy), blur: r((9 + h * 0.35) * m.sx), alpha: r(clamp(h / 18, 0, 1) * 0.55) };
  }
  function detach(id) {
    const i = idx(id);
    if (i < 0 || !ready) return null;
    const b = B[i]; const now = performance.now();
    measure();
    hurry();
    const out = { quad: raisedQuad(b), shadow: shadowOf(b, TAKEOFF_Z) };
    if (!b.detached) {
      b.detached = true; b.hold = 0; b.vacT0 = now; b.raiseV = 0;
      b.handT = now + (reduced ? 0 : 300);
      if (reduced) { b.hidden = true; b.vac = 1; } else b.off = { t0: now };
      if (b.pins.mode !== 'gone') pinsTo(b, 'pop', now);
    }
    kick();
    return out;
  }
  function refill(b) {
    b.off = null; b.hidden = false; b.detached = false; b.drop = null; b.hold = 0;
    b.lift.set(0); b.raise = 0; b.raiseV = 0; b.free = 0; b.sk = 0;
    b.pins.mode = 'off';
  }
  function attach(id, o = {}) {
    const i = idx(id);
    if (i < 0) return Promise.resolve();
    const b = B[i];
    if (!b.detached) return Promise.resolve();
    const slap = o.slap !== false && !reduced;
    hurry();
    refill(b);
    b.vac = 0; b.free = 1;
    if (slap) { b.raise = DROP_Z; b.drop = { slap: true }; }
    pinsTo(b, 'back', performance.now() + (slap ? 200 : 0));
    kick();
    return new Promise((resolve) => setTimeout(resolve, slap ? 420 : 0));
  }
  function vacate(id) {
    const i = id == null ? -1 : idx(id);
    hurry();
    for (const b of B) if (b.g.i !== i && b.detached) refill(b);
    if (i >= 0) {
      const b = B[i];
      if (!b.detached) {
        refill(b);
        b.hidden = true; b.detached = true; b.vacT0 = performance.now();
        if (b.g.pins.length) b.pins.mode = 'gone';
      }
    }
    kick();
  }
  function breathe(watts, kph) {
    const w = +watts || 0; const v = +kph || 0;
    const on = cfg.breathe && !reduced && (w > 0 || v > 0);
    st.br.on = on; st.br.pT = on ? clamp(w / 700, 0, 1.4) : 0; st.br.kph = on ? v : 0;
    kick();
  }
  function pause() { paused = true; stopLoop(); }
  function resume() {
    if (disposed || fell) return;
    paused = false; wd.skip = 8;
    kick();
  }
  function on(type, fn) {
    if (type !== 'fallback' || typeof fn !== 'function') return () => {};
    fallbacks.add(fn);
    if (fell) setTimeout(() => { if (fallbacks.has(fn)) fn(fell); }, 0);
    return () => fallbacks.delete(fn);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopLoop();
    clearTimeout(draftT);
    endSweep();
    for (const off of offs.splice(0)) { try { off(); } catch (_) { /* */ } }
    if (drag) { removeEventListener('pointermove', onDrag, true); removeEventListener('pointerup', onUp, true); removeEventListener('pointercancel', onUp, true); drag = null; }
    if (stage && typeof stage.drift === 'function' && (st.drift[0] || st.drift[1])) { try { stage.drift(0, 0); } catch (_) { /* */ } }
    if (canvas) canvas.removeEventListener('webglcontextlost', onLost);
    if (gl && !gl.isContextLost()) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
    gl = null; P = null; tex = null; B = []; fallbacks.clear();
  }

  async function init(o = {}) {
    if (o.stage) stage = o.stage;
    const list = Array.from(o.bibs || opts.bibs || []);
    const tx = o.textures || {};
    if (!canvas || !host || !list.length) throw new Error('renderer-gl: canvas, stage element or bibs missing');
    gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: tier === 'high' ? 'high-performance' : 'default', failIfMajorPerformanceCaveat: !forced,
    });
    if (!gl) throw new Error('renderer-gl: no WebGL2');
    canvas.addEventListener('webglcontextlost', onLost, false);
    // the id map indexes bibs.json order (sorted by id): R = index + 1
    const sorted = list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const index = new Map(sorted.map((b, i) => [b.id, i]));
    B = sorted.map((b, i) => sheet(prepBib(b, i, index)));
    for (const b of B) byId.set(b.g.id, b.g.i);
    let meta = null;
    try { meta = opts.data && typeof opts.data.getIndex === 'function' ? opts.data.getIndex().meta : null; } catch (_) { meta = null; }
    for (const ex of (meta && meta.localUpper) || []) {
      const up = idx(ex.upper); const lo = idx(ex.lower);
      if (up < 0 || lo < 0 || !Array.isArray(ex.box)) continue;
      const box = ex.box.map((v) => v / U);
      B[up].g.ex = { box, v: [lo + 1, 1] };
      B[lo].g.ex = { box, v: [up + 1, -1] };
    }
    P = {};
    for (const name of Object.keys(PROGRAMS)) P[name] = program(name);
    resize();
    measure();
    const dust = new Float32Array(TIERS.high.dust * 4);
    for (let i = 0; i < dust.length; i += 4) { dust[i] = Math.random(); dust[i + 1] = Math.random(); dust[i + 2] = Math.random() ** 1.4; dust[i + 3] = Math.random(); }
    vao = {
      tri: buffer(new Float32Array([-1, -1, 3, -1, -1, 3]), [2]),
      quad: buffer(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), [2]),
      dust: buffer(dust, [4]),
    };
    roomTex();                                          // r3: the room loads alongside the wall's own files
    const roomP = o.room ? roomStart(o.room, performance.now() + 4500) : null;
    const [nrm, idm, alb] = await Promise.all([bitmap(tx.normal, false), bitmap(tx.id, true), albedo(tx.albedo || img)]);
    if (disposed || lost) throw new Error('renderer-gl: disposed during init');
    tex = { alb: mkTex(alb, 'alb'), nrm: mkTex(nrm, 'nrm'), id: mkTex(idm, 'id'), pin: mkTex(pinGlyph(), 'pin') };
    // self-check: the id map must agree with bibs.json at every anchor (catches colour-managed decodes)
    const iw = idm.width; const ih = idm.height;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.id, 0);
    const px = new Uint8Array(iw * ih * 4);
    gl.readPixels(0, 0, iw, ih, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    const bad = B.filter((b) => {
      const x = clamp(Math.floor((b.g.c[0] / WU) * iw), 0, iw - 1); const y = clamp(Math.floor((b.g.c[1] / HU) * ih), 0, ih - 1);
      return px[(y * iw + x) * 4] !== b.g.idx;
    });
    if (bad.length > 2) throw new Error(`renderer-gl: id map does not match bibs.json (${bad.map((b) => b.g.id).join(', ')})`);
    for (const t of [nrm, idm, alb]) if (t && typeof t.close === 'function') t.close();
    for (const pr of Object.values(P)) {
      gl.useProgram(pr.p);
      [['u_alb', 0], ['u_nrm', 1], ['u_id', 2], ['u_mask', 3], ['u_pinTex', 4], ['u_brick', 6], ['u_brickN', 7], ['u_frame', 8],
        ['u_frameN', 9], ['u_bshadow', 10], ['u_pics', 11], ['u_picsN', 12], ['u_frameV', 13], ['u_frameVN', 14]].forEach(([n, v]) => set(pr, n, v));
    }
    const listen = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); offs.push(() => target.removeEventListener(type, fn, opt)); };
    const track = (e) => { st.ptr = [e.clientX, e.clientY]; st.ptrT = performance.now(); st.ptrIn = true; st.ptrWall = toWallU(e.clientX, e.clientY); };
    listen(host, 'pointermove', track, { passive: true });
    listen(host, 'pointerdown', track, { passive: true, capture: true });
    listen(host, 'pointerleave', () => { st.ptrIn = false; kick(); }, { passive: true });
    listen(host, 'pointerdown', onDown, false);
    listen(host, 'click', onClick, true);
    listen(host, 'dragstart', (e) => { if (drag) e.preventDefault(); }, true);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { if (!disposed && gl) { resize(); kick(); } });
      ro.observe(host);
      offs.push(() => ro.disconnect());
    }
    if (stage && typeof stage.on === 'function') {
      const off = stage.on('change', (c) => {
        // R1-wall-7: the visitor pans (drag, fling, wheel): the lamp keeps its spot on the screen (stage payload dx/dy)
        if (c && c.reason === 'pan' && (c.input === 'drag' || c.input === 'glide' || c.input === 'wheel') && !st.sweep && !st.wander && st.aim == null) {
          const dx = (+c.dx || 0) / U; const dy = (+c.dy || 0) / U;
          st.lamp.tx += dx; st.lamp.ty += dy; st.lamp.sx.x += dx; st.lamp.sx.t += dx; st.lamp.sy.x += dy; st.lamp.sy.t += dy;
        }
        kick();
      });
      if (typeof off === 'function') offs.push(off);
    }
    if (bus && typeof bus.on === 'function') {
      offs.push(bus.on('wall:activate', (d) => {        // keep the paper up (despite hover-out) until detach(), max 1.5 s
        const i = idx(d && d.bibId);
        if (i >= 0 && !B[i].hidden) { B[i].hold = performance.now() + 1500; kick(); }
      }));
      offs.push(bus.on('dossier:closed', () => breathe(0, 0)));
    }
    if (store && typeof store.on === 'function') {
      offs.push(store.on('reducedMotion', (v) => {
        reduced = Boolean(v);
        if (reduced) { st.wander = false; endSweep(); release(); for (const b of B) { b.flut = 0; b.gust = 0; } }
        kick();
      }));
    }
    if (roomP) await roomP;                             // the canvas fades in with the room drawn
    if (disposed || lost) throw new Error('renderer-gl: disposed during init');
    ready = true;
    const now = performance.now();
    step(0, now);
    render(now);
    const err = gl.getError();
    if (err !== gl.NO_ERROR && !gl.isContextLost()) throw new Error(`renderer-gl: GL error ${err} on the first frame`);
    scheduleDraft();
    kick();
  }

  const api = {
    get tier() { return tier; },
    init, setLamp, setWander, sweep, setHouse, setHover, setLit, wind, tug, release, detach, attach, vacate, breathe,
    pause, resume, dispose, on,
    /** QA only: state snapshot. */
    debug() {
      const ids = (f) => B.filter(f).map((b) => b.g.id);
      return {
        tier, ready, paused, fell, frames, running: Boolean(raf), dpr: st.k, D: Math.round(st.D), house: st.house * st.houseK, pool: st.pool,
        lamp: [st.lamp.sx.x * U, st.lamp.sy.x * U], hover: st.hover != null ? B[st.hover].g.id : null, active: ids(active),
        vacated: B.filter((b) => b.vac > 0).map((b) => [b.g.id, +b.vac.toFixed(2)]), pins: B.filter((b) => b.pins.mode !== 'off').map((b) => [b.g.id, b.pins.mode]),
        drift: st.drift.slice(), cached: cache.ok, glError: gl ? gl.getError() : null,
        room: { on: RM.on, pictures: RM.np, lights: RM.nl, files: Object.keys(RM.files), layers: [...RM.done] },
      };
    },
    /** QA only: a JPEG data URL of the next rendered frame. */
    snap() { return new Promise((resolve) => { snaps.push(resolve); kick(); }); },
    /** QA only: sampled rest -> screen pairs of the GL paper of `id` right now. */
    quadNow(id) { const i = idx(id); return i >= 0 && ready ? quadNow(B[i]) : null; },
  };
  return api;
}

export const createGLRenderer = createRenderer;
export default createRenderer;
