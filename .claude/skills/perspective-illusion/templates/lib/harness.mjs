/**
 * harness.mjs — shared plumbing for render.mjs and render_fast.mjs:
 * a tiny static file server, a headless Chromium with WebGL, CLI parsing,
 * and an ffmpeg encoder fed with PNG frames on stdin.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Parse `--key=value` / `--flag` arguments plus positionals. */
export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] === undefined ? true : m[2];
    else positional.push(a);
  }
  return { opts, positional };
}

/** Serve `root` on a random localhost port. Resolves to { url, close }. */
export function serve(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(base, rel);
    if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Load Playwright from the project, NODE_PATH, or the preinstalled cloud location. */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright', '/opt/node-tools/node_modules/playwright'];
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error('playwright not found: npm i playwright (and npx playwright install chromium)');
}

/**
 * Open `page` (relative to cwd) in headless Chromium and wait for window.READY.
 * Falls back to SwiftShader when there is no GPU.
 */
export async function openScene(pageFile, { scale = 1, query = '' } = {}) {
  const { chromium } = loadPlaywright();
  const srv = await serve(process.cwd());
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-webgl', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const q = new URLSearchParams(query);
  if (scale !== 1) q.set('scale', String(scale));
  const qs = q.toString() ? `?${q}` : '';
  await page.goto(`${srv.url}/${pageFile}${qs}`);
  try {
    await page.waitForFunction(() => window.READY === true, null, { timeout: 120000 });
  } catch (e) {
    throw new Error(`scene never set window.READY. Page errors:\n${errors.join('\n') || '(none)'}`);
  }
  const meta = await page.evaluate(() => ({
    loopMs: window.LOOP_MS,
    hasRenderMany: typeof window.renderMany === 'function',
    width: document.querySelector('#frame').width,
    height: document.querySelector('#frame').height,
  }));
  return {
    page, meta, errors,
    async frame() {
      return page.locator('#frame').screenshot({ type: 'png', omitBackground: false });
    },
    async close() { await browser.close(); await srv.close(); },
  };
}

/** Spawn ffmpeg reading PNGs from stdin; resolves when encoding finishes. */
export function encoder(out, fps, { crf = 16 } = {}) {
  const ff = process.env.FFMPEG || 'ffmpeg';
  const proc = spawn(ff, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps),
    '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  return {
    write(buf) {
      return new Promise((resolve) => { if (proc.stdin.write(buf)) resolve(); else proc.stdin.once('drain', resolve); });
    },
    async end() { proc.stdin.end(); await done; },
  };
}

/** Frame range for a loop: frames [from, to) at fps. The seam frame (t = loop) is excluded. */
export function frameRange(loopMs, fps, opts) {
  const total = Math.round((loopMs / 1000) * fps);
  const from = opts.from !== undefined ? Math.round(parseFloat(opts.from) * fps) : 0;
  const to = opts.to !== undefined ? Math.round(parseFloat(opts.to) * fps) : total;
  return { total, from: Math.max(0, from), to: Math.min(total, to) };
}

export function eta(start, done, total) {
  const el = (Date.now() - start) / 1000;
  const left = done ? (el / done) * (total - done) : 0;
  return `${done}/${total}  ${el.toFixed(0)}s elapsed, ~${left.toFixed(0)}s left`;
}
