import { useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Button, CHIP_SHELL, EmptyState, ErrorState, Field, FORM_INPUT, LoadingState, Modal, PageSection, StatusBadge, ERROR_BOX, relativeTime, useAsync } from "../components";
import { DataTable } from "../DataTable";
import { EntityPicker } from "../EntityPicker";
import { taskTitle, taskPreview } from "../taskTitle";
import type { Task } from "../types";

/** The task-status filter chips, in display order. "All" is one of them:
 *  the owner flips to Failed when something broke, then back to All. */
type StatusFilter = "all" | "failed" | "running" | "blocked" | "done";
const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "running", label: "Running" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

export function TasksTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: (id: string) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  /* New task drafts the two text fields (title + details), the executable
     command, and the owner/issue picks — the EntityPicker turns raw
     `owner_teammate_id` inputs into a searchable select. */
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [command, setCommand] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const tasks = useAsync(() => api.projectTasks(projectId), [projectId]);
  const runs = useAsync(() => api.projectRuns(projectId), [projectId]);
  const mates = useAsync(() => api.listTeammates(projectId), [projectId]);
  const issues = useAsync(() => api.listIssues(projectId), [projectId]);
  const mateItems = (mates.data?.teammates ?? []).map((mate) => ({
    id: mate.id,
    name: mate.persona || "Unnamed teammate",
  }));
  const issueItems = (issues.data?.issues ?? []).map((issue) => ({
    id: issue.id,
    name: issue.title || issue.id,
  }));
  const resetDraft = () => {
    setTitle("");
    setDetails("");
    setCommand("");
    setOwnerId("");
    setIssueId("");
    setSaveError(null);
  };
  const createTask = async () => {
    if (!details.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const trimmedTitle = title.trim();
      const description = trimmedTitle ? `${trimmedTitle}\n\n${details.trim()}` : details.trim();
      const task = await api.createTask(projectId, {
        title: trimmedTitle,
        description,
        command: command.trim(),
        owner_teammate_id: ownerId || null,
        issue_id: issueId || null,
      });
      setShowCreate(false);
      resetDraft();
      onOpenTask(task.id);
    } catch (err) {
      setSaveError(err);
      notifyError(err);
    } finally {
      setSaving(false);
    }
  };
  const ownerName = (id: string | null): string => {
    if (!id) return "Unassigned";
    return mates.data?.teammates.find((m) => m.id === id)?.persona || "Assigned";
  };
  const reload = () => {
    tasks.reload();
    runs.reload();
  };

  /* --- Status filter --- */

  /** The task statuses each filter chip matches. `blocked` also covers
   *  awaiting_approval: the task is standstill either way, and the owner
   *  looks for it under Blocked. */
  const FILTER_STATUSES: Record<StatusFilter, Set<string>> = {
    all: new Set(),
    failed: new Set(["failed"]),
    running: new Set(["running"]),
    blocked: new Set(["blocked", "awaiting_approval"]),
    done: new Set(["done"]),
  };
  const allTasks = tasks.data?.tasks ?? [];
  const filteredTasks =
    statusFilter === "all"
      ? allTasks
      : allTasks.filter((task) => FILTER_STATUSES[statusFilter].has(task.status));

  /**
   * The text a failed run recorded for this task's latest failure — stderr
   * first, then the output excerpt — or "" when the API provides no error
   * text (runs still loading, or the run failed without recording one), in
   * which case the badge line shows nothing rather than a guess.
   */
  const latestRunError = (task: Task): string => {
    const failedRuns = (runs.data?.runs ?? []).filter(
      (run) => run.task_id === task.id && run.status === "failed",
    );
    if (failedRuns.length === 0) return "";
    const latest = failedRuns.reduce((a, b) => (b.started_at > a.started_at ? b : a));
    return latest.stderr.trim() || latest.output_excerpt.trim();
  };

  return (
    <div>
      {showCreate ? (
        <Modal title="New task" onClose={() => setShowCreate(false)}>
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void createTask();
            }}
          >
            {saveError ? (
              <div className={`${ERROR_BOX} mb-3`} role="alert">
                {String(saveError)}
              </div>
            ) : null}
            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short title shown in lists"
                className={FORM_INPUT}
              />
            </Field>
            <Field label="Details">
              <textarea
                rows={4}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                required
                placeholder="What the bot should do, in full"
                className={`${FORM_INPUT} resize-y`}
              />
            </Field>
            <Field label="Command">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="echo ok"
                className={FORM_INPUT}
              />
            </Field>
            <Field label="Owner">
              <EntityPicker
                items={mateItems}
                value={ownerId}
                onChange={setOwnerId}
                placeholder="Search teammates"
              />
            </Field>
            <Field label="Issue">
              <EntityPicker
                items={issueItems}
                value={issueId}
                onChange={setIssueId}
                placeholder="Search issues"
              />
            </Field>
            <div className="mt-2 flex justify-end">
              <Button variant="primary" type="submit" disabled={saving || !details.trim()}>
                {saving ? "Creating…" : "Create task"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
      <PageSection
        title="Tasks"
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New task
            </Button>
            <Button onClick={reload}>Refresh</Button>
          </>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map(({ id, label }) => {
            const count =
              id === "all"
                ? allTasks.length
                : allTasks.filter((task) => FILTER_STATUSES[id].has(task.status)).length;
            const active = statusFilter === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-step--2 font-medium transition-colors ${
                  active
                    ? "bg-[var(--surface-3)] text-[var(--text)] shadow-sm"
                    : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                {label}
                <span className="tabular-nums text-[var(--faint)]">{count}</span>
              </button>
            );
          })}
        </div>
        {tasks.loading ? (
          <LoadingState />
        ) : tasks.error ? (
          <ErrorState error={tasks.error} onRetry={tasks.reload} />
        ) : filteredTasks.length > 0 ? (
          <DataTable
            columns={[
              { key: "task", header: "Task", render: (task) => (
                <div>
                  <a href={`/p/${projectId}/t/${task.id}`} onClick={() => onOpenTask(task.id)} className="line-clamp-2 break-words">
                    {task.title || taskTitle(task.description)}
                  </a>
                  <div className="text-[var(--muted)] text-step--2 truncate">{taskPreview(task.description)}</div>
                  {task.description && task.description.length > 1000 ? <span className={CHIP_SHELL}>{(task.description.length/1000).toFixed(1)}k chars</span> : null}
                </div>
              ) },
              { key: "status", header: "Status", render: (task) => (
                <div>
                  <StatusBadge status={task.status} />
                  {task.blocked_reason ? (
                    <div className="text-step--2 text-[var(--muted)]">{task.blocked_reason}</div>
                  ) : task.status === "failed" && latestRunError(task) ? (
                    <div
                      className="max-w-[22rem] line-clamp-2 text-step--2 text-[var(--muted)]"
                      title={latestRunError(task)}
                    >
                      {latestRunError(task)}
                    </div>
                  ) : null}
                </div>
              ) },
              { key: "owner", header: "Owner", render: (task) => ownerName(task.owner_teammate_id) },
            ]}
            rows={filteredTasks}
            onRowClick={(task) => onOpenTask(task.id)}
          />
        ) : (
          <EmptyState
            title={allTasks.length > 0 ? "No tasks match this filter" : "No tasks yet"}
            hint={
              allTasks.length > 0
                ? "Nothing with that status right now."
                : "Create a task above, or let a bot decompose an objective into one."
            }
          />
        )}
      </PageSection>

      <PageSection
        title="Runs across tasks"
        description="Execution evidence for every task in this project."
      >
        {runs.loading ? (
          <LoadingState />
        ) : runs.error ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : runs.data && runs.data.runs.length > 0 ? (
          <DataTable
            columns={[
              { key: "run", header: "Run", render: (run) => relativeTime(run.started_at) },
              { key: "task", header: "Task", render: (run) => {
                const taskData = tasks.data?.tasks.find((task) => task.id === run.task_id);
                const label = taskData ? taskData.title || taskTitle(taskData.description) : "Task";
                return <span className="block truncate max-w-[24rem]" title={label}>{label}</span>;
              } },
              { key: "status", header: "Status", render: (run) => <StatusBadge status={run.status} /> },
              { key: "exit", header: "Exit", render: (run) => run.exit_code ?? "—" },
              { key: "runtime", header: "Runtime", render: (run) => run.runtime },
            ]}
            rows={runs.data.runs}
            onRowClick={(run) => onOpenTask(run.task_id)}
          />
        ) : (
          <EmptyState title="No runs yet" hint="Create a task, then run it from the task page." />
        )}
      </PageSection>
    </div>
  );
}
