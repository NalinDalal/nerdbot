/** Settings view: server health, model connections, security, connection details.
 *
 *  Single owner, no accounts: everything here describes the machine, not
 *  per-user preferences. The page is split so that what the owner needs to
 *  do (connect a model) is separate from what a maintainer needs to read
 *  (how the server is started, how keys are stored).
 */

import { api } from "./api";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Page,
  PageHeader,
  PageSection,
  StatStrip,
  useAsync,
} from "./components";

export function SettingsView() {
  const health = useAsync(() => api.health(), []);

  /* Which workspaces have a model connection, and do they have a key? The
     page must not imply a key is configured when it is not. */
  const connections = useAsync(async () => {
    const projects = (await api.listProjects()).projects;
    const rows = await Promise.all(
      projects.map(async (project) => {
        try {
          const providers = (await api.listProviders(project.id)).providers;
          const usable = providers.filter(
            (p) =>
              p.kind !== "openai-compatible" ||
              (typeof p.config?.base_url === "string" && p.config.base_url.trim() !== "") ||
              typeof p.config?.api_key === "string" ||
              typeof p.config?.api_key_env === "string",
          );
          return {
            id: project.id,
            name: project.repository || project.id,
            total: providers.length,
            usable: usable.length,
          };
        } catch {
          return { id: project.id, name: project.repository || project.id, total: 0, usable: 0 };
        }
      }),
    );
    return rows;
  }, []);

  const ready = (connections.data ?? []).filter((c) => c.usable > 0);
  const needsKey = (connections.data ?? []).filter((c) => c.total > 0 && c.usable === 0);

  return (
    <Page>
      <PageHeader
        eyebrow="Server"
        title="Settings"
        description="Server state and how to connect a model. There is one principal here, so these settings describe the machine, not accounts."
        actions={<Button onClick={() => { health.reload(); connections.reload(); }}>Refresh</Button>}
      />

      {health.loading ? (
        <LoadingState lines={2} />
      ) : health.error ? (
        <ErrorState error={health.error} onRetry={health.reload} />
      ) : health.data ? (
        <PageSection
          title="Server health"
          description="Is the server up, and is it able to store a pasted key."
        >
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-medium text-[var(--text)]">NerdBot API server</span>
              <Badge variant={health.data.status === "ok" ? "ok" : "bad"}>{health.data.status}</Badge>
            </div>
            <dl className="divide-y divide-[var(--border-dim)]">
              <KeyValue label="Version">{health.data.version}</KeyValue>
              <KeyValue label="Database">
                <Badge variant={health.data.db === "ok" ? "ok" : "bad"}>{health.data.db}</Badge>
              </KeyValue>
              <KeyValue label="Restarts">{health.data.restarts}</KeyValue>
              <KeyValue label="Key storage">
                <Badge variant={health.data.secret_key === "absent" ? "warn" : "ok"}>
                  secret key {health.data.secret_key ?? "unknown"}
                </Badge>
              </KeyValue>
            </dl>
          </div>
          {health.data.secret_key === "absent" ? (
            <div className="mt-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3">
              <p className="text-[var(--step-minus-1)] text-[var(--text)]">
                Pasted API keys cannot be stored until the server has a secret key. Start it
                with one:
              </p>
              <div className="mt-2">
                <CodeBlock>
                  {`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`}
                </CodeBlock>
              </div>
              <p className="mt-2 text-[var(--step-minus-1)] text-[var(--muted)]">
                Then start the server with <code className="mono">NERDBOT_SECRET_KEY</code> set.
                Keys stored through <code className="mono">api_key_env</code> keep working without
                it.
              </p>
            </div>
          ) : null}
        </PageSection>
      ) : (
        <EmptyState title="Server unreachable" hint="Start it with nerdbot run, then Refresh." />
      )}

      <PageSection
        title="Model connections"
        description="A bot can only think if its workspace has a model connection with a working key."
      >
        {connections.loading ? (
          <LoadingState lines={2} />
        ) : connections.error ? (
          <ErrorState error={connections.error} onRetry={connections.reload} />
        ) : (
          <>
            {ready.length > 0 ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <StatStrip
                  items={[
                    { label: "workspaces with a working connection", value: ready.length, tone: "ok" },
                  ]}
                />
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[var(--step-minus-1)] text-[var(--muted)]">
                  {ready.map((c) => (
                    <li key={c.id}>
                      <a className="text-[var(--accent)] hover:underline" href={`#/p/${c.id}`}>
                        {c.name}
                      </a>
                      {" · "}
                      {c.usable} connection{c.usable === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {needsKey.length > 0 ? (
              <div className="mt-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-dim)] px-4 py-3">
                <p className="text-[var(--step-minus-1)] text-[var(--text)]">
                  {needsKey.length === 1 ? "One workspace has" : `${needsKey.length} workspaces have`}{" "}
                  a model connection with no usable key. Tasks assigned to bots there will block.
                </p>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[var(--step-minus-1)]">
                  {needsKey.map((c) => (
                    <li key={c.id}>
                      <a className="text-[var(--accent)] hover:underline" href={`#/p/${c.id}`}>
                        {c.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {ready.length === 0 && needsKey.length === 0 ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <p className="text-[var(--step-minus-1)] text-[var(--text)]">
                  No workspace has a model connection yet. Bots cannot think until one does.
                </p>
                <p className="mt-1 text-[var(--step-minus-1)] text-[var(--muted)]">
                  Open a workspace, then its Providers tab. A connection needs a base URL, a model
                  name, and either a pasted key or the name of an environment variable that holds
                  one.
                </p>
                <a
                  href="#/projects"
                  className="mt-2 inline-flex text-[var(--step-minus-1)] text-[var(--accent)] hover:underline"
                >
                  Go to workspaces →
                </a>
              </div>
            ) : null}
          </>
        )}
      </PageSection>

      <PageSection
        title="Security"
        description="How this server handles the one token that lets you in, and the keys you paste."
      >
        <dl className="divide-y divide-[var(--border-dim)] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-1">
          <KeyValue label="Sign in">
            One bearer token, kept in this browser&apos;s local storage only. It is never sent
            anywhere else.
          </KeyValue>
          <KeyValue label="Fail closed">
            With no <code className="mono">NERDBOT_TOKEN</code> set, the server refuses every
            bearer token. The well-known dev token is accepted only with{" "}
            <code className="mono">NERDBOT_INSECURE_DEV_TOKEN=1</code>.
          </KeyValue>
          <KeyValue label="Pasted keys">
            Stored Fernet-encrypted at rest, echoed back only as a fingerprint such as{" "}
            <code className="mono">****last4</code>. Raw keys are never returned by the API.
          </KeyValue>
          <KeyValue label="Shell access">
            Bots may run shell commands inside their task workspace. That is a deliberate
            decision, bounded by the run, the workspace and the deny list. See the ADR in the
            repository.
          </KeyValue>
        </dl>
      </PageSection>

      <PageSection
        title="Connection details"
        description="What to type when you want to talk to this server from a script."
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[var(--step-minus-1)] text-[var(--muted)]">API base</div>
            <CodeBlock>{"http://127.0.0.1:8080   (the dashboard is served by the API)"}</CodeBlock>
          </div>
          <div>
            <div className="mb-1 text-[var(--step-minus-1)] text-[var(--muted)]">Token</div>
            <CodeBlock>{"NERDBOT_TOKEN=<your token>   # single bearer token, fail closed"}</CodeBlock>
          </div>
          <div>
            <div className="mb-1 text-[var(--step-minus-1)] text-[var(--muted)]">Start the server</div>
            <CodeBlock>{"NERDBOT_TOKEN=$(cat ~/.nerdbot-owner-token) uv run nerdbot run"}</CodeBlock>
          </div>
          <p className="text-[var(--step-minus-1)] text-[var(--muted)]">
            Single static token rotation is a recorded non-goal. See{" "}
            <a className="text-[var(--accent)] hover:underline" href="#/capabilities">
              Capabilities
            </a>{" "}
            for what this build can actually do.
          </p>
        </div>
      </PageSection>
    </Page>
  );
}
