import { arcRender, type ArcRender, type DotRender } from "./decor";
import { blendExpression, type BotExpression } from "./expressions";
import { decalageDesYeux } from "./eyefit";
import { blinkScale, eyePoses, liveliness } from "./eyes";
import { clamp, easings, lerp, r2 } from "./math";
import {
  blend,
  capsulePath,
  closedPath,
  radiusAtAngle,
  toPoints,
  type Point,
  type Silhouette,
} from "./shape";
import { STATE_BY_ID, type Pose, type StateDef, type StateId } from "./states";

/**
 * The clock-free bot engine.
 *
 * Ported from `bloub` (MIT, jeremy-prt/bloub). `sample(t)` is a pure
 * function of time: pausing, resuming and jumping to an arbitrary date all
 * give exactly the same image, and the rendering is testable without a DOM.
 */

export interface RenderedEye {
  d: string;
  matrix: string;
  alpha: number;
}

export interface BotFrame {
  bodyPath: string;
  bodyAlpha: number;
  eyes: RenderedEye[];
  dots: DotRender[];
  /** true = the dots pass behind the body (burst particles) */
  dotsBehind: boolean;
  arcs: ArcRender[];
  notif: { x: number; y: number; r: number } | null;
  notch: { x: number; y: number; r: number } | null;
}

/**
 * Where the bot looks when something outside drives it — the pointer, for
 * now.
 *
 * `yaw` and `pitch` are ABSOLUTE directions, which replace the state's
 * ones as `mix` rises. Two reasons, each a trap already fallen into:
 *
 * - it has to be the ENGINE that does the mix, not the caller, because only
 *   it knows the pose AT THAT INSTANT. A caller compensating for the
 *   expression's orientation would read its arrival value while the morph is
 *   still running, and the eyes would jump on every mood change;
 * - and it has to be absolute on BOTH axes. In relative terms the eye
 *   height followed the height of each expression — "neutral" looks at
 *   +28.6deg while the others sit between -9 and +9 — so the eyes dropped in
 *   one step on the first mood change. What makes an expression's character
 *   during tracking is the SHAPE of its eyes (narrowed, round, mismatched),
 *   not where it looks: that is the cursor's call.
 *
 * `mix` says how much the outside drives the DIRECTION (0 = not at all).
 *
 * `wander` says, separately, how much automatic drift is left. The two do
 * not get confused: when the pointer moves, the drift must fade out —
 * cumulated, the bot would look like it is searching for the cursor without
 * ever holding it. But when there is NO pointer (arrival by keyboard, on
 * touch, or the mouse out of the window), the head must stay turned AND keep
 * living. Confusing them froze the gaze as soon as the view opened.
 *
 * `spin` is a turn to travel ON THE WAY, in degrees, melted away to 0 with
 * the arrival. Because the eyes live on a sphere, a turn takes them behind
 * the ball and brings them back on the other side — and `-360deg` being the
 * same angle as `0`, it does not change where they end up.
 */
export interface Look {
  yaw: number;
  pitch: number;
  mix: number;
  spin: number;
  wander: number;
}

const NO_LOOK: Look = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 };

const lerpLook = (a: Look, b: Look, t: number): Look => ({
  yaw: lerp(a.yaw, b.yaw, t),
  pitch: lerp(a.pitch, b.pitch, t),
  mix: lerp(a.mix, b.mix, t),
  spin: lerp(a.spin, b.spin, t),
  wander: lerp(a.wander, b.wander, t),
});

const lerpEye = (a: Pose["eyes"][number], b: Pose["eyes"][number], t: number) => ({
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  open: lerp(a.open, b.open, t),
  tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t),
});

/** Interpolates two poses. The decoration crosses in opacity, not in geometry. */
function blendPose(a: Pose, b: Pose, t: number): Pose {
  const out = 1 - t;
  return {
    sil: blend(a.sil, b.sil, t),
    offX: lerp(a.offX, b.offX, t),
    offY: lerp(a.offY, b.offY, t),
    gaze: {
      yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
      pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
      roll: lerp(a.gaze.roll, b.gaze.roll, t),
    },
    split: lerp(a.split, b.split, t),
    eyes: [lerpEye(a.eyes[0], b.eyes[0], t), lerpEye(a.eyes[1], b.eyes[1], t)],
    eyeAlpha: lerp(a.eyeAlpha, b.eyeAlpha, t),
    bodyAlpha: lerp(a.bodyAlpha, b.bodyAlpha, t),
    dots: [
      ...a.dots.map((d) => ({ ...d, opacity: d.opacity * out })),
      ...b.dots.map((d) => ({ ...d, opacity: d.opacity * t })),
    ],
    arcs: [
      ...a.arcs.map((r) => ({ ...r, id: `a${r.id}`, opacity: r.opacity * out })),
      ...b.arcs.map((r) => ({ ...r, id: `b${r.id}`, opacity: r.opacity * t })),
    ],
    // the pip belongs to one of the two states, it does not blend
    notif: t < 0.5 ? a.notif : b.notif,
    dotsBehind: t < 0.5 ? a.dotsBehind : b.dotsBehind,
  };
}

