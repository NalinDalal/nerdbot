/**
 * The shared animation loop.
 *
 * The loop takes its scheduler as an argument, so these tests step it a frame
 * at a time and read the clock back. What they lock is the contract the
 * avatars depend on: one frame request in flight however many faces are
 * subscribed, a clock that cannot jump, and a loop that stops when the last
 * face leaves.
 */

import { describe, expect, it } from "vitest";
import { MAX_DT, createTicker } from "./ticker";

/**
 * A scheduler that keeps its callbacks instead of running them, so a test can
 * decide when a frame happens and how much time has passed.
 */
function fakeFrames() {
  const pending = new Map<number, (ms: number) => void>();
  const cancelled: number[] = [];
  let next = 0;
  return {
    pending,
    cancelled,
    scheduler: {
      request(callback: (ms: number) => void) {
        next += 1;
        pending.set(next, callback);
        return next;
      },
      cancel(handle: number) {
        cancelled.push(handle);
        pending.delete(handle);
      },
    },
    /** Run every frame the browser would run at this instant. */
    frame(ms: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(ms);
    },
  };
}

describe("the shared animation loop", () => {
  it("asks for one frame however many faces are subscribed", () => {
    const frames = fakeFrames();
    const ticker = createTicker(frames.scheduler);
    ticker.subscribe(() => {});
    ticker.subscribe(() => {});
    ticker.subscribe(() => {});

    // Three avatars, one animation. This is the whole point of the loop.
    expect(frames.pending.size).toBe(1);
    expect(ticker.subscribers()).toBe(3);
  });

  it("hands every face the same clock", () => {
    const frames = fakeFrames();
    const ticker = createTicker(frames.scheduler);
    const seen: number[][] = [[], []];
    ticker.subscribe((t) => seen[0]!.push(t));
    ticker.subscribe((t) => seen[1]!.push(t));

    frames.frame(0);
    frames.frame(16);

    expect(seen[0]).toEqual([0, 0.016]);
    expect(seen[1]).toEqual(seen[0]);
  });

  it("starts the clock at zero", () => {
    const ticker = createTicker(fakeFrames().scheduler);
    expect(ticker.now()).toBe(0);
  });

  it("does not jump when a backgrounded tab comes back", () => {
    const frames = fakeFrames();
    const ticker = createTicker(frames.scheduler);
    ticker.subscribe(() => {});

    frames.frame(0);
    frames.frame(16);
    // A hidden tab's frames are suspended, so the gap is not a frame's worth
    // of time. Stepping by it would send a face forward by minutes.
    frames.frame(60_000);

    expect(ticker.now()).toBeCloseTo(0.016 + MAX_DT, 6);
  });

  it("stops the loop when the last face leaves", () => {
    const frames = fakeFrames();
    const ticker = createTicker(frames.scheduler);
    const leave = ticker.subscribe(() => {});

    leave();

    expect(ticker.subscribers()).toBe(0);
    expect(frames.pending.size).toBe(0);
    expect(frames.cancelled).toHaveLength(1);
  });

  it("restarts for a new face without counting the idle spell", () => {
    const frames = fakeFrames();
    const ticker = createTicker(frames.scheduler);
    const leave = ticker.subscribe(() => {});
    frames.frame(0);
    frames.frame(16);
    leave();

    const seen: number[] = [];
    ticker.subscribe((t) => seen.push(t));
    // However long the page sat with nothing animating, the face resumes
    // where the clock stopped.
    frames.frame(90_000);

    expect(seen).toEqual([0.016]);
    expect(frames.pending.size).toBe(1);
  });

  it("lets a face join a loop that is already running", () => {
    const frames = fakeFrames();
    const ticker = createTicker(frames.scheduler);
    ticker.subscribe(() => {});
    frames.frame(0);
    frames.frame(16);

    const seen: number[] = [];
    ticker.subscribe((t) => seen.push(t));
    frames.frame(32);

    // Not zero: a late joiner shares the loop rather than starting its own.
    expect(seen).toEqual([0.032]);
  });
});
