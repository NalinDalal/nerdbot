import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, describeError } from "./api";
import { navigate, notifyError } from "./app";
import {
  Badge,
  Button,
  EmptyState,
  FORM_SELECT,
  LoadingState,
  Page,
  PageHeader,
  PageSection,
  StatusBadge,
  relativeTime,
  runStatusLabel,
  useAsync,
} from "./components";
import type {
  Notification,
  OrgAttentionItem,
  OrgTaskRow,
  Plan,
  PlanSubTask,
} from "./types";

/* The Home surface is the operating desk, not a dashboard of decoration.
 * Every number comes from /organization/overview, which reads the database
 * once, so the page cannot disagree with itself. Nothing is estimated in the
 * browser and no placeholder metric is ever shown. */

type PlanPreview = {
  objective: string;
  plan: Plan;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function attentionTone(item: OrgAttentionItem): "bad" | "warn" {
  return item.severity === "danger" ? "bad" : "warn";
}

function taskMeta(task: OrgTaskRow): string {
  const bits = [task.project_name];
  if (task.owner_name) bits.push(task.owner_name);
  return bits.join(" · ");
}

/** A compact, factual number. The strip uses dividers instead of five
 *  separate cards so the page keeps one visual object at the top. */
function Kpi({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
}) {
  const toneClass =
    tone === "ok"
      ? "text-[var(--accent)]"
      : tone === "warn"
        ? "text-[var(--warn)]"
        : tone === "bad"
          ? "text-[var(--danger)]"
          : "text-[var(--text)]";
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">
        {label}
      </div>
      <div className={`mt-1 text-step-2 font-semibold tabular-nums tracking-tight ${toneClass}`}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-step--2 text-[var(--muted)]" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function PlanRow({
  step,
  index,
  ownerName,
  editing,
  onChange,
}: {
  step: PlanSubTask;
  index: number;
  ownerName: string;
  editing: boolean;
  onChange: (index: number, patch: Partial<PlanSubTask>) => void;
}) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-3)] text-step--2 font-medium tabular-nums text-[var(--text-soft)]">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <>
            <input
              value={step.description}
              onChange={(event) => onChange(index, { description: event.target.value })}
              aria-label={`Step ${index + 1} description`}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-step--1 font-medium text-[var(--text)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
            />
            <input
              value={step.command}
              onChange={(event) => onChange(index, { command: event.target.value })}
              placeholder="No shell command — the agent decides how to do it"
              aria-label={`Step ${index + 1} command`}
              className="mono mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-step--2 text-[var(--text-soft)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
            />
          </>
        ) : (
          <>
            <div className="text-step--1 font-medium text-[var(--text)]">{step.description}</div>
            {step.command ? (
              <code className="mono mt-1 block truncate rounded bg-[var(--surface-2)] px-2 py-1 text-step--2 text-[var(--text-soft)]" title={step.command}>
                {step.command}
              </code>
            ) : (
              <div className="mt-1 text-step--2 text-[var(--faint)]">
                No shell command — the agent decides how to do it.
              </div>
            )}
          </>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--2 text-[var(--muted)]">
          <span>{ownerName}</span>
          {step.depends_on.length > 0 ? (
            <span>after {step.depends_on.map((dep) => dep + 1).join(", ")}</span>
          ) : (
            <span>starts immediately</span>
          )}
        </div>
      </div>
    </li>
  );
}

