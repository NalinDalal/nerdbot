"""Hardened outbound web fetch for the agent fetch_url tool.

Default-deny policy for server-side request forgery:
- http/https only; no userinfo, no non-HTTP schemes.
- Literal IPs must be globally public (no private, loopback, link-local,
  multicast, reserved, or unspecified ranges — this covers cloud metadata
  endpoints such as 169.254.169.254).
- Hostnames must not be localhost or local-only suffixes, and every
  resolved address must be public (anti DNS-rebinding: all-pass, not any).
- Redirects are followed manually (max 3) with each hop re-validated.
- Per-fetch byte cap and timeout; no Authorization headers, cookies, or
  credentials are ever attached or forwarded.

Clean-room implementation written from the behavior contract only.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

DEFAULT_MAX_BYTES = 1_000_000
DEFAULT_MAX_REDIRECTS = 3
DEFAULT_TIMEOUT_S = 15.0

BLOCKED_HOSTS = frozenset({"localhost"})
BLOCKED_SUFFIXES = (".local", ".internal", ".lan", ".localdomain", ".invalid", ".test")


class FetchBlockedError(ValueError):
    """URL rejected by SSRF policy; never fetched."""


class FetchTooLargeError(ValueError):
    """Response exceeded the per-fetch byte cap."""


class FetchTimeoutError(RuntimeError):
    """Fetch timed out."""


class FetchProtocolError(RuntimeError):
    """Unreachable host, bad status, too many redirects, or bad payload."""


@dataclass(frozen=True)
class FetchPolicy:
    max_redirects: int = DEFAULT_MAX_REDIRECTS
    max_bytes: int = DEFAULT_MAX_BYTES
    timeout_s: float = DEFAULT_TIMEOUT_S


def default_resolver(host: str) -> list[str]:
    """Resolve a hostname to IP strings. Raises FetchProtocolError on failure."""
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise FetchProtocolError(f"cannot resolve {host!r}: {exc}") from exc
    addresses = [str(info[4][0]) for info in infos]
    if not addresses:
        raise FetchProtocolError(f"no addresses for {host!r}")
    return addresses


def _is_public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def check_url(
    url: str,
    policy: FetchPolicy | None = None,
    resolver: Callable[[str], list[str]] | None = None,
) -> str:
    """Validate a URL against SSRF policy. Returns it unchanged or raises."""
    _ = policy
    if not isinstance(url, str) or not url.strip():
        raise FetchBlockedError("empty URL")
    try:
        parts = urlparse(url.strip())
    except ValueError as exc:
        raise FetchBlockedError(f"unparseable URL: {exc}") from exc
    if parts.scheme not in ("http", "https"):
        raise FetchBlockedError(f"scheme not allowed: {parts.scheme!r}")
    if parts.username or parts.password:
        raise FetchBlockedError("credentials in URL are not allowed")
    host = (parts.hostname or "").lower()
    if not host:
        raise FetchBlockedError("URL has no host")
    if host in BLOCKED_HOSTS or host.endswith(BLOCKED_SUFFIXES):
        raise FetchBlockedError(f"local host not allowed: {host!r}")
    if _is_public_ip(host):
        return url
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise FetchBlockedError(f"non-public IP not allowed: {host!r}")
    resolve = resolver or default_resolver
    try:
        addresses = resolve(host)
    except OSError as exc:
        raise FetchProtocolError(f"cannot resolve {host!r}: {exc}") from exc
    bad = [addr for addr in addresses if not _is_public_ip(addr)]
    if bad:
        raise FetchBlockedError(f"host resolves to non-public address: {host!r}")
    return url


def fetch_url_text(
    url: str,
    policy: FetchPolicy | None = None,
    resolver: Callable[[str], list[str]] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> str:
    """Fetch a URL as text under policy. No auth, cookies, or credentials."""
    active = policy or FetchPolicy()
    checked = check_url(url, active, resolver)
    client = httpx.Client(follow_redirects=False, timeout=active.timeout_s, transport=transport)
    try:
        current = checked
        for _ in range(active.max_redirects + 1):
            try:
                response = client.get(current, headers={"User-Agent": "nerdbot-fetch/0.1"})
            except httpx.TimeoutException as exc:
                raise FetchTimeoutError(f"fetch timed out: {exc}") from exc
            except httpx.TransportError as exc:
                raise FetchProtocolError(f"fetch failed: {exc}") from exc
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                if not location:
                    raise FetchProtocolError("redirect without location")
                current = check_url(urljoin(current, location), active, resolver)
                continue
            if response.status_code != 200:
                raise FetchProtocolError(f"unexpected status (HTTP {response.status_code})")
            length = response.headers.get("content-length")
            if length is not None:
                try:
                    declared = int(length)
                except ValueError:
                    declared = None
                if declared is not None and declared > active.max_bytes:
                    raise FetchTooLargeError(
                        f"content-length {length} exceeds cap {active.max_bytes}"
                    )
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes(chunk_size=65536):
                total += len(chunk)
                if total > active.max_bytes:
                    raise FetchTooLargeError(f"response exceeds cap {active.max_bytes} bytes")
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8", errors="replace")
        raise FetchProtocolError(f"too many redirects (>{active.max_redirects})")
    finally:
        client.close()
