/**
 * The "Surprise me" draw.
 *
 * The button has one job: never to look broken. So the tests pin the two
 * things a user can observe — the draw comes from the catalogue, and pressing
 * it on the face already on screen still changes something.
 */

import { describe, expect, it } from "vitest";
import {
  COLOR_IDS,
  DEFAULT_FACE,
  EXPRESSION_IDS,
  SHAPE_IDS,
  randomFace,
} from "./face";

/** A sequence that repeats, so a draw is a fixed example rather than a coin. */
function sequence(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("a random face", () => {
  it("draws every field from the catalogue", () => {
    // Walked across the whole unit interval, so the edges are covered too.
    for (let i = 0; i <= 20; i += 1) {
      const face = randomFace(sequence([i / 20]));
      expect(SHAPE_IDS).toContain(face.shape);
      expect(COLOR_IDS).toContain(face.color);
      expect(EXPRESSION_IDS).toContain(face.expression);
    }
  });

  it("is repeatable when the source is", () => {
    const draw = () => randomFace(sequence([0.1, 0.5, 0.9]));
    expect(draw()).toEqual(draw());
  });

  it("takes the first of each catalogue from the bottom of the interval", () => {
    // `rng` returning 0 must not fall off the front of a list.
    const face = randomFace(() => 0);
    expect(face).toEqual(DEFAULT_FACE);
  });

  it("changes the face already on screen", () => {
    // A surprise that returns the same face reads as a button that does
    // nothing, which is the one outcome worth a special case.
    const face = randomFace(() => 0, DEFAULT_FACE);
    expect(face.shape).toBe(DEFAULT_FACE.shape);
    expect(face.expression).toBe(DEFAULT_FACE.expression);
    expect(face.color).not.toBe(DEFAULT_FACE.color);
    expect(COLOR_IDS).toContain(face.color);
  });

  it("leaves a different face alone", () => {
    const face = randomFace(() => 0, { shape: "triangle", color: "violet", expression: "hilare" });
    expect(face).toEqual(DEFAULT_FACE);
  });
});
