/** The work inbox.
 *
 *  One list of every task the fleet owns, across every workspace. The old
 *  product buried tasks inside a workspace tab, so the owner had to remember
 *  where a piece of work lived before they could look at it. This page is the
 *  spine: needs you, running, queued, done.
 *
 *  It is read-mostly on purpose. A row opens the task workbench, where the
 *  output and the actions live. The only write here is starting new work.
 */
import { useState } from "react";
import { api } from "./api";
import { navigate, notifyError } from "./app";
import type { ApprovalInboxItem, Project, ProjectCounts, Task, Teammate } from "./types";
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
  { id: "running", label: "Running", hint: "A bot is working on it now." },
  { id: "queued", label: "Queued", hint: "Ready for a bot to pick up." },
  { id: "done", label: "Done", hint: "Finished, failed, or cancelled." },
];

/** Which bucket a task belongs to. Unknown statuses are treated as queued so
 *  they stay visible instead of disappearing from every filter. */
export function bucketOf(status: string): Bucket {
  if (status === "blocked" || status === "awaiting_approval") return "needs";
  if (status === "running") return "running";
  if (status === "done" || status === "failed" || status === "cancelled") return "done";
  return "queued";
}

const titleOf = (task: Task): string =>
  task.description?.trim() || task.command?.trim() || "Untitled work";

interface WorkData {
  projects: Project[];
  counts: Record<string, ProjectCounts>;
  tasks: Task[];
  bots: Teammate[];
  decisions: ApprovalInboxItem[];
  failedWorkspaces: string[];
}

