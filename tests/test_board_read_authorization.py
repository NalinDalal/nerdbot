"""Board read authorization: declared permission, enforced permission, scope.

Regression suite for the ``board.read`` gap: the permission was declared in
``gates.PERMISSION_ONLY`` and in ``app_tools.TOOL_PERMISSIONS`` but no code
path consumed it, so board reads by a bot were neither offered nor enforced.

The rules under test:

- declaring a permission is not enforcing it;
- enforcement happens in the backend execution path, not in the schema;
- holding the permission is not enough — the board must also be inside the
  bot's authorized resource scope (own project + board membership);
- an unknown board id must never surface another resource's data;
- a missing or invalid acting identity fails closed.
"""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from nerdbot import app_tools, boards, gates, store
from nerdbot.agent_context import AgentContext
from nerdbot.api import create_app
from nerdbot.models import Decision, ProviderKind, TeammateStatus

TOKEN = "board-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ACTING = "X-Acting-Teammate"


# -- fixtures / helpers -------------------------------------------------------


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "board.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "r"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _teammate(
    client: TestClient, project_id: str, persona: str = "bot", **extra
) -> str:
    body = {"persona": persona, "instructions": "i", "capabilities": ["code"]}
    body.update(extra)
    r = client.post(
        f"/projects/{project_id}/teammates", json=body, headers=AUTH
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _ctx(
    conn: sqlite3.Connection, task_id: str, mate_id: str | None
) -> AgentContext:
    task = store.get_task(conn, task_id)
    assert task is not None
    mate = store.get_teammate(conn, mate_id) if mate_id else None
    return AgentContext(
        conn=conn,
        task=task,
        project=None,
        teammate=mate,
        system_message="",
        allowed_permissions=frozenset(mate.permissions) if mate else frozenset(),
    )


def _board(
    conn: sqlite3.Connection,
    project_id: str,
    owner: str = "local-owner",
    name: str = "b",
) -> str:
    board = store.create_board(conn, owner=owner, name=name, project_id=project_id)
    return board.id


# -- 1. declared != enforced ---------------------------------------------------


def test_board_read_permission_is_declared_and_enforced() -> None:
    """The permission exists in the gate registry and is bound to the tool."""
    assert "board.read" in gates.PERMISSION_ONLY
    assert app_tools.TOOL_PERMISSIONS["read_board"] == "board.read"
    # The schema filter is permission-driven: no board.read, no read_board.
    names = {t["function"]["name"] for t in app_tools.app_tool_schemas(set())}
    assert "read_board" not in names
    names = {t["function"]["name"] for t in app_tools.app_tool_schemas({"board.read"})}
    assert "read_board" in names


def test_bot_without_board_read_cannot_read_a_board() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="blind")
    board_id = _board(conn, project.id)
    store.create_board_member(conn, board_id, mate.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert "board.read" in out, out
    conn.close()


def test_bot_with_board_read_can_read_an_authorized_board() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="reader", permissions=["board.read"]
    )
    board_id = _board(conn, project.id, name="Shared")
    store.create_board_member(conn, board_id, mate.id)
    store.create_board_message(
        conn, board_id, "hello from the feed", from_teammate_id=None
    )
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" not in out, out
    assert board_id in out
    assert "Shared" in out
    assert "hello from the feed" in out
    conn.close()


