"""Seed teammates from config (idempotent)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from . import store


def _json_is_readable(path: Path) -> bool:
    """A seed file that cannot be parsed is worse than no seed file.

    It used to be picked first, fail to load, and leave a fresh install with
    zero agents and one stderr line nobody sees. Check the file before
    choosing it so a malformed copy falls through to the next candidate.
    """
    try:
        json.loads(path.read_text())
        return True
    except Exception as exc:
        print(f"seed: skipping unreadable {path}: {exc}", file=sys.stderr)
        return False


def _seed_path():
    for candidate in ("teammates.seed.json", "teammates.seed.yaml"):
        p = Path(candidate)
        if not p.is_file():
            continue
        if p.suffix == ".json" and not _json_is_readable(p):
            continue
        return p
    data_dir = os.environ.get("NERDBOT_DATA")
    if data_dir:
        p = Path(data_dir) / "teammates.seed.json"
        if p.is_file() and _json_is_readable(p):
            return p
    return None


def load_seed():
    path = _seed_path()
    if path is None:
        return []
    try:
        if path.suffix == ".yaml":
            import yaml
            data = yaml.safe_load(path.read_text())
        else:
            data = json.loads(path.read_text())
    except Exception as exc:
        # A broken seed file must never pass silently: the operator would see
        # zero bots and no explanation. Log loudly and continue with none.
        print(f"seed: failed to load {path}: {exc}", file=sys.stderr)
        return []
    if isinstance(data, dict):
        data = data.get("teammates", [])
    return data if isinstance(data, list) else []


def seed_teammates(conn, project_id):
    created = []
    existing = {m.slug: m for m in store.list_teammates(conn, project_id) if m.slug}
    for entry in load_seed():
        slug = str(entry.get("slug", "")).strip()
        if not slug:
            continue
        name = str(entry.get("name", "")).strip()
        if slug in existing:
            # Rows created before names existed carry only the slug; the seed
            # owns that slug, so it fills in the display name it defines.
            mate = existing[slug]
            if name and not mate.name:
                store.update_teammate(conn, mate.id, name=name)
            continue
        permissions = list(entry.get("permissions") or [])
        mate = store.create_teammate(
            conn,
            project_id,
            slug=slug,
            name=name,
            persona=str(entry.get("persona", "")),
            instructions=str(entry.get("instructions", "")),
            permissions=permissions,
            face=entry.get("face"),
        )
        created.append(mate)
    return created
