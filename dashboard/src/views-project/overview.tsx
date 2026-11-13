import { useMemo } from "react";
import { api } from "../api";
import { navigate } from "../app";
import {
  Badge,
  BotFace,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  relativeTime,
  useAsync,
} from "../components";
import { taskTitle } from "../taskTitle";
import type { Approval, GalleryAsset, LibraryDoc, Project, Run, Task, Teammate } from "../types";

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error }));
}

export type AttentionItem = {
  id: string;
  kind: "approval" | "task";
  title: string;
  reason: string;
  status: string;
  href: string;
  actionLabel: string;
  tone: "warn" | "danger";
  approvalId?: string;
  taskId?: string;
};

export type DeliverableItem = {
  id: string;
  kind: "Document" | "Asset";
  name: string;
  when: string;
  href: string;
  meta: string;
  source: "Library" | "Gallery";
};

export type ActivityItem = {
  id: string;
  title: string;
  detail: string;
  when: string;
  href: string;
  tone: "neutral" | "info" | "warn" | "danger" | "success";
};

export type NextStep = {
  id: string;
  title: string;
  detail: string;
  actionLabel: string;
  onSelect: () => void;
  primary?: boolean;
};

function isPendingApproval(a: Approval): boolean {
  const decision = String((a as any).decision ?? (a as any).status ?? "").toLowerCase();
  return !decision || decision === "pending" || decision === "awaiting_approval";
}

function deriveObjective(project?: Project | null): { text: string; set: boolean } {
  const cfg = (project?.config ?? {}) as Record<string, unknown>;
  const keys = ["objective", "goal", "mission", "purpose", "description", "summary"];
  for (const key of keys) {
    const v = cfg[key];
    if (typeof v === "string" && v.trim()) return { text: v.trim(), set: true };
  }
  return { text: "No objective set yet. Use chat or workspace context to define what this workspace is trying to accomplish.", set: false };
}

