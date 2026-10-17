"""DNS-pinning transport: fake DNS + fake sockets, no live network."""

from __future__ import annotations

import io
import socket
import ssl
import time
from collections import deque

import httpx
import pytest

from nerdbot import fetch as fetch_mod
from nerdbot.fetch import (
    FetchBlockedError,
    FetchPolicy,
    FetchTimeoutError,
    FetchTooLargeError,
    PinnedTransport,
    check_url,
    fetch_url_text,
)

PUBLIC_IP = "93.184.216.34"
PUBLIC_IP_2 = "151.101.1.140"
PRIVATE_IP = "10.0.0.9"


def _recording_connector(calls: list, responder=None):  # type: ignore[no-untyped-def]
    def connect(request: httpx.Request, host: str, ip: str, timeout_s: float,
                max_bytes: int) -> httpx.Response:
        calls.append((host, ip))
        if responder is not None:
            return responder(request, host, ip)
        return httpx.Response(200, text="ok", request=request)

    return connect


def test_rebinding_window_closed() -> None:
    resolutions = [[PUBLIC_IP], [PRIVATE_IP]]

    def flip(host: str) -> list[str]:
        assert host == "rebind.example"
        return resolutions.pop(0) if len(resolutions) > 1 else resolutions[0]

    calls: list = []
    transport = PinnedTransport(resolver=flip, connector=_recording_connector(calls))
    client = httpx.Client(transport=transport)
    try:
        first = client.get("https://rebind.example/")
        assert first.status_code == 200
        # Attacker's second resolution now serves the private IP: refused,
        # and the first connection provably used the pinned public IP.
        with pytest.raises(FetchBlockedError):
            client.get("https://rebind.example/")
    finally:
        client.close()
    assert calls == [("rebind.example", PUBLIC_IP)]


def test_all_resolved_ips_must_pass() -> None:
    calls: list = []

    def mixed(host: str) -> list[str]:
        return [PUBLIC_IP, PRIVATE_IP]

    transport = PinnedTransport(resolver=mixed, connector=_recording_connector(calls))
    client = httpx.Client(transport=transport)
    try:
        with pytest.raises(FetchBlockedError):
            client.get("https://mixed.example/")
    finally:
        client.close()
    assert calls == []


def test_pinned_timeout_is_transient(monkeypatch) -> None:
    def slow(host: str) -> list[str]:
        return ["93.184.216.34"]

    def never_connect(address: object, timeout: object = None) -> object:
        raise TimeoutError("timed out")

    transport = fetch_mod.PinnedTransport(resolver=slow)
    request = httpx.Request("GET", "https://slow.example/")

    monkeypatch.setattr(socket, "create_connection", never_connect)
    with pytest.raises(fetch_mod.FetchTimeoutError):
        transport.handle_request(request)


def test_redirect_hops_repin_independently() -> None:
    mapping = {"hop1.example": [PUBLIC_IP], "hop2.example": [PUBLIC_IP_2]}
    resolved: list[str] = []

    def resolver(host: str) -> list[str]:
        resolved.append(host)
        return mapping[host]

    calls: list = []

    def responder(request: httpx.Request, host: str, ip: str) -> httpx.Response:
        if host == "hop1.example":
            return httpx.Response(302, headers={"location": "https://hop2.example/final"},
                                  request=request)
        return httpx.Response(200, text="landed", request=request)

    text = fetch_mod.fetch_url_text(
        "https://hop1.example/r",
        resolver=resolver,
        transport=PinnedTransport(resolver=resolver,
                                  connector=_recording_connector(calls, responder)),
    )
    assert text == "landed"
    assert calls == [("hop1.example", PUBLIC_IP), ("hop2.example", PUBLIC_IP_2)]
    assert resolved == ["hop1.example", "hop1.example", "hop2.example", "hop2.example"]


class _FakeSock:
    def __init__(self, received: bytearray, body: bytes) -> None:
        self.received = received
        self._body = body

    def settimeout(self, timeout: float | None) -> None:
        pass

    def setsockopt(self, *args: object) -> None:
        pass

    def sendall(self, data: bytes) -> None:
        self.received.extend(data)

    def makefile(self, mode: str, *args: object, **kwargs: object) -> io.BytesIO:
        assert mode == "rb"
        return io.BytesIO(self._body)

    def close(self) -> None:
        pass


