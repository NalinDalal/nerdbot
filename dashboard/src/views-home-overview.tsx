import { useMemo, useState } from "react";
import { api } from "./api";
import { navigate } from "./app";
import {
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Page,
  PageHeader,
  PageSection,
  relativeTime,
  useAsync,
} from "./components";
import { useWorkspaceSummary } from "./views-home";
import type { LibraryDoc, Task } from "./types";

type RecentWorkspace = {
  id: string;
  name: string;
  detail: string;
  href: string;
};

type UnfinishedItem = {
  id: string; // stable task id
  key: string;
  title: string;
  state: string;
  detail: string;
  href: string;
};

function taskStateLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "awaiting_approval":
      return "Awaiting approval";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    default:
      return status.replace(/_/g, " ");
  }
}

function lastHappeningForWorkspace(args: {
  activeRunTask?: Task | null;
  tasks: Task[];
  approvals: number;
  blocked: number;
}): string {
  const { activeRunTask, tasks, approvals, blocked } = args;
  if (activeRunTask) {
    const desc = (activeRunTask.description || "").trim();
    return desc ? `In progress: ${desc}` : "Work in progress";
  }
  const blockedTask = tasks.find((t) => t.status === "blocked");
  if (blockedTask) {
    const desc = (blockedTask.description || "").trim();
    return desc ? `Blocked: ${desc}` : "Blocked work needs attention";
  }
  const awaiting = tasks.find((t) => t.status === "awaiting_approval");
  if (awaiting) {
    const desc = (awaiting.description || "").trim();
    return desc ? `Awaiting approval: ${desc}` : approvals > 0 ? "Awaiting approval" : "Awaiting approval";
  }
  const running = tasks.find((t) => t.status === "running");
  if (running) {
    const desc = (running.description || "").trim();
    return desc ? `Running: ${desc}` : "Running";
  }
  const queued = tasks.find((t) => t.status === "pending" || t.status === "ready");
  if (queued) {
    const desc = (queued.description || "").trim();
    return desc ? `Queued: ${desc}` : "Queued work";
  }
  if (approvals > 0) return approvals === 1 ? "1 approval needs attention" : `${approvals} approvals need attention`;
  if (blocked > 0) return blocked === 1 ? "1 blocked item" : `${blocked} blocked items`;
  return "No unfinished work";
}

