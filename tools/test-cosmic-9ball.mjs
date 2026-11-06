#!/usr/bin/env node
/**
 * Browser tests for Cosmic 9-Ball Pool (../cosmic-9ball.html).
 *
 * Loads the real game page in headless Chromium and drives the shipped `Game`
 * object, so the physics and input code under test is exactly what players run.
 *
 * Requires Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
 * Run from the repo root:
 *   node --test tools/test-cosmic-9ball.mjs
 * Point at another copy of the game with COSMIC_HTML=/path/to/file.html.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HTML_PATH = process.env.COSMIC_HTML
  || fileURLToPath(new URL('../cosmic-9ball.html', import.meta.url));

let browser, page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(pathToFileURL(HTML_PATH).href);
  await page.waitForFunction(() => typeof Game !== 'undefined' && Game.cueBall);
});
after(async () => { await browser?.close(); });

/** Clears the table to a known state and returns the felt bounds. */
async function resetTable() {
  return page.evaluate(() => {
    Game.isGameWon = false;
    Game.ballInHand = false;
    Game.isBallsMoving = false;
    Game.isDraggingAim = false;
    Game.power = 50;
    Game.ballsPocketedThisShot = [];
    for (const b of Game.balls) { b.isPocketed = true; b.vx = 0; b.vy = 0; }
    return Game.getCushionBounds();
  });
}

/**
 * Places a single ball with a velocity and steps physics until it stops or
 * drops. Records the worst escape beyond the felt for an unpocketed ball.
 */
async function rollBall({ x, y, vx, vy, num = 1 }) {
  return page.evaluate(({ x, y, vx, vy, num }) => {
    const b = Game.balls.find((q) => q.num === num);
    Object.assign(b, { x, y, vx, vy, isPocketed: false });
    Game.isBallsMoving = true;
    Game.ballsPocketedThisShot = [];
    const bd = Game.getCushionBounds();
    let worst = 0;
    for (let f = 0; f < 2000; f++) {
      Game.updatePhysics();
      if (!b.isPocketed) {
        worst = Math.max(worst,
          bd.minX - (b.x - b.radius), (b.x + b.radius) - bd.maxX,
          bd.minY - (b.y - b.radius), (b.y + b.radius) - bd.maxY);
      }
      if (b.isPocketed || (b.vx === 0 && b.vy === 0)) break;
    }
    // Final resting spot must always be on the felt.
    const onFelt = b.isPocketed || (
      b.x - b.radius >= bd.minX - 0.01 && b.x + b.radius <= bd.maxX + 0.01 &&
      b.y - b.radius >= bd.minY - 0.01 && b.y + b.radius <= bd.maxY + 0.01);
    const t = Game.table;
    const offTable = !b.isPocketed && (b.x < t.x || b.x > t.x + t.w || b.y < t.y || b.y > t.y + t.h);
    return { pocketed: b.isPocketed, onFelt, offTable, worst, x: b.x, y: b.y };
  }, { x, y, vx, vy, num });
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

test('regression: ball driven down the rail into the old corner gap stays on the table', async () => {
  // Old code skipped the cushion within 30px of a corner but only captured
  // within ~23px of the pocket. This exact shot (found by the fuzz test) flew
  // off the bottom of the screen to y≈2400. Checked at all four corners.
  const bd = await resetTable();
  const cx = (bd.minX + bd.maxX) / 2, cy = (bd.minY + bd.maxY) / 2;
  const base = { x: 852.7, y: 476.9, a: 1.47, s: 23.3 };
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    await resetTable();
    const x = cx + (base.x - cx) * sx, y = cy + (base.y - cy) * sy;
    const vx = Math.cos(base.a) * base.s * sx, vy = Math.sin(base.a) * base.s * sy;
    const r = await rollBall({ x, y, vx, vy });
    assert.ok(!r.offTable, `corner (${sx},${sy}): ball left the table at (${r.x.toFixed(1)}, ${r.y.toFixed(1)})`);
    assert.ok(r.onFelt, `corner (${sx},${sy}): ball came to rest off the felt`);
  }
});

