#!/usr/bin/env node
/* Sanity tests for engine-core under the SNAKE movement model.
   A line is removable iff the ray from its head endpoint, in the pointer
   direction, reaches the board edge without crossing another line. */
import { makeLine, canRemove, solveOrder, removableAtStart, linesOverlap } from "./engine-core.mjs";

let fail = 0;
const assert = (c,m)=>{ if(!c){ console.error("FAIL:",m); fail++; } };
const eq = (a,b)=>JSON.stringify(a)===JSON.stringify(b);

// --- Level 1: head-ray blocking ---
// A's head-ray (row2, going right) is blocked by vertical B at col6 until B
// peels up. C slides down freely and is independent.
const L1 = { cols:8, rows:8, lines:[
  { id:"a", points:[[1,2],[4,2]], head:"end",   dir:"R" }, // head (4,2), ray → right hits B
  { id:"b", points:[[6,0],[6,5]], head:"start", dir:"U" }, // head (6,0), ray → up, clear
  { id:"c", points:[[2,4],[2,7]], head:"end",   dir:"D" }  // head (2,7), ray → down, clear
]};
{
  const lines = L1.lines.map(s=>makeLine(L1,s));
  for(let i=0;i<lines.length;i++) for(let j=i+1;j<lines.length;j++)
    assert(!linesOverlap(lines[i],lines[j]), `L1 ${lines[i].id}/${lines[j].id} overlap`);
  const start = removableAtStart(lines).sort();
  assert(eq(start,["b","c"]), `L1 removable@start ${JSON.stringify(start)} != ["b","c"] (a must be blocked by b)`);
  const order = solveOrder(lines);
  assert(order, "L1 should be solvable");
  console.log(`L1: removable@start=[${start}] order=[${order}]  OK`);
}

// --- Level 2: chained head-rays ---
// A(row3,→) blocked by B(col5,vert). B head-ray up is blocked by D(row0,horiz)?
// Keep it simple & deterministic: D is independent, B blocks A.
const L2 = { cols:8, rows:8, lines:[
  { id:"a", points:[[1,3],[3,3]], head:"end",   dir:"R" }, // ray right hits b
  { id:"b", points:[[5,1],[5,5]], head:"end",   dir:"D" }, // head (5,5), ray down clear
  { id:"d", points:[[0,6],[3,6]], head:"start", dir:"L" }  // head (0,6), ray left clear (already at edge)
]};
{
  const lines = L2.lines.map(s=>makeLine(L2,s));
  const start = removableAtStart(lines).sort();
  assert(start.includes("b") && start.includes("d"), `L2 b,d should be free@start, got ${JSON.stringify(start)}`);
  assert(!start.includes("a"), `L2 a should be blocked by b at start, got ${JSON.stringify(start)}`);
  const order = solveOrder(lines);
  assert(order, "L2 should be solvable");
  console.log(`L2: removable@start=[${start}] order=[${order}]  OK`);
}

console.log(fail ? `\n${fail} test(s) FAILED` : "\nAll core tests passed");
process.exit(fail ? 1 : 0);
