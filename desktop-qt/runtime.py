"""Find an existing project backend or own one child process without blocking Qt."""
from __future__ import annotations

import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from typing import Any, Callable

from PyQt6.QtCore import (QLockFile, QObject, QProcess, QProcessEnvironment,
                          QStandardPaths, QTimer, pyqtSignal)
from PyQt6.QtNetwork import QNetworkAccessManager, QNetworkProxy, QNetworkReply, QNetworkRequest

from backend_client import extract_boot_token, local_request


BACKEND_PROTOCOL = "go-antigravity/desktop-v1"


def packaged_data_directory(environment: QProcessEnvironment) -> Path:
    base = (environment.value("LOCALAPPDATA").strip()
            or environment.value("APPDATA").strip())
    if base:
        return (Path(base) / "Go-Antigravity").resolve()
    return (Path.home() / "AppData" / "Local" / "Go-Antigravity").resolve()


def backend_data_directory(root: Path, environment: QProcessEnvironment) -> Path:
    configured = environment.value("GO_ANTIGRAVITY_DATA_DIR").strip()
    if configured:
        return (root / configured).resolve()
    if environment.value("GO_ANTIGRAVITY_PACKAGED").strip() == "1":
        return packaged_data_directory(environment)
    return (root / ".go-antigravity-data").resolve()


def data_directory_id(directory: Path) -> str:
    canonical = directory.resolve().as_posix()
    if os.name == "nt":
        canonical = canonical.lower()
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def backend_node_executable(environment: QProcessEnvironment) -> Path | None:
    """Honor the bootstrap's validated system Node, or look up node.exe on PATH."""
    selected = environment.value("GO_ANTIGRAVITY_NODE_EXE").strip() or QStandardPaths.findExecutable("node.exe")
    if not selected:
        return None
    candidate = Path(selected).resolve()
    return candidate if candidate.name.lower() == "node.exe" and candidate.is_file() else None


def is_project_backend_process(root: Path, process: dict[str, Any]) -> bool:
    """Match the actual absolute entry argument; an executable alone proves nothing."""
    executable = process.get("executable")
    command = process.get("commandLine")
    if not isinstance(executable, str) or not isinstance(command, str):
        return False
    tokens = [quoted if quoted else plain for quoted, plain in re.findall(r'"([^\"]*)"|(\S+)', command)]
    if len(tokens) < 2:
        return False
    normalize = lambda value: ntpath.normcase(ntpath.normpath(value))
    expected = normalize(str(Path(root).resolve() / "backend" / "server.js"))
    node = ntpath.basename(executable).lower()
    return (node == "node.exe" and ntpath.isabs(tokens[1])
            and normalize(tokens[1]) == expected)


def _temporary_prefix(root: Path) -> str:
    key = hashlib.sha256(str(Path(root).resolve()).casefold().encode("utf-8")).hexdigest()[:16]
    return f"goagy-qt-{key}-"


def _process_is_running(pid: int) -> bool:
    """Unknown/access-denied state is live: recovery must never guess a process dead."""
    if type(pid) is not int or pid <= 0:
        return True
    if os.name != "nt":
        return True
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: PID absent
    try:
        code = wintypes.DWORD()
        return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
    finally:
        kernel.CloseHandle(handle)


