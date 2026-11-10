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
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

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
      return navigate(`/chat`);
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
      } else if (j.source_type === "task_run") {
        if (action === "retry" && j.task_id) await api.retryTask(j.task_id);
        if (action === "cancel") {
          // cancel the specific run by id if API supports; fall back to task context
          try { await (api as any).cancelRun?.(j.id); } catch { /* best effort */ }
        }
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
            <p className="text-step--2 text-[var(--faint)]">Unified statuses, timestamps, logs, and actions for all background work.</p>
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
            {filteredJobs.slice(0, 80).map((j, i) => {
              const key = `${j.source_type}-${j.id}`;
              const expanded = expandedJob === key;
              return (
                <div key={key} className={i > 0 ? "border-t border-[var(--border-dim)]" : ""}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <StatusDot status={j.status} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpandedJob(expanded ? null : key)}>
                      <div className="truncate text-step-0 text-[var(--text)]">{j.title || j.id}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-step--2 text-[var(--faint)]">
                        <span className="rounded bg-[var(--surface-3)] px-1.5 py-0.5">{j.source_type.replace("_", " ")}</span>
                        <span className="mono">{j.status}</span>
                        {j.project_id ? <span>· {projectName.get(j.project_id) || "Workspace"}</span> : null}
                        {j.created_at ? <span>· created {new Date(j.created_at).toLocaleString()}</span> : null}
                        {j.updated_at ? <span>· updated {new Date(j.updated_at).toLocaleString()}</span> : null}
                        {j.next_run_at ? <span>· next {new Date(j.next_run_at).toLocaleString()}</span> : null}
                        {j.due_at ? <span>· due {new Date(j.due_at).toLocaleString()}</span> : null}
                      </div>
                    </button>
                    <StatusBadge status={j.status} />
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="text-step--2 text-[var(--muted)] hover:underline" onClick={() => setExpandedJob(expanded ? null : key)}>{expanded ? "Hide log" : "Log"}</button>
                      {j.actions?.open ? <button type="button" className="text-step--2 font-medium text-[var(--accent)] hover:underline" onClick={() => openJob(j)}>Open</button> : null}
                      {j.actions?.cancel ? <Button disabled={jobBusy === j.id + "cancel"} onClick={() => void jobAction(j, "cancel")}>Cancel</Button> : null}
                      {j.actions?.retry ? <Button disabled={jobBusy === j.id + "retry"} onClick={() => void jobAction(j, "retry")}>Retry</Button> : null}
                      {j.actions?.pause ? <Button disabled={jobBusy === j.id + "pause"} onClick={() => void jobAction(j, "pause")}>Pause</Button> : null}
                      {j.actions?.resume ? <Button disabled={jobBusy === j.id + "resume"} onClick={() => void jobAction(j, "resume")}>Resume</Button> : null}
                    </div>
                  </div>
                  {expanded ? <JobDrilldown job={j} /> : null}
                </div>
              );
            })}
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