export class BotEngine {
  /** radius of the resting ball, in viewBox units */
  readonly scale: number;

  private cur: StateId;
  private prev: StateId | null = null;
  /**
   * FROZEN departure pose, set only when a state change arrives while a fade
   * is already running. See `setState`.
   */
  private departFige: Pose | null = null;
  private tCur = 0;
  private tPrev = 0;
  private blinkAt = -10;
  private pts: Point[] = [];
  private shape: number[] | null = null;
  private shapePrev: number[] | null = null;
  private shapeAt = -10;
  private expr: BotExpression | null = null;
  private exprPrev: BotExpression | null = null;
  private exprAt = -10;
  private look: Look = NO_LOOK;
  private lookPrev: Look = NO_LOOK;
  private lookAt = -10;
  /** duration of the catch-up in progress; see `LOOK_MORPH` */
  private lookMorph = 0.24;

  /** duration of the morph when the body's shape changes */
  static readonly SHAPE_MORPH = 0.45;

  /**
   * Duration of the catch-up of the gaze towards its target. Shorter than
   * `SHAPE_MORPH`: a gaze that follows should look attentive, not sticky.
   * Since the target is re-set on every pointer move, it is this duration
   * that gives the tracking its inertia — the gaze never quite reaches a
   * cursor that keeps moving.
   */
  static readonly LOOK_MORPH = 0.24;

  constructor(
    scale = 100,
    initial: StateId = "idle",
    shape: number[] | null = null,
    expression: BotExpression | null = null,
  ) {
    this.scale = scale;
    this.cur = initial;
    this.shape = shape;
    this.expr = expression;
  }

  /**
   * The resting expression chosen in the customiser. Like the shape, it
   * slides to the new value instead of jumping.
   */
  setExpression(expression: BotExpression | null, now = 0) {
    if (expression === this.expr) return;
    this.exprPrev = this.expr;
    this.expr = expression;
    this.exprAt = now;
  }

  /** The effective expression at `now`, morph included. */
  private exprAtTime(now: number): BotExpression | null {
    const to = this.expr;
    const from = this.exprPrev;
    if (!to || !from) return to;
    const k = (now - this.exprAt) / BotEngine.SHAPE_MORPH;
    if (k >= 1) return to;
    return blendExpression(from, to, easings.easeOutQuint(clamp(k)));
  }

  /**
   * The shape chosen in the customiser. It only replaces the body on the
   * resting states (`baseBody`): on the others, the silhouette IS the
   * animation and must not be overwritten.
   *
   * The change is a morph, not a jump: since all the shapes are sampled at
   * the same angles, interpolating the radii is enough.
   */
  setShape(radii: number[] | null, now = 0) {
    if (radii === this.shape) return;
    this.shapePrev = this.shape;
    this.shape = radii;
    this.shapeAt = now;
  }

  /**
   * The effective shape at `now`, morph included.
   *
   * It does NOT reset `shapePrev` to null at the end of the morph: `sample`
   * must stay a pure function of time, so re-reading a past date has to
   * give the intermediate image again. We only keep one more reference.
   */
  private shapeAtTime(now: number): number[] | null {
    const to = this.shape;
    const from = this.shapePrev;
    if (!to || !from) return to;
    const k = (now - this.shapeAt) / BotEngine.SHAPE_MORPH;
    if (k >= 1) return to;
    const t = easings.easeOutQuint(clamp(k));
    // allocates only during the morph; outside it, the array is returned as-is
    return to.map((r, i) => lerp(from[i] ?? r, r, t));
  }

