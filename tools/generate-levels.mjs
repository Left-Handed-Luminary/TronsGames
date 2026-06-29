#!/usr/bin/env node
/* ============================================================
   Vector Maze — offline level generator + verifier (M2)
   ------------------------------------------------------------
   Produces solvable levels using REVERSE CONSTRUCTION:

     Removal happens one line at a time; a line is removable when its
     slide path off-canvas is clear of all *remaining* lines. We build
     each puzzle in reverse-removal order: place line 1, then place
     line 2 so its slide path is clear of line 1, then line 3 clear of
     {1,2}, ... Removing them in the reverse of placement order is then
     valid BY CONSTRUCTION.

   Every emitted level is then re-checked by an INDEPENDENT DFS solver
   (engine-core.solveOrder). Any level that fails is discarded.

   Usage:
     node tools/generate-levels.mjs --out vector-maze-levels.json \
          --seed 1 --easy 5 --medium 6 --hard 6 --superhard 3

   Run with --help for all flags. Output schema: see
   vector-maze-requirements.md §8.2.
   ============================================================ */

import { writeFileSync } from "node:fs";
import {
  makeLine, canRemove, linesOverlap, selfIntersects,
  solveOrder, removableAtStart
} from "./engine-core.mjs";

/* ---------- seeded RNG (mulberry32) for reproducible packs ---------- */
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive

/* ---------- shape masks ----------
   inside(gx,gy,cols,rows) -> bool. Lines are confined to the shape so the
   maze reads as a symbol/fruit/emoticon centred on the board; the empty
   margin around it lets each line's head-ray exit to the canvas edge. */
