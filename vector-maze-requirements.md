# Vector Maze — Requirements

> Status: **Draft v1** (requirements only — no game code yet)
> Game file (to be rebuilt): `vector-maze.html`
> Portal: registered in `index.html` `gameFiles[]`

A single-page, self-contained browser game in the TronsGames style (one HTML file:
HTML + CSS + JS, canvas rendering, touch + mouse input). This document defines the
gameplay, data model, and — most importantly — how every level is **guaranteed
solvable** before it ships.

---

## 1. Concept

Vector Maze is a **peel-away line puzzle**. The board looks like a dense maze made of
many lines. Each line has a single **pointer** (a mouse-cursor / arrowhead) at one end.
Tapping anywhere on a line makes the **whole line slide** in the direction its pointer
points. If its path off the canvas is clear, the line peels away and is removed. If its
path is blocked by another line, it bounces back, turns red, and the player loses a life.

- **Goal:** remove every line from the canvas.
- **Lose:** run out of lives.
- The challenge is **order**: most lines are blocked until other lines are removed
  first, so the player must find a working removal sequence.

This is the same family as "unblock"/slide puzzles, but with arbitrarily shaped
maze lines and a directional pointer per line.

---

## 2. Core Gameplay Loop

1. A level loads: a grid filled with lines, each showing one pointer.
2. Player taps a line.
3. The line slides rigidly in its pointer direction.
   - **Clear path → valid:** the line travels fully off the canvas and is removed.
     Progress increases.
   - **Blocked → invalid:** the line advances until first contact, flashes red,
     bounces back to its original position, and the player loses one life.
4. Repeat until all lines are removed (**win**) or lives reach zero (**lose**).

Only one line animates at a time; input is locked during animation.

---

## 3. Board & Grid Model

- The canvas is a **grid of unit squares**: `cols × rows` cells, giving
  `(cols+1) × (rows+1)` grid points.
- **Turning points are only at grid points.** Every line vertex sits on an integer
  grid coordinate `(gx, gy)` with `0 ≤ gx ≤ cols`, `0 ≤ gy ≤ rows`.
- All line segments are **axis-aligned** (horizontal or vertical). Diagonals are not
  allowed.
- The canvas is rendered at a fixed internal resolution (e.g. `900×900`) and scaled to
  fit; grid coordinates map to pixels via a cell size. (Portrait boards like the
  screenshots are allowed — `cols`/`rows` need not be equal.)

---

## 4. Line Model

A **line** is an open orthogonal polyline:

- An ordered list of grid-point vertices `[[gx,gy], [gx,gy], ...]` (≥ 2 vertices).
- Consecutive vertices differ in **exactly one** axis (so each segment is H or V).
- The polyline does **not** self-intersect or retrace itself.
- Exactly **one endpoint** carries the **pointer**:
  - `head`: which end (`"start"` = first vertex, `"end"` = last vertex).
  - `dir`: one of `"U" | "D" | "L" | "R"`. The pointer's tip points this way and it is
    the direction the whole line travels when tapped.
  - **Design rule:** `dir` is the **outward direction along the final segment at the
    head endpoint** (the line slides "forward" the way its head points). This matches
    the screenshots, where arrowheads continue their last segment. *(Open question 9.2
    asks whether to also allow perpendicular pointer directions.)*

Visually, lines have rounded thickness (like the screenshots). Thickness matters for
collision clearance (see §5).

---

## 5. Movement & Collision Rules

When a line is tapped, treat the entire polyline as one **rigid shape** that translates
in `dir`.

- **Sweep:** translate the shape by `t · dir` for increasing `t`, from `t = 0` until the
  shape is fully outside the canvas bounds (`t = T_exit`). Any bounded shape translated
  in a single cardinal direction always fully exits eventually.
- **Collision:** at any `t ∈ (0, T_exit]`, if the translated shape **touches or overlaps**
  any other *remaining* line, that is a collision. "Touch" includes the line thickness:
  two centerlines closer than `(thickness + small clearance)` count as contact.
- **Valid line:** no collision for the entire sweep → the line exits and is **removed**.
- **Invalid line:** a collision occurs at some smallest `t = t_hit`:
  - Animate the line forward to `t_hit` (first contact),
  - Flash it **red**,
  - Animate it back to `t = 0` (original position),
  - Decrement lives by 1.