export function WorkView() {
  const data = useAsync<WorkData>(async () => {
    const [projectsRes, botsRes, inbox] = await Promise.all([
      api.listProjects(),
      api.listAllTeammates(),
      api.approvalsInbox("pending").catch(() => ({ approvals: [] })),
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
      if (result.status === "fulfilled") {
        tasks.push(...result.value.tasks);
      } else {
        failedWorkspaces.push(
          projectsRes.projects[index]?.repository || "one workspace",
        );
      }
    }
    return {
      projects: projectsRes.projects,
      counts: projectsRes.counts,
      tasks,
      bots: botsRes.teammates,
      decisions: inbox.approvals,
      failedWorkspaces,
    };
  }, []);

  const [filter, setFilter] = useState<"all" | Bucket>("all");
  const [search, setSearch] = useState("");
  const [workspace, setWorkspace] = useState("all");
  const [showNew, setShowNew] = useState(false);

  const reload = () => {
    data.reload();
  };

  if (data.loading) {
    return (
      <Page>
        <LoadingState lines={6} />
      </Page>
    );
  }
  if (data.error || !data.data) {
    return (
      <Page>
        <ErrorState error={data.error ?? "Work could not be loaded"} onRetry={data.reload} />
      </Page>
    );
  }

  const { projects, tasks, bots, decisions } = data.data;
  const projectName = new Map(
    projects.map((project) => [project.id, project.repository || "Workspace"]),
  );
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const counts = {
    needs: tasks.filter((task) => bucketOf(task.status) === "needs").length,
    running: tasks.filter((task) => bucketOf(task.status) === "running").length,
    queued: tasks.filter((task) => bucketOf(task.status) === "queued").length,
    done: tasks.filter((task) => bucketOf(task.status) === "done").length,
  };
  const query = search.trim().toLowerCase();
  const visible = tasks.filter((task) => {
    if (workspace !== "all" && task.project_id !== workspace) return false;
    if (filter !== "all" && bucketOf(task.status) !== filter) return false;
    if (!query) return true;
    const owner = task.owner_teammate_id ? botById.get(task.owner_teammate_id)?.persona : "";
    return [titleOf(task), projectName.get(task.project_id), owner, task.blocked_reason]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  const groups = BUCKETS.map((bucket) => ({
    ...bucket,
    rows: visible.filter((task) => bucketOf(task.status) === bucket.id),
  })).filter((group) => group.rows.length > 0);

  return (
    <Page>
      <PageHeader
        title="Work"
        description="Every task the fleet owns, in one place."
        actions={
          <>
            <Button onClick={reload}>Refresh</Button>
            <Button variant="primary" onClick={() => setShowNew(true)}>
              New task
            </Button>
          </>
        }
      />

      {decisions.length > 0 ? (
        <button
          onClick={() => navigate("#/approvals")}
          className="mb-5 flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-left"
        >
          <span className="text-step--1 text-[var(--text)]">
            <strong>{decisions.length}</strong>{" "}
            {decisions.length === 1 ? "decision is" : "decisions are"} waiting for you
          </span>
          <span className="text-step--1 font-medium text-[var(--warn)]">
            Review →
          </span>
        </button>
      ) : null}

      {data.data.failedWorkspaces.length > 0 ? (
        <div className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-step--1 text-[var(--muted)]">
          Could not read tasks from {data.data.failedWorkspaces.join(", ")}. The rest of the
          list is current.
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Work state">
          <FilterTab
            label="All"
            count={tasks.length}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {BUCKETS.map((bucket) => (
            <FilterTab
              key={bucket.id}
              label={bucket.label}
              count={counts[bucket.id]}
              active={filter === bucket.id}
              onClick={() => setFilter(bucket.id)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56 shrink-0">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find work"
              aria-label="Find work"
              className={`${FORM_INPUT} h-9`}
            />
          </div>
          <select
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            aria-label="Filter by workspace"
            className={`${FORM_SELECT} h-9`}
          >
            <option value="all">All workspaces</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.repository || "Workspace"}
              </option>
            ))}
          </select>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState
          title="No work yet"
          hint="Start a task and a bot will pick it up."
          action={
            <Button variant="primary" onClick={() => setShowNew(true)}>
              New task
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          hint="Try a different filter, workspace, or search."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {(filter === "all" ? groups : groups.slice(0, 1)).map((group) => (
            <section key={group.id}>
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="text-step-0 font-semibold tracking-tight text-[var(--text)]">
                  {group.label}
                </h2>
                <span className="text-step--2 text-[var(--faint)]">
                  {group.rows.length} · {group.hint}
                </span>
              </div>
              <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                {group.rows.map((task, index) => {
                  const owner = task.owner_teammate_id
                    ? botById.get(task.owner_teammate_id)
                    : undefined;
                  return (
                    <button
                      key={task.id}
                      onClick={() => navigate(`#/p/${task.project_id}/t/${task.id}`)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${
                        index > 0 ? "border-t border-[var(--border-dim)]" : ""
                      }`}
                    >
                      <StatusDot status={task.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-step-0 text-[var(--text)]">
                          {titleOf(task)}
                        </div>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-step--2 text-[var(--faint)]">
                          <span className="min-w-0 truncate">
                            {projectName.get(task.project_id) ?? "Workspace"}
                          </span>
                          <span aria-hidden>·</span>
                          <span className="min-w-0 truncate">{owner?.persona || "Unassigned"}</span>
                          {task.blocked_reason ? (
                            <>
                              {/* On a phone the reason takes its own line rather
                                  than squeezing the workspace and owner to one
                                  letter each. */}
                              <span aria-hidden className="hidden sm:inline">·</span>
                              <span
                                className="min-w-0 basis-full truncate text-[var(--warn)] sm:basis-auto"
                                title={task.blocked_reason}
                              >
                                {task.blocked_reason}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <StatusBadge status={task.status} />
                      <span aria-hidden className="text-[var(--faint)]">
                        →
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {showNew ? (
        <NewTaskModal
          projects={projects}
          bots={bots}
          onClose={() => setShowNew(false)}
          onCreated={(projectId, taskId) => {
            setShowNew(false);
            reload();
            navigate(`#/p/${projectId}/t/${taskId}`);
          }}
        />
      ) : null}
    </Page>
  );
}

function FilterTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-step--1 transition-colors ${
        active
          ? "bg-[var(--surface-3)] text-[var(--text)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-soft)]"
      }`}
    >
      {label}
      <span className="text-step--2 text-[var(--faint)]">{count}</span>
    </button>
  );
}

function NewTaskModal({
  projects,
  bots,
  onClose,
  onCreated,
}: {
  projects: Project[];
  bots: Teammate[];
  onClose: () => void;
  onCreated: (projectId: string, taskId: string) => void;
}) {
  const first = projects.find((project) => project.repository === "my-project") ?? projects[0];
  const [projectId, setProjectId] = useState(first?.id ?? "");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);

  const available = bots.filter(
    (bot) => bot.project_id === projectId && bot.status !== "archived",
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId || !description.trim()) return;
    setBusy(true);
    try {
      const task = await api.createTask(projectId, {
        description: description.trim(),
        ...(owner ? { owner_teammate_id: owner } : {}),
      });
      onCreated(projectId, task.id);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New task" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-step--1 text-[var(--muted)]">Workspace</span>
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setOwner("");
            }}
            className={FORM_SELECT}
            required
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.repository || "Workspace"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-step--1 text-[var(--muted)]">What needs doing</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            autoFocus
            required
            placeholder="Describe the work. A bot reads this as its prompt."
            className={FORM_INPUT}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-step--1 text-[var(--muted)]">Bot</span>
          <select
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            className={FORM_SELECT}
          >
            <option value="">Unassigned</option>
            {available.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.persona || "Unnamed bot"}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !description.trim() || !projectId}
          >
            {busy ? "Creating…" : "Create task"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
