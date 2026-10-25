#!/usr/bin/env node
/**
 * Unit tests for Simon Writes (../simon-writes.html).
 *
 * The game ships as one self-contained HTML file, so these tests pull the pure
 * engine <script> straight out of that file and exercise it. Nothing is copied
 * or re-implemented here: the code under test is byte-for-byte the code that
 * players run. The engine takes time as an argument, so every test is
 * deterministic.
 *
 * Run from the repo root (Node 18+, no installs needed):
 *   node --test tools/test-simon-writes.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML_PATH = fileURLToPath(new URL('../simon-writes.html', import.meta.url));
const html = readFileSync(HTML_PATH, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/**
 * Evaluate the engine script with a CommonJS-style `module`, so its UMD
 * wrapper exports through module.exports instead of touching globals.
 */
function loadEngine() {
  const mod = { exports: {} };
  new Function('module', scripts[0])(mod);
  return mod.exports;
}
const SW = loadEngine();

// ------------------------------------------------------------- page structure

test('page has an engine script and a UI script, and both parse', () => {
  assert.equal(scripts.length, 2, 'expected the engine script and the UI script');
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  assert.equal(typeof SW.createGame, 'function', 'engine exports createGame');
});

test('every element the UI script looks up exists in the markup', () => {
  const ids = [...scripts[1].matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 20, `found only ${ids.length} element lookups`);
  for (const id of new Set(ids)) {
    assert.match(html, new RegExp(`id="${id}"`), `missing element #${id}`);
  }
});

test('every pad the engine knows has a button, and night mode drives the pulse', () => {
  for (const pad of SW.PADS) assert.match(html, new RegExp(`data-pad="${pad}"`), `missing pad ${pad}`);
  assert.match(scripts[1], /setProperty\('--pulse', game\.pulse\(now\)/, 'frame loop feeds the light pulse');
  assert.match(html, /body\.night\s*\{/, 'night mode palette exists');
});

const T0 = 10_000;
const OBEY = (pad) => ({ pad, obey: true, caller: SW.SIMON });
const TRAP = (pad, caller = null) => ({ pad, obey: false, caller });

/** Game with a hand-written script, still in the 'ready' phase. */
function withLines(lines, opts = {}) {
  const base = SW.createGame({ seed: 1, ...opts }).exportState();
  base.lines = lines.map((l) => ({ cleanStreak: 0, ...l }));
  base.results = base.lines.map(() => null);
  return SW.createGame({ restore: base });
}

/** Plays the current round. Obeys every Simon line on the beat except `miss` indices, then enters the next round. */
function playRound(g, { miss = new Set() } = {}) {
  const ev = [];
  const s = g.state;
  for (let i = 0; i < s.lines.length; i++) {
    const t = g.dueTime(i);
    ev.push(...g.update(t));
    if (s.lines[i].obey && !miss.has(i)) ev.push(...g.tap(s.lines[i].pad, t));
  }
  ev.push(...g.update(g.dueTime(s.lines.length - 1) + g.windowMs() + 1));
  if (s.phase === 'intermission') ev.push(...g.update(s.intermissionUntil));
  return ev;
}

const types = (ev) => ev.map((e) => e.type);
const only = (ev, type) => ev.filter((e) => e.type === type);

// ------------------------------------------------------------- generation

test('same seed writes the same script; another seed writes a different one', () => {
  const a = SW.createGame({ seed: 7, difficulty: 'hard' });
  const b = SW.createGame({ seed: 7, difficulty: 'hard' });
  const c = SW.createGame({ seed: 8, difficulty: 'hard' });
  assert.deepEqual(a.state.lines, b.state.lines);
  assert.notDeepEqual(a.state.lines, c.state.lines);
});

test('start length and lives follow the level', () => {
  for (const [name, cfg] of Object.entries(SW.DIFFICULTY)) {
    const g = SW.createGame({ seed: 3, difficulty: name });
    assert.equal(g.state.lines.length, cfg.startLength, name);
    assert.equal(g.state.lives, cfg.lives, name);
    assert.equal(g.state.phase, 'ready');
  }
});

test('Simon lines always say exactly "Simon says"; traps never do; line 1 is never a trap', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const g = SW.createGame({ seed, difficulty: 'hard' });
    g.start(T0);
    for (let r = 0; r < 12; r++) playRound(g);
    const { lines } = g.state;
    assert.equal(lines[0].obey, true);
    for (const l of lines) {
      if (l.obey) assert.equal(l.caller, SW.SIMON);
      else assert.ok(l.caller === null || SW.DECOYS.includes(l.caller), `bad trap caller ${l.caller}`);
    }
  }
});

