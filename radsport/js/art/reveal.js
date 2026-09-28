/**
 * art/reveal.js (round 2, package ui): photo -> drawing reveal in the dossier exhibit (D17), WebGL.
 * Port of concept B's morph ($S/kb/art/concept-B/code/anim/morph.js), same maths, re-timed by the caller (about 2.4 s)
 * and playable backwards (close: quick reverse to the photo crop).
 *
 *   createReveal(canvas, { photo, draw, order, rect, paper, onLost }) -> Reveal | null   (null: no WebGL, caller crossfades)
 *     photo  the photo crop the flight carried (img/bibs/<id>.webp): <img>, or an ImageBitmap
 *     draw   the drawing (img/bibs-art/<id>.webp), decoded: <img>, or an ImageBitmap (decoded off the main thread with
 *            premultiplyAlpha 'none' and colorSpaceConversion 'none', so the upload needs no second decode)
 *     order  the order map or null (R pencil time, G wash time, B reconstructed); without it the order is synthesised
 *            (top to bottom)
 *     rect   { x, y, w, h }: the photo crop inside the drawing, drawing px (photoRect)
 *     paper  [r, g, b] 0..1
 *     onLost called once when the GPU drops the context (a reset, memory pressure): the running play resolves false
 *   Reveal: { box, seek(t), play({ to, ms, ease }) -> Promise<boolean>, stop(), finish(), t, lost, destroy() }
 *     box: the canvas area in drawing px ({ x, y, w, h }) and as fractions of the drawing ({ fx, fy, fw, fh }): the
 *     drawing plus any part of the photo crop outside it
 *
 * Timeline t = 0..1: 0-.14 the paper sheet with the complete outline grows out from under the photo at full strength
 * (a soft front, never a half-transparent film: that read as a grey box on the dark sheet), 0-.22 the photo sinks to a
 * ghost; .10-.66 pencil lines draw in along the order map, reconstructed parts a beat later; .34-.62 the ghost fades;
 * .48-1 the watercolour blooms (the finished drawing, darker at the wet front); 1 = exactly the drawing. The order map's
 * times are mapped inside each window, so nothing of the finished drawing shows at t = 0 (an order value of 0 used to
 * switch its wash on at once: patches of the drawing around the photo) and everything is on at t = 1.
 * The clock reads absolute time: a frame after a pause (hidden tab) lands where it should, never half way.
 */

const VS = 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}';

