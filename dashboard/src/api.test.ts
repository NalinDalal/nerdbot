import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, setSession } from "./api";

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

let seen: Seen[];
let queue: Array<{ status: number; body: unknown }>;

function mockFetch() {
  seen = [];
  queue = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push({
        url,
        method: init.method ?? "GET",
        auth: (init.headers as Record<string, string>)?.Authorization ?? null,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = queue.shift() ?? { status: 200, body: {} };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
      } as Response;
    }),
  );
}

function ok(body: unknown = {}) {
  queue.push({ status: 200, body });
  return body;
}

beforeEach(() => {
  mockFetch();
  setSession({ baseUrl: "http://api:8088/", token: "tok-123" });
});

describe("session and errors", () => {
  it("requires a session before any request", async () => {
    setSession(null);
    await expect(api.health()).rejects.toMatchObject({ status: 0 });
    setSession({ baseUrl: "http://api:8088", token: "tok-123" });
  });

  it("sends the bearer token and base URL", async () => {
    ok({ status: "ok" });
    await api.health();
    expect(seen[0]).toMatchObject({
      url: "http://api:8088/health",
      method: "GET",
      auth: "Bearer tok-123",
    });
  });

  it("surfaces server detail on errors", async () => {
    queue.push({ status: 403, body: { detail: "nope" } });
    await expect(api.health()).rejects.toMatchObject({ status: 403, detail: "nope" });
  });
});

