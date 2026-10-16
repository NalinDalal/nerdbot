"""Fixture test suite (named to avoid repo-level pytest collection)."""

from calc import add


def test_add():
    assert add(2, 3) == 5


def test_add_negative():
    assert add(-1, -1) == -2
