"""Update UI regressions: interaction, demo, cancel, dirty-cancel, failure-no-exit.

The core (`updater`) is always replaced by a synthetic in-process fake, and the
process-lifecycle cases run a real child process with a stubbed runtime, so no
network, no real account data and no real install ever happens here.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

if sys.platform == "win32" and os.environ.get("QT_QPA_PLATFORM") == "offscreen":
    system_fonts = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")
    if os.path.isdir(system_fonts):
        os.environ.setdefault("QT_QPA_FONTDIR", system_fonts)

from PyQt6.QtCore import QCoreApplication, QEvent, QSettings, Qt, QTemporaryDir
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QDialog

import main
import update_ui
from ui import MainWindow

DESKTOP_DIR = Path(__file__).resolve().parent
RELEASE_URL = "https://github.com/cooleava1-gif/Go-Antigravity/releases/tag/v1.1.1"


class FakeUpdater:
    """In-process stand-in for desktop-qt/updater.py (pure stdlib, no Qt)."""

    REPOSITORY = "cooleava1-gif/Go-Antigravity"
    ASSET_NAME = "Go-Antigravity-windows-x64.exe"

    class UpdateError(Exception):
        pass

    def __init__(self):
        self.build = {
            "version": "1.1.0", "commit": "1a2b3c4def", "packaged": True,
            "repository": self.REPOSITORY, "install_supported": True,
            "install_reason": "", "root": "", "launcher": "",
            "data_directory": "", "reason": "",
        }
        self.check_result = None
        self.check_error = None
        self.prepare_behavior = None
        self.install_error = None
        self.calls: list[tuple] = []
        self.threads: list[str] = []
        self.cancel_seen = threading.Event()

    # -- core surface -------------------------------------------------------
    def read_build(self, root):
        self.calls.append(("read_build", str(root)))
        return dict(self.build)

    def check_for_update(self, root, *, timeout=20.0):
        self.calls.append(("check_for_update", str(root), timeout))
        if self.check_error is not None:
            raise self.check_error
        if self.check_result is None:
            return {"current": dict(self.build), "latest": "1.1.0", "available": False,
                    "release_url": "", "notes": "", "published_at": "", "asset": None,
                    "reason": "up-to-date"}
        return dict(self.check_result)

    def prepare_update(self, root, release, *, progress=None, cancel=None):
        self.threads.append(threading.current_thread().name)
        self.calls.append(("prepare_update", str(root), release.get("latest")))
        if self.prepare_behavior is not None:
            return self.prepare_behavior(root, release, progress, cancel)
        if progress is not None:
            progress(512, 1024)
            progress(1024, 1024)
        return self._prepared(release)

    def launch_installer(self, root, prepared):
        self.calls.append(("launch_installer", str(root), prepared.get("staged")))
        if self.install_error is not None:
            raise self.install_error

    def cleanup_prepared(self, prepared):
        self.calls.append(("cleanup_prepared", prepared.get("staged")))

    # -- helpers ------------------------------------------------------------
    def _prepared(self, release):
        return {"version": release.get("latest", "1.1.1"), "root": "harness-root",
                "staged": "harness-staged", "backup": "harness-backup",
                "download": "harness.zip", "temp": "harness-temp",
                "asset_name": self.ASSET_NAME, "asset_size": 1024,
                "asset_sha256": "0" * 64, "release_url": release.get("release_url", ""),
                "published_at": "", "prepared_at": "0"}

    def make_available(self):
        self.check_result = {
            "current": dict(self.build), "latest": "1.1.1", "available": True,
            "release_url": RELEASE_URL, "notes": "修复若干问题", "published_at": "2026-11-20T00:00:00Z",
            "asset": {"name": self.ASSET_NAME, "url": "https://objects.githubusercontent.com/harness",
                      "size": 1024, "sha256": "0" * 64}, "reason": "",
        }
        return self.check_result

    def count(self, name):
        return sum(1 for call in self.calls if call[0] == name)


class UpdateUiTests(unittest.TestCase):
    """Strip + controller behaviour with a mocked core."""

    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyle("Fusion")
        cls.settings_dir = QTemporaryDir()
        QSettings.setDefaultFormat(QSettings.Format.IniFormat)
        QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, cls.settings_dir.path())

    def setUp(self):
        self.fake = FakeUpdater()
        self._patch = patch.object(update_ui, "_updater", self.fake)
        self._patch.start()
        self.addCleanup(self._patch.stop)
        # General UI cases exercise explicit shutdown independently of host tray support.
        tray_patch = patch("ui.create_tray", return_value=None)
        tray_patch.start()
        self.addCleanup(tray_patch.stop)
        self.window = MainWindow(demo=False)
        self.window.resize(940, 580)
        self.window.show()
        self.controller = self.window.update_controller
        self.strip = self.window.update_strip
        self.window.navigate(0, animate=False)
        self.window.settle_animations()
        self.pump()

    def tearDown(self):
        controller = getattr(self.window, "update_controller", None)
        if controller is not None:
            controller.cancel_download()
            controller.shutdown()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and update_ui._WORKERS:
            self.pump(3)
        self.window._closing = True
        self.window.hide()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    # -- helpers ------------------------------------------------------------
    def pump(self, rounds: int = 150) -> None:
        for _ in range(rounds):
            self.app.processEvents()
            # Yield to real worker threads and queued Windows paint/signal events.
            QTest.qWait(10)
            if self.controller._worker is None:
                break

    def available(self):
        self.fake.make_available()
        self.controller.check_now()
        self.pump()

    def confirmations(self, answers):
        asked: list[tuple] = []
        state = {"index": 0}

        def confirm(title, text):
            asked.append((title, text))
            answer = answers[state["index"]] if state["index"] < len(answers) else True
            state["index"] += 1
            return answer
        self.window.confirm = confirm
        return asked

    # -- identity -----------------------------------------------------------
    def test_strip_shows_packaged_build_identity(self):
        identity = self.strip.identity_label.text()
        self.assertIn("v1.1.0", identity)
        self.assertIn("1a2b3c4", identity)
        self.assertIn("正式包", identity)

    def test_strip_shows_development_build_identity(self):
        self.fake.build.update(packaged=False, commit="")
        self.controller.refresh_build()
        self.assertIn("v1.1.0", self.strip.identity_label.text())
        self.assertIn("开发版", self.strip.identity_label.text())

    def test_strip_does_not_squeeze_the_main_navigation(self):
        self.assertEqual(len(self.window.PAGES), 4)
        self.assertEqual(len(self.window.nav_buttons), 4)
        self.assertEqual(self.window.stack.count(), 4)
        # 版本小条不能挤占主导航：导航按钮仍保持各自的最小宽度。
        self.assertGreaterEqual(self.window.nav_buttons[0].minimumWidth(), 70)

    # -- startup / manual checks -------------------------------------------
    def test_startup_check_is_silent_and_runs_once_per_launch(self):
        self.fake.check_error = FakeUpdater.UpdateError("网络不可用，无法检查更新")
        self.controller.startup_check()
        self.pump()
        self.assertEqual(self.fake.count("check_for_update"), 1)
        self.controller.startup_check()
        self.pump()
        self.assertEqual(self.fake.count("check_for_update"), 1)
        self.assertTrue(self.window.notice.isHidden())
        self.assertIn("未完成", self.strip.status_label.text())
        self.assertEqual(self.strip.check_button.text(), "检查更新")

    def test_manual_check_failure_is_reported(self):
        self.fake.check_error = FakeUpdater.UpdateError("没有适合本机的发布资产")
        self.controller.check_now()
        self.pump()
        self.assertIn("没有适合本机的发布资产", self.window.notice.text())
        self.assertEqual(self.strip.check_button.text(), "检查更新")

    def test_up_to_date_leaves_no_action_button(self):
        self.controller.check_now()
        self.pump()
        self.assertIn("已是最新版本", self.strip.status_label.text())
        self.assertFalse(self.strip.action_button.isVisible())
        self.assertFalse(self.strip.release_button.isVisible())

    def test_up_to_date_after_available_clears_the_stale_release(self):
        self.available()
        self.assertTrue(self.strip.action_button.isVisible())
        self.assertTrue(self.strip.release_button.isVisible())
        self.fake.check_result = None
        self.controller.check_now()
        self.pump()
        self.assertIn("已是最新版本", self.strip.status_label.text())
        self.assertFalse(self.strip.action_button.isVisible())
        self.assertFalse(self.strip.release_button.isVisible())
        self.assertIsNone(self.controller._release)
        self.assertEqual(self.controller.release_url, "")
        self.controller.start_download()
        self.assertEqual(self.fake.count("prepare_update"), 0)

    def test_local_version_newer_than_release_reports_local_version(self):
        self.fake.check_result = {
            "current": {"version": "1.1.0"}, "latest": "1.0.0", "available": False,
            "release_url": RELEASE_URL, "notes": "", "published_at": "",
            "asset": None, "reason": "up-to-date",
        }
        self.controller.check_now()
        self.pump()
        self.assertIn("已是最新版本 v1.1.0", self.strip.status_label.text())
        self.assertNotIn("1.0.0", self.strip.status_label.text())
        self.assertFalse(self.strip.action_button.isVisible())
        self.controller.start_download()
        self.assertEqual(self.fake.count("prepare_update"), 0)

    def test_available_update_prompts_without_downloading_or_closing(self):
        self.fake.make_available()
        self.controller.startup_check()
        self.pump()
        self.assertIn("v1.1.1", self.strip.status_label.text())
        self.assertTrue(self.strip.action_button.isVisible())
        self.assertEqual(self.strip.action_button.text(), "下载并更新")
        self.assertEqual(self.fake.count("prepare_update"), 0)
        self.assertFalse(self.window._closing)
        self.assertTrue(self.window.isVisible())

    # -- download ------------------------------------------------------------
    def test_download_runs_off_the_main_thread_with_progress(self):
        self.available()
        started = threading.Event()

        def behavior(root, release, progress, cancel):
            started.set()
            progress(256, 1024)
            while not cancel.wait(0.05):
                pass
            raise FakeUpdater.UpdateError("下载已取消。")
        self.fake.prepare_behavior = behavior
        QTest.mouseClick(self.strip.action_button, Qt.MouseButton.LeftButton)
        self.assertTrue(started.wait(2))
        self.assertNotIn("MainThread", self.fake.threads)
        self.pump()
        self.assertEqual(self.strip.progress.value(), 25)
        self.assertIn("25%", self.strip.status_label.text())
        self.assertEqual(self.strip.action_button.text(), "取消")
        self.assertTrue(self.strip.progress.isVisible())
        self.controller.cancel_download()
        self.pump()
        self.assertFalse(update_ui._WORKERS)

    def test_cancel_is_event_driven_and_returns_to_available(self):
        self.available()

        def behavior(root, release, progress, cancel):
            progress(128, 1024)
            while not cancel.wait(0.05):
                pass
            self.fake.cancel_seen.set()
            raise FakeUpdater.UpdateError("下载已取消。")
        self.fake.prepare_behavior = behavior
        self.controller.start_download()
        self.pump(5)
        began = time.monotonic()
        self.controller.cancel_download()
        elapsed = time.monotonic() - began
        self.assertLess(elapsed, 1.0, "cancel must not block the GUI thread")
        self.pump()
        self.assertTrue(self.fake.cancel_seen.is_set())
        self.assertFalse(self.controller._downloading)
        self.assertEqual(self.strip.action_button.text(), "下载并更新")
        self.assertIn("取消", self.strip.status_label.text())
        self.assertFalse(update_ui._WORKERS)

    def test_download_ready_offers_restart_without_closing(self):
        self.available()
        self.controller.start_download()
        self.pump()
        self.assertIsNotNone(self.controller._prepared)
        self.assertEqual(self.strip.action_button.text(), "重启更新")
        self.assertEqual(self.strip.action_button.objectName(), "Primary")
        self.assertFalse(self.window._closing)

    def test_restart_reuses_close_confirmation_then_launches_installer(self):
        self.available()
        self.controller.start_download()
        self.pump()
        asked = self.confirmations([False])
        closings: list[int] = []
        self.window.closing.connect(lambda: closings.append(1))
        QTest.mouseClick(self.strip.action_button, Qt.MouseButton.LeftButton)
        self.pump()
        self.assertEqual([title for title, _ in asked], ["重启更新"])
        self.assertEqual(self.fake.count("launch_installer"), 0)
        self.assertFalse(self.window._closing)
        self.assertTrue(self.window.isVisible())
        self.assertEqual(closings, [])
        self.assertEqual(self.fake.count("cleanup_prepared"), 0)

        asked = self.confirmations([True])
        QTest.mouseClick(self.strip.action_button, Qt.MouseButton.LeftButton)
        self.pump()
        self.assertEqual(self.fake.count("launch_installer"), 1)
        self.assertTrue(self.window._closing)
        self.assertEqual(len(closings), 1)
        # A real handoff must keep the staged package, not clean it up.
        self.assertEqual(self.fake.count("cleanup_prepared"), 0)

    def test_dirty_settings_block_the_restart_and_keep_the_window_open(self):
        self.available()
        self.controller.start_download()
        self.pump()
        self.window._dirty.add("network")
        asked = self.confirmations([True, False])
        closings: list[int] = []
        self.window.closing.connect(lambda: closings.append(1))
        QTest.mouseClick(self.strip.action_button, Qt.MouseButton.LeftButton)
        self.pump()
        self.assertEqual([title for title, _ in asked], ["重启更新", "关闭工作台"])
        self.assertEqual(self.fake.count("launch_installer"), 0)
        self.assertFalse(self.window._closing)
        self.assertTrue(self.window.isVisible())
        self.assertEqual(closings, [])

    def test_installer_failure_keeps_the_window_open(self):
        self.available()
        self.controller.start_download()
        self.pump()
        self.fake.install_error = FakeUpdater.UpdateError("当前安装缺少 update_install.ps1")
        self.confirmations([True])
        QTest.mouseClick(self.strip.action_button, Qt.MouseButton.LeftButton)
        self.pump()
        self.assertEqual(self.fake.count("launch_installer"), 1)
        self.assertFalse(self.window._closing)
        self.assertTrue(self.window.isVisible())
        self.assertIn("update_install.ps1", self.window.notice.text())
        self.assertEqual(self.strip.action_button.text(), "重启更新")

    def test_tray_hide_keeps_prepared_package_until_explicit_exit(self):
        from unittest.mock import Mock
        self.available()
        self.controller.start_download()
        self.pump()
        self.window.tray = Mock()
        self.window._dirty.clear()
        self.window.close()
        self.pump()
        self.assertFalse(self.window.isVisible())
        self.assertFalse(self.window._closing)
        self.assertIsNotNone(self.controller._prepared)
        self.assertEqual(self.fake.count("cleanup_prepared"), 0)
        self.assertTrue(self.window.request_exit())
        self.pump()
        self.assertEqual(self.fake.count("cleanup_prepared"), 1)

    def test_restart_update_exits_even_with_tray_enabled(self):
        from unittest.mock import Mock
        self.window.tray = Mock()
        self.available()
        self.controller.start_download()
        self.pump()
        self.confirmations([True])
        closings = []
        self.window.closing.connect(lambda: closings.append(1))
        QTest.mouseClick(self.strip.action_button, Qt.MouseButton.LeftButton)
        self.pump()
        self.assertTrue(self.window._closing)
        self.assertEqual(closings, [1])
        self.assertEqual(self.fake.count("launch_installer"), 1)
        self.assertEqual(self.fake.count("cleanup_prepared"), 0)

    def test_normal_close_cleans_the_staged_download(self):
        self.available()
        self.controller.start_download()
        self.pump()
        self.window._dirty.clear()
        self.window.close()
        self.pump()
        self.assertEqual(self.fake.count("cleanup_prepared"), 1)
        self.assertEqual(self.fake.count("launch_installer"), 0)

    # -- unsupported installs -------------------------------------------------
    def test_source_install_refuses_download_but_opens_the_release_page(self):
        self.fake.build.update(packaged=False, install_supported=False,
                               install_reason="当前为源码目录，请从发布页下载安装包")
        self.controller.refresh_build()
        self.available()
        self.assertFalse(self.strip.action_button.isEnabled())
        self.assertIn("源码目录", self.strip.action_button.toolTip())
        self.controller.start_download()
        self.assertEqual(self.fake.count("prepare_update"), 0)
        self.assertIn("源码目录", self.window.notice.text())
        with patch.object(QDesktopServices, "openUrl", return_value=True) as opened:
            QTest.mouseClick(self.strip.release_button, Qt.MouseButton.LeftButton)
            self.pump()
        self.assertEqual(opened.call_args[0][0].toString(), RELEASE_URL)

    # -- closing lifecycle ----------------------------------------------------
    def test_closing_disables_the_strip_through_update_enabled(self):
        self.window._closing = True
        self.window._update_enabled()
        for button in (self.strip.check_button, self.strip.action_button, self.strip.release_button):
            self.assertFalse(button.isEnabled())
        self.window._closing = False
        self.window._update_enabled()
        self.assertTrue(self.strip.check_button.isEnabled())

    def test_close_during_download_cancels_without_deleting_the_worker(self):
        self.available()

        def behavior(root, release, progress, cancel):
            progress(64, 1024)
            while not cancel.wait(0.05):
                pass
            raise FakeUpdater.UpdateError("下载已取消。")
        self.fake.prepare_behavior = behavior
        self.controller.start_download()
        self.pump(5)
        worker = self.controller._worker
        self.assertIsNotNone(worker)
        self.window._dirty.clear()
        self.window.close()
        self.pump()
        self.assertFalse(worker.isRunning())
        self.assertFalse(worker in update_ui._WORKERS)
        self.assertIsNone(self.controller._worker)

    # -- demo ------------------------------------------------------------------
    def test_demo_never_touches_the_core_and_only_previews(self):
        self.fake.calls.clear()  # setUp 已记录一次 read_build，demo 窗口不应再调用核心
        demo = MainWindow(demo=True)
        try:
            demo.resize(940, 580)
            demo.show()
            demo.render_status(main.demo_snapshot())
            demo.set_logs(main.demo_logs())
            demo.navigate(0, animate=False)
            demo.settle_animations()
            self.app.processEvents()
            strip = demo.update_strip
            self.assertIn(f"v{update_ui.DEMO_VERSION}", strip.identity_label.text())
            self.assertIn("界面预览", strip.identity_label.text())
            self.assertEqual(strip.identity_label.text().count("界面预览"), 1)
            with patch.object(QDialog, "exec", side_effect=AssertionError("demo opened a dialog")):
                QTest.mouseClick(strip.check_button, Qt.MouseButton.LeftButton)
                self.app.processEvents()
            self.assertIn("预览模式", demo.notice.text())
            self.assertFalse(strip.action_button.isVisible())
            self.assertFalse(strip.release_button.isVisible())
            self.assertEqual(self.fake.calls, [])
            self.assertIsNone(demo.client)  # demo 从不连接真实后端
            self.assertNotIn("已连接", demo.connection.text())
        finally:
            demo._closing = True
            demo.hide()
            demo.deleteLater()
            QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

    # -- layout -----------------------------------------------------------------
    def test_strip_fits_the_minimum_window_without_overflow(self):
        self.window.resize(940, 580)
        self.window.navigate(0, animate=False)
        self.window.settle_animations()
        self.app.processEvents()
        self._assert_strip_inside_window()
        self.available()
        self.app.processEvents()
        self._assert_strip_inside_window()
        self.assertLessEqual(self.strip.height(), 56)

    def _assert_strip_inside_window(self):
        width = self.window.width()
        self.assertLessEqual(self.strip.width(), width)
        for button in (self.strip.check_button, self.strip.action_button, self.strip.release_button):
            if not button.isVisible():
                continue
            origin = button.mapTo(self.window, button.rect().topLeft())
            self.assertGreaterEqual(origin.x(), 0)
            self.assertLessEqual(origin.x() + button.width(), width)
        origin = self.strip.identity_label.mapTo(self.window, self.strip.identity_label.rect().topLeft())
        self.assertGreaterEqual(origin.x(), 0)
        self.assertLessEqual(origin.x() + self.strip.identity_label.width(), width)

    def test_minimum_width_screenshot_captures_the_update_strip(self):
        self.window.resize(940, 580)
        self.window.navigate(0, animate=False)
        self.window.settle_animations()
        self.available()
        self.app.processEvents()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "workbench-940-update.png"
            self.window.grab().save(str(target))
            self.assertGreater(target.stat().st_size, 2000)


class UpdateArgumentTests(unittest.TestCase):
    """--data-dir must be applied before the runtime and the updater exist."""

    def test_parse_arguments_accepts_data_dir(self):
        args = main.parse_arguments(["--data-dir", "C:/Users/x/data"])
        self.assertEqual(args.data_dir, "C:/Users/x/data")
        self.assertFalse(args.demo)
        args = main.parse_arguments(["--demo", "--quit-after", "10"])
        self.assertTrue(args.demo)
        self.assertEqual(args.quit_after, 10)
        self.assertEqual(args.data_dir, "")

    def test_apply_data_dir_sets_environment_only_when_given(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GO_ANTIGRAVITY_DATA_DIR", None)
            with tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / "data"
                main.apply_data_dir(str(target))
                self.assertEqual(os.environ["GO_ANTIGRAVITY_DATA_DIR"], str(target.resolve()))
            os.environ.pop("GO_ANTIGRAVITY_DATA_DIR", None)
            main.apply_data_dir(None)
            self.assertNotIn("GO_ANTIGRAVITY_DATA_DIR", os.environ)
            main.apply_data_dir("")
            self.assertNotIn("GO_ANTIGRAVITY_DATA_DIR", os.environ)


HARNESS_SOURCE = r'''
"""Hermetic child process: fake updater core, stubbed runtime, real Qt close path."""
import os
import sys
import time
import types

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else ".")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
system_fonts = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")
if os.path.isdir(system_fonts):
    os.environ.setdefault("QT_QPA_FONTDIR", system_fonts)

MODE = os.environ.get("HARNESS_MODE", "check")
SLOW = float(os.environ.get("HARNESS_SLOW_SECONDS", "3"))
CLICK_MS = int(os.environ.get("HARNESS_CLICK_MS", "0"))
CLOSE_MS = int(os.environ.get("HARNESS_CLOSE_MS", "2500"))

fake = types.ModuleType("updater")


class UpdateError(Exception):
    pass


fake.UpdateError = UpdateError
fake.REPOSITORY = "cooleava1-gif/Go-Antigravity"
fake.ASSET_NAME = "Go-Antigravity-windows-x64.exe"
BUILD = {"version": "1.1.0", "commit": "1a2b3c4def", "packaged": True,
         "repository": fake.REPOSITORY, "install_supported": True,
         "root": "", "launcher": "", "data_directory": "", "reason": ""}


def read_build(root):
    return dict(BUILD)


def check_for_update(root, *, timeout=20.0):
    print("HARNESS_CHECK_STARTED", flush=True)
    if MODE == "check":
        time.sleep(SLOW)
    return {"current": dict(BUILD), "latest": "1.1.1", "available": True,
            "release_url": "https://github.com/cooleava1-gif/Go-Antigravity/releases/tag/v1.1.1",
            "notes": "harness", "published_at": "", "reason": "",
            "asset": {"name": fake.ASSET_NAME, "url": "https://example.invalid/a.zip",
                      "size": 4096, "sha256": "0" * 64}}


def prepare_update(root, release, *, progress=None, cancel=None):
    print("HARNESS_DOWNLOAD_STARTED", flush=True)
    started = time.time()
    while not cancel.wait(0.05):
        if progress is not None:
            progress(min(4096, int((time.time() - started) * 256)), 4096)
        if MODE != "download-late-cancel" and time.time() - started > SLOW:
            break
    if MODE == "download-late-cancel":
        # Race: the core finished just as cancel arrived and still returns prepared.
        print("HARNESS_LATE_RETURN", flush=True)
        return {"version": "1.1.1", "root": str(root), "staged": "harness-staged",
                "backup": "harness-backup", "download": "harness.zip", "temp": "harness-temp",
                "asset_name": fake.ASSET_NAME, "asset_size": 4096, "asset_sha256": "0" * 64,
                "release_url": "", "published_at": "", "prepared_at": "0"}
    print("HARNESS_DOWNLOAD_CANCELLED", flush=True)
    raise UpdateError("下载已取消。")


def launch_installer(root, prepared):
    print("HARNESS_LAUNCH", flush=True)


def cleanup_prepared(prepared):
    print("HARNESS_CLEANUP", flush=True)


fake.read_build = read_build
fake.check_for_update = check_for_update
fake.prepare_update = prepare_update
fake.launch_installer = launch_installer
fake.cleanup_prepared = cleanup_prepared
sys.modules["updater"] = fake

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

import runtime


class _StubRuntime(QObject):
    ready = pyqtSignal(str)
    failed = pyqtSignal(str)
    closed = pyqtSignal()

    def __init__(self, root, parent=None):
        super().__init__(parent)

    def start(self):
        pass

    def close(self):
        QTimer.singleShot(0, self.closed.emit)


runtime.BackendRuntime = _StubRuntime

from ui import MainWindow

_show = MainWindow.show


def _show_and_schedule(self, *args):
    _show(self, *args)
    print("HARNESS_WINDOW_SHOWN", flush=True)

    def _close():
        print("HARNESS_CLOSING", flush=True)
        self.request_exit()

    if CLICK_MS > 0:
        def _click():
            strip = getattr(self, "update_strip", None)
            if strip is not None and strip.action_button.isVisible():
                print("HARNESS_CLICK_DOWNLOAD", flush=True)
                strip.action_button.click()
        QTimer.singleShot(CLICK_MS, _click)
    QTimer.singleShot(CLOSE_MS, _close)


MainWindow.show = _show_and_schedule

import main

sys.argv = [sys.argv[0]]
raise SystemExit(main.main())
'''


class UpdateLifecycleTests(unittest.TestCase):
    """Real child process: slow core work + explicit exit must shut down cleanly."""

    def run_harness(self, **env):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "harness.py"
            script.write_text(HARNESS_SOURCE, encoding="utf-8")
            environment = dict(os.environ)
            environment.update({key: str(value) for key, value in env.items()})
            environment.setdefault("QT_QPA_PLATFORM", "offscreen")
            started = time.monotonic()
            proc = subprocess.run(
                [sys.executable, "-B", str(script), str(DESKTOP_DIR)],
                capture_output=True, text=True, timeout=120, env=environment, cwd=str(DESKTOP_DIR),
            )
            return proc, time.monotonic() - started

    def assert_clean_exit(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr[-3000:])
        self.assertNotIn("QThread: Destroyed while thread is still running", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

    def test_slow_check_outliving_the_close_wait_still_exits_clean(self):
        proc, elapsed = self.run_harness(HARNESS_MODE="check", HARNESS_SLOW_SECONDS=10, HARNESS_CLOSE_MS=2500)
        self.assert_clean_exit(proc)
        self.assertIn("HARNESS_CHECK_STARTED", proc.stdout)
        self.assertIn("HARNESS_CLOSING", proc.stdout)
        self.assertIn("HARNESS_WINDOW_SHOWN", proc.stdout)
        # The close path never waited for the worker twice; exit followed the core call.
        self.assertLess(elapsed, 40)

    def test_slow_download_cancelled_on_close_exits_clean(self):
        proc, _ = self.run_harness(HARNESS_MODE="download", HARNESS_SLOW_SECONDS=30,
                                   HARNESS_CLICK_MS=1800, HARNESS_CLOSE_MS=2600)
        self.assert_clean_exit(proc)
        self.assertIn("HARNESS_DOWNLOAD_STARTED", proc.stdout)
        self.assertIn("HARNESS_CLICK_DOWNLOAD", proc.stdout)
        self.assertIn("HARNESS_DOWNLOAD_CANCELLED", proc.stdout)
        self.assertIn("HARNESS_CLOSING", proc.stdout)
        self.assertNotIn("HARNESS_LAUNCH", proc.stdout)

    def test_cancel_after_success_cleans_the_staged_directory(self):
        proc, _ = self.run_harness(HARNESS_MODE="download-late-cancel",
                                   HARNESS_CLICK_MS=1800, HARNESS_CLOSE_MS=2400)
        self.assert_clean_exit(proc)
        self.assertIn("HARNESS_DOWNLOAD_STARTED", proc.stdout)
        self.assertIn("HARNESS_LATE_RETURN", proc.stdout)
        self.assertIn("HARNESS_CLEANUP", proc.stdout)
        self.assertNotIn("HARNESS_LAUNCH", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
