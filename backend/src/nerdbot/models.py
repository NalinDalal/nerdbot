"""Shared domain models: Project, Teammate, Task, Run, Memory, Artifact, Approval, Event.

Hard distinctions enforced here and in the orchestrator:
- Teammate = durable identity (survives runs).
- Run = one execution of a task.
- A Task can have multiple Runs; retry creates a new Run, never a new Task.
- Memory entries carry provenance (source) and scope.
- Artifacts attach to tasks. Chat transcript is not the canonical task log.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(UTC)


class TaskStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"
    # The task is stopped on a human decision: an agent asked for a
    # privileged action and the owner has not answered yet. Not terminal —
    # the approval can still arrive, and the task then resumes.
    AWAITING_APPROVAL = "awaiting_approval"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    STOPPED = "stopped"
    CANCELLED = "cancelled"
    # The run is parked on a human decision. Not terminal: approving the
    # request finishes the run.
    AWAITING_APPROVAL = "awaiting_approval"


class VerificationStatus(StrEnum):
    UNVERIFIED = "unverified"
    PASSED = "passed"
    FAILED = "failed"


class Decision(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    APPROVED_FOREVER = "approved_forever"
    DENIED = "denied"


class TeammateStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"
    ARCHIVED = "archived"


class DelegationStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"


class Project(BaseModel):
    id: str
    owner: str
    repository: str = ""
    config: dict[str, Any] = Field(default_factory=dict)


class BotFace(BaseModel):
    """The face of a bot: three choices the owner makes when setting it up.

    The ids come from the catalogue in :mod:`nerdbot.faces`, which mirrors
    the dashboard's own list. The geometry lives in the dashboard, where the
    avatar is drawn; this model only carries the vocabulary.
    """

    shape: str = "cercle"
    color: str = "encre"
    expression: str = "neutre"


class Teammate(BaseModel):
    id: str
    project_id: str
    slug: str = ""
    # Display name shown next to a teammate's face in chat. Distinct from
    # persona (the system prompt) and slug (the @mention handle).
    name: str = ""
    persona: str = ""
    instructions: str = ""
    capabilities: list[str] = Field(default_factory=list)
    memory_scope: str = "project"
    permissions: list[str] = Field(default_factory=list)
    status: TeammateStatus = TeammateStatus.ACTIVE
    tool_policy: dict[str, Any] = Field(default_factory=dict)
    provider_id: str | None = None
    model: str = ""
    temperature: float | None = None
    max_tokens: int | None = None
    context_limit: int | None = None
    fallback_provider_id: str | None = None
    fallback_model: str = ""
    face: BotFace = Field(default_factory=BotFace)
    # ai-teammates persona files: the durable parts of a bot's identity.
    # soul is who the bot is; goals is what it is working toward; wisdom is
    # what it has learned and distilled. A bot reads these at the start of
    # every session so it does not start from zero.
    soul: str = ""
    goals: str = ""
    wisdom: str = ""
    persona_version: int = 0


class MemoryTier:
    """The three tiers of a bot's memory, in compaction order.

    Raw logs are the daily record. Typed memories are distilled facts.
    Wisdom is distilled principles — the stuff a bot carries forward.
    """

    RAW = "raw"
    TYPED = "typed"
    WISDOM = "wisdom"


class Task(BaseModel):
    id: str
    project_id: str
    description: str
    status: TaskStatus = TaskStatus.PENDING
    owner_teammate_id: str | None = None
    dependencies: list[str] = Field(default_factory=list)
    command: str = ""
    issue_id: str | None = None
    branch: str = ""
    workspace_path: str = ""
    # "checkout" is the original isolated per-task Git checkout. "workspace"
    # executes directly in the project's live workspace root so the owner can
    # watch files change in the same tree they are editing.
    workspace_mode: str = "checkout"
    board_id: str = ""
    parent_task_id: str = ""
    objective_id: str = ""
    assigned_by: str = ""
    # Why the task is blocked, in plain words ("openai-compatible provider
    # not configured"). Set when the task enters the blocked state and
    # cleared when it leaves it, so a blocked task can always explain
    # itself instead of showing a bare status.
    blocked_reason: str = ""
    # Short display name. Empty means derive on display.
    title: str = ""


class BoardStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Board(BaseModel):
    """A workspace container: a board owns tasks and teammates (bots), belongs
    to one project/workspace, and can exchange messages with other boards
    over the response channel."""
    id: str
    owner: str
    name: str
    description: str = ""
    project_id: str = ""
    team_id: str | None = None
    status: BoardStatus = BoardStatus.ACTIVE
    created_at: datetime = Field(default_factory=_utcnow)


class BoardMemberRole(StrEnum):
    MEMBER = "member"
    LEAD = "lead"


# The roles a board membership may carry. The dashboard renders this list from
# the server, so the UI can never offer a role the backend would reject.
BOARD_MEMBER_ROLES: tuple[str, ...] = tuple(role.value for role in BoardMemberRole)


class BoardMember(BaseModel):
    """A teammate (bot) that belongs to a board, with a role."""
    id: str
    board_id: str
    teammate_id: str
    role: str = BoardMemberRole.MEMBER.value
    created_at: datetime = Field(default_factory=_utcnow)


class BoardMessage(BaseModel):
    """A board-to-board message over the response channel."""
    id: str
    board_id: str  # originating board
    to_board_id: str | None = None  # target board (null = post to own board feed)
    from_teammate_id: str | None = None
    to_teammate_id: str | None = None  # direct message to one teammate (null = board feed)
    content: str
    kind: str = "message"  # message | handoff | notice | delegation
    created_at: datetime = Field(default_factory=_utcnow)


class Run(BaseModel):
    id: str
    task_id: str
    runtime: str = "local"
    session: str = ""
    status: RunStatus = RunStatus.QUEUED
    started_at: datetime = Field(default_factory=_utcnow)
    finished_at: datetime | None = None
    exit_code: int | None = None
    output_excerpt: str = ""
    command: str = ""
    stdout: str = ""
    stderr: str = ""
    duration_s: float = 0.0
    provider_id: str | None = None
    cancel_requested: bool = False
    container_id: str = ""
    resource_limits: dict[str, Any] = Field(default_factory=dict)


class MemoryEntry(BaseModel):
    id: str
    scope: str
    content: str
    source: str
    confidence: float = 0.5
    timestamp: datetime = Field(default_factory=_utcnow)
    tier: str = MemoryTier.RAW
    pinned: bool = False
    corrected: bool = False
    provenance: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    updated_at: datetime | None = None


class SkillScope(StrEnum):
    OWNER = "owner"
    PROJECT = "project"
    TEAMMATE = "teammate"


class Skill(BaseModel):
    id: str
    name: str
    slug: str = ""
    description: str = ""
    instructions: str = ""
    version: int = 1
    scope: str = SkillScope.OWNER.value
    owner: str = ""
    project_id: str = ""
    teammate_id: str = ""
    tool_policy: dict[str, Any] = Field(default_factory=dict)
    required_permissions: list[str] = Field(default_factory=list)
    enabled: bool = True
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime | None = None


class TeammateSkill(BaseModel):
    id: str
    teammate_id: str
    skill_id: str
    enabled: bool = True
    created_at: datetime = Field(default_factory=_utcnow)


class Artifact(BaseModel):
    id: str
    task_id: str
    run_id: str
    type: str = "patch"
    location: str = ""
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    summary: str = ""


class Approval(BaseModel):
    id: str
    run_id: str = ""
    board_id: str | None = None
    project_id: str = ""
    action: str
    requester: str
    decision: Decision = Decision.PENDING
    decided_at: datetime | None = None
    expires_at: datetime | None = None
    consumed_at: datetime | None = None
    task_id: str | None = None
    digest: str | None = None
    executed_at: datetime | None = None
    # The bot that asked for this action, when the approval came from a
    # gate inside an agent run.
    teammate_id: str = ""
    # The exact action that is waiting: the tool and its arguments, as JSON.
    # Empty on a manually requested approval (a run approval, a PR package
    # approval), which has nothing to resume.
    tool_name: str = ""
    tool_arguments: str = ""
    # When the resume started carrying this action out. It is written BEFORE
    # the action runs, so a crash cannot repeat it: for a privileged action,
    # at-most-once is the right way round.
    resumed_at: datetime | None = None
    # How the carried-out action ended, written after it ran. Empty means
    # "unknown" — the checkpoint was claimed but the record never landed,
    # which is the crash window the recovery reasons about.
    resume_result: str = ""
    # The binding of the ACTION: a digest over the tool, its canonical
    # arguments, the bot, the run and the task. The gate's own digest is the
    # request's identity and is unchanged; this one proves the resumed call
    # is the one that was asked for.
    tool_digest: str = ""


class ChatThread(BaseModel):
    id: str
    project_id: str
    title: str = ""
    provider_id: str | None = None
    summary: str = ""
    tainted: bool = False
    pinned: bool = False
    archived: bool = False
    archived_at: datetime | None = None
    deleted_at: datetime | None = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class ChatMessage(BaseModel):
    id: str
    thread_id: str
    role: str = "user"
    content: str = ""
    parts: list[dict[str, Any]] = Field(default_factory=list)
    # Which teammate authored this message ("" = the default bot or the user).
    teammate_id: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class ObjectiveStatus(StrEnum):
    PLANNING = "planning"
    AWAITING_APPROVAL = "awaiting_approval"
    RUNNING = "running"
    DONE = "done"
    PARTLY_FAILED = "partly_failed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Objective(BaseModel):
    id: str
    thread_id: str
    title: str = ""
    owner_text: str = ""
    status: ObjectiveStatus = ObjectiveStatus.PLANNING
    plan: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)


class Report(BaseModel):
    id: str
    thread_id: str
    message_id: str = ""
    title: str = ""
    markdown: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class ResearchJobStatus(StrEnum):
    QUEUED = "queued"
    PLANNING = "planning"
    SEARCHING = "searching"
    READING = "reading"
    SYNTHESIZING = "synthesizing"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ResearchJob(BaseModel):
    id: str
    project_id: str
    thread_id: str = ""
    owner: str = ""
    query: str = ""
    status: ResearchJobStatus = ResearchJobStatus.QUEUED
    provider: str = ""
    report_title: str = ""
    report_markdown: str = ""
    sources: list[dict[str, Any]] = Field(default_factory=list)
    error: str = ""
    library_doc_id: str = ""
    report_id: str = ""
    cancel_requested: bool = False
    created_at: datetime = Field(default_factory=_utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_at: datetime = Field(default_factory=_utcnow)


class ResearchJobEvent(BaseModel):
    seq: int = 0
    job_id: str
    kind: str = "status"
    content: str = ""
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=_utcnow)


CHAT_ROLES = frozenset({"user", "assistant", "tool", "system"})


class Event(BaseModel):
    id: str
    project_id: str
    entity: str
    entity_id: str
    event_type: str
    timestamp: datetime = Field(default_factory=_utcnow)


class ProviderKind(StrEnum):
    LOCAL = "local"
    MOCK = "mock"
    OPENAI_COMPATIBLE = "openai-compatible"
    OLLAMA = "ollama"


class ProviderStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class Provider(BaseModel):
    """Model provider configuration, owned by a project. Secrets in config
    are never returned by the API nor included in backups."""

    id: str
    project_id: str
    kind: ProviderKind = ProviderKind.LOCAL
    name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    capabilities: list[str] = Field(default_factory=list)
    status: ProviderStatus = ProviderStatus.ACTIVE
    created_at: datetime = Field(default_factory=_utcnow)


class KnowledgeSource(BaseModel):
    id: str
    project_id: str
    kind: str = "text"
    title: str = ""
    content: str = ""
    source: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class KnowledgeChunk(BaseModel):
    id: str
    source_id: str
    project_id: str
    idx: int = 0
    text: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


# Library document kinds/formats. `kind` kept for compatibility; `format`
# is the editable/export format (md/html/csv/text).
LIBRARY_KINDS = frozenset({"note", "doc", "upload"})
LIBRARY_FORMATS = frozenset({"md", "html", "csv", "text"})
LIBRARY_ACCESS_LEVELS = frozenset({"read", "write"})


class LibraryDoc(BaseModel):
    """One owner-owned document in the project Library.

    ``tainted`` marks content a bot has written: the owner sees the badge
    and decides whether to keep it. ``teammate_id`` is the bot that last
    wrote ("" = the owner). ``source`` is where the content came from
    (upload filename, "note", research job, …) and stays put across edits so
    provenance survives rewrites. ``format`` drives rendering/export.
    """

    id: str
    project_id: str
    kind: str = "note"
    format: str = "md"
    title: str = ""
    content: str = ""
    source: str = ""
    teammate_id: str = ""
    tainted: bool = False
    version: int = 1
    thread_id: str = ""
    task_id: str = ""
    job_id: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class LibraryDocVersion(BaseModel):
    """One saved state of a doc, appended on every save and never rewritten."""

    id: str
    doc_id: str
    version: int = 1
    title: str = ""
    content: str = ""
    source: str = ""
    teammate_id: str = ""
    tainted: bool = False
    format: str = "md"
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)


class LibraryDocAccess(BaseModel):
    """Per-teammate ACL row: absence of a row means no access (fail closed)."""

    id: str
    doc_id: str
    teammate_id: str
    access: str = "read"
    created_at: datetime = Field(default_factory=_utcnow)


class GalleryAsset(BaseModel):
    """A managed file/image asset for Gallery (view/manage only)."""

    id: str
    project_id: str
    name: str = ""
    mime_type: str = "application/octet-stream"
    size: int = 0
    source: str = ""
    thread_id: str = ""
    task_id: str = ""
    doc_id: str = ""
    storage_path: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)


class Schedule(BaseModel):
    id: str
    project_id: str
    name: str = ""
    cron: str = "* * * * *"
    timezone: str = "UTC"
    task_template: dict[str, Any] = Field(default_factory=dict)
    teammate_id: str = ""
    target_action: str = "task"  # task | reminder-hook/reserved; task uses task_template
    enabled: bool = True
    paused: bool = False
    overlap_policy: str = "skip"  # skip (current lock) | allow
    next_run_at: datetime | None = None
    last_fired_at: datetime | None = None
    last_run_status: str = ""
    last_error: str = ""
    locked: bool = False
    fire_count: int = 0
    created_at: datetime = Field(default_factory=_utcnow)


class ScheduleRun(BaseModel):
    id: str
    schedule_id: str
    project_id: str
    status: str = "fired"  # fired | failed | skipped
    task_id: str = ""
    run_id: str = ""
    error: str = ""
    fired_at: datetime = Field(default_factory=_utcnow)
    finished_at: datetime | None = None



class Notification(BaseModel):
    id: str
    project_id: str
    channel: str = "outbox"
    kind: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    status: str = "queued"
    target_url: str = ""
    attempts: int = 0
    next_attempt_at: datetime | None = None
    locked: bool = False
    locked_at: datetime | None = None
    last_error: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class ReminderStatus(StrEnum):
    PENDING = "pending"
    FIRED = "fired"
    CANCELLED = "cancelled"
    FAILED = "failed"


class Reminder(BaseModel):
    id: str
    project_id: str = ""
    thread_id: str = ""
    owner: str = ""
    teammate_id: str = ""  # who set/requested it
    message: str = ""
    due_at: datetime | None = None
    timezone: str = "UTC"
    status: ReminderStatus = ReminderStatus.PENDING
    source: str = "chat"  # chat | teammate | user
    notify_channel: str = "in_app"
    notification_id: str = ""
    fired_at: datetime | None = None
    created_at: datetime = Field(default_factory=_utcnow)


class Issue(BaseModel):
    """Issue intake: manual ingestion or (deferred) GitHub-backed fetch."""

    id: str
    project_id: str
    source: str = "manual"
    external_id: str = ""
    title: str = ""
    body: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    repository_url: str = ""
    base_branch: str = "main"
    labels: list[str] = Field(default_factory=list)
    owner_teammate_id: str | None = None
    priority: str = "medium"
    status: str = "open"
    created_at: datetime = Field(default_factory=_utcnow)


class ReviewVerdict(StrEnum):
    ACCEPTED = "accepted"
    NEEDS_WORK = "needs_work"
    REJECTED = "rejected"


class Review(BaseModel):
    """Reviewer pass: never overwrites implementation artifacts."""

    id: str
    task_id: str
    run_id: str = ""
    reviewer_teammate_id: str = ""
    verdict: ReviewVerdict = ReviewVerdict.NEEDS_WORK
    notes: str = ""
    risks: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)


class PRPackage(BaseModel):
    """Validated, reviewable PR candidate. Never pushed automatically."""

    id: str
    task_id: str
    title: str = ""
    body: str = ""
    base_branch: str = "main"
    head_branch: str = ""
    labels: list[str] = Field(default_factory=list)
    patch_summary: str = ""
    test_evidence: list[dict[str, Any]] = Field(default_factory=list)
    review_evidence: dict[str, Any] = Field(default_factory=dict)
    patch_artifact_id: str = ""
    digest: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class Team(BaseModel):
    """A fleet grouping under one owner: projects and/or bots around a purpose.

    A team is the single grouping abstraction in NerdBot. It may contain
    projects (workspaces) and teammates (bots) — see :class:`TeamMember`.
    Boards are separate: they are per-project workspace containers for tasks.
    """

    id: str
    owner: str
    name: str = ""
    description: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class TeamMember(BaseModel):
    """One membership row: either a project or a teammate inside a team.

    Exactly one of ``project_id`` / ``teammate_id`` is non-empty. The dual
    shape keeps a single grouping model instead of introducing a parallel
    'board-of-bots' abstraction. Rows created before bot membership existed
    always carry a ``project_id``.
    """

    id: str
    team_id: str
    project_id: str = ""
    teammate_id: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class Delegation(BaseModel):
    """A handoff of a task from one teammate to another, bounded by depth.

    The lifecycle is: ``pending`` → ``accepted`` | ``declined`` (the
    delegatee's decision) → ``completed`` | ``failed`` (the delegatee's
    actual result) or ``cancelled`` | ``timed_out`` (the delegator's or the
    deadline's decision). ``pending`` never resolves to a success on its own.
    """

    id: str
    task_id: str
    from_teammate_id: str
    to_teammate_id: str
    reason: str = ""
    status: DelegationStatus = DelegationStatus.PENDING
    depth: int = 1
    created_at: datetime = Field(default_factory=_utcnow)
    decided_at: datetime | None = None
    child_task_id: str = ""  # task created for the delegatee (agent-driven delegation)
    result: str = ""  # final result returned by the delegatee (response channel)
    result_run_id: str = ""  # run that produced the result
    finished_at: datetime | None = None
    deadline_at: datetime | None = None  # after this, the delegation times out
    scope: str = ""  # the bounded scope the delegator stated
    attempts: int = 0  # how many times this objective was delegated
