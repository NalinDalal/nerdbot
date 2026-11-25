import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, describeError } from "./api";
import { navigate, notifyError } from "./app";
import {
  AgentAvatar,
  Badge,
  Button,
  EmptyState,
  FORM_SELECT,
  Icon,
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

type AttentionGroup = {
  key: string;
  label: string;
  detail: string;
  tone: "bad" | "warn" | "info";
  items: OrgAttentionItem[];
};

/** Attention arrives as one row per task. Grouping by reason keeps ten
 *  failed runs from burying the one real decision underneath them. */
function groupAttention(items: OrgAttentionItem[]): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup>();
  for (const item of items) {
    const reason =
      item.kind === "approval"
        ? "approval"
        : item.kind === "provider"
          ? "provider"
          : item.detail || "blocked";
    const existing = groups.get(reason);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const label =
      item.kind === "approval"
        ? "Decisions waiting on you"
        : item.kind === "provider"
          ? "Projects without a model"
          : /failed and needs a retry/i.test(item.detail)
            ? "Failed runs to retry"
            : /no command and no model/i.test(item.detail)
              ? "No model or command configured"
              : /blocked/i.test(item.detail)
                ? "Blocked work"
                : "Work that needs a decision";
    groups.set(reason, {
      key: reason,
      label,
      detail: item.detail,
      tone:
        item.severity === "danger" ? "bad" : item.kind === "approval" ? "info" : "warn",
      items: [item],
    });
  }
  return [...groups.values()].sort((a, b) => {
    const weight = (group: AttentionGroup) =>
      group.tone === "bad" ? 0 : group.tone === "warn" ? 1 : 2;
    return weight(a) - weight(b) || b.items.length - a.items.length;
  });
}

function attentionTaskId(item: OrgAttentionItem): string | null {
  return item.id.startsWith("task:") ? item.id.slice(5) : null;
}

