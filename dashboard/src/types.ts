export interface Project {
  id: string;
  owner: string;
  repository: string;
  config: Record<string, unknown>;
}

export interface Teammate {
  id: string;
  project_id: string;
  persona: string;
  instructions: string;
  capabilities: string[];
  memory_scope: string;
  permissions: string[];
  status: string;
  tool_policy: Record<string, unknown>;
  provider_id: string | null;
}

export interface Task {
  id: string;
  project_id: string;
  description: string;
  status: string;
  owner_teammate_id: string | null;
  dependencies: string[];
  command: string;
  issue_id: string | null;
  branch: string;
  workspace_path: string;
}

export interface Run {
  id: string;
  task_id: string;
  runtime: string;
  session: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  output_excerpt: string;
  command: string;
  stdout: string;
  stderr: string;
  duration_s: number;
  provider_id: string | null;
}

export interface Artifact {
  id: string;
  task_id: string;
  run_id: string;
  type: string;
  location: string;
  verification_status: string;
  summary: string;
}

export interface Approval {
  id: string;
  run_id: string;
  action: string;
  requester: string;
  decision: string;
  decided_at: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  task_id: string | null;
  digest: string | null;
}

export interface Provider {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  /** Secret values arrive redacted from the server; treat as opaque. */
  config: Record<string, unknown>;
  capabilities: string[];
  status: string;
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  source: string;
  external_id: string;
  title: string;
  body: string;
  acceptance_criteria: string[];
  repository_url: string;
  base_branch: string;
  labels: string[];
  owner_teammate_id: string | null;
  priority: string;
  status: string;
  created_at: string;
}

export interface Review {
  id: string;
  task_id: string;
  run_id: string;
  reviewer_teammate_id: string;
  verdict: string;
  notes: string;
  risks: string[];
  created_at: string;
}

export interface PRPackage {
  id: string;
  task_id: string;
  title: string;
  body: string;
  base_branch: string;
  head_branch: string;
  labels: string[];
  patch_summary: string;
  test_evidence: Array<Record<string, unknown>>;
  review_evidence: Record<string, unknown>;
  patch_artifact_id: string;
  digest: string;
  created_at: string;
}

export interface KnowledgeSource {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  created_at: string;
}

export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  cron: string;
  task_template: Record<string, unknown>;
  enabled: boolean;
  next_run_at: string | null;
  last_fired_at: string | null;
  locked: boolean;
  fire_count: number;
  created_at: string;
}

export interface Notification {
  id: string;
  project_id: string;
  channel: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  target_url: string;
  attempts: number;
  next_attempt_at: string | null;
  locked: boolean;
  created_at: string;
}

export interface Event {
  id: string;
  project_id: string;
  entity: string;
  entity_id: string;
  event_type: string;
  timestamp: string;
}

export interface MemoryEntry {
  id: string;
  scope: string;
  content: string;
  source: string;
  confidence: number;
  timestamp: string;
}

export interface Capability {
  id: string;
  status: string;
  description: string;
}

export interface Health {
  status: string;
  version: string;
  db: string;
  restarts: number;
}

export interface TaskView {
  task: Task;
  runs: Run[];
  artifacts: Artifact[];
  issue: Issue | null;
  reviews: Review[];
  pr_packages: PRPackage[];
}

export interface ChatThread {
  id: string;
  project_id: string;
  title: string;
  provider_id: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ThreadView {
  thread: ChatThread;
  messages: ChatMessage[];
}

export interface MemoryProvenance {
  id: string;
  source: string;
  confidence: number;
}

/** Config keys whose values must never be rendered. Server redacts these,
 *  but the UI masks them too so a backend regression cannot leak secrets. */
export const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "secret",
  "token",
  "password",
  "authorization",
]);

export function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "••••••••" : value;
  }
  return out;
}
