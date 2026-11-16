// HorizonX Drops: this engine is copied unchanged from the HorizonX editor
// (horizonx-frontend src/lib/tools/emberEclipse.engine.js at 00b7cec).
// Licensed under the HorizonX Drops License in this repository's LICENSE file.
// Do not edit here: change it in horizonx-frontend and run scripts/sync-from-horizonx.mjs.
// --- end of HorizonX Drops banner ---
/**
 * Ember Eclipse: a burning eclipse drawn per pixel in one WebGL fragment shader.
 * Original HorizonX code, no libraries and no assets, so the editor and the
 * HTML/React/Svelte exports run the same file.
 *
 *   1. The fire of Ember Sun, unchanged: domain-warped flame tongues burn evenly
 *      round a torn, rippling rim, with heat haze, a white-hot rim line, bloom
 *      and embers drifting up. Ripples land on the rim at random angles.
 *   2. Inside, nothing: the disc is one flat colour (near-black by default)
 *      right up to a thin molten lip on the inside of the rim, like a moon
 *      covering the sun. The pointer never lights or changes it.
 *   3. The pointer leans the flames toward it, pulls the rim out and makes it
 *      flare under it, and drops ripples as it moves; the wheel makes the fire
 *      roar.
 */

export const DEFAULT_EMBER_ECLIPSE_CONFIG = {
  viewportWidth: 1040,
  viewportHeight: 620,
  size: 0.3,
  background: '#07080a',
  disc: '#010102',
  flames: 1,
  embers: 1,
  ripples: 1,
  speed: 1,
  animate: true,
  interactive: true
};

// The eclipse's radius in shader units. The fire is drawn at a fixed size in
// these units (flames reach 0.17), so the whole eclipse scales with `size`.
const R_UNITS = 0.42;

const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';

const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform vec2  uArc;      // top of the rim, canvas px (y from bottom); the centre is uRadius below
uniform float uUnit;     // canvas px per unit
uniform float uRadius;   // disc radius in units
uniform float uTime;
uniform float uFlow;     // flame/ember time; runs faster while the wheel spins or the pointer moves
uniform float uClock;    // wall clock for pointer ripples, so they fade even while paused
uniform vec2  uMouse;    // pointer in units, same space as p
uniform float uMouseOn;  // 0..1 pointer influence (fades when idle)
uniform vec2  uMouseVel; // smoothed pointer velocity, units/s
uniform vec3  uPR[4];    // pointer ripples: xy position, z start (uClock)
uniform float uScrollVel;// 0..1.5 smoothed wheel speed
uniform vec3  uBg;       // background, before the tone map
uniform vec3  uDisc;     // the disc, before the tone map
uniform float uFlames;   // flame height multiplier
uniform float uEmbers;   // ember density, 0..2
uniform float uRipples;  // ripple strength, 0..2

const float PI = 3.14159265;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
vec3 fireRamp(float x){
  x = clamp(x, 0.0, 1.0);
  vec3 c = mix(vec3(0.0), vec3(0.38, 0.025, 0.0), smoothstep(0.0, 0.22, x));
  c = mix(c, vec3(0.95, 0.2, 0.02), smoothstep(0.18, 0.5, x));
  c = mix(c, vec3(1.0, 0.52, 0.12), smoothstep(0.48, 0.78, x));
  c = mix(c, vec3(1.0, 0.9, 0.72), smoothstep(0.82, 1.0, x));
  return c;
}

// Torn, rippling rim at arc position s = angle * radius
float rimJag(float s, float t){
  return (fbm(vec2(s * 7.0, t * 0.35)) - 0.5) * 0.026
       + (noise(vec2(s * 40.0, t * 1.5)) - 0.5) * 0.006;
}
// Flame tongues at arc position s: x = noise, yz = domain warp
vec3 flameField(float s, float h, float lean, float fl){
  vec2 fp = vec2(s * 3.6 - lean * max(h, 0.0) * 3.6 * 2.4, h * 2.6 - fl * 0.9);
  vec2 warp = vec2(fbm(fp * 1.25 + vec2(0.0, fl * 0.18)), fbm(fp * 1.25 + vec2(3.7, -fl * 0.14)));
  float n = fbm(fp * 2.2 + warp * 1.8 - vec2(0.0, fl * 0.6));
  return vec3(n, warp);
}
float lavaField(float s, float h, vec2 warp, float t){
  return fbm(vec2(s * 4.0, h * 5.0 + t * 0.22) + warp);
}

