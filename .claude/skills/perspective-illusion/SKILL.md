---
name: perspective-illusion
description: Make a looping illustrated 3D video in the Japanese perspective-illusion style (e.g. @garments__) of any place, such as a street, crossing, station, shop aisle, room, park or rooftop. A clean line-art scene squashed flat by a telephoto lens opens into deep perspective with dolly zooms, swings round to corner views that first read flat and then turn 3D, and objects quietly swap depth while the view is flat. Use when asked for a perspective or optical-illusion video, a "dolly zoom" or "flat to 3D" loop, an isometric-looking illustrated scene that turns out to be 3D, or to recreate one of these clips.
---

# Perspective illusion

## The style, in one paragraph

A level camera on a very long lens (about 2° from 400 to 900 m away) flattens a deep scene into what looks like a flat drawing. Then it dolly-zooms: the lens widens while the camera moves in, so the subject stays the same size but the space behind it stretches open. The camera also swings round to corner views. Each one starts flat and opens into 3D. While the view is flat, objects slide in depth where nobody can see it, so when the depth comes back, a row has become a diagonal. Everything is drawn as clean ink line art with flat two-tone shading, hatched cast shadows and a painted sky, and the whole thing loops seamlessly.

## What ships with this skill

```
perspective-illusion/
  SKILL.md, reference.md
  templates/
    street.html        day side street, red evening sky, all renderer hooks   <- start here
    lib/camera.js      shot -> camera math, monotone timeline, jitter/blur sampling (pure JS)
    lib/harness.mjs    static server + headless Chromium + ffmpeg pipe
    render.mjs         stills (8x AA) and quick 1-sample drafts
    render_fast.mjs    finals: GPU-averaged jitter AA + probe-sized motion blur
  scripts/
    motion_check.py    freezes, stutter, loop seam
    blink_map.py       one-frame flicker in still frames, with a heat map
    frames.py          shared ffmpeg reader / PNG writer
  tests/               node --test tests/*.test.mjs ; python3 -m unittest discover -s tests
```

## Quick start

`SKILL` below is this skill's folder (for example `.claude/skills/perspective-illusion` in the repo).

```
mkdir -p edits/<date>-<name> && cd $_
printf '{"type":"module"}' > package.json && npm i three@0.170.0
cp -r $SKILL/templates/* .
cp street.html scene.html                                         # then edit the scene section
node render.mjs scene.html x --stills=0.3,2.8,4.9,6.7,9.1,10.4,12.0,12.8   # stills/ (add --scale=.5 to go faster)
node render_fast.mjs scene.html preview.mp4 --preview             # whole loop, half size, 30 fps
node render_fast.mjs scene.html final.mp4                         # full size, 60 fps, up to 32 samples/frame
python3 $SKILL/scripts/motion_check.py final.mp4
python3 $SKILL/scripts/blink_map.py ffmpeg final.mp4 blink.png
```

Playwright is loaded from the project, `NODE_PATH`, or a preinstalled copy; install it (`npm i playwright && npx playwright install chromium`) only if none exists. Set `CHROMIUM_PATH` to use a specific browser and `FFMPEG` if ffmpeg isn't on the PATH. Without a GPU, Chromium falls back to SwiftShader: a half-size still takes about 2 s, a 14 s preview a few minutes, a full final much longer, so fix things on stills and previews and render the final once.

## Templates

Start from the template closest to the new scene. Keep its camera rig, timeline, post pass and render hooks, and replace only the scene section (everything between `// ---------- kit` and `// ---------- cameras`; the kit helpers are reusable as they are).

| Template | Scene | Renderer |
|---|---|---|
| `street.html` | Day side street: shops, sign towers, poles and wires, a parked car, a side street, five swap cones, coral sky. | `render_fast.mjs` |

New templates (a supermarket aisle, a night crossing in the rain with a crowd and screens) are built the same way: copy `street.html`, replace the scene section, then add the extras in [reference.md](reference.md). Add a row here when one is committed.

## Step 1: Build a scene that can fool the eye

Any place works if it has these:

