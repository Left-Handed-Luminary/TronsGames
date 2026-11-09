# Perspective illusion: reference

Night, crowd and screen techniques. All of them are implemented in `templates/scramble_night.html`; the notes below say how each works and what to keep when porting it to another scene.

## Night variant

1. **Light.** A cool, high moon (`MOON`, elevation about 45°) still drives a two-tone step: lit faces get `litTint (0.55, 0.6, 0.85)`, shade gets `shadeTint (0.2, 0.22, 0.36)`. Night still reads as lit versus shade.
2. **Glowing faces** (lit windows, signs, screens, lamps, rain). The lit pass encodes two things: `g` = moon Lambert x shadow, `r - g` = glow.
   - A material declares glow with `userData.glow = 1` (the whole face, via `mat(color, 1)` or `tmat(..., { glowAll: true })`) or `userData.glowMap` (a mask: `tmat(..., { glowPaint })` paints a second canvas in the same layout, white = glows).
   - `litFor()` picks the lit-pass material: `MeshBasicMaterial` red for whole faces, `MeshLambertMaterial` white with red `emissive` + `emissiveMap` for masks, plain Lambert otherwise. `setPass()` swaps materials by traversal for each pass.
   - In the post shader, `glow > 0.5` skips two-tone, hatching and ink, and outputs `alb * glowGain`.
   - Windows: `windowTile()` decides lit or dark per window with a seeded rng and paints both canvases from the same layout, never by time.
3. **Bloom.** The post pass writes the glow amount to alpha. `bloomDown` takes `rgb * alpha` to quarter size, a separable 9-tap blur runs twice, and the accumulate pass adds it at 0.9. Keep the radius under about 1.5% of the frame width, or it reads as haze.
4. **Wet ground.** The camera is never tilted, so the mirror image of a point stays in its pixel column. For a ground pixel, march up the column (32 steps, quadratic spacing); at each sample rebuild the world height `Y` from depth and project its mirror (`-Y`). The first sample whose mirror lands at or below this pixel is the reflection. Mix it 32 to 77% (a world-anchored puddle mask `fbm(posW.xz * 0.35)`), full strength for glowing samples and 45% for the rest, and fade near the top of the screen. Never use screen-space noise for the puddles.
5. **Haze.** A low band toward the far end by world z (`smoothstep(-90, -210, posW.z)`) and world height, never camera distance (that changes during dolly zooms and the band would crawl).
6. **Rain.** 2,600 world-space `LineSegments` in a box round the crossing, glowing (so no ink), hidden in the normal pass. Fall 9 m/s in a 31.5 m column: 126 m per 14 s loop is exactly 4 columns, so the loop closes. In general `LOOP_S * speed / column` must be a whole number. Jitter AA in `render_fast` handles the sub-pixel width.
7. **Grade** (blit pass, before the sRGB encode): soft roll-off for bright glow, blue push in the shadows, lifted blacks. The vignette is in the accumulate pass.

### Day look from the night template

Swap `MOON` for a low warm sun and raise both tints; delete the haze, the reflections block and the grade; drop the rain; set every glow flag to 0 (keep masks off); paint a day `skyAt`.

## Crowd of walkers

- **Bodies.** Instanced parts (`InstancedMesh` per part: legs, torso, head, umbrella canopy and stick): one draw call each, about 90 walkers. Per-walker colours via `setColorAt`. Legs pivot at the hip; stride follows distance walked, not time, so feet never slide.
- **Motion.** Each walker covers `v * LOOP_S` metres along a straight line per loop: `s = s0 + v * ((t - WRAP_S) mod LOOP_S)`. Everyone wraps back at the same instant `WRAP_S`, chosen during the fastest camera move (found with `window.probe`), where motion blur hides it.
- **Passes.** The normal-pass `ShaderMaterial` applies `instanceMatrix` under `#ifdef USE_INSTANCING`; Lambert and Basic handle instancing themselves. Set `frustumCulled = false`, since instances move.
- **Shadows.** Walkers don't cast into the shadow map (it would need an update every frame); they receive it.
- **Crossing scenes.** Streams on all four crosswalks and both diagonals; in the flat view they pile into one dense band of umbrellas.

## Ad screens, signs and a train

- **Signs.** Text painted with `tmat()` on a canvas, in a real font (`IPAGothic`, `Noto Sans CJK JP`, `Inter` as available), with made-up brand names. Vertical signs: one glyph per row (`paintVertSign`). Glowing at night.
- **Screens.** Slides are painted once (`SLIDES`); a screen cuts between them `cuts` times per loop, where `cuts` is a multiple of the slide count so the loop closes. Hard cuts never blink; scrolling text can. A screen changes `mesh.userData.albedo` (the pass switcher restores it), and stays out of the static merge.
- **Train.** One pass per loop: 480 m per 14 s, wrapping at x = ±240, far outside every frame. Lit windows via a glow mask.
- **Scale.** Screens 8 to 14 m wide on the buildings facing the crossing; one on the end building low enough (`screenY`) to sit in the flat frame as its hero.

## Other scenes

| Scene | Long axis | Repeats | Swap objects | Corner-view reward |
|---|---|---|---|---|
| Supermarket aisle | Aisle along -z, shelves both sides | Shelf uprights, price rails, ceiling lights | Trolleys or baskets | Tops of shelves, the next aisle, stock boxes |
| Station platform | Platform edge along -z | Columns, benches, signs, ceiling beams | Commuters, bags | Tracks, the opposite platform, roof structure |
| Corridor or classroom wing | Corridor along -z | Doors, lockers, ceiling lights | Chairs, buckets | Rooms through doors, the courtyard |
| Park path | Path along -z | Trees, lamps, benches | Pigeons, cones, bikes | Pond, playground, the street behind the hedge |
| Rooftop | Rooftops along -z | Tanks, railings, antennas | Laundry, chairs | Streets below, the neighbouring roofs |

Scale tips: shelf 1.8 to 2.2 m, aisle 2.4 m, platform edge 1.1 m above the track, corridor 2.7 m ceiling, park lamp 4 m.

## Matching a reference clip

1. Pull frames: `ffmpeg -i ref.mp4 -vf fps=2 ref_%03d.png`.
2. Palette: k-means (k = 8 to 10) on all frame pixels, then drop near-duplicates; use the results as `P` entries.
3. Timing: note the time of each flat hold, dolly zoom and corner view; make those the key times, then scale with `timeScale` to your loop length.
4. Copy the technique only. Build your own place, characters, brands and text.
