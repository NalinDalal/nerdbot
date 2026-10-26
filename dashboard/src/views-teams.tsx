import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import type { BotFace, Task } from "./types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Button,
  SectionLabel,
  BotChip,
  StatusBadge,
  Page,
  PageHeader,
  useAsync,
  taskStatusLabel,
  taskTally,
  TABLE_SHELL,
  TABLE_TD,
  TABLE_TH,
} from "./components";
import { EntityForm } from "./forms";

function openBot(id: string): void {
  window.location.hash = `#/bot/${id}`;
}

export function TeamsView() {
  const list = useAsync(() => api.listTeams(), []);
  const [showCreate, setShowCreate] = useState(false);

  const createTeam = async (values: Record<string, string>) => {
    try {
      await api.createTeam(values);
      setShowCreate(false);
      list.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Advanced"
        title="Teams"
        description="Group workspaces for a shared roll-up. Membership grants no permissions."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              New team
            </Button>
            <Button onClick={list.reload}>Refresh</Button>
          </>
        }
      />

      {showCreate ? (
        <Modal title="New team" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Create team"
            fields={[
              { name: "name", label: "Name", required: true, placeholder: "platform" },
              { name: "description", label: "Description", placeholder: "What this team owns" },
            ]}
            onSubmit={createTeam}
          />
        </Modal>
      ) : null}

      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.teams.length > 0 ? (
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[560px] table-fixed">
            <thead>
              <tr>
                <th className={`${TABLE_TH} w-[46%]`}>Team</th>
                <th className={`${TABLE_TH} w-[8rem]`}>Bots</th>
                <th className={`${TABLE_TH} w-[10rem]`}>Workspaces</th>
                <th className={`${TABLE_TH} w-[6rem]`}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.teams.map((team) => {
                const count = (list.data?.counts ?? {})[team.id];
                return (
                  <tr
                    key={team.id}
                    className="transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <td className={TABLE_TD}>
                      <button
                        onClick={() => {
                          window.location.hash = `#/team/${team.id}`;
                        }}
                        className="text-left font-medium text-[var(--text)] hover:underline"
                      >
                        {team.name || "Unnamed team"}
                      </button>
                      {team.description ? (
                        <div className="text-step--1 text-[var(--muted)]">
                          {team.description}
                        </div>
                      ) : null}
                    </td>
                    <td className={TABLE_TD}>{count?.bots ?? 0}</td>
                    <td className={TABLE_TD}>{count?.workspaces ?? 0}</td>
                    <td className={TABLE_TD}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          window.location.hash = `#/team/${team.id}`;
                        }}
                      >
                        Open →
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No teams yet"
          hint="Create a team to group bots and workspaces around a purpose, then assign bots to tasks and hand work off between them."
          action={
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              Create your first team
            </Button>
          }
        />
      )}
    </Page>
  );
}

/* --- Delegation rollup for one team --- */

interface RollupEntry {
  running: number;
  queued: number;
  blocked: number;
  done: number;
  failed: number;
  /** Waiting on a human decision. */
  awaiting: number;
  handoffs: Array<{
    fromId: string;
    fromPersona: string;
    fromFace: BotFace | null;
    toId: string;
    toPersona: string;
    toFace: BotFace | null;
    child: Task;
  }>;
}

/** Aggregate the tasks owned by the team's bots. Handoffs (agent-to-agent
 *  delegation) are visible as child tasks: a child's parent owner is "from",
 *  the child's owner is "to". */
function teamRollup(
  members: Array<{ id: string; persona: string; face: BotFace | null; tasks: Task[] }>,
): RollupEntry {
  const entry: RollupEntry = {
    running: 0,
    queued: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    awaiting: 0,
    handoffs: [],
  };
  const ownerByTaskId = new Map<string, { id: string; persona: string; face: BotFace | null }>();
  for (const member of members) {
    for (const task of member.tasks) {
      ownerByTaskId.set(task.id, { id: member.id, persona: member.persona, face: member.face });
    }
  }
  const tally = taskTally(members.flatMap((member) => member.tasks));
  entry.running = tally.running;
  entry.queued = tally.queued;
  entry.blocked = tally.blocked;
  entry.awaiting = tally.awaiting;
  entry.done = tally.done;
  entry.failed = tally.failed;
  for (const member of members) {
    for (const task of member.tasks) {
      if (task.parent_task_id) {
        const parent = ownerByTaskId.get(task.parent_task_id);
        if (parent && parent.id !== member.id) {
          entry.handoffs.push({
            fromId: parent.id,
            fromPersona: parent.persona,
            fromFace: parent.face,
            toId: member.id,
            toPersona: member.persona,
            toFace: member.face,
            child: task,
          });
        }
      }
    }
  }
  return entry;
}

