import { describe, it, expect } from "vitest";
import { taskTitle, taskPreview } from "./taskTitle";

describe("taskTitle", () => {
  it("first non-empty line", () => expect(taskTitle("hello\nworld")).toBe("hello"));
  it("empty", () => expect(taskTitle("")).toBe(""));
  it("yaml huge", () => expect(taskTitle("a".repeat(10000))).toHaveLength(80));
  it("equals line", () => expect(taskTitle("=".repeat(200)).length).toBeLessThanOrEqual(80));
});

describe("taskPreview", () => {
  it("skips separator lines and returns the first meaningful text", () => {
    const description = "---\n===\n***\n   \nDeploy the build\nthen verify";
    expect(taskPreview(description)).toBe("Deploy the build");
  });

  it("persona YAML: title line followed by a wall of '# ===' separators", () => {
    const description = [
      "create other bots please:",
      `# ${"=".repeat(70)}`,
      "# nerdbot-personas-v3.yaml",
      "# Full persona configuration for the DriftLock organization.",
    ].join("\n");
    expect(taskTitle(description)).toBe("create other bots please:");
    expect(taskPreview(description)).toBe("nerdbot-personas-v3.yaml");
  });

  it("line of '=' alone is a separator, not the preview", () => {
    expect(taskPreview("Fix login flow\n==========\nbcrypt compare was inverted")).toBe(
      "bcrypt compare was inverted",
    );
  });

  it("repeats of the title line are skipped so the preview is new text", () => {
    expect(taskPreview("Ship the fix\nShip the fix later")).toBe("Ship the fix later");
  });

  it("empty when nothing is meaningful", () => {
    expect(taskPreview("")).toBe("");
    expect(taskPreview("===\n---\n###\n   ")).toBe("");
  });

  it("clamps long previews to ~100 chars ending with an ellipsis", () => {
    const preview = taskPreview("title\n" + "b".repeat(300));
    expect(preview.length).toBe(100);
    expect(preview.endsWith("…")).toBe(true);
  });
});
