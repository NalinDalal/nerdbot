import pytest
from fastapi.testclient import TestClient

from nerdbot.api import create_app

TOKEN = "p4-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "p4.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    monkeypatch.delenv("NERDBOT_INSECURE_DEV_TOKEN", raising=False)
    app = create_app()
    with TestClient(app) as c:
        yield c


def _mk_project_doc(client):
    p = client.post("/projects", json={"repository": "repo"}, headers=AUTH).json()
    doc = client.post(
        f"/projects/{p['id']}/library",
        json={"title": "Doc", "content": "hello", "format": "md", "source": "test"},
        headers=AUTH,
    ).json()
    return p, doc


def test_library_autosave_conflict_and_versions(client):
    _p, doc = _mk_project_doc(client)
    r = client.patch(f"/library/{doc['id']}", json={"content": "v2", "expected_version": doc["version"]}, headers=AUTH)
    assert r.status_code == 200, r.text
    v2 = r.json()
    assert v2["version"] == doc["version"] + 1
    # stale expected_version -> 409 conflict
    r2 = client.patch(f"/library/{doc['id']}", json={"content": "stale", "expected_version": doc["version"]}, headers=AUTH)
    assert r2.status_code == 409, r2.text
    detail = r2.json().get("detail") or {}
    assert detail.get("conflict") is True
    vers = client.get(f"/library/{doc['id']}/versions", headers=AUTH).json()["versions"]
    assert len(vers) >= 2


def test_library_exports(client):
    _p, doc = _mk_project_doc(client)
    for fmt, ctype_sub in [("md", "text/markdown"), ("csv", "text/csv"), ("html", "text/html")]:
        r = client.get(f"/library/{doc['id']}/export", params={"format": fmt}, headers=AUTH)
        assert r.status_code == 200, r.text
        assert ctype_sub in r.headers.get("content-type", "")
        assert "attachment;" in r.headers.get("content-disposition", "")


def test_gallery_upload_list_content_delete(client):
    p = client.post("/projects", json={"repository": "repo"}, headers=AUTH).json()
    content = b"hello gallery"
    r = client.post(
        f"/projects/{p['id']}/gallery?filename=note.txt&mime_type=text/plain&source=chat",
        content=content,
        headers={**AUTH, "Content-Type": "text/plain"},
    )
    assert r.status_code == 200, r.text
    asset = r.json()
    assert asset["name"] == "note.txt"
    assert asset["size"] == len(content)
    assert (asset.get("metadata") or {}).get("storage_policy") == "project_gallery_v1"
    lst = client.get(f"/projects/{p['id']}/gallery", headers=AUTH).json()
    assert lst["total"] >= 1
    assert any(a["id"] == asset["id"] for a in lst["assets"])
    got = client.get(f"/gallery/{asset['id']}", headers=AUTH)
    assert got.status_code == 200
    raw = client.get(f"/gallery/{asset['id']}/content", headers=AUTH)
    assert raw.status_code == 200
    assert raw.content == content
    d = client.delete(f"/gallery/{asset['id']}", headers=AUTH)
    assert d.status_code == 200
    assert client.get(f"/gallery/{asset['id']}", headers=AUTH).status_code == 404
