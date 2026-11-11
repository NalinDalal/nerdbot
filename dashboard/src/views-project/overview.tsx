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
          {description ? <p className="mt-0.5 max-w-2xl text-step--1 text-[var(--muted)]">{description}</p> : null}
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
    failedSources = [],
    runningTasks = [],
    queuedTasks = [],
    blockedTasks = [],
    awaitingTasks = [],
    failedTasks = [],
    attentionApprovals = [],
    deliverables = [],
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

  const attentionCount = attentionApprovals.length + failedTasks.length + blockedTasks.length + awaitingTasks.length;

  const resumeTasks = [...runningTasks, ...blockedTasks, ...awaitingTasks, ...queuedTasks, ...failedTasks]
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-8">
      <PartialLoadNotice failed={failedSources} onRetry={load.reload} />

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <p className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">Workspace</p>
            <h2 className="mt-1 text-step-3 font-semibold tracking-tight text-[var(--text)]">{workspaceName}</h2>
            <p className="mt-2 text-step-0 text-[var(--muted)]">
              Resume work, make decisions, and review what your AI teammates have produced.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onSelectTab("Chat")}>Ask or delegate</Button>
            <Button variant="primary" onClick={() => onSelectTab("Work")}>Start work</Button>
          </div>
        </div>

        {attentionCount > 0 || resumeTasks.length > 0 || deliverables.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <button className="rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => attentionCount > 0 ? undefined : onSelectTab("Work")}>
              <div className="text-step--2 text-[var(--muted)]">Needs attention</div>
              <div className={`mt-1 text-step-1 font-semibold ${attentionCount > 0 ? "text-[var(--warn)]" : "text-[var(--text)]"}`}>
                {failedSources.includes("approvals") && failedSources.includes("tasks") ? "—" : attentionCount}
              </div>
              <div className="mt-1 text-step--2 text-[var(--faint)]">Approvals, blockers, failures</div>
            </button>
            <button className="rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Work")}>
              <div className="text-step--2 text-[var(--muted)]">In progress</div>
              <div className="mt-1 text-step-1 font-semibold text-[var(--text)]">
                {failedSources.includes("tasks") ? "—" : runningTasks.length + queuedTasks.length}
              </div>
              <div className="mt-1 text-step--2 text-[var(--faint)]">Running and queued work</div>
            </button>
            <button className="rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => onSelectTab("Knowledge")}>
              <div className="text-step--2 text-[var(--muted)]">Recent outcomes</div>
              <div className="mt-1 text-step-1 font-semibold text-[var(--text)]">
                {failedSources.includes("library") && failedSources.includes("gallery") ? "—" : deliverables.length}
              </div>
              <div className="mt-1 text-step--2 text-[var(--faint)]">Openable deliverables</div>
            </button>
          </div>
        ) : null}
      </section>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <Section title="Continue work" description="Pick up what’s underway or needs a next step.">
            {failedSources.includes("tasks") ? (
              <EmptyState title="Work status unavailable" hint="Tasks could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : resumeTasks.length === 0 ? (
              <EmptyState title="Nothing in progress" hint="Start by asking in chat or creating work for a teammate." action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => onSelectTab("Chat")}>Ask or delegate</Button><Button variant="primary" onClick={() => onSelectTab("Work")}>Start work</Button></div>} />
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]">
                {resumeTasks.map((t) => {
                  const owner = teammates.find((m) => m.id === t.owner_teammate_id);
                  const latestRun = (runsByTask.get(t.id) || [])[0];
                  const label = t.status === "awaiting_approval" ? "Awaiting approval" : t.status === "blocked" ? "Blocked" : t.status === "failed" ? "Needs review" : t.status === "running" ? "In progress" : "Queued";
                  return (
                    <button key={t.id} className="flex items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => onOpenTask(t.id)}>
                      <div className="min-w-0">
                        <div className="truncate text-step--1 font-medium text-[var(--text)]">{t.title || taskTitle(t.description)}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-step--2 text-[var(--muted)]">
                          <span>{label}</span>
                          <span>·</span>
                          <span>{owner?.persona || owner?.name || "Unassigned"}</span>
                          {t.blocked_reason ? <><span>·</span><span className="truncate">{t.blocked_reason}</span></> : latestRun?.status ? <><span>·</span><span>Latest run: {latestRun.status}</span></> : null}
                        </div>
                      </div>
                      <span className="shrink-0 text-step--2 text-[var(--accent)]">Open</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Needs attention" description="Decisions and blockers that affect progress." action={attentionCount > 0 ? <Button onClick={() => onSelectTab("Work")}>View work</Button> : undefined}>
            {attentionCount === 0 ? (
              failedSources.includes("tasks") && failedSources.includes("approvals") ? (
                <EmptyState title="Attention status unavailable" hint="Task or approval data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
              ) : (
                <div className="rounded-lg bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">No approvals, blockers, or failures need attention right now.</div>
              )
            ) : (
              <div className="flex flex-col gap-2">
                {attentionApprovals.slice(0, 4).map((a) => (
                  <div key={a.id} className="rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-dim)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--text)]">{a.action || "Approval requested"}</div>
                        <div className="mt-1 text-step--2 text-[var(--muted)]">{(a as any).reason || (a as any).message || "A decision is required to continue."}</div>
                      </div>
                      <Button variant="primary" onClick={() => a.task_id ? onOpenTask(a.task_id) : onSelectTab("Approvals")}>Review</Button>
                    </div>
                  </div>
                ))}
                {failedTasks.slice(0, 3).map((t) => (
                  <button key={t.id} className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger-dim)] px-4 py-3 text-left" onClick={() => onOpenTask(t.id)}>
                    <div className="font-medium text-[var(--text)]">{t.title || taskTitle(t.description)}</div>
                    <div className="mt-1 text-step--2 text-[var(--muted)]">Failed — open to review what happened and try again.</div>
                  </button>
                ))}
                {[...blockedTasks, ...awaitingTasks].filter((t) => !failedTasks.some(f => f.id===t.id)).slice(0, 3).map((t) => (
                  <button key={t.id} className="rounded-lg bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => onOpenTask(t.id)}>
                    <div className="flex items-center gap-2"><span className="font-medium text-[var(--text)]">{t.title || taskTitle(t.description)}</span><StatusBadge status={t.status} /></div>
                    <div className="mt-1 text-step--2 text-[var(--muted)]">{t.blocked_reason || (t.status === "awaiting_approval" ? "Waiting for approval." : "Blocked and needs input.")}</div>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Recent outcomes" description="Deliverables produced in this workspace." action={<Button onClick={() => onSelectTab("Knowledge")}>Open library</Button>}>
            {failedSources.includes("library") && failedSources.includes("gallery") ? (
              <EmptyState title="Outcomes unavailable" hint="Library and gallery data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : deliverables.length === 0 ? (
              <EmptyState title="No outcomes yet" hint="Documents and assets produced here will appear for review." action={<Button onClick={() => onSelectTab("Chat")}>Ask a teammate to produce something</Button>} />
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]">
                {deliverables.map((d) => (
                  <button key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(d.href)}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><span className="truncate text-step--1 font-medium text-[var(--text)]">{d.name}</span><Badge variant="neutral">{d.kind}</Badge></div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{d.meta}{d.when ? ` · ${relativeTime(d.when)}` : ""}</div>
                    </div>
                    <span className="shrink-0 text-step--2 text-[var(--accent)]">Open</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="flex flex-col gap-8">
          <Section title="AI teammates" description="Collaborators in this workspace." action={<Button onClick={() => onSelectTab("Agents")}>View agents</Button>}>
            {failedSources.includes("agents") ? (
              <EmptyState title="Agents unavailable" hint="Teammate data could not be loaded." action={<Button onClick={load.reload}>Retry</Button>} />
            ) : teammates.length === 0 ? (
              <EmptyState title="No teammates yet" hint="Add an AI teammate to start delegating work." action={<Button variant="primary" onClick={() => onSelectTab("Agents")}>Add agent</Button>} />
            ) : (
              <div className="flex flex-col gap-2">
                {teammates.slice(0, 6).map((t) => {
                  const observed = failedSources.includes("tasks") ? null : observedAgentState(t.id, tasks);
                  const mine = tasks.filter((x) => x.owner_teammate_id === t.id && (isActiveTaskStatus(x.status) || isBlockedTaskStatus(x.status)));
                  const current = mine[0];
                  return (
                    <button key={t.id} className="flex items-start gap-3 rounded-lg bg-[var(--surface)] px-3 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/bot/${t.id}`)}>
                      <BotFace face={t.face} size={30} status={t.status} animated />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-step--1 font-medium text-[var(--text)]">{t.persona || t.name || "Teammate"}</div>
                        <div className="mt-0.5 text-step--2 text-[var(--muted)]">{observed ? observed.label : "Status unavailable"}</div>
                        {current ? <div className="mt-1 truncate text-step--2 text-[var(--text-soft)]">On: {taskTitle(current.description)}</div> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      </div>

      {tasks.length === 0 && teammates.length === 0 && approvals.length === 0 && deliverables.length === 0 && !load.loading ? (
        <EmptyState title="This workspace is ready" hint="Start by chatting with an AI teammate, adding an agent, or creating work." action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => onSelectTab("Agents")}>Add agent</Button><Button onClick={() => onSelectTab("Chat")}>Open chat</Button><Button variant="primary" onClick={() => onSelectTab("Work")}>Start work</Button></div>} />
      ) : null}
    </div>
  );
}
