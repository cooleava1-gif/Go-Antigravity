"""Native Qt interaction smoke test. Fake API only; never opens accounts or real services."""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import re
import sys

from PyQt6.QtCore import QEvent, QObject, QSettings, QTemporaryDir, Qt, pyqtSignal
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QLineEdit, QPushButton, QStackedWidget

from main import demo_logs, demo_snapshot
from theme import DARK, LIGHT, PALETTE_KEYS, stylesheet
from ui import MainWindow
from widgets import AccountCardWidget, SegmentedControl, ToggleSwitch

PAGE_KEYS = ("workbench", "accounts", "mobile", "logs")


class FakeClient(QObject):
    """Synthetic-only client: records requests and emits in-memory responses."""

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
        self.logs_received.emit(demo_logs())

    def refresh(self):
        pass

    def request(self, action, route, body=None, **kwargs):
        self.calls.append((action, route, body, kwargs))
        return True

    def finish(self, action, data):
        self.operation_finished.emit(action, data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / ".qa")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    app = QApplication(sys.argv[:1])
    app.setStyle("Fusion")
    settings_dir = QTemporaryDir()
    QSettings.setDefaultFormat(QSettings.Format.IniFormat)
    QSettings.setPath(QSettings.Format.IniFormat, QSettings.Scope.UserScope, settings_dir.path())
    w = MainWindow(demo=False)
    w.set_dark(True, persist=False)
    w.resize(1120, 650)

    checks = []

    def check(condition, name):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    check(callable(getattr(w, "settle_animations", None)), "animation settle hook")

    def settle():
        w.settle_animations()
        QApplication.processEvents()

    w.show()
    # Exercise real button signals with the constructor animation still present.
    for index in (1, 2, 3, 0):
        QTest.mouseClick(w.nav_buttons[index], Qt.MouseButton.LeftButton)
        QApplication.processEvents()
        check(w.stack.currentIndex() == index, f"animated navigation click {index} without settling")
    settle()

    # Theme contract: DARK/LIGHT keep every palette key; QSS has no fractional rgba.
    check(set(DARK) >= set(PALETTE_KEYS) and set(LIGHT) >= set(PALETTE_KEYS), "DARK/LIGHT preserve all palette keys")
    check(bool(stylesheet().strip()) and bool(stylesheet(False).strip()) and bool(stylesheet(True).strip()),
          "stylesheet() default, light and dark are non-empty")
    for dark in (False, True):
        css = stylesheet(dark)
        check(not re.search(r"rgba[^)]*[.][0-9]", css), "stylesheet has no fractional rgba")
        check(all(sel in css for sel in ("QPushButton#NavPill", "QPushButton#Primary", "QPushButton#SegmentBtn")),
              "stylesheet styles Liquid Glass nav pills and segmented buttons")

    # Horizontal 4-tab workspace contract; zero emoji nav tabs.
    check(len(w.PAGES) == 4, "PAGES has exactly four entries")
    check(tuple(page[0] for page in w.PAGES) == PAGE_KEYS, "horizontal four-page keys")
    check(isinstance(w.stack, QStackedWidget) and w.stack.count() == 4, "four QStackedWidget views")
    check(len(w.nav_buttons) == 4 and all(b.isCheckable() and b.objectName() == "NavPill" for b in w.nav_buttons),
          "four checkable NavPill buttons")
    check(all(not any(0x2600 <= ord(ch) <= 0x27BF or ord(ch) >= 0x1F000 for ch in b.text()) for b in w.nav_buttons),
          "nav pills use clean SVG icons without emojis")
    check(all(w.nav_group.id(b) == i for i, b in enumerate(w.nav_buttons)), "nav button group ids 0..3")
    check(isinstance(w.tier, SegmentedControl) and isinstance(w.context, SegmentedControl),
          "kernel tier and context use Liquid Glass SegmentedControl")
    check([key for _, key in w.tier._items] == ["stock", "3"], "visible prompt tier keys")
    check([key for _, key in w.context._items] == ["stock", "512k", "900k"], "context mode keys")
    check("1M" in w.context._items[2][0], "900K / 1M context label")
    check(isinstance(w.preflight, ToggleSwitch) and isinstance(w.i18n, ToggleSwitch),
          "settings switches use ToggleSwitch")

    all_buttons = w.findChildren(QPushButton)
    check(sum(1 for b in all_buttons if b.text() == w.launch_button.text()) == 1, "single launch button")
    check(sum(1 for b in all_buttons if "检测" in b.text()) == 1, "single detection button")

    fake = FakeClient()
    w.bind_client(fake)
    settle()
    check(w.client is fake, "synthetic FakeClient bound")

    for i, b in enumerate(w.nav_buttons):
        QTest.mouseClick(b, Qt.MouseButton.LeftButton)
        settle()
        check(w.active_card == i and w.stack.currentIndex() == i and b.isChecked(), f"nav button activates {PAGE_KEYS[i]}")

    for i, key in enumerate(PAGE_KEYS):
        w.navigate(i)
        settle()
        check(w.active_card == i and w.nav_buttons[i].isChecked(), f"navigate activates {key}")
    w.navigate(4)
    settle()
    check(w.active_card == 2 and w.nav_buttons[2].isChecked(), "navigate(4) maps to mobile")
    w.navigate(5)
    settle()
    check(w.active_card == 3 and w.nav_buttons[3].isChecked(), "navigate(5) maps to logs")
    w.navigate(99)
    settle()
    check(w.active_card == 3, "out-of-range navigate ignored")
    w.navigate(0)
    settle()

    # Workbench: port presets, dirty preservation, async lock, kernel restore.
    w._apply_port_preset(7897)
    check(w.port.value() == 7897 and "network" in w._dirty, "port preset updates value and marks dirty")
    w.port.setValue(8080)
    w.render_status(demo_snapshot())
    check(w.port.value() == 8080, "poll preserves unsaved edits")
    QTest.mouseClick(w.save_network_button, Qt.MouseButton.LeftButton)
    check(fake.calls[-1][1:3] == ("/api/config", {"port": 8080, "preflightProxy": True}), "save exact network payload")
    check(not w.save_network_button.isEnabled(), "network save prevents duplicate clicks")
    check(all(not chip.isEnabled() for _, chip in w._port_chips), "network save locks every port preset")
    QTest.mouseClick(w._port_chips[1][1], Qt.MouseButton.LeftButton)
    w._apply_port_preset(7897)
    check(w.port.value() == 8080, "pending save blocks newer preset edits before response")
    fake.finish("config-network", {"ok": True, "settings": {"port": 8080, "preflightProxy": True}})
    check("network" not in w._dirty and w.save_network_button.isEnabled(), "success clears dirty and unlocks")
    check(w.port.value() == 8080 and all(chip.isEnabled() for _, chip in w._port_chips),
          "network response keeps saved port and unlocks presets")

    w.check_proxy()
    check(fake.calls[-1][0] == "proxy-check" and not w.proxy_button.isEnabled(), "proxy check async busy")
    fake.error.emit("proxy-check", "模拟超时")
    check(w.proxy_button.isEnabled(), "proxy failure unlocks button")

    w.confirm = lambda *args: False
    before = len(fake.calls)
    w.apply_kernel()
    check(len(fake.calls) == before, "cancelled kernel confirmation never mutates")
    w.confirm = lambda *args: True
    w.apply_kernel(restore=True)
    check(fake.calls[-1][2] == {"promptTier": "stock", "contextMode": "stock"}, "restore exact kernel axes")
    fake.error.emit("kernel-apply", "模拟取消")

    # Accounts: cards, inline quota bars, search, quota sort, OAuth URL validation.
    w.navigate(1)
    settle()
    check(len(w._account_cards) == 2 and all(isinstance(c, AccountCardWidget) for c in w._account_cards),
          "account pool renders rich AccountCardWidget cards")
    def card_buttons():
        return [button for card in w._account_cards for button in card.findChildren(QPushButton)]

    w._select_card_id("demo-b")
    w.confirm = lambda *args: True
    w.switch_account()
    check("account-switch" in w._pending and all(not b.isEnabled() for b in card_buttons()),
          "account mutation immediately locks existing card actions")
    w.account_search.setText("personal")
    check(len(w._account_cards) == 1, "account search filters cards")
    check(all(not b.isEnabled() for b in card_buttons()), "cards rebuilt during mutation remain locked")
    fake.error.emit("account-switch", "模拟切换失败")
    w.render_status(deepcopy(w.snapshot))
    check(not w._pending and all(b.isEnabled() for b in card_buttons()),
          "failed mutation unlocks cards even with unchanged cached accounts")
    fake.connection_changed.emit(False)
    check(all(not b.isEnabled() for b in card_buttons()), "disconnect immediately locks cached account cards")
    fake.connection_changed.emit(True)
    check(all(b.isEnabled() for b in card_buttons()), "reconnect unlocks cached account cards")
    w._select_card_id("demo-b")
    w.select_account()
    check(fake.calls[-1][2] == {"id": "demo-b"}, "selection uses stable account ID")
    fake.finish("account-select", {"ok": True, "accounts": {"activeId": "demo-b", "items": deepcopy(w._account_items)}})
    w.account_search.clear()

    w.start_oauth()
    authorization = "https://accounts.google.com/o/oauth2/v2/auth?state=demo-only"
    fake.finish("oauth-start", {"ok": True, "authUrl": authorization, "state": "demo-only"})
    check(w.oauth_url.text() == authorization and w.oauth_open_button.isEnabled(), "OAuth browser recovery link available")
    check(not w.valid_oauth_url("https://accounts.google.com.evil.test/o/oauth2/v2/auth"), "OAuth rejects foreign domains")
    w.render_oauth(None)
    check(not w.oauth_url.text(), "OAuth completion clears recovery URL")

    s = deepcopy(w.snapshot)
    s["accounts"]["items"][0]["quota"] = {"models": [], "windows": [{"key": "weekly", "label": "周额度", "percentage": 90, "resetText": "明日重置"}]}
    s["accounts"]["items"][1]["quota"] = {"models": [{"key": "model", "shortLabel": "Model", "percentage": 20}]}
    w.render_status(s)
    w.account_sort.setCurrentIndex(w.account_sort.findData("quota"))
    check(w._account_cards[0]._account_id == s["accounts"]["items"][0]["id"], "quota sort includes window-only accounts")
    w._select_card_id(s["accounts"]["items"][0]["id"])
    weekly_card = next(card for card in w._account_cards if card._account_id == s["accounts"]["items"][0]["id"])
    check(any("周额度" in bar.toolTip() and "90%" in bar.toolTip() and "明日重置" in bar.toolTip()
              for bar in weekly_card._quota_bars), "weekly quota and reset remain in account card")
    check(not hasattr(w, "quota_detail"), "selected account omits duplicate quota text")
    w.account_sort.setCurrentIndex(0)

    # Mobile Remote: stopped clears localUrl, fixed_url visibility tracks mode, invalid fixed URL blocked, starting cancellable, running QR, external locked, PIN auto-mask.
    w.navigate(2)
    settle()
    s_stopped_local = demo_snapshot()
    s_stopped_local["mobile"] = {"state": "stopped", "mode": "quick", "localUrl": "http://127.0.0.1:3082/", "publicUrl": None, "pin": None, "managed": False, "available": True}
    w.render_status(s_stopped_local)
    check(w.mobile_url.text() == "" and w.mobile_qr_frame.isHidden(), "stopped mobile never leaks localUrl into QR or URL field")
    check(w.fixed_url.isHidden(), "fixed_url hidden in quick tunnel mode")

    w.mobile_mode.setCurrentIndex(w.mobile_mode.findData("fixed"))
    check(not w.fixed_url.isHidden(), "fixed_url visible when switched to fixed mode")
    w.fixed_url.setText("http://insecure.example.com/path")
    before = len(fake.calls)
    w.save_mobile()
    check(len(fake.calls) == before, "invalid non-HTTPS fixed URL blocked before request")

    w.fixed_url.setText("https://remote.example.com")
    w.start_mobile()
    check(len(fake.calls) == before + 1 and fake.calls[-1][1] == "/api/mobile/config", "mobile saves dirty config before start")
    fake.finish("mobile-config", {"ok": True, "mobile": {"state": "stopped", "mode": "fixed", "fixedUrl": "https://remote.example.com", "tunnelTokenConfigured": True, "fixedAuth": "token"}})
    check(fake.calls[-1][1] == "/api/mobile/start" and fake.calls[-1][3].get("timeout_ms", 0) >= 70000,
          "mobile start uses >=70s timeout matching backend STARTUP_MS")
    check(w.mobile_stop_button.isEnabled() and not w.mobile_start_button.isEnabled(),
          "mobile stop button stays enabled to cancel in-flight startup")
    fake.error.emit("mobile-start", "模拟启动取消")

    s_run = demo_snapshot()
    s_run["phase"] = "running"
    s_run["mobile"] = {
        "state": "running", "mode": "quick", "managed": True, "available": True,
        "publicUrl": "https://pocket-demo.trycloudflare.com",
        "localUrl": "http://127.0.0.1:3082/",
        "pin": "87654321",
    }
    w.render_status(s_run)
    check(not w.port.isEnabled() and not w.launch_button.isEnabled(), "running AG locks port and launch")
    check(all(not chip.isEnabled() for _, chip in w._port_chips), "running AG locks port presets with input")
    check(w.mobile_url.text() == "https://pocket-demo.trycloudflare.com"
          and w.mobile_qr.pixmap() is not None and not w.mobile_qr.pixmap().isNull()
          and not w.mobile_qr_frame.isHidden(), "running mobile shows HTTPS publicUrl and QR")
    check(w.open_mobile_button.isEnabled() and w.mobile_stop_button.isEnabled(), "running managed mobile allows open and stop")

    s_ext = demo_snapshot()
    s_ext["mobile"] = {"state": "external", "mode": "quick", "managed": False, "localUrl": "http://127.0.0.1:3082/", "publicUrl": None, "pin": None, "available": True}
    w.render_status(s_ext)
    check(not w.mobile_stop_button.isEnabled() and not w.save_mobile_button.isEnabled(), "external mobile cannot be stopped or configured")
    check(w.mobile_url.text() == "" and w.mobile_qr_frame.isHidden(), "external mobile without publicUrl does not draw 127.0.0.1 QR")

    s_ext_pub = demo_snapshot()
    s_ext_pub["mobile"].update(state="external", pin="12345678", publicUrl="https://demo.trycloudflare.com")
    w.render_status(s_ext_pub)
    check(w.mobile_pin.echoMode() == QLineEdit.EchoMode.Password and not w.reveal_pin.isChecked(), "PIN masked by default")
    w.reveal_pin.setChecked(True)
    check(w.mobile_pin.echoMode() == QLineEdit.EchoMode.Normal and w.reveal_pin.isChecked(), "PIN reveal works on mobile tab")
    w.navigate(3)
    settle()
    check(w.active_card == 3 and not w.reveal_pin.isChecked() and w.mobile_pin.echoMode() == QLineEdit.EchoMode.Password,
          "PIN re-masked when leaving mobile tab")
    w.navigate(2)
    settle()
    w.reveal_pin.setChecked(True)
    w.changeEvent(QEvent(QEvent.Type.WindowDeactivate))
    settle()
    check(not w.reveal_pin.isChecked() and w.mobile_pin.echoMode() == QLineEdit.EchoMode.Password,
          "PIN re-masked on window focus loss")
    w.render_qr("https://demo.example/?pin=12345678")
    check(w.mobile_qr_frame.isHidden(), "QR excludes credential query")
    w.mobile_pin.setText("12345678")
    w.copy_pin()
    check(QApplication.clipboard().text() == "12345678", "copy mobile PIN on action")
    QApplication.clipboard().clear()

    # Logs: all categories together, redaction, text filter, clear/copy.
    w.navigate(3)
    settle()
    w.set_logs([{"at": "2026-11-16T01:00:00Z", "category": "SYSTEM", "message": "pin=12345678 access_token=secret https://x.test/?code=abc&state=z"}])
    check("12345678" not in w.logs.toPlainText() and "secret" not in w.logs.toPlainText() and "code=abc" not in w.logs.toPlainText(), "log redaction")
    w.log_filter.setText("no-such-event")
    check(w.logs.toPlainText() == "", "log filtering")
    w.log_filter.clear()
    old = {"at": "2026-11-16T01:00:00Z", "category": "SYSTEM", "message": "old event"}
    new = {"at": "2026-11-16T01:00:01Z", "category": "PROXY", "message": "new event"}
    w.set_logs([old])
    w.clear_logs()
    w.set_logs([old])
    check(w.logs.toPlainText() == "", "clear survives full-history poll")
    w.set_logs([old, new])
    check("new event" in w.logs.toPlainText() and "old event" not in w.logs.toPlainText(), "clear preserves new logs")
    check(not hasattr(w, "log_category"), "logs have no category selector")
    check("[PROXY]" in w.logs.toPlainText(), "all log categories remain visible")
    w.copy_logs()
    check("new event" in QApplication.clipboard().text() and "[PROXY]  new event" in QApplication.clipboard().text(),
          "copy visible redacted logs preserves plain ASCII spacing")
    QApplication.clipboard().clear()

    # Visual screenshots across both themes & all 4 pages, plus minimum-width overflow check.
    w._cleared_log_keys = set()
    w._cleared_log_at = ""
    w._dirty.clear()
    snap = demo_snapshot()
    snap["mobile"] = {
        "state": "running", "mode": "quick", "managed": True, "available": True,
        "publicUrl": "https://pocket-demo.trycloudflare.com",
        "localUrl": "http://127.0.0.1:3082/",
        "pin": "48291753",
    }
    w.render_status(snap)
    w.set_logs(demo_logs())
    w.connection.setText("演示模式")
    w.notice.hide()

    for theme_name, dark_mode in [("dark", True), ("light", False)]:
        w.set_dark(dark_mode, persist=False)
        for idx, key in enumerate(PAGE_KEYS):
            w.navigate(idx)
            settle()
            check(w.accounts_scroll.horizontalScrollBar().maximum() == 0, f"no horizontal overflow {theme_name}-{key}")
            check(w.grab().save(str(args.output / f"{key}-{theme_name}.png")), f"capture {key}-{theme_name}")

    w.resize(940, 580)
    for idx, key in enumerate(("workbench", "accounts", "mobile")):
        w.navigate(idx)
        settle()
        check(w.accounts_scroll.horizontalScrollBar().maximum() == 0, f"no horizontal overflow at 940x580 {key}")
        check(w.grab().save(str(args.output / f"{key}-940.png")), f"capture 940x580 {key}")

    w._dirty.clear()
    w.hide()
    print(json.dumps({"passed": len(checks), "checks": checks, "screenshots": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
