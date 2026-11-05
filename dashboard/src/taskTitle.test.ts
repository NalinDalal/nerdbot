import { describe, it, expect } from "vitest";
import { taskTitle } from "./taskTitle";

describe("taskTitle", () => {
  it("first non-empty line", () => expect(taskTitle("hello\nworld")).toBe("hello"));
  it("empty", () => expect(taskTitle("")).toBe(""));
  it("yaml huge", () => expect(taskTitle("a".repeat(10000))).toHaveLength(80));
  it("equals line", () => expect(taskTitle("=".repeat(200)).length).toBeLessThanOrEqual(80));
});
