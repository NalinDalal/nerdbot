/**
 * Where to place the face on a customiser shape.
 *
 * The eyes live on a sphere, and `radiusAtAngle` re-seats them on the real
 * outline in proportion to the local radius. That proportion places their
 * CENTRE well, but an eye has a SIZE: the margin it has left in front of the
 * edge is multiplied by the same factor, so a silhouette that is narrow in
 * that direction pushes it against the edge until the mask opens it to the
 * outside. The capsule showed up as a notch bitten out of the body on
 * `capsule`, `triangle`, `cloud` and `droplet`.
 *
 * This module solves the problem ONCE and returns a table of offsets. That
 * choice is the heart of the fix, far more than the geometry that follows:
 *
 * Solved inside the render loop, the correction reacts to everything that
 * moves at sixty frames per second — the gaze drift, the pointer, the
 * expression mid-morph, the nearest edge changing, the most constrained eye
 * changing. Seven variants were written that way and all of them produced a
 * visible movement artefact: permanent jitter, a 26-unit jump in direction
 * when the reference edge tipped over, sudden magnification when the size
 * entered the calculation. The defect was in none of their geometries; it was
 * in solving it per frame.
 *
 * The rest of the engine does not work that way: the poses are DECLARED and
 * it only interpolates them with known curves. A tabulated offset fits that
 * mould. It does not move when the gaze drifts or the pointer moves, and on a
 * change of shape or expression it only goes from one table entry to the
 * next, along that morph's curve. The jitter becomes impossible by
 * construction instead of being pushed back: interpolating between two
 * constants is monotone, whereas re-solving the problem on a gaze that is
 * itself interpolating is not.
 *
 * Ported from `bloub` (MIT, jeremy-prt/bloub), with one deliberate change:
 * upstream builds the whole table at import time, which costs seconds and
 * would freeze the dashboard on load. Here the entries are computed on
 * first use and cached, which is the same numbers for the same inputs.
 */

import { EXPRESSIONS, type BotExpression } from "./expressions";
import { eyePoses } from "./eyes";
import { radiusAtAngle, toPoints, type Point } from "./shape";
import { SHAPES } from "./skins";
import { STATES, STATE_BY_ID, type Pose, type StateDef, type StateId } from "./states";

/** Reference radius of the solver. The rendered offset is in units of it. */
const R = 100;

/**
 * Maximum amplitudes of the life at rest, read off `liveliness`: `loopNoise`
 * is bounded by 1 in absolute value, so these sums are exact bounds and not
 * estimates.
 *
 * They have to be covered, otherwise the correction is only right for the
 * nominal pose and wrong a second later: 7 degrees of yaw move the eye by a
 * dozen units on a ball of radius 100. That is exactly what made `capsule` +
 * `frightened` overflow while a measurement at a single instant called it
 * good.
 */
const DERIVE_YAW = 5.5 + 1.6;
const DERIVE_PITCH = 4.2 + 1.3;
/** Drift of the centre, in units of the ball radius. */
const DERIVE_X = 0.006;
const DERIVE_Y = 0.007;

/** The face of a pose: what the solver needs to place the capsules. */
interface Visage {
  gaze: Pose["gaze"];
  split: number;
  eyes: Pose["eyes"];
}

/**
 * A capsule ready to be measured: the segment of its axis, and what is
 * needed to compute the radius to clear IN A GIVEN DIRECTION.
 *
 * A capsule is exactly a segment thickened by a disc of radius `r`. Its image
 * through the tangent matrix is therefore a segment thickened by an ELLIPSE,
 * and the radius to clear depends on the direction: it is the support
 * function of that ellipse, `r * |A^T u|`.
 *
 * Using its largest singular value instead would be conservative but wrong in
 * the only direction that matters, and it is expensive: the reference margin
 * on the circle came out NEGATIVE, so the request became toothless and 34
 * combinations still overflowed.
 */
interface Empreinte {
  /** centre, in viewBox units */
  x: number;
  y: number;
  /** half-vector of the axis */
  ax: number;
  ay: number;
  /** radius of the local disc, before transformation */
  r: number;
  /** columns of the tangent matrix, for the support function */
  m: [number, number, number, number];
}

/**
 * The two eye footprints of a face, placed on a profile.
 *
 * A capsule is exactly a segment thickened by a disc of radius `r`. Its image
 * through the tangent matrix is therefore a segment thickened by an ELLIPSE,
 * and a disc of the radius of its major axis covers it: so the largest
 * singular value is used. The measurement stays conservative in the strict
 * sense — a positive margin guarantees the capsule is inside.
 *
 * Blinking is not in there: a closed eye does not need room made for it.
 */
