"""Central autonomy policy evaluator.

This module is intentionally small and deterministic. LLM output never overrides
it; callers must evaluate actions immediately before execution.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from . import permissions as permissions_mod

Outcome = Literal["allow", "require_approval", "require_input", "deny", "defer", "escalate"]
Risk = Literal["low", "medium", "high", "critical"]


@dataclass(frozen=True)
class AutonomyDecision:
    action: str
    outcome: Outcome
    risk: Risk
    reason: str


_ACTION_RISK: dict[str, Risk] = {
    "task.create": "medium",
    "task.assign": "medium",
    "task.delegate": "medium",
    "board.create": "medium",
    "board.message": "medium",
    "board.read": "low",
    "memory.write": "medium",
    "knowledge.read": "low",
    "knowledge.write": "medium",
    "workspace.read": "low",
    "workspace.write": "medium",
    "workspace.exec": "medium",
    "web.search": "low",
    "message.send": "medium",
    "teammate.create": "high",
    "teammate.update": "high",
    "teammate.delete": "high",
    "team.create": "high",
    "team.membership": "high",
    "board.delete": "high",
    "permission.change": "critical",
    "email.send": "high",
    "social.post": "high",
    "social.dm": "high",
    "github.comment": "high",
    "cms.publish": "high",
    "form.submit": "high",
    "payment.make": "critical",
}


def evaluate_action(
    *,
    action: str,
    actor: str,
    has_permission: bool,
    agent_paused: bool = False,
    approval_granted: bool = False,
    budget_exhausted: bool = False,
) -> AutonomyDecision:
    """Evaluate an action deterministically. Fail closed."""
    if agent_paused:
        return AutonomyDecision(action, "defer", _ACTION_RISK.get(action, "medium"), "agent is paused")
    if budget_exhausted:
        return AutonomyDecision(action, "defer", _ACTION_RISK.get(action, "medium"), "action budget exhausted")
    if action not in permissions_mod.ALL_PERMISSIONS:
        return AutonomyDecision(action, "deny", "high", "unknown action")
    if not has_permission and actor != "human":
        return AutonomyDecision(action, "deny", _ACTION_RISK[action], "missing permission")

    risk = _ACTION_RISK[action]
    if action in permissions_mod.EXTERNAL_PERMISSIONS:
        if approval_granted:
            return AutonomyDecision(action, "allow", risk, "external action approved")
        return AutonomyDecision(action, "require_approval", risk, "external action requires approval")
    if action in permissions_mod.ADMIN_PERMISSIONS:
        if approval_granted:
            return AutonomyDecision(action, "allow", risk, "admin action approved")
        return AutonomyDecision(action, "require_approval", risk, "admin action requires approval")
    return AutonomyDecision(action, "allow", risk, "permitted agent action")
