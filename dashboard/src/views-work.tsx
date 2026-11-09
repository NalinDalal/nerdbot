/** The work inbox / Jobs & Activity (Phase 2).
 *
 *  Unified background job management: task runs, research jobs, schedules,
 *  reminders — with filters (running/queued/scheduled/failed/done), source
 *  type, open detail, and valid cancel/retry/pause/resume actions.
 *  Also keeps the task inbox for day-to-day work.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { navigate, notifyError } from "./app";
import type { ApprovalInboxItem, JobItem, Project, ProjectCounts, ResearchJob, Task, Teammate } from "./types";
import {
  Button,
  EmptyState,
  ErrorState,
  FORM_INPUT,
  FORM_SELECT,
  LoadingState,
  Modal,
  Page,
  PageHeader,
  StatusBadge,
  StatusDot,
  useAsync,
} from "./components";

type Bucket = "needs" | "running" | "queued" | "done";

const BUCKETS: Array<{ id: Bucket; label: string; hint: string }> = [
  { id: "needs", label: "Needs you", hint: "Blocked, or waiting on a decision." },
  { id: "running", label: "Running", hint: "A teammate is working on it now." },
  { id: "queued", label: "Queued", hint: "Ready for a teammate to pick up." },
  { id: "done", label: "Done", hint: "Finished, failed, or cancelled." },
];

export function bucketOf(status: string): Bucket {
  if (status === "blocked" || status === "awaiting_approval") return "needs";
  if (status === "running") return "running";
  if (status === "done" || status === "failed" || status === "cancelled") return "done";
  return "queued";
}

const titleOf = (task: Task): string =>
  task.description?.trim() || task.command?.trim() || "Untitled work";

function jobStateBucket(status: string): "running" | "queued" | "scheduled" | "failed" | "done" | "other" {
  const s = (status || "").toLowerCase();
  if (["running", "planning", "searching", "reading", "synthesizing"].includes(s)) return "running";
  if (["queued", "pending", "ready", "awaiting_approval", "blocked"].includes(s)) return "queued";
  if (["scheduled", "paused", "disabled"].includes(s)) return "scheduled";
  if (["failed", "error", "cancelled", "canceled"].includes(s)) return "failed";
  if (["done", "fired", "completed", "succeeded", "success"].includes(s)) return "done";
  return "other";
}

interface WorkData {
  projects: Project[];
  counts: Record<string, ProjectCounts>;
  tasks: Task[];
  bots: Teammate[];
  decisions: ApprovalInboxItem[];
  researchJobs: ResearchJob[];
  failedWorkspaces: string[];
}

export function WorkView() {
  const data = useAsync<WorkData>(async () => {
    const [projectsRes, botsRes, inbox, researchRes] = await Promise.all([
      api.listProjects(),
      api.listAllTeammates(),
      api.approvalsInbox("pending").catch(() => ({ approvals: [] })),
      api.listResearchJobs(undefined, 25).catch(() => ({ jobs: [] })),
    ]);
    const settled = await Promise.allSettled(
      projectsRes.projects.map(async (project) => {
        const res = await api.projectTasks(project.id);
        return { project, tasks: res.tasks };
      }),
    );
    const tasks: Task[] = [];
    const failedWorkspaces: string[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") tasks.push(...result.value.tasks);
      else failedWorkspaces.push(projectsRes.projects[index]?.repository || "one workspace");
    }
    return {
      projects: projectsRes.projects,
      counts: projectsRes.counts,
      tasks,
      bots: botsRes.teammates,
      decisions: inbox.approvals,
      researchJobs: (researchRes.jobs || []) as ResearchJob[],
      failedWorkspaces,
    };
  }, []);

  const jobs = useAsync(async () => api.listJobs({ limit: 150 }), []);
  const [jobState, setJobState] = useState<"all" | "running" | "queued" | "scheduled" | "failed" | "done">("all");
  const [jobSource, setJobSource] = useState<"all" | "task_run" | "research" | "schedule" | "reminder">("all");
  const [jobBusy, setJobBusy] = useState<string | null>(null);

  const [filter, setFilter] = useState<"all" | "running" | "queued" | "completed" | "failed" | "needs">("all");
  const [search, setSearch] = useState("");
  const [workspace, setWorkspace] = useState("all");
  const [agent, setAgent] = useState("all");
  const [showNew, setShowNew] = useState(false);

  const reload = () => { data.reload(); jobs.reload(); };

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 5000);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        reload();
        if (!timer) timer = setInterval(() => { if (document.visibilityState === "visible") reload(); }, 5000);
      } else if (timer) { clearInterval(timer); timer = null; }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projectName = useMemo(() => new Map((data.data?.projects || []).map((p) => [p.id, p.repository || "Workspace"])), [data.data?.projects]);
  const botById = useMemo(() => new Map((data.data?.bots || []).map((b) => [b.id, b])), [data.data?.bots]);

  if (data.loading) return <Page width="data"><LoadingState lines={6} /></Page>;
  if (data.error || !data.data) return <Page><ErrorState error={data.error ?? "Work could not be loaded"} onRetry={data.reload} /></Page>;

  const { projects, tasks, bots, decisions } = data.data;
  const query = search.trim().toLowerCase();
  const queuedSorted = tasks.filter((t) => t.status === "pending" || t.status === "ready").sort((a, b) => a.id.localeCompare(b.id));
  const queuePos = new Map(queuedSorted.map((t, i) => [t.id, i + 1]));
  const matchesFilter = (task: Task): boolean => {
    if (filter === "all") return true;
    if (filter === "running") return task.status === "running";
    if (filter === "queued") return bucketOf(task.status) === "queued";
    if (filter === "completed") return task.status === "done";
    if (filter === "failed") return task.status === "failed";
    if (filter === "needs") return task.status === "blocked" || task.status === "awaiting_approval";
    return true;
  };
  const visible = tasks.filter((task) => {
    if (workspace !== "all" && task.project_id !== workspace) return false;
    if (agent !== "all" && task.owner_teammate_id !== agent) return false;
    if (!matchesFilter(task)) return false;
    if (!query) return true;
    const owner = task.owner_teammate_id ? botById.get(task.owner_teammate_id)?.persona : "";
    return [titleOf(task), projectName.get(task.project_id), owner, task.blocked_reason].filter(Boolean).join(" ").toLowerCase().includes(query);
  });
  const FILTER_LABEL: Record<string, string> = { running: "Running", queued: "Queued", completed: "Completed", failed: "Failed", needs: "Needs attention" };
  const groups = filter === "all"
    ? BUCKETS.map((bucket) => ({ ...bucket, rows: visible.filter((task) => bucketOf(task.status) === bucket.id) })).filter((g) => g.rows.length > 0)
    : [{ id: filter, label: FILTER_LABEL[filter] ?? filter, hint: "", rows: visible }].filter((g) => g.rows.length > 0);

  const allJobs = (jobs.data?.jobs || []) as JobItem[];
  const filteredJobs = allJobs.filter((j) => {
    if (jobSource !== "all" && j.source_type !== jobSource) return false;
    if (jobState === "all") return true;
    return jobStateBucket(j.status) === jobState;
  });

  const openJob = (j: JobItem) => {
    if (j.source_type === "task_run" && j.project_id && j.task_id) return navigate(`/p/${j.project_id}/t/${j.task_id}`);
    if (j.source_type === "research") {
      const lib = (j.detail as any)?.library_doc_id;
      if (lib) return navigate(`/library/${lib}`);
      if (j.thread_id) return navigate(`/chat?thread=${j.thread_id}`);
    }
    if (j.source_type === "reminder" && j.thread_id) return navigate(`/chat?thread=${j.thread_id}`);
    if (j.source_type === "schedule" && j.project_id) return navigate(`/p/${j.project_id}?tab=Schedules`);
  };

  const jobAction = async (j: JobItem, action: "cancel" | "retry" | "pause" | "resume") => {
    setJobBusy(j.id + action);
    try {
      if (j.source_type === "research") {
        if (action === "cancel") await api.cancelResearchJob(j.id);
        if (action === "retry") await api.retryResearchJob(j.id);
      } else if (j.source_type === "reminder" && action === "cancel") {
        await api.cancelReminder(j.id);
      } else if (j.source_type === "schedule") {
        if (action === "pause") await api.pauseSchedule(j.id);
        if (action === "resume") await api.resumeSchedule(j.id);
      } else if (j.source_type === "task_run" && action === "retry" && j.task_id) {
        await api.retryTask(j.task_id);
      }
      reload();
    } catch (err) { notifyError(err); } finally { setJobBusy(null); }
  };

  return (
    <Page>
      <PageHeader
        title="Activity"
        description="Jobs, schedules, reminders, and task work in one place."
        actions={<><Button onClick={reload}>Refresh</Button><Button variant="primary" onClick={() => setShowNew(true)}>New task</Button></>}
      />

      {decisions.length > 0 ? (
        <button onClick={() => navigate("/approvals")} className="mb-5 flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-left">
          <span className="text-step--1 text-[var(--text)]"><strong>{decisions.length}</strong> {decisions.length === 1 ? "decision is" : "decisions are"} waiting for you</span>
          <span className="text-step--1 font-medium text-[var(--warn)]">Review →</span>
        </button>
      ) : null}

      <section className="mb-8" aria-label="Background jobs">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-step-0 font-semibold tracking-tight text-[var(--text)]">Jobs</h2>
            <p className="text-step--2 text-[var(--faint)]">Task runs, research, schedules, and reminders.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={jobState} onChange={(e) => setJobState(e.target.value as any)} className={`${FORM_SELECT} h-9`} aria-label="Job status filter">
              <option value="all">All states</option>
              <option value="running">Running</option>
              <option value="queued">Queued</option>
              <option value="scheduled">Scheduled</option>
              <option value="failed">Failed</option>
              <option value="done">Done</option>
            </select>
            <select value={jobSource} onChange={(e) => setJobSource(e.target.value as any)} className={`${FORM_SELECT} h-9`} aria-label="Job source filter">
              <option value="all">All sources</option>
              <option value="task_run">Task runs</option>
              <option value="research">Research</option>
              <option value="schedule">Schedules</option>
              <option value="reminder">Reminders</option>
            </select>
          </div>
        </div>
        {jobs.loading ? <LoadingState lines={4} /> : jobs.error ? <ErrorState error={jobs.error} onRetry={jobs.reload} /> : filteredJobs.length === 0 ? (
          <EmptyState title="No jobs match" hint="Background work, research, schedules, and reminders will appear here." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {filteredJobs.slice(0, 60).map((j, i) => (
              <div key={`${j.source_type}-${j.id}`} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-[var(--border-dim)]" : ""}`}>
                <StatusDot status={j.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-step-0 text-[var(--text)]">{j.title || j.id}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-step--2 text-[var(--faint)]">
                    <span className="rounded bg-[var(--surface-3)] px-1.5 py-0.5">{j.source_type.replace("_", " ")}</span>
                    {j.project_id ? <span>{projectName.get(j.project_id) || "Workspace"}</span> : null}
                    {j.next_run_at ? <span>· next {new Date(j.next_run_at).toLocaleString()}</span> : null}
                    {j.due_at ? <span>· due {new Date(j.due_at).toLocaleString()}</span> : null}
                    {j.error ? <span className="truncate text-[var(--danger)]">· {j.error}</span> : null}
                  </div>
                </div>
                <StatusBadge status={j.status} />
                <div className="flex flex-wrap items-center gap-2">
                  {j.actions?.open ? <button type="button" className="text-step--2 font-medium text-[var(--accent)] hover:underline" onClick={() => openJob(j)}>Open</button> : null}
                  {j.actions?.cancel ? <Button disabled={jobBusy === j.id + "cancel"} onClick={() => void jobAction(j, "cancel")}>Cancel</Button> : null}
                  {j.actions?.retry ? <Button disabled={jobBusy === j.id + "retry"} onClick={() => void jobAction(j, "retry")}>Retry</Button> : null}
                  {j.actions?.pause ? <Button disabled={jobBusy === j.id + "pause"} onClick={() => void jobAction(j, "pause")}>Pause</Button> : null}
                  {j.actions?.resume ? <Button disabled={jobBusy === j.id + "resume"} onClick={() => void jobAction(j, "resume")}>Resume</Button> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Task state">
          <FilterTab label="All" count={tasks.length} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterTab label="Running" count={tasks.filter((t) => t.status === "running").length} active={filter === "running"} onClick={() => setFilter("running")} />
          <FilterTab label="Queued" count={tasks.filter((t) => bucketOf(t.status) === "queued").length} active={filter === "queued"} onClick={() => setFilter("queued")} />
          <FilterTab label="Completed" count={tasks.filter((t) => t.status === "done").length} active={filter === "completed"} onClick={() => setFilter("completed")} />
          <FilterTab label="Failed" count={tasks.filter((t) => t.status === "failed").length} active={filter === "failed"} onClick={() => setFilter("failed")} />
          <FilterTab label="Needs attention" count={tasks.filter((t) => t.status === "blocked" || t.status === "awaiting_approval").length} active={filter === "needs"} onClick={() => setFilter("needs")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56 shrink-0"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find task" aria-label="Find task" className={`${FORM_INPUT} h-9`} /></div>
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Filter by project" className={`${FORM_SELECT} h-9`}>
            <option value="all">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.repository || "Workspace"}</option>)}
          </select>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filter by agent" className={`${FORM_SELECT} h-9`}>
            <option value="all">All agents</option>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.persona || b.id}</option>)}
          </select>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState title="No work yet" hint="Start a task and a teammate will pick it up." action={<Button variant="primary" onClick={() => setShowNew(true)}>New task</Button>} />
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing matches" hint="Try a different filter, project, or search." />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.id}>
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="text-step-0 font-semibold tracking-tight text-[var(--text)]">{group.label}</h2>
                <span className="text-step--2 text-[var(--faint)]">{group.rows.length}</span>
              </div>
              <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                {group.rows.map((task, index) => {
                  const owner = task.owner_teammate_id ? botById.get(task.owner_teammate_id) : undefined;
                  return (
                    <button key={task.id} onClick={() => navigate(`/p/${task.project_id}/t/${task.id}`)} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${index > 0 ? "border-t border-[var(--border-dim)]" : ""}`}>
                      <StatusDot status={task.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-step-0 text-[var(--text)]">{titleOf(task)}</div>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-step--2 text-[var(--faint)]">
                          <span className="min-w-0 truncate">{projectName.get(task.project_id) ?? "Workspace"}</span>
                          <span aria-hidden>·</span><span className="min-w-0 truncate">{owner?.persona || "Unassigned"}</span>
                          {queuePos.has(task.id) ? <><span aria-hidden>·</span><span className="text-[var(--info)]">queue #{queuePos.get(task.id)}</span></> : null}
                          {task.blocked_reason ? <><span aria-hidden className="hidden sm:inline">·</span><span className="min-w-0 basis-full truncate text-[var(--warn)] sm:basis-auto" title={task.blocked_reason}>{task.blocked_reason}</span></> : null}
                        </div>
                      </div>
                      <StatusBadge status={task.status} />
                      <span aria-hidden className="text-[var(--faint)]">→</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {showNew ? (
        <NewTaskModal projects={projects} bots={bots} onClose={() => setShowNew(false)} onCreated={(projectId, taskId) => { setShowNew(false); reload(); navigate(`/p/${projectId}/t/${taskId}`); }} />
      ) : null}
    </Page>
  );
}

function FilterTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void; }) {
  return (
    <button role="tab" aria-selected={active} onClick={onClick} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-step--1 transition-colors ${active ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"}`}>
      {label}{count > 0 ? <span className={active ? "text-[var(--muted)]" : "text-[var(--faint)]"}>{count}</span> : null}
    </button>
  );
}

function NewTaskModal({ projects, bots, onClose, onCreated }: { projects: Project[]; bots: Teammate[]; onClose: () => void; onCreated: (projectId: string, taskId: string) => void; }) {
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState("");
  const [busy, setBusy] = useState(false);
  const projectBots = bots.filter((b) => b.project_id === projectId);
  return (
    <Modal title="New task" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="text-step--1"><div className="mb-1 font-medium">Project</div>
          <select className={FORM_SELECT} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.repository || "Workspace"}</option>)}
          </select>
        </label>
        <label className="text-step--1"><div className="mb-1 font-medium">What needs doing</div>
          <textarea className={FORM_INPUT} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <label className="text-step--1"><div className="mb-1 font-medium">Command (optional)</div>
          <input className={`${FORM_INPUT} mono`} value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <label className="text-step--1"><div className="mb-1 font-medium">Assign to (optional)</div>
          <select className={FORM_SELECT} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Unassigned</option>
            {projectBots.map((b) => <option key={b.id} value={b.id}>{b.persona || b.id}</option>)}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !description.trim() || !projectId} onClick={async () => {
            setBusy(true);
            try {
              const task = await api.createTask(projectId, { description, command: command || undefined, owner_teammate_id: ownerId || undefined });
              onCreated(projectId, task.id);
            } catch (err) { notifyError(err); } finally { setBusy(false); }
          }}>Create task</Button>
        </div>
      </div>
    </Modal>
  );
}
