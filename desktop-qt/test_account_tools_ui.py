"""Account toolbar regressions with synthetic data and no backend access."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QCoreApplication, QEvent, QObject, QPoint, QSettings, QTemporaryDir, Qt, pyqtSignal
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QDialog, QDialogButtonBox, QLabel, QLineEdit, QPlainTextEdit, QPushButton

from account_tools import MAX_BODY_BYTES, build_import_payload
from main import demo_snapshot
from ui import MainWindow


class FakeClient(QObject):
    status_received = pyqtSignal(dict)
    logs_received = pyqtSignal(list)
    operation_finished = pyqtSignal(str, object)
    error = pyqtSignal(str, str)
    connection_changed = pyqtSignal(bool)
    base_url = "http://127.0.0.1:19823"

    def __init__(self):
        super().__init__()
        self.calls = []

    def start(self):
        self.connection_changed.emit(True)
        self.status_received.emit(demo_snapshot())

    def refresh(self):
        pass

    def request(self, action, route, body=None, **kwargs):
        self.calls.append((action, route, body, kwargs))
        return True


class AccountToolsUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyle("Fusion")
        cls.settings_dir = QTemporaryDir()
        QSettings.setDefaultFormat(QSettings.Format.IniFormat)
        QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, cls.settings_dir.path())

    def setUp(self):
        self.window = MainWindow(demo=False)
        self.client = FakeClient()
        self.window.bind_client(self.client)
        self.window.resize(940, 580)
        self.window.show()
        self.window.navigate(1, animate=False)
        self.window.settle_animations()
        self.app.processEvents()
        self.tools = self.window.account_tools

    def tearDown(self):
        self.window._closing = True
        self.window.hide()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def test_direct_buttons_are_visible_and_fit_minimum_width(self):
        w, tools = self.window, self.tools
        for dark in (True, False):
            with self.subTest(dark=dark):
                w.set_dark(dark, persist=False)
                w.resize(940, 580)
                w.settle_animations()
                self.app.processEvents()
                self.assertEqual(w.width(), 940)
                page = w.stack.widget(1)
                controls = (w.account_search, w.account_sort, w.oauth_button,
                            tools.refresh_button, tools.capture_button, tools.import_button)
                self.assertEqual(tools.capture_button.text(), "读取本地客户端账户")
                self.assertEqual(tools.import_button.text(), "导入账户 / 令牌")
                self.assertIs(tools.capture_button.parentWidget(), tools.import_button.parentWidget())
                for control in controls:
                    self.assertTrue(control.isVisible(), control.objectName() or type(control).__name__)
                    origin = control.mapTo(page, QPoint(0, 0))
                    self.assertGreaterEqual(origin.x(), 0)
                    self.assertLessEqual(origin.x() + control.width(), page.width())
                for left, right in zip(controls, controls[1:]):
                    left_pos = left.mapTo(page, QPoint(0, 0))
                    right_pos = right.mapTo(page, QPoint(0, 0))
                    self.assertLessEqual(left_pos.x() + left.width(), right_pos.x())
                    self.assertEqual(left_pos.y() + left.height() // 2, right_pos.y() + right.height() // 2)
                for button in (w.oauth_button, tools.refresh_button, tools.capture_button, tools.import_button):
                    self.assertGreaterEqual(button.width(), button.sizeHint().width(), button.text())
                    self.assertIsNone(button.menu())
                self.assertTrue(tools.reauth_button.isVisible())
                self.assertFalse(any("更多工具" in b.text() or "导出" in b.text()
                                     for b in page.findChildren(QPushButton)))
                self.assertFalse(hasattr(tools, "more_button"))
                self.assertFalse(hasattr(tools, "export_masked_action"))
                self.assertFalse(hasattr(tools, "export_full_action"))

    def test_online_offline_pending_and_independent_guards(self):
        w, tools = self.window, self.tools
        self.assertTrue(tools.capture_button.isEnabled())
        self.assertTrue(tools.import_button.isEnabled())
        for field, value in (("_online", False), ("_closing", True), ("demo", True), ("client", None)):
            with self.subTest(field=field):
                original = getattr(w, field)
                setattr(w, field, value)
                tools.update_enabled()
                self.assertFalse(tools.capture_button.isEnabled())
                self.assertFalse(tools.import_button.isEnabled())
                tools.capture_current()
                with patch.object(QDialog, "exec", side_effect=AssertionError("disabled import opened dialog")):
                    tools.import_accounts()
                self.assertEqual(self.client.calls, [])
                setattr(w, field, original)
                tools.update_enabled()
        for pending, capture, importing in (("capture", False, True), ("accounts-import", True, False)):
            with self.subTest(pending=pending):
                w._pending[pending] = (None, None, frozenset())
                tools.update_enabled()
                self.assertEqual(tools.capture_button.isEnabled(), capture)
                self.assertEqual(tools.import_button.isEnabled(), importing)
                w._pending.clear()
                tools.update_enabled()
        self.assertTrue(tools.capture_button.isEnabled())
        self.assertTrue(tools.import_button.isEnabled())

    def test_capture_click_sends_existing_request_once_and_waits(self):
        QTest.mouseClick(self.tools.capture_button, Qt.MouseButton.LeftButton)
        self.assertEqual(self.client.calls[-1][:3], ("capture", "/api/accounts/capture", {}))
        self.assertFalse(self.tools.capture_button.isEnabled())
        self.assertTrue(self.tools.import_button.isEnabled())
        self.tools.capture_current()
        self.assertEqual(len(self.client.calls), 1)
        self.client.operation_finished.emit("capture", {"ok": True})
        self.assertTrue(self.tools.capture_button.isEnabled())

    def test_import_click_keeps_validation_and_submits_existing_payload(self):
        observations = []

        def interact(dialog):
            editor = dialog.findChild(QPlainTextEdit)
            email = dialog.findChild(QLineEdit)
            buttons = dialog.findChild(QDialogButtonBox)
            editor.setPlainText("masked...token")
            buttons.button(QDialogButtonBox.StandardButton.Ok).click()
            observations.append((dialog.result(), [label.text() for label in dialog.findChildren(QLabel)], len(self.client.calls)))
            editor.setPlainText("synthetic-refresh-token")
            email.setText(" fake@example.invalid ")
            buttons.button(QDialogButtonBox.StandardButton.Ok).click()
            return dialog.result()

        with patch.object(QDialog, "exec", new=interact):
            QTest.mouseClick(self.tools.import_button, Qt.MouseButton.LeftButton)
        self.assertNotEqual(observations[0][0], QDialog.DialogCode.Accepted)
        self.assertIn("令牌似乎已脱敏，请使用完整 refresh_token。", observations[0][1])
        self.assertEqual(observations[0][2], 0)
        action, route, body, kwargs = self.client.calls[-1]
        self.assertEqual((action, route), ("accounts-import", "/api/accounts/add"))
        self.assertEqual(body, {"rawInput": "synthetic-refresh-token", "email": "fake@example.invalid"})
        self.assertEqual(kwargs["timeout_ms"], 60000)
        self.assertFalse(self.tools.import_button.isEnabled())
        self.assertTrue(self.tools.capture_button.isEnabled())
        with patch.object(QDialog, "exec", side_effect=AssertionError("pending import opened dialog")):
            self.tools.import_accounts()
        self.assertEqual(len(self.client.calls), 1)
        self.client.operation_finished.emit("accounts-import", {"ok": True})
        self.assertTrue(self.tools.import_button.isEnabled())

    def test_quota_and_reauthorization_controls_are_preserved(self):
        w, tools = self.window, self.tools
        w._select_card_id(w._account_items[0]["id"])
        tools.update_enabled()
        self.assertTrue(tools.refresh_button.isEnabled())
        self.assertTrue(tools.reauth_button.isEnabled())
        QTest.mouseClick(tools.refresh_button, Qt.MouseButton.LeftButton)
        self.assertEqual(self.client.calls[-1][:3], ("quota-refresh-all", "/api/accounts/quota/refresh-all", {}))
        self.assertFalse(tools.refresh_button.isEnabled())
        self.client.operation_finished.emit("quota-refresh-all", {"started": True, "task": {"state": "running"}})
        self.assertFalse(tools.refresh_button.isEnabled())
        tools.render_status({"quotaTask": {"state": "done"}})
        self.assertTrue(tools.refresh_button.isEnabled())
        QTest.mouseClick(tools.reauth_button, Qt.MouseButton.LeftButton)
        action, route, body, _ = self.client.calls[-1]
        self.assertEqual((action, route), ("oauth-start", "/api/accounts/oauth/start"))
        self.assertEqual(body["accountId"], w._account_items[0]["id"])
        self.assertFalse(tools.reauth_button.isEnabled())

    def test_import_payload_rejects_masked_and_oversized_tokens(self):
        for value in ('{"refreshTokenMasked": true, "refresh_token": "secret"}', "prefix...suffix", "x" * MAX_BODY_BYTES):
            with self.subTest(size=len(value)):
                with self.assertRaises(ValueError):
                    build_import_payload(value)


if __name__ == "__main__":
    unittest.main()