- **One long axis.** Lay the scene out along -z (a street, an aisle, a platform, a corridor), with the camera looking down it. Depth along this axis is what the telephoto hides.
- **Repeated things at different depths.** Poles, lamps, shelves, columns, signs, trees, people. On a long lens they stack into one plane. Lined-up poles merge into one, and sign stacks on far facades pile into one wall. Turn signs to face the camera (+z) so they stack.
- **Swap objects.** 3 to 6 similar objects (cones, people, bins, chairs, boxes) whose arrangement changes between a row and a diagonal (`lay`). `cs` scales them, for a flat-view size that reads right.
- **Real-world scale in metres.** The lenses and focus planes only make sense at true scale: a 0.75 m cone, 1.7 m people, a 3.2 m storey.
- **Detail where the corner views look.** Every corner view reveals building sides, the backs of objects, rooftops and the ground. Fill them: side windows, drains, cables, kerbs, water tanks, railings. Flat views hide sloppiness and corner views expose it.
- **Make every detail part of one surface** (paint markings into the ground texture, stack sleeves along a cylinder), or keep separate parallel surfaces clearly apart. From 400 m away, surfaces a few centimetres apart flicker.
- **Frame the flat shot inside the canyon.** If `W` is wider than facade-to-facade, the end walls of the nearest buildings fill the frame edges. `street.html` uses `W` 15 for a 14 m street, with `y = W*9/32` so the ground sits on the bottom edge.

## Step 2: Choreograph the camera

The camera is never tilted. It stays level so verticals stay vertical, like an architect's drawing. Each shot is a plain object:

`{ x, y, zf, W, fov, H, el, yaw, lay, cs }`

| Key | Meaning |
|---|---|
| `x`, `y` | Focus point side position and height (m); the camera sits level with it when `el` is 0. |
| `zf`, `W` | The focus plane, and the width framed there (m). Keeping `W` while changing `fov` is the dolly zoom. |
| `fov` | Horizontal lens angle. About 2° is flat, 25 to 90° is deep. |
| `H` | Lens shift: where the focus point sits vertically (-1 bottom, 0 middle, 1 top). |
| `el` | Look down by raising the camera and shifting the lens, never by tilting. The horizon rises by `tan(el)/tanV`. |
| `yaw` | Swing round the focus point for corner views. |
| `lay`, `cs` | Swap-object layout (0 row, 1 diagonal) and their scale. |

`lib/camera.js` turns a shot into a camera (`cameraFromShot`), an off-axis projection matrix (`projectionMatrix`, lens shift in `elements[8]`/`[9]`), and screen positions (`projectPoint`). The unit tests pin the invariants: the focus point always lands at NDC `(0, H)`, the focus plane always spans `W`, and verticals stay vertical.

Shot vocabulary that works:

| Shot | Settings |
|---|---|
| Flat | `fov` about 2, `H` 0. The whole scene reads as one elevation. |
| Worm's eye | Knee height, `fov` 80 to 90, horizon pushed low (`H` about -0.65). |
| High | `el` 30 to 40 on a medium lens; the horizon goes above the frame. |
| Corner view | `yaw` ±18 to 35°, `el` 35 to 50°. It comes as a pair: a telephoto version (`fov` 4) first, then the same view wide (`fov` 25 to 45). |
| Diagonal and low | Medium lenses that show the swap objects in depth. |

**Corner views must clear the roofs.** The sight line from camera to focus crosses the facade line at horizontal distance `facadeX / sin|yaw|` from the focus, at height `y + that * tan(el)`. That height must exceed the roofs on that side, or the shot is a close-up of a wall. Steeper `el` and smaller `yaw` fix it.

**Loop structure.** Flat, then a deep view, then a corner view (flat then 3D), back to flat (swap the objects here), a high diagonal, the other corner view, a low shot, then flat again (swap back). The loop ends on the shot it starts on; `makeTimeline` refuses a broken seam.

**Timing.** All parameters run through one monotone cubic (Fritsch-Carlson) curve over the key times, so speed never jumps and equal neighbouring keys are dead-still holds. `W` and `fov` interpolate in log space. Keys may omit parameters (they inherit from the previous key). Add tiny drift shots (`drift(shot, t)`, `W` × 0.96) so holds breathe instead of freezing. 12 to 14 s feels smooth, while 7 s feels rushed. To change the length, pass `timeScale` rather than rewriting the keys.

