import { clamp, createRng, loopNoise } from "./math";

/**
 * The eyes are painted on a sphere, not laid flat.
 *
 * Measured on the reference video: the eye closest to the edge is 0.69 times
 * the width of the other, and 0.663 times its area — exactly the depth
 * factor (z = 0.669) of a point on a sphere at that distance from the
 * centre. So a real head orientation is modelled: each eye takes the
 * tangent frame of the sphere and projects it orthographically. The
 * compression and the tilt both fall out of that, which is what gives the
 * face its volume.
 *
 * Ported from `bloub` (MIT, jeremy-prt/bloub), where this file is called
 * `face.ts`.
 */

type Vec3 = [number, number, number];

/** Half-separation of the eyes on the sphere, in degrees (total ~31deg). */
export const EYE_SPLIT = 15.46;
/** Size of the resting eye, in units of the ball radius. */
export const EYE_W = 0.186;
export const EYE_H = 0.412;

/** Resting head orientation, fitted on the reference frames. */
export const REST_GAZE: HeadGaze = { yaw: 28.49, pitch: 28.62, roll: -13 };

export interface EyePose {
  x: number;
  y: number;
  /** 2x2 tangent matrix: [a b c d], in SVG matrix(a,b,c,d,e,f) order */
  a: number;
  b: number;
  c: number;
  d: number;
  /** z component of the normal: > 0 = the face is visible */
  depth: number;
}

export interface HeadGaze {
  /** yaw, degrees, positive = looking right */
  yaw: number;
  /** pitch, degrees, positive = looking up */
  pitch: number;
  /** roll, degrees, the head's tilt */
  roll: number;
}

const deg = (d: number) => (d * Math.PI) / 180;

/** Rotates two vectors of an orthonormal frame in their common plane. */
function spin(u: Vec3, v: Vec3, angle: number): [Vec3, Vec3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

/**
 * Frame of the head, then of the two eyes.
 * Screen frame: x right, y down, z towards the viewer.
 * Index 0 is the inner eye, index 1 the outer one.
 */
export function eyePoses(gaze: HeadGaze, scale: number, split = EYE_SPLIT): [EyePose, EyePose] {
  let f: Vec3 = [0, 0, 1];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];

  // yaw: forward tips towards right
  [f, right] = spin(f, right, deg(gaze.yaw));
  // pitch: forward tips upwards (so away from down)
  [down, f] = spin(down, f, deg(gaze.pitch));
  // roll: the head leans within its own plane
  [right, down] = spin(right, down, deg(gaze.roll));

  const build = (side: number): EyePose => {
    const [ef, er] = spin(f, right, deg(split * side));
    return {
      x: ef[0] * scale,
      y: ef[1] * scale,
      a: er[0],
      b: er[1],
      c: down[0],
      d: down[1],
      depth: ef[2],
    };
  };

  return [build(-1), build(1)];
}

/**
 * Life at rest: slow gaze drift, saccades, blinks.
 *
 * A pure function of time (no internal state), so pausing, resuming and
 * jumping to an arbitrary date always give the same image. The values are
 * OFFSETS to add to the current state's pose.
 */
export interface Liveliness {
  dYaw: number;
  dPitch: number;
  dRoll: number;
  /** 1 = eye open, 0 = closed (vertical squash in screen space) */
  lid: number;
  driftX: number;
  driftY: number;
  breath: number;
}

const BLINK_RNG = createRng(0x5eed);
/** Pre-drawn blink schedule: deterministic and stateless. */
const BLINKS: number[] = (() => {
  const out: number[] = [];
  let t = 1.4;
  while (t < 900) {
    out.push(t);
    // 1.9 to 4.6 s between blinks, with an occasional double blink
    t += 1.9 + BLINK_RNG() * 2.7;
    if (BLINK_RNG() < 0.18) {
      out.push(t);
      t += 0.24;
    }
  }
  return out;
})();

/** Measured: 1 to 2 frames at 10 fps. */
const BLINK_DUR = 0.18;

function blinkLid(t: number): number {
  for (let i = 0; i < BLINKS.length; i++) {
    const start = BLINKS[i]!;
    if (t < start) break;
    const k = (t - start) / BLINK_DUR;
    if (k >= 0 && k <= 1) {
      // fast close, slightly slower reopen
      return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
    }
  }
  return 1;
}

export interface LivelinessOptions {
  wander?: number;
  blink?: boolean;
  float?: boolean;
}

export function liveliness(t: number, opt: LivelinessOptions = {}): Liveliness {
  const { wander = 1, blink = true, float = true } = opt;

  // Mutually prime periods: the drift never looks like it repeats.
  return {
    dYaw: (loopNoise(t, 11.3, 0.4) * 5.5 + loopNoise(t, 3.7, 2.1) * 1.6) * wander,
    dPitch: (loopNoise(t, 9.1, 1.3) * 4.2 + loopNoise(t, 4.3, 0.7) * 1.3) * wander,
    dRoll: loopNoise(t, 13.7, 3.2) * 2.2 * wander,
    lid: blink ? blinkLid(t) : 1,
    // At rest the reference video is almost motionless (centre stable to
    // +-0.003, radius constant): all the life is in the gaze and the blinks.
    // Just enough to keep the image from freezing completely.
    driftX: float ? loopNoise(t, 7.9, 1.9) * 0.006 : 0,
    driftY: float ? loopNoise(t, 5.3, 0.3) * 0.007 : 0,
    // The width is constant, only the height breathes very slightly.
    breath: float ? 1 + Math.sin((t / 3.4) * Math.PI * 2) * 0.005 : 1,
  };
}

/**
 * A blink is a VERTICAL squash in screen space around the centre of the eye
 * (measured: the bounding box keeps its width, the height falls to ~0.35),
 * not a narrowing along the tilted axis of the capsule. It is therefore
 * composed after the tangent matrix, touching only the y outputs.
 */
export function blinkScale(lid: number): number {
  return 0.06 + 0.94 * clamp(lid);
}
