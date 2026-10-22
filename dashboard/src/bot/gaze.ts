import type { Look } from "./engine";
import type { ExpressionId } from "./expressions";
import { clamp, easings } from "./math";

/**
 * Where the bot looks when it follows the pointer.
 *
 * Ported from `bloub` (MIT, jeremy-prt/bloub). Pure: the pointer position
 * enters as already-normalised coordinates, so the rule can be tested without
 * a DOM — and it has to be, because two signs in it are easy to get wrong.
 */

/**
 * Head angles in degrees. CHOSEN, not measured: the reference video shows no
 * pointer tracking. Wide enough to be told apart from the rest drift (+-7deg
 * of yaw, +-5.5 of pitch), restrained enough that no eye goes behind the
 * limb of the sphere.
 */
export const YAW_MAX = 16;
export const PITCH_MAX = 13;

/**
 * Height the gaze rests at, with the pointer in the centre. CHOSEN: slightly
 * above the equator, which gives an attentive bot rather than an absent one.
 *
 * This is an ABSOLUTE value, and that is the point: in relative terms the
 * eye height followed that of each expression, and since "neutral" looks at
 * +28.6deg while the moods sit between -9 and +9, the eyes dropped in one
 * step on the first mood change.
 */
export const PITCH = 10;

/**
 * Direction the head takes in the view: the bot stops looking up and to the
 * right (its resting pose) to look to the LEFT, towards the panel.
 *
 * It is not a mirror of the image: the eyes really travel around the sphere,
 * so they keep their `\\` tilt and their depth compression. Flipping the
 * image would have laid them down as `//`.
 */
export const TURN = 26;

/**
 * A full turn travelled ON THE WAY: the eyes do not slide across the face,
 * they travel around the ball before arriving.
 *
 * It is free because the eyes live on a sphere: at 90deg of yaw they cross
 * the limb, the engine removes them from the image, and they reappear on the
 * other side. The swirl is therefore not an effect laid on top, it is the
 * same orthographic projection pushed one turn further.
 *
 * And above all it LANDS BY CONSTRUCTION, `-360deg` being the same angle as
 * `0`. That is what separates it from a gaze pose written into a state, which
 * leaves the eyes wherever its curve ends.
 */
export const SPIN = 360;

/** Duration of the turn. */
export const TURN_TIME = 1.1;

/**
 * A SCRIPTED gaze: evaluated on every frame with the time elapsed since the
 * start of the arrival, in seconds. The script therefore carries its own
 * clock and can chain several movements — the component only evaluates it
 * and has no duration to know about.
 *
 * The RULE, and it is what makes a script maintenance-free: it must FINISH
 * at `mix: 0`, so the state's pose is the only thing in charge. There is
 * then never anything to release, and that release — which would show up as a
 * last slide of the eyes, right when everything should be settled — does not
 * exist.
 */
export type GazeScript = (t: number) => Look;

export interface Aim {
  /** horizontal offset of the pointer from the centre of the bot, -1 to 1 (right positive) */
  nx: number;
  /** vertical offset, in screen direction (down positive) */
  ny: number;
  /** progress of the arrival, 0 to 1 */
  tour: number;
  /** false = no known pointer: the head stays turned but comes back to life */
  pointer: boolean;
}

/**
 * The gaze target.
 *
 * `tour` leads: it raises the grip on the pose (`mix`) and melts the travel
 * (`spin`) away at the same time. At 0 the state's pose is in charge alone;
 * at 1 the head is set to the left and follows the pointer.
 *
 * Nothing here compensates for the displayed expression: that is the
 * engine's mix, because only it knows the pose at time t. Doing it here
 * would mean reading the expression's ARRIVAL yaw while the engine is still
 * morphing — and the eyes would jump on every mood change.
 */
export function lookTarget({ nx, ny, tour, pointer }: Aim): Look {
  return {
    yaw: -TURN + nx * YAW_MAX,
    // positive pitch = looking up, while the screen's y goes down
    pitch: PITCH - ny * PITCH_MAX,
    mix: tour,
    spin: SPIN * (1 - tour),
    // Without a pointer the head stays turned towards the panel, but it is
    // given back its drift: otherwise the bot fixes a dead point, and
    // arriving by keyboard or on touch gave a completely motionless avatar.
    wander: pointer ? 0 : 1,
  };
}

/** Kept for parity with upstream, where the arrival scripts lived. */
export const TOUR_TIME = 1.5;

/** The arrival turn: the ball looks like it is spinning on itself. */
export const tourLook: GazeScript = (t) => ({
  yaw: 0,
  pitch: 0,
  mix: 0,
  spin: SPIN * (1 - easings.easeInOutCubic(clamp(t / TOUR_TIME))),
  wander: 1,
});

/** The moods the bot goes through while it follows the pointer. */
export const HUMEURS: readonly ExpressionId[] = [
  "surpris",
  "heureux",
  "hilare",
  "excite",
  "fier",
  "blase",
];
