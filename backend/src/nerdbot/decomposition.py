"""LLM-driven task decomposition service.

Takes a free-form objective, asks the configured provider to split it into
ordered subtasks with dependencies, then materializes them as real tasks
(inside an optional board) wired with ``dependencies`` so the executor can
run them in sequence.
"""

from __future__ import annotations

import contextlib
import sqlite3
from typing import Any

from pydantic import BaseModel

from . import chat as chat_mod
from . import store
from .models import Board, Provider, Task, TeammateStatus

DECOMPOSITION_SYSTEM = (
    "You are a planning assistant. Given an objective, split it into an "
    "ordered list of concrete, executable subtasks. Return ONLY a JSON "
    "object with a ``tasks`` array. Each subtask has: ``description`` "
    "(one-line imperative), ``command`` (shell command to run, or ``\"\"`` "
    "if it is a coordination step), and ``depends_on`` (array of zero-based "
    "indices of subtasks that must finish first). Keep commands safe and "
    "workspace-scoped. Never include text outside the JSON object."
)


class SubTask(BaseModel):
    description: str
    command: str = ""
    depends_on: list[int] = []
    # Empty means "the parent agent keeps the step". A teammate id assigns the
    # step to that bot; the server validates it before the step is created.
    owner_teammate_id: str = ""


class Plan(BaseModel):
    tasks: list[SubTask]


# Bounds on a plan an agent may propose. The model decides the plan; the
# server decides whether it may run.
MAX_PLAN_STEPS = 12
MAX_PLAN_COMMAND_CHARS = 2000
MAX_PLAN_DESCRIPTION_CHARS = 500


class PlanError(ValueError):
    """A plan the server refuses to execute (never a partial execution)."""


def validate_plan(
    plan: Plan,
    *,
    project_id: str,
    acting_teammate_id: str,
    known_teammate_ids: set[str] | None = None,
) -> list[str]:
    """Check a proposed plan. Returns the list of problems (empty = valid).

    The rules: a bounded number of steps; a description on every step;
    dependencies that point *backwards* only (so the graph is acyclic and
    executable in order); and owners that exist in the same project.
    """
    problems: list[str] = []
    steps = plan.tasks
    if not steps:
        problems.append("a plan needs at least one step")
        return problems
    if len(steps) > MAX_PLAN_STEPS:
        problems.append(
            f"plan has {len(steps)} steps; the limit is {MAX_PLAN_STEPS}"
        )
    for idx, step in enumerate(steps):
        if not step.description.strip():
            problems.append(f"step {idx} has no description")
        elif len(step.description) > MAX_PLAN_DESCRIPTION_CHARS:
            problems.append(
                f"step {idx} description is longer than {MAX_PLAN_DESCRIPTION_CHARS} characters"
            )
        if len(step.command) > MAX_PLAN_COMMAND_CHARS:
            problems.append(
                f"step {idx} command is longer than {MAX_PLAN_COMMAND_CHARS} characters"
            )
        seen: set[int] = set()
        for dep in step.depends_on:
            if dep in seen:
                problems.append(f"step {idx} lists dependency {dep} twice")
            seen.add(dep)
            if dep < 0 or dep >= len(steps):
                problems.append(f"step {idx} depends on unknown step {dep}")
            elif dep >= idx:
                problems.append(
                    f"step {idx} depends on step {dep}; dependencies must point "
                    "backwards so the plan can run in order"
                )
        owner = step.owner_teammate_id.strip()
        if (
            owner
            and owner != acting_teammate_id
            and known_teammate_ids is not None
            and owner not in known_teammate_ids
        ):
            problems.append(
                f"step {idx} is assigned to {owner}, which is not an active "
                "bot in this project"
            )
    return problems


def _extract_json(text: str) -> str:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object found in provider response")
    return text[start : end + 1]


def resolve_provider(conn: sqlite3.Connection, project_id: str) -> Provider | None:
    """The project's chat provider for decomposition: the capable default (or
    mock), else ``None`` (fail closed). Thread-less — no thread exists yet."""
    return chat_mod.resolve_chat_provider(conn, project_id)


def plan_objective(
    conn: sqlite3.Connection,
    project_id: str,
    objective: str,
    provider: Provider,
) -> Plan:
    """Ask the provider to split ``objective`` into subtasks. Side-effect free:
    this is the preview leg of the plan-review flow."""
    messages, _provenance = chat_mod.build_planning_messages(conn, project_id)
    prompt = (
        DECOMPOSITION_SYSTEM
        + "\n\nObjective: "
        + objective
        + "\n\nReturn the plan as JSON."
    )
    messages.append({"role": "user", "content": prompt})
    text = chat_mod.chat_complete(provider, messages)
    try:
        return Plan.model_validate_json(_extract_json(text))
    except Exception as exc:
        raise ValueError(f"provider did not return a valid decomposition plan: {exc}") from exc


