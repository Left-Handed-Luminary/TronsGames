#!/usr/bin/env node
/**
 * Unit tests for Sleepy Shuffle (../sleepy-puzzle.html).
 *
 * Loads the real page in headless Chromium (offline, with a seeded
 * Math.random — see browser-harness.mjs) and drives the game's own functions:
 * levelSize, extraForLevel, shuffleSolvable, tapTile, endSwipe, fixOne,
 * softReshuffle, the win overlay and level persistence.
 *
 * Run from the repo root:
 *   node --test tools/test-sleepy-puzzle.mjs
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openGame } from './browser-harness.mjs';

const READY = 'Array.isArray(order) && order.length > 0';
let game, page;

before(async () => {
  game = await openGame('sleepy-puzzle.html', { readyWhen: READY });
  page = game.page;
});
after(async () => { await game?.close(); });
beforeEach(async () => {
  // checkWin() opens the overlay from a 180 ms timer; let any timer left by the
  // previous test fire before resetting, so it cannot cover this test's board.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  await page.evaluate(() => {
    overlay.classList.remove('show');
    level = 1;
    setupLevel();
  });
});

/** Put the board in a known arrangement (size inferred from its length). */
const setOrder = (arr) => page.evaluate((arr) => {
  size = Math.round(Math.sqrt(arr.length));
  order = [...arr];
  selected = null;
  moveCount = 0;
  render();
}, arr);
const read = () => page.evaluate(() => ({ order: [...order], selected, moveCount, size, solved: isSolved() }));

// ------------------------------------------------------------ level curve

test('board grows 2x2 -> 3x3 -> 4x4 at levels 4 and 9', async () => {
  const sizes = await page.evaluate(() => [1, 2, 3, 4, 8, 9, 50].map(levelSize));
  assert.deepEqual(sizes, [2, 2, 2, 3, 3, 4, 4]);
});

test('scene detail rises every two levels and caps at 8', async () => {
  const extra = await page.evaluate(() => [1, 2, 3, 4, 17, 18, 100].map(extraForLevel));
  assert.deepEqual(extra, [0, 0, 1, 1, 8, 8, 8]);
});

// ---------------------------------------------------------------- shuffle

test('shuffleSolvable always returns a scrambled permutation, never the solution', async () => {
  const r = await page.evaluate(() => {
    const failures = [];
    for (const n of [4, 9, 16]) {
      for (let d = 0; d < 12; d++) {
        for (let k = 0; k < 50; k++) {
          const a = shuffleSolvable(n, d);
          const isPerm = a.length === n && [...a].sort((x, y) => x - y).every((v, i) => v === i);
          const isIdentity = a.every((v, i) => v === i);
          if (!isPerm || isIdentity) failures.push({ n, d, a });
        }
      }
    }
    return failures;
  });
  assert.deepEqual(r, []);
});

test('setupLevel builds a scrambled board of the right size and labels it', async () => {
  await page.evaluate(() => { level = 9; setupLevel(); });
  const s = await read();
  assert.equal(s.size, 4);
  assert.equal(s.order.length, 16);
  assert.equal(s.solved, false);
  assert.equal(await page.locator('#puzzle .tile').count(), 16);
  assert.equal(await page.textContent('#levelPill'), 'Level 9 · 4×4');
  assert.deepEqual(game.errors, []);
});

// ------------------------------------------------------------ tap to swap

test('tap selects, tapping again deselects, tapping another swaps', async () => {
  await setOrder([1, 0, 2, 3]);
  await page.evaluate(() => tapTile(2));
  assert.equal((await read()).selected, 2);
  assert.ok(await page.locator('#puzzle .tile.selected').count() === 1, 'selected tile is highlighted');

  await page.evaluate(() => tapTile(2));
  assert.equal((await read()).selected, null);

  await page.evaluate(() => { tapTile(0); tapTile(1); });
  const s = await read();
  assert.deepEqual(s.order, [0, 1, 2, 3]);
  assert.equal(s.moveCount, 1);
  assert.equal(s.selected, null);
});

test('clicking tiles in the DOM swaps them too', async () => {
  await setOrder([3, 1, 2, 0]);
  await page.click('#puzzle .tile[data-pos="0"]');
  await page.click('#puzzle .tile[data-pos="3"]');
  assert.deepEqual((await read()).order, [0, 1, 2, 3]);
  assert.equal(await page.locator('#puzzle .tile.correct').count(), 4, 'every tile marked correct');
});

// ---------------------------------------------------------------- swiping