Collision math (centerline form, sufficient for thin lines + clearance):
- The moving line's segments sweep regions as `t` grows; perpendicular segments sweep
  rectangles, parallel segments sweep along their length.
- Equivalent practical test: for each moving segment vs. each static segment, compute the
  smallest `t ≥ 0` at which they come within the clearance distance, considering only the
  translation along `dir`. The minimum such `t` across all pairs is `t_hit` (or none).
- A coarse-but-safe alternative for v1: rasterize lines onto the grid/pixel buffer and
  step the sweep in small increments, checking overlap. Precise geometry is preferred for
  smoothness; rasterization is an acceptable fallback.

---

## 6. Win / Lose

- **Win:** all lines removed. Show a "Level Clear" overlay with star rating and a
  "Next Level" action.
- **Lose:** lives reach 0. Show "Game Over" overlay with a "Retry Level" action.
- **Progress meter:** percentage = `removed / total` lines (the screenshots show a
  `%` and a star progress bar).

---

## 7. Lives & Scoring

- **Lives:** default **3** (matches the three water-drop icons in the screenshots).
  Configurable per difficulty. *(Old prototype used 5 — see open question 9.1.)*
- **Stars (per level):** based on lives remaining at clear, e.g.
  - 3★ = no lives lost, 2★ = 1 lost, 1★ = cleared with any lives remaining.
- **Persistence:** current level and best star rating per level saved to
  `localStorage` (key namespace `vector_maze_*`).

---

## 8. Levels & Data

### 8.1 Source of truth: a pre-generated JSON file

All levels are **pre-generated offline** and stored as static JSON so the game loads
instantly and every level is verified solvable before shipping. The game does **not**
generate puzzles at runtime (runtime generation risks unsolvable or slow loads).

- File: `vector-maze-levels.json` (loaded by `vector-maze.html`; may also be inlined as
  a fallback so the single file still runs from `file://`).

### 8.2 JSON schema

```jsonc
{
  "schemaVersion": 1,
  "levels": [
    {
      "id": 1,
      "name": "Level 1",
      "difficulty": "easy",          // easy | medium | hard | super-hard
      "lives": 3,
      "grid": { "cols": 10, "rows": 10 },
      "lines": [
        {
          "id": "L1",
          "points": [[2,3],[2,6],[5,6]], // grid vertices, orthogonal polyline
          "head": "end",                 // pointer at first ("start") or last ("end") vertex
          "dir": "R"                     // U|D|L|R, outward along final segment
        }
        // ... more lines
      ],
      "solution": ["L3","L1","L2"]       // one known valid removal order (for hints/verify)
    }
  ]
}
```

- Line `id`s are stable within a level (used by `solution` and hints).
- `solution` is **a** valid order, not necessarily unique or shortest.

---

## 9. Solvability Guarantee (the key requirement)

> **Every level must be provably solvable before it is added to the JSON.**

Two independent mechanisms, used together:

### 9.1 Reverse construction (generator) — solvable *by construction*

Removal happens one line at a time. A line is removable now iff its sweep is clear of all
**currently remaining** lines. Build the puzzle so a valid removal order is guaranteed:

1. Start with an empty board. `placed = []`.
2. To add the next line (which will be removed **before** every line already placed):
   a. Generate a candidate orthogonal polyline on the grid (random walk of a few bends),
      choose a head endpoint and set `dir` from its final segment.
   b. Compute the candidate's sweep in `dir`.
   c. Accept it only if (i) at rest it does not overlap any line in `placed`, and
      (ii) its sweep is **clear of every line in `placed`**.
   d. On accept, append to `placed`; otherwise retry with a new candidate.
3. Stop at the target line count for the difficulty (or after an attempt budget).
4. The removal order `reverse(placed)` is valid **by construction**: when the k-th line
   (counting from the end) is removed, exactly the lines placed before it remain, and its
   sweep was checked clear of precisely those.
5. Renumber/shuffle the `id`s so placement order is not a trivial giveaway to the player.

This guarantees at least one solution exists. Difficulty emerges naturally (many lines
are blocked until others move).