def test_sni_host_header_and_verification(monkeypatch) -> None:
    received = bytearray()
    dialed: list = {}
    wrapped: list = {}

    def fake_create_connection(address: tuple, timeout: float | None = None) -> _FakeSock:
        dialed["addr"] = address
        return _FakeSock(received, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi")

    class FakeContext:
        def wrap_socket(self, sock: _FakeSock, server_hostname: str | None = None) -> _FakeSock:
            wrapped["sni"] = server_hostname
            return sock

    monkeypatch.setattr(socket, "create_connection", fake_create_connection)
    monkeypatch.setattr(ssl, "create_default_context", lambda: FakeContext())  # type: ignore[method-assign]

    request = httpx.Request("GET", "https://public.example:8443/x")
    response = fetch_mod._socket_roundtrip(request, "public.example", PUBLIC_IP, 5.0, 1_000_000)
    assert response.status_code == 200 and response.content == b"hi"
    assert dialed["addr"] == (PUBLIC_IP, 8443)  # TCP went to the pinned IP
    assert wrapped["sni"] == "public.example"  # SNI carried the real hostname
    sent = received.decode("latin-1")
    assert "Host: public.example:8443\r\n" in sent
    assert "Accept-Encoding: identity" in sent


def test_trailing_dot_fqdns_normalized() -> None:
    # Trailing dots are stripped before the local-host gate, so
    # "localhost." and "app.local." are refused like their bare forms.
    for url in (
        "http://localhost./",
        "http://LOCALHOST.:8000/x",
        "http://app.local./",
        "http://db.internal./",
        "http://127.0.0.1./",
    ):
        with pytest.raises(FetchBlockedError):
            check_url(url, resolver=lambda h: [PUBLIC_IP])
    assert check_url("http://public.example./", resolver=lambda h: [PUBLIC_IP]) is not None


def test_nat64_and_6to4_embedded_ipv4_blocked() -> None:
    # RFC 6052 NAT64 (64:ff9b::/96) embeds the v4 target in the low 32
    # bits; 6to4 (2002::/16) in bits 16-47. Both are classified by the
    # embedded half, so a NAT64-capable egress cannot be tricked into
    # reaching metadata or RFC1918 space.
    for host in ("64:ff9b::a9fe:a9fe",  # 169.254.169.254
                 "64:ff9b::7f00:1",     # 127.0.0.1
                 "2002:ac10:0a01::",    # 172.16.10.1
                 "2002:e000:0a01::"):   # 224.0.10.1 multicast
        with pytest.raises(FetchBlockedError):
            check_url(f"http://[{host}]/", resolver=lambda h: [PUBLIC_IP])
    # A 6to4 address carrying a public v4 tail is still allowed.
    assert check_url("http://[2002:5dd8:0d05::]/", resolver=lambda h: [PUBLIC_IP]) is not None


def test_default_tls_context_verifies(monkeypatch) -> None:
    # Verification itself must stay intact: real default context properties.
    real_create = ssl.create_default_context
    ctx = real_create()
    assert ctx.check_hostname is True
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("no network in tests")))
    assert check_url("https://public.example/", resolver=lambda h: [PUBLIC_IP])


def test_ipv4_mapped_literals_judged_by_mapped_half() -> None:
    # Private/loopback targets hidden in ::ffff: encoding are refused no
    # matter how the runtime classifies the encoded form.
    for host in ("::ffff:10.0.0.9", "::ffff:169.254.169.254", "::ffff:127.0.0.1",
                 "::ffff:192.168.1.5"):
        with pytest.raises(FetchBlockedError):
            check_url(f"http://[{host}]/", resolver=lambda h: [PUBLIC_IP])
    # A mapped *public* address is still fetchable.
    assert check_url(
        "http://[::ffff:93.184.216.34]/", resolver=lambda h: [PUBLIC_IP]
    ) is not None


def test_noncanonical_ipv4_encodings_resolved_to_loopback_blocked() -> None:
    # Decimal and hex IPv4 encodings normalize to loopback through real
    # address conversion; the all-pass rule rejects whatever they become.
    encoded = {
        "0x7f000001": ["127.0.0.1"],
        "2130706433": ["127.0.0.1"],
        "0177.0.0.1": ["127.0.0.1"],
    }

    def resolver(host: str) -> list[str]:
        assert host in encoded, host
        return encoded[host]

    for literal in encoded:
        with pytest.raises(FetchBlockedError):
            check_url(f"http://{literal}/", resolver=resolver)


class _DripFile:
    """Status/headers up front, then one byte per body read; every body
    byte read advances the fake clock."""

    HEADERS = deque([b"HTTP/1.1 200 OK\r\n", b"Content-Length: 100\r\n", b"\r\n"])

    def __init__(self, clock: dict) -> None:
        self._lines = _DripFile.HEADERS.copy()
        self._remaining = 100
        self._clock = clock

    def readline(self, size: int | None = None) -> bytes:  # type: ignore[no-untyped-def]
        if size is not None and size <= 0:
            return b""
        try:
            return self._lines.popleft()
        except IndexError:
            return b""

    def read(self, size: int) -> bytes:
        self._clock["t"] += 1.0
        if self._remaining <= 0:
            return b""
        self._remaining -= 1
        return b"a"

    def flush(self) -> None:
        pass

    def close(self) -> None:
        pass


