"""A bot's face: the owner's choice, stored, validated and drawn.

Covers the four things that can go wrong with a face:

- it is chosen when the bot is set up, and it comes back on the bot;
- a bot set up without one still has a face (the default), so the dashboard
  never has to invent one;
- a face the catalogue does not know is refused with a 400, instead of being
  stored and silently replaced by the default at render time;
- it survives a backup round trip.

And one thing that can go wrong between the two halves of the product: the
server's catalogue of ids and the dashboard's must be the SAME list. A shape
added on one side and not the other would be a face the API accepts and the
dashboard cannot draw — the worst kind of quiet failure. The drift test at
the bottom reads the dashboard's TypeScript source and compares.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nerdbot import faces as faces_mod
from nerdbot import store
from nerdbot.api import create_app

TOKEN = "face-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

REPO = Path(__file__).resolve().parents[1]
DASHBOARD_BOT = REPO / "dashboard" / "src" / "bot"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_SECRET_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "faces.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "r"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _ids_in_type_alias(source: str, alias: str) -> list[str]:
    """The string literals of a TypeScript union type alias."""
    match = re.search(
        rf"export type {alias}\s*=\s*((?:\s*\|\s*\"[^\"]+\"\s*)+);",
        source,
        re.S,
    )
    assert match, f"no union type alias {alias} found"
    return re.findall(r'"([^"]+)"', match.group(1))


# -- the API surface --------------------------------------------------------


def test_a_bot_is_created_with_the_face_its_owner_picked(client: TestClient) -> None:
    project = _project(client)
    face = {"shape": "goutte", "color": "bleu", "expression": "curieux"}
    r = client.post(
        f"/projects/{project}/teammates",
        json={"persona": "engineer", "face": face},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert r.json()["face"] == face


def test_a_bot_set_up_without_a_face_still_has_one(client: TestClient) -> None:
    project = _project(client)
    r = client.post(f"/projects/{project}/teammates", json={"persona": "b"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["face"] == faces_mod.default_face()


def test_the_face_is_changed_afterwards(client: TestClient) -> None:
    project = _project(client)
    created = client.post(
        f"/projects/{project}/teammates", json={"persona": "b"}, headers=AUTH
    ).json()
    face = {"shape": "nuage", "color": "vert", "expression": "fier"}
    r = client.patch(f"/teammates/{created['id']}", json={"face": face}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["face"] == face
    # and it is the one that comes back on the next read
    again = client.get(f"/teammates/{created['id']}", headers=AUTH)
    assert again.json()["face"] == face


def test_a_face_the_catalogue_does_not_know_is_refused(client: TestClient) -> None:
    project = _project(client)
    r = client.post(
        f"/projects/{project}/teammates",
        json={
            "persona": "b",
            "face": {"shape": "triangle", "color": "bleu", "expression": "pas-une-expression"},
        },
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "expression" in r.json()["detail"]


def test_a_partial_face_is_refused(client: TestClient) -> None:
    """A half face is not a face: defaulting the missing half here would
    make the stored value depend on which fields the caller happened to
    send."""
    project = _project(client)
    r = client.post(
        f"/projects/{project}/teammates",
        json={"persona": "b", "face": {"shape": "triangle", "color": "bleu"}},
        headers=AUTH,
    )
    assert r.status_code == 400, r.text
    assert "expression" in r.json()["detail"]


def test_a_face_with_an_unknown_field_is_refused(client: TestClient) -> None:
    project = _project(client)
    r = client.post(
        f"/projects/{project}/teammates",
        json={
            "persona": "b",
            "face": {
                "shape": "triangle",
                "color": "bleu",
                "expression": "neutre",
                "horns": 3,
            },
        },
        headers=AUTH,
    )
    assert r.status_code == 400, r.text


def test_the_face_survives_a_backup_round_trip(client: TestClient) -> None:
    project = _project(client)
    face = {"shape": "capsule", "color": "ambre", "expression": "attentif"}
    client.post(
        f"/projects/{project}/teammates",
        json={"persona": "b", "face": face},
        headers=AUTH,
    )
    export = client.get(f"/projects/{project}/backup", headers=AUTH)
    assert export.status_code == 200, export.text
    payload = export.json()
    rows = payload["tables"]["teammates"]
    # The JSON columns travel as their stored form, like capabilities and
    # permissions do; the import parses them back.
    assert json.loads(rows[0]["face"]) == face


# -- the store --------------------------------------------------------------


def test_a_row_written_before_faces_existed_reads_as_the_default(
    tmp_path, monkeypatch
) -> None:
    """A database created by an older schema has no face column value: the
    bot still gets a face, so the dashboard always has one to draw."""
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "legacy.db"))
    conn = store.connect(tmp_path / "legacy.db")
    try:
        project = store.create_project(conn, "local-owner", "legacy")
        mate = store.create_teammate(conn, project.id, persona="old")
        conn.execute("UPDATE teammates SET face = '' WHERE id = ?", (mate.id,))
        conn.commit()
        again = store.get_teammate(conn, mate.id)
        assert again is not None
        assert again.face.model_dump(mode="json") == faces_mod.default_face()
    finally:
        conn.close()


def test_a_face_that_stopped_being_drawable_reads_as_the_default(tmp_path) -> None:
    """A face the catalogue no longer knows is a face nobody can draw: the
    default is the honest answer, not a broken avatar."""
    conn = store.connect(tmp_path / "store.db")
    try:
        project = store.create_project(conn, "local-owner", "r")
        mate = store.create_teammate(
            conn,
            project.id,
            persona="b",
            face={"shape": "triangle", "color": "bleu", "expression": "neutre"},
        )
        conn.execute(
            "UPDATE teammates SET face = ? WHERE id = ?",
            ('{"shape": "shape-qui-nexiste-pas", "color": "bleu", "expression": "neutre"}', mate.id),
        )
        conn.commit()
        again = store.get_teammate(conn, mate.id)
        assert again is not None
        assert again.face.model_dump(mode="json") == faces_mod.default_face()
    finally:
        conn.close()


# -- the catalogue ----------------------------------------------------------


def test_the_catalogue_refuses_what_it_does_not_know() -> None:
    assert faces_mod.validate_face(
        {"shape": "cercle", "color": "encre", "expression": "neutre"}
    ) == {"shape": "cercle", "color": "encre", "expression": "neutre"}
    with pytest.raises(faces_mod.FaceError):
        faces_mod.validate_face({"shape": "cercle", "color": "encre"})
    with pytest.raises(faces_mod.FaceError):
        faces_mod.validate_face({"shape": "cercle", "color": "encre", "expression": 7})
    with pytest.raises(faces_mod.FaceError):
        faces_mod.validate_face("triangle")


def test_the_server_and_the_dashboard_speak_the_same_catalogue() -> None:
    """The ids the server accepts and the ids the dashboard can draw are
    the same list.

    The dashboard owns the geometry, so its TypeScript source is the source
    of truth for the vocabulary; the server keeps a copy so the API can
    refuse a face nobody can draw. This test is what makes that copy safe:
    a shape added on one side and forgotten on the other fails here instead
    of failing silently in the product.
    """
    skins = (DASHBOARD_BOT / "skins.ts").read_text(encoding="utf-8")
    expressions = (DASHBOARD_BOT / "expressions.ts").read_text(encoding="utf-8")

    assert _ids_in_type_alias(skins, "ShapeId") == list(faces_mod.SHAPE_IDS)
    assert _ids_in_type_alias(skins, "ColorId") == list(faces_mod.COLOR_IDS)
    assert _ids_in_type_alias(expressions, "ExpressionId") == list(faces_mod.EXPRESSION_IDS)


def test_the_default_face_is_the_one_the_dashboard_uses() -> None:
    """The default the server stores and the default the dashboard falls
    back to are the same face, so a bot nobody has dressed yet looks the
    same on both sides."""
    skins = (DASHBOARD_BOT / "skins.ts").read_text(encoding="utf-8")
    expressions = (DASHBOARD_BOT / "expressions.ts").read_text(encoding="utf-8")

    def constant(source: str, name: str) -> str:
        match = re.search(rf'export const {name}\s*=\s*"([^"]+)"', source)
        assert match, f"no constant {name} found"
        return match.group(1)

    assert constant(skins, "DEFAULT_SHAPE") == faces_mod.DEFAULT_SHAPE
    assert constant(skins, "DEFAULT_COLOR") == faces_mod.DEFAULT_COLOR
    assert constant(expressions, "DEFAULT_EXPRESSION") == faces_mod.DEFAULT_EXPRESSION
