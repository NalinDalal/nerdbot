"""Chat threads: CRUD, paging, streaming parity, caps, fail-closed, isolation."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from nerdbot import chat as chat_mod
from nerdbot import store
from nerdbot.api import create_app
from nerdbot.models import ProviderKind

TOKEN = "chat-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "chat.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _project(client: TestClient) -> str:
    r = client.post("/projects", json={"repository": "c"}, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _thread(client: TestClient, pid: str, **kw) -> str:
    r = client.post(f"/projects/{pid}/threads", json=kw, headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mock_provider(client: TestClient, pid: str, name: str = "m") -> str:
    r = client.post(f"/projects/{pid}/providers", json={"kind": "mock", "name": name},
                    headers=AUTH)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_thread_crud_and_paging(app_client: TestClient) -> None:
    pid = _project(app_client)
    tid = _thread(app_client, pid, title="hello")
    r = app_client.get(f"/projects/{pid}/threads", headers=AUTH)
    assert [t["id"] for t in r.json()["threads"]] == [tid]
    for i in range(5):
        r = app_client.post(f"/threads/{tid}/messages",
                            json={"role": "user", "content": f"m{i}"}, headers=AUTH)
        assert r.status_code == 200, r.text
    view = app_client.get(f"/threads/{tid}?limit=2", headers=AUTH).json()
    assert [m["content"] for m in view["messages"]] == ["m3", "m4"]
    last_id = view["messages"][0]["id"]
    view = app_client.get(f"/threads/{tid}?limit=2&before={last_id}", headers=AUTH).json()
    assert [m["content"] for m in view["messages"]] == ["m1", "m2"]
    r = app_client.get(f"/threads/{tid}?limit=5000", headers=AUTH)
    assert len(r.json()["messages"]) == 5  # capped, not unbounded
    for bad in ({"role": "system-x", "content": "x"}, {"role": "user", "content": "  "}):
        r = app_client.post(f"/threads/{tid}/messages", json=bad, headers=AUTH)
        assert r.status_code == 400, r.text


def test_provider_switch_and_validation(app_client: TestClient) -> None:
    p1 = _project(app_client)
    p2 = _project(app_client)
    tid = _thread(app_client, p1)
    foreign = _mock_provider(app_client, p2)
    r = app_client.patch(f"/threads/{tid}", json={"provider_id": foreign}, headers=AUTH)
    assert r.status_code == 400, r.text
    own = _mock_provider(app_client, p1)
    r = app_client.patch(f"/threads/{tid}", json={"provider_id": own, "title": "t"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["provider_id"] == own and r.json()["title"] == "t"


def test_owner_isolation(app_client: TestClient) -> None:
    r = app_client.get("/threads/thr_nope", headers=AUTH)
    assert r.status_code == 404
    bad = {"Authorization": "Bearer wrong"}
    assert app_client.get("/projects/x/threads", headers=bad).status_code == 403
    assert app_client.post("/projects/x/threads", json={}, headers=bad).status_code == 403


def test_chat_fallback_mock_and_memory(app_client: TestClient) -> None:
    pid = _project(app_client)
    _mock_provider(app_client, pid)
    app_client.post(f"/projects/{pid}/memory",
                    json={"scope": "s", "content": "user likes tea", "source": "note",
                          "confidence": 0.9}, headers=AUTH)
    tid = _thread(app_client, pid)
    r = app_client.post(f"/threads/{tid}/chat", json={"content": "hi there"}, headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"]["role"] == "assistant"
    assert "hi there" in body["message"]["content"]
    assert body["memory_used"] == [
        {"id": body["memory_used"][0]["id"], "source": "note", "confidence": 0.9}]
    view = app_client.get(f"/threads/{tid}", headers=AUTH).json()
    assert [m["role"] for m in view["messages"]] == ["user", "assistant"]


def test_chat_fail_closed_no_provider(app_client: TestClient) -> None:
    pid = _project(app_client)
    tid = _thread(app_client, pid)
    r = app_client.post(f"/threads/{tid}/chat", json={"content": "hi"}, headers=AUTH)
    assert r.status_code == 400, r.text
    assert "no chat provider" in r.json()["detail"]


def test_chat_fail_closed_no_key(app_client: TestClient) -> None:
    pid = _project(app_client)
    r = app_client.post(f"/projects/{pid}/providers",
                        json={"kind": "openai-compatible", "name": "o",
                              "config": {"base_url": "https://x/v1", "model": "m"}},
                        headers=AUTH)
    assert r.status_code == 200, r.text
    tid = _thread(app_client, pid, provider_id=r.json()["id"])
    r = app_client.post(f"/threads/{tid}/chat", json={"content": "hi"}, headers=AUTH)
    assert r.status_code == 400, r.text
    assert "api_key" in r.json()["detail"]


def _sse_transport(chunks: list[str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        lines = "".join(f"data: {c}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, content=lines.encode(),
                              headers={"Content-Type": "text/event-stream"})

    return httpx.MockTransport(handler)


def test_stream_reassembly_matches_fallback(tmp_path) -> None:
    from nerdbot.models import Provider

    provider = Provider(id="prv_x", project_id="p", kind=ProviderKind.MOCK, name="m")
    messages = [{"role": "user", "content": "hello world"}]
    streamed = "".join(chat_mod.chat_stream(provider, messages))
    fallback = chat_mod.chat_complete(provider, messages)
    assert streamed == fallback


def test_sse_stream_assembles_deltas() -> None:
    from nerdbot.models import Provider

    chunks = ['{"choices": [{"delta": {"content": "Hel"}}]}',
              '{"choices": [{"delta": {"content": "lo"}}]}',
              '{"choices": [{"delta": {}}]}']
    provider = Provider(id="prv_x", project_id="p", kind=ProviderKind.OPENAI_COMPATIBLE,
                        name="o", config={"base_url": "https://x/v1", "model": "m",
                                          "api_key": "k"})
    messages = [{"role": "user", "content": "hi"}]
    assert "".join(chat_mod.chat_stream(provider, messages,
                                        transport=_sse_transport(chunks))) == "Hello"


def test_stream_paths_and_caps() -> None:
    from nerdbot.models import Provider

    provider = Provider(id="prv_x", project_id="p", kind=ProviderKind.MOCK, name="m")
    messages = [{"role": "user", "content": "x" * 100}]
    text = "".join(chat_mod.chat_stream(provider, messages, chunk_size=7))
    assert text == chat_mod.chat_complete(provider, messages)
    assert len(text) <= chat_mod.RESPONSE_MAX_CHARS
    with pytest.raises(chat_mod.ProviderConfigurationError):
        list(chat_mod.chat_stream(None, messages))
    with pytest.raises(chat_mod.ProviderConfigurationError):
        list(chat_mod.chat_stream(
            Provider(id="a", project_id="p", kind=ProviderKind.LOCAL, name="l"), messages))


def test_sse_error_mapping() -> None:
    from nerdbot.models import Provider

    def handler_401(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={})

    provider = Provider(id="prv_x", project_id="p", kind=ProviderKind.OPENAI_COMPATIBLE,
                        name="o", config={"base_url": "https://x/v1", "model": "m",
                                          "api_key": "k"})
    messages = [{"role": "user", "content": "hi"}]
    with pytest.raises(chat_mod.ProviderAuthenticationError):
        list(chat_mod.chat_stream(provider, messages,
                                  transport=httpx.MockTransport(handler_401)))

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow", request=request)

    with pytest.raises(chat_mod.ProviderTimeoutError):
        list(chat_mod.chat_stream(provider, messages, transport=httpx.MockTransport(slow)))


def test_memory_provenance_framed(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="o")
    store.write_memory(conn, f"project:{project.id}", "secret plan", source="note",
                       confidence=0.7)
    thread = store.create_thread(conn, project.id, title="t")
    messages, provenance = chat_mod.build_messages(conn, project.id, thread)
    assert provenance == [
        {"id": provenance[0]["id"], "source": "note", "confidence": 0.7}]
    system_text = " ".join(m["content"] for m in messages if m["role"] == "system")
    assert "UNTRUSTED" in system_text and "note" in system_text
    conn.close()


def test_history_window_bounded(tmp_path) -> None:
    conn = store.connect(":memory:")
    project = store.create_project(conn, owner="o")
    thread = store.create_thread(conn, project.id)
    for i in range(chat_mod.HISTORY_WINDOW + 10):
        store.append_message(conn, thread.id, "user", f"m{i}")
    messages, _ = chat_mod.build_messages(conn, project.id, thread)
    user_texts = [m["content"] for m in messages if m["role"] == "user"]
    assert len(user_texts) == chat_mod.HISTORY_WINDOW
    assert user_texts[0] == f"m{10}"
    conn.close()


def test_summarize_persists_and_recalls_across_threads(app_client: TestClient) -> None:
    pid = _project(app_client)
    _mock_provider(app_client, pid)
    first = _thread(app_client, pid, title="tea talk")
    app_client.post(f"/threads/{first}/messages",
                    json={"role": "user", "content": "i love green tea"}, headers=AUTH)
    r = app_client.post(f"/threads/{first}/summarize", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["summary"]  # provider-generated, non-empty
    second = _thread(app_client, pid, title="new topic")
    r = app_client.post(f"/threads/{second}/chat", json={"content": "what do I like?"},
                        headers=AUTH)
    assert r.status_code == 200, r.text
    cited = [m for m in r.json()["memory_used"] if m["source"] == "thread-summary"]
    assert len(cited) == 1 and cited[0]["id"] == first
    view = app_client.get(f"/threads/{second}", headers=AUTH).json()
    assert any(m["role"] == "assistant" for m in view["messages"])


def test_summarize_empty_thread_rejected(app_client: TestClient) -> None:
    pid = _project(app_client)
    _mock_provider(app_client, pid)
    tid = _thread(app_client, pid)
    r = app_client.post(f"/threads/{tid}/summarize", headers=AUTH)
    assert r.status_code == 400, r.text


def test_summary_migration_on_old_table(tmp_path) -> None:
    import sqlite3

    db = str(tmp_path / "oldchat.db")
    raw = sqlite3.connect(db)
    raw.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL,"
                " repository TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}')")
    raw.execute("INSERT INTO projects (id, owner) VALUES ('prj_1', 'o')")
    raw.execute("CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,"
                " title TEXT NOT NULL DEFAULT '', provider_id TEXT,"
                " created_at TEXT NOT NULL)")
    raw.execute("INSERT INTO chat_threads (id, project_id, title, created_at)"
                " VALUES ('thr_1', 'prj_1', 't', '2026-01-01T00:00:00+00:00')")
    raw.commit()
    raw.close()
    conn = store.connect(db)  # migration adds summary
    try:
        thread = store.get_thread(conn, "thr_1")
        assert thread is not None and thread.summary == ""
        updated = store.set_thread_summary(conn, "thr_1", "old topic")
        assert updated.summary == "old topic"
    finally:
        conn.close()