export function HomeOverviewView() {
  const summary = useWorkspaceSummary();
  const projects = useAsync(() => api.listProjects().catch(() => ({ projects: [], counts: {} })), []);
  const recentResults = useAsync(async () => {
    let projectFetchFailed = false;
    const res = await api.listProjects().catch(() => {
      projectFetchFailed = true;
      return { projects: [] as Array<{ id: string; repository: string }>, counts: {} as any };
    });
    const list = (res.projects ?? []).slice(0, 6);
    let partialFailures = projectFetchFailed ? 1 : 0;
    const docs = await Promise.all(
      list.map(async (p) => {
        try {
          const r = await api.listLibrary(p.id);
          return (r.docs ?? []).map((d: LibraryDoc) => ({ doc: d, projectId: p.id, projectName: p.repository || "Workspace" }));
        } catch {
          partialFailures += 1;
          return [] as Array<{ doc: LibraryDoc; projectId: string; projectName: string }>;
        }
      })
    );
    const items = docs
      .flat()
      .sort((a: { doc: LibraryDoc }, b: { doc: LibraryDoc }) =>
        String(b.doc.updated_at || b.doc.created_at || "").localeCompare(String(a.doc.updated_at || a.doc.created_at || ""))
      )
      .slice(0, 5);
    return { items, partialFailures };
  }, []);

  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const data = summary.summary;

  const decide = async (id: string, decision: "approved" | "approved_forever" | "denied") => {
    setBusyApproval(id);
    try {
      await api.decideApproval(id, decision);
      summary.reload();
    } finally {
      setBusyApproval(null);
    }
  };

  const projectList = projects.data?.projects ?? data.bundles.map((b) => b.project);
  const counts = (projects.data?.counts ?? {}) as Record<string, { approvals?: number; blocked?: number; running?: number; tasks?: number; done?: number }>;

  const recentWorkspaces = useMemo((): RecentWorkspace[] => {
    const byId = new Map(data.bundles.map((b) => [b.project.id, b]));
    const activeRunByProject = new Map<string, Task | null>();
    for (const r of data.activeRuns) {
      if (!activeRunByProject.has(r.projectId) && r.task) activeRunByProject.set(r.projectId, r.task);
    }
    const scored = projectList.map((p) => {
      const b = byId.get(p.id);
      const c = counts[p.id] || {};
      const tasks = b?.tasks ?? [];
      const unfinished = tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length;
      const needs = (c.approvals ?? 0) + (c.blocked ?? tasks.filter((t) => t.status === "blocked").length);
      const hasActive = (c.running ?? 0) > 0 || tasks.some((t) => t.status === "running");
      const score = (activeRunByProject.has(p.id) ? 100 : 0) + needs * 10 + unfinished * 3 + (hasActive ? 5 : 0) + (tasks.length > 0 ? 1 : 0);
      return { p, b, c, tasks, unfinished, needs, score, activeTask: activeRunByProject.get(p.id) ?? null };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 4).map(({ p, b, c, tasks, activeTask }) => {
      const approvals = c.approvals ?? b?.approvals.filter((a) => ["pending", "awaiting"].includes(String((a as { decision?: string }).decision || "").toLowerCase())).length ?? 0;
      const blocked = c.blocked ?? tasks.filter((t) => t.status === "blocked").length;
      return {
        id: p.id,
        name: p.repository || "Workspace",
        detail: lastHappeningForWorkspace({ activeRunTask: activeTask, tasks, approvals, blocked }),
        href: `/p/${p.id}`,
      };
    });
  }, [projectList, data.bundles, data.activeRuns, counts]);

  const unfinishedWork = useMemo((): UnfinishedItem[] => {
    const seenTaskIds = new Set<string>();
    const items: UnfinishedItem[] = [];
    const pushTask = (projectId: string, projectName: string, t: Task) => {
      if (seenTaskIds.has(t.id)) return; // stable ID dedupe, never merge distinct records by title
      if (["done", "cancelled"].includes(t.status)) return;
      seenTaskIds.add(t.id);
      items.push({
        id: t.id,
        key: `task-${t.id}`,
        title: (t.description || "").trim() || "Untitled task",
        state: taskStateLabel(t.status),
        detail: `${projectName} · ${taskStateLabel(t.status).toLowerCase()}`,
        href: `/p/${projectId}/t/${t.id}`,
      });
    };

    // Prefer tasks surfaced via active runs first (distinct task records)
    for (const r of data.activeRuns) {
      if (r.task) pushTask(r.projectId, r.projectName, r.task);
    }
    for (const b of data.bundles) {
      const projectName = b.project.repository || "Workspace";
      for (const t of b.tasks) pushTask(b.project.id, projectName, t);
    }

    const rank = (s: string) => (s === "running" ? 0 : s === "awaiting_approval" ? 1 : s === "blocked" ? 2 : s === "ready" ? 3 : s === "pending" ? 4 : s === "failed" ? 5 : 6);
    items.sort((a, b) => {
      const sa = a.detail.endsWith("running") ? "running" : a.detail.endsWith("awaiting approval") ? "awaiting_approval" : a.detail.endsWith("blocked") ? "blocked" : a.detail.endsWith("ready") ? "ready" : a.detail.endsWith("pending") ? "pending" : a.detail.endsWith("failed") ? "failed" : "";
      const sb = b.detail.endsWith("running") ? "running" : b.detail.endsWith("awaiting approval") ? "awaiting_approval" : b.detail.endsWith("blocked") ? "blocked" : b.detail.endsWith("ready") ? "ready" : b.detail.endsWith("pending") ? "pending" : b.detail.endsWith("failed") ? "failed" : "";
      return rank(sa) - rank(sb);
    });
    return items.slice(0, 8);
  }, [data]);

  const actionable = useMemo(() => {
    const items: Array<{ key: string; title: string; detail: string; href?: string; tone: "warn" | "danger"; approval?: { id: string } }> = [];
    for (const { approval, projectName } of data.pendingApprovals) {
      items.push({
        key: `approval-${approval.id}`,
        title: approval.action || "Approval requested",
        detail: `${projectName}${approval.task_id ? " · linked task" : ""}`,
        href: approval.task_id && approval.project_id ? `/p/${approval.project_id}/t/${approval.task_id}` : "/approvals",
        tone: "warn",
        approval: { id: approval.id },
      });
    }
    for (const { run, task, projectName, projectId } of data.failedRuns.slice(0, 4)) {
      items.push({
        key: `failed-run-${run.id}`,
        title: task?.description?.trim() || "Run failed",
        detail: `${projectName} · failed`,
        href: task ? `/p/${projectId}/t/${task.id}` : "/work",
        tone: "danger",
      });
    }
    // blocked/awaiting tasks (compact) - distinct by task id
    const seenTaskIds = new Set(items.filter((i) => i.key.startsWith("task-")).map((i) => i.key));
    for (const b of data.bundles) {
      for (const t of b.tasks) {
        if (t.status !== "blocked" && t.status !== "awaiting_approval") continue;
        const key = `task-${t.id}`;
        if (seenTaskIds.has(key)) continue;
        // avoid duplicating items already represented by approval/failure href
        if (items.some((i) => i.href === `/p/${b.project.id}/t/${t.id}`)) continue;
        seenTaskIds.add(key);
        items.push({
          key,
          title: (t.description || "").trim() || "Task needs attention",
          detail: `${b.project.repository || "Workspace"} · ${t.status.replace("_", " ")}`,
          href: `/p/${b.project.id}/t/${t.id}`,
          tone: t.status === "blocked" ? "danger" : "warn",
        });
      }
    }
    return items.slice(0, 6);
  }, [data]);

  const results = recentResults.data?.items ?? [];
  const recentResultsPartial = (recentResults.data?.partialFailures ?? 0) > 0;

  return (
    <Page width="data">
      <div className="flex flex-col gap-5 pb-16 md:gap-8 md:pb-0">
        <PageHeader
          eyebrow="Home"
          title="Home"
          description="Pick up recent work, handle blockers, and open results."
          actions={<Button variant="primary" onClick={() => navigate("/work")}>Start work</Button>}
        />

        {summary.loading && !summary.data ? <LoadingState lines={4} /> : null}
        {summary.loadFailed ? (
          <div className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]">
            Some workspace data could not be loaded. This view may be incomplete.{" "}
            <button className="underline underline-offset-4" onClick={() => { summary.reload(); projects.reload(); recentResults.reload(); }}>Retry</button>
          </div>
        ) : null}

        <PageSection title="Recent workspaces" description="Where work was last happening.">
          {recentWorkspaces.length === 0 ? (
            <EmptyState
              title="No workspaces yet"
              hint="Create or open a workspace to start tracking work."
              action={<Button variant="primary" onClick={() => navigate("/projects")}>Open workspaces</Button>}
            />
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
              {recentWorkspaces.map((ws) => (
                <div key={`ws-${ws.id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-step--1 font-medium text-[var(--text)]">{ws.name}</div>
                    <div className="mt-0.5 text-step--2 text-[var(--muted)]">{ws.detail}</div>
                  </div>
                  <Button onClick={() => navigate(ws.href)}>Open</Button>
                </div>
              ))}
            </div>
          )}
        </PageSection>

        <PageSection title="Unfinished work" description="Tasks that still need progress or review.">
          {unfinishedWork.length === 0 ? (
            <EmptyState
              title="No unfinished work"
              hint="Pending, running, blocked, and awaiting tasks will appear here."
            />
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
              {unfinishedWork.map((item) => (
                <div key={item.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-step--1 font-medium text-[var(--text)]">{item.title}</div>
                      <Badge variant={item.state === "Blocked" || item.state === "Failed" ? "bad" : item.state === "Awaiting approval" ? "warn" : "info"}>{item.state}</Badge>
                    </div>
                    <div className="mt-0.5 text-step--2 text-[var(--muted)]">{item.detail}</div>
                  </div>
                  <Button onClick={() => navigate(item.href)}>Open</Button>
                </div>
              ))}
            </div>
          )}
        </PageSection>

        {actionable.length > 0 ? (
          <PageSection title="Needs attention" description="Approvals and blockers that need action.">
            <div className="flex flex-col gap-2">
              {actionable.map((item) => (
                <div key={item.key} className={`rounded-lg border px-4 py-3 ${item.tone === "danger" ? "border-[var(--danger)] bg-[var(--danger-dim)]" : "border-[var(--warn)] bg-[var(--warn-dim)]"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[var(--text)]">{item.title}</span>
                        <Badge variant={item.tone === "danger" ? "bad" : "warn"}>{item.tone === "danger" ? "Blocked/failed" : "Needs decision"}</Badge>
                      </div>
                      <div className="mt-1 text-step--1 text-[var(--muted)]">{item.detail}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.approval ? (
                        <>
                          <Button variant="primary" disabled={busyApproval === item.approval.id} onClick={() => void decide(item.approval!.id, "approved")}>Approve</Button>
                          <Button variant="danger" disabled={busyApproval === item.approval.id} onClick={() => void decide(item.approval!.id, "denied")}>Reject</Button>
                        </>
                      ) : item.href ? (
                        <Button onClick={() => navigate(item.href!)}>Open</Button>
                      ) : null}
                    </div>
                  </div>
                  {item.href ? (
                    <button className="mt-2 text-step--1 text-[var(--accent)] hover:underline" onClick={() => navigate(item.href!)}>View details</button>
                  ) : null}
                </div>
              ))}
            </div>
          </PageSection>
        ) : null}

        <PageSection title="Recent results" description="Openable results from your workspaces, when available.">
          {recentResults.loading && !recentResults.data ? <LoadingState lines={3} /> : results.length === 0 ? (
            <EmptyState
              title={recentResults.error || recentResultsPartial ? "Recent results unavailable" : "No recent openable results"}
              hint={recentResults.error || recentResultsPartial
                ? "Some workspace results could not be loaded right now."
                : "Completed documents and saved outputs will appear here when available."}
              action={<Button onClick={() => { recentResults.reload(); }}>Retry</Button>}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {recentResultsPartial ? (
                <div className="rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2 text-step--2 text-[var(--text)]">
                  Some workspace results could not be loaded. Showing available results.{" "}
                  <button className="underline underline-offset-4" onClick={() => recentResults.reload()}>Retry</button>
                </div>
              ) : null}
              <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                {results.map(({ doc, projectName }: { doc: LibraryDoc; projectName: string }) => (
                  <button key={doc.id} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/library/${doc.id}`)}>
                    <div className="min-w-0">
                      <div className="truncate text-step--1 font-medium text-[var(--text)]">{doc.title || "Untitled document"}</div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{projectName}{doc.updated_at || doc.created_at ? ` · ${relativeTime((doc.updated_at || doc.created_at) as string)}` : ""}</div>
                    </div>
                    <span className="text-step--2 text-[var(--faint)]">Open</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </PageSection>
      </div>
    </Page>
  );
}
