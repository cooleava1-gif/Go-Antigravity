"""Asynchronous Qt client for the existing loopback-only Go-Antigravity API."""
from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import urlsplit

from PyQt6.QtCore import QObject, QTimer, QUrl, pyqtSignal
from PyQt6.QtNetwork import QNetworkAccessManager, QNetworkProxy, QNetworkReply, QNetworkRequest

_BOOT_TOKEN = re.compile(r'window\.__GOAGY_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")\s*;')


def validate_base_url(value: str) -> str:
    """Accept only the backend's HTTP loopback origin, never credentials or paths."""
    try:
        parsed = urlsplit(value)
        port = parsed.port or 80
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
                or not 1 <= port <= 65535):
            raise ValueError
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("后端地址必须是本机 HTTP 地址") from exc
    host = "[::1]" if parsed.hostname == "::1" else parsed.hostname
    return f"http://{host}:{port}"


def extract_boot_token(html: str) -> str:
    match = _BOOT_TOKEN.search(html)
    if not match:
        raise ValueError("本地服务未提供有效的 Go-Antigravity 会话")
    try:
        token = json.loads(match.group(1))
    except (ValueError, TypeError) as exc:
        raise ValueError("本地服务会话格式无效") from exc
    if not isinstance(token, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", token):
        raise ValueError("本地服务会话格式无效")
    return token


def local_request(url: str) -> QNetworkRequest:
    request = QNetworkRequest(QUrl(url))
    request.setAttribute(QNetworkRequest.Attribute.RedirectPolicyAttribute,
                         QNetworkRequest.RedirectPolicy.ManualRedirectPolicy)
    request.setAttribute(QNetworkRequest.Attribute.CacheLoadControlAttribute,
                         QNetworkRequest.CacheLoadControl.AlwaysNetwork)
    request.setRawHeader(b"Accept", b"application/json, text/html")
    return request


class BackendClient(QObject):
    status_received = pyqtSignal(dict)
    logs_received = pyqtSignal(list)
    operation_finished = pyqtSignal(str, object)
    error = pyqtSignal(str, str)
    connected = pyqtSignal(str)
    connection_changed = pyqtSignal(bool)

    def __init__(self, base_url: str, parent: QObject | None = None):
        super().__init__(parent)
        self.base_url = validate_base_url(base_url)
        self._network = QNetworkAccessManager(self)
        self._network.setProxy(QNetworkProxy(QNetworkProxy.ProxyType.NoProxy))
        self._token = ""
        self._running = False
        self._online = False
        self._generation = 0
        self._mutation_epoch = 0
        self._handshaking = False
        self._pending: dict[str, dict[str, Any]] = {}
        self._auth_waiters: set[str] = set()
        self._replies: set[QNetworkReply] = set()
        self._status_timer = QTimer(self)
        self._status_timer.setInterval(3000)
        self._status_timer.timeout.connect(self.refresh)
        self._logs_timer = QTimer(self)
        self._logs_timer.setInterval(5000)
        self._logs_timer.timeout.connect(self._refresh_logs)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._generation += 1
        self._status_timer.start()
        self._logs_timer.start()
        self._handshake()

    def stop(self) -> None:
        self._running = False
        self._generation += 1
        self._status_timer.stop()
        self._logs_timer.stop()
        self._handshaking = False
        self._token = ""
        self._pending.clear()
        self._auth_waiters.clear()
        for reply in tuple(self._replies):
            reply.abort()
        self._replies.clear()
        self._set_online(False)

    def refresh(self) -> None:
        self.request("status", "/api/status")

    def _refresh_logs(self) -> None:
        self.request("logs", "/api/logs?limit=120")

    def request(self, action: str, route: str, body: Any = None,
                method: str | None = None, timeout_ms: int = 20000) -> bool:
        """Queue one operation per action. A 401 is retried once after a fresh handshake."""
        if not self._running:
            return False
        if action in self._pending:
            return False
        try:
            parsed = urlsplit(route)
            if (not route.startswith("/api/") or route.startswith("//") or parsed.scheme
                    or parsed.netloc or parsed.fragment or "\r" in route or "\n" in route):
                raise ValueError("请求路径必须指向本机 API")
            verb = (method or ("POST" if body is not None else "GET")).upper()
            if verb not in {"GET", "POST"}:
                raise ValueError("不支持的请求方法")
            payload = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if payload is not None and len(payload) > 64 * 1024:
                raise ValueError("请求内容不能超过 64 KiB")
            timeout = max(1, int(timeout_ms))
        except (TypeError, ValueError, AttributeError):
            self.error.emit(action, "请求参数或本机 API 路径无效")
            return False
        operation = {"action": action, "route": route, "method": verb, "payload": payload,
                     "timeout": timeout, "retried": False, "body": body}
        self._pending[action] = operation
        if self._token:
            self._dispatch(operation)
        else:
            self._auth_waiters.add(action)
            self._handshake()
        return True

    def _set_online(self, online: bool) -> None:
        if self._online != online:
            self._online = online
            self.connection_changed.emit(online)

    def _safe_error(self, message: str, operation: dict | None = None) -> str:
        text = str(message)
        if self._token:
            text = text.replace(self._token, "[会话已隐藏]")
        body = (operation or {}).get("body")
        if isinstance(body, dict):
            for key in ("pin", "rawInput", "refreshToken", "tunnelToken", "callbackUrl", "code", "state", "promptText"):
                secret = body.get(key)
                if isinstance(secret, str) and secret:
                    text = text.replace(secret, "[敏感内容已隐藏]")
        prompt = body.get("promptText") if isinstance(body, dict) else None
        if isinstance(prompt, str) and prompt:
            fragments = {
                prompt,
                json.dumps(prompt, ensure_ascii=False)[1:-1],
                json.dumps(prompt)[1:-1],
                repr(prompt)[1:-1],
            }
            for fragment in fragments:
                if fragment:
                    text = text.replace(fragment, "[敏感内容已隐藏]")
            text = re.sub(
                r'(?i)("?promptText"?\s*[:=]\s*)"(?:\\.|[^"\\])*"',
                r'\1"[敏感内容已隐藏]"',
                text,
            )
            text = re.sub(
                r"(?i)(promptText\s*[:=]\s*)([^\s&,}]+)",
                r"\1[敏感内容已隐藏]",
                text,
            )
        text = re.sub(r"\b\d{8}\b", "[PIN 已隐藏]", text)
        text = re.sub(r"(?i)(token|pin)=([^&\s]+)", r"\1=[已隐藏]", text)
        return text[:600]

    def _fetch(self, route: str, method: str, payload: bytes | None, timeout_ms: int,
               callback: Callable[[int, bytes, str], None], authenticated: bool = True) -> None:
        request = local_request(self.base_url + route)
        if authenticated:
            request.setRawHeader(b"X-Goagy-Token", self._token.encode("ascii"))
        if payload is not None:
            request.setRawHeader(b"Content-Type", b"application/json; charset=utf-8")
        reply = (self._network.get(request) if method == "GET"
                 else self._network.post(request, payload or b""))
        self._replies.add(reply)
        generation = self._generation
        timer = QTimer(reply)
        timer.setSingleShot(True)
        state = {"timeout": False, "oversize": False}
        chunks = bytearray()

        def consume() -> None:
            if reply.isOpen():
                chunks.extend(bytes(reply.readAll()))
            if len(chunks) > 8 * 1024 * 1024:
                state["oversize"] = True
                reply.abort()

        def timeout() -> None:
            state["timeout"] = True
            reply.abort()

        def finished() -> None:
            timer.stop()
            consume()
            self._replies.discard(reply)
            status = reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute) or 0
            failure = ("请求超时，请检查本地代理或网络连接" if state["timeout"] else
                       "本地服务响应过大" if state["oversize"] else
                       "无法连接本地后端" if reply.error() != QNetworkReply.NetworkError.NoError and not status else "")
            data = bytes(chunks)
            reply.deleteLater()
            if self._running and generation == self._generation:
                callback(int(status), data, failure)

        reply.readyRead.connect(consume)
        reply.finished.connect(finished)
        timer.timeout.connect(timeout)
        timer.start(timeout_ms)

    def _handshake(self) -> None:
        if self._handshaking or not self._running:
            return
        self._handshaking = True
        generation = self._generation

        def complete(status: int, raw: bytes, failure: str) -> None:
            self._handshaking = False
            try:
                if failure or status != 200:
                    raise ValueError(failure or f"本地服务握手失败 ({status})")
                token = extract_boot_token(raw.decode("utf-8", errors="replace"))
            except ValueError as exc:
                self._token = ""
                self._set_online(False)
                if not self._running or generation != self._generation:
                    return
                waiters = tuple(self._auth_waiters)
                self._auth_waiters.clear()
                if not waiters:
                    self.error.emit("connect", self._safe_error(str(exc)))
                for action in waiters:
                    if not self._running or generation != self._generation:
                        return
                    self._finish_error(action, str(exc))
                return
            self._token = token
            self._set_online(True)
            if not self._running or generation != self._generation:
                return
            self.connected.emit(self.base_url)
            if not self._running or generation != self._generation:
                return
            waiters = tuple(self._auth_waiters)
            self._auth_waiters.clear()
            for action in waiters:
                operation = self._pending.get(action)
                if operation is not None:
                    self._dispatch(operation)
            self.refresh()
            self._refresh_logs()

        self._fetch("/", "GET", None, 5000, complete, authenticated=False)

    def _dispatch(self, operation: dict[str, Any]) -> None:
        action = operation["action"]
        generation = self._generation
        mutation_epoch = self._mutation_epoch

        def complete(status: int, raw: bytes, failure: str) -> None:
            if (not self._running or generation != self._generation
                    or self._pending.get(action) is not operation):
                return
            if action == "status" and mutation_epoch != self._mutation_epoch:
                # A successful write made this in-flight snapshot obsolete. Free
                # its slot before replacing the refresh a caller could not queue.
                self._pending.pop(action, None)
                self._auth_waiters.discard(action)
                self.refresh()
                return
            if status == 401 and not operation["retried"]:
                operation["retried"] = True
                self._token = ""
                self._set_online(False)
                if not self._running or generation != self._generation:
                    return
                self._auth_waiters.add(action)
                self._handshake()
                return
            try:
                data = json.loads(raw.decode("utf-8")) if not failure else None
            except (UnicodeDecodeError, ValueError):
                self._finish_error(action, "本地服务返回了无效 JSON")
                return
            if failure or not 200 <= status < 300 or (isinstance(data, dict) and data.get("ok") is False):
                if not status or status == 401:
                    self._set_online(False)
                    if not self._running or generation != self._generation:
                        return
                message = data.get("error") if isinstance(data, dict) else None
                self._finish_error(action, failure or message or f"请求失败 ({status})")
                return
            if action == "status" and not isinstance(data, dict):
                self._finish_error(action, "状态响应格式无效")
                return
            if action == "logs" and not isinstance(data, list):
                self._finish_error(action, "日志响应格式无效")
                return
            if operation["method"] == "POST":
                self._mutation_epoch += 1
            self._pending.pop(action, None)
            self._set_online(True)
            if not self._running or generation != self._generation:
                return
            if action == "status":
                if mutation_epoch != self._mutation_epoch:
                    self.refresh()
                    return
                self.status_received.emit(data)
            elif action == "logs":
                self.logs_received.emit(data)
            if not self._running or generation != self._generation:
                return
            self.operation_finished.emit(action, data)

        self._fetch(operation["route"], operation["method"], operation["payload"],
                    operation["timeout"], complete)

    def _finish_error(self, action: str, message: str) -> None:
        operation = self._pending.pop(action, None)
        self._auth_waiters.discard(action)
        self.error.emit(action, self._safe_error(message, operation))
