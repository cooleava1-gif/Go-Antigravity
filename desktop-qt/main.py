"""Standalone native entry. --demo never starts or connects a real backend."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication

from backend_client import BackendClient
from runtime import BackendRuntime
from ui import MainWindow


def demo_snapshot():
    return {
        "port": 7890,
        "preflightProxy": True,
        "enableI18n": True,
        "enableContextMonitor": True,
        "autoApplyKernelPatch": True,
        "phase": "idle",
        "clientRunning": False,
        "cdpSockets": 0,
        "kernel": {
            "platformSupported": True,
            "desired": {"promptTier": "3", "contextMode": "512k"},
            "targets": [{"exists": True, "backupExists": True, "promptTier": "3", "contextMode": "512k"}],
        },
        "proxy": {
            "enabled": True,
            "lastResult": {
                "code": "ok",
                "ok": True,
                "ms": 286,
                "message": "本地代理与 Google 服务连接正常。",
                "egress": {"ip": "203.0.113.8", "countryName": "示例区域", "city": "演示出口"},
            },
        },
        "accounts": {
            "activeId": "demo-a",
            "items": [
                {
                    "id": "demo-a",
                    "name": "日常工作",
                    "email": "work@example.com",
                    "tier": "PRO",
                    "isLive": False,
                    "status": "ok",
                    "lastSwitchedAt": 1794760000000,
                    "quota": {
                        "models": [
                            {"key": "gemini-argon", "shortLabel": "Gemini 4 Argon (周限)", "percentage": 82, "resetText": "5d 4h"},
                            {"key": "claude", "shortLabel": "Claude (5h)", "percentage": 64, "resetText": "2h 18m"},
                            {"key": "gemini", "shortLabel": "Gemini 3.8 (5h)", "percentage": 96, "resetText": "4h 50m"},
                        ]
                    },
                },
                {
                    "id": "demo-b",
                    "name": "个人空间",
                    "email": "personal@example.com",
                    "tier": "FREE",
                    "isLive": False,
                    "status": "ok",
                    "quota": {
                        "models": [
                            {"key": "gemini-argon", "shortLabel": "Gemini 4 Argon (周限)", "percentage": 18, "resetText": "1d 9h"},
                            {"key": "claude", "shortLabel": "Claude (5h)", "percentage": 100, "resetText": "已满"},
                            {"key": "gemini", "shortLabel": "Gemini 3.8 (5h)", "percentage": 92, "resetText": "3h 10m"},
                        ]
                    },
                },
            ],
        },
        "tokenUsage": {
            "conversationCount": 148,
            "today": {"totalTokens": 24800, "inputTokens": 21200, "outputTokens": 3600, "requests": 12},
            "days7": {
                "totalTokens": 1684000,
                "inputTokens": 1410000,
                "outputTokens": 274000,
                "requests": 214,
                "models": [
                    {"name": "Claude Sonnet", "totalTokens": 920000},
                    {"name": "Gemini 4 Argon", "totalTokens": 540000},
                    {"name": "Gemini 3.8 Flash", "totalTokens": 224000},
                ],
            },
            "days30": {"totalTokens": 5200000, "inputTokens": 4320000, "outputTokens": 880000, "requests": 640},
            "all": {"totalTokens": 12400000, "inputTokens": 10100000, "outputTokens": 2300000, "requests": 1227},
        },
        "mobile": {"state": "stopped", "mode": "quick", "managed": False, "autoStart": False, "available": True},
        "oauthFlow": None,
    }


def demo_logs():
    return [
        {"at": "2026-11-16T01:23:00Z", "category": "SYSTEM", "message": "桌面工作区已准备就绪"},
        {"at": "2026-11-16T01:23:04Z", "category": "KERNEL", "message": "检测到本机内核 · 4 档提示词 + 512K 上下文 (.bak 校验通过)"},
        {"at": "2026-11-16T01:23:06Z", "category": "PROXY", "message": "代理连接检测通过 · 203.0.113.8 (示例区域 · 286 ms)"},
        {"at": "2026-11-16T01:23:08Z", "category": "SYSTEM", "message": "界面预览 · 使用演示数据"},
    ]


def main():
    parser = argparse.ArgumentParser(description="Go-Antigravity native desktop")
    parser.add_argument("--demo", action="store_true", help="Preview only, no backend or account access")
    parser.add_argument("--quit-after", type=int, default=0, help="Close demo after milliseconds (QA only)")
    args = parser.parse_args()
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("GoAntigravity.Desktop")
    app = QApplication(sys.argv[:1])
    app.setApplicationName("Go-Antigravity")
    app.setOrganizationName("Go-Antigravity")
    app.setStyle("Fusion")
    app.setQuitOnLastWindowClosed(False)
    window = MainWindow(demo=args.demo)
    if args.demo:
        window.render_status(demo_snapshot())
        window.set_logs(demo_logs())
        window.connection.setText("演示模式")
        window.closing.connect(app.quit)
    else:
        runtime = BackendRuntime(Path(__file__).resolve().parent.parent, app)

        def ready(origin):
            if window._closing:
                return
            client = BackendClient(origin, window)
            window.bind_client(client)

        def closing():
            if window.client:
                window.client.stop()
            runtime.close()

        runtime.ready.connect(ready)

        def failed(message):
            window.set_online(False)
            window.connection.setText("未连接")
            window.inform(message + "；可关闭窗口后重新启动。")

        runtime.failed.connect(failed)
        runtime.closed.connect(lambda: app.quit() if window._closing else None)
        window.closing.connect(closing)
        QTimer.singleShot(0, runtime.start)
    window.show()
    if args.demo and args.quit_after > 0:
        QTimer.singleShot(args.quit_after, window.close)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