export function computeWorkspaceOverviewModel(result: {
  tasks: Settled<{ tasks: Task[] }>;
  runs: Settled<{ runs: Run[] }>;
  teammates: Settled<{ teammates: Teammate[] }>;
  approvals: Settled<{ approvals: Approval[] }>;
  library: Settled<{ docs: LibraryDoc[] }>;
  gallery: Settled<{ assets: GalleryAsset[]; total?: number }>;
  project?: Project | null;
}) {
  const tasks = result.tasks.ok ? (result.tasks.value.tasks ?? []) : [];
  const runs = result.runs.ok ? (result.runs.value.runs ?? []) : [];
  const teammates = result.teammates.ok ? (result.teammates.value.teammates ?? []) : [];
  const approvals = result.approvals.ok ? (result.approvals.value.approvals ?? []) : [];
  const libraryDocs = result.library.ok ? (result.library.value.docs ?? []) : [];
  const galleryAssets = result.gallery.ok ? (result.gallery.value.assets ?? []) : [];
  const failedSources: string[] = [];
  if (!result.tasks.ok) failedSources.push("tasks");
  if (!result.runs.ok) failedSources.push("runs");
  if (!result.teammates.ok) failedSources.push("agents");
  if (!result.approvals.ok) failedSources.push("approvals");
  if (!result.library.ok) failedSources.push("library");
  if (!result.gallery.ok) failedSources.push("gallery");

  const runningTasks = tasks.filter((t) => t.status === "running");
  const queuedTasks = tasks.filter((t) => ["ready", "pending", "queued"].includes(t.status));
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const awaitingTasks = tasks.filter((t) => t.status === "awaiting_approval");
  const failedTasks = tasks.filter((t) => t.status === "failed");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const attentionApprovals = approvals.filter((a) => isPendingApproval(a));

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const attentionItems: AttentionItem[] = [
    ...attentionApprovals.map((a) => {
      const task = a.task_id ? taskById.get(a.task_id) : undefined;
      return {
        id: `approval:${a.id}`,
        kind: "approval" as const,
        title: a.action || "Approval requested",
        reason: (a as any).reason || (a as any).message || (task ? `For: ${taskTitle(task.description)}` : "A decision is required to continue."),
        status: "awaiting decision",
        href: a.task_id ? `/p/${(a as any).project_id || task?.project_id || ""}/t/${a.task_id}` : "",
        actionLabel: "Review",
        tone: "warn" as const,
        approvalId: a.id,
        taskId: a.task_id || undefined,
      };
    }),
    ...failedTasks.map((t) => ({
      id: `task-failed:${t.id}`,
      kind: "task" as const,
      title: t.title || taskTitle(t.description),
      reason: t.blocked_reason || "Failed and needs review before continuing.",
      status: "failed",
      href: "",
      actionLabel: "Review",
      tone: "danger" as const,
      taskId: t.id,
    })),
    ...blockedTasks.map((t) => ({
      id: `task-blocked:${t.id}`,
      kind: "task" as const,
      title: t.title || taskTitle(t.description),
      reason: t.blocked_reason || "Blocked and waiting for input or a dependency.",
      status: "blocked",
      href: "",
      actionLabel: "Open",
      tone: "warn" as const,
      taskId: t.id,
    })),
    ...awaitingTasks.map((t) => ({
      id: `task-awaiting:${t.id}`,
      kind: "task" as const,
      title: t.title || taskTitle(t.description),
      reason: t.blocked_reason || "Waiting for approval to continue.",
      status: "awaiting approval",
      href: "",
      actionLabel: "Review",
      tone: "warn" as const,
      taskId: t.id,
    })),
  ];

  const deliverables: DeliverableItem[] = [
    ...libraryDocs.map((doc) => ({
      id: `doc:${doc.id}`,
      kind: "Document" as const,
      name: doc.title || doc.source || "Untitled document",
      when: doc.updated_at || doc.created_at || "",
      href: `/library/${doc.id}`,
      meta: doc.format || doc.kind || doc.source || "Library",
      source: "Library" as const,
    })),
    ...galleryAssets.map((asset) => ({
      id: `asset:${asset.id}`,
      kind: "Asset" as const,
      name: asset.name || "Untitled asset",
      when: asset.created_at || "",
      href: `/gallery`,
      meta: asset.mime_type || "Gallery",
      source: "Gallery" as const,
    })),
  ]
    .sort((a, b) => String(b.when).localeCompare(String(a.when)))
    .slice(0, 8);

  const sortedRuns = [...runs].sort((a, b) => String(b.finished_at || b.started_at || "").localeCompare(String(a.finished_at || a.started_at || "")));
  const recentActivity: ActivityItem[] = sortedRuns.slice(0, 8).map((run) => {
    const task = taskById.get(run.task_id);
    const title = task ? (task.title || taskTitle(task.description)) : "Execution";
    const when = run.finished_at || run.started_at || "";
    const status = run.status || "updated";
    const tone: ActivityItem["tone"] =
      status === "failed" ? "danger" : status === "succeeded" || status === "done" ? "success" : status === "running" ? "info" : status === "blocked" ? "warn" : "neutral";
    const detail =
      status === "failed" ? "Run failed" :
      status === "succeeded" || status === "done" ? "Run completed" :
      status === "running" ? "Run in progress" :
      status === "blocked" ? "Run blocked" :
      `Run ${status}`;
    return {
      id: `run:${run.id}`,
      title,
      detail,
      when,
      href: task ? `/p/${task.project_id}/t/${task.id}` : "",
      tone,
    };
  });

  const objective = deriveObjective(result.project ?? null);

  return {
    tasks, runs, teammates, approvals, libraryDocs, galleryAssets, failedSources,
    runningTasks, queuedTasks, blockedTasks, awaitingTasks, failedTasks, doneTasks,
    attentionApprovals, attentionItems, deliverables, recentActivity, objective,
  };
}

function useWorkspaceOperatingData(projectId: string) {
  return useAsync(async () => {
    const [tasks, runs, teammates, approvals, library, gallery] = await Promise.all([
      settled(api.projectTasks(projectId)),
      settled(api.projectRuns(projectId)),
      settled(api.listTeammates(projectId)),
      settled(api.projectApprovals(projectId).catch(() => ({ approvals: [] as Approval[] }))),
      settled(api.listLibrary(projectId).catch(() => ({ docs: [] as LibraryDoc[] }))),
      settled(api.listGallery(projectId, { limit: 12 }).catch(() => ({ assets: [] as GalleryAsset[], total: 0 }))),
    ]);
    return { tasks, runs, teammates, approvals, library, gallery };
  }, [projectId]);
}

