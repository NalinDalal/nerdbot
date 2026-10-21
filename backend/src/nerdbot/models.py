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


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    STOPPED = "stopped"


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


class Teammate(BaseModel):
    id: str
    project_id: str
    persona: str = ""
    instructions: str = ""
    capabilities: list[str] = Field(default_factory=list)
    memory_scope: str = "project"
    permissions: list[str] = Field(default_factory=list)
    status: TeammateStatus = TeammateStatus.ACTIVE
    tool_policy: dict[str, Any] = Field(default_factory=dict)
    provider_id: str | None = None


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
    board_id: str = ""
    parent_task_id: str = ""


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


class MemoryEntry(BaseModel):
    id: str
    scope: str
    content: str
    source: str
    confidence: float = 0.5
    timestamp: datetime = Field(default_factory=_utcnow)


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


class ChatThread(BaseModel):
    id: str
    project_id: str
    title: str = ""
    provider_id: str | None = None
    summary: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class ChatMessage(BaseModel):
    id: str
    thread_id: str
    role: str = "user"
    content: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


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


class Schedule(BaseModel):
    id: str
    project_id: str
    name: str = ""
    cron: str = "* * * * *"
    task_template: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    next_run_at: datetime | None = None
    last_fired_at: datetime | None = None
    locked: bool = False
    fire_count: int = 0
    created_at: datetime = Field(default_factory=_utcnow)


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