def test_bot_with_board_read_cannot_read_an_unauthorized_board() -> None:
    """Permission granted, board outside scope: still denied."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="reader", permissions=["board.read"]
    )
    # A board the bot is not a member of.
    board_id = _board(conn, project.id, name="NotMine")
    # A board in another workspace entirely.
    foreign_id = _board(conn, other.id, name="Foreign")
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert "NotMine" not in out

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": foreign_id})
    assert "permission denied" in out, out
    assert "Foreign" not in out
    conn.close()


def test_unknown_board_id_does_not_expose_another_resource() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="reader", permissions=["board.read"]
    )
    real_id = _board(conn, project.id, name="Secret")
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": "brd_nope"})
    assert "not found" in out, out
    assert real_id not in out
    assert "Secret" not in out
    conn.close()


# -- 2. missing / invalid acting identity --------------------------------------


def test_missing_acting_identity_is_rejected() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="reader", permissions=["board.read"]
    )
    board_id = _board(conn, project.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, None)
    ctx.teammate = None

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert board_id not in out
    conn.close()


def test_unknown_acting_identity_is_rejected() -> None:
    """A fabricated identity is not trusted: it must exist in the store."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="reader", permissions=["board.read"]
    )
    board_id = _board(conn, project.id)
    store.create_board_member(conn, board_id, mate.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    # Same shape, but the identity does not exist in the store.
    ghost = mate.model_copy(update={"id": "tm_ghost", "permissions": ["board.read"]})
    ctx.teammate = ghost
    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert "does not exist" in out, out
    conn.close()


def test_archived_acting_identity_is_rejected() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="reader", permissions=["board.read"]
    )
    board_id = _board(conn, project.id)
    store.create_board_member(conn, board_id, mate.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    conn.execute(
        "UPDATE teammates SET status = ? WHERE id = ?",
        (TeammateStatus.ARCHIVED.value, mate.id),
    )
    conn.commit()
    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert "not active" in out, out
    conn.close()


def test_identity_from_another_project_is_rejected() -> None:
    """A context carrying a teammate from another workspace is denied."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    owner = store.create_teammate(
        conn, project.id, persona="owner", permissions=["board.read"]
    )
    stranger = store.create_teammate(
        conn, other.id, persona="stranger", permissions=["board.read"]
    )
    board_id = _board(conn, project.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=owner.id)
    ctx = _ctx(conn, task.id, owner.id)
    # Swap in an identity from a different workspace.
    ctx.teammate = stranger

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert "another project" in out, out
    conn.close()


def test_identity_that_does_not_own_the_task_is_rejected() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    owner = store.create_teammate(
        conn, project.id, persona="owner", permissions=["board.read"]
    )
    other = store.create_teammate(
        conn, project.id, persona="other", permissions=["board.read"]
    )
    board_id = _board(conn, project.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=owner.id)
    ctx = _ctx(conn, task.id, owner.id)
    # Same project, but this identity is not the task's owner.
    ctx.teammate = other

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out
    assert "does not own task" in out, out
    conn.close()


# -- 3. direct invocation cannot bypass the gate -------------------------------


def test_direct_tool_invocation_cannot_bypass_the_permission_check() -> None:
    """Calling the tool by hand is not a way around the gate."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(conn, project.id, persona="blind")
    board_id = _board(conn, project.id)
    store.create_board_member(conn, board_id, mate.id)
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board_id})
    assert "permission denied" in out, out

    # The service layer refuses too, even when handed a teammate directly.
    with pytest.raises(Exception) as excinfo:
        boards.read_board_service(conn, board_id, acting=mate)
    assert "403" in str(excinfo.value)
    conn.close()


def test_board_read_tool_is_not_in_the_ambient_set() -> None:
    """read_board must never be reachable without the permission."""
    assert "read_board" not in app_tools.AMBIENT_TOOLS
    assert app_tools.TOOL_PERMISSIONS["read_board"] == "board.read"


# -- 4. legitimate workflows keep working --------------------------------------


def test_human_owner_board_read_is_never_gated() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    board_id = _board(conn, project.id, name="HumanBoard")
    detail = boards.read_board_service(conn, board_id, acting=None)
    assert detail["board"]["name"] == "HumanBoard"
    conn.close()


