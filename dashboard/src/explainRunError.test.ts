import { describe, it, expect } from "vitest";
import { explainRunError } from "./explainRunError";

const NO_COMMAND = { command: "", project_id: "prj_x" };
const EMPTY_COMMAND_RUN = { stderr: "", output_excerpt: "empty command" };

describe("explainRunError", () => {
  it("empty command on a command-less task → guidance message with tab links", () => {
    const explained = explainRunError(NO_COMMAND, EMPTY_COMMAND_RUN);
    expect(explained.message).toBe(
      "Nothing ran: the shell runtime got no command. If this task should run on a model, attach one to the owner and enable a provider.",
    );
    expect(explained.actions).toEqual([
      { label: "Open the Teammates tab", href: "/p/prj_x?tab=Teammates" },
      { label: "Open the Providers tab", href: "/p/prj_x?tab=Providers" },
    ]);
  });

  it("a whitespace-only command still counts as no command", () => {
    const explained = explainRunError({ command: "  ", project_id: "prj_x" }, EMPTY_COMMAND_RUN);
    expect(explained.actions).toHaveLength(2);
  });

  it("the same error on a task WITH a command passes through unchanged", () => {
    const explained = explainRunError({ command: "echo hi", project_id: "prj_x" }, EMPTY_COMMAND_RUN);
    expect(explained.message).toBe("empty command");
    expect(explained.actions).toEqual([]);
  });

  it("unknown errors pass through unchanged, no actions", () => {
    const run = { stderr: "git: not found", output_excerpt: "" };
    expect(explainRunError(NO_COMMAND, run)).toEqual({
      message: "git: not found",
      actions: [],
    });
  });

  it("stderr wins when both fields carried text", () => {
    const run = { stderr: "exit 1", output_excerpt: "empty command" };
    const explained = explainRunError(NO_COMMAND, run);
    expect(explained.message).toBe("exit 1");
    expect(explained.actions).toEqual([]);
  });

  it("no error text → empty message so callers show nothing", () => {
    expect(explainRunError(NO_COMMAND, { stderr: "  ", output_excerpt: "" })).toEqual({
      message: "",
      actions: [],
    });
  });
});
