#!/usr/bin/env node
/**
 * Tests for the generated gallery page perspective-crossing.html.
 *   node --test tools/test-perspective-crossing.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, OUT, THREE_VERSION } from './build-perspective-crossing.mjs';

const page = readFileSync(OUT, 'utf8');

test('the committed page matches a fresh build from the skill template', () => {
  assert.equal(page, build(), 'stale: run node tools/build-perspective-crossing.mjs');
});

test('the page stands alone on GitHub Pages (no dot-folder or node_modules references)', () => {
  assert.doesNotMatch(page, /\.\/node_modules\//);
  assert.doesNotMatch(page, /from '\.\/lib\//);
  assert.doesNotMatch(page, /\.claude\/skills\/[^\s]*\.(js|mjs)['"]/);
  assert.match(page, new RegExp(`cdn\\.jsdelivr\\.net/npm/three@${THREE_VERSION.replace(/\./g, '\\.')}/build/three\\.module\\.js`));
});

test('camera.js is inlined without export keywords', () => {
  assert.match(page, /function cameraFromShot\(/);
  assert.match(page, /function makeTimeline\(/);
  const inlined = page.slice(page.indexOf('inlined from templates/lib/camera.js'), page.indexOf('end camera.js'));
  assert.doesNotMatch(inlined, /^export\s/m);
});

test('the player is wired to the page contract', () => {
  for (const id of ['pcPlay', 'pcScrub', 'pcSpeed', 'pcQuality', 'pcCaptions', 'pcCaption']) {
    assert.match(page, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(page, /window\.render\(t\)/);
  assert.match(page, /window\.renderMany\(list\)/);
  assert.match(page, /<title>Perspective Crossing<\/title>/);
  assert.match(page, /name="viewport"/);
});

test('captions are in time order and cover the whole loop', () => {
  const caps = JSON.parse(page.match(/const CAPTIONS = (\[.*?\]);\n/s)[1]);
  assert.equal(caps[0][0], 0);
  for (let i = 1; i < caps.length; i++) assert.ok(caps[i][0] > caps[i - 1][0], `caption ${i} out of order`);
  assert.ok(caps.at(-1)[0] < 14, 'last caption starts inside the 14 s loop');
});