test('never more than two trap lines in a row', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const g = SW.createGame({ seed, difficulty: 'hard' });
    g.start(T0);
    for (let r = 0; r < 25; r++) playRound(g);
    let run = 0;
    for (const l of g.state.lines) {
      run = l.obey ? 0 : run + 1;
      assert.ok(run <= 2, `seed ${seed} has ${run} traps in a row`);
    }
  }
});

test('easy level never writes a trap', () => {
  const g = SW.createGame({ seed: 11, difficulty: 'easy' });
  g.start(T0);
  for (let r = 0; r < 20; r++) playRound(g);
  assert.ok(g.state.lines.every((l) => l.obey));
});

test('hit windows never overlap, even at top tempo', () => {
  for (const [name, cfg] of Object.entries(SW.DIFFICULTY)) {
    const beat = 60000 / cfg.maxBpm;
    assert.ok(Math.min(cfg.goodMs, beat * 0.45) < beat / 2, name);
    assert.ok(cfg.perfectMs < cfg.goodMs, name);
  }
});

// ------------------------------------------------------------- timing

test('line i is due COUNT_IN + i beats after the start', () => {
  const g = SW.createGame({ seed: 2 });
  g.start(T0);
  const beat = g.beatMs();
  for (let i = 0; i < g.state.lines.length; i++) {
    assert.equal(g.dueTime(i), T0 + (SW.COUNT_IN + i) * beat);
  }
});

test('count-in emits 4, 3, 2, 1 and then the beat for line 0', () => {
  const g = SW.createGame({ seed: 2 });
  g.start(T0);
  const beats = only(g.update(g.dueTime(0)), 'beat');
  assert.deepEqual(beats.map((b) => b.count), [4, 3, 2, 1, null]);
  assert.equal(beats[4].line, 0);
});

test('nothing happens before start', () => {
  const g = SW.createGame({ seed: 2 });
  assert.deepEqual(g.update(T0), []);
  assert.deepEqual(g.tap('red', T0), []);
  assert.equal(g.pulse(T0), 0);
});

// ------------------------------------------------------------- judging

test('a tap on the beat is perfect and starts a combo', () => {
  const g = withLines([OBEY('red'), OBEY('blue')]);
  g.start(T0);
  const ev = g.tap('red', g.dueTime(0));
  const hit = only(ev, 'hit')[0];
  assert.equal(hit.judgement, 'perfect');
  assert.equal(hit.points, SW.POINTS.perfect);
  assert.equal(g.state.score, 100);
  assert.equal(g.state.combo, 1);
});

test('a tap just outside the perfect window is good', () => {
  const g = withLines([OBEY('red'), OBEY('blue')]);
  g.start(T0);
  const late = SW.DIFFICULTY.normal.perfectMs + 10;
  const hit = only(g.tap('red', g.dueTime(0) + late), 'hit')[0];
  assert.equal(hit.judgement, 'good');
  assert.equal(hit.dt, late);
});

test('a tap before the window opens is stray and costs nothing', () => {
  const g = withLines([OBEY('red'), OBEY('blue')]);
  g.start(T0);
  const ev = g.tap('red', g.dueTime(0) - g.windowMs() - 1);
  assert.deepEqual(types(ev).filter((t) => t !== 'beat'), ['stray']);
  assert.equal(g.state.lives, 3);
  assert.equal(g.state.results[0], null);
});

test('no tap at all is a late miss once the window closes', () => {
  const g = withLines([OBEY('red'), OBEY('blue')]);
  g.start(T0);
  const miss = only(g.update(g.dueTime(0) + g.windowMs() + 1), 'miss')[0];
  assert.equal(miss.reason, 'late');
  assert.equal(miss.lives, 2);
});

