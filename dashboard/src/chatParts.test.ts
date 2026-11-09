import { describe, it, expect } from "vitest";
import { partKind, isTaskProposal } from "./chatParts";

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
