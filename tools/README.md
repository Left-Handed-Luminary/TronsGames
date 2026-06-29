# Vector Maze — level tools (M2)

Offline tooling that generates **provably solvable** Vector Maze levels and
writes them to a JSON pack the game loads. Nothing here ships to players; it is
build-time tooling. See `../vector-maze-requirements.md` (§8, §9) for the spec.

## Files

| File | Purpose |
|---|---|
| `engine-core.mjs` | Canonical geometry + collision + DFS solver. **Mirrors the collision math inlined in `vector-maze.html`** so "verified solvable" offline matches the running game. |
| `generate-levels.mjs` | Reverse-construction generator + independent verifier + difficulty tagging. Emits the levels JSON. |
| `test-core.mjs` | Sanity tests for the snake head-ray collision model. |

## Movement model (snake)

A line peels off **head-first like Snake**: the head moves in its pointer direction and
the body follows the line's own path, then off a straight ray continuing past the head
endpoint. Since the body only retraces its own footprint, the only thing that can block
removal is the **head ray** — the straight ray from the head endpoint to the board edge.
A line is removable iff that ray is clear of every other line.

## Shaped levels

The harder tiers confine lines to a centred **shape mask** (`heart`, `star`, `smiley`,
`apple`, `diamond`) so the maze reads as a symbol/fruit/emoticon. The mask only constrains
candidate generation — every vertex and segment must stay inside the shape — while the
empty margin lets head-rays exit. Masks live in `MASKS` (math/polygon predicates over
normalized grid coords); shaped tiers are flagged `shaped:true` in `PRESETS` and cycle
through the shapes. Each emitted shaped level carries a `"shape"` field.

## Why levels are always solvable

**Reverse construction.** A line is removable when its head ray is clear of all *remaining*
lines. We build each puzzle in reverse-removal order: place line 1, then place line 2 so
its head ray is clear of line 1, then line 3 clear of {1,2}, and so on. Removing them in
the reverse of placement order is therefore valid *by construction* — no search required
to guarantee a solution exists.

**Greedy difficulty.** At each step the generator tries several valid candidates
and keeps the one that *blocks* the most currently-removable lines (crosses their
head rays). Blocking is safe (the blocker is removed first in reverse order) and it
forces the player to discover the order — turning a merely-solvable board into a real
puzzle. A quality gate then rejects boards where too many lines are free on the first
move.

**Independent verification.** Every emitted level is re-checked by a separate DFS
solver (`solveOrder`) and a rest-overlap check before being written. Any level that
fails is discarded. The same solver runs in-game on load as a final guard.

## Usage

```bash
# Default curated 20-level pack (4 easy, 5 medium, 5 hard, 4 super-hard, 2 dense)
node tools/generate-levels.mjs

# Reproducible custom pack
node tools/generate-levels.mjs --seed 42 --easy 6 --medium 8 --hard 4 --superhard 2 \
     --out vector-maze-levels.json

# Keep per-level _meta (line count, free-at-start, construction order) for inspection
node tools/generate-levels.mjs --meta --out sample.json

# Run the parity/sanity tests
node tools/test-core.mjs

node tools/generate-levels.mjs --help   # all flags
```

The same `--seed` always produces the same pack, so packs are reproducible.

## Output schema

```jsonc
{
  "schemaVersion": 1,
  "generator": { "seed": 1, "createdWith": "tools/generate-levels.mjs" },
  "levels": [
    {
      "id": 1,
      "name": "Level 1",
      "difficulty": "easy",        // easy | medium | hard | superhard
      "lives": 3,
      "grid": { "cols": 8, "rows": 8 },
      "lines": [
        { "id": "L1", "points": [[2,3],[2,6],[5,6]], "head": "end", "dir": "R" }
      ],
      "solution": ["L3","L1","L2"] // one verified removal order
    }
  ]
}
```

## Keeping the engine in sync

`engine-core.mjs` is the source of truth for collision constants (`CANVAS`, `PAD`,
`W`, `CLR`) and the `contactT` / `canRemove` math. The game inlines an identical
copy. If you change one, change the other (and re-run `test-core.mjs`). M4 will wire
`vector-maze.html` to consume the generated JSON directly.