function OpenTaskLink({ projectId, taskId, children }: { projectId: string; taskId: string; children: string }) {
  return (
    <button
      className="text-[var(--accent)] hover:underline"
      onClick={() => {
        window.location.hash = `#/p/${projectId}/t/${taskId}`;
      }}
    >
      {children}
    </button>
  );
}

export function TeamDetailView({
  teamId,
}: {
  teamId: string;
  onOpenProject?: (projectId: string) => void;
}) {
  const detail = useAsync(() => api.getTeam(teamId), [teamId]);
  const allBots = useAsync(() => api.listAllTeammates(), []);
  const [attachProjectId, setAttachProjectId] = useState("");

  const memberTasks = useAsync(async () => {
    if (!detail.data) return [];
    const mats = detail.data.teammates ?? [];
    const pairs = await Promise.all(
      mats.map(async (bot) => ({
        id: bot.id,
        persona: bot.persona || "Unnamed bot",
        face: bot.face ?? null,
        tasks: (await api.teammateTasks(bot.id).then((r) => r.tasks).catch(() => [])) as Task[],
      })),
    );
    return pairs;
  }, [detail.data]);

  const attachProject = async () => {
    const id = attachProjectId.trim();
    if (!id) return;
    try {
      await api.addTeamProject(teamId, id);
      setAttachProjectId("");
      detail.reload();
    } catch (err) {
      notifyError(err);
    }
  };

  if (detail.loading) return <LoadingState lines={3} />;
  if (detail.error || !detail.data) {
    return (
      <Page>
        <ErrorState error={detail.error ?? "Team not found"} onRetry={detail.reload} />
      </Page>
    );
  }

  const { team, projects, teammates = [], members } = detail.data;
  const memberBotIds = new Set(teammates.map((t) => t.id));
  const addable = (allBots.data?.teammates ?? []).filter((b) => !memberBotIds.has(b.id));
  const rollup = memberTasks.data ? teamRollup(memberTasks.data) : null;

  return (
    <Page>
      <PageHeader
        eyebrow="Team"
        title={team.name || "Unnamed team"}
        description={team.description}
        back={{ label: "Teams", onClick: () => { window.location.hash = "#/teams"; } }}
        actions={<Button onClick={detail.reload}>Refresh</Button>}
      />

      {/* Rollup */}
      <section className="mb-8">
        <SectionLabel className="mb-2">Execution rollup</SectionLabel>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          {rollup ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-step--1">
                <StatusBadge status="running" label={`${rollup.running} running`} />
                <StatusBadge status="pending" label={`${rollup.queued} queued`} />
                {rollup.awaiting > 0 && (
                  <StatusBadge
                    status="awaiting_approval"
                    label={`${rollup.awaiting} awaiting approval`}
                  />
                )}
                {rollup.blocked > 0 && (
                  <StatusBadge status="blocked" label={`${rollup.blocked} blocked`} />
                )}
                <StatusBadge status="done" label={`${rollup.done} completed`} />
                {rollup.failed > 0 && (
                  <StatusBadge status="failed" label={`${rollup.failed} failed`} />
                )}
              </div>
              {rollup.handoffs.length > 0 && (
                <div>
                  <div className="text-step--2 uppercase tracking-[0.14em] text-[var(--faint)]">
                    Agent-to-agent handoffs
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {rollup.handoffs.map(({ fromPersona, fromFace, toPersona, toFace, child }) => (
                      <div
                        key={`${child.id}`}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-step--1"
                      >
                        <BotChip persona={fromPersona} id={fromPersona} status="done" face={fromFace} />
                        <span className="text-[var(--faint)]" aria-hidden>→</span>
                        <BotChip persona={toPersona} id={toPersona} status={child.status} face={toFace} />
                        <span className="text-[var(--muted)]">delegated:</span>
                        <span className="truncate text-[var(--text-soft)]">{child.description}</span>
                        <span className="ml-auto flex items-center gap-2">
                          <StatusBadge status={child.status} label={taskStatusLabel(child.status)} />
                          <OpenTaskLink projectId={child.project_id} taskId={child.id}>
                            open →
                          </OpenTaskLink>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {rollup.running === 0 && rollup.queued === 0 && rollup.blocked === 0 && rollup.handoffs.length === 0 && (
                <p className="text-step--1 text-[var(--muted)]">
                  Nothing in flight for this team right now.
                </p>
              )}
            </div>
          ) : (
            <LoadingState lines={2} />
          )}
        </div>
      </section>

      {/* Bots */}
      <section className="mb-8">
        <SectionLabel className="mb-2">Bots in this team</SectionLabel>
        <p className="mb-3 max-w-[72ch] text-step--1 text-[var(--muted)]">
          These bots share the team&rsquo;s workspaces and hand tasks off to one another.
          Membership grants no permissions. Each bot acts within its own configured tool permissions.
        </p>
        {teammates.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {teammates.map((bot, index) => (
              <div
                key={bot.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${
                  index > 0 ? "border-t border-[var(--border-dim)]" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <BotChip persona={bot.persona || "Unnamed bot"} id={bot.id} status={bot.status} face={bot.face} />
                  <div className="mt-1 truncate text-step--2 text-[var(--faint)]" title={bot.instructions || ""}>
                    {bot.instructions?.slice(0, 110) || "No instructions"}
                  </div>
                </div>
                <div className="mono max-w-[220px] truncate text-step--2 text-[var(--faint)]" title={bot.permissions.join(", ")}>
                  {bot.permissions.length > 0 ? `${bot.permissions.length} perms` : "no perms"}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => openBot(bot.id)}>
                    Open
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (window.confirm(`Remove bot ${bot.persona || bot.id} from this team?`)) {
                        void api
                          .removeTeamTeammate(teamId, bot.id)
                          .then(() => detail.reload())
                          .catch(notifyError);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No bots in this team"
            hint="Add bots to group them into a fleet around a purpose or workflow."
          />
        )}
        <div className="mt-3 flex items-center gap-3">
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              void api
                .addTeamTeammate(teamId, id)
                .then(() => {
                  detail.reload();
                  allBots.reload();
                })
                .catch(notifyError);
            }}
            aria-label="Bot to add"
            className="max-w-xs rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)]"
          >
            <option value="">Add a bot…</option>
            {addable.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.persona || bot.id} ({bot.id.slice(0, 8)})
              </option>
            ))}
          </select>
          {addable.length === 0 && teammates.length === 0 && (
            <span className="text-step--1 text-[var(--faint)]">
              No bots available to add.
            </span>
          )}
        </div>
      </section>

      {/* Workspaces */}
      <section className="mb-8">
        <SectionLabel className="mb-2">Workspaces in this team</SectionLabel>
        {projects.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {projects.map((project, index) => (
              <div
                key={project.id}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${
                  index > 0 ? "border-t border-[var(--border-dim)]" : ""
                }`}
              >
                <div className="min-w-0">
                  <button
                    className="mono truncate font-medium text-[var(--text)] hover:underline"
                    onClick={() => {
                      window.location.hash = `#/p/${project.id}`;
                    }}
                  >
                    {project.repository || "workspace"}
                  </button>
                  <div className="mono text-step--2 text-[var(--faint)]">{project.id}</div>
                </div>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Detach workspace ${project.repository || project.id} from this team?`,
                      )
                    ) {
                      void api
                        .removeTeamProject(teamId, project.id)
                        .then(() => detail.reload())
                        .catch(notifyError);
                    }
                  }}
                >
                  Detach
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No workspaces"
            hint="Attach a workspace to this team so its bots and tasks belong to the team."
          />
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            attachProject();
          }}
          className="mt-3 flex items-center gap-2"
        >
          <input
            value={attachProjectId}
            onChange={(e) => setAttachProjectId(e.target.value)}
            placeholder="prj_…"
            aria-label="Project ID to attach"
            className="w-64 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-step--1 outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
          />
          <Button type="submit" variant="default">
            Attach workspace
          </Button>
        </form>
      </section>

      {members.length > 0 ? (
        <section>
          <SectionLabel className="mb-2">Membership rows</SectionLabel>
          <div className="mono rounded-xl border border-dashed border-[var(--border-dim)] px-4 py-3 text-step--2 text-[var(--faint)]">
            {members.map((m) => (
              <div key={m.id} className="py-0.5">
                {m.teammate_id ? `bot ${m.teammate_id}` : `workspace ${m.project_id}`}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </Page>
  );
}
