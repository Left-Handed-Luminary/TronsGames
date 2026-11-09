#!/usr/bin/env node
/**
 * render.mjs — stills, and a quick single-render-per-frame video.
 *
 *   node render.mjs scene.html x --stills=0.3,1.5,3      # PNGs in stills/ (8x AA each)
 *   node render.mjs scene.html draft.mp4 [--fps=30] [--scale=.5] [--from=s] [--to=s]
 *
 * The video mode renders ONE sample per frame: fine for checking timing, never for
 * finals (it aliases and blinks). Use render_fast.mjs for finals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, openScene, encoder, frameRange, eta } from './lib/harness.mjs';
import { subSamples } from './lib/camera.js';

const { opts, positional } = parseArgs(process.argv.slice(2));
const [pageFile, out] = positional;
if (!pageFile) {
  console.error('usage: node render.mjs scene.html <out.mp4|x> [--stills=t1,t2] [--fps=30] [--scale=1]');
  process.exit(2);
}
const scale = opts.scale ? parseFloat(opts.scale) : 1;
const scene = await openScene(pageFile, { scale });
const { page, meta } = scene;

async function draw(ms, samples) {
  if (meta.hasRenderMany) {
    await page.evaluate((list) => window.renderMany(list), subSamples(ms, samples, 1000 / 60, 0));
  } else {
    await page.evaluate((t) => window.render(t), ms);
  }
}

try {
  if (opts.stills) {
    fs.mkdirSync('stills', { recursive: true });
    const base = path.basename(pageFile, path.extname(pageFile));
    for (const s of String(opts.stills).split(',').map(Number)) {
      await draw(s * 1000, 8);
      const file = path.join('stills', `${base}_${s.toFixed(2)}s.png`);
      fs.writeFileSync(file, await scene.frame());
      console.log('wrote', file);
    }
  } else {
    const fps = opts.fps ? parseFloat(opts.fps) : 30;
    const { from, to } = frameRange(meta.loopMs, fps, opts);
    const enc = encoder(out, fps, { crf: 20 });
    const start = Date.now();
    for (let f = from; f < to; f++) {
      await draw((f * 1000) / fps, 1);
      await enc.write(await scene.frame());
      if ((f - from) % 30 === 0) console.log(eta(start, f - from, to - from));
    }
    await enc.end();
    console.log('wrote', out);
  }
  if (scene.errors.length) console.warn('page errors:\n' + scene.errors.join('\n'));
} finally {
  await scene.close();
}