void main(){
  vec2 p0 = (gl_FragCoord.xy - uArc) / uUnit;  // top of the rim = origin
  vec2 p = p0;
  float t = uTime;
  float fl = uFlow;
  vec2 centre = vec2(0.0, -uRadius);

  // Pointer influence (broad field and a tight core)
  vec2 dm = p0 - uMouse;
  float md2 = dot(dm, dm);
  float near = exp(-md2 * 9.0) * uMouseOn;
  float core = exp(-md2 * 70.0) * uMouseOn;

  /* 1. Ripple impulses dropped on the rim at seeded angles */
  vec2 disp = vec2(0.0);
  float rippleLight = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float period = 4.6 + fi * 0.9;
    float ph = t / period + fi * 0.31;
    float cyc = floor(ph);
    float age = fract(ph);
    float a = hash(vec2(cyc, fi + 1.7)) * 2.0 * PI;
    float rr = uRadius + (hash(vec2(fi + 4.1, cyc)) - 0.35) * 0.3;
    vec2 c = centre + rr * vec2(sin(a), cos(a));
    vec2 dv = p - c;
    float d = length(dv);
    float band = d - age * 0.75;
    float w = sin(band * 52.0) * exp(-band * band * 140.0) * (1.0 - age) * (1.0 - age) * uRipples;
    disp += dv / (d + 1e-3) * w * 0.011;
    rippleLight += abs(w) * (1.0 - age);
  }
  // Ripples dropped by the pointer as it moves
  for (int i = 0; i < 4; i++) {
    vec3 r = uPR[i];
    float age = (uClock - r.z) / 1.5;
    if (age > 0.0 && age < 1.0) {
      vec2 dv = p0 - r.xy;
      float d = length(dv);
      float band = d - age * 0.55;
      float w = sin(band * 46.0) * exp(-band * band * 150.0) * (1.0 - age) * (1.0 - age) * uRipples;
      disp += dv / (d + 1e-3) * w * 0.017;
      rippleLight += abs(w) * (1.0 - age) * 1.6;
    }
  }

  float flameH = 0.17 * uFlames * (1.0 + 0.9 * near + 0.5 * min(uScrollVel, 1.0));

  /* 2. Rising heat haze, only near the fire (beyond it, it would only nudge the faint glow) */
  vec2 q = p + disp;
  bool fire = length(q - centre) - uRadius - 0.05 * exp(-md2 * 6.0) * uMouseOn < flameH * 1.18 + 0.05;
  if (fire) {
    vec2 hz = vec2(fbm(p * 3.2 + vec2(0.0, -t * 0.7)),
                   fbm(p * 3.2 + vec2(5.2, -t * 0.7 + 1.3))) - 0.5;
    q += hz * 0.012 * (1.0 + uScrollVel * 1.4 + near * 1.6);
  }

  /* 3. The burning rim */
  vec2 rel = q - centre;
  float dist = length(rel);
  float ang = atan(rel.x, rel.y);              // 0 at the top, ±PI at the bottom
  float h = dist - uRadius;                    // > 0 outside the disc
  h -= 0.05 * exp(-md2 * 6.0) * uMouseOn;      // rim is pulled toward the pointer

  // The angle jumps from +PI to -PI at the bottom; blend both sides of that seam
  // and restore the noise contrast the average would flatten.
  float s = ang * uRadius;
  float s2 = s - sign(ang) * 2.0 * PI * uRadius;
  float seam = 0.5 * smoothstep(PI - 0.45, PI, abs(ang));
  float keep = inversesqrt((1.0 - seam) * (1.0 - seam) + seam * seam);

  if (fire) {
    float jag = rimJag(s, t);
    if (seam > 0.0) jag = mix(jag, rimJag(s2, t), seam) * keep;
    h += jag;
  }

  // Flames lean toward the pointer and with its motion, along the rim; higher parts bend more.
  // The flame noise only shows between the disc's edge (h = -0.03, the disc covers everything
  // below) and 1.18 flame heights out, where no tongue can reach.
  vec2 tng = vec2(cos(ang), -sin(ang));
  float lean = clamp(dot(uMouse - p0, tng) * 2.2 * near + dot(uMouseVel, tng) * 0.45 * exp(-md2 * 3.0) * uMouseOn, -1.4, 1.4);
  vec3 ff = vec3(0.0);
  if (h > -0.03 && h < flameH * 1.18) {
    ff = flameField(s, h, lean, fl);
    if (seam > 0.0) {
      vec3 ff2 = flameField(s2, h, lean, fl);
      ff = vec3(0.5 + (mix(ff.x, ff2.x, seam) - 0.5) * keep, mix(ff.yz, ff2.yz, seam));
    }
  }
  float n = ff.x;
  vec2 warp = ff.yz;

  float heat = 0.0;
  if (h > 0.0) {
    // Thresholded noise gives separate tongues instead of a uniform haze
    float tongue = n * 1.15 - h / flameH * 0.85 - 0.12;
    heat = smoothstep(0.0, 0.75, tongue) * 1.05;
    heat += exp(-h * 38.0) * 0.3;                 // hot base hugging the rim
  } else {
    float lava = 0.0;
    if (h > -0.03) {
      lava = lavaField(s, h, warp, t);
      if (seam > 0.0) lava = mix(lava, lavaField(s2, h, warp, t), seam);
    }
    heat = exp(h * 48.0) * 0.8 + exp(h * 7.0) * lava * 0.18;
  }
  heat += exp(-abs(h) * 260.0) * 0.6;              // white-hot rim line
  heat += exp(-md2 * 26.0) * exp(-abs(h) * 9.0) * 0.45 * uMouseOn;   // rim flares under the pointer
  heat *= 0.9;

  vec3 col = uBg;
  col += fireRamp(heat);

  // Soft atmospheric bloom around the eclipse
  if (h > 0.0) col += vec3(1.0, 0.3, 0.05) * 0.16 * exp(-h * 4.5);
  // Warm torchlight around the pointer
  col += vec3(1.0, 0.36, 0.07) * (core * 0.05 + near * 0.025);
  // The disc: one flat colour right up to a thin molten lip on the inside of the torn rim, so the
  // edge burns exactly like the sun's while nothing of the inside shows.
  float moon = smoothstep(-0.006, -0.03, h);
  col = mix(col, uDisc, moon);

  /* 4. Embers drifting up from the rim */
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float sc = 13.0 + fk * 10.0;
    // embers are pushed away from the pointer and rise faster while the wheel spins
    vec2 pe = p - dm / (sqrt(md2) + 0.05) * near * 0.04;
    vec2 sp = pe * sc + vec2(fk * 3.1, -fl * (1.2 + fk * 0.7));
    vec2 id = floor(sp);
    vec2 gv = fract(sp) - 0.5;
    float rnd = hash(id + fk * 13.0);
    vec2 off = (vec2(hash(id + 1.3), hash(id + 7.1)) - 0.5) * 0.6
             + vec2(sin(t * 1.7 + rnd * 6.28) * 0.18, 0.0);
    float sp2 = smoothstep(0.07 - fk * 0.02, 0.0, length(gv - off)) * step(1.0 - 0.13 * uEmbers, rnd);
    sp2 *= 0.55 + 0.45 * sin(t * 7.0 + rnd * 40.0);
    float mask = smoothstep(0.5 * uFlames, 0.02, h) * step(0.0, h);
    col += vec3(1.0, 0.55, 0.18) * sp2 * mask * 1.3;
  }

  // Ripple rings catch the firelight near the rim (not on the disc)
  col += vec3(1.0, 0.45, 0.12) * rippleLight * 0.12 * exp(-abs(h) * 6.0) * (1.0 - moon);

  col += (hash(gl_FragCoord.xy + fract(t) * 100.0) - 0.5) * 0.016 * (1.0 - moon * 0.75);   // film grain, faint on the disc
  col = max(col, 0.0);
  col = col / (1.0 + col * 0.1);
  gl_FragColor = vec4(col, 1.0);
}`;

const UNIFORMS = ['uRes', 'uArc', 'uUnit', 'uRadius', 'uTime', 'uFlow', 'uClock', 'uMouse', 'uMouseOn', 'uMouseVel',
  'uPR', 'uScrollVel', 'uBg', 'uDisc', 'uFlames', 'uEmbers', 'uRipples'];

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16) || 0;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const ease = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
// The shader tone-maps col / (1 + 0.1 col); colours go in through the inverse so the stage and
// the disc show exactly the chosen colour.
const untoned = (hex) => hexToRgb(hex).map((c) => c / (1 - 0.1 * c));

/**
 * Mounts the eclipse into `root` (the element holding `.eec-stage` and
 * `.eec-status`). Returns an idempotent disposer with update(config); updates
 * keep the GPU context.
 */
export function buildEmberEclipse(root, config) {
  let disposed = false;
  let values = { ...DEFAULT_EMBER_ECLIPSE_CONFIG, ...config };
  const stage = root.querySelector('.eec-stage');
  const status = root.querySelector('.eec-status');
  root.removeAttribute('data-ready');
  root.removeAttribute('data-fallback');
  if (status) status.textContent = '';

  const canvas = document.createElement('canvas');
  // Inline styles survive Svelte scoping.
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'A burning eclipse: a dark disc ringed by fire.');
  stage?.append(canvas);

  let gl = null;
  try {
    gl = stage ? canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' }) : null;
  } catch {
    gl = null;
  }

  let ok = false, u = null;
  const fail = () => {
    ok = false;
    canvas.style.display = 'none';
    root.removeAttribute('data-ready');
    root.setAttribute('data-fallback', '');
    if (status) status.textContent = 'The eclipse needs WebGL. Enable hardware acceleration and reload to see it.';
  };

  const init = () => {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const vs = sh(gl.VERTEX_SHADER, VERT);
    const fs = sh(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn(gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(prog));
      fail();
      return;
    }
    gl.useProgram(prog);
    u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ok = true;
    canvas.style.display = 'block';
    root.removeAttribute('data-fallback');
    if (status) status.textContent = '';
  };
  if (gl) init(); else fail();

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const listen = { passive: true };

  /* Render resolution, in canvas px per css px. It starts at 1, climbs toward the screen's density (at most
     1.5) while frames keep up, and steps down when they fall behind. A frame cap (a battery saver holding
     the page at 30 fps) is told apart from real load because a smaller canvas does not speed it up, and
     then the resolution is put back instead of blurring the fire for nothing. */
  const MAX_SCALE = Math.min(window.devicePixelRatio || 1, 1.5), MIN_SCALE = 0.5;
  let scale = Math.min(1, MAX_SCALE);
  const pace = { avg: 16.7, n: 0, slow: 0, fast: 0, ceiling: MAX_SCALE, ceilingUntil: 0, probe: null, capUntil: 0, capWait: 30000 };
  const tune = (ms, now) => {                          // true when the canvas has to be resized
    if (++pace.n < 30) return false;                   // the first frames include the shader compile
    pace.avg += (Math.min(ms, 100) - pace.avg) * 0.08;
    if (pace.probe) {                                  // just stepped down: wait, then check it helped
      if (pace.n - pace.probe.n < 45) return false;
      const { scale: before, avg } = pace.probe;
      pace.probe = null;
      if (pace.avg > avg * 0.88) {                     // no faster: a frame cap, not load. Retry later, less often
        scale = before; pace.capUntil = now + pace.capWait; pace.capWait = Math.min(pace.capWait * 2, 300000);
        return true;
      }
    }
    if (pace.avg > 25 && now > pace.capUntil) {        // under ~40 fps
      pace.fast = 0;
      if (++pace.slow > 20 && scale > MIN_SCALE) {
        pace.probe = { scale, avg: pace.avg, n: pace.n };
        pace.ceiling = scale; pace.ceilingUntil = now + 20000;
        scale = Math.max(MIN_SCALE, scale * 0.85); pace.slow = 0;
        return true;
      }
      return false;
    }
    pace.slow = Math.max(0, pace.slow - 1);
    if (pace.avg < 18.5) {                             // keeping up with a 60 Hz screen, or faster
      const up = Math.min(MAX_SCALE, scale * 1.1);
      if (++pace.fast > 90 && up > scale + 0.01 && (now > pace.ceilingUntil || up < pace.ceiling)) {
        scale = up; pace.fast = 0; return true;
      }
    } else pace.fast = 0;
    return false;
  };

  // Geometry in css px: the radius is `size` of the stage's short side and the centre sits mid-stage.
  const geo = { w: 1, h: 1, cx: 0, topYCss: 0, unitCss: 500, arcY: 0 };
  const layout = () => {
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight);
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const radiusCss = Math.min(w, h) * values.size;
    const topYCss = h / 2 - radiusCss;
    Object.assign(geo, { w, h, cx: w / 2, topYCss, unitCss: radiusCss / R_UNITS, arcY: (h - topYCss) * scale });
  };

  let colors = { bg: [0, 0, 0], disc: [0, 0, 0] };
  const paint = () => { colors = { bg: untoned(values.background), disc: untoned(values.disc) }; };

  let raf = 0, last = 0, visible = true;
  let simTime = 8, flow = 8, clock = 0, demoClock = 0;

  /* ---- Pointer: target in eclipse units, smoothed in the loop so the fire follows with fluid lag ---- */
  const ptr = { tx: 0, ty: 0, x: 0, y: 0, on: 0, onT: 0, vx: 0, vy: 0, lastMove: -1e9, ex: 1e9, ey: 1e9, et: -1e9, ri: 0 };
  const ripples = new Float32Array(12).fill(-100);
  let lastRipple = -1e9, push = 0;
  const scr = { v: 0 };
  const live = () => ok && visible && !document.hidden && !reducedMotion.matches;
  // Editor and gallery stages start without a cursor, so a stand-in one circles the rim until a real
  // pointer arrives; the marker on the root retires it for good.
  const demoing = () => (values.pointerless || values.autoDemo) && values.interactive && root.dataset.hxPointer !== 'real' && !reducedMotion.matches;

  const aim = (ux, uy, tap) => {
    ptr.tx = ux; ptr.ty = uy; ptr.onT = 1; ptr.lastMove = performance.now();
    if (ptr.on < 0.05) { ptr.x = ux; ptr.y = uy; }             // no swoop in from the last position
    const moved = Math.hypot(ux - ptr.ex, uy - ptr.ey);
    if (tap || (moved > 0.07 && clock - ptr.et > 0.14)) {
      ripples.set([ux, uy, clock], (ptr.ri++ % 4) * 3);
      ptr.ex = ux; ptr.ey = uy; ptr.et = clock; lastRipple = clock;
    }
  };
  const release = () => { ptr.onT = 0; };
  const toUnits = (e) => {
    const r = root.getBoundingClientRect();
    const x = (e.clientX - r.left) * geo.w / (r.width || 1), y = (e.clientY - r.top) * geo.h / (r.height || 1);
    return [(x - geo.cx) / geo.unitCss, (geo.topYCss - y) / geo.unitCss];
  };
  const onPointer = (e, tap) => {
    if (e.isTrusted) root.dataset.hxPointer = 'real';
    if (!values.interactive || !live()) return;
    const [ux, uy] = toUnits(e);
    aim(ux, uy, tap);
    wake();
  };
  const onMove = (e) => onPointer(e, false);
  const onDown = (e) => onPointer(e, true);
  const onLeave = () => { release(); wake(); };
  const onWheel = (e) => {
    if (!values.interactive || !live()) return;
    push += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
    wake();
  };

  const step = (dt) => {
    if (demoing()) {
      // a slow loop that rides just outside the rim, so the flames lean and flare as it passes
      demoClock += dt;
      const ph = demoClock * 0.55;
      aim(R_UNITS * 1.15 * Math.sin(ph), -R_UNITS + R_UNITS * 1.15 * Math.cos(ph * 0.9 + 0.6), false);
    }
    if (performance.now() - ptr.lastMove > 2600) ptr.onT = 0;  // idle: hand control back to the autonomous fire
    const px = ptr.x, py = ptr.y;
    ptr.x = ease(ptr.x, ptr.tx, dt, 7); ptr.y = ease(ptr.y, ptr.ty, dt, 7);
    ptr.on = ease(ptr.on, ptr.onT, dt, ptr.onT > ptr.on ? 5 : 1.6);
    if (dt > 0) { ptr.vx = ease(ptr.vx, (ptr.x - px) / dt, dt, 6); ptr.vy = ease(ptr.vy, (ptr.y - py) / dt, dt, 6); }
    const vel = dt > 0 ? Math.min(push / dt / (window.innerHeight || 800), 1.5) : 0;
    push = 0;
    scr.v = ease(scr.v, vel, dt, vel > scr.v ? 8 : 2.2);
    if (values.animate) {
      const sdt = dt * values.speed;
      simTime += sdt;
      flow += sdt * (1 + scr.v * 1.6 + Math.min(Math.hypot(ptr.vx, ptr.vy), 2) * 0.35 * ptr.on);
    }
    clock += dt;
  };

  const draw = () => {
    if (!ok || gl.isContextLost()) return false;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform2f(u.uArc, canvas.width / 2, geo.arcY);
    gl.uniform1f(u.uUnit, geo.unitCss * scale);
    gl.uniform1f(u.uRadius, R_UNITS);
    gl.uniform1f(u.uTime, simTime);
    gl.uniform1f(u.uFlow, flow);
    gl.uniform1f(u.uClock, clock);
    gl.uniform2f(u.uMouse, ptr.x, ptr.y);
    gl.uniform1f(u.uMouseOn, ptr.on);
    gl.uniform2f(u.uMouseVel, ptr.vx, ptr.vy);
    gl.uniform3fv(u.uPR, ripples);
    gl.uniform1f(u.uScrollVel, scr.v);
    gl.uniform3fv(u.uBg, colors.bg);
    gl.uniform3fv(u.uDisc, colors.disc);
    gl.uniform1f(u.uFlames, values.flames);
    gl.uniform1f(u.uEmbers, values.embers);
    gl.uniform1f(u.uRipples, values.ripples);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    root.setAttribute('data-ready', '');
    return true;
  };

  // Keeps drawing while the fire plays, the pointer (real or stand-in) is active, or anything it set
  // in motion is still settling; otherwise the last frame holds.
  const busy = () => values.animate
    || (values.interactive && (demoing() || ptr.onT > 0 || ptr.on > 0.002 || scr.v > 0.002 || clock - lastRipple < 1.5));

  function frame(now) {
    raf = 0;
    if (disposed || !ok) return;
    const ms = last ? now - last : 1000 / 60;
    const run = live();
    step(run ? Math.min(ms / 1000, 0.05) : 0);
    // resize before drawing: resizing clears the canvas
    if (run && tune(ms, now)) layout();
    draw();
    if (run && busy()) { last = now; raf = requestAnimationFrame(frame); }
    else last = 0;
  }
  const wake = () => { if (!disposed && ok && !raf) raf = requestAnimationFrame(frame); };

  const onLost = (e) => {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    fail();
  };
  const onRestored = () => { if (disposed) return; init(); if (ok) { layout(); wake(); } };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  root.addEventListener('pointermove', onMove, listen);
  root.addEventListener('pointerdown', onDown, listen);
  root.addEventListener('pointercancel', onLeave, listen);
  root.addEventListener('pointerleave', onLeave, listen);
  root.addEventListener('wheel', onWheel, listen);
  reducedMotion.addEventListener?.('change', wake);
  document.addEventListener('visibilitychange', wake);
  // Redraw at once on resize: resizing clears the canvas.
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { layout(); draw(); wake(); }) : null;
  resize?.observe(root);
  // Off-screen eclipses stop drawing.
  const seen = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); wake(); })
    : null;
  seen?.observe(root);

  paint(); layout(); wake();

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointercancel', onLeave);
    root.removeEventListener('pointerleave', onLeave);
    root.removeEventListener('wheel', onWheel);
    reducedMotion.removeEventListener?.('change', wake);
    document.removeEventListener('visibilitychange', wake);
    resize?.disconnect();
    seen?.disconnect();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
    root.removeAttribute('data-ready');
    root.removeAttribute('data-fallback');
    if (status) status.textContent = '';
  };
  cleanup.update = (next) => {
    if (disposed) return;
    const size = values.size;
    values = { ...values, ...next };
    if (!values.interactive) release();
    paint();
    if (values.size !== size) layout();
    wake();
  };
  return cleanup;
}
