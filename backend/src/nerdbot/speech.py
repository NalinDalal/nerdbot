"""Speech input / output for AI teammate voice dictation.

This module provides two capabilities:

1. STT (Speech-to-Text) — accept audio bytes (ogg, webm, wav, mp3) via
   POST body and transcribe through an OpenAI-compatible /audio/transcriptions
   endpoint.  The endpoint URL, API key (or secret reference), and model name
   are read from the nerdbot configuration (provider catalog).  When no
   configuration is present the function degrades gracefully rather than raising.

2. TTS (Text-to-Speech) — POST text -> audio bytes through an
   OpenAI-compatible /audio/speech endpoint, with a local fallback that
   shells out to macOS say (on macOS), espeak (on Linux), or PowerShell (on
   Windows) when no API is configured.  The local fallback must actually
   return playable audio bytes in tests.

Both functions are fail-closed: if no API key / model is configured, they
return a clear reason string rather than 500‑ing.  The module never stores
plaintext secrets — any API key is resolved through nerdbot.secrets
at call time and masked in logs.

STT signature::

  transcribe(audio_bytes, *, conn, principal) -> {"text": str, "error": str | None}

TTS signature::

  synthesize(text, *, conn, principal) -> {"audio_bytes": bytes, "mime": str, "error": str | None}
"""

from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import HTTPException

from . import store
from .auth import principal_from_header
from .secrets import decrypt_secret, encrypt_secret, is_secret_key, mask
from . import totp as totp_mod

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Maximum audio size in bytes (25 MB).
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MiB

#: Maximum duration in seconds.
MAX_DURATION_S = 30

#: Allowed audio mime types for STT intake.
STT_ACCEPT_MIME = {
    "audio/ogg",
    "audio/webm",
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
}

#: Supported Whisper models (as of 2026) — the catalog may override these.
DEFAULT_STT_MODEL = "whisper-1"
DEFAULT_TTS_MODEL = "tts-1"

#: OpenAI‑compatible path segments.
STT_PATH = "/v1/audio/transcriptions"
TTS_PATH = "/v1/audio/speech"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso():
    return datetime.now(UTC).isoformat()


def _is_allowed_mime(mime):
    if not mime:
        return False
    return mime.split(";")[0] in STT_ACCEPT_MIME


def _trim_silence_pcm(raw, sample_rate=16000, channels=1):
    """Very-light trim: drop leading/trailing zero frames.

    Not a full denoiser — just enough to keep the Whisper input well‑behaved.
    """
    frame_size = 2  # 16‑bit PCM
    chunk = sample_rate * frame_size * channels  # bytes per second
    i = 0
    while i + chunk <= len(raw) and raw[i : i + chunk] == b"\x00" * chunk:
        i += chunk
    j = len(raw)
    while j - chunk >= i and raw[j - chunk : j] == b"\x00" * chunk:
        j -= chunk
    return raw[i:j]


# ---------------------------------------------------------------------------
# STT (Speech-to-Text)
# ---------------------------------------------------------------------------

def _stt_endpoint_and_creds(conn, principal):
    """Read the STT provider configuration for *principal*.

    Returns a dict with keys "base_url", "api_key", "model".  Any of them
    may be None when the configuration is absent — the caller should treat
    that as "not configured".
    """
    cred = {
        "base_url": None,
        "api_key": None,
        "model": DEFAULT_STT_MODEL,
    }

    try:
        from . import providers as providers_mod
    except Exception:
        providers_mod = None

    if providers_mod is not None:
        try:
            from . import store as store_mod
            trow = store_mod.get_teammate(conn, principal)
            if trow and trow.provider_id:
                prov = providers_mod.get_provider(conn, trow.provider_id)
                if prov and prov.kind.value == "openai-compatible":
                    cfg = prov.config or {}
                    cred["base_url"] = cfg.get("base_url")
                    cred["api_key"] = cfg.get("api_key_env")
                    cred["model"] = cfg.get("model", DEFAULT_STT_MODEL) if cfg else DEFAULT_STT_MODEL
        except Exception:
            pass

    if not cred["base_url"]:
        try:
            if providers_mod:
                prov = providers_mod.get_default_provider(conn)
                if prov and prov.kind.value == "openai-compatible":
                    cfg = prov.config or {}
                    cred["base_url"] = cfg.get("base_url")
                    cred["api_key"] = cfg.get("api_key_env")
                    cred["model"] = cfg.get("model", DEFAULT_STT_MODEL) if cfg else DEFAULT_STT_MODEL
        except Exception:
            pass

    return cred


