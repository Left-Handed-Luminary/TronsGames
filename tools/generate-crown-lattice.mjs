#!/usr/bin/env node
/**
 * Crown Lattice puzzle generator.
 *
 * Builds region maps with exactly one solution and rates each by the logic it
 * needs, then writes the pack into the <script id="crown-puzzles"> block of
 * crown-lattice.html (or prints it with --print).
 *
 * The rules engine is loaded straight out of crown-lattice.html, so the
 * uniqueness check here is the same code the game runs on load.
 *
 *   node tools/generate-crown-lattice.mjs                 # default pack, seed 7
 *   node tools/generate-crown-lattice.mjs --seed 3 --print
 *
 * How a puzzle is made:
 *   1. Place n crowns, one per row and column, none touching (random backtracking).
 *   2. Grow n regions outward from those crowns until they fill the grid.
 *   3. Keep the map only if the solver finds exactly one solution and the
 *      rating matches the target tier for that slot.
 *
 * Ratings come from a human-style deduction solver:
 *   Easy   — only "one open cell left in a row/column/region" plus crossing out.
 *   Medium — also needs pointing (a region confined to one row/column, or the reverse)
 *            and "this cell would empty another unit".
 *   Hard   — also needs 2- or 3-unit confinement (k regions inside k rows/columns).
 *   Expert — the deduction solver stalls (still unique, but needs look-ahead).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML = fileURLToPath(new URL('../crown-lattice.html', import.meta.url));

export function loadLogic(html = readFileSync(HTML, 'utf8')) {
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const self = {};
  new Function('self', 'module', src)(self, undefined);
  return self.CrownLogic;
}
const L = loadLogic();

// ---------------------------------------------------------------- rng
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- construction
function randomCrowns(n, rnd) {
  const cols = [];
  const used = new Set();
  const order = () => [...Array(n).keys()].sort(() => rnd() - 0.5);
  return (function place(r) {
    if (r === n) return cols.slice();
    for (const c of order()) {
      if (used.has(c) || (r > 0 && Math.abs(cols[r - 1] - c) <= 1)) continue;
      cols[r] = c; used.add(c);
      const done = place(r + 1);
      if (done) return done;
      used.delete(c);
    }
    return null;
  })(0);
}

function growRegions(n, crowns, rnd) {
  const reg = new Array(n * n).fill(-1);
  crowns.forEach((c, r) => { reg[r * n + c] = r; });
  let left = n * n - n;
  const nbrs = (i) => {
    const r = Math.floor(i / n), c = i % n, out = [];
    if (r > 0) out.push(i - n); if (r < n - 1) out.push(i + n);
    if (c > 0) out.push(i - 1); if (c < n - 1) out.push(i + 1);
    return out;
  };
  while (left > 0) {
    // Frontier pairs: (owned cell's region, unowned neighbor).
    const byRegion = new Map();
    for (let i = 0; i < n * n; i++) {
      if (reg[i] < 0) continue;
      for (const j of nbrs(i)) if (reg[j] < 0) {
        if (!byRegion.has(reg[i])) byRegion.set(reg[i], []);
        byRegion.get(reg[i]).push(j);
      }
    }
    const keys = [...byRegion.keys()];
    let g;
    if (rnd() < 0.55) g = keys[Math.floor(rnd() * keys.length)]; // even growth
    else { // size-weighted growth: makes a few big sprawling regions
      const all = keys.flatMap((k) => byRegion.get(k).map(() => k));
      g = all[Math.floor(rnd() * all.length)];
    }
    const opts = byRegion.get(g);
    reg[opts[Math.floor(rnd() * opts.length)]] = g;
    left--;
  }
  return reg;
}

/** Region strings with letters assigned in reading order (A = first seen). */
function toRaw(n, reg, crowns) {
  const map = new Map();
  const rows = [];
  for (let r = 0; r < n; r++) {
    let s = '';
    for (let c = 0; c < n; c++) {
      const g = reg[r * n + c];
      if (!map.has(g)) map.set(g, String.fromCharCode(65 + map.size));
      s += map.get(g);
    }
    rows.push(s);
  }
  return { size: n, regions: rows, solution: crowns.slice() };
}

