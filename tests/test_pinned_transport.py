"""DNS-pinning transport: fake DNS + fake sockets, no live network."""

from __future__ import annotations

import io
import socket
import ssl

import httpx
import pytest

from nerdbot import fetch as fetch_mod
from nerdbot.fetch import FetchBlockedError, PinnedTransport, check_url

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


def test_default_tls_context_verifies(monkeypatch) -> None:
    # Verification itself must stay intact: real default context properties.
    real_create = ssl.create_default_context
    ctx = real_create()
    assert ctx.check_hostname is True
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("no network in tests")))
    assert check_url("https://public.example/", resolver=lambda h: [PUBLIC_IP])
