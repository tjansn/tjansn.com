/**
 * wall/gl/shaders.js (WP5): GLSL 300 es for renderer-gl.js. World = the wall in u (1/2000 of its width), y down,
 * z toward the viewer. Lighting after concept A, paper after concept C; the id map (R = bib index + 1, G = inside
 * distance * 8 u) replaces A's per-pixel polygon loops. Round 3 (D29): the photo hangs as a board in an old café:
 * brick wall with a normal map, the board frame and its contact shadow, framed pictures and brass picture lamps
 * (room.json), their lights, glass glare and bulb glow; no more feather into the dark.
 */

const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler2DArray;\n';

/* shared by the fragment shaders; u_l*: the picture lamps (pos + power, dir + range, cos out/in), u_plk dims them
   with the room (framing, a number away) */
const COMMON = `
uniform vec2 u_res;
uniform vec4 u_map;
uniform vec2 u_wall;
uniform vec3 u_eye, u_lampPos, u_spotDir, u_lampCol, u_houseCol, u_lcol;
uniform float u_cosIn, u_cosOut, u_lampPow, u_range, u_house, u_pool, u_fog, u_time, u_vign, u_relief, u_plk;
uniform sampler2D u_alb, u_nrm;
uniform sampler2D u_id;
uniform vec4 u_bib[64];
uniform int u_nl;
uniform vec4 u_lp[4], u_ld[4];
uniform vec2 u_lc[4];
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), w = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), w.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1.)), w.x), w.y);
}
vec2 wallAt(vec2 fc) { return (vec2(fc.x, u_res.y - fc.y) - u_map.xy) / u_map.zw; }
vec4 idTex(ivec2 t) { return texelFetch(u_id, clamp(t, ivec2(0), textureSize(u_id, 0) - 1), 0); }
int idAt(vec2 q) {
  vec2 uv = q / u_wall;
  if (uv.x < 0. || uv.y < 0. || uv.x >= 1. || uv.y >= 1.) return -1;
  return int(idTex(ivec2(uv * vec2(textureSize(u_id, 0)))).r * 255. + .5);
}
float tapW(vec2 f, ivec2 o) { return mix(1. - f.x, f.x, float(o.x)) * mix(1. - f.y, f.y, float(o.y)); }
/* inside the photo: the board frame covers its edge, so framing light, haze, shadows and pins stop there */
float inPhoto(vec2 q) { vec2 d = min(q, u_wall - q); return step(0., min(d.x, d.y)); }
vec3 nrmOf(vec2 n) { return normalize(vec3(n, sqrt(max(1. - dot(n, n), .04)))); }
void surface(vec2 q, float gl, out vec3 alb, out vec3 N, out float gloss) {
  vec2 c = clamp(q / u_wall, 0., 1.);
  alb = texture(u_alb, c).rgb;
  N = nrmOf((texture(u_nrm, c).rg * 2. - 1.) * u_relief);
  gloss = gl;
}
/* house light: higher and nearer the middle is brighter (as on the photo before); Saallicht lights the room evenly */
float houseGrad(vec2 q) {
  float k = mix(.35, .12, smoothstep(.15, .6, u_house));
  return clamp(mix(1.12, .52, clamp(q.y / u_wall.y, -.2, 1.2)), .3, 1.3) * clamp(1. - k * pow((q.x / u_wall.x - .5) * 2., 2.), .15, 1.);
}
/* r3: an exact cone test first */
float lampK(int i, vec3 P, out vec3 l) {
  l = u_lp[i].xyz - P;
  float c = dot(l, u_ld[i].xyz), e2 = dot(l, l);
  if (c >= 0. || c * c <= u_lc[i].x * u_lc[i].x * e2) { l = vec3(0., 0., 1.); return 0.; }
  float e = sqrt(e2); l /= e;
  return smoothstep(u_lc[i].x, u_lc[i].y, -c / e) * u_lp[i].w * u_plk / (1. + e2 / (u_ld[i].w * u_ld[i].w));
}
vec3 lightAt(vec3 P, vec3 N, vec3 alb, float gloss, float frame, float hg) {
  vec3 Lv = u_lampPos - P; float d = length(Lv); vec3 L = Lv / d;
  float cone = smoothstep(u_cosOut, u_cosIn, dot(-L, u_spotDir));
  float att = 1. / (1. + d * d / (u_range * u_range));
  float mask = max(cone * u_pool, frame);
  vec3 V = normalize(u_eye - P), H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.), 38.) * gloss;
  vec3 c = u_lampCol * (u_lampPow * att * mask) * (alb * max(dot(N, L), 0.) + vec3(spec));
  float hd = .5 + .5 * max(dot(N, vec3(-.152, -.728, .668)), 0.);
  c += u_houseCol * (u_house * hg * hd) * alb;
  for (int i = 0; i < 4; i++) {
    if (i >= u_nl) break;
    vec3 l; float k = lampK(i, P, l);
    if (k > 0.) c += u_lcol * k * (alb * max(dot(N, l), 0.) + vec3(pow(max(dot(N, normalize(l + V)), 0.), 30.) * gloss));
  }
  return c;
}
vec3 inscatter(vec3 ro, vec3 rd, float tmax) {
  vec3 q = u_lampPos - ro; float b = dot(rd, q); float h = sqrt(max(dot(q, q) - b * b, 129600.));
  float I = (atan((tmax - b) / h) + atan(b / h)) / h;
  float cone = 0.;
  for (int i = 0; i < 4; i++) {
    float ti = mix(max(b + 250., 0.), tmax, (float(i) + .5) / 4.);
    cone += smoothstep(u_cosOut * .992, u_cosIn, dot(normalize(ro + rd * ti - u_lampPos), u_spotDir));
  }
  return u_lampCol * (u_lampPow * u_fog * I * cone / 4.);
}
float vign(vec2 fc) {
  vec2 q = (fc / u_res * 2. - 1.) * vec2(u_res.x / u_res.y, 1.) * .62;
  return mix(1., smoothstep(1.35, .25, length(q)), u_vign);
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
vec3 finish(vec3 c, vec2 fc) {
  return pow(aces(c * 1.05), vec3(1. / 2.2)) + (hash(fc + fract(u_time) * 91.) - .5) / 255.;
}
vec3 haze(vec3 P, float m) {
  if (u_fog <= 0. || m <= 0.) return vec3(0.);
  vec3 rd = P - u_eye; float t = length(rd);
  return inscatter(u_eye, rd / t, t) * m;
}
`;

