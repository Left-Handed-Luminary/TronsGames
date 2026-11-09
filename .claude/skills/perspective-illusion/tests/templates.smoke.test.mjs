// Smoke test: every template loads in headless Chromium and honours the page contract.
//   PI_NODE_MODULES=/path/with/three/node_modules node --test tests/*.test.mjs
// Skips (does not fail) when three.js or Playwright are not installed, so the fast
// unit tests still run anywhere. Takes ~10 s per template on a CPU-only machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = path.join(here, '..', 'templates');
const pages = fs.readdirSync(templates).filter((f) => f.endsWith('.html'));

function findNodeModules() {
  const candidates = [process.env.PI_NODE_MODULES, path.join(templates, 'node_modules'), path.join(process.cwd(), 'node_modules')];
  return candidates.find((d) => d && fs.existsSync(path.join(d, 'three', 'build', 'three.module.js')));
}
const nodeModules = findNodeModules();
let harness = null;
try {
  harness = await import(path.join(templates, 'lib', 'harness.mjs'));
  harness.loadPlaywright();
} catch { harness = null; }
const skip = !nodeModules ? 'three.js not found (set PI_NODE_MODULES)' : !harness ? 'playwright not found' : false;

for (const page of pages) {
  test(`${page} loads and honours the page contract`, { skip, timeout: 180000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-smoke-'));
    fs.cpSync(templates, work, { recursive: true });
    fs.symlinkSync(nodeModules, path.join(work, 'node_modules'), 'dir');
    const cwd = process.cwd();
    process.chdir(work);
    let scene;
    try {
      scene = await harness.openScene(page, { scale: 0.25 });
      const { meta } = scene;
      assert.ok(meta.loopMs > 0, 'LOOP_MS is set');
      assert.ok(meta.hasRenderMany, 'renderMany is defined');
      assert.equal(meta.width, Math.round(1920 * 0.25));

      const check = await scene.page.evaluate((loop) => {
        const a = window.probe(0); const b = window.probe(loop);
        const seam = a.every((p, i) => (p === null) === (b[i] === null)
          && (p === null || (Math.abs(p.px - b[i].px) < 1e-6 && Math.abs(p.py - b[i].py) < 1e-6)));
        const n = window.renderMany([[loop * 0.5, 0.25, -0.25], [loop * 0.5, -0.25, 0.25]]);
        window.setJitter(0, 0);
        return { seam, n, probes: a.length, hasRender: typeof window.render === 'function' };
      }, meta.loopMs);
      assert.ok(check.seam, 'probe(0) equals probe(LOOP_MS): the camera loop closes');
      assert.equal(check.n, 2);
      assert.ok(check.probes > 0);
      assert.ok(check.hasRender);

      // the frame is a picture, not a blank canvas: PNG of a busy frame is large
      const png = await scene.frame();
      assert.ok(png.length > 20000, `frame looks blank (${png.length} bytes)`);
      assert.deepEqual(scene.errors, [], 'no page errors');
    } finally {
      if (scene) await scene.close();
      process.chdir(cwd);
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
