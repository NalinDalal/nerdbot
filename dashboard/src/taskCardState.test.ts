import { describe, it, expect } from "vitest";
import { deriveTaskCardState } from "./taskCardState";

describe("deriveTaskCardState", () => {
  it("proposed when no task", () => {
    expect(deriveTaskCardState(null, null).state).toBe("proposed");
  });
  it("queued after create", () => {
    expect(deriveTaskCardState({ status: "pending" }, null).state).toBe("queued");
  });
  it("failed shows reason", () => {
    const r = deriveTaskCardState({ status: "failed" }, { status: "failed", stderr: "boom" });
    expect(r.state).toBe("failed");
    expect(r.reason).toBe("boom");
  });
});