  /**
   * A new gaze target, `null` to go back to the state's own.
   *
   * It starts from the CURRENT value, and not from the previous target as
   * `setShape` does: this method is called on every pointer move, and
   * starting from the old target would pull the gaze back one notch before
   * each catch-up — the tracking would stutter instead of gliding.
   *
   * Same contract as `setShape` otherwise: the outside state enters through
   * a timestamped setter, never through a variable read during `sample`,
   * otherwise the engine stops being a pure function of time.
   */
  setLook(look: Look | null, now: number, morph = BotEngine.LOOK_MORPH) {
    /*
     * A non-finite target is refused. The engine KEEPS the last one: a single
     * `NaN` would propagate to every frame and the bot would never settle
     * again. This happened for real — a `getBoundingClientRect` on a
     * zero-sized box gives `0 / 0` at the call site. That one is fixed, but
     * the engine has no business relying on its callers' prudence to stay
     * replayable.
     */
    if (look && !Number.isFinite(look.yaw + look.pitch + look.mix + look.spin + look.wander)) {
      return;
    }
    this.lookPrev = this.lookAtTime(now);
    this.look = look ?? NO_LOOK;
    this.lookAt = now;
    this.lookMorph = morph;
  }

  /** The effective gaze at `now`, catch-up included. */
  private lookAtTime(now: number): Look {
    const k = (now - this.lookAt) / this.lookMorph;
    if (k >= 1) return this.look;
    return lerpLook(this.lookPrev, this.look, easings.easeOutQuint(clamp(k)));
  }

  private posed(
    def: StateDef,
    t: number,
    shape: number[] | null,
    expr: BotExpression | null,
  ): Pose {
    let pose = def.pose(t);
    if (def.baseBody && shape) {
      // the pose (rotation, offset, squash) is kept, only the profile changes
      pose = { ...pose, sil: { ...pose.sil, radii: shape } };
    }
    if (def.baseFace && expr) {
      pose = { ...pose, gaze: expr.gaze, split: expr.split, eyes: expr.eyes };
    }
    return pose;
  }

  /**
   * The eye offset at `now` for a given state, in units of the ball radius.
   *
   * It is READ from a table and interpolated, never recomputed:
   * `eyefit.ts` explains why that distinction is the whole fix. Here it only
   * has to be interpolated along the shape's axis, with exactly the curve and
   * the duration of the silhouette morph — same cause, so it must be the
   * same movement.
   *
   * The table is queried on the BOUNDS of the morph (`shapePrev` and `shape`)
   * and not on the profile that `shapeAtTime` renders: that one is a fresh
   * array allocated every frame, so it has no identity, and it exists in no
   * table.
   */
  private decalageAtTime(now: number, state: StateId): { x: number; y: number } {
    /**
     * One morph axis: the table is read on its two BOUNDS and interpolated
     * with its curve. Never on the interpolated value — that one has no
     * identity and exists in no table, and feeding it to the table is what
     * made the earlier versions jitter.
     */
    const surAxe = (
      debut: number,
      duree: number,
      a: { x: number; y: number },
      b: { x: number; y: number },
    ) => {
      if (a === b) return b;
      const k = (now - debut) / duree;
      if (k >= 1) return b;
      const t = easings.easeOutQuint(clamp(k));
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    };

    // the expression's axis, for each of the two shapes in play
    const parForme = (radii: number[] | null) =>
      surAxe(
        this.exprAt,
        BotEngine.SHAPE_MORPH,
        decalageDesYeux(radii, state, this.exprPrev?.id ?? null),
        decalageDesYeux(radii, state, this.expr?.id ?? null),
      );

    // then the shape's axis
    return surAxe(
      this.shapeAt,
      BotEngine.SHAPE_MORPH,
      parForme(this.shapePrev),
      parForme(this.shape),
    );
  }

  get state(): StateId {
    return this.cur;
  }

  /**
   * Restarts on `id` WITHOUT a previous state, like a fresh engine set on
   * that state.
   *
   * That is what "rewind" means for this engine. `setState` alone cannot do
   * it: it keeps the state being left, to fade out of it, which is exactly
   * its role during playback and exactly what you do not want when coming
   * back to the start of a sequence. Replaying frame 0 after a full pass
   * mixed the first state with the LAST one, and the GIF export opened on a
   * ball with no eyes — the comet has a null `eyeAlpha`.
   *
   * `sample` stays a pure function of time: like `setState`, this is a
   * timestamped setter, called by the sequence driver, never during a
   * sampling.
   */
  reset(id: StateId, now: number) {
    this.cur = id;
    this.prev = null;
    this.departFige = null;
    this.tCur = now;
    this.tPrev = now;
    this.blinkAt = -10;
  }