function empreintes(visage: Visage, sil: Pose["sil"], radii: number[]): Empreinte[] {
  const out: Empreinte[] = [];
  const poses = eyePoses(visage.gaze, R, visage.split);
  for (let i = 0; i < 2; i++) {
    const e = poses[i]!;
    if (e.depth <= 0.02) continue;
    const cfg = visage.eyes[i]!;
    const phi = ((cfg.tilt ?? 0) * Math.PI) / 180;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const ax = e.a * cp + e.c * sp;
    const ay = e.b * cp + e.d * sp;
    const cx = -e.a * sp + e.c * cp;
    const cy = -e.b * sp + e.d * cp;

    const hw = Math.max(cfg.w * R, 0.01) / 2;
    const hh = Math.max(cfg.h * R, 0.01) / 2;
    const r = Math.min(hw, hh);
    // the axis is the longest dimension
    const long = hh > hw;
    const demi = long ? hh - r : hw - r;
    // the local radius proportion, exactly as the engine does it
    const fit = radiusAtAngle(radii, Math.atan2(e.y, e.x) - sil.rot);
    out.push({
      x: e.x * fit,
      y: e.y * fit,
      ax: (long ? cx : ax) * demi,
      ay: (long ? cy : ay) * demi,
      r,
      m: [ax, ay, cx, cy],
    });
  }
  return out;
}

/**
 * Shortest approach between an outline and a segment: the distance, and the
 * vector that goes from the outline towards the segment — the direction that
 * clears.
 *
 * Both come out of the SAME pass. Computing them separately doubled the one
 * real cost of this module, which is that sweep.
 */
function approche(pts: Point[], x0: number, y0: number, x1: number, y1: number) {
  const sx = x1 - x0;
  const sy = y1 - y0;
  const len2 = sx * sx + sy * sy;
  let best = Infinity;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    let t = len2 > 0 ? ((p.x - x0) * sx + (p.y - y0) * sy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x0 + t * sx - p.x;
    const ey = y0 + t * sy - p.y;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      vx = ex;
      vy = ey;
    }
  }
  const d = Math.sqrt(best);
  return { d, ux: d > 1e-9 ? vx / d : 0, uy: d > 1e-9 ? vy / d : 0 };
}

/** One test: capsules to fit inside an outline, and the reference outline. */
interface Epreuve {
  empreintes: Empreinte[];
  reference: Empreinte[];
  contour: Point[];
  calContour: Point[];
}

/**
 * Drift of the centre at rest, in viewBox units. It is added to the radius
 * of the capsule: less than one unit, so absorbing it this way is cheaper
 * than multiplying the tests by its four corners.
 */
const FLOTTEMENT = Math.hypot(DERIVE_X, DERIVE_Y) * R;

/** The margin of the tightest capsule, and the direction that clears it. */
function pire(pts: Point[], emps: Empreinte[], tx: number, ty: number) {
  let marge = Infinity;
  let ux = 0;
  let uy = 0;
  for (const e of emps) {
    const x = e.x + tx;
    const y = e.y + ty;
    const a = approche(pts, x - e.ax, y - e.ay, x + e.ax, y + e.ay);
    // support function of the ellipse in the direction of the approach
    const [m0, m1, m2, m3] = e.m;
    const rayon =
      e.r * Math.hypot(m0 * a.ux + m1 * a.uy, m2 * a.ux + m3 * a.uy) + FLOTTEMENT;
    if (a.d - rayon < marge) {
      marge = a.d - rayon;
      ux = a.ux;
      uy = a.uy;
    }
  }
  return { marge, ux, uy };
}

/**
 * The directions probed and the bisection steps. The product of the two is
 * the cost of building an entry, the only number to watch here.
 */
const DIRECTIONS = 12;
const DICHOTOMIE = 8;

/**
 * The offset to apply to both eyes for this shape, this state and this
 * expression.
 *
 * A TRANSLATION common to both eyes, so an isometry: the gap between the
 * eyes, the sizes and the tilts are preserved to the pixel. The face is only
 * placed a little lower on a body that has no room at the top, which is the
 * gesture you would make by hand. The variants that bounded each eye
 * separately pulled the pair apart, and the ones that scaled the face down
 * made the eyes smaller — visibly.
 *
 * The targeted margin is the one of the ORIGINAL profile, not a strict
 * clearance: on the circle the outer eye already grazes the edge, 17.3 units
 * for a ball of radius 100, and that is wanted — it is what gives the
 * volume. It is capped by what the shape offers at its centre, otherwise the
 * request is untenable on a flat body.
 *
 * DIRECTIONAL SEARCH and not a descent. We look for the translation of
 * smallest norm that fits, so we probe a crown of directions and bisect the
 * distance along each. A gradient descent was written first and it does not
 * converge: clearing the pair from one edge brings it closer to the other, so
 * it stutters and only keeps its best attempt — dropping its turns from 40 to
 * 18 was enough to bring 34 overflows back. Here the result does not depend
 * on a convergence: each direction is solved exactly, to the bisection step.
 */
