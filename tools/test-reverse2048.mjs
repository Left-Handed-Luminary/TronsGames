#!/usr/bin/env node
/**
 * Unit tests for Reverse 2048 (../reverse2048.html).
 *
 * Loads the real page in headless Chromium (offline, see browser-harness.mjs)
 * and drives the game's own top-level functions: createInitialState,
 * getValidDirections, performSplit, bankExtraTwos, undoMove, checkVictory,
 * showHint. Board setups are injected by assigning `state` directly.
 *
 * Run from the repo root:
 *   node --test tools/test-reverse2048.mjs
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openGame } from './browser-harness.mjs';

let game, page;

before(async () => {
  game = await openGame('reverse2048.html', { readyWhen: "typeof state === 'object' && Array.isArray(state.tiles)" });
  page = game.page;
});
after(async () => { await game?.close(); });
beforeEach(async () => { await page.evaluate(() => resetGame('pure')); });

/** Replace the board with `tiles` (ids assigned 1..n) and the given score. */
function setBoard(tiles, { score = 1000, bankedTwos = 0 } = {}) {
  return page.evaluate(({ tiles, score, bankedTwos }) => {
    state = { modeKey: 'pure', score, moves: 0, bankedTwos, tiles: tiles.map((t, i) => ({ id: i + 1, ...t })) };
    nextTileId = tiles.length;
    history = [];
    render();
  }, { tiles, score, bankedTwos });
}
const snapshot = () => page.evaluate(() => ({
  score: state.score,
  moves: state.moves,
  bankedTwos: state.bankedTwos,
  tiles: state.tiles.map(({ id, x, y, value }) => ({ id, x, y, value })),
  nextTileId,
  message: document.getElementById('messageBar').textContent.trim(),
}));

// ------------------------------------------------------------ initial state

test('Pure mode starts with one 2048 tile in the centre and score 20,480', async () => {
  const s = await snapshot();
  assert.deepEqual(s.tiles, [{ id: 1, x: 2, y: 2, value: 2048 }]);
  assert.equal(s.score, 20480);
  assert.equal(s.moves, 0);
  assert.equal(await page.textContent('#scoreValue'), (20480).toLocaleString('en-US'));
  assert.deepEqual(game.errors, []);
});

test('Max mode loads its crowded opener and switching modes resets the board', async () => {
  await page.evaluate(() => switchMode('max'));
  let s = await snapshot();
  assert.equal(s.tiles.length, 8);
  assert.equal(s.score, 82884);
  assert.equal(s.nextTileId, 8, 'new tiles continue after the highest preset id');
  assert.ok(await page.evaluate(() => maxModeBtn.classList.contains('active')));

  await page.evaluate(() => switchMode('pure'));
  s = await snapshot();
  assert.equal(s.tiles.length, 1);
  assert.equal(s.score, 20480);
});

test('createInitialState returns an independent copy of the mode preset', async () => {
  const untouched = await page.evaluate(() => {
    const a = createInitialState('max');
    a.tiles[0].value = 1;
    return createInitialState('max').tiles[0].value;
  });
  assert.equal(untouched, 2048, 'mutating a game must not corrupt MODES');
});

// ----------------------------------------------------------- legal moves

test('getValidDirections lists only in-bounds, empty neighbours', async () => {
  await setBoard([
    { x: 0, y: 0, value: 8 },  // corner: only right/down exist
    { x: 1, y: 0, value: 4 },  // blocks the corner's right
    { x: 4, y: 4, value: 2 },  // 2-tiles never split
  ]);
  const dirs = await page.evaluate(() => state.tiles.map((t) => getValidDirections(t)));
  assert.deepEqual(dirs[0], ['down']);
  assert.deepEqual(dirs[1].sort(), ['down', 'right']);
  assert.deepEqual(dirs[2], []);
  assert.deepEqual(await page.evaluate(() => getValidDirections(null)), []);
});