/* sheets on top hide the drawn one (C's occluder patches, exact); u_ex: local exception box (b24 over b25) */
const OCCLUDE = `
uniform int u_self;
uniform float u_cover[64];
uniform vec4 u_exBox;
uniform vec2 u_ex;
bool hidden(vec2 land) {
  int lid = idAt(land);
  if (lid < 0) return true;
  if (lid == 0 || lid == u_self) return false;
  bool over = u_cover[min(lid, 63)] > .5;
  if (lid == int(u_ex.x) && all(greaterThanEqual(land, u_exBox.xy)) && all(lessThanEqual(land, u_exBox.zw))) over = u_ex.y < 0.;
  return over;
}
`;

const WALL_VS = `${HEAD}in vec2 a_p; void main() { gl_Position = vec4(a_p, 0., 1.); }`;

/* the room (round 3): u_room.x = 1 once its textures are there; rects [x, y, w, h] in u (room.json); pictures and
   lamps: u_pa centre + half size, u_pb cos, sin of the rotation, array layer, kind (1 = lamp), u_pu uv scale of the
   layer (albedo, normal), u_ps shadow dx, dy, blur, opacity; RGBA textures premultiplied in sRGB (sRGB decoded here) */
const WALL_FS = `${HEAD}${COMMON}
uniform vec3 u_holes[8];
uniform vec3 u_board;
uniform float u_field;
uniform sampler2D u_brick, u_brickN, u_frame, u_frameN, u_frameV, u_frameVN, u_bshadow;
uniform float u_frameB;
uniform sampler2DArray u_pics, u_picsN;
uniform vec4 u_room, u_brickR, u_frameR, u_bshR, u_bshad;
uniform int u_np;
uniform vec4 u_pa[10], u_pb[10], u_pu[10], u_ps[10], u_bulb[4];
uniform vec3 u_glowCol;
out vec4 o;
vec4 unpm(vec4 c) { return vec4(pow(c.rgb / max(c.a, 1e-3), vec3(2.2)) * c.a, c.a); }
bool inBox(vec2 t) { return t.x >= 0. && t.y >= 0. && t.x <= 1. && t.y <= 1.; }
/* r3: the board frame as strips (renderer-gl strips()): top + bottom rows, left + right columns, u_frameB u deep */
void frameAt(vec2 q, vec2 qx, vec2 qy, out vec4 c, out vec4 n) {
  vec2 p = q - u_frameR.xy, S = u_frameR.zw; float B = u_frameB;
  c = vec4(0.); n = vec4(.5, .5, 0., 1.);
  if (any(lessThan(p, vec2(0.))) || any(greaterThan(p, S))) return;
  if (p.y < B || p.y > S.y - B) {
    vec2 k = vec2(S.x, 2. * B), t = vec2(p.x, p.y < B ? p.y : p.y - S.y + 2. * B) / k;
    c = textureGrad(u_frame, t, qx / k, qy / k); n = textureGrad(u_frameN, t, qx / k, qy / k);
  } else if (p.x < B || p.x > S.x - B) {
    vec2 k = vec2(2. * B, S.y - 2. * B), t = vec2(p.x < B ? p.x : p.x - S.x + 2. * B, p.y - B) / k;
    c = textureGrad(u_frameV, t, qx / k, qy / k); n = textureGrad(u_frameVN, t, qx / k, qy / k);
  }
}
/* the glass (st: 0..1 in the picture, pc, ph: its centre and half size): the torch's mirror image, and a glint that
   sweeps diagonally across the glass as the torch's aim moves over the picture; the picture lamps' bulbs up top.
   r3: no veil over the photo: a thin glint, upper left while aimed at the middle, at 30 % while aimed on the picture */
vec3 glare(vec3 P, vec3 V, vec2 st, vec2 pc, vec2 ph) {
  vec3 Lv = u_lampPos - P; float d = length(Lv); vec3 L = Lv / d;
  float lit = u_lampPow * smoothstep(u_cosOut, u_cosIn, dot(-L, u_spotDir)) * u_pool / (1. + d * d / (u_range * u_range));
  float h = max(normalize(L + V).z, 0.);
  vec2 aim = u_lampPos.xy + u_spotDir.xy * (u_lampPos.z / -u_spotDir.z), ad = (aim - pc) / ph;
  vec2 dir = vec2(.83, .56);
  float t = dot(st - .5, dir) + .3 - clamp(dot(ad, dir) * .32, -.75, .75);   // moves with the aim, as a reflection does
  vec3 g = u_lampCol * lit * (pow(h, 700.) * 5. + pow(h, 24.) * .05 + exp(-t * t * 300.) * .12 + exp(-t * t * 20.) * .008)
    * mix(.3, 1., smoothstep(.6, 1.1, max(abs(ad.x), abs(ad.y))));
  for (int i = 0; i < 4; i++) {
    if (i >= u_nl) break;
    vec3 l; float k = lampK(i, P, l);
    float hh = max(normalize(l + V).z, 0.);
    g += u_lcol * k * (pow(hh, 500.) * 3. + pow(hh, 60.) * .3);
  }
  return g;
}
void main() {
  vec2 q = wallAt(gl_FragCoord.xy);
  vec2 uv = q / u_wall;
  // r3: q is linear in the pixel: constant screen derivatives (gradients for the pictures and the frame)
  vec2 qx = vec2(1. / u_map.z, 0.), qy = vec2(0., -1. / u_map.w);
  float inP = inPhoto(q);
  vec3 P = vec3(q, 0.);
  vec3 alb, N; float gloss;
  float frame = 0., cover = 1., sh = 1., glass = 0., pcov = 0., pul = 0.;
  vec2 gst = vec2(.5), gpc = vec2(0.), gph = vec2(1.);
  vec3 emis = vec3(0.);
  if (inP > 0.) {
    vec2 tc = uv * vec2(textureSize(u_id, 0)) - .5;
    vec2 fr = fract(tc); ivec2 i0 = ivec2(floor(tc));
    float vac = 0., vd = 0., gl = u_bib[min(int(idTex(ivec2(floor(tc + .5))).r * 255. + .5), 63)].w;
    for (int k = 0; k < 4; k++) {
      if (u_field < .5) break;                       // nothing framed or vacated: one tap is enough
      if (k == 0) gl = 0.;
      ivec2 of = ivec2(k & 1, k >> 1);
      float w = tapW(fr, of);
      vec4 t = idTex(i0 + of);
      int id = int(t.r * 255. + .5);
      float dd = t.g * 31.875;
      vec4 s = u_bib[min(id, 63)];
      frame += w * s.x * smoothstep(0., 6., dd + 1.);
      float va = w * s.y * float(id > 0);
      vac += va; vd += va * dd; gl += w * s.w;
    }
    vd /= max(vac, 1e-4);
    surface(q, gl, alb, N, gloss);
    if (vac > .002) {
      vec3 board = u_board * (.8 + .24 * vnoise(q * .11) + .1 * vnoise(q * .7 + 3.));
      board *= mix(.5, 1., smoothstep(.5, 10., vd)) * (1. - .35 * (1. - smoothstep(0., 2., vd)));
      vec3 nb = vec3(0., 0., 1.); float hole = 0.;
      for (int i = 0; i < 8; i++) {
        vec3 hl = u_holes[i];
        if (hl.z < .01) continue;
        vec2 dv = q - hl.xy; float r = length(dv);
        hole = max(hole, hl.z * (1. - smoothstep(1.6, 3., r)));
        nb.xy -= dv / max(r, .01) * hl.z * .8 * (smoothstep(1., 2., r) - smoothstep(2.6, 4.6, r));
      }
      board *= 1. - .88 * hole;
      alb = mix(alb, board, vac); N = normalize(mix(N, normalize(nb), vac)); gloss = mix(gloss, .02, vac);
    }
  } else {
    // the café wall: bricks (repeat in x, fading into the dark at the ceiling and the floor, r3: and the far sides)
    vec2 bt = (q - u_brickR.xy) / u_brickR.zw;
    alb = texture(u_brick, bt).rgb * u_room.x * smoothstep(0., .07, bt.y) * smoothstep(1., .93, bt.y)
      * smoothstep(-1550., -1150., q.x) * smoothstep(3550., 3150., q.x) + (1. - u_room.x) * vec3(.004);
    N = nrmOf((texture(u_brickN, bt).rg * 2. - 1.) * u_room.x);
    gloss = .02; cover = 0.;
    vec2 bs = (q - u_bshad.xy - u_bshR.xy) / u_bshR.zw;
    sh = 1. - u_bshad.z * texture(u_bshadow, bs).a * float(inBox(bs));
    // r3: far from a picture and its shadow a fragment skips it
    for (int i = 0; i < 10; i++) {
      if (i >= u_np) break;
      vec4 a = u_pa[i], b = u_pb[i], s = u_ps[i];
      vec2 hb = abs(b.x) * a.zw + abs(b.y) * a.wz;
      vec2 d = q - a.xy - s.xy;
      if (any(greaterThan(abs(d), hb + s.z)) && any(greaterThan(abs(q - a.xy), hb))) continue;
      vec2 l = vec2(b.x * d.x + b.y * d.y, -b.y * d.x + b.x * d.y);
      vec2 e = abs(l) - a.zw;
      sh *= 1. - s.w * (1. - smoothstep(-.6 * s.z, s.z, length(max(e, 0.)) + min(max(e.x, e.y), 0.)));
      d = q - a.xy;
      vec2 st = vec2(b.x * d.x + b.y * d.y, -b.y * d.x + b.x * d.y) / (2. * a.zw) + .5;
      if (!inBox(st)) continue;
      vec2 rx = vec2(b.x * qx.x + b.y * qx.y, -b.y * qx.x + b.x * qx.y) / (2. * a.zw);
      vec2 ry = vec2(b.x * qy.x + b.y * qy.y, -b.y * qy.x + b.x * qy.y) / (2. * a.zw);
      vec4 c = unpm(textureGrad(u_pics, vec3(st * u_pu[i].xy, b.z), rx * u_pu[i].xy, ry * u_pu[i].xy));
      if (c.a < .003) continue;
      vec4 nm = textureGrad(u_picsN, vec3(st * u_pu[i].zw, b.z), rx * u_pu[i].zw, ry * u_pu[i].zw);
      vec2 pn = nm.rg * 2. - 1.;
      alb = alb * (1. - c.a) + c.rgb;
      N = normalize(mix(N, nrmOf(vec2(b.x * pn.x - b.y * pn.y, b.y * pn.x + b.x * pn.y)), c.a));
      float gg = smoothstep(.9, 1., nm.b);                     // r3: glass is a mirror (glare()), no satin veil
      gloss = mix(gloss, nm.b * .7 * (1. - .92 * gg), c.a);
      cover = max(cover, c.a); pcov = max(pcov, c.a);
      if (b.w > 1.5) pul = max(pul, c.a);                      // no lamp of its own
      float gi = gg * c.a;
      if (gi > glass) { glass = gi; gst = st; gpc = a.xy; gph = a.zw; }
      if (abs(b.w - 1.) < .5) emis += c.rgb * (.35 + 1.4 * st.y * st.y * st.y) * vec3(.5, .43, .33) * u_plk;   // the dome lit by its bulb
    }
  }
  // the board frame: black wood around the photo; over the photo's edge only its soft occlusion
  vec4 fc, fn;
  frameAt(q, qx, qy, fc, fn);
  fc = unpm(fc) * u_room.x;
  float fo = fc.a * (1. - inP * (1. - smoothstep(.85, 1., fc.a)));   // r3: the rail over the photo's edge
  alb = alb * (1. - fc.a) + fc.rgb;
  N = normalize(mix(N, nrmOf(fn.rg * 2. - 1.), fo));
  gloss = mix(gloss, fn.b * .6, fo);
  cover = max(cover, fc.a);
  frame *= 1. - fc.a;
  vec3 V = normalize(u_eye - P);
  float hg = houseGrad(q);
  hg = mix(hg, max(hg, .42), pcov);                     // a picture far out still shows in the house light
  hg = mix(hg, max(hg, 1.2), pul);                       // r3: lampless ones stay recognisable
  vec3 col = lightAt(P, N, alb, gloss, frame, hg) * mix(sh, 1., cover) + haze(P, 1.) + emis;
  if (glass > 0.) col += glare(P, V, gst, gpc, gph) * glass;
  for (int i = 0; i < 4; i++) {
    vec4 bb = u_bulb[i];
    if (bb.w < .5) continue;
    float r2 = dot(q - bb.xy, q - bb.xy) / (bb.z * bb.z);
    if (r2 > 70.) continue;
    col += u_glowCol * (exp(-r2 * 2.4) * 1.1 + exp(-r2 * .18) * .08) * u_plk;
  }
  o = vec4(finish(col * vign(gl_FragCoord.xy), gl_FragCoord.xy), 1.);
}`;

