#!/usr/bin/env node
/**
 * Unit tests for Crown Lattice (../crown-lattice.html).
 *
 * The rules engine and puzzle data are pulled straight out of the shipped HTML,
 * so the code under test is byte-for-byte what players run.
 *
 * Run from the repo root (Node 18+, no installs needed):
 *   node --test tools/test-crown-lattice.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rate, TIER_NAMES } from './generate-crown-lattice.mjs';

const html = readFileSync(fileURLToPath(new URL('../crown-lattice.html', import.meta.url)), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const fakeSelf = {};
new Function('self', 'module', scripts[0])(fakeSelf, undefined);
const L = fakeSelf.CrownLogic;
const { EMPTY, MARK, QUEEN } = L;
const pack = JSON.parse(html.match(/<script type="application\/json" id="crown-puzzles">([\s\S]*?)<\/script>/)[1]);

const boardFor = (p) => new Array(p.n * p.n).fill(EMPTY);
const solvedBoard = (p) => { const b = boardFor(p); p.solution.forEach((c, r) => { b[r * p.n + c] = QUEEN; }); return b; };

// A tiny hand-checked puzzle used for rule tests.
//   A A B B
//   A C C B      solution: row0 col1, row1 col3, row2 col0, row3 col2
//   D C C B
//   D D C C
const tiny = { id: 't', name: 'Tiny', difficulty: 'Easy', size: 4, regions: ['AABB', 'ACCB', 'DCCB', 'DDCC'], solution: [1, 3, 0, 2] };

// ------------------------------------------------------------------ page

test('page has a logic script, a data block and a UI script', () => {
  assert.equal(scripts.length, 2, 'logic + UI classic scripts');
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  assert.ok(L, 'CrownLogic is exported to self');
});

test('every element the UI looks up exists in the markup', () => {
  const ids = [...scripts[1].matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `found only ${ids.length} lookups`);
  for (const id of new Set(ids)) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
});

test('the arcade index links to the game', () => {
  const index = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(index, /href="crown-lattice\.html"/);
});

// ------------------------------------------------------------------ data

test('puzzle pack: every puzzle has unique id, valid shape, and a unique legal solution', () => {
  assert.equal(pack.schemaVersion, 1);
  assert.ok(pack.puzzles.length >= 1);
  const ids = new Set();
  for (const raw of pack.puzzles) {
    assert.ok(!ids.has(raw.id), `duplicate id ${raw.id}`);
    ids.add(raw.id);
    assert.deepEqual(L.validatePuzzle(raw), [], `${raw.id} ${raw.name}`);
  }
});

test('puzzle pack: each solution independently satisfies all four rules', () => {
  for (const raw of pack.puzzles) {
    const p = L.parsePuzzle(raw);
    const n = p.n;
    const cells = raw.solution.map((c, r) => r * n + c);
    assert.equal(new Set(cells.map((i) => Math.floor(i / n))).size, n, `${raw.id}: one per row`);
    assert.equal(new Set(cells.map((i) => i % n)).size, n, `${raw.id}: one per column`);
    assert.equal(new Set(cells.map((i) => p.regionOf[i])).size, n, `${raw.id}: one per region`);
    for (const a of cells) for (const b of cells) {
      if (a === b) continue;
      const touch = Math.abs(Math.floor(a / n) - Math.floor(b / n)) <= 1 && Math.abs((a % n) - (b % n)) <= 1;
      assert.ok(!touch, `${raw.id}: crowns ${a} and ${b} touch`);
    }
    assert.ok(L.analyze(p, solvedBoard(p)).solved, `${raw.id}: analyze() accepts the solution`);
  }
});

test('puzzle pack: difficulty labels match the deduction rater', () => {
  for (const raw of pack.puzzles) assert.equal(raw.difficulty, TIER_NAMES[rate(raw)], raw.id);
});

// ------------------------------------------------------------------ validation catches bad data

test('validatePuzzle rejects broken puzzles', () => {
  assert.deepEqual(L.validatePuzzle(tiny), []);
  assert.ok(L.validatePuzzle({ ...tiny, solution: [1, 3, 0, 1] }).length, 'shared column');
  assert.ok(L.validatePuzzle({ ...tiny, solution: [0, 2, 1, 3] }).length, 'touching / wrong');
  assert.ok(L.validatePuzzle({ ...tiny, regions: ['AABB', 'ACCB', 'DCCB', 'DDC'] }).length, 'ragged rows');
  assert.ok(L.validatePuzzle({ ...tiny, regions: ['AABA', 'ACCB', 'DCCB', 'DDCC'] }).length, 'split region');
  // Four horizontal stripes: no solution can put one crown per row and per region without... it has many.
  const stripes = { size: 4, regions: ['AAAA', 'BBBB', 'CCCC', 'DDDD'], solution: [1, 3, 0, 2] };
  assert.match(L.validatePuzzle(stripes).join(), /more than one solution/);
});

// ------------------------------------------------------------------ rules

test('analyze flags row, column, region and touching conflicts', () => {
  const p = L.parsePuzzle(tiny);
  const b = boardFor(p);
  b[0] = QUEEN; b[3] = QUEEN; // same row 0, regions A and B
  let a = L.analyze(p, b);
  assert.deepEqual(a.rows, [0]); assert.deepEqual(a.cols, []); assert.deepEqual(a.regions, []);
  assert.ok(a.bad.has(0) && a.bad.has(3));

  b.fill(EMPTY); b[1] = QUEEN; b[13] = QUEEN; // same column 1
  a = L.analyze(p, b);
  assert.deepEqual(a.cols, [1]);

  b.fill(EMPTY); b[5] = QUEEN; b[14] = QUEEN; // both region C, not touching, different row/col
  a = L.analyze(p, b);
  assert.deepEqual(a.regions, [2]); assert.equal(a.adjacent.length, 0);

  b.fill(EMPTY); b[0] = QUEEN; b[5] = QUEEN; // diagonal neighbors
  a = L.analyze(p, b);
  assert.deepEqual(a.adjacent, [[0, 5]]);
  assert.ok(!a.solved);
});

test('X marks never count as conflicts and win needs every rule', () => {
  const p = L.parsePuzzle(tiny);
  const b = solvedBoard(p);
  for (let i = 0; i < b.length; i++) if (b[i] === EMPTY) b[i] = MARK;
  assert.ok(L.analyze(p, b).solved, 'full board of X plus correct crowns wins');
  b[1] = EMPTY;
  assert.ok(!L.analyze(p, b).solved, 'three crowns is not a win');
  b[1] = QUEEN; b[0] = QUEEN; b[0] = MARK;
  assert.ok(L.analyze(p, b).solved);
  // n crowns that break a rule are not a win.
  const wrong = boardFor(p); [0, 7, 9, 14].forEach((i) => { wrong[i] = QUEEN; });
  assert.ok(!L.analyze(p, wrong).solved);
});

test('nextState: cycle, mark and crown tap modes', () => {
  assert.equal(L.nextState('cycle', EMPTY), MARK);
  assert.equal(L.nextState('cycle', MARK), QUEEN);
  assert.equal(L.nextState('cycle', QUEEN), EMPTY);
  assert.equal(L.nextState('mark', EMPTY), MARK);
  assert.equal(L.nextState('mark', MARK), EMPTY);
  assert.equal(L.nextState('mark', QUEEN), MARK);
  assert.equal(L.nextState('queen', EMPTY), QUEEN);
  assert.equal(L.nextState('queen', QUEEN), EMPTY);
  assert.equal(L.nextState('queen', MARK), QUEEN);
});

// ------------------------------------------------------------------ hints

test('hint removes a wrong crown first, then clears a wrong X', () => {
  const p = L.parsePuzzle(tiny);
  const b = boardFor(p);
  b[0] = QUEEN; b[1] = MARK; // (0,0) is wrong; (0,1) is the answer
  assert.deepEqual(L.hint(p, b), { action: 'remove', cell: 0, reason: 'wrong-queen' });
  b[0] = EMPTY;
  assert.deepEqual(L.hint(p, b), { action: 'clear', cell: 1, reason: 'wrong-mark' });
});

test('hint places exactly one correct crown and never the whole answer', () => {
  for (const raw of pack.puzzles) {
    const p = L.parsePuzzle(raw);
    const b = boardFor(p);
    const h = L.hint(p, b);
    assert.equal(h.action, 'place');
    assert.equal(p.solution[Math.floor(h.cell / p.n)], h.cell % p.n, `${raw.id}: hint is a solution cell`);
    assert.ok(h.open >= 1);
  }
});

test('following hints from an empty board solves every puzzle in n steps', () => {
  for (const raw of pack.puzzles) {
    const p = L.parsePuzzle(raw);
    const b = boardFor(p);
    let steps = 0;
    for (let h = L.hint(p, b); h; h = L.hint(p, b)) {
      assert.equal(h.action, 'place');
      b[h.cell] = QUEEN;
      assert.equal(L.analyze(p, b).bad.size, 0, `${raw.id}: hint created a conflict`);
      steps++;
      assert.ok(steps <= p.n, 'too many hints');
    }
    assert.equal(steps, p.n);
    assert.ok(L.analyze(p, b).solved, raw.id);
  }
});

test('hint prefers a forced cell when one unit has a single open cell', () => {
  const p = L.parsePuzzle(tiny);
  const b = boardFor(p);
  // Mark every cell of region D except its solution cell (row2,col0 = 8).
  for (const i of [12, 13]) b[i] = MARK;
  const h = L.hint(p, b);
  assert.equal(h.reason, 'only-cell');
  assert.equal(h.cell, 8);
});

test('hint returns null once solved', () => {
  const p = L.parsePuzzle(tiny);
  assert.equal(L.hint(p, solvedBoard(p)), null);
});