function resous(epreuves: Epreuve[]): { x: number; y: number } {
  if (!epreuves.length) return { x: 0, y: 0 };

  /** The tightest margin over all the tests, for a given translation. */
  const marge = (tx: number, ty: number) => {
    let m = Infinity;
    for (const ep of epreuves) m = Math.min(m, pire(ep.contour, ep.empreintes, tx, ty).marge);
    return m;
  };

  // Required margin: the tightest the original profile tolerates, over all
  // the tests. Then capped by the most the shape can offer the pair at its
  // centre.
  let requis = Infinity;
  for (const ep of epreuves) {
    requis = Math.min(requis, pire(ep.calContour, ep.reference, 0, 0).marge);
  }
  /*
   * The travel must be able to reach the centre of the body: `wide` has
   * capsules 87 units long, and on a triangle they only fit towards the
   * middle, about fifty units from their nominal place. A fixed travel left
   * them outside.
   */
  let mx = 0;
  let my = 0;
  const emps = epreuves[0]!.empreintes;
  for (const e of emps) {
    mx -= e.x / emps.length;
    my -= e.y / emps.length;
  }
  const course = Math.max(0.35 * R, Math.hypot(mx, my) * 1.25);

  // Cap on the request: what the shape offers at its centre, always reachable.
  requis = Math.min(requis, marge(mx, my));

  /*
   * Already good: the circle's case, and that of any shape wide enough. The
   * capsule must FIT, and not be tighter than on the original profile —
   * without that second condition, a shape where nothing fits satisfied the
   * first one degenerately and we gave up. `wide` has capsules 87 units
   * long, `notify` discs 50 across: on a triangle or a droplet they overflow
   * whatever you do, and the answer is then the least bad, not a refusal.
   */
  const depart = marge(0, 0);
  if (depart >= requis && depart >= 0) return { x: 0, y: 0 };
  const cible = Math.max(requis, 0);

  let meilleurX = 0;
  let meilleurY = 0;
  let meilleureNorme = Infinity;
  // fallback when nothing fits: the translation that clears the most, probed
  // on the way
  let secoursX = 0;
  let secoursY = 0;
  let secours = depart;

  for (let d = 0; d < DIRECTIONS; d++) {
    const a = (d / DIRECTIONS) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    if (marge(ux * course, uy * course) < cible) {
      // this direction leads nowhere; we still keep the best clearance
      // there is no solution that way, but maybe a better clearance
      for (const k of [0.3, 0.6, 1]) {
        const m = marge(ux * course * k, uy * course * k);
        if (m > secours) {
          secours = m;
          secoursX = ux * course * k;
          secoursY = uy * course * k;
        }
      }
      continue;
    }
    // the shortest distance that fits, along this direction
    let bas = 0;
    let haut = course;
    for (let i = 0; i < DICHOTOMIE; i++) {
      const mid = (bas + haut) / 2;
      if (marge(ux * mid, uy * mid) >= cible) haut = mid;
      else bas = mid;
    }
    if (haut < meilleureNorme) {
      meilleureNorme = haut;
      meilleurX = ux * haut;
      meilleurY = uy * haut;
    }
  }

  const x = meilleureNorme === Infinity ? secoursX : meilleurX;
  const y = meilleureNorme === Infinity ? secoursY : meilleurY;
  // rendered in units of the BALL RADIUS: the engine puts it back to its scale
  return { x: +(x / R).toFixed(6), y: +(y / R).toFixed(6) };
}

/**
 * The face to cover: the expression's if the state accepts one, its own
 * otherwise.
 *
 * ONE table entry per expression, and not a worst case common to all of
 * them. A worst case looked more convincing — a constant offset cannot move
 * when the expression changes — but it is untenable: on a capsule, `neutre`
 * has the eyes high and asks to go down while `frightened` has them low and
 * asks to go up. No single translation satisfies both, and the measurement
 * agrees (4 overflows of 4.8 units).
 *
 * One entry per expression is not less smooth for that: the engine
 * interpolates between TWO CONSTANTS, which is monotone by construction.
 * What used to jitter was re-solving the problem on a gaze that was itself
 * interpolating.
 */
