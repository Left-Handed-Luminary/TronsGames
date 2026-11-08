#!/usr/bin/env node
/**
 * render_fast.mjs — final-quality loop render.
 *
 *   node render_fast.mjs scene.html final.mp4                 # full size, 60 fps
 *   node render_fast.mjs scene.html preview.mp4 --preview     # half size, 30 fps, 4 samples max
 *   options: --fps=60 --scale=1 --from=s --to=s --shutter=0.5 --max=32
 *
 * Every frame is the GPU average of jittered sub-renders (window.renderMany):
 * 4 for anti-aliasing, up to --max on fast moves, sized by how far window.probe
 * points travel on screen while the shutter is open.
 */
import { parseArgs, openScene, encoder, frameRange, eta } from './lib/harness.mjs';
import { subSamples, samplesForMotion } from './lib/camera.js';

const { opts, positional } = parseArgs(process.argv.slice(2));
const [pageFile, out] = positional;
if (!pageFile || !out) {
  console.error('usage: node render_fast.mjs scene.html out.mp4 [--preview] [--fps=60] [--from=s] [--to=s]');
  process.exit(2);
}
const preview = Boolean(opts.preview);
const fps = opts.fps ? parseFloat(opts.fps) : preview ? 30 : 60;
const scale = opts.scale ? parseFloat(opts.scale) : preview ? 0.5 : 1;
const shutter = opts.shutter ? parseFloat(opts.shutter) : 0.5;
const maxSamples = opts.max ? parseInt(opts.max, 10) : preview ? 4 : 32;

const scene = await openScene(pageFile, { scale });
const { page, meta } = scene;
if (!meta.hasRenderMany) {
  await scene.close();
  console.error(`${pageFile} has no window.renderMany; add it (see SKILL.md, page contract).`);
  process.exit(1);
}

const frameMs = 1000 / fps;
const { from, to } = frameRange(meta.loopMs, fps, opts);
const enc = encoder(out, fps, { crf: preview ? 20 : 14 });
const start = Date.now();
let sampleTotal = 0;
try {
  for (let f = from; f < to; f++) {
    const ms = f * frameMs;
    const half = (shutter * frameMs) / 2;
    const [a, b] = await page.evaluate(([t0, t1]) => [window.probe(t0), window.probe(t1)], [ms - half, ms + half]);
    const n = samplesForMotion(a, b, { min: Math.min(4, maxSamples), max: maxSamples });
    sampleTotal += n;
    await page.evaluate((list) => window.renderMany(list), subSamples(ms, n, frameMs, shutter));
    await enc.write(await scene.frame());
    if ((f - from) % 15 === 0) console.log(`${eta(start, f - from, to - from)}  (${n} samples)`);
  }
  await enc.end();
  console.log(`wrote ${out}: ${to - from} frames, ${(sampleTotal / Math.max(1, to - from)).toFixed(1)} samples/frame avg`);
  if (scene.errors.length) console.warn('page errors:\n' + scene.errors.join('\n'));
} finally {
  await scene.close();
}
