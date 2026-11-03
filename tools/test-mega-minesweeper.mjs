#!/usr/bin/env node
/**
 * Unit tests for Mega Minesweeper (../mega-minesweeper.html).
 *
 * Loads the real page in headless Chromium (offline, with a seeded
 * Math.random — see browser-harness.mjs) and drives the game's own functions:
 * initGame, placeMines, getNeighbors, reveal, toggleFlag, checkWin and the
 * solveStep AI. Hand-built boards are injected by editing `grid` directly.
 *
 * Run from the repo root:
 *   node --test tools/test-mega-minesweeper.mjs
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openGame } from './browser-harness.mjs';

let game, page;

before(async () => {
  game = await openGame('mega-minesweeper.html', { seed: 7, readyWhen: 'Array.isArray(grid) && grid.length === GRID_SIZE' });
  page = game.page;
});
after(async () => { await game?.close(); });
beforeEach(async () => {
  await page.evaluate(() => {
    autoSimulating = false;
    document.getElementById('pursuit-mode').checked = false;
    initGame();
  });
});

/** Summary of the board computed inside the page. */
const boardStats = () => page.evaluate(() => {
  let mines = 0, revealed = 0, revealedMines = 0, flagged = 0;
  for (const row of grid) for (const c of row) {
    mines += c.isMine; revealed += c.revealed; flagged += c.flagged;
    revealedMines += c.isMine && c.revealed;
  }
  return { mines, revealed, revealedMines, flagged, gameOver, gameWon, mineCount, flagsUsed };
});

/**
 * A blank, already-started board: no mines except `mines` ([[x,y],...]),
 * neighbour counts recomputed, nothing revealed. Bypasses the random layout.
 */
const handBoard = (mines) => page.evaluate((mines) => {
  firstClick = false;
  mineCount = mines.length;
  for (const row of grid) for (const c of row) Object.assign(c, { isMine: false, revealed: false, flagged: false, neighborMines: 0 });
  for (const [x, y] of mines) grid[y][x].isMine = true;
  for (const row of grid) for (const c of row) c.neighborMines = getNeighbors(c.x, c.y).filter((n) => n.isMine).length;
}, mines);

// ------------------------------------------------------------------- setup

test('a new game is a 64x64 grid with 20% mines pending, nothing placed yet', async () => {
  const s = await boardStats();
  assert.equal(await page.evaluate(() => grid.length * grid[0].length), 64 * 64);
  assert.equal(s.mineCount, Math.floor(64 * 64 * 0.2));
  assert.equal(s.mines, 0, 'mines are laid on the first click, not before');
  assert.equal(s.revealed, 0);
  assert.equal(await page.textContent('#mine-count'), String(s.mineCount));
  assert.deepEqual(game.errors, []);
});

test('getNeighbors returns 8 cells inside, 5 on an edge, 3 in a corner', async () => {
  const counts = await page.evaluate(() => [
    getNeighbors(10, 10).length,
    getNeighbors(0, 10).length,
    getNeighbors(63, 63).length,
    getNeighbors(0, 0).map((c) => `${c.x},${c.y}`).sort(),
  ]);
  assert.deepEqual(counts.slice(0, 3), [8, 5, 3]);
  assert.deepEqual(counts[3], ['0,1', '1,0', '1,1']);
});

// --------------------------------------------------------- first click

test('the first click is always safe: no mine within its 3x3 block', async () => {
  for (const [x, y] of [[32, 32], [0, 0], [63, 0], [5, 60]]) {
    const r = await page.evaluate(([x, y]) => {
      initGame();
      reveal(x, y);
      let nearby = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        nearby += grid[y + dy]?.[x + dx]?.isMine ? 1 : 0;
      }
      return { nearby, opened: grid[y][x].revealed, zero: grid[y][x].neighborMines === 0, gameOver };
    }, [x, y]);
    assert.deepEqual(r, { nearby: 0, opened: true, zero: true, gameOver: false }, `first click at ${x},${y}`);
  }
});

test('exactly mineCount mines are laid and every number matches its neighbours', async () => {
  await page.evaluate(() => reveal(20, 20));
  const r = await page.evaluate(() => {
    let wrong = 0;
    for (const row of grid) for (const c of row) {
      if (!c.isMine && c.neighborMines !== getNeighbors(c.x, c.y).filter((n) => n.isMine).length) wrong++;
    }
    return wrong;
  });
  const s = await boardStats();
  assert.equal(s.mines, s.mineCount);
  assert.equal(r, 0, 'cells with a wrong neighbour count');
});