test('fuzz: 400 random shots — no ball ever ends up off the table', async () => {
  const bd = await resetTable();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 400; i++) {
    await resetTable();
    // Bias starts toward rails and corners, where the leaks were.
    const edge = rnd() < 0.6;
    const x = edge ? (rnd() < 0.5 ? bd.minX + 14 + rnd() * 30 : bd.maxX - 14 - rnd() * 30) : bd.minX + 14 + rnd() * (bd.maxX - bd.minX - 28);
    const y = bd.minY + 14 + rnd() * (bd.maxY - bd.minY - 28);
    const a = rnd() * Math.PI * 2;
    const s = 4 + rnd() * 24; // full in-game speed range
    const r = await rollBall({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s });
    assert.ok(!r.offTable && r.onFelt,
      `shot ${i} from (${x.toFixed(1)},${y.toFixed(1)}) angle ${a.toFixed(2)} speed ${s.toFixed(1)} escaped to (${r.x.toFixed(1)},${r.y.toFixed(1)})`);
  }
});

test('full break: every ball stays on the table or is pocketed', async () => {
  for (let trial = 0; trial < 20; trial++) {
    const res = await page.evaluate((trial) => {
      Game.isGameWon = false;
      Game.ballInHand = false;
      Game.rackBalls ? Game.rackBalls() : Game.initBalls?.();
      Game.isBallsMoving = false;
      Game.power = 100;
      Game.aimAngle = (trial - 10) * 0.012; // spread of break angles
      Game.shoot();
      const t = Game.table;
      for (let f = 0; f < 3000 && Game.isBallsMoving; f++) Game.updatePhysics();
      return Game.balls.filter((b) => !b.isPocketed &&
        (b.x < t.x || b.x > t.x + t.w || b.y < t.y || b.y > t.y + t.h)).map((b) => b.num);
    }, trial);
    assert.deepEqual(res, [], `break ${trial}: balls off table: ${res}`);
  }
});

test('pockets still work: straight shots into a corner and a side pocket drop', async () => {
  const bd = await resetTable();
  const pockets = await page.evaluate(() => Game.getPockets());
  for (const pi of [0, 1, 2, 3, 4, 5]) {
    await resetTable();
    const p = pockets[pi];
    const sx = (bd.minX + bd.maxX) / 2;
    const sy = (bd.minY + bd.maxY) / 2;
    const a = Math.atan2(p.y - sy, p.x - sx);
    const r = await rollBall({ x: sx, y: sy, vx: Math.cos(a) * 14, vy: Math.sin(a) * 14 });
    assert.ok(r.pocketed, `pocket ${pi} did not capture a dead-centre shot`);
  }
});

// ---------------------------------------------------------------------------
// Cue stick input
// ---------------------------------------------------------------------------

/** Converts canvas coords to page coords for mouse events. */
async function toPage(pt) {
  return page.evaluate(({ x, y }) => {
    const r = Game.canvas.getBoundingClientRect();
    return { x: r.left + x * r.width / Game.width, y: r.top + y * r.height / Game.height };
  }, pt);
}

async function setupAim() {
  return page.evaluate(() => {
    Game.isGameWon = false; Game.ballInHand = false; Game.isBallsMoving = false;
    Game.isDraggingAim = false;
    // A sunk 9 in an earlier test opens the win modal over the canvas.
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
    for (const b of Game.balls) { b.vx = 0; b.vy = 0; }
    Object.assign(Game.cueBall, { x: 500, y: 360, isPocketed: false });
    Game.aimAngle = 0; // aiming right, stick extends left of the ball
    Game.power = 50;
    return { cb: { x: Game.cueBall.x, y: Game.cueBall.y } };
  });
}
const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test('grabbing the stick does not snap the aim toward the finger', async () => {
  const { cb } = await setupAim();
  const grab = await toPage({ x: cb.x - 120, y: cb.y }); // middle of the stick
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  const a = await page.evaluate(() => Game.aimAngle);
  await page.mouse.up();
  assert.ok(angleDiff(a, 0) < 1e-6, `aim jumped to ${a} on grab (old bug: aimed backward at ~π)`);
});

test('dragging the stick swings it like a lever around the cue ball', async () => {
  const { cb } = await setupAim();
  const grab = await toPage({ x: cb.x - 120, y: cb.y });
  const drag = await toPage({ x: cb.x - 120, y: cb.y + 120 }); // stick swung down-left
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drag.x, drag.y, { steps: 8 });
  const a = await page.evaluate(() => Game.aimAngle);
  await page.mouse.up();
  // Stick lies along the pointer (down-left), so the shot points up-right: -π/4.
  assert.ok(angleDiff(a, -Math.PI / 4) < 0.02, `expected ≈ -0.785, got ${a.toFixed(3)}`);
});

