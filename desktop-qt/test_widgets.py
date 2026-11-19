"""Synthetic Qt label/card geometry tests: no settings, accounts, or services."""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QPoint, QSettings, QTemporaryDir, Qt
from PyQt6.QtGui import QFont, QFontMetrics
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QLabel, QPushButton, QScrollArea, QVBoxLayout, QWidget

from theme import stylesheet
from widgets import AccountCardWidget, ElidedLabel, QuotaBarWidget


class AccountIdentityLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyle("Fusion")
        cls.settings_dir = QTemporaryDir()
        QSettings.setDefaultFormat(QSettings.Format.IniFormat)
        QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, cls.settings_dir.path())

    def setUp(self):
        self.widgets = []

    def tearDown(self):
        for widget in self.widgets:
            widget.close()
            widget.deleteLater()
        self.app.processEvents()

    def keep(self, widget):
        self.widgets.append(widget)
        return widget

    def make_card(self, *, name, email, dark=True, **extra):
        account = {
            "id": "synthetic-account", "name": name, "email": email,
            "status": "valid", "tier": "ULTRA", "lastSwitchedAt": 1700000000000,
            **extra,
        }
        card = AccountCardWidget(account, None, False, False, True, dark)
        card.setStyleSheet(stylesheet(dark))
        return card

    def test_full_value_plain_text_and_tooltip_survive_resize_and_update(self):
        full = "<b>" + "very.long.identity." * 35 + "@example.invalid</b>"
        label = self.keep(ElidedLabel(full))
        label.resize(90, 28)
        label.show()
        self.app.processEvents()
        self.assertEqual(label.text(), full)
        self.assertEqual(label.toolTip(), full)
        self.assertEqual(label.textFormat(), Qt.TextFormat.PlainText)
        self.assertEqual(label.minimumSizeHint().width(), 0)
        self.assertLess(label.width(), label.fontMetrics().horizontalAdvance(full))
        self.assertFalse(label.grab().isNull())
        label.resize(140, 28)
        replacement = "updated." * 40 + "@example.invalid"
        label.setText(replacement)
        self.app.processEvents()
        self.assertEqual(label.text(), replacement)
        self.assertEqual(label.toolTip(), replacement)
        label.setText("")
        self.assertEqual(label.toolTip(), "")

    def test_ordinary_names_keep_native_label_rendering_and_style(self):
        for dark in (True, False):
            for role, text in (("Section", "Taylor Chen"), ("MonoMuted", "taylor@example.invalid")):
                with self.subTest(dark=dark, role=role):
                    expected = self.keep(QLabel(text))
                    actual = self.keep(ElidedLabel(text))
                    for label in (expected, actual):
                        label.setObjectName(role)
                        label.setStyleSheet(stylesheet(dark))
                        label.resize(320, 30)
                        label.show()
                    self.app.processEvents()
                    self.assertEqual(actual.text(), expected.text())
                    self.assertEqual(actual.font(), expected.font())
                    self.assertEqual(actual.palette(), expected.palette())
                    self.assertEqual(actual.grab().toImage(), expected.grab().toImage())

    def test_long_card_identity_keeps_switch_button_within_constrained_width(self):
        name = "VeryLongSyntheticAccountName" * 24
        email = "very.long.synthetic.account." * 24 + "@example.invalid"
        for dark in (True, False):
            for width in (420, 520, 640):
                with self.subTest(dark=dark, width=width):
                    card = self.keep(self.make_card(name=name, email=email, dark=dark))
                    card.resize(width, card.sizeHint().height())
                    card.show()
                    self.app.processEvents()
                    self.assertEqual(card.width(), width)
                    button = card.findChild(QPushButton, "AccentSoft")
                    self.assertIsNotNone(button)
                    self.assertTrue(card.rect().contains(button.geometry()))
                    self.assertGreaterEqual(button.width(), button.minimumSizeHint().width())
                    labels = card.findChildren(ElidedLabel)
                    self.assertEqual(len(labels), 2)
                    self.assertEqual(labels[0].text(), name)
                    self.assertTrue(labels[1].text().startswith(email))
                    for label in labels:
                        self.assertEqual(label.toolTip(), label.text())
                        self.assertLess(label.width(), label.fontMetrics().horizontalAdvance(label.text()))
                        self.assertLess(label.geometry().right(), button.geometry().left())
                        self.assertFalse(label.grab().isNull())
                    actions = []
                    card.action_triggered.connect(lambda *args: actions.append(args))
                    QTest.mouseClick(button, Qt.MouseButton.LeftButton)
                    self.assertEqual(actions, [("switch", "synthetic-account")])

    def test_long_card_identity_does_not_force_scroll_content_wider(self):
        viewport = self.keep(QScrollArea())
        viewport.setWidgetResizable(True)
        viewport.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        content = QWidget()
        layout = QVBoxLayout(content)
        layout.setContentsMargins(0, 0, 0, 0)
        card = self.make_card(name="SyntheticName" * 60, email="identity." * 80 + "@example.invalid")
        layout.addWidget(card)
        layout.addStretch(1)
        viewport.setWidget(content)
        viewport.resize(440, 300)
        viewport.show()
        self.app.processEvents()
        self.assertLessEqual(content.width(), viewport.viewport().width())
        self.assertLessEqual(card.width(), viewport.viewport().width())
        self.assertEqual(viewport.horizontalScrollBar().maximum(), 0)
        button = card.findChild(QPushButton, "AccentSoft")
        self.assertTrue(card.rect().contains(button.geometry()))

    def test_three_models_and_zero_weekly_window_all_remain_visible(self):
        quota = {
            "models": [
                {"key": f"model-{i}", "label": f"Synthetic Model {i}", "percentage": 80 - i * 20}
                for i in range(3)
            ],
            "windows": [{"key": "weekly", "label": "周额度", "percentage": 0, "resetText": "下周一重置"}],
        }
        card = self.keep(self.make_card(name="Synthetic", email="quota@example.invalid", quota=quota))
        card.resize(420, card.sizeHint().height())
        card.show()
        self.app.processEvents()
        self.assertEqual(len(card._quota_bars), 4)
        self.assertEqual([bar._full_label for bar in card._quota_bars],
                         ["Synthetic Model 0", "Synthetic Model 1", "Synthetic Model 2", "周额度"])
        weekly = card._quota_bars[-1]
        self.assertEqual(weekly._pct, 0)
        self.assertIn("0%", weekly.toolTip())
        self.assertIn("下周一重置", weekly.toolTip())
        for bar in card._quota_bars:
            self.assertTrue(bar.isVisible())
            self.assertTrue(card.rect().contains(bar.geometry()))
            self.assertGreater(bar.width(), 0)

    def test_historical_model_and_window_aliases_display_once_with_zero_weekly(self):
        for with_windows in (False, True):
            with self.subTest(explicit_windows=with_windows):
                models = [
                    {"key": "gemini-argon", "shortLabel": "Gemini 4 Argon (周限)", "percentage": 0},
                    {"key": "claude", "shortLabel": "Claude (5h)", "percentage": 50},
                    {"key": "gemini", "shortLabel": "Gemini 3.8 (5h)", "percentage": 50},
                ]
                windows = [
                    {"key": "gemini-argon-wtu-weekly", "label": "Gemini 4 Argon (周限)", "percentage": 0},
                    {"key": "3p-5h", "label": "Claude (5h)", "percentage": 50},
                    {"key": "claude:5h", "label": "Claude (5h)", "percentage": 50},
                    {"key": "gemini-5h", "label": "Gemini 3.8 (5h)", "percentage": 50},
                    {"key": "gemini:5h", "label": "Gemini 3.8 (5h)", "percentage": 50},
                    {"key": "3p-weekly", "label": "Claude (周限)", "percentage": 0, "resetText": "下周一重置"},
                    {"key": "claude:weekly", "label": "Claude (周限)", "percentage": 0},
                ]
                if with_windows:
                    for item in models + windows:
                        item["window"] = "weekly" if "weekly" in item["key"] or "argon" in item["key"] else "5h"
                quota = {"models": models, "windows": windows}
                card = self.keep(self.make_card(name="Synthetic", email="quota@example.invalid", quota=quota))
                self.assertEqual([bar._full_label for bar in card._quota_bars],
                                 ["Gemini 4 Argon (周限)", "Claude (5h)", "Gemini 3.8 (5h)", "Claude (周限)"])
                self.assertEqual([bar._pct for bar in card._quota_bars], [0, 50, 50, 0])
                self.assertIn("下周一重置", card._quota_bars[-1].toolTip())
                self.assertNotIn("quotaKey", models[0])

    def test_same_percentage_distinct_model_and_explicit_windows_are_not_deduplicated(self):
        quota = {"models": [
            {"key": "custom-a", "label": "Custom A", "percentage": 50, "window": "5h"},
            {"key": "custom-b", "label": "Custom B", "percentage": 50, "window": "5h"},
            {"key": "shared", "label": "Shared 5h", "percentage": 50, "window": "5h"},
            {"key": "shared", "label": "Shared weekly", "percentage": 50, "window": "weekly"},
            {"key": "claude", "shortLabel": "Claude (5h)", "percentage": 50},
        ], "windows": [
            {"key": "gemini-5h", "label": "Gemini (5h)", "percentage": 50},
            {"key": "3p-weekly", "label": "Claude (周限)", "percentage": 50},
        ]}
        card = self.keep(self.make_card(name="Synthetic", email="quota@example.invalid", quota=quota))
        self.assertEqual(len(card._quota_bars), 7)
        self.assertEqual([bar._full_label for bar in card._quota_bars],
                         ["Custom A", "Custom B", "Shared 5h", "Shared weekly", "Claude (5h)", "Gemini (5h)", "Claude (周限)"])

    def test_explicit_quota_keys_match_legacy_aliases_without_collapsing_new_buckets(self):
        quota = {"models": [
            {"key": "provider-model-a", "quotaKey": "claude:5h", "label": "Claude shared", "percentage": 50},
            {"key": "provider-model-a", "quotaKey": "claude-new:5h", "label": "Claude independent", "percentage": 50},
        ], "windows": [
            {"key": "3p-5h", "label": "Claude duplicate", "percentage": 50},
            {"key": "provider-weekly", "quotaKey": "claude:weekly", "label": "Claude weekly", "percentage": 0},
            {"key": "3p-weekly", "label": "Claude weekly duplicate", "percentage": 0},
        ]}
        card = self.keep(self.make_card(name="Synthetic", email="quota@example.invalid", quota=quota))
        self.assertEqual([bar._full_label for bar in card._quota_bars],
                         ["Claude shared", "Claude independent", "Claude weekly"])
        self.assertEqual(card._quota_bars[-1]._pct, 0)

    def test_enabled_window_is_not_hidden_by_disabled_model(self):
        quota = {"models": [{"key": "claude", "shortLabel": "Claude (5h)", "disabled": True}],
                 "windows": [{"key": "3p-5h", "label": "Claude (5h)", "percentage": 0}]}
        card = self.keep(self.make_card(name="Synthetic", email="quota@example.invalid", quota=quota))
        self.assertEqual(len(card._quota_bars), 1)
        self.assertEqual(card._quota_bars[0]._pct, 0)
        self.assertFalse(card._quota_bars[0]._disabled)

    def test_window_only_and_no_quota_keep_meaningful_fallbacks(self):
        for quota in ({"windows": [{"key": "weekly", "label": "周额度", "percentage": 17}]}, {}, None):
            with self.subTest(quota=quota):
                card = self.keep(self.make_card(name="Synthetic", email="quota@example.invalid", quota=quota))
                card.resize(420, card.sizeHint().height())
                card.show()
                self.app.processEvents()
                if quota:
                    self.assertEqual(len(card._quota_bars), 1)
                    self.assertEqual(card._quota_bars[0]._full_label, "周额度")
                    self.assertIn("17%", card._quota_bars[0].toolTip())
                else:
                    self.assertFalse(card._quota_bars)
                    self.assertTrue(any("暂无缓存配额" in label.text() and label.isVisible()
                                        for label in card.findChildren(QLabel)))

    def test_many_long_quota_entries_fit_compact_scroll_in_both_themes(self):
        long_name = "Very long synthetic model identifier " * 12
        reset = "每周一北京时间 23:59 后重置 " * 8
        quota = {
            "models": [{"key": f"model-{i}", "label": f"{i} {long_name}", "percentage": i * 10,
                        "resetText": reset} for i in range(7)],
            "windows": [{"key": "weekly", "label": "周额度", "percentage": 0, "resetText": reset}],
        }
        for dark in (True, False):
            for width in (420, 520):
                with self.subTest(dark=dark, width=width):
                    scroll = self.keep(QScrollArea())
                    scroll.setWidgetResizable(True)
                    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
                    content = QWidget()
                    layout = QVBoxLayout(content)
                    layout.setContentsMargins(0, 0, 0, 0)
                    card = self.make_card(name="Synthetic", email="quota@example.invalid", dark=dark, quota=quota)
                    layout.addWidget(card)
                    layout.addStretch(1)
                    scroll.setWidget(content)
                    scroll.resize(width, 240)
                    scroll.show()
                    self.app.processEvents()
                    self.assertEqual(len(card._quota_bars), 8)
                    self.assertLessEqual(content.width(), scroll.viewport().width())
                    self.assertEqual(scroll.horizontalScrollBar().maximum(), 0)
                    occupied = []
                    for bar in card._quota_bars:
                        self.assertTrue(card.rect().contains(bar.geometry()))
                        self.assertGreaterEqual(bar.width(), 100)
                        self.assertTrue(all(not bar.geometry().intersects(other) for other in occupied))
                        occupied.append(bar.geometry())
                        self.assertIn(bar._full_label, bar.toolTip())
                        self.assertIn(reset, bar.toolTip())
                        self.assertFalse(bar.grab().isNull())
                    scroll.ensureWidgetVisible(card._quota_bars[-1])
                    self.app.processEvents()
                    last = card._quota_bars[-1]
                    visible_rect = last.rect().translated(last.mapTo(scroll.viewport(), QPoint()))
                    self.assertTrue(scroll.viewport().rect().contains(visible_rect))

    def test_long_reset_text_has_separate_clipped_paint_bounds(self):
        for disabled, pct in ((False, 0), (False, 100), (True, None)):
            with self.subTest(disabled=disabled, pct=pct):
                bar = self.keep(QuotaBarWidget("Synthetic very long model name " * 10, pct,
                                              "Long synthetic reset text " * 20, disabled))
                bar.resize(130, 32)
                bar.show()
                self.app.processEvents()
                label_font = QFont(bar.font())
                label_font.setPointSize(9)
                value_font = QFont("Cascadia Mono", 9)
                value_font.setBold(True)
                label_metrics, value_metrics = QFontMetrics(label_font), QFontMetrics(value_font)
                label_rect, value_rect, label_text, value_text = bar._text_layout(label_metrics, value_metrics)
                self.assertFalse(label_rect.intersects(value_rect))
                self.assertGreater(label_rect.width(), 0)
                self.assertGreater(value_rect.width(), 0)
                self.assertLessEqual(value_rect.right(), bar.width())
                self.assertGreaterEqual(label_rect.height(), label_metrics.height())
                self.assertGreaterEqual(value_rect.height(), value_metrics.height())
                self.assertLessEqual(value_rect.bottom() + 10, bar.height())
                self.assertLessEqual(label_metrics.horizontalAdvance(label_text), label_rect.width())
                self.assertLessEqual(value_metrics.horizontalAdvance(value_text), value_rect.width())
                if pct is not None:
                    self.assertTrue(value_text.startswith(f"{pct}%"))
                self.assertIn("Long synthetic reset text", bar.toolTip())

    def test_short_model_names_leave_room_for_ordinary_reset_values(self):
        for label, pct, reset in (("Gemini 4 Argon (周限)", 82, "5d 4h"),
                                  ("Claude (5h)", 64, "2h 18m"),
                                  ("周额度", 0, "下周一重置")):
            with self.subTest(label=label):
                bar = self.keep(QuotaBarWidget(label, pct, reset))
                bar.resize(238, 32)
                label_font = QFont(bar.font())
                label_font.setPointSize(9)
                value_font = QFont("Cascadia Mono", 9)
                value_font.setBold(True)
                label_rect, value_rect, label_text, value_text = bar._text_layout(
                    QFontMetrics(label_font), QFontMetrics(value_font))
                self.assertEqual(label_text, bar._label)
                self.assertEqual(value_text, f"{pct}% · {reset}")
                self.assertFalse(label_rect.intersects(value_rect))

    def test_full_window_quota_visibility_at_supported_sizes_and_themes(self):
        from main import demo_snapshot
        from smoke_test import FakeClient
        from ui import MainWindow

        window = self.keep(MainWindow(demo=False))
        client = FakeClient()
        window.bind_client(client)
        state = demo_snapshot()
        state["accounts"]["items"][0]["quota"]["windows"] = [
            {"key": "weekly", "label": "周额度", "percentage": 0, "resetText": "下周一重置"}
        ]
        state["accounts"]["items"][1]["quota"] = {
            "models": [{"key": f"long-{i}", "label": f"Model {i} " + "Long synthetic identifier " * 8,
                        "percentage": 100 - i * 10, "resetText": "下周一北京时间 23:59 后重置 " * 8}
                       for i in range(7)],
            "windows": [{"key": "weekly", "label": "周额度", "percentage": 0, "resetText": "下周一重置"}],
        }
        window.render_status(state)
        window.navigate(1, animate=False)
        window.show()
        try:
            for dark in (True, False):
                window.set_dark(dark, persist=False)
                for width, height in ((940, 580), (1120, 640)):
                    with self.subTest(dark=dark, width=width, height=height):
                        window.resize(width, height)
                        window.settle_animations()
                        self.app.processEvents()
                        desktop = self.app.primaryScreen()
                        desktop = desktop.availableGeometry() if desktop else None
                        if desktop is None or (width <= desktop.width() and height <= desktop.height()):
                            self.assertEqual((window.width(), window.height()), (width, height))
                        else:
                            # A real window manager clamps the frame to the screen (CI desktops are
                            # 1024 wide); the offscreen platform keeps the requested size.
                            self.assertGreaterEqual(window.width(), min(width, desktop.width()))
                        self.assertFalse(hasattr(window, "quota_detail"))
                        scroll = window.accounts_scroll
                        self.assertEqual(scroll.horizontalScrollBar().maximum(), 0)
                        self.assertLessEqual(scroll.widget().width(), scroll.viewport().width())
                        self.assertEqual([len(card._quota_bars) for card in window._account_cards], [4, 8])
                        for card in window._account_cards:
                            for bar in card._quota_bars:
                                self.assertTrue(card.rect().contains(bar.geometry()))
                                self.assertGreaterEqual(bar.width(), 100)
                            weekly = card._quota_bars[-1]
                            self.assertIn("周额度：0%", weekly.toolTip())
                            scroll.ensureWidgetVisible(weekly, 0, 0)
                            self.app.processEvents()
                            visible_rect = weekly.rect().translated(weekly.mapTo(scroll.viewport(), QPoint()))
                            self.assertTrue(scroll.viewport().rect().contains(visible_rect))
        finally:
            window._closing = True
            window.hide()


if __name__ == "__main__":
    unittest.main()