def test_bot_created_board_stays_visible_and_readable() -> None:
    """A bot that creates a board can read it and the owner still sees it."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="builder", permissions=["board.create", "board.read"]
    )
    board = boards.create_board_service(
        conn,
        owner=mate.id,
        name="AgentBoard",
        project_id=project.id,
        acting=mate,
    )
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)
    out = app_tools.execute_app_tool(ctx, "read_board", {"board_id": board.id})
    assert "permission denied" not in out, out
    assert "AgentBoard" in out
    # Owned by the human principal, so it stays in the owner's board list.
    assert board.owner == project.owner
    listed = boards.list_boards_for_actor(
        conn, owner=project.owner, project_id=project.id, acting=mate
    )
    assert board.id in [b.id for b in listed]
    conn.close()


def test_api_board_read_for_acting_bot(app_client) -> None:
    pid = _project(app_client)
    reader = _teammate(app_client, pid, persona="reader", permissions=["board.read"])
    blind = _teammate(app_client, pid, persona="blind")
    board = app_client.post(
        "/boards", json={"name": "shared", "project_id": pid}, headers=AUTH
    ).json()
    app_client.post(
        f"/boards/{board['id']}/members",
        json={"teammate_id": reader},
        headers=AUTH,
    )

    r = app_client.get(f"/boards/{board['id']}", headers={**AUTH, ACTING: reader})
    assert r.status_code == 200, r.text
    assert r.json()["board"]["name"] == "shared"

    # Without the permission: denied.
    r = app_client.get(f"/boards/{board['id']}", headers={**AUTH, ACTING: blind})
    assert r.status_code == 403, r.text

    # Owner path: never gated.
    r = app_client.get(f"/boards/{board['id']}", headers=AUTH)
    assert r.status_code == 200, r.text


def test_api_board_listing_requires_board_read_for_bots(app_client) -> None:
    pid = _project(app_client)
    reader = _teammate(app_client, pid, persona="reader", permissions=["board.read"])
    blind = _teammate(app_client, pid, persona="blind")
    board = app_client.post(
        "/boards", json={"name": "shared", "project_id": pid}, headers=AUTH
    ).json()
    app_client.post(
        f"/boards/{board['id']}/members",
        json={"teammate_id": reader},
        headers=AUTH,
    )
    app_client.post(
        f"/boards/{board['id']}/members",
        json={"teammate_id": blind},
        headers=AUTH,
    )

    r = app_client.get("/boards", headers={**AUTH, ACTING: reader})
    assert r.status_code == 200, r.text
    assert [b["id"] for b in r.json()["boards"]] == [board["id"]]

    r = app_client.get("/boards", headers={**AUTH, ACTING: blind})
    assert r.status_code == 403, r.text


# -- 5. related enforcement gaps fixed in the same pass ------------------------


def test_send_message_cannot_target_another_project() -> None:
    """A bot-supplied target board is validated, not trusted."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="bot", permissions=["message.send"]
    )
    board_id = _board(conn, project.id, name="mine")
    foreign_id = _board(conn, other.id, name="theirs")
    task = store.create_task(
        conn, project.id, "t", owner_teammate_id=mate.id, board_id=board_id
    )
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(
        ctx, "send_message", {"content": "hi", "to_board_id": foreign_id}
    )
    assert "permission denied" in out, out
    # Nothing was written to the foreign board's feed.
    assert store.list_board_messages(conn, foreign_id) == []

    # The same-project target still works.
    other_board = _board(conn, project.id, name="sibling")
    out = app_tools.execute_app_tool(
        ctx, "send_message", {"content": "hi", "to_board_id": other_board}
    )
    assert "sent message" in out, out
    conn.close()


def test_send_message_cannot_address_another_projects_teammate() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn, project.id, persona="bot", permissions=["message.send"]
    )
    stranger = store.create_teammate(conn, other.id, persona="stranger")
    board_id = _board(conn, project.id)
    task = store.create_task(
        conn, project.id, "t", owner_teammate_id=mate.id, board_id=board_id
    )
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(
        ctx, "send_message", {"content": "hi", "to_teammate_id": stranger.id}
    )
    assert "permission denied" in out, out
    conn.close()


def test_delete_board_cannot_cross_workspace() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    mate = store.create_teammate(
        conn,
        project.id,
        persona="ops",
        permissions=["board.delete"],
    )
    mate = store.update_teammate(
        conn, mate.id, tool_policy={"board.delete": "auto"}
    )
    foreign = _board(conn, other.id, name="Foreign")
    task = store.create_task(conn, project.id, "t", owner_teammate_id=mate.id)
    ctx = _ctx(conn, task.id, mate.id)

    out = app_tools.execute_app_tool(ctx, "delete_board", {"board_id": foreign})
    assert "permission denied" in out, out
    assert store.get_board(conn, foreign) is not None
    conn.close()


def test_team_membership_cannot_cross_workspace() -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    other = store.create_project(conn, owner="local-owner")
    actor = store.create_teammate(
        conn, project.id, persona="boss", permissions=["team.membership"]
    )
    stranger = store.create_teammate(conn, other.id, persona="stranger")
    team = store.create_team(conn, owner=project.owner, name="squad")
    task = store.create_task(conn, project.id, "t", owner_teammate_id=actor.id)
    ctx = _ctx(conn, task.id, actor.id)

    out = app_tools.execute_app_tool(
        ctx,
        "add_teammate_to_team",
        {"team_id": team.id, "teammate_id": stranger.id},
    )
    assert "permission denied" in out, out
    assert store.list_teammates_for_team(conn, team.id) == []
    conn.close()


# -- 7. bot-management privilege escalation ------------------------------------