test('a centre tile on an empty board can split all four ways', async () => {
  assert.deepEqual(
    (await page.evaluate(() => getValidDirections(state.tiles[0]))).sort(),
    ['down', 'left', 'right', 'up'],
  );
});

// ---------------------------------------------------------------- splitting

test('performSplit halves the tile, places the twin, and charges the full value', async () => {
  await page.evaluate(() => performSplit(1, 'right'));
  const s = await snapshot();
  assert.deepEqual(s.tiles, [
    { id: 1, x: 2, y: 2, value: 1024 },
    { id: 2, x: 3, y: 2, value: 1024 },
  ]);
  assert.equal(s.score, 20480 - 2048);
  assert.equal(s.moves, 1);
  assert.match(s.message, /Split 2048 into 1024 \+ 1024/);
});

test('a blocked or off-board split changes nothing and is not recorded', async () => {
  await setBoard([{ x: 0, y: 0, value: 8 }, { x: 0, y: 1, value: 4 }]);
  const before = await snapshot();
  await page.evaluate(() => performSplit(1, 'down'));   // occupied
  assert.match((await snapshot()).message, /blocked/);
  await page.evaluate(() => performSplit(1, 'left'));   // off the board
  await page.evaluate(() => performSplit(1, 'sideways')); // unknown direction
  await page.evaluate(() => performSplit(999, 'right')); // unknown tile
  const afterMoves = await snapshot();
  assert.deepEqual(afterMoves.tiles, before.tiles);
  assert.equal(afterMoves.moves, 0);
  assert.equal(await page.evaluate(() => history.length), 0, 'no undo entry for a rejected move');
});

test('score never drops below zero', async () => {
  await setBoard([{ x: 2, y: 2, value: 64 }], { score: 10 });
  await page.evaluate(() => performSplit(1, 'up'));
  assert.equal((await snapshot()).score, 0);
  assert.match((await snapshot()).message, /Score zeroed out/);
});

test('only the two newest 2-tiles stay on the board; older ones are banked', async () => {
  await setBoard([
    { x: 0, y: 0, value: 2 },
    { x: 4, y: 0, value: 2 },
    { x: 2, y: 2, value: 4 },
  ]);
  await page.evaluate(() => performSplit(3, 'down'));
  const s = await snapshot();
  const twos = s.tiles.filter((t) => t.value === 2).map((t) => t.id).sort((a, b) => a - b);
  assert.deepEqual(twos, [3, 4], 'the oldest 2s (ids 1 and 2) were retired');
  assert.equal(s.bankedTwos, 2);
  assert.equal(await page.textContent('#bankValue'), '2');
});

// ------------------------------------------------------------- selection UI

test('pressing a 2-tile or a boxed-in tile does not select it', async () => {
  await setBoard([
    { x: 0, y: 0, value: 2 },
    { x: 4, y: 4, value: 8 }, { x: 3, y: 4, value: 4 }, { x: 4, y: 3, value: 4 },
  ]);
  await page.evaluate(() => onTilePress(1));
  assert.equal(await page.evaluate(() => selectedTileId), null);
  assert.match((await snapshot()).message, /already complete/);
  await page.evaluate(() => onTilePress(2));
  assert.equal(await page.evaluate(() => selectedTileId), null);
  assert.match((await snapshot()).message, /no open neighbor/);
});

test('arrow keys split the selected tile', async () => {
  await page.evaluate(() => onTilePress(1));
  assert.equal(await page.evaluate(() => selectedTileId), 1);
  await page.keyboard.press('ArrowUp');
  const s = await snapshot();
  assert.deepEqual(s.tiles.map((t) => [t.x, t.y, t.value]), [[2, 2, 1024], [2, 1, 1024]]);
  assert.equal(await page.evaluate(() => selectedTileId), null, 'selection clears after a split');
});

// ---------------------------------------------------------------------- undo

