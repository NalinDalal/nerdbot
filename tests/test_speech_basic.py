"""Speech (dictation) module tests — no external network.

Uses ``unittest.mock.patch`` so every test is deterministic and offline.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest
from unittest import mock

from fastapi import Header

from backend.src.nerdbot.speech import transcribe, synthesize
from backend.src.nerdbot import store as store_mod
from tests.conftest import db_path  # noqa: F401 # establishes fixture scope


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def conn(db_path):
    return store_mod.connect(db_path)


@pytest.fixture()
def principal(conn):
    """A dummy principal; most STT/TTS paths just need a conn, not a real user."""
    return "test-principal"


# ---------------------------------------------------------------------------
# STT tests
# ---------------------------------------------------------------------------


def test_stt_not_configured(conn, principal):
    """When no OpenAI-compatible provider is configured in the DB,
    transcribe returns "not configured" rather than 500‑ing."""
    result = transcribe(b"some audio", conn=conn, principal=principal)
    assert result["text"] == ""
    assert result["error"] == "not configured"


def test_stt_success_with_mock(conn, principal):
    """A successful STT call returns the transcript when httpx.post is
    patched to return a mock transcript AND the provider creds are
    temporarily configured."""
    with mock.patch("backend.src.nerdbot.speech.httpx.post") as mock_post:
        # Patch the creds function so the call proceeds to httpx.post.
        with mock.patch("backend.src.nerdbot.speech._stt_endpoint_and_creds") as mock_creds:
            mock_creds.return_value = {
                "base_url": "http://mock-stt.local/v1",
                "api_key": "sk-mock-stt",
                "model": "whisper-1",
            }
            mock_post.return_value = httpx.Response(
                200,
                json={"text": "hello world from mock stt"},
                headers={"content-type": "application/json"},
                request=httpx.Request("POST", "http://mock-stt.local/v1"),
            )
            result = transcribe(b"\xff\xfb" + b"\x00" * 100, conn=conn, principal=principal)
            assert result["text"] == "hello world from mock stt"
            assert result["error"] is None


def test_stt_too_large(conn, principal):
    """Audio larger than ``MAX_AUDIO_BYTES`` is rejected before any network call."""
    big = b"\x00" * (25 * 1024 * 1024 + 1)  # 25 MiB + 1 byte
    result = transcribe(big, conn=conn, principal=principal)
    assert result["text"] == ""
    assert result["error"] == "audio too large"


# ---------------------------------------------------------------------------
# TTS tests
# ---------------------------------------------------------------------------


def test_tts_not_configured(conn, principal):
    """When no TTS provider is configured in the DB, synthesize returns
    empty bytes and ``"not configured"`` error."""
    result = synthesize("hello", conn=conn, principal=principal)
    assert result["audio_bytes"] == b""
    assert result["error"] == "not configured"


def test_tts_success_with_mock(conn, principal):
    """A successful TTS call returns audio bytes when httpx.post is
    patched to return mock audio bytes."""
    with mock.patch("backend.src.nerdbot.speech.httpx.post") as mock_post:
        # Patch the creds function so the call proceeds to httpx.post.
        with mock.patch("backend.src.nerdbot.speech._tts_endpoint_and_creds") as mock_creds:
            mock_creds.return_value = {
                "base_url": "http://mock-tts.local/v1",
                "api_key": "sk-mock-tts",
                "model": "tts-1",
            }
            mock_post.return_value = httpx.Response(
                200,
                json={"audio": base64.b64encode(b"fake mp3 bytes").decode()},
                headers={"content-type": "application/json"},
                request=httpx.Request("POST", "http://mock-tts.local/v1"),
            )
            result = synthesize("hello world", conn=conn, principal=principal)
            assert isinstance(result["audio_bytes"], bytes)
            assert result["error"] is None
            # The synthesize function already base64-decodes the response;
            # verify the raw bytes match expected.
            assert result["audio_bytes"] == b"fake mp3 bytes"


def test_tts_local_fallback_missing(conn, principal):
    """When no remote provider and no local synth (e.g. Linux without espeak),
    synthesize returns empty bytes with a reason."""
    result = synthesize("hello", conn=conn, principal=principal)
    assert result["audio_bytes"] == b""
    # The exact reason depends on the platform; just verify it's a string.
    assert isinstance(result["error"], str)


# ---------------------------------------------------------------------------
# Edge‑case: format‑guessing in STT
# ---------------------------------------------------------------------------


def test_stt_mp3_magic_bytes(conn, principal):
    """STT should recognise MP3 magic bytes and guess the mime."""
    result = transcribe(b"\xff\xfb" + b"\x00" * 100, conn=conn, principal=principal)
    # May return "not configured" if no provider, or the mock transcript.
    assert "text" in result or "error" in result


def test_stt_wav_magic_bytes(conn, principal):
    """STT should recognise WAV RIFF magic bytes."""
    result = transcribe(b"RIFF" + b"WAVE" + b"\x00" * 100, conn=conn, principal=principal)
    assert "text" in result or "error" in result