/* paper (C): z = bulge w (1 - 0.4 r^2) + flutter w wave + tug w gauss(120 u) + tilt + raise; scale about u_o */
const BIB_VS = `${HEAD}
in vec2 a_p; in float a_w; in vec2 a_wg;
uniform mat4 u_vp;
uniform vec2 u_c, u_o, u_shift;
uniform float u_R, u_bulge, u_raise, u_free, u_scale, u_tugZ;
uniform vec2 u_tilt;
uniform vec4 u_flut, u_tug;
out vec2 v_rest; out vec3 v_world; out vec3 v_n;
float fz(vec2 p, float w) {
  vec2 dc = p - u_c;
  float z = u_bulge * w * (1. - .4 * dot(dc, dc) / (u_R * u_R));
  float ph = dot(p, u_flut.zw) * .021 - u_flut.y;
  z += u_flut.x * w * (.5 + .5 * sin(ph)) * (.75 + .25 * sin(ph * .47 + 1.3));
  vec2 g = p - u_tug.xy;
  z += u_tugZ * w * exp(-dot(g, g) / 28800.);
  z += dot(dc, u_tilt) * w;
  return max(z, 0.);
}
void main() {
  float w = mix(a_w, 1., u_free);
  vec2 wg = a_wg * (1. - u_free);
  float z = fz(a_p, w);
  float zx = fz(a_p + vec2(3., 0.), w + wg.x * 3.), zy = fz(a_p + vec2(0., 3.), w + wg.y * 3.);
  v_n = normalize(vec3((z - zx) / 3., (z - zy) / 3., 1.));
  vec2 g = a_p - u_tug.xy;
  vec2 xy = u_o + (a_p - u_o) * (1. + u_scale * w) + (u_tug.zw * exp(-dot(g, g) / 28800.) + u_shift) * w;
  v_rest = a_p; v_world = vec3(xy, z + u_raise);
  gl_Position = u_vp * vec4(v_world, 1.);
}`;