def test_bot_cannot_grant_a_permission_it_lacks() -> None:
    """Escalation is refused outright: no approval can authorize it."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    boss = store.create_teammate(
        conn,
        project.id,
        persona="boss",
        permissions=["teammate.update", "permission.change"],
    )
    victim = store.create_teammate(conn, project.id, persona="victim")
    store.create_task(conn, project.id, "t", owner_teammate_id=boss.id)

    # The HTTP path (the tool only forwards persona/instructions).
    from nerdbot import fleet

    with pytest.raises(Exception) as excinfo:
        fleet.update_teammate_service(
            conn,
            victim.id,
            {"permissions": ["board.delete"]},
            acting=boss,
        )
    assert "403" in str(excinfo.value)
    assert "cannot grant permissions" in str(excinfo.value)
    assert store.get_teammate(conn, victim.id).permissions == []
    conn.close()


def test_bot_cannot_auto_approve_a_permission_it_lacks() -> None:
    """tool_policy keys count as holding the permission — so writing one is
    an escalation and must be refused."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    boss = store.create_teammate(
        conn,
        project.id,
        persona="boss",
        permissions=["teammate.update", "permission.change"],
    )
    store.create_task(conn, project.id, "t", owner_teammate_id=boss.id)

    from nerdbot import fleet

    with pytest.raises(Exception) as excinfo:
        fleet.update_teammate_service(
            conn,
            boss.id,
            {"tool_policy": {"board.delete": "auto"}},
            acting=boss,
        )
    assert "403" in str(excinfo.value)
    assert store.get_teammate(conn, boss.id).tool_policy == {}
    conn.close()


def test_approval_is_bound_to_the_exact_permission_change() -> None:
    """Approving one permission set must not authorize a different one."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    boss = store.create_teammate(
        conn,
        project.id,
        persona="boss",
        permissions=[
            "teammate.update",
            "permission.change",
            "task.create",
            "memory.write",
        ],
    )
    victim = store.create_teammate(conn, project.id, persona="victim")
    store.create_task(conn, project.id, "t", owner_teammate_id=boss.id)

    from nerdbot import fleet

    # First attempt: approval required (both gates raise).
    with pytest.raises(Exception) as excinfo:
        fleet.update_teammate_service(
            conn, victim.id, {"permissions": ["task.create"]}, acting=boss
        )
    assert "409" in str(excinfo.value)

    approvals = store.list_approvals_for_project(conn, project.id)
    assert approvals, "an approval must be raised"
    # Both gates (teammate.update and permission.change) are decided in one go.
    assert {a.action for a in approvals} == {"teammate.update", "permission.change"}
    for approval in approvals:
        store.decide_approval(conn, approval.id, Decision.APPROVED)

    # The same exact change now proceeds.
    updated = fleet.update_teammate_service(
        conn, victim.id, {"permissions": ["task.create"]}, acting=boss
    )
    assert updated.permissions == ["task.create"]

    # A different permission set is a different digest: still gated.
    with pytest.raises(Exception) as excinfo:
        fleet.update_teammate_service(
            conn, victim.id, {"permissions": ["task.create", "memory.write"]},
            acting=boss,
        )
    assert "409" in str(excinfo.value)
    conn.close()


def test_create_teammate_can_attach_a_provider() -> None:
    """A spawned bot can be given a model, so it can actually work."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    provider = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    task = store.create_task(conn, project.id, "spawn", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, task.id, ceo.id)

    out = app_tools.execute_app_tool(
        ctx,
        "create_teammate",
        {"persona": "engineer", "permissions": [], "provider_id": provider.id},
    )
    assert "APPROVAL REQUIRED" in out, out

    for approval in store.list_approvals_for_project(conn, project.id):
        store.decide_approval(conn, approval.id, Decision.APPROVED)

    out = app_tools.execute_app_tool(
        ctx,
        "create_teammate",
        {"persona": "engineer", "permissions": [], "provider_id": provider.id},
    )
    assert "created teammate" in out, out
    assert provider.id in out, out
    mates = store.list_teammates(conn, project.id)
    engineer = next(m for m in mates if m.persona == "engineer")
    assert engineer.provider_id == provider.id
    conn.close()