function Section({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-step-0 font-semibold tracking-tight text-[var(--text)]">{title}</h3>
          {description ? <p className="mt-0.5 max-w-2xl text-step--1 leading-relaxed text-[var(--muted)]">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function PartialLoadNotice({ failed, onRetry }: { failed: string[]; onRetry: () => void }) {
  if (failed.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--warn)]/40 bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]" role="status">
      Some workspace information could not be loaded: {failed.join(", ")}. Showing available data. {" "}
      <button className="font-medium underline underline-offset-2" onClick={onRetry}>Retry</button>
    </div>
  );
}

function isActiveTaskStatus(status: string) {
  return ["running", "ready", "pending", "queued"].includes(status);
}
function isBlockedTaskStatus(status: string) {
  return status === "blocked" || status === "awaiting_approval";
}

export function observedAgentState(teammateId: string, tasks: Task[]) {
  const mine = tasks.filter((t) => t.owner_teammate_id === teammateId);
  const running = mine.filter((t) => t.status === "running").length;
  const queued = mine.filter((t) => ["ready", "pending", "queued"].includes(t.status)).length;
  const blocked = mine.filter((t) => isBlockedTaskStatus(t.status)).length;
  const failed = mine.filter((t) => t.status === "failed").length;
  if (running > 0) return { label: "Working now", tone: "info" as const, detail: `${running} running${queued ? ` · ${queued} queued` : ""}` };
  if (blocked > 0) return { label: "Blocked", tone: "warn" as const, detail: `${blocked} blocked or awaiting approval` };
  if (queued > 0) return { label: "Queued work", tone: "neutral" as const, detail: `${queued} queued` };
  if (failed > 0) return { label: "Needs review", tone: "bad" as const, detail: `${failed} failed task${failed === 1 ? "" : "s"}` };
  if (mine.length > 0) return { label: "No active assignment observed", tone: "neutral" as const, detail: "Has task history in this workspace" };
  return { label: "No active assignment observed", tone: "neutral" as const, detail: "No tasks assigned yet" };
}

