"""Tray lifecycle regressions: close hides, tray restores, explicit exit, fallback.

All cases run fully offline with an offscreen Qt platform: no network, no real
account data, no real system tray (QSystemTrayIcon is patched before MainWindow
construction so tray availability is deterministic on every machine).
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

# On Windows the offscreen Qt plugin does not automatically load system fonts.
if sys.platform == "win32" and os.environ.get("QT_QPA_PLATFORM") == "offscreen":
    system_fonts = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")
    if os.path.isdir(system_fonts):
        os.environ.setdefault("QT_QPA_FONTDIR", system_fonts)

from PyQt6.QtCore import QCoreApplication, QEvent, QSettings, QTemporaryDir, Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QSystemTrayIcon

from smoke_test import FakeClient
from tray import TrayController, create_tray
from ui import MainWindow


class TrayLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyle("Fusion")
        cls.settings_dir = QTemporaryDir()
        QSettings.setDefaultFormat(QSettings.Format.IniFormat)
        QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, cls.settings_dir.path())

    def setUp(self):
        # Deterministic: pretend a tray is available for the "tray active" cases.
        # Offscreen QSystemTrayIcon.show() logs "No Icon set" when the platform has
        # no system tray; an empty icon keeps tests quiet without touching assets.
        self._icon_patch = patch.object(QSystemTrayIcon, "setIcon", lambda self, icon: None)
        self._icon_patch.start()
        self.addCleanup(self._icon_patch.stop)
        self._tray_patch = patch.object(QSystemTrayIcon, "isSystemTrayAvailable", return_value=True)
        self._tray_patch.start()
        self.addCleanup(self._tray_patch.stop)
        self.window = MainWindow(demo=False)
        self.window.bind_client(FakeClient())
        self.window.resize(940, 580)
        self.window.show()
        self.app.processEvents()
        self.closings: list[int] = []
        self.window.closing.connect(lambda: self.closings.append(1))

    def tearDown(self):
        self.window._closing = True
        self.window.hide()
        if self.window.tray is not None:
            self.window.tray.hide()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    # -- helpers ------------------------------------------------------------
    def pump(self, rounds: int = 20):
        for _ in range(rounds):
            self.app.processEvents()

    # -- close() hides to tray --------------------------------------------
    def test_close_hides_to_tray_without_emitting_closing(self):
        w = self.window
        self.assertIsNotNone(w.tray)
        w.close()
        self.pump()
        self.assertFalse(w.isVisible())
        self.assertFalse(w._closing)
        self.assertEqual(self.closings, [])
        self.assertTrue(w.tray.is_visible())
        # Hidden state must not mark the window as exiting: strip stays enabled.
        self.assertTrue(w.update_strip.check_button.isEnabled())

    def test_close_with_dirty_settings_still_hides_and_keeps_them(self):
        # 隐藏不丢设置：普通关闭不应弹“放弃改动”确认，设置原样保留。
        w = self.window
        w._dirty.add("network")
        asked: list[tuple] = []
        w.confirm = lambda title, text: asked.append((title, text)) or False
        w.close()
        self.pump()
        self.assertEqual(asked, [])
        self.assertFalse(w.isVisible())
        self.assertFalse(w._closing)
        self.assertEqual(self.closings, [])
        self.assertIn("network", w._dirty)

    def test_tray_double_click_restores_the_window(self):
        w = self.window
        w.close()
        self.pump()
        self.assertFalse(w.isVisible())
        # 事件入口：直接派发 activated 信号，等价于平台双击托盘图标。
        w.tray.tray.activated.emit(QSystemTrayIcon.ActivationReason.DoubleClick)
        self.pump()
        self.assertTrue(w.isVisible())
        self.assertFalse(w._closing)
        self.assertEqual(self.closings, [])

    def test_tray_trigger_activation_restores_the_window(self):
        w = self.window
        w.close()
        self.pump()
        self.assertFalse(w.isVisible())
        w.tray.tray.activated.emit(QSystemTrayIcon.ActivationReason.Trigger)
        self.pump()
        self.assertTrue(w.isVisible())
        self.assertFalse(w._closing)

    def test_show_window_restores_from_minimized(self):
        w = self.window
        w.showMinimized()
        self.pump()
        self.assertTrue(w.isMinimized())
        w.tray.show_window()
        self.pump()
        self.assertFalse(w.isMinimized())
        self.assertTrue(w.isVisible())

    def test_tray_menu_actions_restore_and_exit(self):
        w = self.window
        w.close()
        self.pump()
        self.assertFalse(w.isVisible())
        # 事件入口：触发菜单 action，等价于右键菜单点击。
        w.tray.show_action.trigger()
        self.pump()
        self.assertTrue(w.isVisible())
        w._dirty.clear()
        w.tray.quit_action.trigger()
        self.pump()
        self.assertTrue(w._closing)
        self.assertEqual(self.closings, [1])
        self.assertFalse(w.tray.is_visible())

    def test_tray_exit_from_hidden_shows_window_before_confirm(self):
        # 隐藏时托盘退出：先恢复窗口，未保存确认对话框才可见可操作。
        w = self.window
        w.close()
        self.pump()
        self.assertFalse(w.isVisible())
        w._dirty.add("network")
        asked: list[tuple] = []
        w.confirm = lambda title, text: asked.append((title, text)) or False
        w.tray.quit_action.trigger()
        self.pump()
        self.assertEqual(len(asked), 1)
        self.assertTrue(w.isVisible(), "confirm dialog must be visible, not hidden behind tray")
        self.assertFalse(w._closing)
        self.assertEqual(self.closings, [])

    # -- explicit exit -----------------------------------------------------
    def test_request_exit_returns_true_and_closes(self):
        w = self.window
        w._dirty.clear()
        self.assertTrue(w.request_exit())
        self.pump()
        self.assertTrue(w._closing)
        self.assertEqual(self.closings, [1])
        self.assertFalse(w.isVisible())
        # Idempotent once closed.
        self.assertTrue(w.request_exit())

    def test_request_exit_cancelled_by_dirty_returns_false(self):
        w = self.window
        w._dirty.add("network")
        w.confirm = lambda title, text: False
        self.assertFalse(w.request_exit())
        self.pump()
        self.assertFalse(w._closing)
        self.assertTrue(w.isVisible())
        self.assertEqual(self.closings, [])

    def test_close_cancelled_by_dirty_never_exits(self):
        # 显式退出路径（_exit_requested）下的 dirty 取消：不退出、不隐藏。
        w = self.window
        w._dirty.add("network")
        w.confirm = lambda title, text: False
        w._exit_requested = True
        try:
            w.close()
        finally:
            w._exit_requested = False
        self.pump()
        self.assertTrue(w.isVisible())
        self.assertFalse(w._closing)
        self.assertEqual(self.closings, [])

    def test_begin_update_close_runs_handoff_and_exits(self):
        # 更新重启复用显式退出路径：handoff 通过才退出，托盘不吞掉关闭。
        w = self.window
        w._dirty.clear()
        ran: list[bool] = []
        self.assertTrue(w.begin_update_close(lambda: ran.append(True) or True))
        self.pump()
        self.assertEqual(ran, [True])
        self.assertTrue(w._closing)
        self.assertEqual(self.closings, [1])

    def test_begin_update_close_handoff_failure_keeps_window(self):
        w = self.window
        w._dirty.clear()
        self.assertFalse(w.begin_update_close(lambda: False))
        self.pump()
        self.assertFalse(w._closing)
        self.assertTrue(w.isVisible())
        self.assertEqual(self.closings, [])

    # -- no-tray fallback ---------------------------------------------------
    def test_no_tray_falls_back_to_normal_close(self):
        with patch.object(QSystemTrayIcon, "isSystemTrayAvailable", return_value=False):
            w = MainWindow(demo=False)
            try:
                w.bind_client(FakeClient())
                w.resize(940, 580)
                w.show()
                self.pump()
                self.assertIsNone(w.tray)
                local_closings: list[int] = []
                w.closing.connect(lambda: local_closings.append(1))
                w._dirty.clear()
                w.close()
                self.pump()
                self.assertTrue(w._closing)
                self.assertEqual(local_closings, [1])
                self.assertFalse(w.isVisible())
                self.assertTrue(w.request_exit())
            finally:
                w._closing = True
                w.hide()
                w.deleteLater()
                QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                self.pump()

    def test_create_tray_returns_none_when_isSystemTrayAvailable_false(self):
        with patch.object(QSystemTrayIcon, "isSystemTrayAvailable", return_value=False):
            self.assertIsNone(create_tray(self.window))

    def test_demo_close_does_not_tray_hide(self):
        # Demo window never binds a tray; closing must follow the conventional path.
        demo = MainWindow(demo=True)
        try:
            demo.resize(940, 580)
            demo.show()
            self.pump()
            demo._dirty.clear()
            demo.close()
            self.pump()
            # Demo 拥有托盘，但 demo 关闭走常规退出，不进托盘隐藏分支。
            self.assertTrue(demo._closing)
            self.assertFalse(demo.isVisible())
            self.assertFalse(demo.tray.is_visible())
        finally:
            demo._closing = True
            demo.hide()
            demo.deleteLater()
            QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.pump()


if __name__ == "__main__":
    unittest.main(verbosity=2)