const FS = `precision mediump float;
uniform sampler2D uPhoto,uArt,uOrder;
uniform float uT,uHasOrder,uReach;
uniform vec4 uRect,uView;
uniform vec3 uPaper;
uniform vec2 uTexel;
varying vec2 v;
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
float ramp(float a,float b,float x){return clamp((x-a)/(b-a),0.,1.);}
float hash(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 u=uView.xy+v*uView.zw;
  float inA=step(0.,u.x)*step(u.x,1.)*step(0.,u.y)*step(u.y,1.);
  vec2 uc=clamp(u,0.,1.);
  vec4 art=texture2D(uArt,uc)*inA;
  float aa=art.a;
  float l=luma(art.rgb);
  float r=3.,d=2.1213;
  #define LA(o) luma(texture2D(uArt,uc+(o)*uTexel).rgb)
  float ring=max(max(max(LA(vec2(r,0.)),LA(vec2(-r,0.))),max(LA(vec2(0.,r)),LA(vec2(0.,-r)))),
                 max(max(LA(vec2(d,d)),LA(vec2(-d,d))),max(LA(vec2(d,-d)),LA(vec2(-d,-d)))));
  float la=clamp((ring-l)/max(ring*.35,.05),0.,1.);
  float sat=max(max(art.r,art.g),art.b)-min(min(art.r,art.g),art.b);
  la=max(la,clamp((.43-l)/.27,0.,1.)*clamp(1.-sat*2.5,0.,1.))*aa;
  vec3 ord=texture2D(uOrder,uc).rgb;
  if(uHasOrder<.5){float n=hash(floor(uc*vec2(90.,120.)));ord=vec3(clamp(uc.y*.82+n*.12,0.,1.),clamp(.08+uc.y*.62+n*.22,0.,1.),0.);}
  float tp=.04+min(1.,ord.r*.85+.15*ord.b)*.955;
  float tg=.07+ord.g*.925;
  float tLine=ramp(.10,.66,uT);
  float tWash=ramp(.48,1.,uT);
  float lineOn=smoothstep(tp-.04,tp+.005,tLine);
  float washOn=smoothstep(tg-.07,tg+.005,tWash);
  float photoOut=smoothstep(.34,.62,uT);
  vec2 pu=(u-uRect.xy)/uRect.zw;
  float inR=step(0.,pu.x)*step(pu.x,1.)*step(0.,pu.y)*step(pu.y,1.);
  vec4 ph=texture2D(uPhoto,clamp(pu,0.,1.))*inR;
  vec2 dd=max(max(uRect.xy-u,u-uRect.xy-uRect.zw),0.);
  dd.x*=uTexel.y/uTexel.x;
  float reach=smoothstep(0.,.14,uT)*uReach;
  float paperIn=1.-smoothstep(reach-.03,reach,length(dd));
  float ghost=smoothstep(0.,.22,uT);
  float paperA=aa*paperIn;
  vec4 acc=vec4(uPaper*paperA,paperA);
  float phA=ph.a*(1.-.78*ghost)*(1.-photoOut);
  acc=vec4(ph.rgb*phA,phA)+acc*(1.-phA);
  float pA=aa*lineOn*la*(1.-washOn);
  acc=vec4(art.rgb*pA,pA)+acc*(1.-pA);
  float front=washOn*(1.-washOn)*4.;
  vec3 wet=art.rgb*(1.-.16*front*(1.-l*.5));
  float wA=aa*washOn;
  acc=vec4(wet*wA,wA)+acc*(1.-wA);
  gl_FragColor=acc;
}`;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function createReveal(canvas, { photo, draw, order = null, rect, paper = [0.97, 0.96, 0.94], onLost = null } = {}) {
  if (!canvas || !photo || !draw || !rect) return null;
  const W = draw.naturalWidth || draw.width;
  const H = draw.naturalHeight || draw.height;
  if (!(W > 0 && H > 0)) return null;
  // how far the paper has to grow from the photo rect to reach the farthest corner of the sheet (drawing heights), plus
  // the soft front
  const rx = rect.x / W; const ry = rect.y / H; const rw = rect.w / W; const rh = rect.h / H;
  let reach = 0;
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const dx = Math.max(rx - cx, cx - rx - rw, 0) * (W / H);
    const dy = Math.max(ry - cy, cy - ry - rh, 0);
    reach = Math.max(reach, Math.hypot(dx, dy));
  }
  // the canvas covers the drawing and the photo crop together (a crop may reach past the drawing's edge)
  const x0 = Math.min(0, rect.x); const y0 = Math.min(0, rect.y);
  const x1 = Math.max(W, rect.x + rect.w); const y1 = Math.max(H, rect.y + rect.h);
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, fx: x0 / W, fy: y0 / H, fw: (x1 - x0) / W, fh: (y1 - y0) / H };
  canvas.width = Math.round(box.w);
  canvas.height = Math.round(box.h);
  let gl = null;
  try { gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false }); } catch (_) { gl = null; }
  if (!gl || gl.isContextLost()) return null;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(pr);
  // the link status is the one blocking query left here (no getError round trip): a program that did not link (or a
  // context lost meanwhile) hands over to the caller's crossfade
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
    if (!gl.isContextLost()) { try { console.warn('[radsport] reveal: shader', gl.getProgramInfoLog(pr)); } catch (_) { /* no console */ } }
    lose(gl);
    return null;
  }
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = (im, unit, name) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    // <img> sources: raw pixels as stored (ImageBitmaps are decoded that way already; for them these flags do not apply)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (im) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(pr, name), unit);
  };
  try {
    tex(photo, 0, 'uPhoto');
    tex(draw, 1, 'uArt');
    tex(order, 2, 'uOrder');
  } catch (_) { lose(gl); return null; }
  gl.uniform1f(gl.getUniformLocation(pr, 'uHasOrder'), order ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(pr, 'uReach'), reach + 0.05);
  gl.uniform4f(gl.getUniformLocation(pr, 'uRect'), rx, ry, rw, rh);
  gl.uniform4f(gl.getUniformLocation(pr, 'uView'), box.x / W, box.y / H, box.w / W, box.h / H);
  gl.uniform3fv(gl.getUniformLocation(pr, 'uPaper'), paper.map(Number));
  gl.uniform2f(gl.getUniformLocation(pr, 'uTexel'), 1 / W, 1 / H);
  const uT = gl.getUniformLocation(pr, 'uT');
  gl.viewport(0, 0, canvas.width, canvas.height);

  let now = 0;
  let raf = 0;
  let timer = 0;
  let run = null;             // { resolve, t0, from, to, ms, ease }
  let dead = false;
  let lost = false;
  // a lost context draws nothing any more: stop, resolve the running play with false and tell the caller once
  const onLose = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (lost) return;
    lost = true;
    dead = true;
    end(false);
    if (typeof onLost === 'function') { try { onLost(); } catch (_) { /* caller */ } }
  };
  canvas.addEventListener('webglcontextlost', onLose, false);
  const draw1 = (t) => {
    if (dead) return;
    if (gl.isContextLost()) { onLose(null); return; }
    now = clamp01(t);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uT, now);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const end = (reached) => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    const r = run;
    run = null;
    if (r) r.resolve(reached);
  };
  const frame = () => {
    if (!run) return;
    const r = run;
    const x = clamp01((performance.now() - r.t0) / r.ms);
    draw1(r.from + (r.to - r.from) * r.ease(x));
    if (x >= 1) { end(true); return; }
    raf = requestAnimationFrame(frame);
  };
  draw1(0);
  const api = {
    /** The canvas box in drawing px ({ x, y, w, h }): the page places the canvas there. */
    box,
    get t() { return now; },
    /** True once the context was lost: the canvas stays empty, the caller shows the drawing or the photo instead. */
    get lost() { return lost; },
    seek(t) { end(false); draw1(t); },
    /** Animate from the current t to `to` in `ms`; resolves true when it got there, false when stopped. */
    play({ to = 1, ms = 2400, ease = (x) => x } = {}) {
      end(false);
      if (dead) return Promise.resolve(false);
      const from = now;
      if (ms <= 0 || Math.abs(to - from) < 1e-4) { draw1(to); return Promise.resolve(true); }
      return new Promise((resolve) => {
        run = { resolve, t0: performance.now(), from, to, ms, ease };
        raf = requestAnimationFrame(frame);
        // rAF sleeps in a hidden tab: the absolute clock is checked once more after the end time
        timer = setTimeout(() => { if (run) { draw1(to); end(true); } }, ms + 400);
      });
    },
    stop() { end(false); },
    /** Jump to the end of the running play (or leave t as it is). */
    finish() { if (run) { const to = run.to; end(true); draw1(to); } },
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLose, false);
      end(false);
      if (dead) return;
      dead = true;
      lose(gl);
    },
  };
  return api;
}

function lose(gl) {
  try { const e = gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); } catch (_) { /* gone */ }
}

export default { createReveal };