function toneDot(tone: "neutral" | "info" | "warn" | "danger" | "success") {
  const cls = tone === "danger" ? "bg-[var(--danger)]" : tone === "warn" ? "bg-[var(--warn)]" : tone === "success" ? "bg-[var(--success)]" : tone === "info" ? "bg-[var(--accent)]" : "bg-[var(--faint)]";
  return <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

export function ProjectOperatingOverview({
  projectId,
  workspaceName,
  project,
  onOpenTask,
  onSelectTab,
}: {
  projectId: string;
  workspaceName: string;
  project?: Project | null;
  onOpenTask: (taskId: string) => void;
  onSelectTab: (tab: string) => void;
}) {
  const projectsFallback = useAsync(
    () => (project ? Promise.resolve({ projects: [] as Project[], counts: {} as any }) : api.listProjects().catch(() => ({ projects: [] as Project[], counts: {} as any }))),
    [projectId, project?.id],
  );
  const resolvedProject = project ?? (projectsFallback.data?.projects ?? []).find((p) => p.id === projectId) ?? null;
  const load = useWorkspaceOperatingData(projectId);
  const result = load.data;
  const model = useMemo(() => (result ? computeWorkspaceOverviewModel({ ...result, project: resolvedProject }) : null), [result, resolvedProject]);

  const {
    tasks = [],
    runs = [],
    teammates = [],
    approvals = [],
    failedSources = [],
    runningTasks = [],
    queuedTasks = [],
    blockedTasks = [],
    awaitingTasks = [],
    failedTasks = [],
    doneTasks = [],
    attentionItems = [],
    deliverables = [],
    recentActivity = [],
    objective = { text: "", set: false },
  } = model ?? {};

  const runsByTask = useMemo(() => {
    const map = new Map<string, Run[]>();
    for (const run of runs) {
      const arr = map.get(run.task_id) || [];
      arr.push(run);
      map.set(run.task_id, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
    return map;
  }, [runs]);

  if (load.loading && !load.data) {
    return <LoadingState lines={8} />;
  }
  if (load.error && !load.data) {
    return <ErrorState error={load.error} onRetry={load.reload} />;
  }

  const inProgressCount = runningTasks.length + queuedTasks.length;
  const attentionCount = attentionItems.length;
  const resumeTasks = [...runningTasks, ...blockedTasks, ...awaitingTasks, ...queuedTasks, ...failedTasks]
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
    .slice(0, 6);

  const recentDone = [...doneTasks]
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .slice(0, 3);

  const nextSteps: NextStep[] = [];
  if (attentionItems.length > 0) nextSteps.push({ id: "attention", title: "Resolve what needs attention", detail: `${attentionItems.length} decision${attentionItems.length === 1 ? "" : "s"} or blocker${attentionItems.length === 1 ? "" : "s"} affecting progress.`, actionLabel: "Open work", onSelect: () => onSelectTab("Work"), primary: true });
  if (runningTasks.length > 0 || queuedTasks.length > 0) nextSteps.push({ id: "monitor", title: runningTasks.length > 0 ? "Monitor work in progress" : "Check queued work", detail: `${runningTasks.length} running, ${queuedTasks.length} queued.`, actionLabel: "View work", onSelect: () => onSelectTab("Work") });
  if (deliverables.length > 0) nextSteps.push({ id: "review", title: "Review recent deliverables", detail: `${deliverables.length} recent outcome${deliverables.length === 1 ? "" : "s"} available.`, actionLabel: "Open library", onSelect: () => onSelectTab("Knowledge") });
  if (teammates.length === 0) nextSteps.push({ id: "agents", title: "Add an AI teammate", detail: "Bring an agent into this workspace to delegate work.", actionLabel: "View agents", onSelect: () => onSelectTab("Agents"), primary: nextSteps.length === 0 });
  if (tasks.length === 0) nextSteps.push({ id: "start", title: "Start with a conversation or task", detail: "Define the objective and delegate the first piece of work.", actionLabel: "Open chat", onSelect: () => onSelectTab("Chat"), primary: nextSteps.length === 0 });
  if (nextSteps.length === 0) nextSteps.push({ id: "continue", title: "Continue in chat", detail: "Ask for an update, plan next steps, or delegate new work.", actionLabel: "Open chat", onSelect: () => onSelectTab("Chat"), primary: true });

  const isEmptyWorkspace = tasks.length === 0 && teammates.length === 0 && approvals.length === 0 && deliverables.length === 0 && !load.loading;

  return (
    <div className="flex flex-col gap-8 lg:gap-10">
      <PartialLoadNotice failed={failedSources} onRetry={load.reload} />

      <header className="flex flex-col gap-5 border-b border-[var(--border-dim)] pb-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 max-w-3xl">
            <p className="text-step--2 font-medium uppercase tracking-[0.16em] text-[var(--faint)]">Workspace</p>
            <h1 className="mt-1 text-step-3 font-semibold tracking-[-0.03em] text-[var(--text)] md:text-step-4">{workspaceName}</h1>
            <p className={`mt-3 max-w-2xl text-step-0 leading-relaxed ${objective.set ? "text-[var(--text-soft)]" : "text-[var(--muted)]"}`}>
              {objective.text}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Button onClick={() => onSelectTab("Chat")}>Ask or delegate</Button>
            <Button variant="primary" onClick={() => onSelectTab("Work")}>Start work</Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-step--1">
          <span className={attentionCount > 0 ? "text-[var(--warn)]" : "text-[var(--muted)]"}>
            <strong className="font-semibold tabular-nums">{failedSources.includes("tasks") && failedSources.includes("approvals") ? "—" : attentionCount}</strong> need attention
          </span>
          <span className="text-[var(--border)]" aria-hidden>·</span>
          <span className="text-[var(--muted)]"><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{failedSources.includes("tasks") ? "—" : inProgressCount}</strong> in progress</span>
          <span className="text-[var(--border)]" aria-hidden>·</span>
          <span className="text-[var(--muted)]"><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{failedSources.includes("tasks") ? "—" : doneTasks.length}</strong> completed</span>
          <span className="text-[var(--border)]" aria-hidden>·</span>
          <span className="text-[var(--muted)]"><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{failedSources.includes("library") && failedSources.includes("gallery") ? "—" : deliverables.length}</strong> outcomes</span>
        </div>
      </header>

      {isEmptyWorkspace ? (
        <EmptyState
          title="This workspace is ready"
          hint="Define the objective, add an AI teammate, and start in chat to turn this into an operating environment."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => onSelectTab("Agents")}>Add agent</Button>
              <Button onClick={() => onSelectTab("Chat")}>Open chat</Button>
              <Button variant="primary" onClick={() => onSelectTab("Work")}>Create work</Button>
            </div>
          }
        />
      ) : null}

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-10">
          <Section title="Needs attention" description="Decisions and blockers that affect progress." action={attentionCount > 0 ? <Button onClick={() => onSelectTab("Work")}>Open work</Button> : undefined}>
            {failedSources.includes("tasks") && failedSources.includes("approvals") ? (
              <EmptyState title="Attention status unavailable" hint="Task or approval data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : attentionItems.length === 0 ? (
              <div className="rounded-md bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">No approvals, blockers, or failures need attention right now.</div>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-md bg-[var(--surface)]">
                {attentionItems.slice(0, 6).map((item) => (
                  <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-step--1 font-medium text-[var(--text)]">{item.title}</span>
                        <Badge variant={item.tone === "danger" ? "bad" : "warn"}>{item.status}</Badge>
                      </div>
                      <p className="mt-1 text-step--2 leading-relaxed text-[var(--muted)]">{item.reason}</p>
                    </div>
                    <Button
                      variant={item.kind === "approval" ? "primary" : "default"}
                      onClick={() => {
                        if (item.taskId) onOpenTask(item.taskId);
                        else if (item.kind === "approval") onSelectTab("Approvals");
                        else onSelectTab("Work");
                      }}
                    >
                      {item.actionLabel}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Execution" description="What is running, queued, blocked, and recently completed." action={<Button onClick={() => onSelectTab("Work")}>View work</Button>}>
            {failedSources.includes("tasks") ? (
              <EmptyState title="Execution status unavailable" hint="Tasks could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : tasks.length === 0 ? (
              <EmptyState title="No work yet" hint="Create work or delegate from chat to start execution in this workspace." action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => onSelectTab("Chat")}>Ask in chat</Button><Button variant="primary" onClick={() => onSelectTab("Work")}>Create work</Button></div>} />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-step--2 text-[var(--muted)]">
                  <span><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{runningTasks.length}</strong> running</span>
                  <span><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{queuedTasks.length}</strong> queued</span>
                  <span><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{blockedTasks.length + awaitingTasks.length}</strong> blocked/awaiting</span>
                  <span><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{failedTasks.length}</strong> failed</span>
                  <span><strong className="font-semibold tabular-nums text-[var(--text-soft)]">{doneTasks.length}</strong> completed</span>
                </div>
                {resumeTasks.length > 0 ? (
                  <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-md bg-[var(--surface)]">
                    {resumeTasks.map((t) => {
                      const owner = teammates.find((m) => m.id === t.owner_teammate_id);
                      const latestRun = (runsByTask.get(t.id) || [])[0];
                      const label = t.status === "awaiting_approval" ? "Awaiting approval" : t.status === "blocked" ? "Blocked" : t.status === "failed" ? "Needs review" : t.status === "running" ? "Running" : t.status === "done" ? "Completed" : "Queued";
                      return (
                        <button key={t.id} className="flex items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset" onClick={() => onOpenTask(t.id)}>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-step--1 font-medium text-[var(--text)]">{t.title || taskTitle(t.description)}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--muted)]">
                              <span>{label}</span>
                              <span aria-hidden>·</span>
                              <span>{owner?.persona || owner?.name || "Unassigned"}</span>
                              {t.blocked_reason ? <><span aria-hidden>·</span><span className="truncate">{t.blocked_reason}</span></> : latestRun?.status ? <><span aria-hidden>·</span><span>Latest run: {latestRun.status}</span></> : null}
                            </div>
                          </div>
                          <span className="shrink-0 pt-0.5 text-step--2 text-[var(--accent)]">Open</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {recentDone.length > 0 ? (
                  <div>
                    <div className="mb-1.5 text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">Recently completed</div>
                    <div className="flex flex-col divide-y divide-[var(--border-dim)]">
                      {recentDone.map((t) => (
                        <button key={t.id} className="flex items-center justify-between gap-3 py-2 text-left transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset rounded-sm" onClick={() => onOpenTask(t.id)}>
                          <span className="truncate text-step--1 text-[var(--text-soft)]">{t.title || taskTitle(t.description)}</span>
                          <span className="shrink-0 text-step--2 text-[var(--muted)]">Completed</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </Section>

          <Section title="Deliverables" description="What this workspace has produced." action={<Button onClick={() => onSelectTab("Knowledge")}>Open library</Button>}>
            {failedSources.includes("library") && failedSources.includes("gallery") ? (
              <EmptyState title="Deliverables unavailable" hint="Library and gallery data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : deliverables.length === 0 ? (
              <EmptyState title="No deliverables yet" hint="Documents, reports, and assets produced here will appear for review." action={<Button onClick={() => onSelectTab("Chat")}>Ask for an output</Button>} />
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-md bg-[var(--surface)]">
                {deliverables.map((d) => (
                  <button key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset" onClick={() => navigate(d.href)}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="truncate text-step--1 font-medium text-[var(--text)]">{d.name}</span><Badge variant="neutral">{d.kind}</Badge></div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{d.meta}{d.when ? ` · ${relativeTime(d.when)}` : ""}</div>
                    </div>
                    <span className="shrink-0 text-step--2 text-[var(--accent)]">Open</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="flex flex-col gap-10">
          <Section title="People" description="AI teammates involved in this workspace." action={<Button onClick={() => onSelectTab("Agents")}>View agents</Button>}>
            {failedSources.includes("agents") ? (
              <EmptyState title="Agents unavailable" hint="Teammate data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : teammates.length === 0 ? (
              <EmptyState title="No teammates yet" hint="Add an AI teammate to start delegating work." action={<Button variant="primary" onClick={() => onSelectTab("Agents")}>Add agent</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {teammates.slice(0, 8).map((t) => {
                  const observed = failedSources.includes("tasks") ? null : observedAgentState(t.id, tasks);
                  const mine = tasks.filter((x) => x.owner_teammate_id === t.id && (isActiveTaskStatus(x.status) || isBlockedTaskStatus(x.status) || x.status === "failed"));
                  const current = mine[0];
                  return (
                    <button key={t.id} className="flex items-start gap-3 rounded-md bg-[var(--surface)] px-3 py-3 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset" onClick={() => navigate(`/bot/${t.id}`)}>
                      <BotFace face={t.face} size={32} status={t.status} animated />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate text-step--1 font-medium text-[var(--text)]">{t.persona || t.name || "Teammate"}</span>
                          {observed ? <span className="text-step--2 text-[var(--muted)]">{observed.label}</span> : <span className="text-step--2 text-[var(--faint)]">Status unavailable</span>}
                        </div>
                        {current ? <div className="mt-1 truncate text-step--2 text-[var(--text-soft)]">{taskTitle(current.description)}</div> : observed?.detail ? <div className="mt-1 text-step--2 text-[var(--faint)]">{observed.detail}</div> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Recent context" description="What has happened recently in this workspace.">
            {failedSources.includes("runs") && failedSources.includes("tasks") ? (
              <EmptyState title="Activity unavailable" hint="Run and task data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : recentActivity.length === 0 ? (
              <div className="rounded-md bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">No recent execution activity yet.</div>
            ) : (
              <div className="flex flex-col gap-3">
                {recentActivity.map((item) => (
                  <button key={item.id} className="flex items-start gap-3 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" onClick={() => item.href ? navigate(item.href) : onSelectTab("Work")} disabled={!item.href && false}>
                    {toneDot(item.tone)}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-step--1 text-[var(--text)]">{item.title}</div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{item.detail}{item.when ? ` · ${relativeTime(item.when)}` : ""}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Next steps" description="Suggested actions based on the current state of this workspace.">
            <div className="flex flex-col gap-2">
              {nextSteps.slice(0, 4).map((step) => (
                <div key={step.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md bg-[var(--surface)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-step--1 font-medium text-[var(--text)]">{step.title}</div>
                    <div className="mt-0.5 text-step--2 leading-relaxed text-[var(--muted)]">{step.detail}</div>
                  </div>
                  <Button variant={step.primary ? "primary" : "default"} onClick={step.onSelect}>{step.actionLabel}</Button>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
