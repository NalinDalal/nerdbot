/**
 * What a bot's face does for a status, and what a bot is doing right now.
 *
 * The mapping is read at a glance and at twenty-eight pixels, so these tests
 * check the READING rather than the exact state id where the id is an
 * implementation detail: a status that wants the owner's answer must get the
 * pip, one that needs attention must get the exclamation, and the rest must
 * rest. The activity tests check the priority order, because that is where a
 * bug shows up as a bot that looks busy while it is actually stuck.
 */

import { describe, expect, it } from "vitest";
import { botActivity, faceStateFor } from "./status";

describe("the pose a status earns", () => {
  it("turns a working bot into a spinning body", () => {
    expect(faceStateFor("running")).toBe("orbit");
  });

  it("turns a waiting bot into three dots", () => {
    expect(faceStateFor("queued")).toBe("thinking");
    expect(faceStateFor("pending")).toBe("thinking");
    // `ready` is a task waiting for its executor, not a finished one.
    expect(faceStateFor("ready")).toBe("thinking");
  });

  it("gives the owner's move the notification pip", () => {
    expect(faceStateFor("awaiting_approval")).toBe("notify");
  });

  it("turns anything stopped or broken into the exclamation", () => {
    for (const status of ["blocked", "failed", "denied", "rejected", "expired", "error"]) {
      expect(faceStateFor(status), status).toBe("alert");
    }
  });

  it("winks at something finished", () => {
    expect(faceStateFor("done")).toBe("wink");
    expect(faceStateFor("succeeded")).toBe("wink");
  });

  it("puts a bot that is off to sleep", () => {
    for (const status of ["disabled", "archived", "cancelled", "stopped"]) {
      expect(faceStateFor(status), status).toBe("sleep");
    }
  });

  it("rests for an active bot and for anything it does not know", () => {
    expect(faceStateFor("active")).toBe("idle");
    expect(faceStateFor(undefined)).toBe("idle");
    expect(faceStateFor(null)).toBe("idle");
    expect(faceStateFor("something-new")).toBe("idle");
  });
});

describe("what a bot is doing", () => {
  it("rests when nothing is in flight", () => {
    expect(botActivity("active", [{ status: "done" }], [{ status: "succeeded" }])).toBe("active");
  });

  it("reports the disabled state of a bot with no work", () => {
    expect(botActivity("disabled", [])).toBe("disabled");
  });

  it("reads a running task or a running run", () => {
    expect(botActivity("active", [{ status: "running" }])).toBe("running");
    expect(botActivity("active", [], [{ status: "running" }])).toBe("running");
  });

  it("puts an unanswered approval above everything else", () => {
    // Work in flight does not excuse an approval nobody has answered: the
    // owner is the blocker, and the face should say so.
    const tasks = [{ status: "running" }, { status: "awaiting_approval" }];
    expect(botActivity("active", tasks)).toBe("awaiting_approval");
  });

  it("reports a blocked task", () => {
    expect(botActivity("active", [{ status: "blocked" }])).toBe("blocked");
  });

  it("does not read failures out of the run history", () => {
    // Run history keeps every failure a bot ever had. A bot that failed once
    // must not look alarmed forever: only the tasks — which a human retries —
    // and a run that is running now are read.
    const history = [{ status: "failed" }, { status: "blocked" }];
    expect(botActivity("active", [{ status: "done" }], history)).toBe("active");
    expect(botActivity("active", [], [{ status: "failed" }])).toBe("active");
  });

  it("reports a queue, and keeps its two kinds apart", () => {
    // The dot sits next to a badge that says the exact status; saying a
    // different one word would read as a contradiction.
    expect(botActivity("active", [{ status: "pending" }])).toBe("queued");
    expect(botActivity("active", [{ status: "ready" }])).toBe("ready");
  });

  it("leaves the owner's approval above a queue", () => {
    const tasks = [{ status: "ready" }, { status: "awaiting_approval" }];
    expect(botActivity("active", tasks)).toBe("awaiting_approval");
  });
});