/* the paper is dropped wherever the wall behind it is not the photo (the board frame lies over its edge) */
const BIB_FS = `${HEAD}${COMMON}${OCCLUDE}
uniform float u_frameOn, u_gloss, u_glossK, u_alpha;
in vec2 v_rest; in vec3 v_world; in vec3 v_n;
out vec4 o;
void main() {
  vec2 tc = v_rest / u_wall * vec2(textureSize(u_id, 0)) - .5;
  vec2 fr = fract(tc); ivec2 i0 = ivec2(floor(tc));
  float cov = 0., dd = 0.;
  for (int k = 0; k < 4; k++) {
    ivec2 of = ivec2(k & 1, k >> 1);
    vec4 t = idTex(i0 + of);
    if (int(t.r * 255. + .5) == u_self) { float w = tapW(fr, of); cov += w; dd += w * t.g * 31.875; }
  }
  if (cov < .004 || hidden(wallAt(gl_FragCoord.xy))) discard;
  dd /= cov;
  vec3 alb, N; float gloss;
  surface(v_rest, u_gloss, alb, N, gloss);
  N = normalize(vec3(N.xy / max(N.z, .2) + v_n.xy / max(v_n.z, .25), 1.));
  float frame = u_frameOn * smoothstep(0., 6., dd + 1.);
  vec3 col = lightAt(v_world, N, alb, gloss * u_glossK, frame, houseGrad(v_rest)) + haze(v_world, 1.);
  o = vec4(finish(col * vign(gl_FragCoord.xy), gl_FragCoord.xy), cov * u_alpha);
}`;