def materialize_plan(
    conn: sqlite3.Connection,
    project_id: str,
    plan: Plan,
    *,
    objective: str = "",
    board_name: str | None = None,
    create_board: bool = True,
    attach_board_id: str | None = None,
    acting_teammate_id: str | None = None,
) -> dict[str, Any]:
    """Create the board and tasks for an already-reviewed plan. No LLM call:
    the exact plan the human reviewed is what gets materialized.

    A step that names a teammate is created owned by that teammate (the plan
    was validated before this runs); unnamed steps stay with the acting bot,
    or become unowned when the reviewer is the human, so the executor sweep
    can claim them.

    ``create_board=False`` with ``attach_board_id`` hangs the plan's tasks on
    an existing board instead of creating a fresh one (the agent path: a bot
    without ``board.create`` can still plan inside a board it already works
    on). The board row must belong to this project.
    """
    board: Board | None = None
    if create_board:
        # The board belongs to the workspace owner (the human principal), not
        # to whoever triggered the decomposition — otherwise a bot-driven
        # decomposition would create a board the owner cannot see. A bot that
        # triggered it joins as a member so it keeps access.
        project = store.get_project(conn, project_id)
        owner = (project.owner if project is not None else "") or "local-owner"
        board = store.create_board(
            conn,
            owner=owner,
            name=board_name or f"Plan: {(objective or 'Objective')[:40]}",
            description=objective,
            project_id=project_id,
        )
        if acting_teammate_id:
            mate = store.get_teammate(conn, acting_teammate_id)
            if mate is not None and mate.project_id == project_id:
                # Membership is convenience; the board row is canonical.
                with contextlib.suppress(KeyError, ValueError):
                    store.create_board_member(
                        conn, board_id=board.id, teammate_id=mate.id
                    )
    elif attach_board_id is not None:
        board = store.get_board(conn, attach_board_id)
        if board is None or board.project_id != project_id:
            raise ValueError(
                f"attach_board_id {attach_board_id!r} is not a board in this project"
            )

    index_to_task_id: dict[int, str] = {}
    created: list[Task] = []
    for idx, subtask in enumerate(plan.tasks):
        dep_ids = [index_to_task_id[d] for d in subtask.depends_on if d in index_to_task_id]
        # The exact plan the reviewer saw is what materializes: a step that
        # names a teammate is created owned by that teammate. Steps that do
        # not name one stay with the acting bot (or unowned when a human
        # applies the plan, so the executor may claim them).
        step_owner = subtask.owner_teammate_id.strip() or acting_teammate_id
        task = store.create_task(
            conn,
            project_id=project_id,
            description=subtask.description,
            command=subtask.command,
            dependencies=dep_ids,
            owner_teammate_id=step_owner or None,
            board_id=board.id if board else "",
        )
        index_to_task_id[idx] = task.id
        created.append(task)

    return {
        "board": board.model_dump(mode="json") if board else None,
        "tasks": [t.model_dump(mode="json") for t in created],
        "plan": plan.model_dump(),
    }


def decompose_objective(
    conn: sqlite3.Connection,
    project_id: str,
    objective: str,
    provider: Provider,
    *,
    board_name: str | None = None,
    create_board: bool = True,
    acting_teammate_id: str | None = None,
) -> dict[str, Any]:
    """Ask the provider to decompose ``objective`` into subtasks, then create
    a board and tasks for them. Returns the board, tasks, and raw plan.

    The plan is validated against live project state before anything is
    created: an invalid (or stale-facts) plan is rejected whole.
    """
    plan = plan_objective(conn, project_id, objective, provider)
    known = {
        m.id
        for m in store.list_all_teammates(conn)
        if m.project_id == project_id and m.status == TeammateStatus.ACTIVE
    }
    problems = validate_plan(
        plan,
        project_id=project_id,
        acting_teammate_id=acting_teammate_id or "",
        known_teammate_ids=known,
    )
    if problems:
        raise ValueError(f"plan rejected: {'; '.join(problems)}")
    return materialize_plan(
        conn,
        project_id,
        plan,
        objective=objective,
        board_name=board_name,
        create_board=create_board,
        acting_teammate_id=acting_teammate_id,
    )