### 9.2 Independent verifier — solvable *by proof*

Regardless of how a level was produced, a separate solver double-checks it (defense in
depth, and it can be run in the game at load):

- Search states where a state = set of remaining lines.
- A move = remove any line whose sweep is clear of the other remaining lines.
- DFS/BFS with memoization (greedy-first, backtrack on dead ends). If a path empties the
  board, the level is solvable; record that path as `solution`.
- If a level fails verification, it is **rejected** and never shipped.

### 9.3 Difficulty metrics (for tagging levels)

Computed by the generator/verifier and used to bucket levels:

- Total line count and grid density.
- Number of lines removable on the very first move (fewer = harder).
- Average bends per line; branching factor of the solution search.
- Map roughly to `easy / medium / hard / super-hard` (cf. screenshot labels).

### 9.4 Tooling

- A small offline Node/JS script (`tools/`, not shipped to players) runs the generator +
  verifier and writes `vector-maze-levels.json`. The same geometry/collision code is
  shared with the game where practical to avoid drift.

---

## 10. UI / UX

Modeled on the screenshots:

- **Header:** level number / name, difficulty label, back button. (Palette & settings
  icons optional / future.)
- **Lives:** 3 droplet (or heart) icons that empty as lives are lost.
- **Progress:** percentage + star progress bar showing `removed / total`.
- **Hint (optional):** reveal the next line to remove from `solution` (may cost a
  resource / be limited). Future-friendly, not required for v1.
- **Overlays:** Level Clear (stars + Next), Game Over (Retry).
- **Theme:** dark background, light-grey idle lines, accent color for removed/cleared,
  red for invalid. Match the existing TronsGames dark aesthetic.

---

## 11. Input

- **Touch and mouse** both supported (the portal runs games in an iframe on mobile and
  desktop).
- Tap/click maps to canvas coordinates; the nearest line within a hit threshold is
  selected. Tapping empty space does nothing.
- Input is ignored while a line is animating or after the game ends.
- Prevent default touch scrolling/zoom on the canvas.

---

## 12. Technical Constraints

- **Single self-contained file** `vector-maze.html` (HTML/CSS/JS), consistent with the
  other games. Levels JSON may be a sibling file with an inlined fallback.
- Must run when opened directly (`file://`) and when served via the `index.html` portal
  iframe and GitHub Pages.
- Vanilla JS + Canvas 2D. No build step, no external runtime dependencies.
- Responsive: fits portrait phone screens; canvas scales while keeping aspect ratio.
- Reasonable performance for dense boards (hundreds of segments) at 60fps for a single
  animating line.

---

## 13. Out of Scope (v1)

- Procedural generation at runtime.
- Online features, accounts, leaderboards.
- Sound (could be a later enhancement).
- Level editor UI for players.

---

## 14. Decisions & Open Questions

**Resolved:**

- **Lives count:** **3** (matches screenshots; old prototype's 5 dropped).
- **Pointer direction:** **outward-along-final-segment only** for v1 (matches
  screenshots).
- **Initial level pack:** **~20 levels**, hand-curated difficulty curve from easy →
  hard. The generator may produce more candidates; we cherry-pick ~20 good ones.
- **Collision precision:** **exact geometry** — segment-vs-segment swept math for smooth,
  precise near-misses (§5).
- **Hints:** **deferred** — not in v1. (`solution` is still stored in the JSON for the
  verifier and future hint support.)

**Still open:**

- **Board sizes** per difficulty (grid `cols × rows`) — to be tuned while building the
  level pack.
- **Line thickness / clearance** value (affects how "tight" near-misses feel) — to be
  tuned during M1.

---

## 15. Suggested Milestones

1. **M0 — Requirements** (this document) ✅
2. **M1 — Engine prototype:** grid model, polyline rendering, tap-to-slide, sweep
   collision, win/lose, lives. Hand-authored tiny levels.
3. **M2 — Generator + verifier tool:** reverse construction + independent solver;
   emit `vector-maze-levels.json`; difficulty tagging.
4. **M3 — Level pack:** generate and verify a full set of levels across difficulties.
5. **M4 — Polish:** UI to match screenshots (progress, stars, overlays), persistence,
   mobile tuning; register in `index.html` portal.
