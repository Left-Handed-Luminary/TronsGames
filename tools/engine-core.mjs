/* ============================================================
   Vector Maze — shared engine core (geometry + collision + solver)
   ------------------------------------------------------------
   This is the canonical implementation used by the offline level
   generator/verifier. The in-game copy inside vector-maze.html
   MUST stay in sync with the functions below (same constants and
   same collision math) so that "verified solvable" offline always
   matches what happens in the running game.

   Pure ES module: no DOM, no canvas. Operates on plain objects.
   ============================================================ */

export const CANVAS = 900;   // internal play resolution (square)
export const PAD = 56;       // board inset in px
export const W = 11;         // line thickness
export const CLR = 4;        // extra collision clearance

export const DIRV = { R:[1,0], L:[-1,0], U:[0,-1], D:[0,1] };

export function cellSize(level){
  return (CANVAS - 2*PAD) / Math.max(level.cols, level.rows);
}

// Build pixel vertices for a line's grid points.
export function toPx(level, points){
  const cs = cellSize(level);
  return points.map(([gx,gy]) => ({ x: PAD + gx*cs, y: PAD + gy*cs }));
}

// Attach pxBase (+ derived head point) to a raw {id,points,head,dir}.
export function makeLine(level, src){
  const pxBase = toPx(level, src.points);
  const headPt = src.head === "start" ? pxBase[0] : pxBase[pxBase.length-1];
  return { ...src, pxBase, headPt };
}

export function segsOf(line){
  const s=[]; const p=line.pxBase;
  for(let i=0;i<p.length-1;i++) s.push({x0:p[i].x,y0:p[i].y,x1:p[i+1].x,y1:p[i+1].y});
  return s;
}

export function segAABB(s, pad){
  return {
    minx:Math.min(s.x0,s.x1)-pad, maxx:Math.max(s.x0,s.x1)+pad,
    miny:Math.min(s.y0,s.y1)-pad, maxy:Math.max(s.y0,s.y1)+pad
  };
}

export function lineBBox(line){
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  for(const p of line.pxBase){
    minx=Math.min(minx,p.x); maxx=Math.max(maxx,p.x);
    miny=Math.min(miny,p.y); maxy=Math.max(maxy,p.y);
  }
  return {minx,miny,maxx,maxy};
}

// SNAKE MOVEMENT MODEL
// --------------------
// A line peels off head-first: the head travels forward in its pointer
// direction while the body follows the line's own path. The body only ever
// retraces its own footprint (which never overlaps another line), so the only
// thing that can block removal is the HEAD'S RAY — a straight ray from the head
// endpoint in the pointer direction out to the board edge. A line is removable
// iff that ray is clear of every other line.

// Head endpoint of a line (pixel coords).
export function headPoint(line){
  return line.head === "start" ? line.pxBase[0] : line.pxBase[line.pxBase.length-1];
}

// Distance from the head endpoint to the board edge along the pointer direction.
export function rayLenToEdge(E, dir){
  if(dir==="R") return CANVAS - E.x;
  if(dir==="L") return E.x;
  if(dir==="D") return CANVAS - E.y;
  return E.y; // U
}

// Smallest forward distance from head point E (moving in dir) at which the
// head's inflated box contacts any segment of `others`. Infinity if clear.
// Must match the in-game copy exactly.
export function rayHitDist(E, dir, others){
  const pm=W/2+CLR, ps=W/2;
  const m={ minx:E.x-pm, maxx:E.x+pm, miny:E.y-pm, maxy:E.y+pm };
  let best=Infinity;
  for(const o of others){
    for(const ss of segsOf(o)){
      const s=segAABB(ss,ps);
      let t;
      if(dir==="R"){
        if(!(m.miny<=s.maxy && s.miny<=m.maxy)) continue;
        if(s.maxx<=m.minx) continue;
        t=Math.max(0, s.minx-m.maxx);
      } else if(dir==="L"){
        if(!(m.miny<=s.maxy && s.miny<=m.maxy)) continue;
        if(s.minx>=m.maxx) continue;
        t=Math.max(0, m.minx-s.maxx);
      } else if(dir==="D"){
        if(!(m.minx<=s.maxx && s.minx<=m.maxx)) continue;
        if(s.maxy<=m.miny) continue;
        t=Math.max(0, s.miny-m.maxy);
      } else { // U
        if(!(m.minx<=s.maxx && s.minx<=m.maxx)) continue;
        if(s.miny>=m.maxy) continue;
        t=Math.max(0, m.miny-s.maxy);
      }
      if(t<best) best=t;
    }
  }
  return best;
}

// Can `line` be removed given the other present lines? (snake: head-ray clear)
export function canRemove(line, others){
  const E=headPoint(line);
  const reach=rayLenToEdge(E, line.dir);
  const rest=others.filter(o=>o!==line);
  return rayHitDist(E, line.dir, rest) >= reach;
}

// Do two lines overlap at rest (malformed board)?
export function linesOverlap(a, b){
  for(const sa of segsOf(a)){
    const A=segAABB(sa, W/2);
    for(const sb of segsOf(b)){
      const B=segAABB(sb, W/2);
      if(A.minx<=B.maxx && B.minx<=A.maxx && A.miny<=B.maxy && B.miny<=A.maxy) return true;
    }
  }
  return false;
}

// Does a line self-intersect (non-adjacent segments touching)?
export function selfIntersects(line){
  const segs=segsOf(line);
  for(let i=0;i<segs.length;i++){
    const A=segAABB(segs[i], W/2 - 0.5);
    for(let j=i+2;j<segs.length;j++){
      // skip adjacent (shared vertex) segments
      const B=segAABB(segs[j], W/2 - 0.5);
      if(A.minx<=B.maxx && B.minx<=A.maxx && A.miny<=B.maxy && B.miny<=A.maxy) return true;
    }
  }
  return false;
}

// DFS solver: returns a valid removal order (array of ids) or null.
export function solveOrder(lines){
  const dead=new Set();
  let result=null;
  function rec(present, path){
    if(present.length===0){ result=path; return true; }
    const key=present.map(l=>l.id).sort().join(",");
    if(dead.has(key)) return false;
    for(const l of present){
      if(canRemove(l, present)){
        if(rec(present.filter(x=>x!==l), path.concat(l.id))) return true;
      }
    }
    dead.add(key);
    return false;
  }
  rec(lines.slice(), []);
  return result;
}

export function isSolvable(lines){ return solveOrder(lines) !== null; }

// Lines removable on the very first move (a difficulty signal).
export function removableAtStart(lines){
  return lines.filter(l => canRemove(l, lines)).map(l => l.id);
}
