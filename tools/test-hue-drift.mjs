#!/usr/bin/env node
/**
 * Unit tests for Hue Drift (../hue-drift.html).
 *
 * The game ships as one self-contained HTML file, so these tests pull the pure
 * logic <script> straight out of that file and exercise it. Nothing is copied
 * or re-implemented here: the code under test is byte-for-byte the code that
 * players run.
 *
 * Run from the repo root (Node 18+, no installs needed):
 *   node --test tools/test-hue-drift.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML_PATH = fileURLToPath(new URL('../hue-drift.html', import.meta.url));
const html = readFileSync(HTML_PATH, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/**
 * Evaluate the logic script the way a browser would: `self` is the global and
 * `module` is undefined, so the UMD wrapper attaches `HueLogic` to `self`.
 * Using new Function (same realm) keeps arrays comparable with deepStrictEqual.
 */
function loadLogic() {
  const fakeSelf = {};
  new Function('self', 'module', scripts[0])(fakeSelf, undefined);
  return fakeSelf.HueLogic;
}
const L = loadLogic();

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

test('page has exactly two scripts and both parse', () => {
  assert.equal(scripts.length, 2, 'expected a logic script and a UI script');
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  assert.ok(L, 'HueLogic should be exported to self');
});

test('every element the UI script looks up exists in the markup', () => {
  const ids = [...scripts[1].matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `found only ${ids.length} element lookups`);
  for (const id of new Set(ids)) {
    assert.match(html, new RegExp(`id="${id}"`), `missing element #${id}`);
  }
  assert.match(html, /<meta name="theme-color"/, 'UI updates the theme-color meta tag');
});

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

test('hex <-> rgb <-> OKLab round-trips without drift', () => {
  for (const hex of ['#000000', '#ffffff', '#4f2033', '#e0a27e', '#022646', '#7f7f7f']) {
    assert.equal(L.rgbToHex(L.hexToRgb(hex)), hex);
    assert.equal(L.rgbToHex(L.oklabToRgb(L.rgbToOklab(L.hexToRgb(hex)))), hex);
  }
});

test('hexToRgb rejects malformed input', () => {
  for (const bad of ['', '#fff', '#12345g', 'red', null, undefined]) {
    assert.throws(() => L.hexToRgb(bad), /Invalid hex color/);
  }
});

test('rgbToHex clamps out-of-range channels', () => {
  assert.equal(L.rgbToHex([-20, 300, 127.6]), '#00ff80');
});

test('colorDistance is zero for identical colors and symmetric', () => {
  assert.equal(L.colorDistance('#4f2033', '#4f2033'), 0);
  const ab = L.colorDistance('#4f2033', '#e0a27e');
  assert.ok(ab > 0);
  assert.equal(ab, L.colorDistance('#e0a27e', '#4f2033'));
});

// ---------------------------------------------------------------------------
// Board generation
// ---------------------------------------------------------------------------

test('buildGradient puts the exact corner colors in the corners', () => {
  const corners = ['#4f2033', '#e0a27e', '#022646', '#848e8f'];
  const g = L.buildGradient(4, 5, corners);
  assert.equal(g.length, 20);
  assert.deepEqual([g[0], g[3], g[16], g[19]], corners);
});

test('buildGradient validates its arguments', () => {
  const c = ['#000000', '#111111', '#222222', '#333333'];
  assert.throws(() => L.buildGradient(1, 5, c), /at least 2x2/);
  assert.throws(() => L.buildGradient(4, 2.5, c), /at least 2x2/);
  assert.throws(() => L.buildGradient(4, 5, c.slice(0, 3)), /exactly 4/);
});

test('anchorIndices: frame, sides and corners lock the right tiles', () => {
  assert.equal(L.anchorIndices(4, 5, 'frame').size, 14); // 2*4 + 2*(5-2)
  assert.equal(L.anchorIndices(5, 7, 'sides').size, 14); // two columns of 7
  assert.deepEqual([...L.anchorIndices(6, 8, 'corners')].sort((a, b) => a - b), [0, 5, 42, 47]);
  assert.throws(() => L.anchorIndices(4, 4, 'spiral'), /Unknown anchor mode/);
});

test('every tile on every level and palette is visually distinct', () => {
  // Color palettes were tuned so every pair of tiles stays ~0.0145 OKLab apart.
  // The tightest pair today is Moon tide on the 7x9 board at 0.01445, so the
  // floor is 0.0144: any palette edit that makes two tiles closer fails here.
  // Line palettes may share a gray, but then the hatch angle must differ.
  const MIN_COLOR = 0.0144;
  const MIN_ANGLE = 8;
  for (const palette of L.PALETTES) {
    for (const { cols, rows } of L.LEVELS) {
      const tiles = L.buildTileStyles(cols, rows, palette);
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          assert.ok(
            L.tilesDistinct(tiles[i], tiles[j], MIN_COLOR, MIN_ANGLE),
            `${palette.name} ${cols}x${rows}: tiles ${i} and ${j} look identical`,
          );
        }
      }
    }
  }
});