**Cheat while flat.** Only change `lay` between two flat keys. If the camera is moving in depth while objects move, the trick shows.

The first corner view should go to the side that the hero object (a car, a sign) does not cover. That way the reveal shows something new.

## Step 3: The look

The page renders three passes per sub-render: flat colour (`MeshBasicMaterial`, no lighting), view normals with linear depth (alpha 0 = sky), and a sun-only Lambert-times-shadow mask. One post shader composes them.

- **Two-tone shading.** N·L comes from the normal pass; the shadow factor is `mask / N·L`. A face is lit when it faces the sun and the factor is above 0.5, otherwise it gets `albedo × shadeTint`. No gradients. The mask light has intensity `PI`, because three.js divides Lambert by pi; with the default 1 everything reads as shade.
- **Hatch only cast shadows** (faces toward the sun that are shadowed), with hatching anchored in world space (never screen space) and faded by `fwidth` so dense hatching melts into flat shade.
- **Ink lines** from depth (positive second difference of 1/z, so planes give zero and only the near side of a step is inked: no double lines), normals, and flat colour. Lines are heavier up close. Ground markings get thin grey lines. Colour lines fade out where one pixel covers more than a few centimetres, or far textures turn to noise.
- **Paint the sky by view direction,** not screen position, so clouds stay put as the camera moves. Keep cloud edges soft.
- **Palette.** 6 to 10 flat colours plus one accent (the coral sky in `street.html`). To match a reference, take the colours from its frames with k-means.
- **Light.** One low, hard sun placed so the main subjects stay lit and throw long shadows across the ground. A sun from the tall side buries the scene in one big shadow: in `street.html` the tall buildings are on the left and the sun comes from behind-right.

For a night variant (moonlight, lit windows, wet reflections, glow, rain, grade), a crowd of walkers, or ad screens and signs, see [reference.md](reference.md).

## Step 4: Detail passes (what makes it great)

First versions always look empty. Great versions come from deliberate passes, each checked on stills before the next one starts.

1. **Forms.** Main masses at true scale, the long axis, the swap objects, and the camera timeline. Check that the flat shot really reads flat, and that every move reveals something.
2. **Structure.** Everything a real place has, built from real-world logic. For a street, that means kerbs, drains, manholes, poles with their arms and boxes, signs on both faces, fences, bins, vending machines, bike racks, overhead wires, and window frames with sills and AC units. List what is there before building.
3. **Wear and story.** Small things that make it lived-in: stickers, tape, posters with code-drawn text, puddle stains, a bicycle left leaning, laundry, a cat, a coffee cup. Aim for 3 or more per surface the camera lingers on.
4. **Corner-view audit.** For each corner view, render the wide still and fill whatever looks bare there. Usually that is building sides, the backs of signs, rooftops (tanks, railings, antennas) and the ground between objects.
5. **Light and shadow.** Make sure every object casts a readable shadow, and get the shadow side of every main form into the two-tone step. Shadows that only appear in one view are a reward for the camera move.
6. **Life (optional).** Walkers, a train or cars moving at constant speed, screens, birds, flags. Everything loops a whole number of times.
7. **Polish.** Palette harmony, line weight, sky, vignette and grade. Then the blinking check on the final.

Density rule: from the flat telephoto shot, the frame should feel full edge to edge, like a dense illustration, with no large empty wall or ground area unless it is a deliberate rest for the eye.

## The quality bar

Before any full render, check stills at every key time (and halfway between moves) against this list. Fix anything that fails, then check again.

- [ ] The flat shot reads as a flat drawing. Nothing gives away the depth.
- [ ] Every move ends on a reveal: a hidden diagonal, a side street, objects that were far apart.
- [ ] Corner views start flat and open up, clear the roofs, and the first one turns away from the hero object.
- [ ] Lines are crisp and even, with no double lines, no ink on glowing faces, and no noise on far textures.
- [ ] Two-tone shading is clear on every main form, and hatching appears only in cast shadows.
- [ ] Nothing reads as a bare primitive. Every box has trim, seams, a base or a label.
- [ ] Text is legible, the right way up, sized to fit its surface, in real fonts, with made-up brands.
- [ ] The sky matches the light direction and colour of the scene.
- [ ] The palette is limited and harmonious, with one clear accent.
- [ ] The loop seam is invisible and nothing pops (`motion_check.py` reports the seam).
- [ ] The preview has no stutter. On the final, the `blink_map` count is low, and what blinks is intended motion (rain, screens).

