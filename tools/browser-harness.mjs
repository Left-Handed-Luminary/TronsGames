/**
 * Shared harness for browser-driven game tests.
 *
 * Opens one of the repo's real HTML pages in headless Chromium so tests can
 * call the game's own top-level functions through page.evaluate(). Nothing is
 * re-implemented: the code under test is exactly what players run.
 *
 * Two things make the runs hermetic and repeatable:
 *   - Every http(s) request is aborted. The games' rules never depend on the
 *     network (only Tailwind styling is lost), so tests pass offline.
 *   - Math.random is replaced, before any page script runs, by a seeded
 *     mulberry32 generator. Mine layouts and shuffles are identical on every run.
 *
 * Requires the pre-installed Playwright + Chromium (no `playwright install`).
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

/** Absolute path of a file in the repo root, e.g. repoFile('reverse2048.html'). */
export function repoFile(name) {
  return fileURLToPath(new URL(`../${name}`, import.meta.url));
}

/**
 * Launch Chromium and open `htmlFile` (relative to the repo root).
 *
 * @param {string} htmlFile    page to open, e.g. 'mega-minesweeper.html'
 * @param {object} [opts]
 * @param {number} [opts.seed=1]          seed for the deterministic Math.random
 * @param {object} [opts.localStorage]    key/value pairs present before load
 * @param {string} [opts.readyWhen]       JS expression awaited after load
 * @returns {Promise<{browser, page, errors: string[], reload: Function, close: Function}>}
 *   `errors` collects uncaught page errors so tests can assert none occurred.
 */
export async function openGame(htmlFile, opts = {}) {
  const { seed = 1, localStorage: storage = {}, readyWhen = 'true' } = opts;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
  await context.route(/^https?:/, (route) => route.abort());

  await context.addInitScript(({ seed, storage }) => {
    let s = seed >>> 0;
    Math.random = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Seed storage once per page load, before the game reads it.
    try { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch { /* storage blocked */ }
  }, { seed, storage });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const url = pathToFileURL(repoFile(htmlFile)).href;
  const load = async () => {
    await page.goto(url);
    await page.waitForFunction(readyWhen);
  };
  await load();

  return {
    browser,
    page,
    errors,
    reload: load,
    close: () => browser.close(),
  };
}