function norm(gx,gy,cols,rows,fit){
  const cx=cols/2, cy=rows/2, R=Math.min(cols,rows)/2*fit;
  return [(gx-cx)/R, (gy-cy)/R];
}
function pip(x,y,v){ // point-in-polygon
  let inside=false;
  for(let i=0,j=v.length-1;i<v.length;j=i++){
    const xi=v[i][0],yi=v[i][1],xj=v[j][0],yj=v[j][1];
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function starVerts(k=5,inner=0.42){ const v=[]; for(let i=0;i<2*k;i++){
  const a=-Math.PI/2 + i*Math.PI/k, r=i%2?inner:1; v.push([Math.cos(a)*r, Math.sin(a)*r]); } return v; }
const STAR = starVerts();
const DIAMOND = [[0,-1.05],[1.05,0],[0,1.05],[-1.05,0]];

const MASKS = {
  heart:  (gx,gy,c,r)=>{ let [x,y]=norm(gx,gy,c,r,0.80); y=-y+0.25; x*=1.1;
                         const v=x*x+y*y-1; return v*v*v - x*x*y*y*y <= 0; },
  star:   (gx,gy,c,r)=> pip(...norm(gx,gy,c,r,0.96), STAR),
  smiley: (gx,gy,c,r)=>{ const [x,y]=norm(gx,gy,c,r,0.92); if(x*x+y*y>1) return false;
                         const eye=ex=>{const dx=x-ex,dy=y+0.32; return dx*dx+dy*dy<0.045;};
                         if(eye(-0.36)||eye(0.36)) return false;
                         const my=-0.05+0.9*x*x; if(y>0.1 && Math.abs(x)<0.55 && Math.abs(y-my)<0.13) return false;
                         return true; },
  apple:  (gx,gy,c,r)=>{ const [x,y]=norm(gx,gy,c,r,0.86);
                         return x*x+y*y<=1 || (Math.abs(x)<0.10 && y<-0.85 && y>-1.25); }, // circle + stem
  diamond:(gx,gy,c,r)=> pip(...norm(gx,gy,c,r,0.96), DIAMOND),
};
const SHAPE_CYCLE = ["heart","star","smiley","apple","diamond"];

/* ---------- difficulty presets ----------
   Portrait grids (cols x rows). `lines` is [floor, cap]: the generator packs up
   to `cap` and accepts any board with at least `floor` lines once placement
   stalls. Shaped tiers confine lines to a centred shape mask (near-square grids
   so the shape isn't distorted). maxSeg = cap on a single segment's length. */
const PRESETS = {
  easy:       { cols:8,  rows:11, lines:[8,12],   maxBends:1, maxSeg:5, lives:3, maxStartFrac:0.95, candTries:8,  shaped:false },
  medium:     { cols:11, rows:16, lines:[22,32],  maxBends:2, maxSeg:6, lives:3, maxStartFrac:0.92, candTries:8,  shaped:false },
  hard:       { cols:20, rows:22, lines:[20,200], maxBends:2, maxSeg:6, lives:3, maxStartFrac:0.97, candTries:10, shaped:true },
  superhard:  { cols:26, rows:28, lines:[30,240], maxBends:2, maxSeg:6, lives:3, maxStartFrac:0.97, candTries:10, shaped:true },
  dense:      { cols:32, rows:34, lines:[45,300], maxBends:2, maxSeg:6, lives:3, maxStartFrac:0.97, candTries:10, shaped:true }
};

/* ---------- candidate line generation ---------- */

// Outward slide direction along the final segment at the head endpoint.
function outwardDir(points, head){
  let a, b;
  if(head === "end"){ a = points[points.length-2]; b = points[points.length-1]; }
  else             { a = points[1];                b = points[0]; }
  const dx = b[0]-a[0], dy = b[1]-a[1];
  if(dx > 0) return "R";
  if(dx < 0) return "L";
  if(dy > 0) return "D";
  return "U";
}

// Random orthogonal polyline (alternating axes, no immediate retrace).
// If `mask` is given, every vertex AND every grid point a segment crosses must
// be inside the mask, so the whole line stays within the shape.
function randomCandidate(rng, cols, rows, maxBends, maxSeg, mask){
  let x, y, tries=0;
  do { x = ri(rng,0,cols); y = ri(rng,0,rows); tries++; }
  while(mask && !mask(x,y,cols,rows) && tries<40);
  if(mask && !mask(x,y,cols,rows)) return null;

  const pts = [[x,y]];
  const bends = ri(rng, 0, maxBends);
  let lastAxis = null;
  for(let i=0; i<=bends; i++){
    const axis = lastAxis === null ? (rng() < 0.5 ? "h" : "v")
                                   : (lastAxis === "h" ? "v" : "h");
    let moved = false;
    for(let tryN=0; tryN<6; tryN++){
      const sign = rng() < 0.5 ? -1 : 1;
      let maxLen = axis === "h" ? (sign>0 ? cols-x : x) : (sign>0 ? rows-y : y);
      maxLen = Math.min(maxLen, maxSeg);
      // Clamp so the segment never leaves the mask.
      if(mask){
        let run=0;
        for(let s=1;s<=maxLen;s++){
          const nx = axis==="h" ? x+sign*s : x, ny = axis==="v" ? y+sign*s : y;
          if(!mask(nx,ny,cols,rows)) break;
          run=s;
        }
        maxLen=run;
      }
      if(maxLen < 1) continue;
      const len = ri(rng, 1, maxLen);
      if(axis === "h") x += sign*len; else y += sign*len;
      pts.push([x,y]);
      moved = true;
      break;
    }
    if(!moved) break;
    lastAxis = axis;
  }
  if(pts.length < 2) return null;
  const head = rng() < 0.5 ? "start" : "end";
  return { points: pts, head, dir: outwardDir(pts, head) };
}

/* ---------- reverse construction for one level ----------
   At each step we generate several valid candidates and greedily keep
   the one that BLOCKS the most currently-removable lines. Blocking an
   already-placed line is safe: the new line is removed before it (reverse
   order), so the dependency is always resolvable — it just forces the
   player to find the order. This is what turns a solvable board into an
   actual puzzle. */

// How many currently-removable placed lines would `cand` block?
function newlyBlocked(placed, cand){
  let n = 0;
  const withC = placed.concat(cand);
  for(const l of placed){
    if(canRemove(l, placed) && !canRemove(l, withC)) n++;
  }
  return n;
}

function buildLevel(rng, preset, name, difficulty, shapeName){
  const cols = preset.cols, rows = preset.rows;
  const level = { cols, rows };
  const mask = shapeName ? MASKS[shapeName] : null;
  const floor = preset.lines[0], cap = preset.lines[1];
  const placed = [];           // placement order; removal order is the reverse
  let stall = 0;
  const STALL = 600;           // give up packing once we can't place anything

  while(placed.length < cap && stall < STALL){
    let best = null, bestScore = -1;
    for(let k=0; k<preset.candTries; k++){
      const cand = randomCandidate(rng, cols, rows, preset.maxBends, preset.maxSeg, mask);
      if(!cand) continue;
      cand.id = "L" + (placed.length+1);
      const line = makeLine(level, cand);
      if(selfIntersects(line)) continue;
      if(placed.some(p => linesOverlap(line, p))) continue;     // at-rest overlap
      if(!canRemove(line, placed)) continue;                    // must clear placed
      // Prefer blockers, then longer lines (more maze-like), small jitter.
      const score = newlyBlocked(placed, line)*100 + line.points.length*3 + rng();
      if(score > bestScore){ bestScore = score; best = line; }
    }
    if(!best){ stall++; continue; }
    placed.push(best); stall = 0;
  }

  if(placed.length < floor) return null; // stalled too sparse — retry the level

  // Quality gate: reject boards where too much is removable up front.
  const startFrac = removableAtStart(placed).length / placed.length;
  if(startFrac > preset.maxStartFrac) return null;

  // Removal order = reverse of placement (valid by construction).
  const construction = placed.slice().reverse().map(l => l.id);

  // Independent verification.
  const order = solveOrder(placed.map(l => ({ ...l })));
  if(!order) return null;

  // Shuffle the lines[] array so placement order isn't a visual giveaway
  // (ids stay attached; solution references ids).
  const shuffled = placed.slice();
  for(let i=shuffled.length-1; i>0; i--){
    const j = Math.floor(rng()*(i+1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const startRemovable = removableAtStart(placed);
  const lvl = {
    difficulty,
    lives: preset.lives,
    grid: { cols, rows },
    lines: shuffled.map(l => ({ id:l.id, points:l.points, head:l.head, dir:l.dir })),
    solution: order,
    _meta: {
      lineCount: placed.length,
      removableAtStart: startRemovable.length,
      constructionOrder: construction,
      avgBends: +(placed.reduce((s,l)=>s+(l.points.length-2),0)/placed.length).toFixed(2)
    }
  };
  if(shapeName) lvl.shape = shapeName;
  return lvl;
}

/* ---------- pack assembly ---------- */

function generatePack({ seed, counts, keepMeta }){
  const rng = mulberry32(seed);
  const plan = [
    ...Array(counts.easy).fill("easy"),
    ...Array(counts.medium).fill("medium"),
    ...Array(counts.hard).fill("hard"),
    ...Array(counts.superhard).fill("superhard"),
    ...Array(counts.dense).fill("dense"),
  ];
  const levels = [];
  let idNum = 1, guard = 0, shapeIdx = 0;
  for(const difficulty of plan){
    // Shaped tiers cycle through the shape library for variety.
    const shapeName = PRESETS[difficulty].shaped ? SHAPE_CYCLE[shapeIdx++ % SHAPE_CYCLE.length] : null;
    let lvl = null;
    while(!lvl && guard < 100000){
      guard++;
      lvl = buildLevel(rng, PRESETS[difficulty],
                       `Level ${idNum}`, difficulty, shapeName);
    }
    if(!lvl){ console.error(`Could not build a ${difficulty} level`); continue; }
    lvl.id = idNum;
    lvl.name = `Level ${idNum}`;
    if(!keepMeta) delete lvl._meta;
    levels.push(lvl);
    idNum++;
  }
  return { schemaVersion: 1, generator: { seed, createdWith: "tools/generate-levels.mjs" }, levels };
}

/* ---------- CLI ---------- */

function parseArgs(argv){
  // Default counts = the curated 20-level curve (easy→dense showpieces).
  const a = { out:"vector-maze-levels.json", seed:1,
              easy:4, medium:5, hard:5, superhard:4, dense:2, meta:false, help:false };
  for(let i=2;i<argv.length;i++){
    const k=argv[i];
    if(k==="--help"||k==="-h"){ a.help=true; }
    else if(k==="--meta"){ a.meta=true; }
    else if(k==="--out"){ a.out=argv[++i]; }
    else if(k==="--seed"){ a.seed=parseInt(argv[++i],10); }
    else if(k==="--easy"){ a.easy=parseInt(argv[++i],10); }
    else if(k==="--medium"){ a.medium=parseInt(argv[++i],10); }
    else if(k==="--hard"){ a.hard=parseInt(argv[++i],10); }
    else if(k==="--superhard"){ a.superhard=parseInt(argv[++i],10); }
    else if(k==="--dense"){ a.dense=parseInt(argv[++i],10); }
    else { console.error("Unknown arg:", k); a.help=true; }
  }
  return a;
}

const HELP = `Vector Maze level generator

  node tools/generate-levels.mjs [options]

Options:
  --out <file>        Output JSON path (default vector-maze-levels.json)
  --seed <int>        RNG seed for reproducible packs (default 1)
  --easy <n>          Number of easy levels (default 4)
  --medium <n>        Number of medium levels (default 5)
  --hard <n>          Number of hard levels (default 5)
  --superhard <n>     Number of super-hard levels (default 4)
  --dense <n>         Number of dense showpiece levels (default 2)
  --meta              Keep per-level _meta (counts, construction order)
  -h, --help          Show this help

Every emitted level is solvable by construction and re-checked by an
independent DFS solver before being written.`;

function main(){
  const a = parseArgs(process.argv);
  if(a.help){ console.log(HELP); return; }
  const pack = generatePack({
    seed: a.seed,
    counts: { easy:a.easy, medium:a.medium, hard:a.hard, superhard:a.superhard, dense:a.dense },
    keepMeta: a.meta
  });

  // Final guard: re-verify everything that's about to be written.
  let bad = 0;
  for(const lvl of pack.levels){
    const lines = lvl.lines.map(l => makeLine({cols:lvl.grid.cols, rows:lvl.grid.rows}, l));
    for(let i=0;i<lines.length;i++)
      for(let j=i+1;j<lines.length;j++)
        if(linesOverlap(lines[i], lines[j])) { bad++; console.error(`Level ${lvl.id}: rest-overlap`); }
    if(!solveOrder(lines)) { bad++; console.error(`Level ${lvl.id}: UNSOLVABLE`); }
  }
  if(bad){ console.error(`\nABORTED: ${bad} invalid level(s).`); process.exit(1); }

  writeFileSync(a.out, JSON.stringify(pack, null, 2));
  const by = {};
  for(const l of pack.levels) by[l.difficulty]=(by[l.difficulty]||0)+1;
  console.log(`Wrote ${pack.levels.length} levels to ${a.out}  (seed ${a.seed})`);
  console.log("By difficulty:", JSON.stringify(by));
}

main();
