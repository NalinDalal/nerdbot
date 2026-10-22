# The bot engine

This folder is a port of **[bloub](https://github.com/jeremy-prt/bloub)** by
jeremy-prt — *an SVG recreation of the x.ai bot avatar: one filled shape
morphing through 14 states, two white shapes for the eyes that morph
independently*.

MIT licensed. The original project is not affiliated with, endorsed by or
connected to x.ai; it recreates the visual behaviour of their bot avatar as
an exercise, and "Grok" and "x.ai" belong to their owners. The MIT licence
covers the code in that repository, not the design it imitates — the same
holds here.

## What came from where

| File | What it is |
| --- | --- |
| `math.ts` | Numeric helpers: clamping, easings, periodic noise, the PRNG. |
| `profiles.ts` | Radial profiles measured pixel by pixel off the reference video. |
| `shape.ts` | The silhouette model: radial profiles, blending, path generation. |
| `eyes.ts` | The eyes painted on a sphere, the life at rest, the blinks. |
| `skins.ts` | The eight customiser shapes and the twelve colours. |
| `expressions.ts` | The sixteen resting expressions. |
| `states.ts` | The fourteen animated states and their poses. |
| `decor.ts` | The orbit rings, the particles, the comet, the notification pip. |
| `eyefit.ts` | Where the face sits on a customiser shape. |
| `engine.ts` | The clock-free engine: `sample(t)` is a pure function of time. |
| `repere.ts` | The reference frame everything is measured in. |
| `gaze.ts` | Where the bot looks when it follows the pointer. |
| `face.ts` | **Ours**: the face as a choice — the three ids, the labels, the plate, the random draw. |
| `BotAvatar.tsx` | **Ours**: the React component that draws the engine's frames. |
| `FacePicker.tsx` | **Ours**: the picker the owner uses to choose a face. |
| `ticker.ts` | **Ours**: the one animation loop every animated face shares. |
| `status.ts` | **Ours**: which pose a status earns, and what a bot is doing now. |

## What changed in the port

Three deliberate changes, and one that was a bug in the transcription:

1. **The comments are in English.** The upstream code comments are in French;
   the rest of this repository is in English, so the reasoning was carried
   over rather than the wording.

2. **The offset table is built lazily.** Upstream builds the whole table of
   eye offsets at import time — about three hundred entries, each of them a
   small geometric search. That is fine for an app that draws one avatar,
   and it is not fine for a dashboard that may draw a page of them. Here each
   entry is computed the first time it is asked for and then kept, so the
   numbers are the same and the import is free. `eyefit.ts` documents it.

3. **`face.ts` is upstream's `face.ts` renamed to `eyes.ts`.** Upstream's
   file is about the eyes and the gaze; the name was taken by the face
   descriptor, which is ours.

4. The `eyefit.ts` transcription had `e.d * sp` where upstream has
   `e.d * cp` in the eye's own tilt. The upstream test suite caught it: the
   eyes no longer fitted inside the narrow shapes. It is the reason
   `faces.test.ts` is a faithful port of upstream's `skins.test.ts` rather
   than a new set of assertions.

## The tests

`faces.test.ts` is upstream's `src/bot/skins.test.ts`, ported. It measures
the RENDERED geometry — the body's outline and each eye capsule's outline,
read back as the component draws them — and not the computation, so it
assumes nothing about the method.

The heavy one ("lets no shape let an eye out of the silhouette") sweeps 680
combinations of state, shape and expression over three seconds of time. It
takes a few seconds and it is the only test that proves what the eye sees.

The rest are ours: `ticker.test.ts` drives the shared loop a frame at a time
through an injected scheduler, `status.test.ts` pins the status-to-pose
mapping and the activity priority, and `random-face.test.ts` makes sure
"Surprise me" never appears to do nothing. `src/motion.test.ts` covers the
reduced-motion read; the component uses it to turn `animated` into a still.
