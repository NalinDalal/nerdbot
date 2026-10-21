/** Settings view (S1 BYOK slice): server state, secret-key posture, and the
 * owner's guide to keys, bots, and the sign-in model. Single owner, no
 * accounts: everything here is state-of-the-server, not per-user prefs. */

import { api } from "./api";
import { EmptyState, ErrorState, LoadingState, Badge, Button, SectionLabel, Page, PageHeader, useAsync } from "./components";

const CODE_BLOCK =
  "mono mt-2 overflow-x-auto rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[var(--step-minus-1)] text-[var(--text-soft)]";

export function SettingsView() {
  const health = useAsync(() => api.health(), []);

  return (
    <Page>
      <PageHeader
        eyebrow="Server"
        title="Settings"
        description="Server state and the owner's guide. There is one principal here — you — so settings describe the machine, not accounts."
      />

      {health.loading ? (
        <LoadingState lines={2} />
      ) : health.error ? (
        <ErrorState error={health.error} onRetry={health.reload} />
      ) : health.data ? (
        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-[var(--text)]">NerdBot API server</span>
              <Badge variant={health.data.status === "ok" ? "ok" : "bad"}>{health.data.status}</Badge>
            </div>
            <Button onClick={health.reload}>Refresh</Button>
          </div>
          <div className="mono mt-2 text-[var(--step-minus-1)] text-[var(--muted)]">
            version {health.data.version} · db {health.data.db} · restarts {health.data.restarts}
            {" · "}secret key: {health.data.secret_key ?? "unknown"}
          </div>
          {health.data.secret_key === "absent" ? (
            <div className="mt-3 rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-3 py-2 text-[var(--step-minus-1)]">
              <p>
                Storing pasted API keys needs <code>NERDBOT_SECRET_KEY</code> (a Fernet key).
                Start the server like:
              </p>
              <pre className={CODE_BLOCK}>{`NERDBOT_SECRET_KEY="generate one below" nerdbot run
# one-shot key: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`}</pre>
              <p className="mt-2">The <code>api_key_env</code> integration keeps working without it.</p>
            </div>
          ) : (
            <div className="mt-3 text-[var(--step-minus-1)] text-[var(--muted)]">
              BYOK is live: pasted keys are saved Fernet-encrypted at rest and echoed back
              only as fingerprints (<code className="mono">****last4</code>).
            </div>
          )}
        </section>
      ) : (
        <EmptyState title="Server unreachable" hint="Start it: nerdbot run, then Refresh." />
      )}

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <SectionLabel className="mb-3">Where things live</SectionLabel>
        <ul className="flex flex-col gap-2 text-[var(--step-0)] text-[var(--text-soft)] leading-relaxed [list-style:none] p-0">
          <li>
            <strong className="text-[var(--text)]">Model connections</strong> (your llm keys + base URL + model) are per
            project → open a project, <strong className="text-[var(--text)]">Providers</strong> tab.
          </li>
          <li>
            <strong className="text-[var(--text)]">Bots</strong> are per project → <strong className="text-[var(--text)]">Bots</strong> tab. Attach a
            connection so a bot can think.
          </li>
          <li>
            <strong className="text-[var(--text)]">Chat</strong> is per project → <strong className="text-[var(--text)]">Chat</strong> tab; give a bot a
            real mission under <strong className="text-[var(--text)]">Tasks</strong> and watch runs + artifacts there.
          </li>
          <li>
            Status of every capability (what&rsquo;s real vs stub): the{" "}
            <a className="text-[var(--accent)] hover:underline" href="#/capabilities">Capabilities</a> page keeps it honest.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <SectionLabel className="mb-3">Connection details</SectionLabel>
        <pre className={CODE_BLOCK}>{`API base:  http://127.0.0.1:8080   (dashboard served by the API)
token:     NERDBOT_TOKEN=<your token> — single bearer token, fail-closed
start:     NERDBOT_TOKEN=$(cat ~/.nerdbot-owner-token) uv run nerdbot run`}</pre>
        <div className="mt-3 text-[var(--step-minus-1)] text-[var(--muted)]">
          Fail-closed by design: with no <code className="mono">NERDBOT_TOKEN</code> set the server
          refuses every bearer token (HTTP 503), and the well-known dev token is
          accepted only with <code className="mono">NERDBOT_INSECURE_DEV_TOKEN=1</code>. Single
          static token rotation is a recorded non-goal.
        </div>
      </section>
    </Page>
  );
}
