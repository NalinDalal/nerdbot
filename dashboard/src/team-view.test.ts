import { describe, it, expect } from "vitest";
import { deriveMemberState } from "./team-view";

describe("deriveMemberState", () => {
  it("idle when no current task", () => {
    expect(deriveMemberState({ failed: 0 })).toBe("idle");
  });
  it("working when running", () => {
    expect(deriveMemberState({ current: { status: "running" }, failed: 0 })).toBe("working");
  });
  it("failed when failed count > 0", () => {
    expect(deriveMemberState({ failed: 1 })).toBe("failed");
  });
  it("waiting_approval when pending", () => {
    expect(deriveMemberState({ current: { status: "pending" }, failed: 0 })).toBe("waiting_approval");
  });
});