// ---------------------------------------------------------------- rating
/**
 * Human-style solver. Returns the hardest technique tier needed (1–3), or 4
 * when deduction stalls before the grid is solved.
 */
export function rate(raw) {
  const p = L.parsePuzzle(raw);
  const { n } = p;
  const units = L.units(p);
  const state = new Array(n * n).fill(0); // 0 open, 1 out, 2 crown
  let tier = 1;

  const place = (i) => {
    state[i] = 2;
    for (let j = 0; j < n * n; j++) if (state[j] === 0 && L.covers(p, i, j)) state[j] = 1;
  };
  const open = (u) => u.cells.filter((i) => state[i] === 0);
  const done = (u) => u.cells.some((i) => state[i] === 2);
  const crowns = () => state.filter((v) => v === 2).length;

  function singles() {
    for (const u of units) {
      if (done(u)) continue;
      const o = open(u);
      if (o.length === 0) throw new Error('contradiction');
      if (o.length === 1) { place(o[0]); return true; }
    }
    return false;
  }

  // Tier 2a: a cell whose crown would leave some other unit with no open cell.
  function wipes() {
    for (let i = 0; i < n * n; i++) {
      if (state[i] !== 0) continue;
      for (const u of units) {
        if (done(u) || u.cells.includes(i)) continue;
        if (open(u).every((j) => L.covers(p, i, j))) { state[i] = 1; return true; }
      }
    }
    return false;
  }

  // Tier 2b / 3: k units of one kind whose open cells fit inside k units of
  // another kind claim those k units; everything else there is crossed out.
  function confinement(k) {
    const kinds = ['region', 'row', 'col'];
    let changed = false;
    for (const a of kinds) {
      for (const b of kinds) {
        if (a === b) continue;
        const A = units.filter((u) => u.kind === a && !done(u));
        const keyB = (i) => (b === 'row' ? Math.floor(i / n) : b === 'col' ? i % n : p.regionOf[i]);
        for (const combo of combos(A, k)) {
          const covered = new Set();
          for (const u of combo) for (const i of open(u)) covered.add(keyB(i));
          if (covered.size !== k) continue;
          const inCombo = new Set(combo.flatMap((u) => u.cells));
          for (let i = 0; i < n * n; i++) {
            if (state[i] === 0 && covered.has(keyB(i)) && !inCombo.has(i)) { state[i] = 1; changed = true; }
          }
          if (changed) return true;
        }
      }
    }
    return false;
  }

  try {
    while (crowns() < n) {
      if (singles()) continue;
      if (confinement(1) || wipes()) { tier = Math.max(tier, 2); continue; }
      if (confinement(2) || confinement(3)) { tier = Math.max(tier, 3); continue; }
      return 4;
    }
  } catch { return 4; }
  return tier;
}

function* combos(list, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < list.length; i++) { acc.push(list[i]); yield* combos(list, k, i + 1, acc); acc.pop(); }
}

export const TIER_NAMES = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Expert' };

// ---------------------------------------------------------------- pack
const DEFAULT_PACK = [
  { size: 5, tier: 1, name: 'First Light' },
  { size: 6, tier: 1, name: 'Quiet Court' },
  { size: 6, tier: 2, name: 'Velvet Steps' },
  { size: 7, tier: 2, name: 'Lantern Row' },
  { size: 7, tier: 3, name: 'Glass Garden' },
  { size: 8, tier: 2, name: 'Midnight Ward' },
  { size: 8, tier: 3, name: 'Signal Keep' },
  { size: 9, tier: 3, name: 'Ember Throne' },
  { size: 9, tier: 4, name: 'Starfall Court' },
  { size: 10, tier: 3, name: 'Iron Orchard' },
];