describe("views", () => {
  it("health view", async () => {
    ok({ status: "ok" });
    await api.health();
    expect(seen[0].url).toBe("http://api:8088/health");
  });

  it("capabilities view", async () => {
    ok({ capabilities: [] });
    await api.capabilities();
    expect(seen[0].url).toBe("http://api:8088/capabilities");
  });

  it("project create", async () => {
    ok({ id: "prj_1" });
    await api.createProject("demo");
    expect(seen[0]).toMatchObject({
      url: "http://api:8088/projects",
      method: "POST",
      auth: "Bearer tok-123",
    });
    expect(seen[0].body).toMatchObject({ repository: "demo" });
  });

  it("teammates view", async () => {
    ok({ teammates: [] });
    await api.listTeammates("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/teammates");
  });

  it("teammate create/disable", async () => {
    ok({ id: "tm_1" });
    await api.createTeammate("prj_1", { persona: "coder" });
    expect(seen[0].method).toBe("POST");
    ok({ id: "tm_1" });
    await api.disableTeammate("tm_1");
    expect(seen[1].url).toBe("http://api:8088/teammates/tm_1/disable");
  });

  it("task create + task detail view", async () => {
    ok({ id: "tsk_1" });
    await api.createTask("prj_1", { description: "fix it", command: "echo ok" });
    expect(seen[0].body).toMatchObject({ description: "fix it" });
    ok({ task: { id: "tsk_1" }, runs: [], artifacts: [] });
    const view = await api.taskView("tsk_1");
    expect(seen[1].url).toBe("http://api:8088/tasks/tsk_1");
    expect(view.task.id).toBe("tsk_1");
  });

  it("run + retry actions", async () => {
    ok({ run: { id: "run_1" } });
    await api.runTask("tsk_1");
    expect(seen[0].url).toBe("http://api:8088/tasks/tsk_1/runs");
    ok({ run: { id: "run_2" } });
    await api.retryTask("tsk_1");
    expect(seen[1].url).toBe("http://api:8088/tasks/tsk_1/retry");
  });

  it("runs table + run detail + artifact views", async () => {
    ok({ runs: [] });
    await api.projectRuns("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/runs");
    ok({ run: { id: "run_1" }, artifacts: [] });
    await api.getRun("run_1");
    expect(seen[1].url).toBe("http://api:8088/runs/run_1");
    ok({ id: "art_1" });
    await api.getArtifact("art_1");
    expect(seen[2].url).toBe("http://api:8088/artifacts/art_1");
  });

  it("approvals inbox + decide + purge", async () => {
    ok({ id: "apr_1" });
    await api.requestApproval("run_1", "deploy");
    expect(seen[0].url).toBe("http://api:8088/runs/run_1/approvals");
    ok({ id: "apr_1", decision: "approved" });
    await api.decideApproval("apr_1", "approved");
    expect(seen[1].body).toMatchObject({ decision: "approved" });
    ok({ purged: 2 });
    await api.purgeApprovals("prj_1");
    expect(seen[2].url).toBe("http://api:8088/projects/prj_1/approvals/purge");
  });

  it("providers view + create with secrets", async () => {
    ok({ providers: [{ id: "prv_1", config: { api_key: "[redacted]" } }] });
    const list = await api.listProviders("prj_1");
    expect(list.providers[0].config).toMatchObject({ api_key: "[redacted]" });
    ok({ id: "prv_2" });
    await api.createProvider("prj_1", { kind: "mock", config: { api_key: "SECRET" } });
    expect(seen[1].body).toMatchObject({ kind: "mock" });
  });

  it("knowledge view + search + attach", async () => {
    ok({ sources: [] });
    await api.listKnowledge("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/knowledge");
    ok({ citations: [] });
    await api.searchKnowledge("tsk_1", "red button");
    expect(seen[1].body).toMatchObject({ query: "red button" });
    ok({ artifact_id: "art_9" });
    await api.attachKnowledge("tsk_1", "red button");
    expect(seen[2].url).toBe("http://api:8088/tasks/tsk_1/knowledge/attach");
  });

  it("schedules view + fire", async () => {
    ok({ schedules: [] });
    await api.listSchedules("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/schedules");
    ok({ id: "sch_1" });
    await api.createSchedule("prj_1", { name: "n", cron: "* * * * *", task_template: {} });
    expect(seen[1].method).toBe("POST");
    ok({ run_id: "run_3" });
    await api.fireSchedule("sch_1");
    expect(seen[2].url).toBe("http://api:8088/schedules/sch_1/fire");
  });

  it("notifications view + deliver + sweep + targets", async () => {
    ok({ notifications: [] });
    await api.listNotifications("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/notifications");
    ok({ id: "ntf_1", status: "delivered" });
    await api.deliverNotification("ntf_1");
    expect(seen[1].url).toBe("http://api:8088/notifications/ntf_1/deliver");
    ok({ fired: [] });
    await api.sweepWebhooks();
    expect(seen[2].url).toBe("http://api:8088/webhooks/sweep");
    ok({ targets: [] });
    await api.listWebhookTargets("prj_1");
    expect(seen[3].url).toBe("http://api:8088/projects/prj_1/webhook-targets");
  });

  it("issues view + github preview + ingress", async () => {
    ok({ issues: [] });
    await api.listIssues("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/issues");
    ok({ title: "T", suggested_ingest: {} });
    await api.previewGithubIssue("prj_1", "o/r", 7);
    expect(seen[1].body).toMatchObject({ repository: "o/r", number: 7 });
    ok({ issue: {}, task: {} });
    await api.ingestInbound("prj_1", { title: "ping" });
    expect(seen[2].url).toBe("http://api:8088/projects/prj_1/ingress");
  });

  it("memory view", async () => {
    ok({ entries: [] });
    await api.projectMemory("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/memory");
    ok({ id: "mem_1" });
    await api.writeProjectMemory("prj_1", { content: "x", source: "note" });
    expect(seen[1].method).toBe("POST");
  });

  it("events view", async () => {
    ok({ events: [] });
    await api.projectEvents("prj_1", "run");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/events?entity=run");
  });

  it("backup export + validate + import", async () => {
    ok({ version: 1 });
    await api.exportBackup("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/backup");
    ok({ valid: true, errors: [] });
    await api.validateBackup("prj_1", { version: 1 });
    expect(seen[1].url).toBe("http://api:8088/projects/prj_1/backup/validate");
    ok({ imported: {}, rejected: [] });
    await api.importBackup("prj_1", { version: 1 }, true);
    expect(seen[2].body).toMatchObject({ dry_run: true });
  });

  it("metrics view", async () => {
    ok({ runs_total: 0 });
    await api.projectMetrics("prj_1");
    expect(seen[0].url).toBe("http://api:8088/projects/prj_1/metrics");
  });

  it("review + patch + package + rollup actions", async () => {
    ok({ review: { id: "rev_1" } });
    await api.submitReview("tsk_1", { reviewer_teammate_id: "tm_2", verdict: "accepted" });
    expect(seen[0].url).toBe("http://api:8088/tasks/tsk_1/reviews");
    ok({ artifact_id: "art_p" });
    await api.capturePatch("tsk_1", "run_1");
    expect(seen[1].body).toMatchObject({ run_id: "run_1" });
    ok({ id: "prp_1" });
    await api.generatePackage("tsk_1", { title: "Fix" });
    expect(seen[2].url).toBe("http://api:8088/tasks/tsk_1/pr-package");
    ok({ id: "apr_2" });
    await api.requestPackageApproval("tsk_1");
    expect(seen[3].url).toBe("http://api:8088/tasks/tsk_1/package-approval");
  });

  it("workspace actions", async () => {
    ok({ path: "/w", branch: "nb/t" });
    await api.ensureWorkspace("tsk_1");
    expect(seen[0].url).toBe("http://api:8088/tasks/tsk_1/workspace");
    ok({ removed: true });
    await api.deleteWorkspace("tsk_1");
    expect(seen[1].method).toBe("DELETE");
  });
});