  /**
   * Origin of the fade in progress: the frozen pose if there is one, else
   * the state being left evaluated at its own elapsed time — so still
   * animating, which is wanted.
   */
  private origine(
    now: number,
    shape: number[] | null,
    expr: BotExpression | null,
  ): Pose | null {
    if (this.departFige) return this.departFige;
    if (!this.prev) return null;
    const prevDef = STATE_BY_ID.get(this.prev)!;
    return this.posed(prevDef, Math.max(0, now - this.tPrev), shape, expr);
  }

  /**
   * The composite pose at `now`, fade included: exactly what `sample` mixes,
   * before the layer of rest-life and gaze. Extracted so that `setState` can
   * freeze it.
   */
  private poseComposee(now: number): Pose {
    const def = STATE_BY_ID.get(this.cur)!;
    const shape = this.shapeAtTime(now);
    const expr = this.exprAtTime(now);
    const pose = this.posed(def, Math.max(0, now - this.tCur), shape, expr);
    const since = now - this.tCur;
    if (since >= def.morph) return pose;
    const origine = this.origine(now, shape, expr);
    if (!origine) return pose;
    return blendPose(origine, pose, easings.easeOutQuint(clamp(since / def.morph)));
  }

  /**
   * A state change, dated.
   *
   * The engine keeps only ONE slot of history, so a change arriving during a
   * fade replaced the origin of the mix with the FULL pose of the state being
   * left, instead of the partially mixed image that was on screen. Measured
   * on `idle -> wide -> idle` at 100 ms: 35.9 px of jump against 8.0 px of
   * normal movement.
   *
   * So we freeze the current composite pose and mix from it. Continuous by
   * construction, whatever the number of chained changes.
   *
   * And ONLY in that case. Freezing on every change would stop the animation
   * of the state being left dead for the whole fade — the "!" of `alert`
   * would freeze mid-run — while there is nothing to correct outside a
   * morph: the state being left is already exactly the image on screen.
   */
  setState(id: StateId, now: number) {
    if (id === this.cur) return;
    const morph = STATE_BY_ID.get(this.cur)!.morph;
    const enPleinFondu = this.prev !== null && now - this.tCur < morph;
    this.departFige = enPleinFondu ? this.poseComposee(now) : null;
    this.prev = this.cur;
    this.tPrev = this.tCur;
    this.cur = id;
    this.tCur = now;
    // In the video, every change of shape is masked by a blink.
    if (STATE_BY_ID.get(id)?.blinkIn) this.blinkAt = now;
  }

