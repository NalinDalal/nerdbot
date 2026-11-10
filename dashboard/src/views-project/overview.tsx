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
  StatusBadge,
  relativeTime,
  useAsync,
} from "../components";
import { taskTitle } from "../taskTitle";
import type { Approval, GalleryAsset, LibraryDoc, Run, Task, Teammate } from "../types";

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error }));
}

export function computeWorkspaceOverviewModel(result: {
  tasks: Settled<{ tasks: Task[] }>;
  runs: Settled<{ runs: Run[] }>;
  teammates: Settled<{ teammates: Teammate[] }>;
  approvals: Settled<{ approvals: Approval[] }>;
  library: Settled<{ docs: LibraryDoc[] }>;
  gallery: Settled<{ assets: GalleryAsset[]; total?: number }>;
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
  const attentionApprovals = approvals.filter((a) => {
    const decision = String((a as any).decision ?? (a as any).status ?? "").toLowerCase();
    return !decision || decision === "pending" || decision === "awaiting_approval";
  });

  const deliverables = [
    ...libraryDocs.map((doc) => ({
      id: `doc:${doc.id}`,
      kind: "Document",
      name: doc.title || doc.source || "Untitled document",
      when: doc.updated_at || doc.created_at || "",
      href: `/library/${doc.id}`,
      meta: doc.format || doc.kind || doc.source || "Library",
      source: "Library",
    })),
    ...galleryAssets.map((asset) => ({
      id: `asset:${asset.id}`,
      kind: "Asset",
      name: asset.name || "Untitled asset",
      when: asset.created_at || "",
      href: `/gallery`,
      meta: asset.mime_type || "Gallery",
      source: "Gallery",
    })),
  ]
    .sort((a, b) => String(b.when).localeCompare(String(a.when)))
    .slice(0, 8);

  return {
    tasks, runs, teammates, approvals, libraryDocs, galleryAssets, failedSources,
    runningTasks, queuedTasks, blockedTasks, awaitingTasks, failedTasks, attentionApprovals, deliverables,
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

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border-dim)] bg-[var(--surface)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-dim)] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-step-0 font-semibold tracking-tight text-[var(--text)]">{title}</h3>
          {description ? <p className="mt-0.5 text-step--1 text-[var(--muted)]">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

function PartialLoadNotice({ failed, onRetry }: { failed: string[]; onRetry: () => void }) {
  if (failed.length === 0) return null;
  return (
    <div className="mb-5 rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]" role="status">
      Some workspace information could not be loaded: {failed.join(", ")}. Showing available data only.{" "}
      <button className="underline underline-offset-4" onClick={onRetry}>Retry</button>
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

export function ProjectOperatingOverview({
  projectId,
  workspaceName,
  onOpenTask,
  onSelectTab,
}: {
  projectId: string;
  workspaceName: string;
  onOpenTask: (taskId: string) => void;
  onSelectTab: (tab: string) => void;
}) {
  const load = useWorkspaceOperatingData(projectId);
  const result = load.data;
  const model = useMemo(() => (result ? computeWorkspaceOverviewModel(result) : null), [result]);

  const {
    tasks = [],
    runs = [],
    teammates = [],
    approvals = [],
    libraryDocs = [],
    galleryAssets = [],
    failedSources = [],
    runningTasks = [],
    queuedTasks = [],
    blockedTasks = [],
    awaitingTasks = [],
    failedTasks = [],
    attentionApprovals = [],
    deliverables = [],
  } = model ?? {};

  const activeWork = [...runningTasks, ...queuedTasks].slice(0, 8);
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

  const hasAnyData = tasks.length + teammates.length + approvals.length + libraryDocs.length + galleryAssets.length + runs.length > 0 || failedSources.length < 6;
  const attentionCount = attentionApprovals.length + failedTasks.length + blockedTasks.length + awaitingTasks.length;

  return (
    <div className="flex flex-col gap-6">
      <PartialLoadNotice failed={failedSources} onRetry={load.reload} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="rounded-xl border border-[var(--border-dim)] bg-[var(--surface)] px-5 py-5 sm:px-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Workspace</p>
              <h2 className="mt-1 text-step-2 font-semibold tracking-tight text-[var(--text)]">{workspaceName}</h2>
              <p className="mt-2 max-w-2xl text-step--1 text-[var(--muted)]">
                Coordinate agents, track execution, and review what this workspace has produced.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => onSelectTab("Chat")}>Open chat</Button>
              <Button onClick={() => onSelectTab("Work")}>Open work</Button>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-step--2 uppercase tracking-[0.12em] text-[var(--faint)]">Objective</div>
                <div className="mt-1 text-step--1 text-[var(--text)]">No workspace objective set</div>
                <p className="mt-1 text-step--2 text-[var(--muted)]">
                  A saved workspace mission is not available yet, so this overview does not guess one.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-[var(--border-dim)] px-3 py-2.5">
              <div className="text-step--2 text-[var(--muted)]">Needs attention</div>
              <div className={`mt-1 text-step-1 font-semibold ${attentionCount > 0 ? "text-[var(--warn)]" : "text-[var(--text)]"}`}>{failedSources.includes("approvals") && failedSources.includes("tasks") ? "—" : attentionCount}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-dim)] px-3 py-2.5">
              <div className="text-step--2 text-[var(--muted)]">Active work</div>
              <div className="mt-1 text-step-1 font-semibold text-[var(--text)]">{failedSources.includes("tasks") ? "—" : runningTasks.length + queuedTasks.length}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-dim)] px-3 py-2.5">
              <div className="text-step--2 text-[var(--muted)]">Agents</div>
              <div className="mt-1 text-step-1 font-semibold text-[var(--text)]">{failedSources.includes("agents") ? "—" : teammates.length}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-dim)] px-3 py-2.5">
              <div className="text-step--2 text-[var(--muted)]">Recent deliverables</div>
              <div className="mt-1 text-step-1 font-semibold text-[var(--text)]">{failedSources.includes("library") && failedSources.includes("gallery") ? "—" : deliverables.length}</div>
            </div>
          </div>
        </section>

        <SectionCard
          title="What to do next"
          description="Useful actions based on current workspace state."
        >
          <div className="flex flex-col gap-2">
            {attentionApprovals.length > 0 ? (
              <button className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-2.5 text-left transition-colors hover:opacity-95" onClick={() => onSelectTab("Approvals")}>
                <div className="font-medium text-[var(--text)]">Review {attentionApprovals.length} pending approval{attentionApprovals.length === 1 ? "" : "s"}</div>
                <div className="text-step--2 text-[var(--muted)]">Decisions are blocking or awaiting confirmation.</div>
              </button>
            ) : null}
            {failedTasks.length > 0 ? (
              <button className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2.5 text-left" onClick={() => onOpenTask(failedTasks[0].id)}>
                <div className="font-medium text-[var(--text)]">Inspect failed work</div>
                <div className="text-step--2 text-[var(--muted)]">{failedTasks.length} task{failedTasks.length === 1 ? "" : "s"} failed. Open the latest to review and retry.</div>
              </button>
            ) : null}
            {blockedTasks.length + awaitingTasks.length > 0 ? (
              <button className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-left hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Work")}>
                <div className="font-medium text-[var(--text)]">Unblock work</div>
                <div className="text-step--2 text-[var(--muted)]">{blockedTasks.length + awaitingTasks.length} task{blockedTasks.length + awaitingTasks.length === 1 ? " is" : "s are"} blocked or awaiting approval.</div>
              </button>
            ) : null}
            {runningTasks.length + queuedTasks.length > 0 ? (
              <button className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-left hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Work")}>
                <div className="font-medium text-[var(--text)]">Monitor active execution</div>
                <div className="text-step--2 text-[var(--muted)]">{runningTasks.length} running · {queuedTasks.length} queued.</div>
              </button>
            ) : null}
            {deliverables.length > 0 ? (
              <button className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-left hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Knowledge")}>
                <div className="font-medium text-[var(--text)]">Review recent outputs</div>
                <div className="text-step--2 text-[var(--muted)]">Open recent documents and assets produced in this workspace.</div>
              </button>
            ) : null}
            {attentionCount === 0 && runningTasks.length + queuedTasks.length === 0 && deliverables.length === 0 && teammates.length === 0 ? (
              <EmptyState
                title="Set this workspace in motion"
                hint="Add agents, start a conversation, or create work to begin operating this project."
                action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => onSelectTab("Agents")}>Add or view agents</Button><Button onClick={() => onSelectTab("Chat")}>Start chat</Button><Button variant="primary" onClick={() => onSelectTab("Work")}>Create work</Button></div>}
              />
            ) : null}
            {attentionCount === 0 && (runningTasks.length + queuedTasks.length > 0 || deliverables.length > 0 || teammates.length > 0) ? (
              <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-2.5 text-step--1 text-[var(--muted)]">
                No urgent attention items detected from available data.
              </div>
            ) : null}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <SectionCard
            title="Needs attention"
            description="Approvals, failures, and blocked work linked to their source."
            action={attentionApprovals.length > 0 ? <Button onClick={() => onSelectTab("Approvals")}>Approvals</Button> : <Button onClick={() => onSelectTab("Work")}>Work</Button>}
          >
            {attentionCount === 0 ? (
              failedSources.includes("tasks") && failedSources.includes("approvals") ? (
                <EmptyState title="Attention status unavailable" hint="Task or approval data could not be loaded. Retry to check for blockers." action={<Button onClick={load.reload}>Retry</Button>} />
              ) : (
                <EmptyState title="Nothing needs attention" hint="Pending approvals, failed runs/tasks, and blockers will appear here." />
              )
            ) : (
              <div className="flex flex-col gap-2.5">
                {attentionApprovals.slice(0, 5).map((a) => (
                  <div key={a.id} className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-[var(--text)]">{a.action || "Approval requested"}</span>
                          <Badge variant="warn">Needs decision</Badge>
                        </div>
                        <div className="mt-1 text-step--2 text-[var(--muted)]">{(a as any).reason || (a as any).message || "A human decision is required."}</div>
                      </div>
                      <div className="flex gap-2">
                        {a.task_id ? <Button onClick={() => onOpenTask(a.task_id!)}>Open task</Button> : null}
                        <Button variant="primary" onClick={() => onSelectTab("Approvals")}>Review</Button>
                      </div>
                    </div>
                  </div>
                ))}
                {failedTasks.slice(0, 4).map((t) => (
                  <button key={t.id} className="rounded-lg border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-3 text-left" onClick={() => onOpenTask(t.id)}>
                    <div className="flex items-center gap-2"><span className="font-medium text-[var(--text)]">Failed task</span><StatusBadge status={t.status} /></div>
                    <div className="mt-1 text-step--1 text-[var(--text-soft)]">{t.title || taskTitle(t.description)}</div>
                    {t.blocked_reason ? <div className="mt-1 text-step--2 text-[var(--muted)]">{t.blocked_reason}</div> : null}
                  </button>
                ))}
                {[...blockedTasks, ...awaitingTasks].slice(0, 4).map((t) => (
                  <button key={t.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => onOpenTask(t.id)}>
                    <div className="flex items-center gap-2"><span className="font-medium text-[var(--text)]">{t.status === "awaiting_approval" ? "Awaiting approval" : "Blocked"}</span><StatusBadge status={t.status} /></div>
                    <div className="mt-1 text-step--1 text-[var(--text-soft)]">{t.title || taskTitle(t.description)}</div>
                    {t.blocked_reason ? <div className="mt-1 text-step--2 text-[var(--muted)]">{t.blocked_reason}</div> : null}
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Active work"
            description="Running and queued tasks with current status and links to source."
            action={<Button onClick={() => onSelectTab("Work")}>All work</Button>}
          >
            {failedSources.includes("tasks") ? (
              <EmptyState title="Work status unavailable" hint="Tasks could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : activeWork.length === 0 ? (
              <EmptyState title="No active work" hint="Running and queued tasks will appear here when work is in progress." action={<Button onClick={() => onSelectTab("Work")}>Open work</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {activeWork.map((t) => {
                  const owner = teammates.find((m) => m.id === t.owner_teammate_id);
                  const latestRun = (runsByTask.get(t.id) || [])[0];
                  return (
                    <button key={t.id} className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => onOpenTask(t.id)}>
                      <div className="min-w-0">
                        <div className="truncate text-step--1 font-medium text-[var(--text)]">{t.title || taskTitle(t.description)}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--muted)]">
                          <span>{owner?.persona || owner?.name || "Unassigned"}</span>
                          <span>·</span>
                          <span>{latestRun ? `Run ${latestRun.status}` : "Task"}</span>
                          {latestRun?.started_at ? <><span>·</span><span>{relativeTime(latestRun.started_at)}</span></> : null}
                        </div>
                      </div>
                      <StatusBadge status={t.status} />
                    </button>
                  );
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Recent deliverables"
            description="Documents and assets produced in this workspace. This view currently shows Library documents and Gallery assets. Other task outputs may be available in task or run details."
            action={<div className="flex gap-2"><Button onClick={() => onSelectTab("Knowledge")}>Knowledge</Button><Button onClick={() => onSelectTab("Files")}>Files & tools</Button></div>}
          >
            {failedSources.includes("library") && failedSources.includes("gallery") ? (
              <EmptyState title="Deliverables unavailable" hint="Library and gallery data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : deliverables.length === 0 ? (
              <EmptyState title="No deliverables yet" hint="Saved documents, reports, and uploaded assets for this workspace will appear here." action={<Button onClick={() => onSelectTab("Knowledge")}>Open knowledge</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {deliverables.map((d) => (
                  <button key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => navigate(d.href)}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-step--1 font-medium text-[var(--text)]">{d.name}</span>
                        <Badge variant="neutral">{d.kind}</Badge>
                      </div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{d.source} · {d.meta}{d.when ? ` · ${relativeTime(d.when)}` : ""}</div>
                    </div>
                    <span className="shrink-0 text-step--2 text-[var(--accent)]">Open</span>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6">
          <SectionCard
            title="Agents"
            description="Configured teammates and their observed execution in this workspace."
            action={<Button onClick={() => onSelectTab("Agents")}>Manage agents</Button>}
          >
            {failedSources.includes("agents") ? (
              <EmptyState title="Agents unavailable" hint="Teammate data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : teammates.length === 0 ? (
              <EmptyState title="No agents in this workspace" hint="Add teammates to delegate work and collaborate." action={<Button variant="primary" onClick={() => onSelectTab("Agents")}>Add agent</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {teammates.slice(0, 8).map((t) => {
                  const observed = failedSources.includes("tasks") ? null : observedAgentState(t.id, tasks);
                  const mine = tasks.filter((x) => x.owner_teammate_id === t.id && (isActiveTaskStatus(x.status) || isBlockedTaskStatus(x.status)));
                  const current = mine[0];
                  return (
                    <button key={t.id} className="flex items-start gap-3 rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => navigate(`/bot/${t.id}`)}>
                      <BotFace face={t.face} size={30} status={t.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-step--1 font-medium text-[var(--text)]">{t.persona || t.name || "Teammate"}</span>
                          <span className="text-step--2 text-[var(--faint)]">Configured: {t.status || "unknown"}</span>
                        </div>
                        <div className="mt-0.5 text-step--2 text-[var(--muted)]">
                          {observed ? <span>{observed.label}{observed.detail ? ` · ${observed.detail}` : ""}</span> : <span>Execution state unavailable (tasks not loaded)</span>}
                        </div>
                        {current ? <div className="mt-1 truncate text-step--2 text-[var(--text-soft)]">Current: {taskTitle(current.description)}</div> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Workspace areas" description="Contextual access to conversation, knowledge, files, and tools.">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button className="rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Chat")}>
                <div className="font-medium text-[var(--text)]">Chat</div>
                <div className="text-step--2 text-[var(--muted)]">Coordinate with agents and discuss this workspace.</div>
              </button>
              <button className="rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Knowledge")}>
                <div className="font-medium text-[var(--text)]">Knowledge</div>
                <div className="text-step--2 text-[var(--muted)]">Sources, memory, and workspace context.</div>
              </button>
              <button className="rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Files")}>
                <div className="font-medium text-[var(--text)]">Files & tools</div>
                <div className="text-step--2 text-[var(--muted)]">Browse files and outputs. Editors and terminals remain contextual.</div>
              </button>
              <button className="rounded-lg border border-[var(--border-dim)] bg-[var(--bg)] px-3 py-3 text-left hover:bg-[var(--surface-2)]" onClick={() => navigate(`/workbench?project=${projectId}`)}>
                <div className="font-medium text-[var(--text)]">Workbench</div>
                <div className="text-step--2 text-[var(--muted)]">Advanced editing/terminal environment when needed.</div>
              </button>
            </div>
          </SectionCard>

          {!hasAnyData && failedSources.length === 6 ? (
            <EmptyState title="Workspace data unavailable" hint="Could not load workspace information. Check your connection and retry." action={<Button variant="primary" onClick={load.reload}>Retry</Button>} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
