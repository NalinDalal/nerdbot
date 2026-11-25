"""Shared pytest fixtures for nerdbot backend tests."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

from nerdbot import store  # noqa: E402


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    """Return a path to a fresh temporary SQLite database."""
    return tmp_path / "test.db"


@pytest.fixture()
def conn(db_path: Path) -> sqlite3.Connection:
    """Open a fresh nerdbot database connection with schema/migrations applied."""
    connection = store.connect(db_path)
    try:
        yield connection
    finally:
        connection.close()


@pytest.fixture()
def data_dir(tmp_path: Path) -> Path:
    """Return a temporary nerdbot data dir."""
    d = tmp_path / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d
