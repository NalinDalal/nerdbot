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

  it("approvals inbox is cross-workspace, and asks can be swept or asked again", async () => {
    ok({ approvals: [{ id: "apr_1", state: "pending" }], state: "pending" });
    const inbox = await api.approvalsInbox("pending");
    expect(inbox.approvals[0].state).toBe("pending");
    expect(seen[0].url).toBe("http://api:8088/approvals?state=pending");

    ok({ closed: [{ approval_id: "apr_1" }], count: 1 });
    const swept = await api.sweepApprovals();
    expect(swept.count).toBe(1);
    expect(seen[1].url).toBe("http://api:8088/approvals/sweep");

    ok({ run: { id: "run_2" }, exit_code: null, artifact_id: null });
    await api.reaskApproval("apr_1");
    expect(seen[2].url).toBe("http://api:8088/approvals/apr_1/reask");
  });

  it("a decision reports what it did to the work", async () => {
    ok({
      id: "apr_1",
      decision: "approved",
      resume: { outcome: "carried_out", output: "created teammate tm_1" },
      idempotent: false,
    });
    const result = await api.decideApproval("apr_1", "approved");
    expect(result.resume?.outcome).toBe("carried_out");
    expect(result.idempotent).toBe(false);
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

  it("notifications failure details: last_error, attempts, lock pass through", async () => {
    ok({
      notifications: [
        {
          id: "ntf_9",
          channel: "webhook-out",
          kind: "ping",
          status: "failed",
          attempts: 3,
          next_attempt_at: null,
          locked: false,
          locked_at: null,
          last_error: "FetchTimeoutError: delivery failed after 3 attempts: timeout",
          created_at: "2026-10-17T00:00:00+00:00",
        },
        {
          id: "ntf_10",
          channel: "webhook-out",
          kind: "ping",
          status: "queued",
          attempts: 1,
          next_attempt_at: "2026-10-17T01:00:00+00:00",
          locked: false,
          locked_at: null,
          last_error: "WebhookDeliveryError: upstream rejected (HTTP 503)",
          created_at: "2026-10-17T00:05:00+00:00",
        },
      ],
    });
    const view = await api.listNotifications("prj_1");
    expect(view.notifications[0]).toMatchObject({
      id: "ntf_9",
      status: "failed",
      attempts: 3,
      last_error: "FetchTimeoutError: delivery failed after 3 attempts: timeout",
    });
    expect(view.notifications[1]).toMatchObject({
      status: "queued",
      next_attempt_at: "2026-10-17T01:00:00+00:00",
      last_error: "WebhookDeliveryError: upstream rejected (HTTP 503)",
    });
  });

  it("sweep results surface reclaimed failures through the contract", async () => {
    ok({
      fired: [
        { id: "ntf_11", status: "failed", attempts: 3, reclaimed: true },
        { id: "ntf_12", status: "delivered", attempts: 2 },
      ],
    });
    const view = await api.sweepWebhooks();
    expect(view.fired[0]).toMatchObject({ reclaimed: true, status: "failed" });
    expect(view.fired[1]).toMatchObject({ status: "delivered" });
  });

  it("events feed filters notification delivery transitions", async () => {
    ok({
      events: [
        {
          id: "evt_1",
          entity: "notification",
          entity_id: "ntf_9",
          event_type: "notification.failed",
          timestamp: "2026-10-17T00:00:00+00:00",
        },
      ],
    });
    const view = await api.projectEvents("prj_1", "notification");
    expect(seen[0].url).toBe(
      "http://api:8088/projects/prj_1/events?entity=notification",
    );
    expect(view.events[0]).toMatchObject({
      entity: "notification",
      event_type: "notification.failed",
    });
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

  it("chat threads + messages", async () => {
    ok({ id: "thr_1" });
    await api.createThread("prj_1", { title: "hi" });
    expect(seen[0]).toMatchObject({ url: "http://api:8088/projects/prj_1/threads", method: "POST" });
    ok({ threads: [{ id: "thr_1" }] });
    await api.listThreads("prj_1");
    expect(seen[1].url).toBe("http://api:8088/projects/prj_1/threads");
    ok({ id: "thr_1" });
    await api.updateThread("thr_1", { provider_id: "prv_1" });
    expect(seen[2].body).toMatchObject({ provider_id: "prv_1" });
    ok({ thread: { id: "thr_1" }, messages: [] });
    await api.threadView("thr_1", 10, "msg_9");
    expect(seen[3].url).toBe("http://api:8088/threads/thr_1?limit=10&before=msg_9");
    ok({ id: "msg_1" });
    await api.appendMessage("thr_1", "user", "hello");
    expect(seen[4].body).toMatchObject({ role: "user", content: "hello" });
  });

  it("chat send returns message + provenance", async () => {
    ok({ message: { id: "msg_2", content: "hi" }, provider_id: "prv_1", memory_used: [] });
    const result = await api.sendChat("thr_1", "hello");
    expect(seen[0].url).toBe("http://api:8088/threads/thr_1/chat");
    expect(result.message.content).toBe("hi");
  });

  it("chat stream reassembles chunks", async () => {
    const payload =
      'data: {"text": "Hel"}\n\n' + 'data: {"text": "lo"}\n\n' + "data: [DONE]\n\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, body: stream }) as Response),
    );
    const chunks: string[] = [];
    const full = await api.sendChatStream("thr_1", "hi", (text) => chunks.push(text));
    expect(full).toBe("Hello");
    expect(chunks).toEqual(["Hel", "lo"]);
  });

  it("chat stream surfaces server errors", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"error": "boom"}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, body: stream }) as Response),
    );
    await expect(api.sendChatStream("thr_1", "hi", () => {})).rejects.toMatchObject({
      detail: "boom",
    });
  });

  it("chat stream stops when aborted, mapping abort to Stream stopped", async () => {
    let abortStream: (() => void) | null = null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"text": "par"}\n\n'));
        abortStream = () => {
          const abortErr = new Error("The operation was aborted");
          abortErr.name = "AbortError";
          controller.error(abortErr);
        };
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        // A real browser/undici rejects in-flight reads when the signal aborts.
        const signal = init.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => abortStream?.(), { once: true });
        return { ok: true, status: 200, body: stream } as Response;
      }),
    );
    const chunks: string[] = [];
    const controller = new AbortController();
    const pending = api.sendChatStream("thr_1", "hi", (text) => chunks.push(text), {
      signal: controller.signal,
    });
    // Let the reader attach and absorb the first chunk before aborting.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(chunks).toContain("par");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0, detail: "Stream stopped" });
    expect(chunks).toEqual(["par"]);
  });

  it("thread summarize action", async () => {
    ok({ id: "thr_1", summary: "tea talk" });
    const thread = await api.summarizeThread("thr_1");
    expect(seen[seen.length - 1].url).toBe("http://api:8088/threads/thr_1/summarize");
    expect(thread.summary).toBe("tea talk");
  });

  it("home route parses to chat", async () => {
    vi.stubGlobal("window", { location: { hash: "" } });
    const { parseHash } = await import("./app");
    const setHash = (hash: string) => {
      (window.location as { hash: string }).hash = hash;
      return parseHash();
    };
    expect(setHash("")).toEqual({ name: "home" });
    expect(setHash("#/")).toEqual({ name: "home" });
    expect(setHash("#/projects")).toEqual({ name: "projects" });
    expect(setHash("#/nope")).toEqual({ name: "home" });
    vi.unstubAllGlobals();
  });

  it("a workspace route carries the tab to open", async () => {
    vi.stubGlobal("window", { location: { hash: "" } });
    const { parseHash } = await import("./app");
    const setHash = (hash: string) => {
      (window.location as { hash: string }).hash = hash;
      return parseHash();
    };
    // A recovery link must land on the exact tab, not just the workspace.
    expect(setHash("#/p/prj_1?tab=Providers")).toEqual({
      name: "project",
      projectId: "prj_1",
      tab: "Providers",
    });
    // No query means no tab, and the id is never polluted by the query.
    expect(setHash("#/p/prj_1")).toEqual({
      name: "project",
      projectId: "prj_1",
      tab: undefined,
    });
    // A task route still wins over the query.
    expect(setHash("#/p/prj_1/t/tsk_2")).toEqual({
      name: "task",
      projectId: "prj_1",
      taskId: "tsk_2",
    });
    vi.unstubAllGlobals();
  });
});

describe("BYOK client surface (S1)", () => {
  it("patchProvider PATCHes with partial body", async () => {
    ok({ id: "prv_1" });
    const out = await api.patchProvider("prv_1", { status: "disabled" });
    expect(out).toEqual({ id: "prv_1" });
    const call = seen[0];
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe("http://api:8088/providers/prv_1");
    expect(call.auth).toBe("Bearer tok-123");
    expect(call.body).toEqual({ status: "disabled" });
  });

  it("providerModels GETs the catalog", async () => {
    ok({ models: ["openai/gpt-oss-120b"] });
    const out = await api.providerModels("prv_1");
    expect(out.models).toEqual(["openai/gpt-oss-120b"]);
    const call = seen[0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe("http://api:8088/providers/prv_1/models");
  });

  it("patchTeammate PATCHes provider attachment (null detaches)", async () => {
    ok({ id: "tm_1" });
    await api.patchTeammate("tm_1", { provider_id: null });
    const call = seen[0];
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe("http://api:8088/teammates/tm_1");
    expect(call.body).toEqual({ provider_id: null });
  });
});