/** Is region g still one piece if cell `skip` leaves it? */
function connectedWithout(n, reg, g, skip) {
  const cells = [];
  for (let i = 0; i < n * n; i++) if (reg[i] === g && i !== skip) cells.push(i);
  if (!cells.length) return false;
  const seen = new Set([cells[0]]);
  const stack = [cells[0]];
  while (stack.length) {
    const i = stack.pop(), r = Math.floor(i / n), c = i % n;
    for (const j of [r > 0 ? i - n : -1, r < n - 1 ? i + n : -1, c > 0 ? i - 1 : -1, c < n - 1 ? i + 1 : -1]) {
      if (j >= 0 && j !== skip && reg[j] === g && !seen.has(j)) { seen.add(j); stack.push(j); }
    }
  }
  return seen.size === cells.length;
}

/**
 * Nudge regions until the intended crowns are the only solution: take a rival
 * solution, pick one of its crowns that is not an intended crown, and hand that
 * cell to a neighboring region (keeping every region connected). This breaks
 * the rival because two of its crowns now share a region or one region is empty.
 */
function repairToUnique(n, reg, crowns, rnd, steps = 80) {
  const intended = new Set(crowns.map((c, r) => r * n + c));
  for (let s = 0; s < steps; s++) {
    const p = L.parsePuzzle(toRaw(n, reg, crowns));
    const sols = L.solveAll(p, 2);
    const rival = sols.find((x) => x.join() !== crowns.join());
    if (!rival) return sols.length === 1;
    const cand = rival.map((c, r) => r * n + c).filter((i) => !intended.has(i)).sort(() => rnd() - 0.5);
    let moved = false;
    for (const i of cand) {
      const r = Math.floor(i / n), c = i % n;
      const targets = [r > 0 ? i - n : -1, r < n - 1 ? i + n : -1, c > 0 ? i - 1 : -1, c < n - 1 ? i + 1 : -1]
        .filter((j) => j >= 0 && reg[j] !== reg[i]).map((j) => reg[j]).sort(() => rnd() - 0.5);
      if (!targets.length || !connectedWithout(n, reg, reg[i], i)) continue;
      reg[i] = targets[0];
      moved = true;
      break;
    }
    if (!moved) return false;
  }
  return false;
}

export function generate({ size, tier, maxTries = 20000 }, rnd) {
  for (let t = 0; t < maxTries; t++) {
    const crowns = randomCrowns(size, rnd);
    const reg = growRegions(size, crowns, rnd);
    if (!repairToUnique(size, reg, crowns, rnd)) continue;
    const raw = toRaw(size, reg, crowns);
    if (rate(raw) !== tier) continue;
    return { raw, tries: t + 1 };
  }
  throw new Error(`no ${size}x${size} tier-${tier} puzzle in ${maxTries} tries`);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('usage: node tools/generate-crown-lattice.mjs [--seed N] [--print]');
    return;
  }
  const seed = Number(flag('--seed', 7));
  const rnd = mulberry32(seed);
  const puzzles = DEFAULT_PACK.map((slot, k) => {
    const { raw, tries } = generate(slot, rnd);
    const errs = L.validatePuzzle(raw);
    if (errs.length) throw new Error(`${slot.name}: ${errs.join('; ')}`);
    console.error(`${slot.name.padEnd(16)} ${slot.size}x${slot.size} ${TIER_NAMES[slot.tier].padEnd(6)} (${tries} tries)`);
    return {
      id: `cl-${String(k + 1).padStart(2, '0')}`, name: slot.name, difficulty: TIER_NAMES[slot.tier],
      size: raw.size, regions: raw.regions, solution: raw.solution,
    };
  });
  const lines = puzzles.map((p) => '  ' + JSON.stringify(p));
  const json = `{"schemaVersion":1,"generator":{"seed":${seed},"createdWith":"tools/generate-crown-lattice.mjs"},"puzzles":[\n${lines.join(',\n')}\n]}`;
  if (args.includes('--print')) { console.log(json); return; }
  const html = readFileSync(HTML, 'utf8');
  const re = /(<script type="application\/json" id="crown-puzzles">\n)[\s\S]*?(\n<\/script>)/;
  if (!re.test(html)) throw new Error('crown-puzzles block not found');
  writeFileSync(HTML, html.replace(re, (_, a, b) => a + json + b));
  console.error(`wrote ${puzzles.length} puzzles to crown-lattice.html`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