function JobDrilldown({ job }: { job: JobItem }) {
  const [events, setEvents] = useState<any[]>([]);
  const [scheduleRuns, setScheduleRuns] = useState<any[]>([]);
  const [runEvents, setRunEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setEvents([]);
      setScheduleRuns([]);
      setRunEvents([]);
      setError(null);
      try {
        if (job.source_type === "research") {
          const r = await api.getResearchJobEvents(job.id, 0);
          if (alive) setEvents(r.events || []);
        } else if (job.source_type === "schedule") {
          const r = await api.listScheduleRuns(job.id, 20);
          if (alive) setScheduleRuns((r as any).runs || []);
        } else if (job.source_type === "task_run") {
          const r = await api.runEvents(job.id, 0);
          if (alive) setRunEvents(((r as any).events || []) as any[]);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [job.id, job.source_type, job.status, job.updated_at]);

  const fmt = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");

  return (
    <div className="border-t border-[var(--border-dim)] bg-[var(--surface-2)] px-4 py-3 text-step--1">
      <div className="mb-2 grid gap-x-4 gap-y-1 text-[var(--faint)] sm:grid-cols-2 lg:grid-cols-3">
        <span>ID: <span className="mono text-[var(--text-soft)]">{job.id}</span></span>
        <span>Source: <span className="text-[var(--text-soft)]">{job.source_type}</span></span>
        <span>Status: <span className="text-[var(--text-soft)]">{job.status}</span></span>
        <span>Created: <span className="text-[var(--text-soft)]">{fmt(job.created_at)}</span></span>
        <span>Updated: <span className="text-[var(--text-soft)]">{fmt(job.updated_at)}</span></span>
        {job.next_run_at ? <span>Next run: <span className="text-[var(--text-soft)]">{fmt(job.next_run_at)}</span></span> : null}
        {job.due_at ? <span>Due: <span className="text-[var(--text-soft)]">{fmt(job.due_at)}</span></span> : null}
        {job.project_id ? <span>Workspace: <span className="mono text-[var(--text-soft)]">{job.project_id}</span></span> : null}
        {job.task_id ? <span>Task: <span className="mono text-[var(--text-soft)]">{job.task_id}</span></span> : null}
        {job.thread_id ? <span>Thread: <span className="mono text-[var(--text-soft)]">{job.thread_id}</span></span> : null}
        {job.last_run_status ? <span>Last run: <span className="text-[var(--text-soft)]">{job.last_run_status}</span></span> : null}
      </div>
      {job.error ? <div className="mb-2 rounded-md bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]">Error: {job.error}</div> : null}
      {job.detail ? (
        <details className="mb-2 rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2">
          <summary className="cursor-pointer text-step--2 font-medium text-[var(--muted)]">Details</summary>
          <pre className="mt-2 max-h-48 overflow-auto text-step--2 text-[var(--muted)]">{JSON.stringify(job.detail, null, 2)}</pre>
        </details>
      ) : null}
      <div className="mb-3 flex flex-wrap gap-2">
        {job.source_type === "task_run" && job.project_id && job.task_id ? <Button onClick={() => navigate(`/p/${job.project_id}/t/${job.task_id}`)}>Open task & run logs</Button> : null}
        {job.source_type === "research" && job.thread_id ? <Button onClick={() => navigate(`/chat?thread=${job.thread_id}`)}>Open source chat</Button> : null}
        {job.source_type === "research" && (job.detail as any)?.library_doc_id ? <Button onClick={() => navigate(`/library/${(job.detail as any).library_doc_id}`)}>Open report doc</Button> : null}
        {job.source_type === "reminder" && job.thread_id ? <Button onClick={() => navigate(`/chat?thread=${job.thread_id}`)}>Open source chat</Button> : null}
        {job.source_type === "reminder" && job.project_id ? <Button onClick={() => navigate(`/p/${job.project_id}`)}>Open workspace</Button> : null}
        {job.source_type === "schedule" && job.project_id ? <Button onClick={() => navigate(`/p/${job.project_id}?tab=Schedules`)}>Open schedule</Button> : null}
      </div>

      {job.source_type === "research" ? (
        <LogSection title="Event log" loading={loading} error={error} empty={!loading && !error && events.length === 0} emptyText="No events yet.">
          <ul className="max-h-56 space-y-1 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2">
            {events.map((ev: any, idx: number) => (
              <li key={ev.seq ?? idx} className="flex gap-2 text-step--2">
                <span className="mono shrink-0 text-[var(--faint)]">{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ""}</span>
                <span className="shrink-0 rounded bg-[var(--surface-3)] px-1 text-[var(--muted)]">{ev.kind}</span>
                <span className="min-w-0 break-words text-[var(--text-soft)]">{ev.content}{ev.data && Object.keys(ev.data).length ? <span className="text-[var(--faint)]"> {JSON.stringify(ev.data)}</span> : null}</span>
              </li>
            ))}
          </ul>
        </LogSection>
      ) : job.source_type === "schedule" ? (
        <LogSection title="Recent runs" loading={loading} error={error} empty={!loading && !error && scheduleRuns.length === 0} emptyText="No runs recorded yet.">
          <ul className="max-h-56 space-y-1 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2">
            {scheduleRuns.map((r: any) => (
              <li key={r.id} className="flex flex-wrap gap-x-3 gap-y-0.5 text-step--2">
                <span className="mono text-[var(--faint)]">{r.fired_at ? new Date(r.fired_at).toLocaleString() : ""}</span>
                <span className="rounded bg-[var(--surface-3)] px-1 text-[var(--muted)]">{r.status}</span>
                {r.task_id ? <button className="text-[var(--accent)] hover:underline" onClick={() => job.project_id && navigate(`/p/${job.project_id}/t/${r.task_id}`)}>task {r.task_id}</button> : null}
                {r.error ? <span className="text-[var(--danger)]">{r.error}</span> : null}
              </li>
            ))}
          </ul>
        </LogSection>
      ) : job.source_type === "task_run" ? (
        <LogSection title="Run events" loading={loading} error={error} empty={!loading && !error && runEvents.length === 0} emptyText="No events captured yet. Open task for full logs.">
          <ul className="max-h-56 space-y-1 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-2">
            {runEvents.slice(-80).map((ev: any, idx: number) => (
              <li key={ev.seq ?? idx} className="flex gap-2 text-step--2">
                <span className="mono shrink-0 text-[var(--faint)]">{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ""}</span>
                <span className="shrink-0 rounded bg-[var(--surface-3)] px-1 text-[var(--muted)]">{ev.kind || "event"}</span>
                <span className="min-w-0 break-words text-[var(--text-soft)]">{ev.content || ""}</span>
              </li>
            ))}
          </ul>
        </LogSection>
      ) : job.source_type === "reminder" ? (
        <div className="rounded-md border border-[var(--border-dim)] bg-[var(--surface)] p-3 text-step--1 text-[var(--text-soft)]">
          <div>Message: <span className="text-[var(--text)]">{job.title}</span></div>
          <div className="mt-1 text-[var(--faint)]">Status {job.status}{job.due_at ? ` · due ${fmt(job.due_at)}` : ""}{job.updated_at ? ` · updated ${fmt(job.updated_at)}` : ""}</div>
          {(job.detail as any)?.notify_channel ? <div className="mt-1 text-[var(--faint)]">Channel: {(job.detail as any).notify_channel}</div> : null}
        </div>
      ) : (
        <div className="text-[var(--faint)]">Open source for full logs and context.</div>
      )}
    </div>
  );
}

function LogSection({ title, loading, error, empty, emptyText, children }: { title: string; loading: boolean; error: string | null; empty: boolean; emptyText: string; children: any }) {
  return (
    <div>
      <div className="mb-1 text-step--2 font-medium uppercase tracking-wider text-[var(--faint)]">{title}</div>
      {loading ? <LoadingState lines={2} /> : error ? <div className="rounded-md bg-[var(--danger-dim)] px-3 py-2 text-[var(--danger)]">{error}</div> : empty ? (
        <div className="text-[var(--faint)]">{emptyText}</div>
      ) : children}
    </div>
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
