from nerdbot.autonomy import AutonomyDecision, evaluate_action


def test_internal_read_allowed():
    d = evaluate_action(action="workspace.read", actor="agent", has_permission=True)
    assert d.outcome == "allow"
    assert d.risk == "low"


def test_missing_permission_denied():
    d = evaluate_action(action="workspace.write", actor="agent", has_permission=False)
    assert d.outcome == "deny"


def test_external_send_requires_approval():
    d = evaluate_action(action="email.send", actor="agent", has_permission=True)
    assert d.outcome == "require_approval"
    assert d.risk in {"high", "critical"}


def test_payment_requires_approval():
    d = evaluate_action(action="payment.make", actor="agent", has_permission=True)
    assert d.outcome == "require_approval"
    assert d.risk == "critical"


def test_permission_change_requires_approval():
    d = evaluate_action(action="permission.change", actor="agent", has_permission=True)
    assert d.outcome == "require_approval"


def test_paused_agent_defers():
    d = evaluate_action(action="workspace.read", actor="agent", has_permission=True, agent_paused=True)
    assert d.outcome == "defer"


def test_unknown_action_denied_fail_closed():
    d = evaluate_action(action="unknown.danger", actor="agent", has_permission=True)
    assert d.outcome == "deny"
