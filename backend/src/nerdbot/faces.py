"""The catalogue of bot faces.

A bot's face is three choices — body shape, colour, resting expression — and
each of them is an id from a fixed list. The ids and the geometry live in the
dashboard (``dashboard/src/bot/``), which is where the avatar is drawn; this
module is the server's copy of the vocabulary, so the API can refuse a face
nobody can draw instead of storing it and letting the dashboard fall back to
the default behind the owner's back.

The two lists are checked against each other by ``tests/test_bot_faces.py``,
which reads the TypeScript source and compares. That test is the reason this
duplication is safe: a shape added on one side and not the other fails the
build instead of silently doing nothing.
"""

from __future__ import annotations

from typing import Any

# Body shapes. The ids are French, as in the upstream customiser, because the
# faces themselves are that customiser's — renaming them here would fork the
# vocabulary for no gain.
SHAPE_IDS: tuple[str, ...] = (
    "cercle",
    "galet",
    "squircle",
    "capsule",
    "triangle",
    "hexagone",
    "nuage",
    "goutte",
)

# Body colours.
COLOR_IDS: tuple[str, ...] = (
    "encre",
    "creme",
    "brun",
    "rouge",
    "orange",
    "ambre",
    "vert",
    "turquoise",
    "bleu",
    "violet",
    "rose",
    "gris",
)

# Resting expressions.
EXPRESSION_IDS: tuple[str, ...] = (
    "neutre",
    "attentif",
    "surpris",
    "excite",
    "heureux",
    "hilare",
    "colere",
    "triste",
    "effraye",
    "mefiant",
    "confus",
    "curieux",
    "fier",
    "timide",
    "blase",
    "somnolent",
)

DEFAULT_SHAPE = "cercle"
DEFAULT_COLOR = "encre"
DEFAULT_EXPRESSION = "neutre"

#: The fields a face is made of.
FACE_FIELDS: tuple[str, ...] = ("shape", "color", "expression")

_MAX_ID_LENGTH = 32


class FaceError(ValueError):
    """A face the catalogue does not know."""


def _check(field: str, value: Any, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str):
        raise FaceError(f"face.{field} must be a string")
    if len(value) > _MAX_ID_LENGTH:
        raise FaceError(f"face.{field} is too long")
    if value not in allowed:
        raise FaceError(f"unknown face.{field}: {value!r}")
    return value


def validate_face(face: Any) -> dict[str, str]:
    """Check a face against the catalogue and return it normalised.

    Every field is required: a partial face is not a face, and defaulting
    the missing halves here would make the stored value depend on which
    fields the caller happened to send. Callers that want a default use
    :func:`default_face`.
    """
    if not isinstance(face, dict):
        raise FaceError("face must be an object")
    unknown = set(face) - set(FACE_FIELDS)
    if unknown:
        raise FaceError(f"unknown face field(s): {sorted(unknown)}")
    missing = set(FACE_FIELDS) - set(face)
    if missing:
        raise FaceError(f"missing face field(s): {sorted(missing)}")
    return {
        "shape": _check("shape", face["shape"], SHAPE_IDS),
        "color": _check("color", face["color"], COLOR_IDS),
        "expression": _check("expression", face["expression"], EXPRESSION_IDS),
    }


def default_face() -> dict[str, str]:
    """The face a bot gets when the owner does not choose one."""
    return {
        "shape": DEFAULT_SHAPE,
        "color": DEFAULT_COLOR,
        "expression": DEFAULT_EXPRESSION,
    }


def merge_face(face: Any) -> dict[str, str]:
    """Validate a face that may leave some fields out.

    The missing ones take their default. Used by the store, which has to
    cope with rows written before faces existed.
    """
    if not isinstance(face, dict):
        raise FaceError("face must be an object")
    unknown = set(face) - set(FACE_FIELDS)
    if unknown:
        raise FaceError(f"unknown face field(s): {sorted(unknown)}")
    merged = default_face()
    for field in FACE_FIELDS:
        if field in face:
            merged[field] = face[field]
    return validate_face(merged)
