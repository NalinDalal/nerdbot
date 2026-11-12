import { describe, it, expect } from "vitest";
import { partKind, isTaskProposal, executionStages } from "./chatParts";

describe("chatParts", () => {
  it("identifies report parts", () => {
    expect(partKind({ type: "report", title: "r", content: "x" })).toBe("report");
  });
  it("identifies task proposals", () => {
    const p = { type: "task", proposal: { title: "t", proposal_id: "prp_1" } };
    expect(partKind(p)).toBe("task");
    expect(isTaskProposal(p)).toBe(true);
  });
  it("marks accepted tasks as not proposals", () => {
    const p = { type: "task", proposal: { title: "t", proposal_id: "prp_1" }, task_id: "tsk_1" };
    expect(isTaskProposal(p)).toBe(false);
  });
  it("falls back to unknown", () => {
    expect(partKind({ type: "foo" })).toBe("unknown");
    expect(partKind({})).toBe("unknown");
  });
});


describe("executionStages", () => {
  it("derives observed task lifecycle states without fabrication", () => {
    const stages = executionStages({ status: "running", owner_teammate_id: "bot1" }, { status: "running" });
    expect(stages[0].state).toBe("done");
    expect(stages[1].state).toBe("done");
    expect(stages[2].state).toBe("active");
    expect(stages[4].state).toBe("pending");
  });

  it("marks failure and review states from actual data", () => {
    const failed = executionStages({ status: "failed", owner_teammate_id: "bot1" }, { status: "failed" });
    expect(failed[2].state).toBe("error");
    expect(failed[4].state).toBe("error");
    const review = executionStages({ status: "awaiting_approval", owner_teammate_id: "bot1", blocked_reason: "Needs approval" }, {});
    expect(review[3].state).toBe("warn");
    expect(review[3].detail).toContain("Needs approval");
  });
});
