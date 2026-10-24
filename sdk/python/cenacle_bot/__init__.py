# SPDX-License-Identifier: Apache-2.0
"""The Python SDK for Cenacle bots.

A client for the API (with a bot token) and a WSGI app for what Cenacle sends to
bots: slash commands, interactions (buttons, menus, dialogs) and event
subscriptions, with the signature checked. Only the standard library is used.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

__all__ = ["SIGNATURE_HEADER", "Client", "CenacleError", "sign", "verify", "app"]

SIGNATURE_HEADER = "X-Cenacle-Signature"
MAX_AGE = 300  # seconds
MAX_BODY = 1 << 20


def _mac(secret: str, ts: int, body: bytes) -> str:
    return hmac.new(secret.encode(), str(ts).encode() + b"." + body, hashlib.sha256).hexdigest()


def sign(secret: str, body: bytes, at: Optional[float] = None) -> str:
    """The signature header value of a body (for tests of bots)."""
    ts = int(at if at is not None else time.time())
    return f"t={ts},v1={_mac(secret, ts, body)}"


def verify(secret: str, header: str, body: bytes, now: Optional[float] = None) -> bool:
    """Checks a signature header against the raw body, at most five minutes old."""
    parts = dict(p.split("=", 1) for p in (header or "").split(",") if "=" in p)
    try:
        ts = int(parts.get("t", ""))
    except ValueError:
        return False
    sig = parts.get("v1", "")
    current = now if now is not None else time.time()
    if not sig or abs(current - ts) > MAX_AGE:
        return False
    return hmac.compare_digest(_mac(secret, ts, body), sig)


class CenacleError(Exception):
    """An error answer of the API (application/problem+json)."""

    def __init__(self, status: int, code: str = "", detail: str = ""):
        super().__init__(f"cenacle: {status} {code}: {detail}")
        self.status, self.code, self.detail = status, code, detail


class Client:
    """Calls Cenacle's API with a bot token (cnb_…)."""

    def __init__(self, base_url: str, token: str, timeout: float = 30):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _do(self, method: str, path: str, body: Any = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 (the server's own address)
                raw = res.read(4 << 20)
        except urllib.error.HTTPError as err:
            problem: dict = {}
            try:
                problem = json.loads(err.read() or b"{}")
            except ValueError:
                pass
            raise CenacleError(err.code, problem.get("code", ""), problem.get("detail", "")) from None
        return json.loads(raw) if raw else None

    @staticmethod
    def _path(*parts: str) -> str:
        return "/".join(urllib.parse.quote(p, safe="") for p in parts)

    def post_message(self, channel_id: str, text: str = "", attachments: Optional[list] = None,
                     root_id: Optional[str] = None, nonce: Optional[str] = None) -> dict:
        """Sends a message to a channel the bot is in."""
        body: dict = {"body": text, "nonce": nonce or "sdk-" + secrets.token_hex(12)}
        if attachments:
            body["attachments"] = attachments
        if root_id:
            body["root_id"] = root_id
        return self._do("POST", "/api/channels/" + self._path(channel_id) + "/messages", body)

    def edit_message(self, channel_id: str, message_id: str, text: str) -> dict:
        return self._do("PATCH", "/api/channels/" + self._path(channel_id, "messages", message_id), {"body": text})

    def delete_message(self, channel_id: str, message_id: str) -> None:
        self._do("DELETE", "/api/channels/" + self._path(channel_id, "messages", message_id))

    def react(self, channel_id: str, message_id: str, emoji: str) -> None:
        self._do("PUT", "/api/channels/" + self._path(channel_id, "messages", message_id, "reactions", emoji))


Handler = Callable[[dict], Optional[dict]]


def app(secret: str, on_command: Optional[Handler] = None, on_interaction: Optional[Handler] = None,
        on_event: Optional[Callable[[dict], None]] = None):
    """A WSGI app for a bot: POST /command, /interaction and /event, each signed.

    Each handler gets the request as a dict and returns the answer as a dict
    (or None for an empty answer). An exception answers 500, so Cenacle shows an
    error (commands, interactions) or tries again later (events).
    """
    routes = {"/command": on_command, "/interaction": on_interaction, "/event": on_event}

    def wsgi(environ, start_response):
        def reply(status: str, payload: Any = None):
            body = json.dumps(payload).encode() if payload is not None else b""
            headers = [("Content-Type", "application/json")] if payload is not None else []
            start_response(status, headers + [("Content-Length", str(len(body)))])
            return [body]

        handler = routes.get(environ.get("PATH_INFO", ""))
        if environ.get("REQUEST_METHOD") != "POST" or handler is None:
            return reply("404 Not Found")
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            return reply("413 Payload Too Large")
        raw = environ["wsgi.input"].read(length)
        if not verify(secret, environ.get("HTTP_X_CENACLE_SIGNATURE", ""), raw):
            return reply("401 Unauthorized")
        try:
            request = json.loads(raw)
            out = handler(request)
        except Exception:  # noqa: BLE001 (any failure of the bot is a 500)
            return reply("500 Internal Server Error")
        if environ["PATH_INFO"] == "/event":
            return reply("204 No Content")
        return reply("200 OK", out or {})

    return wsgi
