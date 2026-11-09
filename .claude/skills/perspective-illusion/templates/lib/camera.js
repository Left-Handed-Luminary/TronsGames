/**
 * camera.js — pure math for the perspective-illusion camera rig.
 *
 * No three.js dependency: the scene page and the Node renderers/tests share it.
 *
 * Conventions
 *  - World units are metres, y is up, the scene's long axis runs along -z.
 *  - The camera is NEVER tilted. Looking down is done by raising the camera and
 *    shifting the lens (an architect's "rise"), so verticals stay vertical.
 *  - A shot is { x, y, zf, W, fov, H, el, yaw, lay, cs } (see SKILL.md, Step 2).
 *    (x, y, zf) is the focus point; W is the width framed at the focus plane;
 *    fov is the HORIZONTAL lens angle in degrees.
 *
 * Projection matrices are column-major, three.js layout (elements[8]/[9] are the
 * lens-shift terms that setJitter also writes).
 */

export const DEG = Math.PI / 180;

/** Every key a shot carries, in a fixed order. */
export const SHOT_KEYS = ['x', 'y', 'zf', 'W', 'fov', 'H', 'el', 'yaw', 'lay', 'cs'];

/** Keys interpolated in log space, so a dolly zoom moves at an even visual rate. */
export const LOG_KEYS = new Set(['W', 'fov']);

export const DEFAULT_SHOT = Object.freeze({
  x: 0, y: 1.6, zf: 0, W: 20, fov: 30, H: 0, el: 0, yaw: 0, lay: 0, cs: 1,
});

// ---------------------------------------------------------------------------
// Monotone cubic interpolation (Fritsch-Carlson, Fritsch-Butland tangents)
// ---------------------------------------------------------------------------

/**
 * Tangents for a monotone piecewise-cubic Hermite through (xs, ys).
 * Interior tangents use the weighted harmonic mean of neighbouring secants,
 * which never overshoots: speed never jumps and holds stay perfectly still.
 *
 * @param {number[]} xs strictly increasing knots
 * @param {number[]} ys values
 * @param {boolean} periodic  treat ys[0] and ys[n-1] as the same point of a loop
 * @returns {number[]} tangents
 */
export function monotoneTangents(xs, ys, periodic = false) {
  const n = xs.length;
  if (n < 2) return [0];
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    if (!(h[i] > 0)) throw new Error(`knots must strictly increase (at index ${i})`);
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const blend = (dPrev, dNext, hPrev, hNext) => {
    if (dPrev * dNext <= 0) return 0; // local extremum or flat: stop dead
    const w1 = 2 * hNext + hPrev;
    const w2 = hNext + 2 * hPrev;
    return (w1 + w2) / (w1 / dPrev + w2 / dNext);
  };
  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) m[i] = blend(d[i - 1], d[i], h[i - 1], h[i]);
  if (periodic && n > 2) {
    m[0] = m[n - 1] = blend(d[n - 2], d[0], h[n - 2], h[0]);
  } else {
    m[0] = d[0];
    m[n - 1] = d[n - 2];
  }
  return m;
}