class _DripSock(_FakeSock):
    def __init__(self, received: bytearray, clock: dict) -> None:
        super().__init__(received, b"")
        self._clock = clock

    def makefile(self, mode: str, *args: object, **kwargs: object) -> object:  # type: ignore[no-untyped-def]
        assert mode == "rb"
        return _DripFile(self._clock)


def test_pinned_drip_response_hits_read_deadline(monkeypatch) -> None:
    # One byte per read: each socket op stays inside the socket timeout, so
    # only the per-exchange deadline ends the fetch. The connection must
    # still have been dialed to the pinned public IP first.
    clock = {"t": 0.0}

    def fake_monotonic() -> float:
        return clock["t"]

    monkeypatch.setattr(time, "monotonic", fake_monotonic)

    dialed: dict = {}

    def fake_create_connection(address, timeout: float | None = None, source_address=None) -> _DripSock:  # type: ignore[no-untyped-def]
        dialed["addr"] = address
        return _DripSock(received=bytearray(), clock=clock)

    monkeypatch.setattr(socket, "create_connection", fake_create_connection)

    transport = fetch_mod.PinnedTransport(
        resolver=lambda h: [PUBLIC_IP], timeout_s=3.0, max_bytes=1_000_000
    )
    request = httpx.Request("GET", f"http://{PUBLIC_IP}/drip")
    with pytest.raises(fetch_mod.FetchTimeoutError):
        transport.handle_request(request)
    assert dialed["addr"] == (PUBLIC_IP, 80)


def test_whole_fetch_budget_spans_redirect_hops() -> None:
    # Redirect hops cannot stack unbounded wall-clock time: the third hop
    # (after the budget is exhausted) is checked BEFORE its outbound request,
    # so the mock transport only ever sees three requests.
    t = {"now": 0.0}

    def clock() -> float:
        return t["now"]

    calls = {"n": 0}

    def resolver(host: str) -> list[str]:
        assert host == "public.example", host
        return [PUBLIC_IP]

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] > 3:
            raise AssertionError("fourth request reached the transport")
        t["now"] += 20.0
        return httpx.Response(302, headers={"location": "/r2"})

    with pytest.raises(FetchTimeoutError, match="total time budget"):
        fetch_url_text(
            "https://public.example/r1",
            resolver=resolver,
            transport=httpx.MockTransport(handler),
            policy=FetchPolicy(timeout_s=10.0, max_redirects=3),
            clock=clock,
        )
    assert calls["n"] == 3


def test_whole_budget_also_bounds_the_final_response() -> None:
    # Budget elapsed during the LAST response: the check after the
    # response must still abort, not return success.

    t = {"now": 0.0}

    def clock() -> float:
        return t["now"]

    def handler(request: httpx.Request) -> httpx.Response:
        t["now"] += 100.0
        return httpx.Response(200, text="late", request=request)

    with pytest.raises(FetchTimeoutError, match="total time budget"):
        fetch_url_text(
            "https://public.example/r1",
            resolver=lambda h: [PUBLIC_IP],
            transport=httpx.MockTransport(handler),
            policy=FetchPolicy(timeout_s=10.0, max_redirects=3),
            clock=clock,
        )


def test_oversized_response_headers_capped(monkeypatch) -> None:
    # A header block beyond HEADERS_MAX_BYTES fails the exchange before
    # the body is ever read; the dial still goes to the pinned IP.
    received = bytearray()
    dialed: dict = {}

    def fake_create_connection(address, timeout: float | None = None,
                               source_address=None) -> _FakeSock:  # type: ignore[no-untyped-def]
        dialed["addr"] = address
        # Many modest lines (each under http.client's 64KB per-line cap):
        # only the TOTAL header block overflows our cap first.
        block = b"".join(b"X-Y: %s\r\n" % (b"z" * 2048) for _ in range(100))
        return _FakeSock(received, b"HTTP/1.1 200 OK\r\n" + block + b"\r\nhello")

    monkeypatch.setattr(socket, "create_connection", fake_create_connection)

    transport = fetch_mod.PinnedTransport(
        resolver=lambda h: [PUBLIC_IP], timeout_s=5.0, max_bytes=1_000_000
    )
    request = httpx.Request("GET", f"http://{PUBLIC_IP}/huge-headers")
    with pytest.raises(FetchTooLargeError, match="headers exceed cap"):
        transport.handle_request(request)
    assert dialed["addr"] == (PUBLIC_IP, 80)