test('undo restores the board, score, move count and id counter', async () => {
  const start = await snapshot();
  await page.evaluate(() => { performSplit(1, 'left'); performSplit(2, 'left'); });
  assert.equal((await snapshot()).moves, 2);
  await page.evaluate(() => { undoMove(); undoMove(); });
  const back = await snapshot();
  assert.deepEqual(back.tiles, start.tiles);
  assert.equal(back.score, start.score);
  assert.equal(back.moves, 0);
  assert.equal(back.nextTileId, start.nextTileId);
  assert.equal(await page.evaluate(() => undoBtn.disabled), true);
  await page.evaluate(() => undoMove()); // nothing left: must be a no-op
  assert.deepEqual((await snapshot()).tiles, start.tiles);
});

// --------------------------------------------------------------------- hints

test('showHint proposes a legal move and selects its tile', async () => {
  await page.evaluate(() => switchMode('max'));
  const hint = await page.evaluate(() => { showHint(); return { ...hint, selectedTileId }; });
  assert.equal(hint.selectedTileId, hint.tileId);
  const legal = await page.evaluate((id) => getValidDirections(getTileById(id)), hint.tileId);
  assert.ok(legal.includes(hint.direction), `hint ${hint.direction} not in ${legal}`);
});

test('showHint reports a dead board instead of inventing a move', async () => {
  await setBoard([{ x: 0, y: 0, value: 2 }, { x: 1, y: 0, value: 2 }]);
  const hint = await page.evaluate(() => { showHint(); return hint; });
  assert.equal(hint, null);
  assert.match((await snapshot()).message, /No valid splits remain/);
});

// ------------------------------------------------------------------- victory

test('the final 4 -> 2 + 2 split at score zero wins and opens the modal', async () => {
  await setBoard([{ x: 2, y: 2, value: 4 }], { score: 4 });
  await page.evaluate(() => performSplit(1, 'right'));
  assert.equal(await page.evaluate(() => checkVictory()), true);
  // Tailwind is not loaded offline, so check the classes the game toggles.
  const modalOpen = () => page.evaluate(() => victoryModalEl.classList.contains('flex') && !victoryModalEl.classList.contains('hidden'));
  assert.equal(await modalOpen(), true);
  assert.equal(await page.textContent('#victoryMode'), 'Pure');
  await page.keyboard.press('Escape');
  assert.equal(await modalOpen(), false, 'Escape closes the modal');
});

test('two 2-tiles with score left over is not a win', async () => {
  await setBoard([{ x: 0, y: 0, value: 2 }, { x: 1, y: 0, value: 2 }], { score: 2 });
  assert.equal(await page.evaluate(() => checkVictory()), false);
});

for (const [mode, splits] of [['pure', 1023], ['max', 4186]]) {
  test(`${mode} mode is winnable: smallest-tile-first play reaches exactly zero`, async () => {
    const r = await page.evaluate((mode) => {
      resetGame(mode);
      for (let guard = 0; guard < 20000; guard++) {
        const tile = state.tiles
          .filter((t) => getValidDirections(t).length)
          .sort((a, b) => a.value - b.value || a.id - b.id)[0];
        if (!tile) break;
        performSplit(tile.id, getValidDirections(tile)[0]);
      }
      return { won: checkVictory(), moves: state.moves, score: state.score, tiles: state.tiles.length };
    }, mode);
    assert.deepEqual(r, { won: true, moves: splits, score: 0, tiles: 2 });
    assert.deepEqual(game.errors, []);
  });
}

// --------------------------------------------------------------------- misc

test('tileColor gives every tile value a distinct [bg, text, glow] triple, with a fallback past 2048', async () => {
  const values = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
  const colors = await page.evaluate((values) => values.map(tileColor), values);
  for (const c of colors) {
    assert.equal(c.length, 3);
    for (const hex of c) assert.match(hex, /^#[0-9a-f]{6}$/i);
  }
  assert.equal(new Set(colors.map((c) => c[0])).size, values.length, 'each value has its own background');
  const [big, odd] = await page.evaluate(() => [tileColor(4096), tileColor(3)]);
  assert.equal(big.length, 3);
  assert.notDeepEqual(big, odd, 'oversized tiles use their own fallback colour');
});
