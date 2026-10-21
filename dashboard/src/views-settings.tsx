/** Settings view (S1 BYOK slice): server state, secret-key posture, and the
 * owner's guide to keys, bots, and the sign-in model. Single owner, no
 * accounts: everything here is state-of-the-server, not per-user prefs. */

import { api } from "./api";
import { EmptyState, ErrorState, LoadingState, StatusBadge, useAsync } from "./components";

export function SettingsView() {
  const health = useAsync(() => api.health(), []);

  return (
    <div>
      <h1>Settings</h1>
      <p className="subtitle">
        Server state and the owner's guide. There is one principal here — you — so settings
        describe the machine, not accounts.
      </p>

      {health.loading ? (
        <LoadingState lines={2} />
      ) : health.error ? (
        <ErrorState error={health.error} onRetry={health.reload} />
      ) : health.data ? (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>NerdBot API server</strong> <StatusBadge status={health.data.status} />
            </div>
            <button onClick={health.reload}>Refresh</button>
          </div>
          <div className="mono muted" style={{ marginTop: 8 }}>
            version {health.data.version} · db {health.data.db} · restarts {health.data.restarts}
            {" · "}secret key:{" "}
            <code>{health.data.secret_key ?? "unknown"}</code>
          </div>
          {health.data.secret_key === "absent" ? (
            <div className="error-box" style={{ marginTop: 12 }}>
              Storing pasted API keys needs <code>NERDBOT_SECRET_KEY</code> (a Fernet key).
              Start the server like:
              <pre className="log">{`NERDBOT_SECRET_KEY="generate one below" nerdbot run
# one-shot key: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`}</pre>
              The <code>api_key_env</code> integration keeps working without it.
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 12 }}>
              BYOK is live: pasted keys are saved Fernet-encrypted at rest and echoed back
              only as fingerprints (<code>****last4</code>).
            </div>
          )}
        </div>
      ) : (
        <EmptyState title="Server unreachable" hint="Start it: nerdbot run, then Refresh." />
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <strong>Where things live</strong>
        <ul style={{ marginTop: 8, lineHeight: 1.7 }}>
          <li>
            <strong>Model connections</strong> (your llm keys + base URL + model) are per
            project → open a project, <strong>Providers</strong> tab.
          </li>
          <li>
            <strong>Bots</strong> are per project → <strong>Bots</strong> tab. Attach a
            connection so a bot can think.
          </li>
          <li>
            <strong>Chat</strong> is per project → <strong>Chat</strong> tab; give a bot a
            real mission under <strong>Tasks</strong> and watch runs + artifacts there.
          </li>
          <li>
            Status of every capability (what's real vs stub): the{" "}
            <a href="#/capabilities">Capabilities</a> page keeps it honest.
          </li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <strong>Connection details</strong>
        <pre className="log">{`API base:  http://127.0.0.1:8080   (dashboard served by the API)
token:     NERDBOT_TOKEN=<your token> — single bearer token, fail-closed
start:     NERDBOT_TOKEN=$(cat ~/.nerdbot-owner-token) uv run nerdbot run`}</pre>
        <div className="muted" style={{ marginTop: 8 }}>
          Fail-closed by design: with no <code>NERDBOT_TOKEN</code> set the server
          refuses every bearer token (HTTP 503), and the well-known dev token is
          accepted only with <code>NERDBOT_INSECURE_DEV_TOKEN=1</code>. Single
          static token rotation is a recorded non-goal.
        </div>
      </div>
    </div>
  );
}
