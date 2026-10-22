/**
 * The customiser shapes, measured against the body they replace.
 *
 * Ported from `bloub` (MIT, jeremy-prt/bloub) — `src/bot/skins.test.ts`. Two
 * things are locked here, and the second cost far more than the first:
 *
 * 1. **The eye does not leave the silhouette.** The eyes live on a sphere, and
 *    `radiusAtAngle` re-seats them on the outline in proportion to the local
 *    radius — which divides their margin by the same proportion. A shape
 *    that is narrow in the direction of the eye pushed it against the edge
 *    until the mask opened it: the capsule showed up as a notch bitten out
 *    of the body.
 * 2. **The correction is not seen to move.** Seven versions computed it in
 *    the render loop and all of them jittered. The oscillation tests below
 *    are what disqualified them, and they compare against the CIRCLE, the
 *    shape the correction does not touch.
 *
 * Everything is measured on the RENDERED GEOMETRY, not on the computation:
 * the body's outline and each capsule's outline are read back as the
 * component draws them. That is the only way to check what the eye sees,
 * and it assumes nothing about the method.
 */

import { describe, expect, it } from "vitest";
import { BotEngine, type RenderedEye } from "./engine";
import { EXPRESSIONS } from "./expressions";
import { decalageDesYeux } from "./eyefit";
import { DEFAULT_SHAPE, SHAPES, SHAPE_BY_ID } from "./skins";
import { STATES, type StateId } from "./states";
import { normalizeFace, DEFAULT_FACE } from "./face";

const R = 100;

/**
 * The body's outline, read off the `bodyPath`. `closedPath` emits `M x y`
 * then one `C` per point, so the points of the curve are the 3rd pair of
 * each `C`.
 */
function contourDuCorps(d: string) {
  const pts: Array<{ x: number; y: number }> = [];
  for (const seg of d.slice(1).split("C")) {
    const n = seg.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    if (n.length >= 6) pts.push({ x: n[4]!, y: n[5]! });
    else if (n.length === 2) pts.push({ x: n[0]!, y: n[1]! });
  }
  return pts;
}

/** Is the point inside the polygon? Ray casting. */
function dedans(poly: Array<{ x: number; y: number }>, x: number, y: number) {
  let on = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) on = !on;
  }
  return on;
}

/**
 * The outline of a capsule in screen coordinates: a stadium, sampled then
 * put through the rendered matrix. The dimensions are read back out of the
 * `d` that `capsulePath` produced (`M-hw -hh+r A r r ...`), so the test
 * depends on the output only.
 *
 * Thirty-two points are enough: on a capsule 40 units long they are less
 * than three units apart, and the smallest overflow ever measured is three.
 */
function contourDeLOeil(eye: RenderedEye, N = 32) {
  const g = eye.d.match(/-?\d+\.?\d*/g)!.map(Number);
  const hw = Math.abs(g[0]!);
  const r = Math.abs(g[2]!);
  const droit = Math.abs(g[1]!);
  const m = eye.matrix.match(/-?\d+\.?\d*/g)!.map(Number);
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < N; i++) {
    const u = (i / N) * 4;
    let x: number;
    let y: number;
    if (u < 1) {
      const t = Math.PI * (u - 0.5);
      x = Math.cos(t) * r;
      y = -droit + Math.sin(t) * r;
    } else if (u < 2) {
      x = hw;
      y = -droit + (u - 1) * 2 * droit;
    } else if (u < 3) {
      const t = Math.PI * (u - 2 + 0.5);
      x = Math.cos(t) * r;
      y = droit + Math.sin(t) * r;
    } else {
      x = -hw;
      y = droit - (u - 3) * 2 * droit;
    }
    out.push({ x: a * x + c * y + e, y: b * x + d * y + f });
  }
  return out;
}

/** Three seconds at twenty frames per second: enough for several blinks. */
const INSTANTS = 60;
const PAS = 1 / 20;

/**
 * How far the most overflowing capsule leaves the body, in viewBox units.
 *
 * It sweeps TIME and not just the combination. The gaze drift moves the eye
 * by a dozen units, so a single frame proves nothing: measuring only at
 * `POSES[state]` let `capsule` + `frightened` pass unnoticed while it was
 * overflowing by 4.4 units a second later.
 */
