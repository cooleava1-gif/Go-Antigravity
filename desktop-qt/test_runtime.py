"""Backend selection regressions: no real processes, network, or account access."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PyQt6.QtCore import QCoreApplication, QObject, pyqtSignal

import runtime

_REAL_PROCESS = runtime.QProcess


def windows_short_path(path: Path):
    """Return the 8.3 short form of an existing path, or None when the volume keeps none."""
    if os.name != "nt":
        return None
    import ctypes
    buffer = ctypes.create_unicode_buffer(32768)
    written = ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer))
    return buffer.value if 0 < written < len(buffer) else None


def discovery_process(payload, exit_code=0):
    class Discovery(QObject):
        readyReadStandardOutput = pyqtSignal()
        readyReadStandardError = pyqtSignal()
        finished = pyqtSignal(int, object)
        errorOccurred = pyqtSignal(object)
        ProcessChannelMode = _REAL_PROCESS.ProcessChannelMode
        ProcessState = _REAL_PROCESS.ProcessState

        def setProcessChannelMode(self, _mode):
            pass

        def readAllStandardOutput(self):
            output = getattr(self, "output", b"")
            self.output = b""
            return output

        def readAllStandardError(self):
            return b""

        def exitCode(self):
            return exit_code

        def state(self):
            return self.ProcessState.NotRunning

        def start(self, *_args):
            value = payload
            if isinstance(value, dict) and "pids" in value:
                ids = value["pids"] if isinstance(value["pids"], list) else [value["pids"]]
                ports = value.get("ports", [])
                ports = ports if isinstance(ports, list) else [ports]
                source = Path(__file__).resolve().parent.parent / "backend/server.js"
                value = {"processes": [{"pid": pid, "executable": "node.exe",
                                        "commandLine": f'node.exe "{source}"'} for pid in ids],
                         "listeners": [{"pid": ids[0] if ids else -1, "port": port} for port in ports]}
                if ports and not ids:
                    value = b"invalid-json"
            self.output = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.finished.emit(exit_code, None)

        def kill(self):
            raise AssertionError("Tests must not terminate a real process")

    return Discovery


class BackendOwnershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QCoreApplication.instance() or QCoreApplication([])

    def setUp(self):
        self.backend = runtime.BackendRuntime(Path(__file__).resolve().parent.parent)
        self.backend._active = True
        self.backend._acquire_launch_lock = Mock()
        self.backend._spawn_backend = Mock()
        self.ready = []
        self.errors = []
        self.requests = []
        self.backend.ready.connect(self.ready.append)
        self.backend.failed.connect(self.errors.append)
        self.compatible_ports = {19823, 32123}
        self.status = {"phase": "idle", "accounts": {}, "capabilities": {}, "mobile": {},
                       "backendProtocol": runtime.BACKEND_PROTOCOL, "updatesEnabled": False,
                       "dataDirectoryId": runtime.data_directory_id(self.backend._data_directory)}
        self.backend._get = self.synthetic_get

    def tearDown(self):
        self.backend.close()
        self.app.processEvents()

    def synthetic_get(self, url, callback, _token=""):
        self.requests.append(url)
        port = int(url.split(":")[2].split("/")[0])
        if port not in self.compatible_ports:
            callback(503, b"")
        elif url.endswith("/api/status"):
            callback(200, json.dumps(self.status).encode())
        else:
            callback(200, b'<script>window.__GO_ANTIGRAVITY_TOKEN__="0123456789abcdef0123456789abcdef";</script>')

    def discover(self, payload, *, exit_code=0):
        with patch.object(runtime, "QProcess", discovery_process(payload, exit_code)), patch.object(
            runtime, "QStandardPaths", SimpleNamespace(findExecutable=lambda _name: "mock-powershell.exe")
        ):
            self.backend._discover()

    def test_current_project_random_port_ignores_foreign_default(self):
        self.discover({"pids": [4242], "ports": [32123]})
        self.assertEqual(self.ready, ["http://127.0.0.1:32123"])
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(all(":32123/" in url for url in self.requests))
        self.assertFalse(self.backend.owns_process)

    def test_foreign_default_without_project_process_is_not_reused(self):
        self.discover({"pids": [], "ports": []})
        self.assertEqual(self.ready, [])
        self.assertEqual(self.requests, [])
        self.backend._acquire_launch_lock.assert_called_once()

    def test_project_owned_default_port_is_still_reused(self):
        self.discover({"pids": 4242, "ports": 19823})
        self.assertEqual(self.ready, ["http://127.0.0.1:19823"])
        self.assertEqual(self.errors, [])

    def assert_backend_rejected(self, **status):
        self.status.update(status)
        self.discover({"pids": [4242], "ports": [32123]})
        self.assertEqual(self.ready, [])
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(self.requests[-1].endswith("/api/status"))
        self.assertEqual(len(self.errors), 1)
        self.backend._acquire_launch_lock.assert_not_called()
        self.backend._spawn_backend.assert_not_called()

    def test_wrong_backend_protocol_is_not_reused(self):
        self.assert_backend_rejected(backendProtocol="legacy")

    def test_wrong_data_directory_is_not_reused(self):
        self.assert_backend_rejected(dataDirectoryId="different")

    def test_updates_enabled_backend_is_not_reused(self):
        self.assert_backend_rejected(updatesEnabled=True)

    def test_unresponsive_project_does_not_fall_back_to_foreign_default(self):
        self.compatible_ports = {19823}
        self.discover({"pids": [4242], "ports": [32123]})
        self.assertEqual(self.ready, [])
        self.assertEqual(self.requests, ["http://127.0.0.1:32123/"])
        self.assertEqual(len(self.errors), 1)
        self.backend._acquire_launch_lock.assert_not_called()
        self.backend._spawn_backend.assert_not_called()

    def test_invalid_discovery_does_not_probe_default(self):
        for payload in (b"invalid-json", {"pids": [], "ports": [19823]}):
            with self.subTest(payload=payload):
                self.backend._active = True
                self.backend._closing = False
                self.discover(payload)
                self.assertEqual(self.ready, [])
                self.assertEqual(self.requests, [])
        self.assertEqual(len(self.errors), 2)

    def test_only_mobile_and_foreign_project_processes_do_not_block_start(self):
        root = self.backend.root
        self.discover({"processes": [
            {"pid": 3, "executable": str(root / "go-antigravity-node.exe"),
             "commandLine": f'"{root / "go-antigravity-node.exe"}" "{root / "backend/mobile/server.mjs"}"'},
            {"pid": 4, "executable": "node.exe",
             "commandLine": f'node.exe "{root.parent / "foreign/backend/server.js"}"'}],
            "listeners": [{"pid": 3, "port": 19823}, {"pid": 4, "port": 32123}]})
        self.assertEqual(self.requests, [])
        self.assertEqual(self.backend._existing_pids, [])
        self.backend._acquire_launch_lock.assert_called_once()

    def test_backend_and_mobile_same_executable_probe_only_backend_port(self):
        root = self.backend.root
        self.discover({"processes": [
            {"pid": 3, "executable": str(root / "go-antigravity-node.exe"),
             "commandLine": f'"{root / "go-antigravity-node.exe"}" "{root / "backend/mobile/tunnel.mjs"}"'},
            {"pid": 4, "executable": "node.exe",
             "commandLine": f'node.exe "{root / "backend/server.js"}"'}],
            "listeners": [{"pid": 3, "port": 19823}, {"pid": 4, "port": 32123}]})
        self.assertEqual(self.ready, ["http://127.0.0.1:32123"])
        self.assertTrue(all(":32123/" in url for url in self.requests))

    def test_failed_discovery_does_not_probe_default(self):
        self.discover({"pids": [], "ports": []}, exit_code=1)
        self.assertEqual(self.ready, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(len(self.errors), 1)

    def test_missing_powershell_does_not_probe_default(self):
        with patch.object(runtime, "QStandardPaths", SimpleNamespace(findExecutable=lambda _name: "")):
            self.backend._discover()
        self.assertEqual(self.ready, [])
        self.assertEqual(self.requests, [])
        self.assertEqual(len(self.errors), 1)


class BackendDataDirectoryTests(unittest.TestCase):
    def test_legacy_settings_and_account_pool_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            legacy = base / "local" / "com.goagy.launcher.tauri"
            portable = root / "backend"
            for location in (legacy, portable):
                location.mkdir(parents=True)
                (location / "accounts.json").write_text("{}", encoding="utf-8")
                (location / "settings.json").write_text("{}", encoding="utf-8")
            environment = runtime.QProcessEnvironment()
            environment.insert("LOCALAPPDATA", str(base / "local"))
            environment.insert("LEGACY_DATA_DIR", str(legacy))
            expected = (root / ".go-antigravity-data").resolve()
            self.assertEqual(runtime.backend_data_directory(root, environment), expected)
            self.assertFalse(expected.exists())

    def test_explicit_independent_directory_can_be_absolute_or_checkout_relative(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            environment = runtime.QProcessEnvironment()
            for setting, expected in ((str(base / "custom"), base / "custom"),
                                      ("dedicated-data", root / "dedicated-data")):
                with self.subTest(setting=setting):
                    environment.insert("GO_ANTIGRAVITY_DATA_DIR", setting)
                    self.assertEqual(runtime.backend_data_directory(root, environment), expected.resolve())
                    self.assertFalse(expected.exists())


class BackendProcessIdentityTests(unittest.TestCase):
    def test_same_executable_mobile_and_other_project_are_excluded(self):
        root = Path(tempfile.gettempdir()) / "go-antigravity-synthetic-project"
        for executable, script in (("node.exe", root / "backend/mobile/server.mjs"),
                                   ("node.exe", root / "backend/mobile/tunnel.mjs"),
                                   ("node.exe", root.parent / "other/backend/server.js"),
                                   ("go-antigravity-node.exe", root / "backend/server.js")):
            with self.subTest(executable=executable, script=script):
                self.assertFalse(runtime.is_project_backend_process(root, {
                    "executable": executable, "commandLine": f'"{executable}" "{script}"'}))

    def test_system_node_absolute_backend_is_recognized(self):
        root = Path(tempfile.gettempdir()) / "go-antigravity project"
        script = root / "backend/server.js"
        self.assertTrue(runtime.is_project_backend_process(root, {
            "executable": r"C:\Program Files\nodejs\node.exe",
            "commandLine": f'"C:\\Program Files\\nodejs\\node.exe" "{script}"'}))

    def test_short_and_long_path_forms_of_the_same_entry_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "go-antigravity project"
            (root / "backend").mkdir(parents=True)
            (root / "backend/server.js").touch()
            short = windows_short_path(root)
            if not short or short.casefold() == str(root).casefold():
                self.skipTest("volume keeps no 8.3 short names")
            self.assertTrue(runtime.is_project_backend_process(root, {
                "executable": r"C:\Program Files\nodejs\node.exe",
                "commandLine": f'"C:\\Program Files\\nodejs\\node.exe" "{short}\\backend\\server.js"'}))

    def test_script_argument_not_incidental_text_must_match(self):
        root = Path(tempfile.gettempdir()) / "go-antigravity-project"
        expected = str(root / "backend/server.js")
        for command in (f'node.exe other.js "{expected}"', f'node.exe "{expected}.other"',
                        'node.exe backend/server.js', 'node.exe -e "backend/server.js"'):
            with self.subTest(command=command):
                self.assertFalse(runtime.is_project_backend_process(root, {
                    "executable": "node.exe", "commandLine": command}))

    def test_selected_or_system_node_passes_to_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "node.exe"
            selected.touch()
            obsolete = root / "legacy-node.exe"
            obsolete.touch()
            environment = runtime.QProcessEnvironment()
            environment.insert("LEGACY_NODE_EXE", str(obsolete))
            environment.insert("GO_ANTIGRAVITY_NODE_EXE", str(selected))
            self.assertEqual(runtime.backend_node_executable(environment), selected.resolve())
            environment.remove("GO_ANTIGRAVITY_NODE_EXE")
            with patch.object(runtime.QStandardPaths, "findExecutable", return_value=str(selected)):
                self.assertEqual(runtime.backend_node_executable(environment), selected.resolve())
            with patch.object(runtime.QStandardPaths, "findExecutable", return_value=""):
                self.assertIsNone(runtime.backend_node_executable(environment))
            environment.insert("GO_ANTIGRAVITY_NODE_EXE", str(obsolete))
            self.assertIsNone(runtime.backend_node_executable(environment))


class TemporaryOwnershipTests(unittest.TestCase):
    def test_only_old_owned_orphan_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            now = 1_800_000_000
            def make(name, **changes):
                target = base / (runtime._temporary_prefix(root) + name)
                target.mkdir()
                owner = {"version": 1, "project": str(root.resolve()), "created": now - 90000,
                         "pid": 41, "childPid": 42, "testMode": False}
                owner.update(changes)
                (target / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
                (target / "ready.json").write_text("{}", encoding="utf-8")
                return target
            stale = make("orphan")
            fresh = make("fresh", created=now - 10)
            foreign = make("foreign", project=str(base / "other"))
            parent_live = make("parent", pid=99)
            child_live = make("child", childPid=99)
            uncertain = make("uncertain", childPid=0)
            extra = make("extra")
            (extra / "real-config.yml").write_text("keep", encoding="utf-8")
            old_unmarked = base / "go-antigravity-qt-unmarked"
            old_unmarked.mkdir()
            result = runtime.cleanup_orphaned_temporary(root, base=base, now=now,
                                                       process_is_running=lambda pid: pid == 99)
            self.assertEqual(result, [stale])
            self.assertFalse(stale.exists())
            for target in (fresh, foreign, parent_live, child_live, uncertain, extra, old_unmarked):
                self.assertTrue(target.exists(), target.name)


class BackendCloseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QCoreApplication.instance() or QCoreApplication([])

    def test_reused_service_close_does_not_stop_or_kill(self):
        backend = runtime.BackendRuntime(Path(tempfile.gettempdir()))
        child = Mock()
        backend._child = child
        backend.owns_process = False
        backend._active = True
        backend.close()
        self.app.processEvents()
        child.write.assert_not_called()
        child.kill.assert_not_called()

    def test_owned_service_gets_quit_and_owned_temp_is_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = runtime.BackendRuntime(Path(directory))
            backend._temporary = tempfile.TemporaryDirectory(dir=directory)
            temporary = Path(backend._temporary.name)
            child = Mock()
            child.state.return_value = _REAL_PROCESS.ProcessState.Running
            backend._child = child
            backend.owns_process = True
            backend._active = True
            backend.close()
            child.write.assert_called_once_with(b"quit\n")
            child.closeWriteChannel.assert_called_once()
            child.kill.assert_not_called()
            backend._force_close()
            child.kill.assert_called_once()
            backend._child_finished()
            self.assertFalse(temporary.exists())
            self.assertFalse(backend.owns_process)


if __name__ == "__main__":
    unittest.main(verbosity=2)
