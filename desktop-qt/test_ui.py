"""Frontend regressions using synthetic accounts, API replies, and isolated settings only."""
from __future__ import annotations

from copy import deepcopy
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

# On Windows the offscreen Qt plugin does not automatically load system fonts.
# Without real font metrics, geometry assertions do not represent the desktop UI.
if sys.platform == "win32" and os.environ.get("QT_QPA_PLATFORM") == "offscreen":
    system_fonts = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")
    if os.path.isdir(system_fonts):
        os.environ.setdefault("QT_QPA_FONTDIR", system_fonts)

from PyQt6.QtCore import QCoreApplication, QEvent, QSettings, QTemporaryDir, Qt
from PyQt6.QtGui import QShortcut
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QDialog, QFileDialog, QPushButton

from backend_client import BackendClient
from main import demo_snapshot
from smoke_test import FakeClient
from ui import MainWindow


class FrontendRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyle("Fusion")
        cls.settings_dir = QTemporaryDir()
        QSettings.setDefaultFormat(QSettings.Format.IniFormat)
        QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, cls.settings_dir.path())

    def setUp(self):
        # General UI cases exercise explicit shutdown independently of host tray support.
        tray_patch = patch("ui.create_tray", return_value=None)
        tray_patch.start()
        self.addCleanup(tray_patch.stop)
        self.window = MainWindow(demo=False)
        self.client = FakeClient()
        self.window.bind_client(self.client)
        self.window.resize(940, 580)
        self.window.show()
        self.window.navigate(1, animate=False)
        self.window.settle_animations()
        self.app.processEvents()

    def tearDown(self):
        self.window._closing = True
        self.window.hide()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def test_cancelled_card_switch_keeps_visible_and_delete_targets_consistent(self):
        w = self.window
        first, second = w._account_items[:2]
        w._select_card_id(first["id"])
        confirmations = []
        w.confirm = lambda title, text: confirmations.append((title, text)) or False
        card = next(c for c in w._account_cards if c._account_id == second["id"])
        switch = next(b for b in card.findChildren(QPushButton) if b.text() == "切换账户")
        QTest.mouseClick(switch, Qt.MouseButton.LeftButton)
        self.app.processEvents()
        self.assertFalse(self.client.calls)
        self.assertEqual(w.selected_account()["id"], second["id"])
        self.assertEqual(w.selected_acc_name.text(), second["name"])
        self.assertIn(second["email"], confirmations[-1][1])
        self.assertIn("退出 Antigravity", confirmations[-1][1])
        self.assertIn("下次启动", confirmations[-1][1])
        self.assertNotIn("并重启", confirmations[-1][1])
        w.confirm = lambda title, text: confirmations.append((title, text)) or True
        QTest.mouseClick(w.remove_account_button, Qt.MouseButton.LeftButton)
        self.assertEqual(self.client.calls[-1][2], {"id": second["id"]})
        self.assertIn(second["email"], confirmations[-1][1])
        self.assertEqual(w.selected_acc_name.text(), second["name"])

    def test_parallel_config_results_update_only_their_own_fields(self):
        for order in (("config-enhance", "config-network"), ("config-network", "config-enhance")):
            with self.subTest(order=order):
                w = self.window
                w.render_status(deepcopy(demo_snapshot()))
                w.port.setValue(7900)
                self.assertTrue(w.save_network())
                w.i18n.setChecked(False)
                self.assertTrue(w.save_enhance())
                replies = {
                    "config-network": {"ok": True, "settings": {"port": 7900, "preflightProxy": True, "enableI18n": True}},
                    "config-enhance": {"ok": True, "settings": {"port": 7890, "preflightProxy": True, "enableI18n": False, "enableContextMonitor": True, "autoApplyKernelPatch": True}},
                }
                for action in order:
                    self.client.finish(action, replies[action])
                self.assertEqual(w.port.value(), 7900)
                self.assertFalse(w.i18n.isChecked())
                self.assertFalse(w._dirty.intersection({"network", "enhance"}))
                w.monitor.setChecked(False)
                self.assertTrue(w.save_enhance())
                self.assertFalse(self.client.calls[-1][2]["enableI18n"])
                self.client.finish("config-enhance", {"ok": True, "settings": {"enableI18n": False, "enableContextMonitor": False, "autoApplyKernelPatch": True}})

    def test_real_client_drops_old_poll_before_the_next_user_save(self):
        class SyntheticTransport(BackendClient):
            def __init__(self):
                super().__init__("http://127.0.0.1:19823")
                self.requests = []

            def start(self):
                self._running = True
                self._generation += 1
                self._token = "0" * 32
                self._set_online(True)
                self.status_received.emit(deepcopy(demo_snapshot()))

            def _fetch(self, route, method, payload, timeout_ms, callback, authenticated=True):
                self.requests.append((route, json.loads(payload) if payload else None, callback))

        w = self.window
        client = SyntheticTransport()
        w.bind_client(client)
        client.refresh()
        old_poll = client.requests[-1][2]
        w.i18n.setChecked(False)
        self.assertTrue(w.save_enhance())
        _, submitted, saved = client.requests[-1]
        saved(200, json.dumps({"ok": True, "settings": submitted}).encode(), "")
        self.assertFalse(w.i18n.isChecked())
        old_poll(200, json.dumps(demo_snapshot()).encode(), "")
        self.assertFalse(w.i18n.isChecked())
        fresh = demo_snapshot()
        fresh.update(submitted)
        self.assertEqual(client.requests[-1][0], "/api/status")
        client.requests[-1][2](200, json.dumps(fresh).encode(), "")
        w.monitor.setChecked(False)
        self.assertTrue(w.save_enhance())
        self.assertFalse(client.requests[-1][1]["enableI18n"])
        client.stop()

    def test_quick_start_ignores_hidden_invalid_fixed_url_draft(self):
        w = self.window
        w.mobile_mode.setCurrentIndex(w.mobile_mode.findData("fixed"))
        w.fixed_url.setText("not-a-domain")
        w.mobile_mode.setCurrentIndex(w.mobile_mode.findData("quick"))
        self.assertTrue(w.fixed_url.isHidden())
        w.start_mobile()
        action, route, body, _ = self.client.calls[-1]
        self.assertEqual((action, route), ("mobile-config", "/api/mobile/config"))
        self.assertEqual(body, {"mode": "quick", "autoStart": False})
        self.client.finish("mobile-config", {"ok": True, "mobile": {"state": "stopped", "mode": "quick", "fixedUrl": "https://saved.example.com", "autoStart": False}})
        self.assertEqual(self.client.calls[-1][0], "mobile-start")
        self.assertEqual(w.fixed_url.text(), "https://saved.example.com")

    def test_fixed_mode_still_rejects_invalid_and_submits_valid_url(self):
        w = self.window
        w.mobile_mode.setCurrentIndex(w.mobile_mode.findData("fixed"))
        w.fixed_url.setText("not-a-domain")
        w.save_mobile()
        self.assertFalse(self.client.calls)
        w.fixed_url.setText("https://remote.example.com")
        w.save_mobile()
        self.assertEqual(self.client.calls[-1][2]["fixedUrl"], "https://remote.example.com")

    def legend(self):
        layout = self.window.model_dist_list
        return [[layout.itemAt(i).layout().itemAt(j).widget().text() for j in (1, 2)]
                for i in range(layout.count()) if layout.itemAt(i).layout() is not None]

    def test_empty_seven_days_never_falls_back_to_thirty_days(self):
        self.window.render_usage({"days7": {"totalTokens": 0, "models": []}, "days30": {"models": [{"name": "Last month only", "totalTokens": 7000}]}})
        self.assertEqual(self.window.usage_tiles["days7"][0].text(), "0")
        self.assertEqual(self.window.model_dist_bar._items, [])
        self.assertEqual(self.window.usage_dist_total.text(), "—")
        self.assertEqual(self.legend(), [])

    def test_usage_tiles_show_cache_reads_only_when_present(self):
        self.window.render_usage({"today": {"totalTokens": 48061042, "requests": 250, "inputTokens": 2394458,
                                            "outputTokens": 587675, "cacheReadTokens": 45078909}})
        self.assertIn("缓存 45.1M", self.window.usage_tiles["today"][2].text())
        self.window.render_usage({"today": {"totalTokens": 1000, "requests": 1, "inputTokens": 900, "outputTokens": 100}})
        self.assertIn("缓存 0", self.window.usage_tiles["today"][2].text())

    def test_distribution_total_segments_and_legend_share_all_models(self):
        self.window.settle_animations()
        self.app.processEvents()
        baseline_heights = [[label.height() for label in tile] for tile in self.window.usage_tiles.values()]
        for count in (3, 5, 6):
            with self.subTest(models=count):
                models = [{"name": f"Model {i}", "totalTokens": 1000} for i in range(count)]
                self.window.render_usage({"days7": {"totalTokens": count * 1000, "models": models}})
                items = self.window.model_dist_bar._items
                self.assertEqual(sum(value for _, value in items), count * 1000)
                self.assertEqual([name for name, _ in items], [row[0] for row in self.legend()])
                self.assertEqual(len(items), min(count, 3))
                self.window.settle_animations()
                self.app.processEvents()
                for index in range(self.window.model_dist_list.count()):
                    row = self.window.model_dist_list.itemAt(index).layout()
                    name_label = row.itemAt(1).widget()
                    bottom = name_label.mapTo(self.window, name_label.rect().bottomRight())
                    self.assertLess(bottom.y(), self.window.height())
                for tile, heights in zip(self.window.usage_tiles.values(), baseline_heights):
                    for text_label, height in zip(tile, heights):
                        self.assertGreaterEqual(text_label.height(), height)
                if count > 3:
                    self.assertEqual(items[-1], ("其他", (count - 2) * 1000))
                    self.assertAlmostEqual(items[0][1] / sum(value for _, value in items), 1 / count)

    def test_usage_labels_remain_readable_and_scrollable_at_both_sizes(self):
        w = self.window
        state = deepcopy(demo_snapshot())
        state["accounts"]["items"][0]["quota"] = {
            "models": [{"id": f"long-model-{i}", "label": f"测试模型 {i}",
                        "percentage": 95, "resetText": "3 天 16 小时"} for i in range(9)],
            "windows": [],
        }
        state["tokenUsage"]["days7"]["models"] = [
            {"name": f"模型 {i}", "totalTokens": (i + 1) * 1000000} for i in range(6)
        ]
        w.render_status(state)
        self.assertFalse(hasattr(w, "quota_detail"))
        for dark in (False, True):
            w.set_dark(dark, persist=False)
            for width, height in ((940, 580), (1120, 640)):
                with self.subTest(dark=dark, width=width, height=height):
                    w.resize(width, height)
                    w.settle_animations()
                    self.app.processEvents()
                    scroll = w.account_details_scroll
                    viewport = scroll.viewport()
                    self.assertEqual(scroll.horizontalScrollBar().maximum(), 0)
                    for value, requests, io in w.usage_tiles.values():
                        tile = value.parentWidget()
                        for text_label in (value, requests, io):
                            self.assertGreaterEqual(text_label.contentsRect().height(),
                                                    text_label.fontMetrics().height(), text_label.text())
                        req_y = requests.mapTo(tile, requests.rect().bottomLeft()).y()
                        val_top = value.mapTo(tile, value.rect().topLeft()).y()
                        val_bottom = value.mapTo(tile, value.rect().bottomLeft()).y()
                        io_top = io.mapTo(tile, io.rect().topLeft()).y()
                        self.assertLess(req_y, val_top)
                        self.assertLess(val_bottom, io_top)
                        scroll.ensureWidgetVisible(tile, 0, 0)
                        self.app.processEvents()
                        top = tile.mapTo(viewport, tile.rect().topLeft()).y()
                        bottom = tile.mapTo(viewport, tile.rect().bottomLeft()).y()
                        self.assertGreaterEqual(top, 0)
                        self.assertLess(bottom, viewport.height())

        # Exercise a genuinely short viewport rather than only the default full-height panel.
        scroll.setFixedHeight(180)
        self.app.processEvents()
        self.assertGreater(scroll.verticalScrollBar().maximum(), 0)
        bottom_tile = w.usage_tiles["all"][0].parentWidget()
        legend_label = w.model_dist_list.itemAt(w.model_dist_list.count() - 1).layout().itemAt(1).widget()
        for target in (bottom_tile, legend_label):
            scroll.ensureWidgetVisible(target, 0, 0)
            self.app.processEvents()
            top = target.mapTo(viewport, target.rect().topLeft()).y()
            bottom = target.mapTo(viewport, target.rect().bottomLeft()).y()
            self.assertGreaterEqual(top, 0)
            self.assertLess(bottom, viewport.height())

    def test_long_model_names_do_not_clip_the_account_details_panel(self):
        w = self.window
        name = "Gemini very long model identifier " * 12
        state = deepcopy(demo_snapshot())
        state["tokenUsage"]["days7"]["models"] = [{"name": name, "totalTokens": 1234567}]
        w.render_status(state)
        w.resize(940, 580)
        w.settle_animations()
        self.app.processEvents()
        scroll = w.account_details_scroll
        row = w.model_dist_list.itemAt(0).layout()
        model_name, total = row.itemAt(1).widget(), row.itemAt(2).widget()
        self.assertLessEqual(scroll.widget().width(), scroll.viewport().width())
        self.assertEqual(model_name.text(), name)
        self.assertEqual(model_name.toolTip(), name)
        scroll.ensureWidgetVisible(total, 0, 0)
        self.app.processEvents()
        self.assertLess(total.mapTo(scroll.viewport(), total.rect().bottomRight()).x(),
                        scroll.viewport().width())

    def test_mobile_start_waits_for_the_supervisor_retry_budget(self):
        self.window.start_mobile()
        action, route, body, options = self.client.calls[-1]
        self.assertEqual((action, route, body), ("mobile-start", "/api/mobile/start", {}))
        self.assertEqual(options["timeout_ms"], 135000)

    def test_mobile_recovery_replaces_stale_pairing_without_losing_pin(self):
        w = self.window
        state = deepcopy(demo_snapshot())
        state["mobile"].update(state="running", managed=True, publicUrl="https://before-recovery.trycloudflare.com", pin="12345678")
        w.render_status(state)
        self.assertEqual(w._qr_url, state["mobile"]["publicUrl"])
        state["mobile"].update(state="degraded", publicUrl="", lastError="")
        w.render_status(state)
        self.assertEqual(w.mobile_url.text(), "")
        self.assertEqual(w._qr_url, "")
        self.assertTrue(w.mobile_qr_frame.isHidden())
        self.assertFalse(w.copy_mobile_button.isEnabled())
        self.assertFalse(w.open_mobile_button.isEnabled())
        self.assertEqual(w.mobile_pin.text(), "12345678")
        self.assertTrue(w.mobile_stop_button.isEnabled())
        self.assertEqual(w.mobile_state.text(), "正在恢复")
        self.assertIn("恢复", w.qr_caption_title.text())
        state["mobile"].update(state="running", publicUrl="https://after-recovery.trycloudflare.com")
        w.render_status(state)
        self.assertEqual(w._qr_url, state["mobile"]["publicUrl"])
        self.assertFalse(w.mobile_qr_frame.isHidden())
        self.assertTrue(w.open_mobile_button.isEnabled())
        self.assertEqual(w.mobile_pin.text(), "12345678")

    def test_mobile_starting_remains_cancellable_during_protocol_fallback(self):
        w = self.window
        state = deepcopy(demo_snapshot())
        state["mobile"].update(state="starting", managed=True, publicUrl="", pin="12345678", lastError="")
        w.render_status(state)
        self.assertIn("125", w.mobile_detail.text())
        self.assertTrue(w.mobile_stop_button.isEnabled())
        self.assertFalse(w.mobile_start_button.isEnabled())

    def test_mobile_startup_phases_do_not_publish_an_unverified_qr(self):
        w = self.window
        state = deepcopy(demo_snapshot())
        state["mobile"].update(state="starting", managed=True, publicUrl="", lastError="")
        for phase, expected in (("origin", "本地"), ("connector", "Cloudflare"), ("public", "验证公网"), ("recovering", "切换连接")):
            with self.subTest(phase=phase):
                state["mobile"]["startupPhase"] = phase
                w.render_status(state)
                self.assertIn(expected, w.qr_ph_label.text())
                self.assertEqual(w._qr_url, "")
                self.assertTrue(w.mobile_stop_button.isEnabled())

    def fixed_mobile(self, **extra):
        state = deepcopy(demo_snapshot())
        state["mobile"].update(mode="fixed", fixedUrl="https://remote.example.com", tunnelTokenConfigured=False, fixedAuth=None, **extra)
        self.window._dirty.discard("mobile")
        self.window.render_status(state)
        return state

    def test_tunnel_token_is_masked_saved_once_and_never_refilled(self):
        w = self.window
        state = self.fixed_mobile()
        w.tunnel_token.setText("fixture-tunnel-secret")
        w._mobile_token_edited()
        self.assertEqual(w.tunnel_token.echoMode(), w.mobile_pin.echoMode())
        self.assertTrue(w.save_mobile())
        self.assertEqual(self.client.calls[-1][2]["tunnelToken"], "fixture-tunnel-secret")
        self.assertFalse(w.tunnel_token.isEnabled())
        state["mobile"].update(tunnelTokenConfigured=True, fixedAuth="token")
        self.client.finish("mobile-config", {"ok": True, "mobile": state["mobile"]})
        self.assertEqual(w.tunnel_token.text(), "")
        self.assertIn("已加密", w.tunnel_token_status.text())
        self.assertNotIn("fixture-tunnel-secret", json.dumps(w.snapshot))
        self.assertTrue(w.save_mobile())
        self.assertNotIn("tunnelToken", self.client.calls[-1][2])
        self.assertNotIn("clearTunnelToken", self.client.calls[-1][2])

    def test_tunnel_token_failure_preserves_draft_and_clear_is_explicit(self):
        w = self.window
        state = self.fixed_mobile()
        state["mobile"].update(tunnelTokenConfigured=True, fixedAuth="token")
        w.render_status(state)
        w.tunnel_token.setText("replacement-fixture")
        w._mobile_token_edited()
        w.save_mobile()
        self.client.error.emit("mobile-config", "模拟保存失败")
        self.assertEqual(w.tunnel_token.text(), "replacement-fixture")
        self.assertIn("mobile", w._dirty)
        w.clear_mobile_token()
        self.assertEqual(w.tunnel_token.text(), "")
        w.save_mobile()
        self.assertTrue(self.client.calls[-1][2]["clearTunnelToken"])
        self.assertNotIn("tunnelToken", self.client.calls[-1][2])
        state["mobile"].update(tunnelTokenConfigured=False, fixedAuth=None)
        self.client.finish("mobile-config", {"ok": True, "mobile": state["mobile"]})
        self.assertFalse(w._clear_tunnel_token)
        self.assertFalse(w.clear_tunnel_token_button.isEnabled())

    def test_quick_mode_never_submits_hidden_token_or_clear_draft(self):
        w = self.window
        self.fixed_mobile()
        w.tunnel_token.setText("hidden-fixture-token")
        w._mobile_token_edited()
        w.mobile_mode.setCurrentIndex(w.mobile_mode.findData("quick"))
        w.save_mobile()
        self.assertEqual(self.client.calls[-1][2], {"mode": "quick", "autoStart": False})
        self.assertTrue(w.fixed_fields.isHidden())

    def test_fixed_start_requires_usable_credentials_and_saves_before_start(self):
        w = self.window
        state = self.fixed_mobile()
        w.start_mobile()
        self.assertFalse(self.client.calls)
        self.assertIn("Tunnel Token", w.notice.text())
        w.tunnel_token.setText("fixture-saved-before-start")
        w._mobile_token_edited()
        w.start_mobile()
        self.assertEqual(self.client.calls[-1][0], "mobile-config")
        state["mobile"].update(tunnelTokenConfigured=True, fixedAuth="token")
        self.client.finish("mobile-config", {"ok": True, "mobile": state["mobile"]})
        self.assertEqual(self.client.calls[-1][0], "mobile-start")
        self.assertEqual(w.tunnel_token.text(), "")

    def test_token_controls_lock_during_runtime_and_saved_status_is_safe(self):
        w = self.window
        state = self.fixed_mobile()
        for status in ("starting", "running", "degraded", "stopping", "external"):
            with self.subTest(state=status):
                state["mobile"].update(state=status, managed=status != "external", tunnelTokenConfigured=True, fixedAuth=None)
                w.render_status(state)
                self.assertFalse(w.tunnel_token.isEnabled())
                self.assertFalse(w.clear_tunnel_token_button.isEnabled())
                self.assertIn("暂不可用", w.tunnel_token_status.text())

    def test_visible_prompt_tiers_offer_only_stock_and_compact(self):
        w = self.window
        self.assertEqual([key for _, key in w.tier._items], ["stock", "3"])
        self.assertEqual([text for text, _ in w.tier._items], ["官方原版", "最大化精简"])
        self.assertEqual(w.tier.currentData(), "stock")
        # The removed custom tier must not survive as a hidden control in the window.
        self.assertFalse(hasattr(w, "custom_prompt_button"))
        self.assertFalse(hasattr(w, "custom_prompt_status_label"))
        self.assertFalse(hasattr(w, "_custom_prompt_draft"))
        self.assertEqual(w.context._items, [("256K（默认）", "256k"), ("512K", "512k")])
        self.assertEqual(w.context.currentData(), "256k")
        self.assertIn("256,000", w.CTX_HINTS["256k"])
        self.assertIn("512,000", w.CTX_HINTS["512k"])

    def test_legacy_prompt_stays_until_explicit_prompt_choice(self):
        w = self.window
        w.confirm = lambda *args: True
        for legacy in ("1", "2", "4"):
            with self.subTest(legacy=legacy):
                before = len(self.client.calls)
                state = deepcopy(demo_snapshot())
                state["kernel"]["desired"]["promptTier"] = legacy
                w.render_status(state)
                self.assertIsNone(w.tier.currentData())
                self.assertIn("旧", w.tier_hint_label.text())
                w.apply_kernel()
                self.assertEqual(len(self.client.calls), before, "legacy tier must not be silently applied")
        state = deepcopy(demo_snapshot())
        state["kernel"]["desired"]["promptTier"] = "3"
        state["kernel"]["promptPreferenceVersion"] = 2
        state["kernel"]["targets"][0].update(promptTier="3", promptPayloadVersion=2, promptLegacy=True)
        w.render_status(state)
        self.assertEqual(w.tier.currentData(), "3")
        QTest.mouseClick(w.context._buttons[1], Qt.MouseButton.LeftButton)
        w.apply_kernel()
        self.assertEqual(self.client.calls[-1][2], {"contextMode": "512k"})
        state["kernel"]["desired"]["contextMode"] = "512k"
        self.client.finish("kernel-apply", {"ok": True, "kernel": state["kernel"]})
        QTest.mouseClick(w.tier._buttons[1], Qt.MouseButton.LeftButton)
        w.apply_kernel()
        self.assertEqual(self.client.calls[-1][2], {"promptTier": "3"})

    def test_kernel_apply_sends_exactly_the_two_axes(self):
        w = self.window
        w.confirm = lambda *args: True
        w.tier.setCurrentIndex(w.tier.findData("3"))
        w.context.setCurrentIndex(w.context.findData("512k"))
        w.apply_kernel()
        self.assertEqual(self.client.calls[-1][2], {"promptTier": "3", "contextMode": "512k"})

    def test_restore_sends_the_stock_axes_only(self):
        w = self.window
        w.confirm = lambda *args: True
        w.apply_kernel(restore=True)
        self.assertEqual(
            self.client.calls[-1][2],
            {"promptTier": "stock", "contextMode": "256k"},
        )

    def test_fixed_token_form_is_reachable_in_both_themes_at_minimum_size(self):
        w = self.window
        self.fixed_mobile()
        w.navigate(2, animate=False)
        for dark in (True, False):
            with self.subTest(dark=dark):
                w.set_dark(dark, persist=False)
                w.settle_animations()
                self.app.processEvents()
                scroll = w.mobile_scroll
                self.assertLessEqual(scroll.widget().width(), scroll.viewport().width())
                for control in (w.tunnel_token, w.fixed_url, w.save_mobile_button):
                    scroll.ensureWidgetVisible(control, 0, 0)
                    self.app.processEvents()
                    origin = control.mapTo(scroll.viewport(), control.rect().topLeft())
                    self.assertGreaterEqual(origin.x(), 0)
                    self.assertLessEqual(origin.x() + control.width(), scroll.viewport().width())
                    self.assertGreaterEqual(origin.y(), 0)
                    self.assertLessEqual(origin.y() + control.height(), scroll.viewport().height())
                self.assertGreaterEqual(w.tunnel_token_status.font().pixelSize(), 12)

    def test_logs_show_all_categories_and_keep_keyword_filter(self):
        w = self.window
        w.navigate(3, animate=False)
        w.set_logs([
            {"at": "2026-11-16T01:00:00Z", "category": "SYSTEM", "message": "system ready"},
            {"at": "2026-11-16T01:00:01Z", "category": "PROXY", "message": "proxy connected"},
            {"at": "2026-11-16T01:00:02Z", "category": "KERNEL", "message": "pin=12345678"},
            {"at": "2026-11-16T01:00:03Z", "category": "CUSTOM", "message": "custom event"},
        ])
        self.assertFalse(hasattr(w, "log_category"))
        for category in ("SYSTEM", "PROXY", "KERNEL", "CUSTOM"):
            self.assertIn(f"[{category}]", w.logs.toPlainText())
        self.assertNotIn("12345678", w.logs.toPlainText())
        w.log_filter.setText("proxy connected")
        self.assertIn("[PROXY]", w.logs.toPlainText())
        self.assertNotIn("[SYSTEM]", w.logs.toPlainText())
        w.log_filter.clear()
        self.assertIn("[CUSTOM]", w.logs.toPlainText())

    def test_long_identity_keeps_card_actions_inside_minimum_window(self):
        w = self.window
        state = deepcopy(demo_snapshot())
        long_email = "firstname.lastname.verylongdepartment.member@engineering.example.com"
        state["accounts"]["items"][0].update(name="Long account identity " * 8, email=long_email)
        w.render_status(state)
        w.settle_animations()
        self.app.processEvents()
        viewport = w.accounts_scroll.viewport()
        self.assertLessEqual(w.accounts_container.width(), viewport.width())
        self.assertEqual(w.selected_acc_email.text(), long_email)
        self.assertEqual(w.selected_acc_email.toolTip(), long_email)
        for card in w._account_cards:
            for button in card.findChildren(QPushButton):
                origin = button.mapTo(viewport, button.rect().topLeft())
                self.assertGreaterEqual(origin.x(), 0)
                self.assertLessEqual(origin.x() + button.width(), viewport.width())
                self.assertTrue(button.isVisible())

    def test_numbered_shortcuts_cover_exactly_the_four_visible_pages(self):
        w = self.window
        keys = sorted(s.key().toString() for s in w.findChildren(QShortcut))
        self.assertEqual(keys, ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+R"])
        # In-app links still resolve the retired indices onto existing pages.
        w.navigate(4, animate=False)
        self.assertEqual(w.stack.currentIndex(), 2)
        w.navigate(5, animate=False)
        self.assertEqual(w.stack.currentIndex(), 3)

    def test_kernel_controls_need_an_explicit_support_flag(self):
        w = self.window
        controls = (w.tier, w.context, w.kernel_button, w.restore_button)
        state = deepcopy(demo_snapshot())
        w.render_status(state)
        self.assertTrue(all(c.isEnabled() for c in controls))
        self.assertNotIn("未报告", w.kernel_hint.text())

        missing = deepcopy(demo_snapshot())
        del missing["kernel"]["platformSupported"]
        w.render_status(missing)
        self.assertTrue(all(not c.isEnabled() for c in controls))
        self.assertIn("未报告", w.kernel_hint.text())

        unsupported = deepcopy(demo_snapshot())
        unsupported["kernel"]["platformSupported"] = False
        w.render_status(unsupported)
        self.assertTrue(all(not c.isEnabled() for c in controls))
        self.assertIn("不支持", w.kernel_hint.text())

    def test_mobile_page_names_the_desktop_precondition_without_faking_online(self):
        w = self.window
        state = deepcopy(demo_snapshot())
        w.render_status(state)
        self.assertIn("桌面端 Antigravity 未运行", w.mobile_desktop_note.text())
        self.assertIn("未连接桌面端", w.mobile_desktop_note.text())

        state["phase"] = "running"
        w.render_status(state)
        self.assertIn("桌面端 Antigravity 运行中", w.mobile_desktop_note.text())
        self.assertNotIn("未连接桌面端", w.mobile_desktop_note.text())
        self.assertNotIn("在线", w.mobile_desktop_note.text())

        w.set_online(False)
        w.render_mobile(state["mobile"])
        self.assertIn("桌面端尚未连接", w.mobile_desktop_note.text())
        self.assertIn("不会显示虚假在线", w.mobile_desktop_note.text())

    def test_demo_window_previews_actions_without_mutating_anything(self):
        demo = MainWindow(demo=True)
        try:
            demo.resize(940, 580)
            demo.show()
            demo.render_status(demo_snapshot())
            demo.set_logs([])
            demo.navigate(0, animate=False)
            demo.settle_animations()
            self.app.processEvents()
            self.assertTrue(demo.kernel_button.isEnabled())
            self.assertTrue(demo.account_tools.capture_button.isEnabled())
            self.assertTrue(demo.account_tools.import_button.isEnabled())
            self.assertFalse(demo.perform("kernel-apply", "/api/kernel/apply", {}))
            self.assertIn("预览模式", demo.notice.text())
            self.assertEqual(demo._pending, {})
            with patch.object(QDialog, "exec", side_effect=AssertionError("demo opened a dialog")), \
                    patch.object(QFileDialog, "getOpenFileName", side_effect=AssertionError("demo opened a file dialog")), \
                    patch.object(QFileDialog, "getSaveFileName", side_effect=AssertionError("demo opened a file dialog")):
                demo.account_tools.capture_current()
                demo.account_tools.import_accounts()
                demo.account_tools.export_accounts()
            self.assertEqual(demo._pending, {})
            self.assertIn("预览模式", demo.notice.text())
            self.assertIn("预览模式", demo.mobile_desktop_note.text())
        finally:
            demo._closing = True
            demo.hide()
            demo.deleteLater()
            QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()


if __name__ == "__main__":
    unittest.main()