test('line palettes give every tile an angle and an ink; color palettes give none', () => {
  for (const palette of L.PALETTES) {
    const tiles = L.buildTileStyles(5, 7, palette);
    for (const t of tiles) {
      if (palette.lines) {
        assert.equal(typeof t.angle, 'number');
        assert.ok(t.ink === palette.lines.light || t.ink === palette.lines.dark);
      } else {
        assert.equal(t.angle, null);
        assert.equal(t.ink, null);
      }
    }
  }
});

test('angleGap wraps at 180 degrees', () => {
  assert.equal(L.angleGap(10, 170), 20);
  assert.equal(L.angleGap(0, 180), 0);
  assert.equal(L.angleGap(25, 155), 50);
});

// ---------------------------------------------------------------------------
// Shuffle and moves
// ---------------------------------------------------------------------------

test('scramble is a derangement of movable tiles and never moves anchors', () => {
  for (let level = 0; level < L.LEVELS.length; level++) {
    const { cols, rows, anchors: mode } = L.levelConfig(level);
    const size = cols * rows;
    const anchors = L.anchorIndices(cols, rows, mode);
    for (let seed = 1; seed <= 200; seed++) {
      const board = L.scramble(size, anchors, L.mulberry32(seed));
      assert.deepEqual([...board].sort((a, b) => a - b), Array.from({ length: size }, (_, i) => i));
      for (let p = 0; p < size; p++) {
        if (anchors.has(p)) assert.equal(board[p], p, `anchor ${p} moved`);
        else assert.notEqual(board[p], p, `level ${level} seed ${seed}: tile ${p} starts home`);
      }
      assert.equal(L.isSolved(board), false);
    }
  }
});

test('mulberry32 is reproducible for the same seed', () => {
  const a = L.mulberry32(42), b = L.mulberry32(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('swapTiles returns the same array for every illegal move', () => {
  const anchors = new Set([0, 3]);
  const board = [0, 2, 1, 3];
  for (const [a, b] of [[1, 1], [0, 1], [1, 3], [-1, 2], [1, 4], [1.5, 2]]) {
    assert.equal(L.swapTiles(board, a, b, anchors), board, `swap ${a}<->${b} should be rejected`);
  }
});

test('swapTiles is immutable and a solving swap is detected', () => {
  const anchors = new Set([0, 3]);
  const board = [0, 2, 1, 3];
  const next = L.swapTiles(board, 1, 2, anchors);
  assert.notEqual(next, board);
  assert.deepEqual(board, [0, 2, 1, 3], 'original board must not change');
  assert.deepEqual(next, [0, 1, 2, 3]);
  assert.equal(L.isSolved(next), true);
  assert.equal(L.correctCount(board), 2);
  assert.equal(L.correctCount(next), 4);
});

test('levelConfig clamps bad and past-the-end levels', () => {
  const last = L.LEVELS[L.LEVELS.length - 1];
  assert.equal(L.levelConfig(0), L.LEVELS[0]);
  assert.equal(L.levelConfig(-3), L.LEVELS[0]);
  assert.equal(L.levelConfig('nope'), L.LEVELS[0]);
  assert.equal(L.levelConfig(999), last);
});

// ---------------------------------------------------------------------------
// Pinch-zoom math
// ---------------------------------------------------------------------------

test('clampView keeps scale in range and the board covering the viewport', () => {
  assert.deepEqual(L.clampView({ s: 0.5, tx: 50, ty: 50 }, 400, 300), { s: 1, tx: 0, ty: 0 });
  assert.deepEqual(L.clampView({ s: 9, tx: -5000, ty: -5000 }, 400, 300), { s: 4, tx: -1200, ty: -900 });
  assert.deepEqual(L.clampView({ s: 2, tx: -100, ty: -50 }, 400, 300), { s: 2, tx: -100, ty: -50 });
});

test('pinchView keeps the pinched point under the fingers', () => {
  const start = { s: 1, tx: 0, ty: 0 };
  const mid = { x: 200, y: 150 };
  const v = L.pinchView(start, mid, 100, mid, 200, 400, 300);
  assert.equal(v.s, 2);
  // Board point under the midpoint before the pinch is still under it after.
  assert.equal((mid.x - v.tx) / v.s, mid.x);
  assert.equal((mid.y - v.ty) / v.s, mid.y);
});

test('pinchView survives a zero starting distance and caps zoom', () => {
  const v = L.pinchView({ s: 1, tx: 0, ty: 0 }, { x: 0, y: 0 }, 0, { x: 0, y: 0 }, 1000, 400, 300);
  assert.equal(v.s, 4);
  assert.ok(Number.isFinite(v.tx) && Number.isFinite(v.ty));
});