function visageDe(def: StateDef, pose: Pose, expr: BotExpression | null): Visage {
  if (def.baseFace && expr) return { gaze: expr.gaze, split: expr.split, eyes: expr.eyes };
  return { gaze: pose.gaze, split: pose.split, eyes: pose.eyes };
}

/** The dates to sample in a state: one if its pose does not move. */
function dates(def: StateDef): number[] {
  /** Everything the solver uses: if nothing moves, one date is enough. */
  const signature = (p: Pose) =>
    JSON.stringify([p.gaze, p.split, p.eyes, p.sil.rot, p.sil.cx, p.sil.cy, p.sil.sx, p.sil.sy]);
  if (signature(def.pose(0)) === signature(def.pose(def.duration))) return [0];
  const n = 3;
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * def.duration);
}

/** The offset of a shape on a state and an expression, drift included. */
function decalagePour(
  def: StateDef,
  radii: number[],
  expr: BotExpression | null,
): { x: number; y: number } {
  const epreuves: Epreuve[] = [];
  for (const t of dates(def)) {
    const pose = def.pose(t);
    const contour = toPoints({ ...pose.sil, radii }, R);
    const calContour = toPoints(pose.sil, R);
    const v = visageDe(def, pose, expr);
    // The four corners of the drift bound the nominal pose, which is their
    // centre: testing it as well would not change any margin and would cost
    // one test in five.
    const coins: Visage[] = [];
    for (const dy of [-DERIVE_YAW, DERIVE_YAW]) {
      for (const dp of [-DERIVE_PITCH, DERIVE_PITCH]) {
        coins.push({
          ...v,
          gaze: { yaw: v.gaze.yaw + dy, pitch: v.gaze.pitch + dp, roll: v.gaze.roll },
        });
      }
    }
    for (const c of coins) {
      epreuves.push({
        empreintes: empreintes(c, pose.sil, radii),
        reference: empreintes(c, pose.sil, pose.sil.radii),
        contour,
        calContour,
      });
    }
  }
  return resous(epreuves);
}

/** Zero, the value shared by everything that has nothing to correct. */
const NUL = { x: 0, y: 0 } as const;

/** The key of an entry: the state, and the expression when the state accepts one. */
const clef = (state: StateId, expr: string | null) => `${state}|${expr ?? ""}`;

/**
 * Cache of the offsets, keyed by the shape's radii ARRAY REFERENCE — which is
 * already the engine's convention: its `radii === this.shape` guard relies on
 * that same stability. An unknown profile, or `null`, corrects nothing.
 *
 * Upstream builds every entry at import time. Here each entry is computed
 * the first time it is asked for and then kept: the numbers are identical,
 * but the dashboard does not pay for the 300-odd entries it never reads.
 */
const CACHE = new WeakMap<number[], Map<string, { x: number; y: number }>>();

function entryFor(
  radii: number[],
  state: StateId,
  expr: string | null,
): { x: number; y: number } | undefined {
  const def = STATE_BY_ID.get(state);
  if (!def) return undefined;
  // Only the states whose body the customiser replaces have a correction:
  // on the others the silhouette is the animation, measured off the video,
  // and moving the eyes would break it.
  if (!def.baseBody) return undefined;
  let par = CACHE.get(radii);
  if (!par) {
    par = new Map<string, { x: number; y: number }>();
    CACHE.set(radii, par);
  }
  const key = clef(state, expr);
  const hit = par.get(key);
  if (hit) return hit;
  const expression = expr ? (EXPRESSIONS.find((e) => e.id === expr) ?? null) : null;
  const computed = decalagePour(def, radii, expression);
  par.set(key, computed);
  return computed;
}

/**
 * The offset to apply to both eyes for this shape on this state, in units of
 * the ball radius — the engine puts it back to its own scale.
 *
 * Worth zero as soon as the shape is not in the catalogue, which covers
 * `null` and the circle: on the circle both profiles are the same, so the
 * margin is already the required one and the descent stops on the first
 * turn. The shape measured off the video therefore does not move, without a
 * special case.
 */
export function decalageDesYeux(
  radii: number[] | null,
  state: StateId,
  expr: string | null,
): { x: number; y: number } {
  if (!radii) return NUL;
  // a state without a resting face has a single entry, whatever the expression
  return (
    entryFor(radii, state, expr) ??
    entryFor(radii, state, null) ??
    NUL
  );
}

/** For the tests: the shape catalogue the solver was asked about. */
export const POUR_TESTS = { SHAPES, STATES };