test('the wrong color is a miss and breaks the combo', () => {
  const g = withLines([OBEY('red'), OBEY('blue'), OBEY('green')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  const miss = only(g.tap('green', g.dueTime(1)), 'miss')[0];
  assert.equal(miss.reason, 'wrong');
  assert.equal(miss.pad, 'green');
  assert.equal(g.state.combo, 0);
});

test('tapping a trap line is a miss; leaving it alone scores "held"', () => {
  const g = withLines([OBEY('red'), TRAP('blue'), TRAP('yellow', 'Simone says'), OBEY('green')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  const held = only(g.update(g.dueTime(1) + g.windowMs() + 1), 'hit')[0];
  assert.equal(held.judgement, 'held');
  const fell = only(g.tap('yellow', g.dueTime(2)), 'miss')[0];
  assert.equal(fell.reason, 'trap');
});

test('a second tap on the same line is stray: no double score, no penalty', () => {
  const g = withLines([OBEY('red'), OBEY('blue')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  const ev = g.tap('blue', g.dueTime(0) + 20);
  assert.deepEqual(types(ev), ['stray']);
  assert.equal(g.state.score, 100);
  assert.equal(g.state.lives, 3);
});

test('the multiplier steps every 8 hits and caps at x4', () => {
  assert.deepEqual([0, 7, 8, 15, 16, 24, 99].map(SW.multiplier), [1, 1, 2, 2, 3, 4, 4]);
  const g = withLines(Array.from({ length: 9 }, () => OBEY('red')));
  g.start(T0);
  for (let i = 0; i < 9; i++) g.tap('red', g.dueTime(i));
  assert.equal(g.state.score, 7 * 100 + 2 * 200);
});

// ------------------------------------------------------------- rounds

test('a clean round adds one line and raises the tempo', () => {
  const g = SW.createGame({ seed: 5, difficulty: 'normal' });
  g.start(T0);
  const ev = playRound(g);
  const start = only(ev, 'roundStart')[0];
  assert.equal(only(ev, 'roundEnd')[0].clean, true);
  assert.equal(start.repeat, false);
  assert.equal(g.state.round, 2);
  assert.equal(g.state.lines.length, 5);
  assert.equal(g.state.bpm, 92);
});

test('a round with a miss repeats at the same length and tempo', () => {
  const g = withLines([OBEY('red'), OBEY('blue'), OBEY('green')]);
  g.start(T0);
  const ev = playRound(g, { miss: new Set([1]) });
  assert.equal(only(ev, 'roundEnd')[0].next, 'repeat');
  assert.equal(only(ev, 'roundStart')[0].repeat, true);
  assert.equal(g.state.round, 1);
  assert.equal(g.state.lines.length, 3);
  assert.equal(g.state.bpm, SW.DIFFICULTY.normal.baseBpm);
  assert.deepEqual(g.state.results, [null, null, null]);
});

test('the next round starts exactly one intermission after the last window closes', () => {
  const g = withLines([OBEY('red')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  const end = g.dueTime(0) + g.windowMs();
  g.update(end + 1);
  assert.equal(g.state.phase, 'intermission');
  assert.equal(g.state.intermissionUntil, end + SW.INTERMISSION_MS);
  assert.deepEqual(g.update(g.state.intermissionUntil - 1), []);
  assert.equal(only(g.update(g.state.intermissionUntil), 'roundStart').length, 1);
});

test('tempo stops rising at the level cap', () => {
  const g = SW.createGame({ seed: 9, difficulty: 'easy' });
  g.start(T0);
  for (let r = 0; r < 20; r++) playRound(g);
  assert.equal(g.state.bpm, SW.DIFFICULTY.easy.maxBpm);
});

test('the game ends when the last heart is lost; later input is ignored', () => {
  const g = withLines([OBEY('red'), OBEY('red'), OBEY('red'), OBEY('red')]);
  g.start(T0);
  g.tap('blue', g.dueTime(0));
  g.tap('blue', g.dueTime(1));
  const ev = g.tap('blue', g.dueTime(2));
  const over = only(ev, 'gameOver')[0];
  assert.equal(g.state.phase, 'over');
  assert.equal(over.tally.miss, 3);
  assert.deepEqual(g.tap('red', g.dueTime(3)), []);
  assert.deepEqual(g.update(g.dueTime(3) + 5000), []);
});

// ------------------------------------------------------------- pause / resume

test('pausing freezes time; resuming gives the next line a fresh count-in', () => {
  const g = withLines([OBEY('red'), OBEY('blue'), OBEY('green'), OBEY('yellow')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  g.update(g.dueTime(0) + g.windowMs() + 1);
  g.pause(g.dueTime(1) - 200);

  const later = T0 + 60_000;
  assert.deepEqual(g.update(later), [], 'no line expires while paused');
  g.resume(later);

  assert.ok(Math.abs(g.dueTime(1) - (later + SW.COUNT_IN * g.beatMs())) < 1e-6);
  const counts = only(g.update(g.dueTime(1)), 'beat').map((b) => b.count);
  assert.deepEqual(counts, [4, 3, 2, 1, null]);
  assert.equal(g.state.lives, 3);
});

test('a line already tapped before the pause is skipped by the resume count-in', () => {
  const g = withLines([OBEY('red'), OBEY('blue'), OBEY('green')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  g.pause(g.dueTime(0) + 10);
  g.resume(T0 + 30_000);
  assert.equal(g.state.cursor, 1);
  assert.ok(Math.abs(g.dueTime(1) - (T0 + 30_000 + SW.COUNT_IN * g.beatMs())) < 1e-6);
});

test('pausing between rounds gives a fresh intermission on resume', () => {
  const g = withLines([OBEY('red')]);
  g.start(T0);
  g.tap('red', g.dueTime(0));
  const t = g.dueTime(0) + g.windowMs() + 1;
  g.update(t);
  g.pause(t + 10);
  g.resume(t + 90_000);
  assert.equal(g.state.intermissionUntil, t + 90_000 + SW.INTERMISSION_MS);
});

test('upcomingBeats looks ahead without emitting, and is empty while paused', () => {
  const g = SW.createGame({ seed: 4 });
  g.start(T0);
  const ahead = g.upcomingBeats(T0, g.beatMs() * 1.5);
  assert.deepEqual(ahead.map((b) => b.beat), [0, 1]);
  assert.equal(new Set(ahead.map((b) => b.key)).size, 2);
  assert.equal(only(g.update(T0), 'beat').length, 1, 'lookahead did not consume beats');
  g.pause(T0 + 1);
  assert.deepEqual(g.upcomingBeats(T0 + 1, 10_000), []);
});

// ------------------------------------------------------------- night-mode pulse & view

test('pulse is full on the beat, decays across it, and is dark when idle or paused', () => {
  const g = SW.createGame({ seed: 4 });
  assert.equal(g.pulse(T0), 0, 'dark before start');
  g.start(T0);
  const beat = g.beatMs();
  assert.equal(g.pulse(T0 + 2 * beat), 1);
  assert.ok(Math.abs(g.pulse(T0 + 2.5 * beat) - Math.exp(-SW.PULSE_DECAY * 0.5)) < 1e-9);
  assert.ok(g.pulse(T0 + 2.99 * beat) < 0.01);
  assert.equal(g.pulse(T0 - 1), 0, 'dark before the first count beat');
  g.pause(T0 + 2 * beat);
  assert.equal(g.pulse(T0 + 2 * beat), 0, 'dark while paused');
});

test('scroll position holds during the count-in and lands on each line at its beat', () => {
  const g = SW.createGame({ seed: 4 });
  assert.equal(g.scrollPosition(T0), -1);
  g.start(T0);
  assert.equal(g.scrollPosition(T0 + g.beatMs()), -1);
  for (let i = 0; i < g.state.lines.length; i++) {
    assert.ok(Math.abs(g.scrollPosition(g.dueTime(i)) - i) < 1e-9);
  }
});

// ------------------------------------------------------------- fading ink

test('permanent ink never fades', () => {
  const g = withLines([OBEY('red'), OBEY('blue')], { ink: 'permanent' });
  g.start(T0);
  for (let r = 0; r < 6; r++) playRound(g);
  assert.equal(g.inkOpacity(0), 1);
});

test('fading ink thins with clean plays and comes back after a miss', () => {
  const g = withLines([OBEY('red'), OBEY('blue')], { ink: 'fading' });
  g.start(T0);
  const seen = [];
  for (let r = 0; r < 4; r++) { playRound(g); seen.push(g.inkOpacity(0)); }
  assert.deepEqual(seen, [1, 0.66, 0.32, 0]);
  playRound(g, { miss: new Set([0]) });
  assert.equal(g.inkOpacity(0), 1);
});

// ------------------------------------------------------------- persistence & validation

test('exportState / restore round-trips, and a live game comes back paused', () => {
  const g = SW.createGame({ seed: 12, difficulty: 'hard', ink: 'fading' });
  g.start(T0);
  playRound(g);
  const saved = g.exportState();
  const back = SW.createGame({ restore: saved });
  assert.deepEqual({ ...back.state, paused: false }, saved);
  assert.equal(back.state.paused, true);
  saved.score = -1;
  assert.notEqual(g.state.score, -1, 'export is a copy');
});

test('restore rejects broken saves', () => {
  const good = SW.createGame({ seed: 1 }).exportState();
  const bad = [
    null,
    { ...good, version: 99 },
    { ...good, lines: [] },
    { ...good, lines: [{ pad: 'purple', obey: true, caller: SW.SIMON, cleanStreak: 0 }], results: [null] },
    { ...good, lines: [{ pad: 'red', obey: false, caller: SW.SIMON, cleanStreak: 0 }], results: [null] },
    { ...good, results: [] },
    { ...good, phase: 'dancing' },
  ];
  for (const data of bad) assert.throws(() => SW.createGame({ restore: data }));
});

test('bad options and pads are rejected', () => {
  assert.throws(() => SW.createGame({ difficulty: 'impossible' }), RangeError);
  assert.throws(() => SW.createGame({ ink: 'invisible' }), RangeError);
  assert.throws(() => SW.createGame({ seed: Number.NaN }), TypeError);
  const g = SW.createGame({ seed: 1 });
  g.start(T0);
  assert.throws(() => g.tap('purple', T0), RangeError);
});