def cleanup_orphaned_temporary(root: Path, *, base: Path | None = None,
                               now: float | None = None,
                               process_is_running: Callable[[int], bool] = _process_is_running) -> list[Path]:
    """Recover only old, marked directories of this checkout with both owners gone."""
    directory = Path(base) if base is not None else Path(tempfile.gettempdir())
    current = time.time() if now is None else now
    removed = []
    try:
        candidates = directory.glob(_temporary_prefix(root) + "*")
        for candidate in candidates:
            try:
                if (not candidate.is_dir() or candidate.is_symlink()
                        or getattr(candidate.stat(), "st_file_attributes", 0) & 0x400):
                    continue
                marker = candidate / "owner.json"
                if marker.is_symlink() or marker.stat().st_size > 4096:
                    continue
                owner = json.loads(marker.read_text(encoding="utf-8"))
                created = owner.get("created")
                if (owner.get("version") != 1 or owner.get("project") != str(Path(root).resolve())
                        or type(created) not in (int, float) or not 0 <= created <= current - 86400
                        or type(owner.get("pid")) is not int or owner["pid"] <= 0
                        or type(owner.get("childPid")) is not int or owner["childPid"] <= 0):
                    continue
                if process_is_running(owner["pid"]) or (owner["childPid"] and process_is_running(owner["childPid"])):
                    continue
                allowed = {"owner.json", "ready.json"}
                if owner.get("testMode") is True:
                    allowed.add("data")
                if any(item.name not in allowed or item.is_symlink() or getattr(item.stat(), "st_file_attributes", 0) & 0x400
                       for item in candidate.iterdir()):
                    continue
                shutil.rmtree(candidate)
                removed.append(candidate)
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    except OSError:
        pass
    return removed


