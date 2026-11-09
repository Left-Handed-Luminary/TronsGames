// Unit tests for templates/lib/camera.js — run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monotoneCubic, monotoneTangents, makeTimeline, fillShots, drift, cameraFromShot,
  projectionMatrix, projectPoint, jitterToNdc, halton, subSamples, samplesForMotion, DEFAULT_SHOT,
} from '../templates/lib/camera.js';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b} (eps ${eps})`);

test('monotone cubic passes through knots', () => {
  const xs = [0, 1, 2.5, 4]; const ys = [0, 3, 3.5, -1];
  const f = monotoneCubic(xs, ys);
  xs.forEach((x, i) => close(f(x), ys[i], 1e-12));
});

test('monotone cubic never overshoots between knots', () => {
  const xs = [0, 1, 1.2, 3, 5, 5.5]; const ys = [0, 10, 10.5, 2, 2, 9];
  const f = monotoneCubic(xs, ys);
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = Math.min(ys[i], ys[i + 1]); const hi = Math.max(ys[i], ys[i + 1]);
    for (let k = 0; k <= 50; k++) {
      const v = f(xs[i] + (xs[i + 1] - xs[i]) * (k / 50));
      assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `segment ${i}: ${v} outside [${lo}, ${hi}]`);
    }
  }
});

test('equal neighbouring keys make a dead-still hold (zero tangent)', () => {
  const m = monotoneTangents([0, 1, 2, 3], [0, 5, 5, 8]);
  assert.equal(m[1], 0);
  assert.equal(m[2], 0);
  const f = monotoneCubic([0, 1, 2, 3], [0, 5, 5, 8]);
  close(f(1.5), 5, 1e-12);
});

test('monotone cubic rejects non-increasing knots', () => {
  assert.throws(() => monotoneCubic([0, 1, 1], [0, 1, 2]), /strictly increase/);
});

test('speed is continuous: no jump in derivative at knots', () => {
  const f = monotoneCubic([0, 1, 2, 4], [0, 2, 3, 3.5]);
  const h = 1e-5;
  for (const x of [1, 2]) {
    const left = (f(x) - f(x - h)) / h; const right = (f(x + h) - f(x)) / h;
    close(left, right, 1e-3, `derivative jumps at ${x}: ${left} vs ${right}`);
  }
});

test('fillShots inherits missing keys forward', () => {
  const [a, b] = fillShots([{ t: 0, fov: 2 }, { t: 1, W: 9 }]);
  assert.equal(a.W, DEFAULT_SHOT.W);
  assert.equal(b.fov, 2);
  assert.equal(b.W, 9);
});

test('drift scales W only', () => {
  const d = drift({ t: 0, W: 20, fov: 2 }, 1.5);
  assert.equal(d.t, 1.5); close(d.W, 19.2); assert.equal(d.fov, 2);
});

test('timeline loops seamlessly and wraps time', () => {
  const base = { t: 0, W: 20, fov: 2, x: 1 };
  const tl = makeTimeline([base, { t: 2, fov: 50 }, { ...base, t: 4 }], { period: 4 });
  for (const k of ['W', 'fov', 'x']) close(tl.at(0)[k], tl.at(4)[k], 1e-9);
  close(tl.at(1).fov, tl.at(5).fov, 1e-9);
  close(tl.at(-1).fov, tl.at(3).fov, 1e-9);
});

test('timeline rejects a broken seam', () => {
  assert.throws(() => makeTimeline([{ t: 0, fov: 2 }, { t: 4, fov: 3 }], { period: 4 }), /loop seam/);
});

test('fov and W interpolate in log space', () => {
  const tl = makeTimeline([{ t: 0, fov: 2, W: 10 }, { t: 1, fov: 50, W: 40 }]);
  // symmetric Hermite with equal end tangents in log space: midpoint is the geometric mean
  close(tl.at(0.5).fov, Math.sqrt(2 * 50), 1e-9);
  close(tl.at(0.5).W, Math.sqrt(10 * 40), 1e-9);
});

test('timeScale stretches key times', () => {
  const tl = makeTimeline([{ t: 0, fov: 2 }, { t: 1, fov: 8 }, { t: 2, fov: 2 }], { period: 2, timeScale: 1.5 });
  assert.equal(tl.period, 3);
  close(tl.at(1.5).fov, 8, 1e-9);
});

const ASPECT = 16 / 9;
const W = 1920; const H = 1080;

test('focus point lands at NDC (0, H) for any lens, yaw and elevation', () => {
  for (const shot of [
    { ...DEFAULT_SHOT, zf: -30, fov: 2, W: 15 },
    { ...DEFAULT_SHOT, zf: -30, fov: 55, W: 24, H: -0.35, y: 1.4 },
    { ...DEFAULT_SHOT, zf: -30, fov: 4, W: 30, yaw: 22, el: 42, H: -0.1 },
    { ...DEFAULT_SHOT, zf: -30, fov: 38, W: 30, yaw: -20, el: 50 },
  ]) {
    const cam = cameraFromShot(shot, ASPECT);
    const p = projectPoint(cam, [shot.x, shot.y, shot.zf], W, H);
    close(p.ndcX, 0, 1e-9); close(p.ndcY, shot.H, 1e-9);
  }
});

test('dolly zoom: the focus plane keeps its framed width W', () => {
  for (const fov of [2, 10, 45, 90]) {
    const shot = { ...DEFAULT_SHOT, zf: -30, fov, W: 26 };
    const cam = cameraFromShot(shot, ASPECT);
    const edge = projectPoint(cam, [shot.x + 13, shot.y, shot.zf], W, H);
    close(edge.ndcX, 1, 1e-9);
  }
});

test('the camera is never tilted: verticals project vertical', () => {
  const cam = cameraFromShot({ ...DEFAULT_SHOT, zf: -30, fov: 40, W: 20, yaw: 25, el: 45 }, ASPECT);
  const a = projectPoint(cam, [3, 0, -40], W, H);
  const b = projectPoint(cam, [3, 12, -40], W, H);
  close(a.ndcX, b.ndcX, 1e-9);
});

test('elevation raises the horizon above the focus point', () => {
  const flat = cameraFromShot({ ...DEFAULT_SHOT, fov: 30 }, ASPECT);
  const high = cameraFromShot({ ...DEFAULT_SHOT, fov: 30, el: 30 }, ASPECT);
  close(flat.shiftY, 0);
  assert.ok(high.shiftY > 0.5);
  assert.ok(high.position[1] > flat.position[1]);
});

test('projectionMatrix agrees with projectPoint, including jitter', () => {
  const cam = cameraFromShot({ ...DEFAULT_SHOT, zf: -30, fov: 35, W: 18, yaw: 15, el: 20, H: -0.2 }, ASPECT);
  const j = jitterToNdc(0.3, -0.4, W, H);
  const e = projectionMatrix(cam, j);
  const p = [2, 3, -45];
  // view space by hand (inverse yaw rotation)
  const [dx, dy, dz] = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const c = Math.cos(cam.yaw); const s = Math.sin(cam.yaw);
  const v = [c * dx - s * dz, dy, s * dx + c * dz, 1];
  const clip = [0, 1, 2, 3].map((r) => e[r] * v[0] + e[4 + r] * v[1] + e[8 + r] * v[2] + e[12 + r] * v[3]);
  const q = projectPoint(cam, p, W, H, j);
  close(clip[0] / clip[3], q.ndcX, 1e-9);
  close(clip[1] / clip[3], q.ndcY, 1e-9);
  const zN = clip[2] / clip[3];
  assert.ok(zN > -1 && zN < 1, 'point inside near/far');
});

test('projectPoint returns null behind the camera', () => {
  const cam = cameraFromShot({ ...DEFAULT_SHOT, zf: -30, fov: 40, W: 20 }, ASPECT);
  assert.equal(projectPoint(cam, [0, 1.6, cam.position[2] + 5], W, H), null);
});

test('halton values are in [0,1) and distinct', () => {
  const v = Array.from({ length: 32 }, (_, i) => halton(i + 1, 2));
  assert.ok(v.every((x) => x >= 0 && x < 1));
  assert.equal(new Set(v).size, v.length);
});

test('subSamples spread over the shutter, centred on the frame time', () => {
  const s = subSamples(1000, 8, 1000 / 60, 0.5);
  assert.equal(s.length, 8);
  const mean = s.reduce((a, x) => a + x[0], 0) / s.length;
  close(mean, 1000, 1e-9);
  assert.ok(s.every(([t, jx, jy]) => Math.abs(t - 1000) <= 0.25 * 1000 / 60 && Math.abs(jx) <= 0.5 && Math.abs(jy) <= 0.5));
  assert.deepEqual(subSamples(5, 1, 16)[0][0], 5);
});

test('samplesForMotion: 4 when still, scales with travel, clamps at max', () => {
  const pt = (x, y) => ({ px: x, py: y });
  assert.equal(samplesForMotion([pt(0, 0)], [pt(0.1, 0)]), 4);
  assert.equal(samplesForMotion([pt(0, 0)], [pt(10, 0)]), 10);
  assert.equal(samplesForMotion([pt(0, 0)], [pt(500, 0)]), 32);
  assert.equal(samplesForMotion([null, pt(0, 0)], [pt(9, 9), pt(0, 6)]), 6);
});
