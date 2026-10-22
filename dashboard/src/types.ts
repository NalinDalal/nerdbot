export interface Project {
  id: string;
  owner: string;
  repository: string;
  config: Record<string, unknown>;
}

/** What a workspace holds. Sent alongside the project list so a workspace
 *  can be described without opening it. */
export interface ProjectCounts {
  bots: number;
  tasks: number;
  running: number;
  blocked: number;
  done: number;
  boards: number;
  runs: number;
  approvals: number;
}

/** A bot's face: the body shape, the colour and the resting expression the
 *  owner picked. The ids come from the catalogue in `src/bot/`. */
export interface BotFace {
  shape: string;
  color: string;
  expression: string;
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
  face: BotFace;
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
  board_id: string;
  /** Set when this task was created by a parent's delegate_task tool. */
  parent_task_id: string;
  /** Why the task is blocked, in plain words. Empty when not blocked. */
  blocked_reason: string;
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
  /** True once a stop was requested for this run. */
  cancel_requested: boolean;
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
  locked_at: string | null;
  last_error: string;
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

export interface Team {
  id: string;
  owner: string;
  name: string;
  description: string;
  created_at: string;
}

/** How many bots and workspaces a team holds. */
export interface TeamCounts {
  bots: number;
  workspaces: number;
}

export interface TeamMember {
  id: string;
  team_id: string;
  project_id: string;
  teammate_id: string;
  created_at: string;
}

export interface Delegation {
  id: string;
  task_id: string;
  from_teammate_id: string;
  to_teammate_id: string;
  reason: string;
  status: string;
  depth: number;
  created_at: string;
  decided_at: string | null;
  /** Child task created for the delegatee (agent-driven delegation). */
  child_task_id: string;
  /** Result returned through the response channel once the child finishes. */
  result: string;
  result_run_id: string;
  finished_at: string | null;
}

export interface Board {
  id: string;
  owner: string;
  name: string;
  description: string;
  project_id: string;
  team_id: string | null;
  status: string;
  created_at: string;
}

export interface BoardMember {
  id: string;
  board_id: string;
  teammate_id: string;
  role: string;
  created_at: string;
}

export interface BoardMessage {
  id: string;
  board_id: string;
  to_board_id: string | null;
  from_teammate_id: string | null;
  /** Targeted message (response channel); null = board-wide. */
  to_teammate_id: string | null;
  content: string;
  kind: string;
  created_at: string;
}

/** Board feed message as returned per-project (adds the board's name). */
export interface ProjectMessage extends BoardMessage {
  board_name: string;
}

export interface Approval {
  id: string;
  run_id: string;
  board_id: string | null;
  project_id: string | null;
  action: string;
  requester: string;
  decision: string;
  decided_at: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  task_id: string | null;
  digest: string | null;
  /** Set once the approved exact action executed (one-use binding). */
  executed_at: string | null;
}

export interface Capability {
  id: string;
  status: string;
  description: string;
}

/** One entry of the backend's canonical permission catalogue. */
export interface Permission {
  name: string;
  /** "admin" (approval-gated) or "agent" (permission-only). */
  kind: string;
  summary: string;
  requires_approval: boolean;
}

export interface Health {
  status: string;
  version: string;
  db: string;
  restarts: number;
  /** "configured" (Fernet key present) or "absent" (BYOK writes are blocked). */
  secret_key?: string;
}

export interface TaskView {
  task: Task;
  runs: Run[];
  artifacts: Artifact[];
  issue: Issue | null;
  reviews: Review[];
  pr_packages: PRPackage[];
  /** Approvals tied to this task, so a task waiting on a decision can be
   *  decided from the task itself. */
  approvals: Approval[];
  delegations: Delegation[];
  /** Child tasks created via delegation (nested tree, one level per view). */
  children: Task[];
  parent: Task | null;
}

export interface ChatThread {
  id: string;
  project_id: string;
  title: string;
  provider_id: string | null;
  summary: string;
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

/** One subtask in a decomposition plan (what the human reviews). */
export interface PlanSubTask {
  description: string;
  command: string;
  depends_on: number[];
}

export interface Plan {
  tasks: PlanSubTask[];
}

/** POST /boards/{id}/decompose response (preview or materialized). */
export interface DecomposeResult {
  board: Board | null;
  tasks: Task[];
  plan: Plan;
  objective?: string;
  preview?: boolean;
}

/** A file inside a task's isolated workspace. */
export interface WorkspaceFile {
  path: string;
  size: number;
  modified: number;
}