def test_create_teammate_approval_binds_the_provider() -> None:
    """Approving "spawn with provider A" must not authorize provider B."""
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="local-owner")
    provider_a = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    provider_b = store.create_provider(conn, project.id, kind=ProviderKind.MOCK)
    ceo = store.create_teammate(
        conn, project.id, persona="ceo", permissions=["teammate.create"]
    )
    task = store.create_task(conn, project.id, "spawn", owner_teammate_id=ceo.id)
    ctx = _ctx(conn, task.id, ceo.id)

    out = app_tools.execute_app_tool(
        ctx,
        "create_teammate",
        {"persona": "engineer", "permissions": [], "provider_id": provider_a.id},
    )
    assert "APPROVAL REQUIRED" in out, out
    for approval in store.list_approvals_for_project(conn, project.id):
        store.decide_approval(conn, approval.id, Decision.APPROVED)

    # Same persona, different provider: a different digest, still gated.
    out = app_tools.execute_app_tool(
        ctx,
        "create_teammate",
        {"persona": "engineer", "permissions": [], "provider_id": provider_b.id},
    )
    assert "APPROVAL REQUIRED" in out, out
    conn.close()


# -- 6. end-to-end: a model-driven bot actually calls the tool -----------------


def test_model_driven_bot_reads_a_board_through_the_real_agent_loop(
    app_client, monkeypatch
) -> None:
    """The tool is offered to a permitted bot and denied to an unpermitted one."""
    import json

    import httpx

    from nerdbot import providers as providers_mod

    pid = _project(app_client)
    provider = app_client.post(
        f"/projects/{pid}/providers",
        json={
            "name": "mock",
            "kind": "openai-compatible",
            "config": {
                "base_url": "https://provider.example/v1",
                "model": "e2e-model",
                "api_key": "sk-test",
            },
        },
        headers=AUTH,
    ).json()
    board = app_client.post(
        "/boards", json={"name": "SharedBoard", "project_id": pid}, headers=AUTH
    ).json()
    app_client.post(
        f"/boards/{board['id']}/messages",
        json={"content": "roadmap: ship the thing"},
        headers=AUTH,
    )

    reader = _teammate(
        app_client,
        pid,
        persona="reader",
        permissions=["board.read"],
        provider_id=provider["id"],
    )
    blind = _teammate(
        app_client, pid, persona="blind", provider_id=provider["id"]
    )
    for mate_id in (reader, blind):
        app_client.post(
            f"/boards/{board['id']}/members",
            json={"teammate_id": mate_id},
            headers=AUTH,
        )

    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "r1",
                                        "type": "function",
                                        "function": {
                                            "name": "read_board",
                                            "arguments": json.dumps(
                                                {"board_id": board["id"]}
                                            ),
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                },
            )
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": "done"}}]},
        )

    transport = httpx.MockTransport(handler)
    real_init = providers_mod.OpenAICompatibleAdapter.__init__
    real_exec = providers_mod.OpenAICompatibleAdapter._execute_one
    tool_results: list[tuple[str, str]] = []

    def patched_init(self, config, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = transport
        real_init(self, config, **kwargs)

    def capture_exec(self, workspace, name, arguments, context):  # type: ignore[no-untyped-def]
        result = real_exec(self, workspace, name, arguments, context)
        tool_results.append((name, result))
        return result

    monkeypatch.setattr(
        providers_mod.OpenAICompatibleAdapter, "__init__", patched_init
    )
    monkeypatch.setattr(
        providers_mod.OpenAICompatibleAdapter, "_execute_one", capture_exec
    )

    # The permitted bot is offered the tool and reads the board.
    task = app_client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "read the board",
            "command": "read the board",
            "owner_teammate_id": reader,
        },
        headers=AUTH,
    ).json()
    run = app_client.post(f"/tasks/{task['id']}/runs", json={}, headers=AUTH).json()
    assert run["run"]["status"] == "succeeded", run
    assert any(
        t["function"]["name"] == "read_board"
        for t in calls[0].get("tools", [])
    ), "read_board must be offered to a bot holding board.read"
    read_results = [r for name, r in tool_results if name == "read_board"]
    assert read_results, "the bot must actually invoke read_board"
    assert "SharedBoard" in read_results[0]
    assert "roadmap: ship the thing" in read_results[0]

    # The unpermitted bot is never offered the tool.
    calls.clear()
    task2 = app_client.post(
        f"/projects/{pid}/tasks",
        json={
            "description": "read the board",
            "command": "read the board",
            "owner_teammate_id": blind,
        },
        headers=AUTH,
    ).json()
    app_client.post(f"/tasks/{task2['id']}/runs", json={}, headers=AUTH)
    offered = {t["function"]["name"] for t in calls[0].get("tools", [])}
    assert "read_board" not in offered, "read_board must not be offered without board.read"
