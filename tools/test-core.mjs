#!/usr/bin/env node
/* Parity + sanity tests for engine-core.
   Confirms the shared core reproduces the in-game M1 level solutions,
   so offline "verified solvable" matches what the running game does. */
import { makeLine, solveOrder, removableAtStart, linesOverlap } from "./engine-core.mjs";

// The exact three levels hand-authored in vector-maze.html (M1).
const M1 = [
  { name:"Warm Up", cols:8, rows:8, expectStart:["b","c"], lines:[
    { id:"a", points:[[1,2],[4,2]], head:"end",   dir:"R" },
    { id:"b", points:[[6,0],[6,5]], head:"start", dir:"U" },
    { id:"c", points:[[2,4],[2,7]], head:"end",   dir:"D" } ]},
  { name:"Chain", cols:8, rows:8, expectStart:["d","e"], lines:[
    { id:"a", points:[[1,4],[3,4]], head:"end",   dir:"R" },
    { id:"b", points:[[5,4],[5,6]], head:"end",   dir:"D" },
    { id:"d", points:[[4,7],[6,7]], head:"start", dir:"L" },
    { id:"e", points:[[7,1],[7,3]], head:"start", dir:"U" } ]},
  { name:"Tangle", cols:8, rows:8, expectStart:["b","d","e"], lines:[
    { id:"a", points:[[2,1],[5,1]], head:"end",   dir:"R" },
    { id:"b", points:[[6,0],[6,3]], head:"start", dir:"U" },
    { id:"c", points:[[2,3],[2,6]], head:"end",   dir:"D" },
    { id:"d", points:[[1,7],[3,7]], head:"start", dir:"L" },
    { id:"e", points:[[4,4],[7,4]], head:"end",   dir:"R" } ]}
];

let fail = 0;
function assert(cond, msg){ if(!cond){ console.error("FAIL:", msg); fail++; } }

for(const lvl of M1){
  const lines = lvl.lines.map(s => makeLine(lvl, s));
  // no rest overlaps
  for(let i=0;i<lines.length;i++)
    for(let j=i+1;j<lines.length;j++)
      assert(!linesOverlap(lines[i], lines[j]), `${lvl.name}: ${lines[i].id}/${lines[j].id} overlap at rest`);
  // solvable
  const order = solveOrder(lines);
  assert(order, `${lvl.name}: should be solvable`);
  // not trivially all-removable at start (must require ordering)
  const start = removableAtStart(lines).sort();
  assert(start.length < lines.length, `${lvl.name}: should require ordering`);
  assert(JSON.stringify(start) === JSON.stringify(lvl.expectStart),
         `${lvl.name}: removable@start ${JSON.stringify(start)} != ${JSON.stringify(lvl.expectStart)}`);
  console.log(`${lvl.name}: order=[${order}] removable@start=[${start}]  OK`);
}

console.log(fail ? `\n${fail} test(s) FAILED` : "\nAll core tests passed");
process.exit(fail ? 1 : 0);
