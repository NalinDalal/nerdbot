"""Seed teammates from config (idempotent)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import store


def _seed_path():
    for candidate in ("teammates.seed.json", "teammates.seed.yaml"):
        p = Path(candidate)
        if p.is_file():
            return p
    data_dir = os.environ.get("NERDBOT_DATA")
    if data_dir:
        p = Path(data_dir) / "teammates.seed.json"
        if p.is_file():
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
    except Exception:
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
