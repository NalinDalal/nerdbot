import { useState } from "react";
import { api } from "./api";
import { navigate } from "./app";
import {
  Badge,
  BotFace,
  Button,
  EmptyState,
  LoadingState,
  Page,
  PageHeader,
  PageSection,
  StatusBadge,
  StatusDot,
  relativeTime,
  useAsync,
} from "./components";
import { useWorkspaceSummary } from "./views-home";
import type { JobItem } from "./types";

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" | "info" }) {
  const color =
    tone === "bad"
      ? "text-[var(--danger)]"
      : tone === "warn"
        ? "text-[var(--warn)]"
        : tone === "info"
          ? "text-[var(--info)]"
          : tone === "ok"
            ? "text-[var(--accent)]"
            : "text-[var(--text)]";
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-step-2 font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-step--1 text-[var(--muted)]">{label}</span>
    </div>
  );
}

export function HomeOverviewView() {
  const summary = useWorkspaceSummary();
  const jobs = useAsync(() => api.listJobs({ limit: 12 }).catch(() => ({ jobs: [], total: 0 })), []);
  const recentThreads = useAsync(() => api.listRecentThreads(6).catch(() => ({ threads: [] })), []);
  const projects = useAsync(() => api.listProjects().catch(() => ({ projects: [], counts: {} })), []);
  const [busyApproval, setBusyApproval] = useState<string | null>(null);

  const data = summary.summary;
  const attentionCount = data.pendingApprovals.length + data.failedRuns.length + data.blockedTasks + data.awaitingTasks;
  const activeCount = data.activeRuns.length + data.runningTasks;
  const queuedCount = data.queuedTasks;

  const recentJobs = (jobs.data?.jobs ?? []) as JobItem[];
  const recentOutcomes = recentJobs.filter((j) => {
    const s = String(j.status || "").toLowerCase();
    return ["done", "succeeded", "completed", "failed", "error", "cancelled", "canceled"].includes(s);
  }).slice(0, 6);
  const activeJobs = recentJobs.filter((j) => {
    const s = String(j.status || "").toLowerCase();
    return ["running", "queued", "pending", "ready", "scheduled"].includes(s);
  }).slice(0, 6);

  const decide = async (id: string, decision: "approved" | "approved_forever" | "denied") => {
    setBusyApproval(id);
    try {
      await api.decideApproval(id, decision);
      summary.reload();
      jobs.reload();
    } catch {
      // keep truthful; errors surface via global handlers in other flows; minimal here
    } finally {
      setBusyApproval(null);
    }
  };

  return (
    <Page width="data">
      <PageHeader
        eyebrow="Home"
        title="Overview"
        description="What needs attention, what your AI teammates are doing, and what has shipped across workspaces."
        actions={
          <>
            <Button onClick={() => navigate("/chat")}>Open chat</Button>
            <Button variant="primary" onClick={() => navigate("/work")}>Open work</Button>
          </>
        }
      />

      {summary.loading && !summary.data ? <LoadingState lines={6} /> : null}
      {summary.loadFailed ? (
        <div className="mb-6 rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]">
          Some workspace data could not be loaded. This overview may be incomplete.{" "}
          <button className="underline underline-offset-4" onClick={() => { summary.reload(); jobs.reload(); projects.reload(); }}>Retry</button>
        </div>
      ) : null}

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
          <Stat label="Need attention" value={attentionCount} tone={attentionCount > 0 ? "warn" : "ok"} />
        </div>
        <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
          <Stat label="Active now" value={activeCount} tone={activeCount > 0 ? "info" : undefined} />
        </div>
        <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
          <Stat label="Queued" value={queuedCount} tone={queuedCount > 0 ? "warn" : undefined} />
        </div>
        <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
          <Stat label="Workspaces" value={(projects.data?.projects ?? data.bundles.map((b) => b.project)).length} />
        </div>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <PageSection
            title="Needs attention"
            description="Decisions, failures, and blocked work that require action."
            actions={data.pendingApprovals.length > 0 ? <Button onClick={() => navigate("/approvals")}>Approvals inbox</Button> : undefined}
          >
            {attentionCount === 0 ? (
              <EmptyState title="Nothing needs attention" hint="Approvals, failures, and blocked work will appear here when action is needed." />
            ) : (
              <div className="flex flex-col gap-3">
                {data.pendingApprovals.slice(0, 5).map(({ approval, projectName }) => (
                  <div key={approval.id} className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-[var(--text)]">{approval.action || "Approval requested"}</span>
                          <Badge variant="warn">Needs decision</Badge>
                        </div>
                        <div className="mt-1 text-step--1 text-[var(--muted)]">
                          {projectName}
                          {approval.task_id ? " · linked to a task" : ""}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button variant="primary" disabled={busyApproval === approval.id} onClick={() => void decide(approval.id, "approved")}>Approve</Button>
                        <Button disabled={busyApproval === approval.id} onClick={() => void decide(approval.id, "approved_forever")}>Always allow</Button>
                        <Button variant="danger" disabled={busyApproval === approval.id} onClick={() => void decide(approval.id, "denied")}>Reject</Button>
                      </div>
                    </div>
                    {approval.task_id && approval.project_id ? (
                      <button className="mt-2 text-step--1 text-[var(--accent)] hover:underline" onClick={() => navigate(`/p/${approval.project_id}/t/${approval.task_id}`)}>Open task</button>
                    ) : null}
                  </div>
                ))}
                {data.failedRuns.slice(0, 4).map(({ run, task, projectName, projectId }) => (
                  <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><span className="font-medium text-[var(--text)]">Run failed</span><Badge variant="bad">Failed</Badge></div>
                      <div className="mt-1 truncate text-step--1 text-[var(--muted)]">{task?.description?.trim() || "A task run failed"} · {projectName}</div>
                    </div>
                    {task ? <Button onClick={() => navigate(`/p/${projectId}/t/${task.id}`)}>Open task</Button> : <Button onClick={() => navigate("/work")}>Open work</Button>}
                  </div>
                ))}
                {data.blockedTasks > 0 || data.awaitingTasks > 0 ? (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">
                    {data.blockedTasks > 0 ? `${data.blockedTasks} blocked task${data.blockedTasks === 1 ? "" : "s"}` : ""}
                    {data.blockedTasks > 0 && data.awaitingTasks > 0 ? " · " : ""}
                    {data.awaitingTasks > 0 ? `${data.awaitingTasks} awaiting approval` : ""}
                    <button className="ml-2 text-[var(--accent)] hover:underline" onClick={() => navigate("/work")}>View in Work</button>
                  </div>
                ) : null}
              </div>
            )}
          </PageSection>

          <PageSection title="Active work" description="Running and queued work across workspaces.">
            {activeJobs.length === 0 && data.activeRuns.length === 0 && queuedCount === 0 ? (
              <EmptyState title="No active work" hint="Running and queued tasks, runs, and jobs will appear here." action={<Button onClick={() => navigate("/projects")}>Open workspaces</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {data.activeRuns.slice(0, 6).map(({ run, task, projectName, projectId }) => (
                  <button key={run.id} className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => task ? navigate(`/p/${projectId}/t/${task.id}`) : navigate(`/p/${projectId}`)}>
                    <div className="min-w-0">
                      <div className="truncate text-step--1 font-medium text-[var(--text)]">{task?.description?.trim() || "Running task"}</div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{projectName} · {run.status}</div>
                    </div>
                    <StatusDot status={run.status} pulse />
                  </button>
                ))}
                {activeJobs.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {activeJobs.slice(0, 4).map((job) => (
                      <div key={job.id} className="flex items-center justify-between gap-3 rounded-md px-1 py-1 text-step--1">
                        <span className="truncate text-[var(--text-soft)]">{job.title || job.source_type || job.id}</span>
                        <StatusBadge status={String(job.status || "queued")} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </PageSection>

          <PageSection title="Recent outcomes" description="Completed and failed work with links to details." actions={<Button onClick={() => navigate("/work")}>View all work</Button>}>
            {recentOutcomes.length === 0 && data.failedRuns.length === 0 ? (
              <EmptyState title="No recent outcomes yet" hint="Completed runs, jobs, and produced results will appear here." />
            ) : (
              <div className="flex flex-col gap-2">
                {recentOutcomes.map((job) => (
                  <div key={job.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-step--1 text-[var(--text)]">{job.title || job.source_type || "Job"}</div>
                      <div className="text-step--2 text-[var(--faint)]">{job.source_type || "work"}{job.updated_at ? ` · ${relativeTime(job.updated_at)}` : ""}</div>
                    </div>
                    <StatusBadge status={String(job.status || "done")} />
                  </div>
                ))}
              </div>
            )}
          </PageSection>
        </div>

        <div className="flex flex-col gap-8">
          <PageSection title="AI teammates" description="Who is available and where work is happening." actions={<Button onClick={() => navigate("/bots")}>Open agents</Button>}>
            {data.bots.length === 0 ? (
              <EmptyState title="No teammates yet" hint="Create agents in a workspace to delegate work and build an AI team." action={<Button onClick={() => navigate("/workspaces")}>Open workspaces</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {data.bots.slice(0, 8).map((bot) => {
                  const busy = data.activeRuns.some((r) => r.task?.owner_teammate_id === bot.id) || data.bundles.some((b) => b.tasks.some((t) => t.owner_teammate_id === bot.id && t.status === "running"));
                  return (
                    <button key={bot.id} className="flex items-center gap-3 rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/bot/${bot.id}`)}>
                      <BotFace face={bot.face} size={28} status={bot.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-step--1 font-medium text-[var(--text)]">{bot.name || bot.persona || "Teammate"}</div>
                        <div className="text-step--2 text-[var(--muted)]">{busy ? "Active in work" : bot.status || "Idle"}</div>
                      </div>
                      <span className="text-step--2 text-[var(--faint)]">Open</span>
                    </button>
                  );
                })}
              </div>
            )}
          </PageSection>

          <PageSection title="Workspaces" description="Project environments and where attention is needed." actions={<Button onClick={() => navigate("/projects")}>All workspaces</Button>}>
            {(projects.data?.projects ?? []).length === 0 ? (
              <EmptyState title="No workspaces yet" hint="Create a workspace to organize teammates, work, and deliverables." action={<Button variant="primary" onClick={() => navigate("/projects")}>Create workspace</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {(projects.data?.projects ?? []).slice(0, 6).map((p) => {
                  const counts = (projects.data?.counts ?? {}) as Record<string, { approvals?: number; blocked?: number; bots?: number; tasks?: number }>;
                  const c = counts[p.id];
                  const needs = (c?.approvals ?? 0) + (c?.blocked ?? 0);
                  return (
                    <button key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/p/${p.id}`)}>
                      <div className="min-w-0">
                        <div className="truncate text-step--1 font-medium text-[var(--text)]">{p.repository || "Workspace"}</div>
                        <div className="mt-0.5 text-step--2 text-[var(--muted)]">{c ? `${c.bots ?? 0} agents · ${c.tasks ?? 0} tasks` : "Open workspace"}</div>
                      </div>
                      {needs > 0 ? <Badge variant="warn">{needs} need attention</Badge> : <span className="text-step--2 text-[var(--faint)]">Open</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </PageSection>

          <PageSection title="Recent conversations" description="Chat is available for coordination and direct teammate interaction." actions={<Button onClick={() => navigate("/chat")}>Open chat</Button>}>
            {(recentThreads.data?.threads ?? []).length === 0 ? (
              <EmptyState title="No recent conversations" hint="Start a conversation in Chat or with a teammate when you need to coordinate." action={<Button onClick={() => navigate("/chat")}>Go to Chat</Button>} />
            ) : (
              <div className="flex flex-col gap-1.5">
                {(recentThreads.data?.threads ?? []).slice(0, 5).map((t) => (
                  <button key={t.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/chat/${t.project_id}?thread=${t.id}`)}>
                    <span className="truncate text-step--1 text-[var(--text)]">{t.title || "Untitled conversation"}</span>
                    <span className="shrink-0 text-step--2 text-[var(--faint)]">{relativeTime((t.updated_at || t.created_at) ?? "")}</span>
                  </button>
                ))}
              </div>
            )}
          </PageSection>

          <PageSection title="Deliverables" description="Documents, reports, and assets produced by your team." actions={<Button onClick={() => navigate("/library")}>Open library</Button>}>
            <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">
              Review saved documents and outputs in Library. Workspace-level deliverable aggregation will be expanded as workspace dashboards are implemented.
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => navigate("/library")}>Library</Button>
                <Button onClick={() => navigate("/gallery")}>Gallery</Button>
              </div>
            </div>
          </PageSection>
        </div>
      </div>
    </Page>
  );
}