/** Index i with xs[i] <= x < xs[i+1] (clamped to a valid segment). */
function segmentIndex(xs, x) {
  let lo = 0;
  let hi = xs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Build a monotone cubic interpolant.
 * @returns {(x:number)=>number}
 */
export function monotoneCubic(xs, ys, periodic = false) {
  const m = monotoneTangents(xs, ys, periodic);
  const n = xs.length;
  return (x) => {
    if (n === 1) return ys[0];
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    const i = segmentIndex(xs, x);
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]
      + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1]
      + (t3 - t2) * h * m[i + 1];
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Fill missing keys forward so every key holds a complete shot.
 * The first key falls back to DEFAULT_SHOT; later keys inherit from the previous one.
 */
export function fillShots(keys) {
  let prev = { ...DEFAULT_SHOT };
  return keys.map((k) => {
    const shot = { ...prev };
    for (const key of SHOT_KEYS) if (k[key] !== undefined) shot[key] = k[key];
    prev = shot;
    return { t: k.t, ...shot };
  });
}

/** Return a copy of `shot` with every framing-scale parameter scaled (drift shot). */
export function drift(shot, t, factor = 0.96) {
  return { ...shot, t, W: shot.W * factor };
}

/**
 * Build a looping camera timeline.
 *
 * @param {Array<{t:number}>} keys  key shots, t in seconds, ascending.
 *   For a loop the last key's t must equal `period` and its shot must equal the first.
 * @param {{period?:number, timeScale?:number}} opts
 *   timeScale multiplies every key time (change the loop length without rewriting keys).
 * @returns {{ at:(tSec:number)=>object, period:number, keys:object[] }}
 */
export function makeTimeline(keys, opts = {}) {
  if (!keys.length) throw new Error('timeline needs at least one key');
  const scale = opts.timeScale ?? 1;
  const full = fillShots(keys).map((k) => ({ ...k, t: k.t * scale }));
  const period = opts.period !== undefined ? opts.period * scale : undefined;
  const periodic = period !== undefined;
  if (periodic) {
    const first = full[0];
    const last = full[full.length - 1];
    if (Math.abs(first.t) > 1e-9 || Math.abs(last.t - period) > 1e-9) {
      throw new Error('a looping timeline must start at t=0 and end at t=period');
    }
    for (const key of SHOT_KEYS) {
      if (Math.abs(first[key] - last[key]) > 1e-9) {
        throw new Error(`loop seam: key "${key}" differs between first and last shot`);
      }
    }
  }
  const xs = full.map((k) => k.t);
  const curves = {};
  for (const key of SHOT_KEYS) {
    const log = LOG_KEYS.has(key);
    const ys = full.map((k) => {
      if (log && !(k[key] > 0)) throw new Error(`"${key}" must be > 0 (log-space)`);
      return log ? Math.log(k[key]) : k[key];
    });
    const f = monotoneCubic(xs, ys, periodic);
    curves[key] = log ? (t) => Math.exp(f(t)) : f;
  }
  const wrap = (t) => (periodic ? ((t % period) + period) % period : t);
  return {
    period,
    keys: full,
    at(tSec) {
      const t = wrap(tSec);
      const shot = {};
      for (const key of SHOT_KEYS) shot[key] = curves[key](t);
      return shot;
    },
  };
}

// ---------------------------------------------------------------------------
// Shot -> camera
// ---------------------------------------------------------------------------

/**
 * Resolve a shot into a level camera with lens shift.
 *
 * @param {object} shot
 * @param {number} aspect width / height
 * @returns {{position:number[], yaw:number, tanH:number, tanV:number,
 *            shiftX:number, shiftY:number, near:number, far:number, distance:number}}
 *   shiftY is where the horizon lands in NDC (-1 bottom, +1 top).
 */
export function cameraFromShot(shot, aspect, opts = {}) {
  const sceneDepth = opts.sceneDepth ?? 900; // how far past the focus the scene reaches (m)
  const tanH = Math.tan((shot.fov * DEG) / 2);
  const tanV = tanH / aspect;
  const distance = shot.W / 2 / tanH; // horizontal distance camera -> focus point
  const yaw = shot.yaw * DEG;
  const el = shot.el * DEG;
  const rise = distance * Math.tan(el);
  const position = [
    shot.x + distance * Math.sin(yaw),
    shot.y + rise,
    shot.zf + distance * Math.cos(yaw),
  ];
  // Focus point lands at NDC y = H; the horizon sits rise/(distance*tanV) above it.
  const shiftY = shot.H + Math.tan(el) / tanV;
  const slant = Math.hypot(distance, rise);
  const near = Math.min(Math.max(slant * 0.03, 0.05), 30);
  const far = slant + sceneDepth;
  return { position, yaw, tanH, tanV, shiftX: 0, shiftY, near, far, distance };
}

/**
 * Column-major off-axis perspective matrix (three.js layout).
 * jitterNdc shifts the lens by a sub-pixel amount for anti-aliasing / motion blur.
 */
export function projectionMatrix(cam, jitterNdc = [0, 0]) {
  const { tanH, tanV, near: n, far: f } = cam;
  const e = new Array(16).fill(0);
  e[0] = 1 / tanH;
  e[5] = 1 / tanV;
  // ndc.x = x/(-z)/tanH - e[8]  ->  e[8] = -(shift + jitter)
  e[8] = -(cam.shiftX + jitterNdc[0]);
  e[9] = -(cam.shiftY + jitterNdc[1]);
  e[10] = -(f + n) / (f - n);
  e[11] = -1;
  e[14] = (-2 * f * n) / (f - n);
  return e;
}

/** Pixel jitter -> NDC offset for a framebuffer of size (w, h). */
export function jitterToNdc(jx, jy, w, h) {
  return [(2 * jx) / w, (2 * jy) / h];
}

/**
 * Project a world point to NDC and pixels (y down). Returns null behind the camera.
 */
export function projectPoint(cam, p, w, h, jitterNdc = [0, 0]) {
  const dx = p[0] - cam.position[0];
  const dy = p[1] - cam.position[1];
  const dz = p[2] - cam.position[2];
  // inverse of a rotation by +yaw about y
  const c = Math.cos(cam.yaw);
  const s = Math.sin(cam.yaw);
  const vx = c * dx - s * dz;
  const vz = s * dx + c * dz;
  const depth = -vz;
  if (depth <= 1e-6) return null;
  const ndcX = vx / depth / cam.tanH + cam.shiftX + jitterNdc[0];
  const ndcY = dy / depth / cam.tanV + cam.shiftY + jitterNdc[1];
  return { ndcX, ndcY, px: ((ndcX + 1) / 2) * w, py: ((1 - ndcY) / 2) * h, depth };
}

// ---------------------------------------------------------------------------
// Sampling helpers shared by the page and the renderers
// ---------------------------------------------------------------------------

/** Radical inverse (Halton) in base b — low-discrepancy jitter. */
export function halton(i, b) {
  let f = 1;
  let r = 0;
  let k = i;
  while (k > 0) {
    f /= b;
    r += f * (k % b);
    k = Math.floor(k / b);
  }
  return r;
}

/**
 * Sub-render list for one output frame: [[ms, jx, jy], ...].
 * Samples spread over the shutter interval and over the pixel (Halton 2,3).
 *
 * @param {number} ms       frame centre time
 * @param {number} count    number of sub-renders
 * @param {number} frameMs  frame duration
 * @param {number} shutter  fraction of the frame the shutter is open (0..1)
 */
export function subSamples(ms, count, frameMs, shutter = 0.5) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const tFrac = count === 1 ? 0 : (i + 0.5) / count - 0.5;
    out.push([ms + tFrac * shutter * frameMs, halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);
  }
  return out;
}

/**
 * How many sub-renders a frame needs: 4 for anti-aliasing, more when probe points
 * travel far on screen during the shutter, so motion blur stays gapless.
 *
 * @param {Array<{px:number,py:number}|null>} a  probe at shutter open
 * @param {Array<{px:number,py:number}|null>} b  probe at shutter close
 */
export function samplesForMotion(a, b, { min = 4, max = 32, pxPerSample = 1.0 } = {}) {
  let travel = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!a[i] || !b[i]) continue;
    travel = Math.max(travel, Math.hypot(a[i].px - b[i].px, a[i].py - b[i].py));
  }
  return Math.min(max, Math.max(min, Math.ceil(travel / pxPerSample)));
}
