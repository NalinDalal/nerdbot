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
import type { Approval, LibraryDoc, Task } from "./types";

type RecentWorkspace = {
  id: string;
  name: string;
  detail: string;
  href: string;
};

type UnfinishedItem = {
  key: string;
  title: string;
  state: string;
  detail: string;
  href: string;
};

type AttentionItem = {
  key: string;
  title: string;
  detail: string;
  href?: string;
  approval?: { id: string };
  tone: "warn" | "danger";
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

  const actionable = useMemo((): AttentionItem[] => {
    const items: AttentionItem[] = [];
    const seenApprovalIds = new Set<string>();
    for (const { approval, projectName } of data.pendingApprovals) {
      if (seenApprovalIds.has(approval.id)) continue;
      seenApprovalIds.add(approval.id);
      const action = String((approval as { action?: string }).action || "Action").replace(/_/g, " ");
      items.push({
        key: `approval-${approval.id}`,
        title: action,
        detail: `${projectName} · needs approval`,
        href: `/approvals`,
        approval: { id: approval.id },
        tone: "warn",
      });
    }
    for (const f of data.failedRuns.slice(0, 3)) {
      items.push({
        key: `failed-${f.run.id}`,
        title: f.task?.description ? f.task.description.slice(0, 80) : "Failed execution",
        detail: `${f.projectName} · failed${(f.run as any).error ? `: ${String((f.run as any).error).slice(0, 120)}` : ""}`,
        href: f.task ? `/p/${f.projectId}/t/${f.task.id}` : `/p/${f.projectId}`,
        tone: "danger",
      });
    }
    return items.slice(0, 6);
  }, [data.pendingApprovals, data.failedRuns]);

  const unfinishedWork = useMemo((): UnfinishedItem[] => {
    const items: UnfinishedItem[] = [];
    // use summary-derived signals to stay consistent with actionable
    const seenTaskIds = new Set<string>();
    for (const b of data.bundles) {
      for (const t of b.tasks) {
        if (["done", "cancelled"].includes(t.status)) continue;
        if (!["pending", "ready", "running", "awaiting_approval", "blocked"].includes(t.status)) continue;
        if (seenTaskIds.has(t.id)) continue;
        seenTaskIds.add(t.id);
        items.push({
          key: `task-${t.id}`,
          title: (t.description || "").trim() || "Task",
          state: taskStateLabel(t.status),
          detail: `${b.project.repository || "Workspace"} · ${t.status.replace(/_/g, " ")}`,
          href: `/p/${b.project.id}/t/${t.id}`,
        });
      }
    }
    const rank = (s: string) => ({ awaiting_approval: 0, blocked: 1, running: 2, ready: 3, pending: 4 }[s] ?? 9);
    items.sort((a, b) => {
      const sa = (data.bundles.flatMap((x) => x.tasks).find((t) => `task-${t.id}` === a.key)?.status) || "pending";
      const sb = (data.bundles.flatMap((x) => x.tasks).find((t) => `task-${t.id}` === b.key)?.status) || "pending";
      return rank(sa) - rank(sb);
    });
    return items.slice(0, 6);
  }, [data.bundles]);

  const recentRuns = useMemo(() => {
    const all: Array<{ id: string; label: string; detail: string; href: string; status: string; when?: string }> = [];
    for (const r of data.activeRuns) {
      all.push({
        id: `run-a-${r.run.id}`,
        label: r.task?.description || "Running task",
        detail: `${r.projectName} · running`,
        href: r.task ? `/p/${r.projectId}/t/${r.task.id}` : `/p/${r.projectId}`,
        status: "running",
        when: r.run.started_at,
      });
    }
    for (const b of data.bundles) {
      const pname = b.project.repository || "Workspace";
      for (const run of b.runs) {
        if (run.status === "running") continue;
        if (!["completed", "failed", "cancelled", "awaiting_approval"].includes(run.status)) continue;
        const task = b.tasks.find((t) => t.id === run.task_id);
        all.push({
          id: `run-${run.id}`,
          label: task?.description || "Execution",
          detail: `${pname} · ${String(run.status).replace(/_/g, " ")}${(run as any).error ? ` · ${String((run as any).error).slice(0, 80)}` : ""}`,
          href: task ? `/p/${b.project.id}/t/${task.id}` : `/p/${b.project.id}`,
          status: run.status,
          when: run.finished_at || run.started_at,
        });
      }
    }
    all.sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));
    return all.slice(0, 8);
  }, [data.activeRuns, data.bundles]);

  const workforce = useMemo(() => {
    const activeTaskOwners = new Set<string>();
    const byBot = new Map<string, { running: number; unfinished: number; projectNames: Set<string> }>();
    for (const b of data.bundles) {
      const pname = b.project.repository || "Workspace";
      for (const t of b.tasks) {
        if (!t.owner_teammate_id) continue;
        if (!["pending", "ready", "running", "awaiting_approval", "blocked"].includes(t.status)) continue;
        const cur = byBot.get(t.owner_teammate_id) || { running: 0, unfinished: 0, projectNames: new Set<string>() };
        cur.unfinished += 1;
        if (t.status === "running") cur.running += 1;
        cur.projectNames.add(pname);
        byBot.set(t.owner_teammate_id, cur);
        if (t.status === "running") activeTaskOwners.add(t.owner_teammate_id);
      }
    }
    const bots = data.bots.slice(0, 12).map((bot) => {
      const stats = byBot.get(bot.id);
      return {
        id: bot.id,
        name: bot.name || bot.slug || "Agent",
        status: activeTaskOwners.has(bot.id) ? "active" : stats ? "assigned" : "idle",
        detail: stats
          ? `${stats.running > 0 ? `${stats.running} running · ` : ""}${stats.unfinished} open${stats.projectNames.size ? ` · ${Array.from(stats.projectNames).slice(0, 2).join(", ")}` : ""}`
          : "No active or queued work",
      };
    });
    return { bots, teamCount: data.teams.length, botCount: data.bots.length, activeCount: activeTaskOwners.size };
  }, [data.bots, data.teams, data.bundles]);

  const results = recentResults.data?.items ?? [];
  const recentResultsPartial = (recentResults.data?.partialFailures ?? 0) > 0;

  const systemSignals = useMemo(() => {
    const signals: Array<{ key: string; label: string; value: string; tone: "neutral" | "warn" | "bad" | "ok" }> = [
      { key: "projects", label: "Projects", value: String(data.bundles.length), tone: "neutral" },
      { key: "running", label: "Running", value: String(data.runningTasks || data.activeRuns.length), tone: data.activeRuns.length ? "ok" : "neutral" },
      { key: "approvals", label: "Pending approvals", value: String(data.pendingApprovals.length), tone: data.pendingApprovals.length ? "warn" : "neutral" },
      { key: "blocked", label: "Blocked/failed", value: String(data.blockedTasks + data.failedRuns.length), tone: (data.blockedTasks + data.failedRuns.length) ? "bad" : "neutral" },
    ];
    if (summary.loadFailed) signals.push({ key: "load", label: "Data load", value: "Partial", tone: "warn" });
    return signals;
  }, [data, summary.loadFailed]);

  return (
    <Page width="data">
      <div className="flex flex-col gap-5 pb-16 md:gap-8 md:pb-0">
        <PageHeader
          eyebrow="Home"
          title="Operational overview"
          description="Monitor projects, agents, executions, approvals, and system signals from one place."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate("/approvals")}>Approvals</Button>
              <Button onClick={() => navigate("/workbench")}>Workbench</Button>
              <Button variant="primary" onClick={() => navigate("/work")}>Start work</Button>
            </div>
          }
        />

        {summary.loading && !summary.data ? <LoadingState lines={4} /> : null}
        {summary.loadFailed ? (
          <div className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]">
            Some workspace data could not be loaded. This view may be incomplete.{" "}
            <button className="underline underline-offset-4" onClick={() => { summary.reload(); projects.reload(); recentResults.reload(); }}>Retry</button>
          </div>
        ) : null}

        <PageSection title="System and operational health" description="Important indicators, notifications, and recovery signals.">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {systemSignals.map((s) => (
              <div key={s.key} className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-3 py-3">
                <div className="text-step--2 text-[var(--muted)]">{s.label}</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-step-1 font-semibold text-[var(--text)]">{s.value}</span>
                  <Badge variant={s.tone === "bad" ? "bad" : s.tone === "warn" ? "warn" : s.tone === "ok" ? "ok" : "neutral"}>
                    {s.tone === "bad" ? "Attention" : s.tone === "warn" ? "Review" : s.tone === "ok" ? "Active" : "OK"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
          {summary.loadFailed ? (
            <div className="mt-2 text-step--2 text-[var(--muted)]">Action: retry data load or open affected project/workspace for details. Partial results are shown where available.</div>
          ) : null}
        </PageSection>

        <PageSection title="Recent workspaces" description="Active projects and where work was last happening.">
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
                  <div className="flex gap-2">
                    <Button onClick={() => navigate(ws.href)}>Open</Button>
                    <Button onClick={() => navigate(`/p/${ws.id}/workbench`)}>Workbench</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PageSection>

        <PageSection title="Agent and workforce visibility" description="Teammates, active work, ownership, and team context.">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-step--2 text-[var(--muted)]">
            <Badge variant="neutral">{workforce.botCount} agents</Badge>
            <Badge variant="neutral">{workforce.teamCount} teams</Badge>
            <Badge variant={workforce.activeCount ? "ok" : "neutral"}>{workforce.activeCount} active</Badge>
            <Button onClick={() => navigate("/bots")}>View agents</Button>
          </div>
          {workforce.bots.length === 0 ? (
            <EmptyState title="No agents configured" hint="Create teammates/agents to distribute and track work." action={<Button onClick={() => navigate("/bots")}>Manage agents</Button>} />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {workforce.bots.map((bot) => (
                <button key={bot.id} className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/bots/${bot.id}`)}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-step--1 font-medium text-[var(--text)]">{bot.name}</div>
                    <Badge variant={bot.status === "active" ? "ok" : bot.status === "assigned" ? "info" : "neutral"}>{bot.status}</Badge>
                  </div>
                  <div className="mt-1 text-step--2 text-[var(--muted)]">{bot.detail}</div>
                </button>
              ))}
            </div>
          )}
        </PageSection>

        <PageSection title="Execution visibility" description="Running, recent, completed, and failed executions with recovery paths.">
          {recentRuns.length === 0 ? (
            <EmptyState title="No recent executions" hint="Task runs and agent executions will appear here." action={<Button onClick={() => navigate("/activity")}>Open activity</Button>} />
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
              {recentRuns.map((r) => (
                <button key={r.id} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(r.href)}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-step--1 font-medium text-[var(--text)]">{r.label}</div>
                      <Badge variant={r.status === "failed" ? "bad" : r.status === "running" ? "ok" : r.status === "awaiting_approval" ? "warn" : "neutral"}>{r.status.replace(/_/g, " ")}</Badge>
                    </div>
                    <div className="mt-0.5 text-step--2 text-[var(--muted)]">{r.detail}{r.when ? ` · ${relativeTime(r.when)}` : ""}</div>
                  </div>
                  <span className="text-step--2 text-[var(--faint)]">Open</span>
                </button>
              ))}
            </div>
          )}
          {data.failedRuns.length > 0 ? (
            <div className="mt-2 text-step--2 text-[var(--muted)]">Recovery: open failed items to inspect errors, outputs, and rerun or adjust tasks.</div>
          ) : null}
        </PageSection>

        <PageSection title="Approval center" description="Pending approvals, context, and decision workflows.">
          {data.pendingApprovals.length === 0 ? (
            <EmptyState title="No pending approvals" hint="Approval requests and their context will appear here." action={<Button onClick={() => navigate("/approvals")}>Open approvals</Button>} />
          ) : (
            <div className="flex flex-col gap-2">
              {data.pendingApprovals.slice(0, 6).map(({ approval, projectName }) => {
                const a = approval as Approval & { action?: string; description?: string };
                return (
                  <div key={approval.id} className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-[var(--text)]">{String(a.action || "Action").replace(/_/g, " ")}</span>
                          <Badge variant="warn">Pending</Badge>
                        </div>
                        <div className="mt-1 text-step--1 text-[var(--muted)]">{projectName}{a.description ? ` · ${String(a.description).slice(0, 140)}` : ""}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button variant="primary" disabled={busyApproval === approval.id} onClick={() => void decide(approval.id, "approved")}>Approve</Button>
                        <Button variant="danger" disabled={busyApproval === approval.id} onClick={() => void decide(approval.id, "denied")}>Reject</Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div><Button onClick={() => navigate("/approvals")}>View all approvals and history</Button></div>
            </div>
          )}
        </PageSection>

        <PageSection title="Unfinished work" description="Tasks that still need progress or review.">
          {unfinishedWork.length === 0 ? (
            <EmptyState title="No unfinished work" hint="Pending, running, blocked, and awaiting tasks will appear here." />
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
          <PageSection title="Needs attention" description="Important operational notifications and actionable issues.">
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
