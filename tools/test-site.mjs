#!/usr/bin/env node
/**
 * Site-wide smoke tests for the TronsGames arcade.
 *
 * Fast, browser-free checks over every page in the repo:
 *   - the arcade index links only to pages that exist,
 *   - the gallery and README game list/count agree,
 *   - every inline script on every page is syntactically valid JavaScript,
 *   - inline JSON blocks parse,
 *   - the shipped Vector Maze level pack is well-formed and every level's
 *     recorded solution is a legal removal order under the real engine.
 *
 * Run from the repo root (Node 18+, no installs needed):
 *   node --test tools/test-site.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLine, canRemove, linesOverlap, solveOrder } from './engine-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const PAGES = readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

/**
 * Every <script> element in `html` as { type, src, body }.
 * `type` is '' for a classic script.
 */
function scriptsOf(html) {
  return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => {
    const attrs = m[1] || '';
    return {
      type: (attrs.match(/\btype\s*=\s*"([^"]*)"/i) || [, ''])[1].toLowerCase(),
      src: (attrs.match(/\bsrc\s*=\s*"([^"]*)"/i) || [, ''])[1],
      body: m[2],
    };
  });
}

/** Syntax-check an ES module without executing it (node --check). */
function checkModuleSyntax(source) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-module-'));
  try {
    const file = join(dir, 'page-module.mjs');
    writeFileSync(file, source);
    return spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- index page

const galleryGames = () => [...read('index.html').matchAll(/<a\b[^>]*class="game-card"[^>]*href="([^"]+)"/g)]
  .map((m) => m[1]);
const documentedGames = () => [...read('README.md').matchAll(/^\| (?:`([^`]+\.html)`|\[[^\]]+\]\(([^)]+\.html)\)) \|/gm)]
  .map((m) => m[1] || m[2]);

test('every documented game appears in the gallery exactly once', () => {
  const games = galleryGames();
  assert.equal(new Set(games).size, games.length, 'gallery has no duplicate cards');
  assert.deepEqual(games.sort(), documentedGames().sort(), 'gallery matches the README game list');
});

test('the README game count matches its game list and the gallery', () => {
  const count = read('README.md').match(/Explore (\d+) games and interactive experiments/);
  assert.ok(count, 'README includes a game count');
  assert.equal(Number(count[1]), documentedGames().length);
  assert.equal(Number(count[1]), galleryGames().length);
});

test('the arcade index links only to pages that exist', () => {
  const links = [...read('index.html').matchAll(/href="([^"#?]+)"/g)]
    .map((m) => m[1])
    .filter((href) => !/^[a-z]+:/i.test(href)); // skip https:, mailto:, ...
  assert.ok(links.length >= 15, `only ${links.length} local links found`);
  for (const href of new Set(links)) {
    assert.ok(existsSync(join(ROOT, href)), `index.html links to missing file ${href}`);
  }
});

test('every screenshot the index shows exists', () => {
  const images = [...read('index.html').matchAll(/src="(screenshots\/[^"]+)"/g)].map((m) => m[1]);
  for (const src of new Set(images)) {
    assert.ok(existsSync(join(ROOT, src)), `index.html shows missing image ${src}`);
  }
});

// ---------------------------------------------------------- per-page scripts

for (const page of PAGES) {
  test(`${page}: every inline script parses`, () => {
    const html = read(page);
    assert.match(html, /<title>[^<]+<\/title>/i, 'page has a non-empty <title>');
    for (const [i, s] of scriptsOf(html).entries()) {
      if (s.src || !s.body.trim()) continue; // external or empty
      const where = `${page} script #${i + 1} (type="${s.type || 'classic'}")`;
      if (s.type === '' || s.type === 'text/javascript') {
        assert.doesNotThrow(() => new Function(s.body), where);
      } else if (s.type === 'module') {
        const r = checkModuleSyntax(s.body);
        assert.equal(r.status, 0, `${where} failed node --check:\n${r.stderr}`);
      } else if (s.type === 'application/json') {
        assert.doesNotThrow(() => JSON.parse(s.body), where);
      }
      // text/babel (JSX) needs Babel; it is exercised in the browser instead.
    }
  });
}

// ------------------------------------------------------- Vector Maze levels

test('vector-maze-levels.json is a well-formed, solvable level pack', () => {
  const pack = JSON.parse(read('vector-maze-levels.json'));
  assert.equal(pack.schemaVersion, 1);
  assert.ok(Array.isArray(pack.levels) && pack.levels.length > 0, 'pack has levels');

  const ids = new Set();
  for (const lvl of pack.levels) {
    const tag = `level ${lvl.id}`;
    assert.ok(!ids.has(lvl.id), `${tag}: duplicate id`);
    ids.add(lvl.id);
    // Tiers mirror PRESETS in tools/generate-levels.mjs.
    assert.ok(['easy', 'medium', 'hard', 'superhard', 'dense'].includes(lvl.difficulty), `${tag}: difficulty "${lvl.difficulty}"`);
    assert.ok(lvl.lives > 0, `${tag}: lives`);

    const level = { cols: lvl.grid.cols, rows: lvl.grid.rows };
    for (const src of lvl.lines) {
      for (const [x, y] of src.points) {
        assert.ok(x >= 0 && x <= level.cols && y >= 0 && y <= level.rows, `${tag} ${src.id}: point off-grid`);
      }
    }
    const lines = lvl.lines.map((src) => makeLine(level, src));

    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        assert.ok(!linesOverlap(lines[i], lines[j]), `${tag}: ${lines[i].id} overlaps ${lines[j].id}`);
      }
    }

    // Replay the recorded solution: every step must be legal at that moment.
    assert.deepEqual([...lvl.solution].sort(), lines.map((l) => l.id).sort(), `${tag}: solution names every line once`);
    let remaining = [...lines];
    for (const id of lvl.solution) {
      const line = remaining.find((l) => l.id === id);
      const others = remaining.filter((l) => l !== line);
      assert.ok(canRemove(line, others), `${tag}: ${id} is blocked when the solution removes it`);
      remaining = others;
    }
    assert.ok(solveOrder(lines), `${tag}: independent solver finds an order`);
  }
});
