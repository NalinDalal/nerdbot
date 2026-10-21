"""The served dashboard cannot pin a stale UI.

The API serves the built SPA: ``/`` is the entry document that names the
content-hashed bundles, and ``/assets/...`` are those bundles. Without
explicit cache headers the browser applied its own heuristics, which is how
a tab kept running the previous bundle after the server had already moved
on — the owner clicked "Approve once" on an approval the new code no longer
offered and got a 410 from an action the page should not have shown.

The rules: the entry document must be revalidated, the hashed bundles are
safe to cache forever.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from nerdbot.api import create_app

TOKEN = "spa-cache-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NERDBOT_TOKEN", TOKEN)
    monkeypatch.setenv("NERDBOT_DB", str(tmp_path / "spa.db"))
    monkeypatch.setenv("NERDBOT_DATA", str(tmp_path / "data"))
    return TestClient(create_app())


def _dist_index_html() -> str | None:
    from pathlib import Path

    dist = Path(__file__).resolve().parents[1] / "dashboard" / "dist" / "index.html"
    return dist.read_text() if dist.is_file() else None


def test_the_entry_document_is_revalidated(client) -> None:
    """A stale index.html must never be served from cache."""
    html = _dist_index_html()
    if html is None:
        pytest.skip("the dashboard is not built")
    r = client.get("/")
    assert r.status_code == 200, r.text
    cache = r.headers.get("cache-control", "")
    assert "no-cache" in cache or "no-store" in cache, (
        f"the entry document is cacheable: {cache!r}"
    )


def test_hashed_assets_are_cached_immutably(client) -> None:
    """A content-hashed bundle is safe to cache for a year."""
    html = _dist_index_html()
    if html is None:
        pytest.skip("the dashboard is not built")
    match = re.search(r'src="(/assets/[^"]+\.js)"', html)
    if match is None:
        pytest.skip("the built index.html names no bundle")
    r = client.get(match.group(1))
    assert r.status_code == 200, r.text
    cache = r.headers.get("cache-control", "")
    assert "immutable" in cache, f"a hashed bundle is not immutable: {cache!r}"
    assert "max-age" in cache, f"a hashed bundle has no max-age: {cache!r}"


def test_the_api_routes_are_not_cached_as_a_document(client) -> None:
    """The API must never be cached like the entry document."""
    r = client.get("/projects", headers=AUTH)
    assert r.status_code == 200, r.text
    cache = r.headers.get("cache-control", "")
    assert "immutable" not in cache, f"an API response is cached immutably: {cache!r}"