class BackendRuntime(QObject):
    ready = pyqtSignal(str)
    failed = pyqtSignal(str)
    closed = pyqtSignal()

    def __init__(self, root: Path, parent: QObject | None = None, test_mode: bool = False):
        super().__init__(parent)
        self.root = Path(root).resolve()
        self.test_mode = test_mode
        self.base_url = ""
        self.owns_process = False
        self._active = False
        self._closing = False
        self._ready_emitted = False
        self._child: QProcess | None = None
        self._discovery: QProcess | None = None
        self._network = QNetworkAccessManager(self)
        self._network.setProxy(QNetworkProxy(QNetworkProxy.ProxyType.NoProxy))
        self._replies: set[QNetworkReply] = set()
        self._existing_pids: list[int] = []
        self._probe_running = False
        self._temporary: tempfile.TemporaryDirectory | None = None
        self._ready_path: Path | None = None
        self._data_directory = backend_data_directory(self.root, QProcessEnvironment.systemEnvironment())
        self._lock: QLockFile | None = None
        self._lock_deadline = 0.0
        self._startup_deadline = 0.0
        self._waiting_for_lock = False
        self._poll = QTimer(self)
        self._poll.setInterval(150)
        self._poll.timeout.connect(self._poll_ready)
        self._kill_timer = QTimer(self)
        self._kill_timer.setSingleShot(True)
        self._kill_timer.timeout.connect(self._force_close)

    def start(self) -> None:
        if self._active or self._closing:
            return
        self._active = True
        self._ready_emitted = False
        self._waiting_for_lock = False
        self.base_url = ""
        self._existing_pids = []
        self._probe_running = False
        if self.test_mode:
            self._spawn_backend()
        else:
            self._discover()

    def _discover(self) -> None:
        if not self._active or self._closing:
            return
        self._existing_pids = []
        script = (
            "$ErrorActionPreference='Stop';"
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
            "$processes=@(Get-CimInstance Win32_Process | Where-Object {"
            "$_.Name -ieq 'node.exe'"
            "} | ForEach-Object {@{pid=[int]$_.ProcessId;executable=$_.ExecutablePath;commandLine=$_.CommandLine}});"
            "$ids=@($processes | ForEach-Object {$_.pid});$listeners=@();if($ids.Count -gt 0){"
            "$listeners=@(Get-NetTCPConnection -State Listen | Where-Object {"
            "$ids -contains [int]$_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1'"
            "} | ForEach-Object {@{pid=[int]$_.OwningProcess;port=[int]$_.LocalPort}})};"
            "@{processes=$processes;listeners=$listeners}|ConvertTo-Json -Depth 4 -Compress"
        )
        powershell = QStandardPaths.findExecutable("powershell.exe")
        if not powershell:
            self._discovery_unavailable()
            return
        process = QProcess(self)
        self._discovery = process
        process.setProcessChannelMode(QProcess.ProcessChannelMode.SeparateChannels)
        output = bytearray()
        finished = {"done": False, "overflow": False}
        watchdog = QTimer(process)
        watchdog.setSingleShot(True)

        def drain() -> None:
            output.extend(bytes(process.readAllStandardOutput()))
            process.readAllStandardError()
            if len(output) > 256 * 1024:
                finished["overflow"] = True
                process.kill()

        def complete(*_args: Any) -> None:
            if finished["done"]:
                return
            finished["done"] = True
            watchdog.stop()
            drain()
            self._discovery = None
            process.deleteLater()
            if self._closing:
                self._finish_close()
                return
            if not self._active:
                return
            if finished["overflow"] or process.exitCode() != 0:
                self._discovery_unavailable()
                return
            try:
                payload = json.loads(bytes(output).decode("utf-8-sig"))
                if "processes" not in payload or "listeners" not in payload:
                    raise ValueError("Missing discovery records")
                processes = payload.get("processes") or []
                listeners = payload.get("listeners") or []
                if not isinstance(processes, list) or not isinstance(listeners, list):
                    raise ValueError("Invalid discovery records")
                self._existing_pids = [value["pid"] for value in processes
                                       if isinstance(value, dict) and type(value.get("pid")) is int
                                       and value["pid"] > 0 and is_project_backend_process(self.root, value)]
                candidates = [value["port"] for value in listeners
                              if isinstance(value, dict) and value.get("pid") in self._existing_pids
                              and type(value.get("port")) is int and 1 <= value["port"] <= 65535]
            except (ValueError, TypeError, AttributeError):
                self._discovery_unavailable()
                return
            self._try_candidates(candidates, self._after_discovery)

        process.readyReadStandardOutput.connect(drain)
        process.readyReadStandardError.connect(drain)
        process.finished.connect(complete)
        process.errorOccurred.connect(lambda _error: complete() if process.state() == QProcess.ProcessState.NotRunning else None)
        watchdog.timeout.connect(lambda: process.kill())
        process.start(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
        watchdog.start(10000)

    def _discovery_unavailable(self) -> None:
        self._fail("无法确认现有后端进程，请检查 PowerShell 与本机 TCP 查询权限后重试")

    def _try_candidates(self, candidates: list[int], on_missing: Callable[[], None]) -> None:
        ports = list(dict.fromkeys(candidates))

        def step() -> None:
            if not self._active or self._closing:
                return
            if not ports:
                on_missing()
                return
            port = ports.pop(0)
            self._verify_backend(port, lambda valid: self._become_ready(port) if valid else step())

        step()

    def _verify_backend(self, port: int, callback: Callable[[bool], None]) -> None:
        origin = f"http://127.0.0.1:{port}"

        def html_done(status: int, data: bytes) -> None:
            try:
                if status != 200:
                    raise ValueError
                token = extract_boot_token(data.decode("utf-8", errors="replace"))
            except ValueError:
                callback(False)
                return

            def status_done(code: int, raw: bytes) -> None:
                try:
                    value = json.loads(raw.decode("utf-8"))
                    valid = (code == 200 and isinstance(value, dict)
                             and value.get("backendProtocol") == BACKEND_PROTOCOL
                             and value.get("dataDirectoryId") == data_directory_id(self._data_directory)
                             and value.get("updatesEnabled") is False
                             and all(key in value for key in ("phase", "accounts", "capabilities", "mobile")))
                except (ValueError, OSError):
                    valid = False
                callback(valid)

            self._get(origin + "/api/status", status_done, token)

        self._get(origin + "/", html_done)

    def _get(self, url: str, callback: Callable[[int, bytes], None], token: str = "") -> None:
        request = local_request(url)
        if token:
            request.setRawHeader(b"X-Goagy-Token", token.encode("ascii"))
        reply = self._network.get(request)
        self._replies.add(reply)
        timer = QTimer(reply)
        timer.setSingleShot(True)
        timer.timeout.connect(reply.abort)
        buffer = bytearray()

        def consume() -> None:
            if reply.isOpen():
                buffer.extend(bytes(reply.readAll()))
            if len(buffer) > 8 * 1024 * 1024:
                reply.abort()

        def done() -> None:
            timer.stop()
            consume()
            self._replies.discard(reply)
            code = reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute) or 0
            success = reply.error() == QNetworkReply.NetworkError.NoError
            reply.deleteLater()
            if self._active and not self._closing:
                callback(int(code) if success else 0, bytes(buffer))

        reply.readyRead.connect(consume)
        reply.finished.connect(done)
        timer.start(1200)

    def _after_discovery(self) -> None:
        if self._existing_pids:
            self._fail("已发现同目录的后端，但版本、数据目录或接口不匹配。请关闭旧后端或等待启动完成后重试")
            return
        if self._waiting_for_lock:
            self._waiting_for_lock = False
            self._spawn_backend()
            return
        self._acquire_launch_lock()

    def _acquire_launch_lock(self) -> None:
        try:
            self._data_directory.mkdir(parents=True, exist_ok=True)
        except OSError:
            self._fail("无法创建 Go-Antigravity 数据目录，请检查用户目录权限")
            return
        self._lock = QLockFile(str(self._data_directory / ".desktop-qt-backend.lock"))
        self._lock.setStaleLockTime(0)
        self._lock_deadline = time.monotonic() + 20
        self._try_launch_lock()

    def _try_launch_lock(self) -> None:
        if not self._active or self._closing or self._lock is None:
            return
        if self._lock.tryLock(0):
            # Re-scan after obtaining the lock: another Qt instance may have started a backend.
            self._waiting_for_lock = True
            self._discover()
        elif time.monotonic() >= self._lock_deadline:
            self._fail("另一个桌面窗口正在准备后端，请稍后重试")
        else:
            QTimer.singleShot(250, self._try_launch_lock)

    def _spawn_backend(self) -> None:
        environment = QProcessEnvironment.systemEnvironment()
        executable = backend_node_executable(environment)
        source = self.root / "backend" / "server.js"
        if executable is None or not source.is_file():
            self._fail("未找到 Node.js 22.13+ 或 backend/server.js，请使用项目启动脚本准备依赖")
            return
        cleanup_orphaned_temporary(self.root)
        try:
            self._temporary = tempfile.TemporaryDirectory(prefix=_temporary_prefix(self.root))
        except OSError:
            self._fail("无法创建本地后端运行目录，请检查临时目录权限")
            return
        temporary = Path(self._temporary.name)
        self._temporary_owner = {"version": 1, "project": str(self.root), "created": time.time(),
                                 "pid": os.getpid(), "childPid": 0, "testMode": self.test_mode}
        try:
            self._write_temporary_owner()
        except OSError:
            self._fail("无法记录本地后端运行目录，请检查临时目录权限")
            return
        self._ready_path = temporary / "ready.json"
        environment.insert("GO_ANTIGRAVITY_QT_HOST", "1")
        environment.insert("GO_ANTIGRAVITY_READY_FILE", str(self._ready_path))
        if self.test_mode:
            self._data_directory = temporary / "data"
        environment.insert("GO_ANTIGRAVITY_DATA_DIR", str(self._data_directory))
        if self.test_mode:
            environment.insert("GO_ANTIGRAVITY_TEST_MODE", "1")
        else:
            environment.remove("GO_ANTIGRAVITY_TEST_MODE")
        child = QProcess(self)
        self._child = child
        self.owns_process = True
        child.setWorkingDirectory(str(self.root))
        child.setProcessEnvironment(environment)
        child.setProcessChannelMode(QProcess.ProcessChannelMode.SeparateChannels)
        # Both channels are deliberately discarded; native events can contain sensitive material.
        child.readyReadStandardOutput.connect(lambda: child.readAllStandardOutput())
        child.readyReadStandardError.connect(lambda: child.readAllStandardError())
        child.started.connect(self._record_child_owner)
        child.finished.connect(self._child_finished)
        child.errorOccurred.connect(self._child_error)
        self._startup_deadline = time.monotonic() + 30
        child.start(str(executable), [str(source)])
        self._poll.start()

    def _write_temporary_owner(self) -> None:
        if self._temporary is not None:
            (Path(self._temporary.name) / "owner.json").write_text(json.dumps(self._temporary_owner), encoding="utf-8")

    def _record_child_owner(self) -> None:
        if self._child is not None and self._temporary is not None:
            self._temporary_owner["childPid"] = int(self._child.processId())
            try:
                self._write_temporary_owner()
            except OSError:
                self._fail("无法记录本地后端运行目录，请检查临时目录权限")

    def _poll_ready(self) -> None:
        if not self._active or self._closing or self._ready_path is None or self._probe_running:
            return
        if time.monotonic() >= self._startup_deadline:
            self._fail("本地后端启动超时，请检查项目依赖后重试")
            return
        try:
            if not self._ready_path.is_file() or self._ready_path.stat().st_size > 2048:
                return
            payload = json.loads(self._ready_path.read_text(encoding="utf-8"))
            port, pid = payload.get("port"), payload.get("pid")
            if (not isinstance(port, int) or not 1 <= port <= 65535 or self._child is None
                    or pid != int(self._child.processId())):
                return
        except (OSError, ValueError, TypeError, AttributeError):
            return
        self._probe_running = True

        def checked(valid: bool) -> None:
            self._probe_running = False
            if valid:
                self._become_ready(port)

        self._verify_backend(port, checked)

    def _become_ready(self, port: int) -> None:
        if not self._active or self._closing or self._ready_emitted:
            return
        self._poll.stop()
        self._release_lock()
        self._ready_emitted = True
        self.base_url = f"http://127.0.0.1:{port}"
        self.ready.emit(self.base_url)

    def _child_error(self, error: QProcess.ProcessError) -> None:
        if error == QProcess.ProcessError.FailedToStart and self._active and not self._closing:
            self._fail("无法启动项目内 Node 后端，请检查可执行文件")

    def _child_finished(self, *_args: Any) -> None:
        self._poll.stop()
        self._kill_timer.stop()
        self._release_lock()
        was_active = self._active
        self.owns_process = False
        child = self._child
        self._child = None
        if child is not None:
            child.deleteLater()
        self._cleanup_temporary()
        if self._closing:
            self._finish_close()
        elif was_active:
            self._active = False
            self.failed.emit("本地后端已退出，请重新启动桌面窗口")

    def _release_lock(self) -> None:
        if self._lock is not None and self._lock.isLocked():
            self._lock.unlock()
        self._lock = None

    def _cleanup_temporary(self) -> None:
        self._ready_path = None
        if self._temporary is not None:
            try:
                self._temporary.cleanup()
            except OSError:
                pass
            self._temporary = None

    def _fail(self, message: str) -> None:
        if not self._active:
            return
        self.close()
        self.failed.emit(message)

    def close(self) -> None:
        """Only terminate the process this instance spawned; never touch a reused backend."""
        if self._closing:
            return
        self._active = False
        self._closing = True
        self._poll.stop()
        self._release_lock()
        for reply in tuple(self._replies):
            reply.abort()
        self._replies.clear()
        if self._discovery is not None:
            self._discovery.kill()
        child = self._child
        if self.owns_process and child is not None and child.state() != QProcess.ProcessState.NotRunning:
            child.write(b"quit\n")
            child.closeWriteChannel()
            self._kill_timer.start(8000)
        else:
            self.owns_process = False
            self._child = None
            if child is not None:
                child.deleteLater()
            self._cleanup_temporary()
            QTimer.singleShot(0, self._finish_close)

    def _finish_close(self) -> None:
        if self._closing and self._discovery is None and self._child is None:
            self._closing = False
            self.closed.emit()

    def _force_close(self) -> None:
        child = self._child
        if self.owns_process and child is not None and child.state() != QProcess.ProcessState.NotRunning:
            child.kill()
