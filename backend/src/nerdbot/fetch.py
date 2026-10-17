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

import http.client
import ipaddress
import socket
import ssl
import time
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

    def __init__(self, message: str = "", status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


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
    # IPv4-mapped IPv6 must be judged by its mapped IPv4 half. Stdlib
    # is_private semantics for ::ffff: forms changed with the runtime
    # version (post-CVE-2024-4032), so unwrap explicitly instead of
    # trusting version-dependent behavior.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def check_hostname(url: str) -> str:
    """Syntactic SSRF gate: scheme, credentials, local hostnames. No DNS."""
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
    return url


def check_url(
    url: str,
    policy: FetchPolicy | None = None,
    resolver: Callable[[str], list[str]] | None = None,
) -> str:
    """Validate a URL against SSRF policy. Returns it unchanged or raises."""
    _ = policy
    checked = check_hostname(url)
    host = (urlparse(checked).hostname or "").lower()
    if _is_public_ip(host):
        return checked
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
    return checked


def fetch_url_text(
    url: str,
    policy: FetchPolicy | None = None,
    resolver: Callable[[str], list[str]] | None = None,
    transport: httpx.BaseTransport | None = None,
    clock: Callable[[], float] | None = None,
) -> str:
    """Fetch a URL as text under policy. No auth, cookies, or credentials."""
    active = policy or FetchPolicy()
    tick = clock or time.monotonic
    checked = check_url(url, active, resolver)
    if transport is None:
        transport = PinnedTransport(
            resolver=resolver, timeout_s=active.timeout_s, max_bytes=active.max_bytes
        )
    client = httpx.Client(follow_redirects=False, timeout=active.timeout_s, transport=transport)
    # Whole-fetch wall-clock budget: per-connection timeouts cannot bound a
    # fetch alone — redirect hops and slow (slowloris) body delivery stack up.
    started = tick()
    budget = active.timeout_s * (active.max_redirects + 1)
    try:
        current = checked
        for _ in range(active.max_redirects + 1):
            if tick() - started > budget:
                raise FetchTimeoutError(
                    f"fetch exceeded total time budget ({budget:.1f}s)"
                )
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
                raise FetchProtocolError(
                    f"unexpected status (HTTP {response.status_code})",
                    status=response.status_code,
                )
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


def _default_port(scheme: str, explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    return 443 if scheme == "https" else 80


def _host_header(host: str, scheme: str, port: int | None) -> str:
    if port is None or port == _default_port(scheme, None):
        return host
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"{host}:{port}"


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection to a pinned IP with SNI/hostname of the real host."""

    def __init__(
        self,
        ip: str,
        port: int,
        sni_host: str,
        context: ssl.SSLContext | None = None,
        timeout: float = 15.0,
    ) -> None:
        super().__init__(ip, port, timeout=timeout,
                         context=context or ssl.create_default_context())
        self._pin_context = context or ssl.create_default_context()
        self._sni_host = sni_host

    def connect(self) -> None:
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._pin_context.wrap_socket(sock, server_hostname=self._sni_host)


def _socket_roundtrip(
    request: httpx.Request, host: str, ip: str, timeout_s: float, max_bytes: int
) -> httpx.Response:
    """One HTTP exchange over TCP to a pinned IP. SNI and Host use the real host."""
    scheme = request.url.scheme
    port = _default_port(scheme, request.url.port)
    raw_path = request.url.path or "/"
    query = request.url.query
    path = raw_path + ("?" + query.decode("ascii") if query else "")
    headers = [
        (k.decode("latin-1"), v.decode("latin-1"))
        for k, v in request.headers.raw
        if k.lower() not in (b"host", b"accept-encoding")
    ]
    headers.append(("Host", _host_header(host, scheme, request.url.port)))
    headers.append(("Accept-Encoding", "identity"))
    body = request.content
    if scheme == "https":
        conn: http.client.HTTPConnection = _PinnedHTTPSConnection(
            ip, port, host, timeout=timeout_s, context=ssl.create_default_context()
        )
    else:
        conn = http.client.HTTPConnection(ip, port, timeout=timeout_s)
    try:
        started = time.monotonic()
        conn.putrequest(request.method, path, skip_host=True, skip_accept_encoding=True)
        for key, value in headers:
            conn.putheader(key, value)
        if body:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body if body else None)
        response = conn.getresponse()
        status = response.status

        def _text(value: bytes | str) -> str:
            return value.decode("latin-1") if isinstance(value, bytes) else value

        raw_headers = [(_text(k), _text(v)) for k, v in response.getheaders()]
        chunks: list[bytes] = []
        total = 0
        while True:
            piece = response.read(65536)
            if not piece:
                break
            total += len(piece)
            if total > max_bytes:
                raise FetchTooLargeError(f"response exceeds cap {max_bytes} bytes")
            chunks.append(piece)
            # Slowloris bound: each socket op may individually stay inside
            # timeout_s, so a dribbling server could otherwise keep the
            # exchange alive indefinitely. Enforce one per-exchange deadline
            # across all reads.
            if time.monotonic() - started > timeout_s:
                raise FetchTimeoutError(
                    f"pinned response exceeded time budget ({timeout_s:.1f}s)"
                )
    except TimeoutError as exc:
        raise FetchTimeoutError(f"pinned connection timed out: {exc}") from exc
    except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
        raise FetchProtocolError(f"pinned connection failed: {exc}") from exc
    finally:
        conn.close()
    return httpx.Response(status, headers=raw_headers, content=b"".join(chunks),
                          request=request)


Connector = Callable[[httpx.Request, str, str, float, int], httpx.Response]


class PinnedTransport(httpx.BaseTransport):
    """httpx transport that resolves once and connects by pinned IP.

    Resolution happens here, at connection time: the hostname policy plus a
    single DNS lookup whose addresses must ALL be public, then TCP goes to
    the first address only. SNI and the Host header carry the original
    hostname; TLS verification uses the default context against that name.
    Each request (including every redirect hop, which arrives as a new
    request) is pinned independently. ``connector`` is injectable for tests.
    """

    def __init__(
        self,
        resolver: Callable[[str], list[str]] | None = None,
        connector: Connector | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self._resolver = resolver
        self._connector = connector
        self._timeout_s = timeout_s
        self._max_bytes = max_bytes

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        host = (request.url.host or "").lower()
        check_hostname(str(request.url))
        if _is_public_ip(host):
            ips = [host]
        else:
            try:
                ipaddress.ip_address(host)
            except ValueError:
                pass
            else:
                raise FetchBlockedError(f"non-public IP not allowed: {host!r}")
            resolve = self._resolver or default_resolver
            try:
                ips = resolve(host)
            except OSError as exc:
                raise FetchProtocolError(f"cannot resolve {host!r}: {exc}") from exc
            if not ips:
                raise FetchProtocolError(f"no addresses for {host!r}")
            bad = [addr for addr in ips if not _is_public_ip(addr)]
            if bad:
                raise FetchBlockedError(f"host resolves to non-public address: {host!r}")
        connector = self._connector or _socket_roundtrip
        return connector(request, host, ips[0], self._timeout_s, self._max_bytes)
