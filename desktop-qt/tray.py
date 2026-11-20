"""系统托盘驻留：关闭窗口默认隐藏，托盘菜单负责恢复与真正退出。

职责边界：
- 只负责托盘图标与菜单；是否隐藏、是否真正退出由 MainWindow.closeEvent 决定；
- 没有可用的系统托盘（无托盘环境 / QSystemTrayIcon.isSystemTrayAvailable() 为假）时
  本模块安全回退：window.tray 为 None，关闭走常规退出，避免窗口被不可恢复地隐藏；
- 隐藏只 hide()，绝不 emit MainWindow.closing——后端、隧道与更新器线程保持运行。
"""
from __future__ import annotations

from pathlib import Path

from PyQt6.QtCore import QObject
from PyQt6.QtGui import QAction, QIcon
from PyQt6.QtWidgets import QMenu, QSystemTrayIcon


class TrayController(QObject):
    """托盘图标控制器：显示主窗口 / 双击恢复 / 退出。"""

    def __init__(self, window, parent=None):
        super().__init__(parent if parent is not None else window)
        self._window = window
        self.tray = QSystemTrayIcon(window)
        self.tray.setIcon(QIcon(str(Path(__file__).parent / "assets/go-antigravity.ico")))
        self.tray.setToolTip("Go-Antigravity")

        menu = QMenu(window)
        show_action = QAction("显示主窗口", menu)
        show_action.triggered.connect(self.show_window)
        quit_action = QAction("退出", menu)
        quit_action.triggered.connect(self.request_exit)
        menu.addAction(show_action)
        menu.addSeparator()
        menu.addAction(quit_action)
        self.tray.setContextMenu(menu)
        # Windows 上 Trigger ≈ 单击/双击激活；DoubleClick 兜底不同平台语义。
        self.tray.activated.connect(self._on_activated)
        self.menu = menu
        self.show_action = show_action
        self.quit_action = quit_action

    def _on_activated(self, reason) -> None:
        if reason in (
            QSystemTrayIcon.ActivationReason.Trigger,
            QSystemTrayIcon.ActivationReason.DoubleClick,
        ):
            self.show_window()

    def show_window(self) -> None:
        window = self._window
        if window is None:
            return
        # showNormal 先退出最小化/最大化态，再前置激活，保证恢复可见可交互。
        window.showNormal()
        window.raise_()
        window.activateWindow()

    def request_exit(self) -> None:
        """托盘退出：走与点关闭按钮一致的显式退出路径（含未保存设置确认）。"""
        window = self._window
        if window is None:
            return
        # 窗口若正隐藏在托盘，先恢复，保证未保存设置确认对话框可见可操作。
        if not window.isVisible():
            self.show_window()
        window.request_exit()

    def hide(self) -> None:
        if self.tray is not None:
            self.tray.hide()

    def show(self) -> None:
        if self.tray is not None:
            self.tray.show()

    def is_visible(self) -> bool:
        return bool(self.tray is not None and self.tray.isVisible())


def create_tray(window):
    """尽力创建托盘；托盘不可用或创建失败时回退到 None（常规关闭，不隐藏）。"""
    try:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return None
        return TrayController(window)
    except (RuntimeError, OSError, ValueError):
        # 仅捕获平台/资源类预期错误；编程错误继续抛出，不静默降级。
        return None