test('flood fill opens the whole zero region and its numbered border, never a mine', async () => {
  await page.evaluate(() => reveal(32, 32));
  const r = await page.evaluate(() => {
    let unopenedNextToZero = 0;
    for (const row of grid) for (const c of row) {
      if (c.revealed && c.neighborMines === 0 && !c.isMine) {
        unopenedNextToZero += getNeighbors(c.x, c.y).filter((n) => !n.revealed).length;
      }
    }
    return unopenedNextToZero;
  });
  const s = await boardStats();
  assert.ok(s.revealed > 9, `opening should cascade, revealed ${s.revealed}`);
  assert.equal(r, 0, 'every neighbour of an open zero cell is open');
  assert.equal(s.revealedMines, 0);
});

// -------------------------------------------------------------------- flags

test('flags toggle, are counted, and protect a cell from being revealed', async () => {
  await handBoard([[5, 5]]);
  await page.evaluate(() => toggleFlag(5, 5));
  let s = await boardStats();
  assert.equal(s.flagsUsed, 1);
  assert.equal(await page.textContent('#flag-count'), '1');

  await page.evaluate(() => reveal(5, 5));
  s = await boardStats();
  assert.equal(s.gameOver, false, 'a flagged mine cannot be clicked');

  await page.evaluate(() => toggleFlag(5, 5));
  assert.equal((await boardStats()).flagsUsed, 0);
});

test('revealed cells and off-board coordinates cannot be flagged', async () => {
  await handBoard([[5, 5]]);
  await page.evaluate(() => { reveal(5, 4); toggleFlag(5, 4); toggleFlag(-1, 0); toggleFlag(64, 64); });
  assert.equal((await boardStats()).flagsUsed, 0);
  await page.evaluate(() => reveal(-1, 3)); // must not throw
  assert.deepEqual(game.errors, []);
});

// --------------------------------------------------------------- win / lose

test('revealing a mine ends the game, shows every mine and freezes the board', async () => {
  await handBoard([[5, 5], [40, 40]]);
  await page.evaluate(() => reveal(5, 5));
  const s = await boardStats();
  assert.equal(s.gameOver, true);
  assert.equal(s.revealedMines, 2, 'all mines are shown');
  assert.match(await page.textContent('#message-box'), /GAME OVER/);

  const revealedBefore = s.revealed;
  await page.evaluate(() => { reveal(30, 30); toggleFlag(31, 31); });
  const after = await boardStats();
  assert.equal(after.revealed, revealedBefore, 'no reveals after game over');
  assert.equal(after.flagsUsed, 0, 'no flags after game over');
});

test('opening every safe cell wins and counts the win', async () => {
  await handBoard([[0, 0]]);
  const winsBefore = await page.evaluate(() => wins);
  await page.evaluate(() => reveal(63, 63)); // one flood opens all 4095 safe cells
  const s = await boardStats();
  assert.equal(s.gameWon, true);
  assert.equal(s.gameOver, false);
  assert.equal(await page.evaluate(() => wins), winsBefore + 1);
  assert.match(await page.textContent('#message-box'), /VICTORY/);
});

// ----------------------------------------------------------------------- AI

test('solveStep opens the centre on a fresh board', async () => {
  await page.evaluate(() => solveStep());
  assert.equal(await page.evaluate(() => grid[32][32].revealed), true);
  assert.match(await page.textContent('#ai-status'), /Opening center/);
});

test('solveStep flags a forced mine, then clears the cells it makes safe', async () => {
  // Mine at (1,0). With (0,1) and (1,1) open, the "1" at (0,0) has a single
  // hidden neighbour, so that neighbour must be the mine.
  await handBoard([[1, 0]]);
  await page.evaluate(() => { grid[0][0].revealed = true; grid[1][0].revealed = true; grid[1][1].revealed = true; });

  await page.evaluate(() => solveStep());
  assert.equal(await page.evaluate(() => grid[0][1].flagged), true, 'mine at (1,0) flagged');
  assert.match(await page.textContent('#ai-status'), /guaranteed mines/);

  await page.evaluate(() => solveStep());
  const r = await page.evaluate(() => ({ a: grid[2][0].revealed, b: grid[2][1].revealed, gameOver }));
  assert.deepEqual(r, { a: true, b: true, gameOver: false });
  assert.match(await page.textContent('#ai-status'), /safe neighbors/);
});

test('solveStep never flags a safe cell during a long seeded run', async () => {
  const r = await page.evaluate(() => {
    let steps = 0;
    while (steps < 400 && solveStep()) steps++;
    let wrongFlags = 0;
    for (const row of grid) for (const c of row) if (c.flagged && !c.isMine) wrongFlags++;
    return { steps, wrongFlags };
  });
  assert.ok(r.steps > 10, `AI made only ${r.steps} moves`);
  assert.equal(r.wrongFlags, 0);
  assert.deepEqual(game.errors, []);
});
