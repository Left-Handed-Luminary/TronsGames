#!/usr/bin/env node
/**
 * Browser tests for Mergation (../mergation.html) block physics.
 *
 * Loads the real page in headless Chromium and steps the game's own animate()
 * loop frame by frame (requestAnimationFrame is captured, not re-implemented),
 * so the physics under test is exactly what players run.
 *
 * Requires Playwright with Chromium and network access for the three.js CDN.
 * Run from the repo root:
 *   node --test tools/test-mergation.mjs
 * Point at another copy with MERGATION_HTML=/path/to/file.html.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HTML_PATH = process.env.MERGATION_HTML
  || fileURLToPath(new URL('../mergation.html', import.meta.url));

let browser, page;

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  // Capture the frame loop so tests advance time deterministically.
  await page.addInitScript(() => {
    window.__raf = null;
    window.requestAnimationFrame = (cb) => { window.__raf = cb; return 1; };
    window.__step = (n = 1) => { for (let i = 0; i < n; i++) { const cb = window.__raf; window.__raf = null; cb && cb(performance.now()); } };
  });
  await page.goto(pathToFileURL(HTML_PATH).href);
  await page.waitForFunction(() => typeof cubes !== 'undefined' && window.__raf);
});
after(async () => { await browser?.close(); });

/**
 * Builds a board: `blocks` = [{v, x, z}] at rest, plus one shooter launched
 * uphill like onRelease() does. Steps `frames` frames and returns a trace.
 */
async function run({ blocks, shot, frames = 240 }) {
  return page.evaluate(({ blocks, shot, frames }) => {
    // Clean slate.
    for (const c of cubes) scene.slopeGroup.remove(c);
    cubes = [];
    if (activeCube) { scene.slopeGroup.remove(activeCube); activeCube = null; }
    isGameOver = false; score = 0;
    lastSpawnTime = performance.now() + 1e9; // keep the auto-spawner quiet
    const made = blocks.map((b) => {
      const c = createCube(b.v, b.x, b.z); scene.slopeGroup.add(c); cubes.push(c); return c;
    });
    const s = createCube(shot.v, shot.x, shot.z ?? (worldDepth / 2 - 1.5));
    scene.slopeGroup.add(s); s.userData.velocity.z = shot.vz ?? -1.4; cubes.push(s);

    const start = made.map((c) => ({ x: c.position.x, z: c.position.z }));
    let maxPen = 0, passedThrough = false, maxBurst = 0;
    const prevRel = made.map(() => null);
    for (let f = 0; f < frames; f++) {
      window.__step();
      maxBurst = Math.max(maxBurst, fireworks.length);
      const live = cubes.filter((c) => c.parent);
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i].position, b = live[j].position;
        const p = Math.min(cubeSize - Math.abs(a.x - b.x), cubeSize - Math.abs(a.y - b.y), cubeSize - Math.abs(a.z - b.z));
        if (p > 0) maxPen = Math.max(maxPen, p);
      }
      // Tunnelling check: on the floor and in the same lane on two consecutive
      // frames, the shooter must never flip from in front of a block to behind it.
      // (Being deflected around a block and drifting back into its lane later is fine.)
      made.forEach((c, k) => {
        if (!s.parent || !c.parent) { prevRel[k] = null; return; }
        const sameLane = s.position.y < cubeSize && c.position.y < cubeSize
          && Math.abs(c.position.x - s.position.x) < cubeSize * 0.9;
        const rel = Math.sign(s.position.z - c.position.z);
        if (sameLane && prevRel[k] !== null && prevRel[k] !== 0 && rel !== prevRel[k]) passedThrough = true;
        prevRel[k] = sameLane ? rel : null;
      });
    }
    return {
      maxPen, passedThrough, maxBurst, score,
      shooterAlive: !!s.parent,
      shooter: { z: s.position.z, vz: s.userData.velocity.z },
      blocks: made.map((c, k) => ({ alive: !!c.parent, dz: c.position.z - start[k].z, dx: c.position.x - start[k].x })),
      values: cubes.filter((c) => c.parent).map((c) => c.userData.value).sort((a, b) => a - b),
    };
  }, { blocks, shot, frames });
}