  sample(now: number): BotFrame {
    const R = this.scale;
    const def = STATE_BY_ID.get(this.cur)!;
    const shape = this.shapeAtTime(now);
    const expr = this.exprAtTime(now);
    let pose = this.posed(def, Math.max(0, now - this.tCur), shape, expr);
    let decalage = this.decalageAtTime(now, this.cur);

    // --- transition -------------------------------------------------------
    const since = now - this.tCur;
    // The previous state is never purged: `since < def.morph` is enough to
    // ignore it once the fade is over, and forgetting it would make the
    // engine non-replayable — re-reading a date from before the end of the
    // fade would not find it any more. It is the optimisation that looks
    // innocent and breaks everything.
    const origine = since < def.morph ? this.origine(now, shape, expr) : null;
    if (origine) {
      // Exponential ease-out: the curve measured on the video. The body does
      // not overshoot (only the pip and the opening of the eyes do).
      // The ratio is clamped: re-reading a date BEFORE the state change would
      // give a negative ratio, which the ease-out extrapolates — the
      // silhouette would then start thirty times too far away.
      const ratio = easings.easeOutQuint(clamp(since / def.morph));
      pose = blendPose(origine, pose, ratio);
      // The eye offset follows the SAME curve as the silhouette that motivates
      // it. It comes from the state being left, which `setState` always
      // reports at the same time as the origin — the test is there for the
      // typing, not for a real case.
      const quitte = this.prev;
      if (quitte) {
        const avant = this.decalageAtTime(now, quitte);
        decalage = {
          x: lerp(avant.x, decalage.x, ratio),
          y: lerp(avant.y, decalage.y, ratio),
        };
      }
    }

    // --- life at rest -----------------------------------------------------
    const alive = pose.eyeAlpha > 0.01;
    const look = this.lookAtTime(now);
    const life = liveliness(now, { wander: alive ? look.wander : 0, blink: alive });

    const gaze = {
      // The two targets REPLACE the pose's ones instead of adding to them (see
      // `Look`), and the turn is subtracted along the way. The drift is added
      // AFTER the mix, otherwise the target would cancel it at the same time
      // as the pose — and it has to survive a turned head with no pointer.
      yaw: lerp(pose.gaze.yaw, look.yaw, look.mix) + life.dYaw - look.spin,
      pitch: lerp(pose.gaze.pitch, look.pitch, look.mix) + life.dPitch,
      // the roll follows nothing: the bot's head is tilted -13deg in the
      // video, and rolling it with the cursor breaks that signature
      roll: pose.gaze.roll + life.dRoll,
    };

    // the blink triggered by the state change, on top of the schedule
    const forced = clamp((now - this.blinkAt) / 0.2);
    const forcedLid = forced < 1 ? Math.abs(forced * 2 - 1) : 1;
    const lid = Math.min(life.lid, forcedLid);

    const offX = pose.offX + life.driftX;
    const offY = pose.offY + life.driftY;

    // --- body -------------------------------------------------------------
    const sil: Silhouette = {
      ...pose.sil,
      cx: pose.sil.cx + offX,
      cy: pose.sil.cy + offY,
      sy: pose.sil.sy * life.breath,
    };
    const bodyPath = closedPath(toPoints(sil, R, this.pts));

    // --- eyes -------------------------------------------------------------
    // The eyes live on a sphere of radius 1; as soon as the silhouette is no
    // longer a circle, they are brought back in proportion to the real radius
    // in their direction, otherwise they overflow and the mask cuts them.
    const bodyRadius = (x: number, y: number) =>
      radiusAtAngle(pose.sil.radii, Math.atan2(y, x) - pose.sil.rot);

    const eyes: RenderedEye[] = [];
    if (pose.eyeAlpha > 0.01) {
      const poses = eyePoses(gaze, R, pose.split);
      for (let i = 0; i < 2; i++) {
        const e = poses[i]!;
        if (e.depth <= 0.02) continue;
        const cfg = pose.eyes[i]!;
        const fit = bodyRadius(e.x, e.y);
        // The eye's own tilt: the tangent frame is composed with a rotation
        // in the eye's plane (Basis x Rot). That is what allows mirrored
        // tilts between the two eyes.
        const phi = ((cfg.tilt ?? 0) * Math.PI) / 180;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        const ax = e.a * cp + e.c * sp;
        const ay = e.b * cp + e.d * sp;
        const cx2 = -e.a * sp + e.c * cp;
        const cy2 = -e.b * sp + e.d * cp;
        // The blink is applied AFTER all of that: it is a vertical squash on
        // screen, not along the capsule's tilted axis.
        const k = blinkScale(Math.min(lid, cfg.open));
        eyes.push({
          d: capsulePath(cfg.w * R, cfg.h * R),
          matrix: `matrix(${r2(ax)},${r2(ay * k)},${r2(cx2)},${r2(cy2 * k)},${r2(
            e.x * fit + (offX + decalage.x) * R,
          )},${r2(e.y * fit + (offY + decalage.y) * R)})`,
          alpha: pose.eyeAlpha * clamp(e.depth / 0.12),
        });
      }
    }

    // --- decoration --------------------------------------------------------
    const dots = pose.dots
      .filter((p) => p.opacity > 0.01 && p.r > 0.0005)
      .map((p) => ({ ...p, x: (p.x + offX) * R, y: (p.y + offY) * R, r: p.r * R }));

    // the pip is posed on the outline: it follows the shape too
    const nFit = pose.notif ? bodyRadius(pose.notif.x, pose.notif.y) : 1;
    const nx = pose.notif ? (pose.notif.x * nFit + offX) * R : 0;
    const ny = pose.notif ? (pose.notif.y * nFit + offY) * R : 0;
    const notif = pose.notif ? { x: nx, y: ny, r: pose.notif.r * R } : null;
    const notch = pose.notif ? { x: nx, y: ny, r: pose.notif.notch * R } : null;

    return {
      bodyPath,
      bodyAlpha: pose.bodyAlpha,
      eyes,
      dots,
      dotsBehind: pose.dotsBehind,
      // The states declare their arcs in units of the ball radius; the engine
      // is the only one that knows the viewBox scale, so it is the one that
      // draws them.
      arcs: pose.arcs
        .filter((a) => a.opacity > 0.01)
        .map((a) => arcRender(a.seed, a.t, R, a.id, a.opacity)),
      notif,
      notch,
    };
  }
}
