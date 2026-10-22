/**
 * The reduced-motion preference.
 *
 * The avatar asks this before it starts a loop. These tests cover the three
 * states that matter: no `matchMedia` at all (a test runner, an old browser),
 * a system that asked for less motion, and one that did not.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "./motion";

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the reduced-motion preference", () => {
  it("allows motion when there is nothing to ask", () => {
    // The node environment has no window: motion is not refused by default.
    expect(prefersReducedMotion()).toBe(false);
  });

  it("honours a system that asked for less motion", () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("allows motion when the system did not ask", () => {
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});