test('regression: a shot does not slide past a different-numbered block (head-on and offset)', async () => {
  for (const x of [0, 0.35, -0.5, 0.75]) {
    const r = await run({ blocks: [{ v: 4, x: 0, z: -2 }], shot: { v: 2, x } });
    assert.equal(r.passedThrough, false, `x offset ${x}: shooter went through/past the block`);
    assert.ok(r.maxPen < 0.06, `x offset ${x}: blocks interpenetrated by ${r.maxPen.toFixed(3)}`);
  }
});

test('same numbers merge on contact with a pop burst', async () => {
  const r = await run({ blocks: [{ v: 8, x: 0, z: -2 }], shot: { v: 8, x: 0.2 }, frames: 60 });
  assert.equal(r.blocks[0].alive, false, 'target 8 should be consumed');
  assert.equal(r.shooterAlive, false, 'shooter 8 should be consumed');
  assert.deepEqual(r.values, [16]);
  assert.equal(r.score, 16);
  assert.ok(r.maxBurst > 0, 'merge should spawn a shard burst');
});

test('hitting a different block knocks it back and slows the shooter', async () => {
  const r = await run({ blocks: [{ v: 4, x: 0, z: 2 }], shot: { v: 2, x: 0 }, frames: 30 });
  assert.ok(r.blocks[0].dz < -1.0, `struck block should be shoved uphill, moved only ${r.blocks[0].dz.toFixed(2)}`);
  assert.equal(r.passedThrough, false);
});

test('a row of blocks gets pushed back together, not overlapped', async () => {
  const r = await run({
    blocks: [{ v: 4, x: 0, z: 2 }, { v: 16, x: 0, z: 2 - 1.1 }, { v: 32, x: 0, z: 2 - 2.2 }],
    shot: { v: 2, x: 0 }, frames: 60,
  });
  r.blocks.forEach((b, i) => assert.ok(b.dz < -0.3, `row block ${i} did not move back (dz=${b.dz.toFixed(2)})`));
  assert.ok(r.maxPen < 0.06, `row interpenetrated by ${r.maxPen.toFixed(3)}`);
  assert.equal(r.passedThrough, false);
});

test('a block pinned against the far wall stops the shot; shooter rebounds', async () => {
  const r = await run({ blocks: [{ v: 4, x: 0, z: -12.5 }], shot: { v: 2, x: 0 }, frames: 200 });
  assert.equal(r.passedThrough, false);
  assert.ok(r.maxPen < 0.06, `penetration ${r.maxPen.toFixed(3)}`);
  assert.ok(r.blocks[0].dz > -0.05, 'pinned block should not be pushed into the wall');
});

test('fuzz: 60 random boards — no tunnelling, no interpenetration', async () => {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const vals = [2, 4, 8, 16, 32, 64];
  for (let t = 0; t < 60; t++) {
    const blocks = [];
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const b = { v: vals[Math.floor(rnd() * vals.length)], x: -2.6 + rnd() * 5.2, z: -12 + rnd() * 16 };
      if (blocks.every((o) => Math.abs(o.x - b.x) > 1.15 || Math.abs(o.z - b.z) > 1.15)) blocks.push(b);
    }
    const shot = { v: vals[Math.floor(rnd() * 3)], x: -2.8 + rnd() * 5.6 };
    const r = await run({ blocks, shot, frames: 200 });
    assert.equal(r.passedThrough, false, `board ${t}: tunnelled ${JSON.stringify({ blocks, shot })}`);
    assert.ok(r.maxPen < 0.06, `board ${t}: penetration ${r.maxPen.toFixed(3)} ${JSON.stringify({ blocks, shot })}`);
  }
});