/* shadow: C's blurred mask away from the lamp, softer with height (mip bias) */
const SHADOW_VS = `${HEAD}
in vec2 a_q;
uniform mat4 u_vp;
uniform vec4 u_box;
uniform vec4 u_sh;
uniform vec2 u_off;
out vec2 v_uv;
void main() {
  v_uv = a_q;
  vec2 p = u_box.xy + a_q * u_box.zw;
  gl_Position = u_vp * vec4(u_sh.xy + (p - u_sh.xy) * u_sh.z + u_off, 0., 1.);
}`;
const SHADOW_FS = `${HEAD}${COMMON}${OCCLUDE}
uniform sampler2D u_mask;
uniform float u_alpha, u_blur;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 land = wallAt(gl_FragCoord.xy);
  float m = texture(u_mask, v_uv, u_blur).a;
  if (m < .003 || hidden(land)) discard;                   // hidden() also ends it at the photo's edge
  o = vec4(.018, .014, .011, m * u_alpha);
}`;

/* safety pin (C's glyph), lit by the lamp, travelling glint */
const PIN_VS = `${HEAD}
in vec2 a_q;
uniform mat4 u_vp;
uniform vec4 u_pin;
uniform float u_pinS;
out vec2 v_uv; out vec3 v_world;
void main() {
  v_uv = a_q;
  vec2 lp = (vec2(-12., -14.) + a_q * vec2(78., 28.)) * u_pinS;
  float c = cos(u_pin.w), s = sin(u_pin.w);
  v_world = vec3(u_pin.xy + vec2(c * lp.x - s * lp.y, s * lp.x + c * lp.y), u_pin.z);
  gl_Position = u_vp * vec4(v_world, 1.);
}`;
const PIN_FS = `${HEAD}${COMMON}
uniform sampler2D u_pinTex;
uniform float u_alpha, u_glint, u_frameOn;
in vec2 v_uv; in vec3 v_world;
out vec4 o;
void main() {
  vec4 t = texture(u_pinTex, v_uv);
  if (t.a < .004) discard;
  vec3 c = pow(t.rgb / t.a, vec3(2.2));
  vec3 Lv = u_lampPos - v_world; float d = length(Lv);
  float cone = smoothstep(u_cosOut, u_cosIn, dot(-Lv / d, u_spotDir));
  float fm = max(cone * u_pool, u_frameOn);
  float lit = u_lampPow / (1. + d * d / (u_range * u_range)) * fm * .85 + u_house * .9;
  float band = exp(-pow((v_uv.x - u_glint) * 6., 2.)) * step(.5, t.r) * fm;
  vec3 col = c * lit * u_lampCol + vec3(1., .95, .86) * band * 1.6;
  float a = t.a * u_alpha * inPhoto(v_world.xy);             // a pin never shows over the board frame
  o = vec4(finish(col, gl_FragCoord.xy) * a, a);
}`;