export function HomeOverviewView() {
  const overview = useAsync(() => api.organizationOverview(), []);
  const data = overview.data;

  const [workspaceId, setWorkspaceId] = useState("");
  const [objective, setObjective] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [approved, setApproved] = useState<{ count: number; workspace: string } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const projects = useMemo(() => data?.projects ?? [], [data?.projects]);
  const selected = useMemo(
    () => projects.find((project) => project.id === workspaceId) ?? null,
    [projects, workspaceId],
  );

  useEffect(() => {
    if (projects.length === 0) {
      if (workspaceId) setWorkspaceId("");
      return;
    }
    if (projects.some((project) => project.id === workspaceId)) return;
    const preferred = projects.find((project) => project.provider_ready) ?? projects[0];
    setWorkspaceId(preferred.id);
  }, [projects, workspaceId]);

  const agentNames = useMemo(() => {
    const out = new Map<string, string>();
    for (const agent of data?.agents_list ?? []) out.set(agent.id, agent.name);
    return out;
  }, [data?.agents_list]);

  const needsAttention =
    (data?.tasks.blocked ?? 0) +
    (data?.tasks.failed ?? 0) +
    (data?.approvals.pending ?? 0) +
    projects.filter((project) => !project.provider_ready).length;

  const setup = data
    ? [
        { key: "workspace", label: "Workspace", done: data.project_count > 0, href: "/projects" },
        {
          key: "model",
          label: "Model provider",
          done: data.provider_ready_projects > 0,
          href: "/settings",
        },
        { key: "agent", label: "Agent", done: data.agents.total > 0, href: "/agents" },
        { key: "work", label: "First objective", done: data.tasks.total > 0, href: "/work" },
      ]
    : [];
  const setupComplete = setup.length > 0 && setup.every((step) => step.done);

  const resetComposer = () => {
    setPreview(null);
    setEditingPlan(false);
    setComposerError("");
  };

  const updatePlanStep = (index: number, patch: Partial<PlanSubTask>) => {
    setPreview((current) => {
      if (!current) return current;
      const tasks = current.plan.tasks.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step,
      );
      return { ...current, plan: { ...current.plan, tasks } };
    });
  };

  const previewPlan = async () => {
    const text = objective.trim();
    if (!workspaceId || !text || planning) return;
    setPlanning(true);
    setComposerError("");
    setApproved(null);
    try {
      const res = await api.createObjective(workspaceId, { objective: text, preview: true });
      const plan = res.plan as Plan | undefined;
      if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        throw new Error("The provider returned an empty plan.");
      }
      setPreview({ objective: text, plan });
    } catch (err) {
      const message = describeError(err);
      setComposerError(message);
      notifyError(err);
    } finally {
      setPlanning(false);
    }
  };

  const approvePlan = async () => {
    if (!preview || !workspaceId || approving) return;
    if (preview.plan.tasks.some((step) => !step.description.trim())) {
      setComposerError("Every step needs a description before the plan can be approved.");
      return;
    }
    setApproving(true);
    try {
      const result = await api.createObjective(workspaceId, {
        objective: preview.objective,
        plan: preview.plan,
        create_board: true,
      });
      const count = Array.isArray(result.tasks) ? result.tasks.length : preview.plan.tasks.length;
      setApproved({ count, workspace: selected?.name ?? "workspace" });
      toast.success(`Plan approved — ${count} task${count === 1 ? "" : "s"} queued.`);
      setPreview(null);
      setEditingPlan(false);
      setObjective("");
      overview.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setApproving(false);
    }
  };

  const orgProject = projects[0] ?? null;
  const governance = useAsync(async () => {
    if (!orgProject) return null;
    const [budgets, decisions, notifications] = await Promise.all([
      api.listBudgets(orgProject.id).catch(() => null),
      api
        .listDecisions(orgProject.id, 4)
        .catch(() => ({ decisions: [] as Array<Record<string, unknown>> })),
      api.listNotifications(orgProject.id).catch(() => ({ notifications: [] as Notification[] })),
    ]);
    return { budgets, decisions: decisions.decisions, notifications: notifications.notifications };
  }, [orgProject?.id]);

  if (overview.loading && !data) {
    return (
      <Page width="data">
        <PageHeader
          eyebrow="Home"
          title="Command center"
          description="Direct the workforce, review plans, and see what is running, blocked, or delivered."
        />
        <LoadingState lines={6} />
      </Page>
    );
  }

  if (!data) {
    return (
      <Page width="data">
        <PageHeader eyebrow="Home" title="Command center" />
        <EmptyState
          title="The organisation could not be loaded"
          hint={describeError(overview.error)}
          action={<Button onClick={overview.reload}>Retry</Button>}
        />
      </Page>
    );
  }

  return (
    <Page width="data">
      <div className="flex flex-col gap-6 pb-16 md:gap-8 md:pb-0">
        <PageHeader
          eyebrow="Home"
          title="Command center"
          description="Direct the workforce, review plans, and see what is running, blocked, or delivered."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate("/chat")}>Chat</Button>
              <Button
                variant="primary"
                onClick={() => {
                  composerRef.current?.focus();
                  composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                }}
              >
                New objective
              </Button>
            </div>
          }
        />

        {overview.error ? (
          <div className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]">
            Partial data. Some organisation details could not be loaded.{" "}
            <button className="underline underline-offset-4" onClick={overview.reload}>
              Retry
            </button>
          </div>
        ) : null}

        {!setupComplete ? (
          <div className="rounded-xl border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">
                Setup
              </div>
              <div className="text-step--2 text-[var(--muted)]">
                {setup.filter((step) => step.done).length}/{setup.length} complete
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {setup.map((step) => (
                <button
                  key={step.key}
                  onClick={() => navigate(step.href)}
                  className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-step--1 transition-colors ${
                    step.done
                      ? "border-[var(--border-dim)] text-[var(--muted)] hover:bg-[var(--surface-2)]"
                      : "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[var(--surface-2)]"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      step.done ? "bg-[var(--success)]" : "bg-[var(--accent)]"
                    }`}
                  />
                  {step.label}
                  <span className="text-[var(--faint)]">{step.done ? "done" : "next"}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* The composer is the one place a human gives the organisation a
         *  direction. It plans first and creates nothing until approved. */}
        {data.project_count === 0 ? (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h2 className="text-step-1 font-semibold tracking-tight text-[var(--text)]">
              Give the workforce a workspace
            </h2>
            <p className="mt-1 max-w-[62ch] text-step--1 text-[var(--muted)]">
              An objective becomes a reviewed plan, then tasks your agents execute. Create a
              workspace first so work, memory, and deliverables have a home.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => navigate("/projects")}>
                Create workspace
              </Button>
              <Button onClick={() => navigate("/settings")}>Connect a model</Button>
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-dim)] px-4 py-3.5 md:px-5">
              <div>
                <div className="text-step--2 font-medium uppercase tracking-[0.14em] text-[var(--faint)]">
                  Objective
                </div>
                <h2 className="mt-1 text-step-1 font-semibold tracking-tight text-[var(--text)]">
                  What should the workforce accomplish?
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={selected?.provider_ready ? "ok" : "warn"}>
                  {selected?.provider_ready
                    ? selected.provider_name || "Model ready"
                    : "No model provider"}
                </Badge>
                <Badge variant="neutral">{data.agents.total} agents</Badge>
              </div>
            </div>

            <div className="p-4 md:p-5">
              <textarea
                ref={composerRef}
                value={objective}
                onChange={(event) => {
                  setObjective(event.target.value);
                  if (preview) resetComposer();
                  if (approved) setApproved(null);
                }}
                rows={3}
                placeholder="Describe the outcome. The planner will turn it into ordered tasks you can review before anything runs."
                aria-label="Objective"
                className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3.5 py-3 text-step-0 leading-relaxed text-[var(--text)] outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <label className="flex min-w-0 items-center gap-2 text-step--1 text-[var(--muted)]">
                  <span className="shrink-0">Workspace</span>
                  <select
                    className={`${FORM_SELECT} max-w-[18rem]`}
                    value={workspaceId}
                    onChange={(event) => {
                      setWorkspaceId(event.target.value);
                      resetComposer();
                      setApproved(null);
                    }}
                    aria-label="Objective workspace"
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                        {project.provider_ready ? "" : " — no model"}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  {preview ? (
                    <Button onClick={resetComposer} disabled={approving}>
                      Discard
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    onClick={() => void previewPlan()}
                    disabled={
                      planning || !objective.trim() || !workspaceId || !selected?.provider_ready
                    }
                  >
                    {planning ? "Drafting plan…" : preview ? "Re-plan" : "Preview plan"}
                  </Button>
                </div>
              </div>

              {!selected?.provider_ready ? (
                <p className="mt-3 text-step--1 text-[var(--warn)]">
                  This workspace has no usable model.{" "}
                  <button
                    className="underline underline-offset-4"
                    onClick={() => navigate("/settings")}
                  >
                    Connect a provider
                  </button>{" "}
                  before planning or executing work.
                </p>
              ) : null}

              {composerError ? (
                <p className="mt-3 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-step--1 text-[var(--text)]">
                  {composerError}
                </p>
              ) : null}

              {planning ? (
                <p className="mt-3 text-step--1 text-[var(--muted)]">
                  The planner is reading workspace context and drafting ordered steps. This can take
                  a moment.
                </p>
              ) : null}

              {approved ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-2 text-step--1 text-[var(--text)]">
                  <span>
                    Plan approved — {approved.count} task{approved.count === 1 ? "" : "s"} queued in{" "}
                    {approved.workspace}.
                  </span>
                  <Button onClick={() => navigate("/work")}>Open work</Button>
                </div>
              ) : null}
            </div>

            {preview ? (
              <div className="border-t border-[var(--border-dim)] bg-[var(--bg)]/40">
                <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 md:px-5">
                  <div className="min-w-0">
                    <div className="text-step--1 font-semibold text-[var(--text)]">
                      Plan review
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-step--2 text-[var(--muted)]">
                      {preview.objective}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="info">
                      {preview.plan.tasks.length} step
                      {preview.plan.tasks.length === 1 ? "" : "s"}
                    </Badge>
                    <Button onClick={() => setEditingPlan((value) => !value)} disabled={approving}>
                      {editingPlan ? "Done editing" : "Edit plan"}
                    </Button>
                  </div>
                </div>
                <ol className="divide-y divide-[var(--border-dim)] border-t border-[var(--border-dim)]">
                  {preview.plan.tasks.map((step, index) => (
                    <PlanRow
                      key={index}
                      step={step}
                      index={index}
                      ownerName={
                        step.owner_teammate_id
                          ? agentNames.get(step.owner_teammate_id) || step.owner_teammate_id
                          : "Auto-assigned by the executor"
                      }
                      editing={editingPlan}
                      onChange={updatePlanStep}
                    />
                  ))}
                </ol>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-dim)] px-4 py-3 md:px-5">
                  <p className="text-step--2 text-[var(--muted)]">
                    Approving creates exactly these tasks. Nothing has run yet.
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={resetComposer} disabled={approving}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={() => void approvePlan()} disabled={approving}>
                      {approving ? "Approving…" : "Approve plan & queue work"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        )}

        <div className="grid grid-cols-2 divide-y divide-[var(--border-dim)] overflow-hidden rounded-xl border border-[var(--border-dim)] bg-[var(--surface)] sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5 lg:divide-x">
          <Kpi
            label="Workspaces"
            value={data.project_count}
            detail={`${data.active_projects} with open work`}
          />
          <Kpi
            label="Workforce"
            value={`${data.agents.working}/${data.agents.total}`}
            detail={`${data.agents.idle} idle · ${data.agents.inactive} inactive`}
            tone={data.agents.working > 0 ? "ok" : "neutral"}
          />
          <Kpi
            label="In flight"
            value={data.tasks.active}
            detail={`${data.tasks.running} running · ${data.tasks.queued} queued`}
            tone={data.tasks.running > 0 ? "ok" : "neutral"}
          />
          <Kpi
            label="Needs you"
            value={needsAttention}
            detail={`${data.approvals.pending} approvals · ${data.tasks.blocked} blocked · ${data.tasks.failed} failed`}
            tone={data.tasks.blocked + data.tasks.failed > 0 ? "bad" : needsAttention > 0 ? "warn" : "neutral"}
          />
          <Kpi
            label="Deliverables"
            value={data.deliverables.total}
            detail={`${data.tasks.completed} tasks completed`}
            tone={data.deliverables.total > 0 ? "ok" : "neutral"}
          />
        </div>

        <PageSection
          title="Needs attention"
          description="Blocked work, failed runs, missing models, and decisions waiting on you."
          actions={
            needsAttention > 0 ? (
              <Button
                onClick={() =>
                  navigate(data.approvals.pending > 0 ? "/approvals" : "/work")
                }
              >
                {data.approvals.pending > 0 ? "Open approvals" : "Open work"}
              </Button>
            ) : undefined
          }
        >
          {data.attention.length === 0 ? (
            <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">
              Nothing is blocked, failed, or waiting for a decision.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
              {data.attention.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-dim)] px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={attentionTone(item)}>
                        {item.kind === "approval"
                          ? "Decision"
                          : item.kind === "provider"
                            ? "Model"
                            : "Blocked"}
                      </Badge>
                      <span className="truncate text-step--1 font-medium text-[var(--text)]">
                        {item.title}
                      </span>
                    </div>
                    <div className="mt-1 text-step--2 text-[var(--muted)]">
                      {item.project_name} · {item.detail}
                    </div>
                  </div>
                  <Button onClick={() => navigate(item.href)}>
                    {item.kind === "approval" ? "Review" : item.kind === "provider" ? "Connect" : "Open"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </PageSection>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:gap-8">
          <PageSection
            title="Active work"
            description="Running, queued, blocked, and recently finished tasks."
            actions={<Button onClick={() => navigate("/work")}>All work</Button>}
            className="mb-0"
          >
            {data.recent_tasks.length === 0 ? (
              <EmptyState
                title="No work yet"
                hint="Approve an objective above and its tasks will appear here."
                action={<Button onClick={() => composerRef.current?.focus()}>Write an objective</Button>}
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                {data.recent_tasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => navigate(task.href)}
                    className="flex w-full items-start justify-between gap-3 border-b border-[var(--border-dim)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-2)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-step--1 font-medium text-[var(--text)]">
                        {task.title}
                      </div>
                      <div className="mt-0.5 truncate text-step--2 text-[var(--muted)]">
                        {taskMeta(task)}
                        {task.at ? ` · ${relativeTime(task.at)}` : ""}
                      </div>
                      {task.status === "blocked" && task.blocked_reason ? (
                        <div className="mt-1 truncate text-step--2 text-[var(--danger)]">
                          {task.blocked_reason}
                        </div>
                      ) : null}
                    </div>
                    <StatusBadge status={task.status} />
                  </button>
                ))}
              </div>
            )}
          </PageSection>

          <PageSection
            title="Workforce"
            description="Who is working, idle, or offline."
            actions={<Button onClick={() => navigate("/agents")}>Agents</Button>}
            className="mb-0"
          >
            {data.agents_list.length === 0 ? (
              <EmptyState
                title="No agents"
                hint="Create an agent to execute planned work."
                action={<Button onClick={() => navigate("/agents")}>Create agent</Button>}
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                {data.agents_list.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => navigate(agent.href)}
                    className="flex w-full items-center gap-3 border-b border-[var(--border-dim)] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-2)]"
                  >
                    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-3)] text-step--2 font-semibold text-[var(--text-soft)]">
                      {initials(agent.name)}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)] ${
                          agent.working
                            ? "bg-[var(--accent)]"
                            : agent.status === "active"
                              ? "bg-[var(--success)]"
                              : "bg-[var(--faint)]"
                        }`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-step--1 font-medium text-[var(--text)]">
                          {agent.name}
                        </span>
                        {agent.working ? <Badge variant="ok">working</Badge> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-step--2 text-[var(--muted)]">
                        {agent.current_task || agent.role || agent.project_name}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </PageSection>
        </div>

        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          <PageSection
            title="Deliverables"
            description="Documents and reports saved by the workforce."
            actions={<Button onClick={() => navigate("/library")}>Library</Button>}
            className="mb-0"
          >
            {data.deliverables.recent.length === 0 ? (
              <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-4">
                <div className="text-step--1 font-medium text-[var(--text)]">
                  No deliverables saved yet
                </div>
                <p className="mt-1 text-step--2 text-[var(--muted)]">
                  Completed tasks can save documents; research produces reports. Both appear here
                  and in the Library after they are persisted.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                {data.deliverables.recent.map((item) => (
                  <button
                    key={`${item.kind}-${item.id}`}
                    onClick={() => navigate(item.href)}
                    className="flex w-full items-start justify-between gap-3 border-b border-[var(--border-dim)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-2)]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-step--1 font-medium text-[var(--text)]">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block truncate text-step--2 text-[var(--muted)]">
                        {item.project_name} · {item.kind}
                        {item.at ? ` · ${relativeTime(item.at)}` : ""}
                      </span>
                    </span>
                    <Badge variant="neutral">{item.kind === "report" ? "Report" : "Document"}</Badge>
                  </button>
                ))}
              </div>
            )}
          </PageSection>

          <PageSection
            title="Activity"
            description="Recent executions and saved outputs."
            actions={<Button onClick={() => navigate("/work")}>Open work</Button>}
            className="mb-0"
          >
            {data.activity.length === 0 ? (
              <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-4 text-step--1 text-[var(--muted)]">
                No executions yet. Runs appear here as soon as an agent starts work.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                {data.activity.map((item) => (
                  <button
                    key={`${item.kind}-${item.id}`}
                    onClick={() => (item.href ? navigate(item.href) : undefined)}
                    className="flex w-full items-start justify-between gap-3 border-b border-[var(--border-dim)] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-2)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-step--1 text-[var(--text)]">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block truncate text-step--2 text-[var(--muted)]">
                        {item.project_name}
                        {item.at ? ` · ${relativeTime(item.at)}` : ""}
                      </span>
                    </span>
                    <StatusBadge status={item.status} label={runStatusLabel(item.status)} />
                  </button>
                ))}
              </div>
            )}
          </PageSection>
        </div>

        {orgProject ? (
          <PageSection
            title="Governance"
            description={`Budgets, decisions, and the outbox for ${orgProject.name}.`}
          >
            {governance.loading && !governance.data ? (
              <LoadingState lines={3} />
            ) : (
              <div className="grid gap-2 md:grid-cols-3">
                <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
                  <div className="text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">
                    Token budgets
                  </div>
                  {governance.data?.budgets ? (
                    <div className="mt-2 flex flex-col gap-1.5 text-step--1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[var(--muted)]">Org today</span>
                        <span className="font-medium tabular-nums text-[var(--text)]">
                          {(governance.data.budgets.usage?.org_today_used ?? 0).toLocaleString()} /{" "}
                          {(governance.data.budgets.caps?.org_daily_max_tokens ?? 0).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[var(--muted)]">Persona today</span>
                        <span className="font-medium tabular-nums text-[var(--text)]">
                          {(governance.data.budgets.usage?.persona_today_used ?? 0).toLocaleString()} /{" "}
                          {(governance.data.budgets.caps?.per_persona_daily_max_tokens ?? 0).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[var(--muted)]">Per task</span>
                        <span className="font-medium tabular-nums text-[var(--text)]">
                          {(governance.data.budgets.caps?.per_task_max_tokens ?? 0).toLocaleString()} cap
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-step--2 text-[var(--muted)]">
                      Budget report unavailable.
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">
                      Decision log
                    </div>
                    <button
                      onClick={() => navigate(`/p/${orgProject.id}`)}
                      className="text-step--2 text-[var(--faint)] hover:text-[var(--text)]"
                    >
                      Open
                    </button>
                  </div>
                  {(governance.data?.decisions ?? []).length === 0 ? (
                    <div className="mt-2 text-step--2 text-[var(--muted)]">
                      Agents record non-trivial decisions here, with reasons.
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {(governance.data?.decisions ?? []).slice(0, 3).map((decision) => (
                        <div key={String(decision.id)} className="text-step--1">
                          <div className="truncate font-medium text-[var(--text)]">
                            {String(decision.decision || "")}
                          </div>
                          <div className="text-step--2 text-[var(--muted)]">
                            {decision.created_at ? relativeTime(String(decision.created_at)) : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3">
                  <div className="text-step--2 font-medium uppercase tracking-[0.12em] text-[var(--faint)]">
                    Outbox
                  </div>
                  {(governance.data?.notifications ?? []).length === 0 ? (
                    <div className="mt-2 text-step--2 text-[var(--muted)]">
                      Approved external actions and owner notifications land here.
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {(governance.data?.notifications ?? []).slice(0, 3).map((notification) => (
                        <div key={notification.id} className="text-step--1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-[var(--text)]">
                              {String(notification.kind || "notification").replace(/_/g, " ")}
                            </span>
                            <Badge variant={notification.status === "stored" ? "neutral" : "info"}>
                              {notification.status}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </PageSection>
        ) : null}
      </div>
    </Page>
  );
}