When reviewing stills, look at them like an illustrator: name the three weakest areas of each frame, fix those, and repeat. Don't stop at "it works".

## Step 5: Render and check

- **`render_fast.mjs`** renders each frame on the GPU as an average of jittered sub-renders: 4 for anti-aliasing, and up to 32 on fast moves for gapless motion blur, sized by how far `window.probe` points move on screen during the shutter. `--preview` is half size, 30 fps, at most 4 samples. Also `--fps`, `--scale`, `--from`/`--to` (seconds), `--shutter` and `--max`. Frames cover `[0, loop)`: the seam frame is not rendered twice.
- **`render.mjs`** writes stills (`--stills=t1,t2`, 8 samples each) and quick drafts (one sample per frame: timing checks only, never finals). It also works with pages that only have `render(ms)`.
- **Merge static meshes by material at load** (`mergeStatic` in the template, using `mergeGeometries`). Keep anything that moves out of the merge (the template's `live` group). The shadow map updates only when a moving object changes.
- **Check the final** with `motion_check.py` (freezes, stutter, seam; exit code 1 on problems) and `blink_map.py` (pixels that flash for one frame in nearly still frames, with a heat map). Compare the count before and after a change. Previews shimmer by design, so judge blinking on the final only.

### The page contract

Any scene page works with the renderers if it provides:

| Hook | What it does |
|---|---|
| `#frame` | The canvas that gets screenshotted (`preserveDrawingBuffer: true`). |
| `window.READY` | Set once assets and fonts are loaded. |
| `window.LOOP_MS` | Loop length in milliseconds. |
| `window.render(ms)` | Draws the frame at time `ms`. |
| `window.probe(ms)` | Returns screen positions of a few world points, used to size the motion blur. |
| `window.setJitter(x, y)` | Extra sub-pixel lens offset in pixels (added to `projectionMatrix.elements[8]`/`[9]`). |
| `window.renderMany([[ms, jx, jy], ...])` | Averages several renders in one call (needed for `render_fast`). |
| `?scale=.5` | Renders at half size. |

Everything animated must be a pure function of `ms`, periodic in the loop length. Use whole numbers of cycles per loop for steps, crawls and rain.

## Blinking and glitches

| Cause | Fix |
|---|---|
| Anything in screen space (wobble, hatching, noise, haze by camera distance) | Anchor it to the world or to view direction. |
| Surfaces a few cm apart | Merge them into one surface, or keep them clearly apart. |
| Overlapping coplanar planes (road markings, floor pieces) | Paint markings onto one plane, and make pieces meet edge to edge. |
| Sub-pixel detail (rails, grids, cables, rain) | Jitter anti-aliasing on every frame, and fade dense lines by metres per pixel. |
| One render per frame | Never do this in finals. |
| Hard edges on clouds or reflections | Soften them, and fade effects at screen borders. |
| Moving things that wrap or pop | Wrap them during the fastest camera move of the loop, found with `window.probe`. |

## Pitfalls

- A `//` comment added to one-line code swallows the rest of the line (a `scene.add`, a light). Use `/* */`.
- Helpers that add to the scene root ignore the current group, and can land on top of things. Build inside groups (every kit helper takes the group first).
- Single-sided quads only cast shadows if their material has `shadowSide = DoubleSide` (the kit's `mat()`/`tmat()` set it).
- Keep emissive faces (screens, sign panels) out of the flat-colour and shadow passes, or every glyph gets inked and darkened (see reference.md).
- `ffmpeg -stream_loop ... -c copy` makes loops that some players stop early. Re-encode instead.
- For X, side-by-sides at 32:9 are too wide to upload. Stack them vertically.
- Use original characters and made-up brands only. Copy the technique of a reference, never its artwork.
