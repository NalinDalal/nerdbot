import { describe, expect, it } from "vitest";
import { computeWorkspaceOverviewModel, observedAgentState } from "./overview";
import type { Approval, GalleryAsset, LibraryDoc, Run, Task, Teammate } from "../types";

const ok = <T,>(value: T) => ({ ok: true as const, value });
const err = (error = new Error("boom")) => ({ ok: false as const, error });

const baseTask = (over: Partial<Task> & { id: string; status: string }): Task => ({
  id: over.id,
  project_id: "p1",
  description: over.description ?? "task",
  status: over.status,
  owner_teammate_id: over.owner_teammate_id ?? null,
  dependencies: [],
  command: "",
  issue_id: null,
  branch: "",
  workspace_path: "",
  workspace_mode: "checkout",
  board_id: "",
  parent_task_id: "",
  blocked_reason: over.blocked_reason ?? "",
  title: over.title,
});

const teammate = (over: Partial<Teammate> & { id: string }): Teammate => {
  const base: Teammate = {
    id: over.id,
    project_id: "p1",
    slug: over.id,
    name: "",
    persona: "Agent",
    instructions: "",
    capabilities: [],
    memory_scope: "project",
    permissions: [],
    status: "active",
    tool_policy: {},
    provider_id: null,
    model: "",
    temperature: null,
    max_tokens: null,
    context_limit: null,
    fallback_provider_id: null,
    fallback_model: "",
    face: { shape: "blob", color: "blue", expression: "neutral" },
  };
  return { ...base, ...over };
};

describe("workspace overview model", () => {
  it("returns populated slices and no failed sources when all loads succeed", () => {
    const model = computeWorkspaceOverviewModel({
      tasks: ok({ tasks: [baseTask({ id: "t1", status: "running", description: "Run work" })] }),
      runs: ok({ runs: [] as Run[] }),
      teammates: ok({ teammates: [teammate({ id: "a1", persona: "Builder" })] }),
      approvals: ok({ approvals: [] as Approval[] }),
      library: ok({ docs: [{ id: "d1", project_id: "p1", kind: "doc", title: "Report", content: "", source: "note", teammate_id: "", tainted: false, version: 1, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" } as LibraryDoc] }),
      gallery: ok({ assets: [{ id: "g1", project_id: "p1", name: "shot.png", mime_type: "image/png", size: 1, source: "upload", created_at: "2026-01-03T00:00:00Z" } as GalleryAsset] }),
    });
    expect(model.failedSources).toEqual([]);
    expect(model.runningTasks.map((t) => t.id)).toEqual(["t1"]);
    expect(model.deliverables.map((d) => d.name)).toEqual(["shot.png", "Report"]);
    expect(model.teammates).toHaveLength(1);
  });

  it("preserves partial data and records failed sources on partial errors", () => {
    const model = computeWorkspaceOverviewModel({
      tasks: ok({ tasks: [baseTask({ id: "t1", status: "failed", description: "Broken" })] }),
      runs: err(),
      teammates: err(),
      approvals: ok({ approvals: [{ id: "ap1", run_id: "r1", board_id: null, project_id: "p1", action: "deploy", requester: "bot", decision: "pending", decided_at: null, expires_at: null, consumed_at: null, task_id: "t1", digest: null, executed_at: null } as Approval] }),
      library: ok({ docs: [] as LibraryDoc[] }),
      gallery: err(),
    });
    expect(model.failedSources).toEqual(["runs", "agents", "gallery"]);
    expect(model.failedTasks).toHaveLength(1);
    expect(model.attentionApprovals).toHaveLength(1);
    expect(model.deliverables).toEqual([]);
    expect(model.teammates).toEqual([]);
  });

  it("handles fully empty workspace without fabricating activity", () => {
    const model = computeWorkspaceOverviewModel({
      tasks: ok({ tasks: [] as Task[] }),
      runs: ok({ runs: [] as Run[] }),
      teammates: ok({ teammates: [] as Teammate[] }),
      approvals: ok({ approvals: [] as Approval[] }),
      library: ok({ docs: [] as LibraryDoc[] }),
      gallery: ok({ assets: [] as GalleryAsset[] }),
    });
    expect(model.runningTasks).toHaveLength(0);
    expect(model.queuedTasks).toHaveLength(0);
    expect(model.blockedTasks).toHaveLength(0);
    expect(model.failedTasks).toHaveLength(0);
    expect(model.attentionApprovals).toHaveLength(0);
    expect(model.deliverables).toHaveLength(0);
    expect(model.failedSources).toHaveLength(0);
  });
});

describe("observedAgentState", () => {
  it("distinguishes observed execution from missing assignment data", () => {
    const tasks = [baseTask({ id: "t1", status: "running", owner_teammate_id: "a1", description: "x" })];
    expect(observedAgentState("a1", tasks).label).toBe("Working now");
    expect(observedAgentState("a2", tasks).label).toBe("No active assignment observed");
  });

  it("reports blocked and failed states from real tasks", () => {
    expect(observedAgentState("a1", [baseTask({ id: "t1", status: "awaiting_approval", owner_teammate_id: "a1" })]).label).toBe("Blocked");
    expect(observedAgentState("a1", [baseTask({ id: "t1", status: "failed", owner_teammate_id: "a1" })]).label).toBe("Needs review");
  });
});
