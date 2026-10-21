import { useState } from "react";
import { api } from "./api";
import { notifyError } from "./app";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  ShortId,
  StatusBadge,
  useAsync,
  taskStatusLabel,
} from "./components";
import { EntityForm } from "./forms";

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
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1>Teams</h1>
          <p className="subtitle">
            A team coordinates bots and workspaces around one purpose. Membership is a grouping
            only — it grants no permissions; bots act within the tool permissions configured on
            each bot.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowCreate(true)}>
            New team
          </button>
          <button onClick={list.reload}>Refresh</button>
        </div>
      </div>

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
        <div>
          {list.data.teams.map((team) => (
            <div className="card" key={team.id} style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
                <div>
                  <a href={`#/team/${team.id}`}>
                    <strong>{team.name || "Unnamed team"}</strong>
                  </a>
                  <div className="muted mono" style={{ marginTop: 4 }}>{team.id}</div>
                  {team.description ? (
                    <div className="muted" style={{ marginTop: 4 }}>{team.description}</div>
                  ) : null}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="primary" onClick={list.reload} style={{ padding: "4px 10px", fontSize: 12 }}>
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No teams yet"
          action={
            <button className="button primary" onClick={() => setShowCreate(true)}>
              Create your first team
            </button>
          }
          hint="Create a team to group bots and workspaces around a purpose, then assign bots to tasks and hand work off between them."
        />
      )}
    </div>
  );
}

export function TeamDetailView({
  teamId,
  onOpenProject,
}: {
  teamId: string;
  onOpenProject: (projectId: string) => void;
}) {
  const detail = useAsync(() => api.getTeam(teamId), [teamId]);
  const allBots = useAsync(() => api.listAllTeammates(), []);
  const [attachProjectId, setAttachProjectId] = useState("");

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
      <div>
        <button onClick={() => (window.location.hash = "#/teams")}>← Back to teams</button>
        <ErrorState error={detail.error ?? "Team not found"} onRetry={detail.reload} />
      </div>
    );
  }

  const { team, projects, teammates = [], members } = detail.data;
  const memberBotIds = new Set(teammates.map((t) => t.id));
  const addable =
    (allBots.data?.teammates ?? []).filter((b) => !memberBotIds.has(b.id));

  return (
    <div>
      <button onClick={() => (window.location.hash = "#/teams")}>← Back to teams</button>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 12 }}>
        <div>
          <h1>{team.name || "Unnamed team"}</h1>
          <p className="subtitle mono">{team.id}</p>
          {team.description ? <p className="subtitle">{team.description}</p> : null}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button onClick={detail.reload} style={{ padding: "4px 10px", fontSize: 12 }}>
            Refresh
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 12, marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-value">{teammates.length}</div>
          <div className="stat-label">bots</div>
        </div>
        <div className="stat">
          <div className="stat-value">{projects.length}</div>
          <div className="stat-label">workspaces</div>
        </div>
      </div>

      <h2 style={{ marginBottom: 8 }}>Bots in this team</h2>
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        These bots share the team&rsquo;s workspaces and hand tasks off to one another. Membership
        grants no permissions — each bot acts within its own configured tool permissions.
      </p>
      {teammates.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Role / instructions</th>
              <th>Status</th>
              <th>Model</th>
              <th>Permissions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {teammates.map((bot) => {
              const statusLabel = taskStatusLabel(bot.status);
              return (
                <tr key={bot.id}>
                  <td>
                    <div>
                      <a href={`#/bot/${bot.id}`}>
                        <strong>{bot.persona || "Unnamed bot"}</strong>
                      </a>
                      <div className="muted mono">{bot.id.slice(0, 12)}…</div>
                    </div>
                  </td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>
                    {bot.instructions?.slice(0, 90) || "—"}
                    {bot.instructions && bot.instructions.length > 90 ? "…" : ""}
                  </td>
                  <td>
                    <StatusBadge status={bot.status} label={statusLabel} />
                  </td>
                  <td className="muted mono">
                    {bot.provider_id ? bot.provider_id.slice(0, 10) + "…" : "—"}
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {bot.permissions.length > 0 ? bot.permissions.join(", ") : "—"}
                  </td>
                  <td>
                    <button
                      className="primary"
                      onClick={() => {
                        window.location.hash = `#/bot/${bot.id}`;
                      }}
                      style={{ padding: "4px 10px", fontSize: 12 }}
                    >
                      Open
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (
                          window.confirm(`Remove bot ${bot.persona || bot.id} from this team?`)
                        ) {
                          void api.removeTeamTeammate(teamId, bot.id).then(() => detail.reload()).catch(notifyError);
                        }
                      }}
                      style={{ padding: "4px 8px", fontSize: 12, marginLeft: 4 }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No bots in this team"
          hint="Add bots to group them into a fleet around a purpose or workflow."
        />
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <select
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            void api.addTeamTeammate(teamId, id).then(() => {
              detail.reload();
              allBots.reload();
            }).catch(notifyError);
          }}
          aria-label="Bot to add"
          style={{ maxWidth: 320 }}
        >
          <option value="">Add a bot…</option>
          {addable.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.persona || bot.id} ({bot.id.slice(0, 8)})
            </option>
          ))}
        </select>
        {addable.length === 0 && (
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            No bots available to add.
          </span>
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>Workspaces in this team</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <form onSubmit={(e) => { e.preventDefault(); attachProject(); }} className="row">
          <input
            value={attachProjectId}
            onChange={(e) => setAttachProjectId(e.target.value)}
            placeholder="prj_…"
            aria-label="Project ID to attach"
            style={{ maxWidth: 260 }}
          />
          <button className="primary" type="submit">Attach workspace</button>
        </form>
      </div>
      {projects.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th>Project</th>
              <th>Repository</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>
                  <a href={`#/p/${project.id}`} onClick={() => onOpenProject(project.id)}>
                    <ShortId id={project.id} />
                  </a>
                </td>
                <td className="muted mono">{project.repository}</td>
                <td>
                  <button
                    className="danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Detach workspace ${project.repository || project.id} from this team?`
                        )
                      ) {
                        void api.removeTeamProject(teamId, project.id).then(() => detail.reload()).catch(notifyError);
                      }
                    }}
                  >
                    Detach
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No workspaces"
          hint="Attach a workspace to this team so its bots and tasks belong to the team."
        />
      )}

      {members.length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <strong>Membership rows</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {members.length} membership row{members.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {members.map((m) => (
              <div key={m.id} style={{ marginBottom: 2 }}>
                {m.teammate_id ? `bot ${m.teammate_id}` : `workspace ${m.project_id}`}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