test('pressing on the cue ball itself grabs the stick, not the target', async () => {
  const { cb } = await setupAim();
  const on = await toPage({ x: cb.x + 4, y: cb.y + 3 });
  await page.mouse.move(on.x, on.y);
  await page.mouse.down();
  const a = await page.evaluate(() => ({ a: Game.aimAngle, mode: Game.aimDragMode }));
  await page.mouse.up();
  assert.equal(a.mode, 'stick');
  assert.ok(angleDiff(a.a, 0) < 1e-6);
});

test('tapping open table away from the stick still aims at that point', async () => {
  const { cb } = await setupAim();
  const target = { x: cb.x + 200, y: cb.y - 100 };
  const p = await toPage(target);
  await page.mouse.click(p.x, p.y);
  const a = await page.evaluate(() => Game.aimAngle);
  assert.ok(angleDiff(a, Math.atan2(-100, 200)) < 0.01, `got ${a}`);
});

test('touch drag on the stick moves the stick', async () => {
  const { cb } = await setupAim();
  const a = await page.evaluate(({ cb }) => {
    const c = Game.canvas;
    const r = c.getBoundingClientRect();
    const toClient = (x, y) => ({ clientX: r.left + x * r.width / Game.width, clientY: r.top + y * r.height / Game.height });
    const fire = (type, target, x, y) => {
      const t = new Touch({ identifier: 1, target: c, ...toClient(x, y) });
      target.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    };
    fire('touchstart', c, cb.x - 100, cb.y);
    const afterGrab = Game.aimAngle;
    fire('touchmove', window, cb.x, cb.y - 100); // swing stick straight up
    const afterMove = Game.aimAngle;
    fire('touchend', window, cb.x, cb.y - 100);
    return { afterGrab, afterMove };
  }, { cb });
  assert.ok(angleDiff(a.afterGrab, 0) < 1e-6, 'touch grab snapped the aim');
  // Stick above the ball → shot aims straight down (+π/2).
  assert.ok(angleDiff(a.afterMove, Math.PI / 2) < 0.02, `got ${a.afterMove}`);
});

/** Fires a few real shots via Game.shoot() so shotCount > 0. */
async function takeShots(n) {
  await page.evaluate((n) => {
    Game.rackBalls();
    for (let i = 0; i < n; i++) {
      Game.isBallsMoving = false;
      Game.isGameWon = false;
      Game.ballInHand = false;
      Game.shoot();
      for (const b of Game.balls) { b.vx = 0; b.vy = 0; }
      Game.isBallsMoving = false;
    }
  }, n);
}

const shotLabel = () => page.textContent('#streak-counter');

test('shot counter resets to 0 when Play Again starts a new game after a win', async () => {
  await takeShots(3);
  assert.equal(await page.evaluate(() => Game.shotCount), 3);
  assert.equal(await shotLabel(), 'Shots: 3');

  // Finish the game and show the win modal, as handlePostShotEvaluation does.
  await page.evaluate(() => {
    Game.isGameWon = true;
    document.getElementById('modal-win').classList.remove('hidden');
  });
  await page.click('#btn-play-again');

  assert.equal(await page.evaluate(() => Game.shotCount), 0);
  assert.equal(await shotLabel(), 'Shots: 0');
  assert.equal(await page.evaluate(() => Game.isGameWon), false);

  // The first shot of the new game counts as 1, not 4.
  await page.evaluate(() => { Game.isBallsMoving = false; Game.shoot(); });
  assert.equal(await page.evaluate(() => Game.shotCount), 1);
  assert.equal(await shotLabel(), 'Shots: 1');
});

test('shot counter resets to 0 when Re-rack starts a new game', async () => {
  await takeShots(2);
  assert.equal(await shotLabel(), 'Shots: 2');
  await page.evaluate(() => { Game.isBallsMoving = false; });
  await page.click('#btn-rerack');
  assert.equal(await page.evaluate(() => Game.shotCount), 0);
  assert.equal(await shotLabel(), 'Shots: 0');
});