/* dust (A): world-anchored motes around the lamp, lit inside the cone (over the whole room since round 3) */
const DUST_VS = `${HEAD}
in vec4 a_p;
uniform mat4 u_vp;
uniform vec3 u_b0, u_b1, u_lampPos, u_spotDir, u_eye;
uniform float u_glow, u_px, u_still, u_stream, u_time, u_cosIn, u_cosOut, u_lampPow, u_range, u_house;
out float v_b; out float v_sz;
void main() {
  float s = a_p.w, T = u_time * (1. - u_still);
  vec3 sz = u_b1 - u_b0;
  vec3 w = a_p.xyz * sz;
  w.x += sin(T * .13 + s * 40.) * 34. + u_stream;
  w.y += T * (2. + 4. * s) + cos(T * .11 + s * 23.) * 26.;
  w.z += sin(T * .07 + s * 11.) * 30.;
  vec3 p = u_b0 + mod(w - u_b0, sz);
  vec3 L = p - u_lampPos; float d = max(length(L), 1.);
  float cone = smoothstep(u_cosOut * .985, u_cosIn, dot(L / d, u_spotDir)) * smoothstep(260., 520., d);
  float tw = .55 + .45 * sin(u_time * (.8 + s * 2.6) + s * 60.);
  v_b = (cone * u_lampPow * .9 / (1. + d * d / (u_range * u_range)) + u_house * .05 + u_glow) * tw;
  vec4 cp = u_vp * vec4(p, 1.);
  gl_Position = cp;
  float size = (1.1 + s * 2.8) * u_px / cp.w;
  v_sz = size; gl_PointSize = clamp(size, 1., 18.);
}`;
const DUST_FS = `${HEAD}
uniform vec3 u_lampCol;
in float v_b; in float v_sz;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2. - 1.; float r = dot(q, q);
  if (r > 1.) discard;
  float soft = mix(1. - r, exp(-r * 3.), clamp((v_sz - 3.) / 8., 0., 1.));
  o = vec4(u_lampCol * v_b * soft * .9 / (1. + max(v_sz - 3., 0.) * .35), 1.);
}`;

export const PROGRAMS = {
  wall: [WALL_VS, WALL_FS],
  bib: [BIB_VS, BIB_FS],
  shadow: [SHADOW_VS, SHADOW_FS],
  pin: [PIN_VS, PIN_FS],
  dust: [DUST_VS, DUST_FS],
};

export default PROGRAMS;