function debordement(
  state: StateId,
  radii: number[],
  expr: (typeof EXPRESSIONS)[number] | null,
) {
  const e = new BotEngine(R, state, radii, expr);
  let pire = 0;
  for (let i = 0; i < INSTANTS; i++) {
    const f = e.sample(i * PAS);
    const corps = contourDuCorps(f.bodyPath);
    for (const eye of f.eyes) {
      for (const p of contourDeLOeil(eye)) {
        if (dedans(corps, p.x, p.y)) continue;
        pire = Math.max(
          pire,
          Math.min(...corps.map((q) => Math.hypot(q.x - p.x, q.y - p.y))),
        );
      }
    }
  }
  return pire;
}

/** The states whose body can be replaced by a customiser shape. */
const CORPS_DE_BASE = STATES.filter((s) => s.baseBody).map((s) => s.id);
/** The others: their silhouette IS the animation, measured off the video. */
const SILHOUETTE_MESUREE = STATES.filter((s) => !s.baseBody).map((s) => s.id);

describe("customiser shapes", () => {
  // 680 combinations x 60 instants x two outlines: the heaviest test in the
  // port, and the only one that proves what the eye sees.
  it("lets no shape let an eye out of the silhouette", () => {
    const fautifs: string[] = [];
    for (const state of CORPS_DE_BASE) {
      for (const forme of SHAPES) {
        for (const expr of [null, ...EXPRESSIONS]) {
          const sortie = debordement(state, forme.radii, expr);
          if (sortie > 0.05) {
            fautifs.push(`${state}/${forme.id}/${expr?.id ?? "pose"} ${sortie.toFixed(1)}`);
          }
        }
      }
    }
    expect(fautifs).toEqual([]);
  }, 60_000);

  /**
   * The circle is the shape measured off the video, and the default body:
   * choosing it in the customiser must change NOTHING compared to choosing
   * nothing. That is what guarantees the correction is neutral on the
   * reference — including its outer eye, which already grazes the edge and
   * must go on grazing it.
   */
  it("renders the circle exactly like choosing nothing", () => {
    expect(DEFAULT_SHAPE).toBe("cercle");
    const cercle = SHAPE_BY_ID.get("cercle")!.radii;
    for (const state of CORPS_DE_BASE) {
      for (const expr of [null, ...EXPRESSIONS]) {
        const avec = new BotEngine(R, state, cercle, expr).sample(1);
        const sans = new BotEngine(R, state, null, expr).sample(1);
        expect(avec.eyes, `${state}/${expr?.id ?? "pose"}`).toEqual(sans.eyes);
      }
      expect(decalageDesYeux(cercle, state, null)).toEqual({ x: 0, y: 0 });
    }
  });

  /**
   * The silhouettes measured off the video are not replaceable, so the
   * chosen shape must not reach them — neither their body nor their eyes.
   * `orbit` is the case that matters: its eye margin is tighter than the
   * circle's and it is still right, because it was measured that way. A
   * margin rule applied without distinction would move it.
   */
  it("does not touch the states with a measured silhouette", () => {
    for (const state of SILHOUETTE_MESUREE) {
      const nu = new BotEngine(R, state, null, null).sample(1);
      for (const forme of SHAPES) {
        const habille = new BotEngine(R, state, forme.radii, null).sample(1);
        expect(habille.eyes, `${state}/${forme.id}`).toEqual(nu.eyes);
        expect(habille.bodyPath).toBe(nu.bodyPath);
      }
    }
  });

  /**
   * The correction must change NOTHING about the size of the eyes.
   *
   * One version scaled them at the same time as it moved them: that kept
   * all the face's ratios and stayed stable, but the eyes became visibly
   * smaller on a flat body, and changing expression then animated that
   * shrinking. It read as a defect.
   */
  it("does not let the shape change the size of the eyes", () => {
    const tailles = new Set(
      SHAPES.map((f) =>
        new BotEngine(R, "idle", f.radii, null)
          .sample(1)
          .eyes.map((y) => y.d)
          .join("|"),
      ),
    );
    expect(tailles.size).toBe(1);
  });

  /**
   * The real trap: the correction must be INVISIBLE in motion.
   *
   * What is measured is the OSCILLATION, not the speed. A morph moves the
   * eyes quickly anyway — the expressions do not look at the same place —
   * and that is wanted movement. Jittering is going and COMING BACK. So the
   * direction changes per frame are counted, and compared against the
   * circle, which the correction does not touch.
   */
  it("does not make the eyes oscillate", () => {
    const pas = 1 / 60;

    const trajectoire = (bati: () => BotEngine, duree = BotEngine.SHAPE_MORPH) => {
      const e = bati();
      const out: Array<Array<{ x: number; y: number }>> = [];
      for (let t = 0; t <= duree + pas; t += pas) {
        out.push(
          e.sample(t).eyes.map((eye) => {
            const n = eye.matrix.match(/-?\d+\.?\d*/g)!.map(Number);
            return { x: n[4]!, y: n[5]! };
          }),
        );
      }
      return out;
    };

    /** How many times an eye goes back, and by how much at most. */
    const allersRetours = (suite: Array<Array<{ x: number; y: number }>>) => {
      let n = 0;
      let amplitude = 0;
      const yeux = Math.min(...suite.map((f) => f.length));
      for (let j = 0; j < yeux; j++) {
        let px = 0;
        let py = 0;
        for (let i = 1; i < suite.length; i++) {
          const dx = suite[i]![j]!.x - suite[i - 1]![j]!.x;
          const dy = suite[i]![j]!.y - suite[i - 1]![j]!.y;
          const len = Math.hypot(dx, dy);
          if (len <= 0.05) continue;
          if ((px || py) && dx * px + dy * py < 0) {
            n++;
            amplitude = Math.max(amplitude, len);
          }
          px = dx;
          py = dy;
        }
      }
      return { n, amplitude };
    };

    const cercle = SHAPE_BY_ID.get("cercle")!.radii;
    const morphDeForme = (radii: number[]) =>
      allersRetours(
        trajectoire(() => {
          const e = new BotEngine(R, "idle", cercle, null);
          e.setShape(radii, 0);
          return e;
        }),
      );
    const auRepos = (radii: number[]) =>
      allersRetours(trajectoire(() => new BotEngine(R, "idle", radii, null), 3));
    const morphsDExpression = (radii: number[]) =>
      EXPRESSIONS.map((expr) =>
        allersRetours(
          trajectoire(() => {
            const e = new BotEngine(R, "idle", radii, EXPRESSIONS[0]!);
            e.setExpression(expr, 0);
            return e;
          }),
        ),
      ).reduce(
        (a, b) => ({ n: a.n + b.n, amplitude: Math.max(a.amplitude, b.amplitude) }),
        { n: 0, amplitude: 0 },
      );

    /*
     * On the CIRCLE, nothing at all: the correction is zero there, so it
     * cannot add any movement, and it is the reference for the three
     * comparisons.
     */
    expect(morphsDExpression(cercle).n, "cercle: expression morphs").toBe(0);

    for (const forme of SHAPES) {
      // At rest, the only thing that moves is the gaze drift. A correction
      // that followed it would make the eyes jitter permanently: the most
      // visible defect of all, and the first one we had.
      expect(auRepos(forme.radii).n, `${forme.id}: rest drift`).toBeLessThanOrEqual(
        auRepos(cercle).n + 1,
      );
      // A change of shape moves the offset, but along the same curve as the
      // silhouette: no more back-and-forth than the circle.
      expect(morphDeForme(forme.radii).n, `shape morph to ${forme.id}`).toBeLessThanOrEqual(
        morphDeForme(cercle).n + 1,
      );
      /*
       * A change of expression takes the offset from one table entry to the
       * next. Seven shapes out of eight gain no back-and-forth; the droplet
       * goes from one 6.3-unit rebound — already there without the
       * correction — to two of 11.1. The bound lets that through and
       * nothing more: the faulty versions were at 26.
       */
      expect(
        morphsDExpression(forme.radii).amplitude,
        `${forme.id}: expression morphs`,
      ).toBeLessThan(14);
    }
  });
});

describe("the face descriptor", () => {
  it("falls back to the default for an unknown id", () => {
    expect(normalizeFace({ shape: "nope", color: "bleu", expression: "neutre" })).toEqual({
      ...DEFAULT_FACE,
      color: "bleu",
    });
    expect(normalizeFace(null)).toEqual(DEFAULT_FACE);
    expect(normalizeFace({})).toEqual(DEFAULT_FACE);
  });

  it("keeps a face the catalogue knows", () => {
    expect(
      normalizeFace({ shape: "goutte", color: "vert", expression: "curieux" }),
    ).toEqual({ shape: "goutte", color: "vert", expression: "curieux" });
  });
});