function taskMeta(task: OrgTaskRow): string {
  const bits = [task.project_name];
  if (task.owner_name) bits.push(task.owner_name);
  return bits.join(" · ");
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
              placeholder="No shell command. The agent decides how to do it."
              aria-label={`Step ${index + 1} command`}
              className="mono mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-step--2 text-[var(--text-soft)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
            />
          </>
        ) : (
          <>
            <div className="text-step--1 font-medium text-[var(--text)]">{step.description}</div>
            {step.command ? (
              <code
                className="mono mt-1 block truncate rounded bg-[var(--surface-2)] px-2 py-1 text-step--2 text-[var(--text-soft)]"
                title={step.command}
              >
                {step.command}
              </code>
            ) : (
              <div className="mt-1 text-step--2 text-[var(--faint)]">
                No shell command. The agent decides how to do it.
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

function AttentionGroupBlock({
  group,
  expanded,
  onToggle,
  onRetry,
  retryingId,
}: {
  group: AttentionGroup;
  expanded: boolean;
  onToggle: () => void;
  onRetry: (item: OrgAttentionItem) => void;
  retryingId: string | null;
}) {
  const projects = [...new Set(group.items.map((item) => item.project_name))];
  const latest = group.items[0];
  const retryable = group.label === "Failed runs to retry";
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? group.items : group.items.slice(0, 3);
  return (
    <div className="border-b border-[var(--border-dim)] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]"
      >
        <Icon
          name="chevron-right"
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--faint)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-step--1 font-medium text-[var(--text)]">{group.label}</span>
            <Badge variant={group.tone}>{group.items.length}</Badge>
          </span>
          <span className="mt-0.5 block truncate text-step--2 text-[var(--muted)]">
            {projects.join(", ")}
            {latest.at ? ` · latest ${relativeTime(latest.at)}` : ""}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-step--2 text-[var(--faint)]">
          {expanded ? "Hide" : "Show"}
        </span>
      </button>

      {expanded ? (
        <ul className="border-t border-[var(--border-dim)] bg-[var(--surface-2)]">
          {visible.map((item) => {
            const taskId = attentionTaskId(item);
            const retrying = retryingId === item.id;
            return (
              <li
                key={item.id}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-[var(--border-dim)] px-4 py-2.5 pl-10 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => navigate(item.href)}
                    className="line-clamp-2 text-left text-step--1 text-[var(--text)] underline-offset-2 hover:underline"
                  >
                    {item.title}
                  </button>
                  <div className="mt-0.5 text-step--2 text-[var(--muted)]">
                    {item.detail}
                    {item.at ? ` · ${relativeTime(item.at)}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {retryable && taskId ? (
                    <Button
                      size="sm"
                      onClick={() => onRetry(item)}
                      disabled={retrying}
                      ariaBusy={retrying}
                    >
                      {retrying ? "Retrying" : "Retry"}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => navigate(item.href)}>
                    Open
                  </Button>
                </div>
              </li>
            );
          })}
          {group.items.length > 3 ? (
            <li className="border-b border-[var(--border-dim)] px-4 py-2 pl-10 last:border-b-0">
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="text-step--2 font-medium text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {showAll
                  ? "Show fewer"
                  : `Show all ${group.items.length} in this group`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
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
  const [expandedGroups, setExpandedGroups] = useState<string[] | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const projects = useMemo(() => data?.projects ?? [], [data?.projects]);
  const selected = useMemo(
    () => projects.find((project) => project.id === workspaceId) ?? null,
    [projects, workspaceId],
  );

  useEffect(() => {
    if (projects.length === 0) {
      // Derived state: workspace selection managed elsewhere
      return;
    }
    if (projects.some((project) => project.id === workspaceId)) return;
    // Derived state: preferred project selected via other mechanisms
  }, [projects, workspaceId]);

  useEffect(() => {
    const focusComposer = () => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    window.addEventListener("nerdbot:compose", focusComposer);
    return () => window.removeEventListener("nerdbot:compose", focusComposer);
  }, []);

  const agentNames = useMemo(() => {
    const out = new Map<string, string>();
    for (const agent of data?.agents_list ?? []) out.set(agent.id, agent.name);
    return out;
  }, [data?.agents_list]);

  const groups = useMemo(() => groupAttention(data?.attention ?? []), [data?.attention]);
  const needsAttention =
    (data?.tasks.blocked ?? 0) +
    (data?.tasks.failed ?? 0) +
    (data?.approvals.pending ?? 0) +
    projects.filter((project) => !project.provider_ready).length;

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
      setApproved({ count, workspace: selected?.name ?? "project" });
      toast.success(`Plan approved. ${count} task${count === 1 ? "" : "s"} queued.`);
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

  const retryAttention = async (item: OrgAttentionItem) => {
    const taskId = attentionTaskId(item);
    if (!taskId || retryingId) return;
    setRetryingId(item.id);
    try {
      await api.retryTask(taskId);
      toast.success("Retry queued.");
      overview.reload();
    } catch (err) {
      notifyError(err);
    } finally {
      setRetryingId(null);
    }
  };

  if (overview.loading && !data) {
    return (
      <Page width="data">
        <PageHeader
          eyebrow="Home"
          title="Command center"
          description="Direct the workforce, review plans, and see what is running, stuck, or delivered."
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

  const inFlight = data.tasks.running + data.tasks.queued;

  return (
    <Page width="data">
      <div className="flex flex-col gap-8 pb-16 md:pb-0">
        <div>
          <PageHeader
            eyebrow="Home"
            title="Command center"
            description="Give the workforce its next outcome. Plans are reviewed before anything runs."
            actions={
              <Button onClick={() => navigate("/chat")} className="hidden sm:inline-flex">
                <Icon name="chat" className="h-3.5 w-3.5" />
                Open chat
              </Button>
            }
          />

          <div className="-mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-step--1 md:-mt-4">
            <button
              type="button"
              onClick={() => navigate("/agents")}
              className="inline-flex items-baseline gap-1.5 rounded-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              <span className="text-step-0 font-semibold tabular-nums text-[var(--text)]">
                {data.agents.total}
              </span>
              agents
              {data.agents.working > 0 ? (
                <span className="text-[var(--accent)]">· {data.agents.working} working</span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => navigate("/work")}
              className="inline-flex items-baseline gap-1.5 rounded-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              <span className="text-step-0 font-semibold tabular-nums text-[var(--text)]">
                {inFlight}
              </span>
              in flight
            </button>
            <button
              type="button"
              onClick={() => navigate("/work")}
              className="inline-flex items-baseline gap-1.5 rounded-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              <span
                className={`text-step-0 font-semibold tabular-nums ${
                  needsAttention > 0 ? "text-[var(--danger)]" : "text-[var(--text)]"
                }`}
              >
                {needsAttention}
              </span>
              need you
            </button>
            <button
              type="button"
              onClick={() => navigate("/library")}
              className="inline-flex items-baseline gap-1.5 rounded-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              <span className="text-step-0 font-semibold tabular-nums text-[var(--text)]">
                {data.deliverables.total}
              </span>
              delivered
            </button>
            <span className="ml-auto hidden text-step--2 text-[var(--faint)] md:inline">
              Updated {relativeTime(data.generated_at)}
            </span>
          </div>
        </div>

        {overview.error ? (
          <div className="rounded-lg border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3 text-step--1 text-[var(--text)]">
            Partial data. Some organisation details could not be loaded.{" "}
            <button className="underline underline-offset-4" onClick={overview.reload}>
              Retry
            </button>
          </div>
        ) : null}

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-10">
          <div className="flex min-w-0 flex-col gap-8">
            {data.project_count === 0 ? (
              <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
                <h2 className="text-step-1 font-semibold tracking-[-0.02em] text-[var(--text)]">
                  Give the workforce a project
                </h2>
                <p className="mt-1 max-w-[62ch] text-step--1 text-[var(--muted)]">
                  An objective becomes a reviewed plan, then tasks your agents execute. Create a
                  project first so work, memory, and deliverables have a home.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => navigate("/projects")}>
                    Create project
                  </Button>
                  <Button onClick={() => navigate("/settings")}>Connect a model</Button>
                </div>
              </section>
            ) : (
              <section
                aria-labelledby="composer-title"
                className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-dim)] px-4 py-3 md:px-5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-[var(--accent-dim)] text-[var(--accent)]">
                      <Icon name="spark" className="h-3.5 w-3.5" />
                    </span>
                    <h2
                      id="composer-title"
                      className="text-step--1 font-semibold tracking-[-0.01em] text-[var(--text)]"
                    >
                      New objective
                    </h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={selected?.provider_ready ? "ok" : "warn"}>
                      {selected?.provider_ready
                        ? selected.provider_name || "Model ready"
                        : "No model"}
                    </Badge>
                    <Badge variant="neutral">
                      {selected?.counts.bots ?? 0} agents in {selected?.name ?? "project"}
                    </Badge>
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
                    rows={4}
                    placeholder="Describe the outcome. The planner turns it into ordered tasks."
                    aria-label="Objective"
                    className="w-full resize-y border border-[var(--border-dim)] bg-[var(--surface)] py-2 px-3 text-step-1 leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--faint)] focus:ring-2 focus:ring-[var(--ring)]"
                  />

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-dim)] pt-3">
                    <label className="flex min-w-0 items-center gap-2 text-step--1 text-[var(--muted)]">
                      <span className="shrink-0">Project</span>
                      <select
                        className={`${FORM_SELECT} max-w-[16rem]`}
                        value={workspaceId}
                        onChange={(event) => {
                          setWorkspaceId(event.target.value);
                          resetComposer();
                          setApproved(null);
                        }}
                        aria-label="Objective project"
                      >
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                            {project.provider_ready ? "" : " (no model)"}
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
                      This project has no usable model.{" "}
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
                      The planner is reading project context and drafting ordered steps. This can
                      take a moment.
                    </p>
                  ) : null}

                  {approved ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-2 text-step--1 text-[var(--text)]">
                      <span>
                        Plan approved. {approved.count} task{approved.count === 1 ? "" : "s"} queued
                        in {approved.workspace}.
                      </span>
                      <Button onClick={() => navigate("/work")}>Open work</Button>
                    </div>
                  ) : null}
                </div>

                {preview ? (
                  <div className="border-t border-[var(--border-dim)] bg-[var(--surface-2)]">
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
                        <Button
                          onClick={() => setEditingPlan((value) => !value)}
                          disabled={approving}
                          className="rounded-md border border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[var(--accent-hover)]"
                        >
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
                        <Button
                          variant="primary"
                          onClick={() => void approvePlan()}
                          disabled={approving}
                        >
                          {approving ? "Approving…" : "Approve plan and queue work"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            )}

            <PageSection
              title="Needs attention"
              description="Grouped by reason. Failed runs can be retried here."
              actions={needsAttention > 0 ? (
                <Button
                  onClick={() => navigate(data.approvals.pending > 0 ? "/approvals" : "/work")}
                >
                  {data.approvals.pending > 0 ? "Open approvals" : "Open work"}
                </Button>
              ) : undefined}
            >
              {groups.length === 0 ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-4 py-3 text-step--1 text-[var(--muted)]">
                  <Icon name="check" className="h-4 w-4 text-[var(--success)]" />
                  Nothing is blocked, failed, or waiting on a decision.
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                  {groups.map((group) => (
                    <AttentionGroupBlock
                      key={group.key}
                      group={group}
                      expanded={
                        expandedGroups === null
                          ? group === groups[0]
                          : expandedGroups.includes(group.key)
                      }
                      onToggle={() =>
                        setExpandedGroups((current) => {
                          const base =
                            current ?? (groups[0] ? [groups[0].key] : []);
                          return base.includes(group.key)
                            ? base.filter((key) => key !== group.key)
                            : [...base, group.key];
                        })
                      }
                      onRetry={(item) => void retryAttention(item)}
                      retryingId={retryingId}
                    />
                  ))}
                </div>
              )}
            </PageSection>

            <PageSection
              title="Recent work"
              description="The state of the work that changed most recently."
              actions={<Button onClick={() => navigate("/work")}>All work</Button>}
            >
              {data.recent_tasks.length === 0 ? (
                <EmptyState
                  title="No work yet"
                  hint="Approve an objective above and its tasks will appear here."
                  action={
                    <Button onClick={() => composerRef.current?.focus()}>Write an objective</Button>
                  }
                />
              ) : (
                <div className="overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface)]">
                  {data.recent_tasks.map((task) => (
                    <button
                      key={task.id}
                      onClick={() => navigate(task.href)}
                      className="flex w-full items-start justify-between gap-4 border-b border-[var(--border-dim)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-2)]"
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
          </div>

          <aside className="flex min-w-0 flex-col gap-8" aria-label="Workforce and output">
            <section aria-labelledby="workforce-title">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h2
                  id="workforce-title"
                  className="text-step--1 font-semibold tracking-[-0.01em] text-[var(--text)]"
                >
                  Workforce
                </h2>
                <button
                  type="button"
                  onClick={() => navigate("/agents")}
                  className="text-step--2 text-[var(--faint)] transition-colors hover:text-[var(--text)]"
                >
                  All agents
                </button>
              </div>
              <p className="mb-3 text-step--2 text-[var(--muted)]">
                {data.agents.total} agents, {data.agents.working} working, {data.agents.idle} idle.
              </p>
              {data.agents_list.length === 0 ? (
                <div className="rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] px-3 py-3">
                  <p className="text-step--2 text-[var(--muted)]">
                    No agents yet. Create one to execute planned work.
                  </p>
                  <Button
                    size="sm"
                    className="mt-2"
                    onClick={() => navigate("/agents")}
                  >
                    Create agent
                  </Button>
                </div>
              ) : (
                <ul className="flex flex-col">
                  {data.agents_list.slice(0, 6).map((agent) => (
                    <li key={agent.id}>
                      <button
                        type="button"
                        onClick={() => navigate(agent.href)}
                        className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-1 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]"
                      >
                        <span className="relative">
                          <AgentAvatar name={agent.name} size={26} />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[var(--bg)] ${
                              agent.working
                                ? "bg-[var(--accent)]"
                                : agent.status === "active"
                                  ? "bg-[var(--success)]"
                                  : "bg-[var(--faint)]"
                            }`}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-step--1 text-[var(--text)]">
                            {agent.name}
                          </span>
                          <span className="mt-0.5 block truncate text-step--2 text-[var(--faint)]">
                            {agent.working
                              ? agent.current_task || "Working"
                              : agent.role || agent.project_name}
                          </span>
                        </span>
                        {agent.working ? <Badge variant="ok">working</Badge> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="deliverables-title" className="border-t border-[var(--border-dim)] pt-5">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h2
                  id="deliverables-title"
                  className="text-step--1 font-semibold tracking-[-0.01em] text-[var(--text)]"
                >
                  Recent deliverables
                </h2>
                <button
                  type="button"
                  onClick={() => navigate("/library")}
                  className="text-step--2 text-[var(--faint)] transition-colors hover:text-[var(--text)]"
                >
                  Library
                </button>
              </div>
              {data.deliverables.recent.length === 0 ? (
                <p className="text-step--2 text-[var(--muted)]">
                  Completed tasks and reports are saved here and in the Library.
                </p>
              ) : (
                <ul className="flex flex-col">
                  {data.deliverables.recent.slice(0, 4).map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      <button
                        type="button"
                        onClick={() => navigate(item.href)}
                        className="flex w-full items-start justify-between gap-3 rounded-[var(--radius-sm)] px-1 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-step--1 text-[var(--text)]">
                            {item.title}
                          </span>
                          <span className="mt-0.5 block truncate text-step--2 text-[var(--faint)]">
                            {item.kind === "report" ? "Report" : "Document"} ·{" "}
                            {item.project_name}
                            {item.at ? ` · ${relativeTime(item.at)}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="activity-title" className="border-t border-[var(--border-dim)] pt-5">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h2
                  id="activity-title"
                  className="text-step--1 font-semibold tracking-[-0.01em] text-[var(--text)]"
                >
                  Recent runs
                </h2>
                <button
                  type="button"
                  onClick={() => navigate("/work")}
                  className="text-step--2 text-[var(--faint)] transition-colors hover:text-[var(--text)]"
                >
                  Work
                </button>
              </div>
              {data.activity.length === 0 ? (
                <p className="text-step--2 text-[var(--muted)]">
                  Runs appear here as soon as an agent starts work.
                </p>
              ) : (
                <ul className="flex flex-col">
                  {data.activity.slice(0, 4).map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      <button
                        type="button"
                        onClick={() => (item.href ? navigate(item.href) : undefined)}
                        className="flex w-full items-start justify-between gap-3 rounded-[var(--radius-sm)] px-1 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-step--1 text-[var(--text)]">
                            {item.title}
                          </span>
                          <span className="mt-0.5 block truncate text-step--2 text-[var(--faint)]">
                            {item.at ? relativeTime(item.at) : item.project_name}
                          </span>
                        </span>
                        <StatusBadge status={item.status} label={runStatusLabel(item.status)} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </Page>
  );
}