test('a swipe swaps with the neighbour in the swipe direction', async () => {
  await setOrder([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const swipe = (pos, dx, dy) => page.evaluate(([pos, dx, dy]) => {
    startSwipe({ clientX: 100, clientY: 100 }, pos);
    endSwipe({ clientX: 100 + dx, clientY: 100 + dy }, pos);
    return [...order];
  }, [pos, dx, dy]);

  assert.deepEqual(await swipe(4, 60, 0), [0, 1, 2, 3, 5, 4, 6, 7, 8], 'right');
  await setOrder([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await swipe(4, 0, -60), [0, 4, 2, 3, 1, 5, 6, 7, 8], 'up');
  await setOrder([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await swipe(4, -50, 10), [0, 1, 2, 4, 3, 5, 6, 7, 8], 'mostly-left diagonal');
});

test('short swipes, off-board swipes and mismatched pointer-ups are ignored', async () => {
  const start = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  await setOrder(start);
  const r = await page.evaluate(() => {
    startSwipe({ clientX: 0, clientY: 0 }, 4); endSwipe({ clientX: 10, clientY: 10 }, 4); // < 30px
    startSwipe({ clientX: 0, clientY: 0 }, 0); endSwipe({ clientX: -80, clientY: 0 }, 0); // off the left edge
    startSwipe({ clientX: 0, clientY: 0 }, 8); endSwipe({ clientX: 0, clientY: 80 }, 8);  // off the bottom edge
    startSwipe({ clientX: 0, clientY: 0 }, 1); endSwipe({ clientX: 80, clientY: 0 }, 2);  // released on another tile
    endSwipe({ clientX: 80, clientY: 0 }, 3);                                               // no swipe started
    return { order: [...order], moveCount };
  });
  assert.deepEqual(r, { order: start, moveCount: 0 });
});

// ------------------------------------------------------------- helper button

test('"Fix one tile" places exactly the first wrong piece', async () => {
  await setOrder([2, 0, 1, 3]);
  await page.click('#hintBtn');
  assert.deepEqual((await read()).order, [0, 2, 1, 3]);
});

test('repeated "Fix one tile" solves any board in at most n-1 moves', async () => {
  const r = await page.evaluate(() => {
    level = 12; setupLevel();
    const n = order.length;
    let presses = 0;
    while (!isSolved() && presses < 100) { fixOne(); presses++; }
    return { n, presses, solved: isSolved(), moveCount };
  });
  assert.equal(r.solved, true);
  assert.ok(r.presses <= r.n - 1, `${r.presses} presses for ${r.n} tiles`);
  assert.equal(r.moveCount, r.presses);
  await page.evaluate(() => fixOne()); // no-op once solved
  assert.equal((await read()).moveCount, r.presses);
});

test('reshuffle scrambles a fresh board and resets the move counter', async () => {
  await page.evaluate(() => { tapTile(0); tapTile(1); });
  await page.click('#reshuffleBtn');
  const s = await read();
  assert.equal(s.moveCount, 0);
  assert.equal(s.solved, false);
  assert.equal(s.order.length, 4);
});

// ----------------------------------------------------- winning + progress

test('solving shows the overlay; "Next" advances and remembers the level', async () => {
  await setOrder([1, 0, 2, 3]);
  await page.evaluate(() => { tapTile(0); tapTile(1); });
  await page.waitForFunction(() => overlay.classList.contains('show'));
  assert.equal(await page.textContent('#overlayTitle'), 'Picture settled.');

  await page.click('#nextBtn');
  assert.equal(await page.evaluate(() => level), 2);
  assert.equal(await page.evaluate(() => localStorage.getItem('sleepyShuffleLevel')), '2');
  assert.equal(await page.evaluate(() => overlay.classList.contains('show')), false);
  assert.equal((await read()).solved, false, 'the next level starts scrambled');
});

test('the progress dots fill one per level and wrap every six levels', async () => {
  const dots = await page.evaluate(() => [1, 3, 6, 7].map((n) => {
    level = n; buildProgress();
    return progress.querySelectorAll('span.done').length;
  }));
  assert.deepEqual(dots, [1, 3, 6, 1]);
});

test('reshuffling right after solving does not show the win overlay', async () => {
  // Regression: the overlay is opened from a 180 ms timer. If the board is
  // scrambled again inside that window, the timer must not announce a win.
  await setOrder([1, 0, 2, 3]);
  await page.evaluate(() => { tapTile(0); tapTile(1); softReshuffle(); });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal((await read()).solved, false);
  assert.equal(await page.evaluate(() => overlay.classList.contains('show')), false);
});

test('a saved level is restored on load', async () => {
  const other = await openGame('sleepy-puzzle.html', { readyWhen: READY, localStorage: { sleepyShuffleLevel: '9' } });
  try {
    const s = await other.page.evaluate(() => ({ level, size, tiles: order.length }));
    assert.deepEqual(s, { level: 9, size: 4, tiles: 16 });
  } finally {
    await other.close();
  }
});

// ------------------------------------------------------------------- misc

test('esc() escapes every HTML-special character', async () => {
  assert.equal(
    await page.evaluate(() => esc(`<a href="x">Tom & 'Jerry'</a>`)),
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#039;Jerry&#039;&lt;/a&gt;',
  );
});

test('every scene renders to a valid SVG data URL', async () => {
  const r = await page.evaluate(() => scenes.map((s) => {
    const url = makeScene(s, 3);
    const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return { name: s.name, svgUrl: url.startsWith('data:image/svg+xml'), ok: !doc.querySelector('parsererror') };
  }));
  for (const s of r) {
    assert.ok(s.svgUrl, `${s.name} is not an SVG data URL`);
    assert.ok(s.ok, `${s.name} SVG does not parse`);
  }
});
