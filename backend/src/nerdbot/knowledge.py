"""Offline knowledge: chunk, retrieve, cite, attach.

Reimplemented usefulness patterns only (no copied RAG code, no vectors, no
external deps). Chunking is a word-window splitter; retrieval scores
token overlap deterministically. Every chunk carries source provenance.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from . import store
from .models import VerificationStatus

_WORD = re.compile(r"[a-z0-9]+")


def chunk_text(text: str, words_per_chunk: int = 120, overlap: int = 30) -> list[str]:
    """Split text into overlapping word windows. Deterministic."""
    if words_per_chunk <= 0:
        raise ValueError("words_per_chunk must be positive")
    if not 0 <= overlap < words_per_chunk:
        raise ValueError("overlap must satisfy 0 <= overlap < words_per_chunk")
    words = text.split()
    if not words:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(words):
        chunks.append(" ".join(words[start : start + words_per_chunk]))
        if start + words_per_chunk >= len(words):
            break
        start += words_per_chunk - overlap
    return chunks


def tokenize(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


def overlap_score(query_tokens: set[str], chunk_tokens: set[str]) -> float:
    if not query_tokens:
        return 0.0
    return len(query_tokens & chunk_tokens) / len(query_tokens)


def retrieve(
    conn: sqlite3.Connection, project_id: str, query: str, top_k: int = 3
) -> list[dict[str, Any]]:
    """Return top-k chunk citations with provenance and confidence."""
    query_tokens = tokenize(query)
    sources = {s.id: s for s in store.list_knowledge_sources(conn, project_id)}
    chunks = {c.id: c for c in store.list_knowledge_chunks(conn, project_id)}
    scored: list[tuple[float, str, str, str]] = []
    for chunk in chunks.values():
        chunk_source = sources.get(chunk.source_id)
        if chunk_source is None:
            continue
        score = overlap_score(query_tokens, tokenize(chunk.text))
        if score > 0:
            scored.append((score, chunk.id, chunk_source.title, chunk_source.source))
    scored.sort(key=lambda item: (-item[0], item[1]))
    results: list[dict[str, Any]] = []
    for score, chunk_id, title, source in scored[: max(top_k, 0)]:
        results.append(
            {
                "chunk_id": chunk_id,
                "source_title": title,
                "source": source,
                "excerpt": chunks[chunk_id].text[:500],
                "confidence": round(score, 4),
            }
        )
    return results


def ingest_knowledge(
    conn: sqlite3.Connection,
    project_id: str,
    title: str,
    content: str,
    source: str,
    kind: str = "text",
) -> tuple[str, int]:
    """Store a source plus its chunks. Returns (source_id, chunk_count)."""
    entry = store.create_knowledge_source(conn, project_id, title, content, source, kind=kind)
    chunks = store.store_knowledge_chunks(conn, entry.id, project_id, chunk_text(content))
    return entry.id, len(chunks)


def attach_evidence(
    conn: sqlite3.Connection,
    task_id: str,
    query: str,
    data_dir: str,
    run_id: str = "",
    top_k: int = 3,
) -> tuple[str, list[dict[str, Any]]]:
    """Retrieve citations for a task and persist them as a knowledge artifact."""
    from . import orchestrator

    task = store.get_task(conn, task_id)
    if task is None:
        raise KeyError(f"unknown task {task_id}")
    citations = retrieve(conn, task.project_id, query, top_k=top_k)
    lines = [f"# Knowledge evidence for {task_id}", "", f"query: {query}", ""]
    for cite in citations:
        lines.append(
            f"- [{cite['source_title']}] ({cite['source']}) "
            f"confidence={cite['confidence']}: {cite['excerpt'][:200]}"
        )
    if not citations:
        lines.append("(no citations above threshold)")
    location = orchestrator.artifacts_dir(data_dir) / f"knowledge-{task_id}-{len(citations)}.md"
    location.write_text("\n".join(lines) + "\n", encoding="utf-8")
    artifact = store.create_artifact(
        conn,
        task_id,
        run_id,
        "knowledge",
        str(location),
        VerificationStatus.UNVERIFIED,
        summary=f"citations={len(citations)}",
    )
    return artifact.id, citations
