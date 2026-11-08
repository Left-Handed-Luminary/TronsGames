# Perspective illusion: reference

Extras that are not in `templates/street.html`. Each is written against the template's structure (`kit` helpers, the three passes in `drawSample`, the post shader), so it can be pasted in.

## Night variant

1. **Light.** Swap the sun for a cool, higher moon (`#9fb4ff`, elevation 50 to 60°) and darken `shadeTint` to about `(0.25, 0.28, 0.42)`. Keep the two-tone step: night still reads as lit versus shade.
2. **Emissive faces** (lit windows, sign panels, screens). Give them a separate material flag and keep them out of ink and shade:
   - In the lit pass, override them with `MeshBasicMaterial({ color: 0xff0000 })` instead of `litMat` (render the scene twice with `layers`, or swap materials by traversal for the emissive meshes only). Red = 1 and green = 0 marks "emissive" in `tLit`.
   - In the post shader: `bool glow = lit.r > 0.9 && lit.g < 0.1;` then skip two-tone, hatching and ink when `glow`, and output `alb * 1.6`.
   - Windows: paint a lit-window tile variant (warm `#ffd9a0` glass, curtain silhouettes) and pick lit or dark per window by a seeded hash, never by time.
3. **Glow.** Downsample the post output where `glow` is true (a 4-tap box blur at 1/4 size, twice), add it back at 0.6. It is screen-space, so it moves with the scene; keep its radius under 1.5% of the frame width, or it reads as haze.
4. **Wet ground.** For pixels with `nW.y > 0.9`, reflect the view ray (`reflect(dirW, vec3(0,1,0))`) and look up the post colour at the mirrored screen position of the reflected point (project `posW` mirrored in y with the current view-projection). Mix 30 to 45% where the sample is emissive, 10% elsewhere, and fade to zero within 8% of the screen border. Break it up with a world-anchored puddle mask (`fbm(posW.xz * 0.3)`), never screen noise.
5. **Haze line.** A thin warm band where the ground meets the far end: `mix(col, hazeColor, smoothstep(80., 220., distanceAlongZ) * 0.35)` using world z, not camera distance (camera distance changes during dolly zooms and the band would crawl).
6. **Rain.** Streaks are world-space line segments in a box around the focus point: positions `p = base + vec3(0, -mod(t * 9.0 + seed, 12.0), 0)` with 9 m/s fall speed and a 12 m cycle, so `LOOP_S * speed / cycle` must be a whole number (with 14 s, 9 m/s and 12 m give 10.5: use a 10.5 m cycle for 12 cycles, or 6 m/s with 12 m for 7). Draw them as one `LineSegments` in the `live` group, in the albedo pass only (light grey, alpha via colour), and exclude them from ink. Jitter AA in `render_fast` handles the sub-pixel width.
7. **Grade.** In the blit pass: lift blacks slightly (`col = col * 0.92 + 0.02`), push shadows toward blue, and add a gentle vignette. Do it in the blit shader, before the sRGB encode.

### Day look from a night scene

Swap the moon for a warm sun and raise the ambient tint; delete the point lights; remove wet ground, haze line and grade from the post shader; drop the rain; set every emissive flag to off; paint a day `skyAt`.

## Crowd of walkers

- **Bodies.** A walker is a group: legs (two boxes pivoting at the hip), torso (box), head (sphere), optional bag or umbrella. 1.55 to 1.85 m tall, flat colours from the palette, one accent garment in a few of them.
- **Motion.** Each walker is a pure function of `ms`: `phase = (ms / LOOP_MS) * laps + offset`; position along a path is `fract(phase)`. Pick `laps` as whole numbers so the loop closes. Stride angle `sin(phase * strides * 2π) * 0.45`, with `strides` a whole number per lap.
- **Wrapping.** A walker that reaches the path end reappears at the start. Put both ends out of frame or behind something, and time the wrap during the fastest camera move (use `window.probe` to find it).
- **Scale.** At 30+ walkers, use `InstancedMesh` per body part: one draw call each. They stay out of `mergeStatic`. Mark the shadow map dirty every frame they are visible (`renderer.shadowMap.needsUpdate = true`), or give them a fake contact shadow (a dark disc in the albedo pass, 2 cm above the ground, with ink disabled) and leave them out of the shadow map.
- **Crossing scenes.** A scramble crossing reads best with 3 to 4 streams on diagonals; in the flat view they become one dense band of people.

## Ad screens and signs

- **Signs.** Paint text with `tmat()` on a canvas, in a real font (`IPAGothic`, `Noto Sans CJK JP`, `Inter` as available) with made-up brand names. Vertical Japanese signs: one glyph per row (`paintVertSign`). Light-box signs at night are emissive (see above).
- **Screens.** A `CanvasTexture` redrawn from `ms` each sub-render (set `needsUpdate = true`). Content loops a whole number of times per loop: slides with hard cuts are safer than scrolling text, which can blink on the final. Keep screens out of ink.
- **Scale.** Screens on far facades are 6 to 12 m wide; at telephoto they stack with signs into one wall of colour, which is the point.

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