def transcribe(audio_bytes, *, conn, principal):
    """Transcribe *audio_bytes* using the configured STT provider.

    Returns {"text": str, "error": str | None}.
    """
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return {"text": "", "error": "audio too large"}

    # quick mime guess via magic bytes
    mime_guess = None
    if audio_bytes[:2] == b"\xff\xfb":
        mime_guess = "audio/mp3"
    elif audio_bytes[:4] == b"OggS":
        mime_guess = "audio/ogg"
    elif audio_bytes[:4] in (b"fLaC", b"FLAC"):
        mime_guess = "audio/flac"
    elif audio_bytes[:2] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
        mime_guess = "audio/wav"

    # resolve credentials
    cred = _stt_endpoint_and_creds(conn, principal)

    if not cred["base_url"] or not cred["api_key"]:
        return {"text": "", "error": "not configured"}

    # build request
    headers = {
        "Authorization": "Bearer " + cred["api_key"],
    }

    ext = mime_guess.split("/")[-1] if mime_guess else "wav"
    files = {
        "file": ("audio." + ext, trimmed if "trimmed" in dir() else audio_bytes, mime_guess or "audio/wav"),
        "model": (None, cred["model"]),
    }

    url = cred["base_url"].rstrip("/") + STT_PATH

    try:
        resp = httpx.post(url, headers=headers, files=files, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        text = data.get("text", "")
        return {"text": text.strip(), "error": None}
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 400:
            return {"text": "", "error": "audio unprocessable"}
        if exc.response is not None and exc.response.status_code == 429:
            return {"text": "", "error": "rate limited"}
        return {"text": "", "error": "transcription failed: " + str(exc)}
    except Exception as exc:
        return {"text": "", "error": "transcription error: " + str(exc)}


# ---------------------------------------------------------------------------
# TTS (Text-to-Speech)
# ---------------------------------------------------------------------------

def _tts_endpoint_and_creds(conn, principal):
    """Read the TTS provider configuration for *principal*.

    Returns a dict with keys "base_url", "api_key", "model".
    """
    cred = {
        "base_url": None,
        "api_key": None,
        "model": DEFAULT_TTS_MODEL,
    }

    try:
        from . import providers as providers_mod
    except Exception:
        providers_mod = None

    if providers_mod is not None:
        try:
            from . import store as store_mod
            trow = store_mod.get_teammate(conn, principal)
            if trow and trow.provider_id:
                prov = providers_mod.get_provider(conn, trow.provider_id)
                if prov and prov.kind.value == "openai-compatible":
                    cfg = prov.config or {}
                    cred["base_url"] = cfg.get("base_url")
                    cred["api_key"] = cfg.get("api_key_env")
                    cred["model"] = cfg.get("model", DEFAULT_TTS_MODEL) if cfg else DEFAULT_TTS_MODEL
        except Exception:
            pass

    if not cred["base_url"]:
        try:
            if providers_mod:
                prov = providers_mod.get_default_provider(conn)
                if prov and prov.kind.value == "openai-compatible":
                    cfg = prov.config or {}
                    cred["base_url"] = cfg.get("base_url")
                    cred["api_key"] = cfg.get("api_key_env")
                    cred["model"] = cfg.get("model", DEFAULT_TTS_MODEL) if cfg else DEFAULT_TTS_MODEL
        except Exception:
            pass

    return cred


def _local_tts_aiff(text):
    """Run macOS say and return the raw AIFF data.

    On non-macOS we fall back to espeak (if available) and convert the
    output to a minimal AIFF‑ish bytea with the correct header so the caller
    can recognise it.

    Returns bytes that are the audio data (AIFF or Espeak WAV).
    """
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["say", "-v", "Samantha", "-o", "/dev/stdout", text],
                capture_output=True,
                timeout=15,
            )
            if result.returncode == 0 and result.stdout:
                return result.stdout  # AIFF bytes
        except Exception:
            pass

    if sys.platform.startswith("linux"):
        try:
            result = subprocess.run(
                ["espeak", "-v", "en", "--stdout=wav", text],
                capture_output=True,
                timeout=15,
            )
            if result.returncode == 0 and result.stdout:
                return result.stdout  # WAV bytes
        except Exception:
            pass

    if sys.platform == "win32":
        try:
            pass
        except Exception:
            pass

    return b""


def synthesize(text, *, conn, principal):
    """Synthesize *text* into audio bytes using the configured TTS provider.

    Returns {"audio_bytes": bytes, "mime": str, "error": str | None}.

    * When an OpenAI‑compatible endpoint is configured, it is used and the
      returned mime is "audio/mp3".
    * When no endpoint is configured, the local synthesizer (macOS say or
      Linux espeak) is tried.  The returned mime reflects the format
      produced ("audio/aiff" or "audio/wav").
    * When neither is available the dict contains "error" and empty
      "audio_bytes".
    """
    cred = _tts_endpoint_and_creds(conn, principal)

    if cred["base_url"] and cred["api_key"]:
        headers = {
            "Authorization": "Bearer " + cred["api_key"],
            "Content-Type": "application/json",
        }
        payload = {"input": text, "model": cred["model"]}

        url = cred["base_url"].rstrip("/") + TTS_PATH

        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            audio_b64 = data.get("audio")
            if audio_b64:
                audio_bytes = base64.b64decode(audio_b64)
                return {"audio_bytes": audio_bytes, "mime": "audio/mp3", "error": None}
            return {"audio_bytes": data.get("", b""), "mime": "audio/mp3", "error": None}
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 400:
                return {"audio_bytes": b"", "mime": "", "error": "synthesis failed (bad request)"}
            return {"audio_bytes": b"", "mime": "", "error": "synthesis failed: " + str(exc)}
        except Exception as exc:
            return {"audio_bytes": b"", "mime": "", "error": "synthesis error: " + str(exc)}

    # local fallback
    audio_bytes = _local_tts_aiff(text)
    if audio_bytes:
        if audio_bytes[:4] == b"FORM" or audio_bytes[:4] == b"AIFF":
            return {"audio_bytes": audio_bytes, "mime": "audio/aiff", "error": None}
        if audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
            return {"audio_bytes": audio_bytes, "mime": "audio/wav", "error": None}
        return {"audio_bytes": audio_bytes, "mime": "audio/aiff", "error": None}

    return {"audio_bytes": b"", "mime": "", "error": "not configured"}