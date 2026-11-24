"""桌面自更新界面与生命周期接线。

`updater`（纯 stdlib）负责 GitHub 版本查询、下载、SHA 校验、安全解压与暂存目录；
本模块只把它接进 Qt：概览页顶部一条紧凑版本小条、每次启动至多一次的后台检查、可手动重试的
检查、可取消的后台下载，以及下载完成后的「重启更新」交接。

关键约定：
- 主线程绝不阻塞：check_for_update 与 prepare_update 都是阻塞调用，分别跑在 QThread 里，
  进度/结果/失败都通过信号回到主线程；
- 取消通过 threading.Event；关闭或取消时对线程做有界等待，运行中的 QThread 绝不销毁；
- 「重启更新」复用窗口既有关闭路径（含未保存设置确认），只有关闭真正继续时才调用
  launch_installer，随后按既有 runtime 关闭顺序退出；安装器启动失败则不退出、不隐藏窗口；
- demo 模式不联网、不调用 updater，所有按钮只给预览提示；
- 源码目录等不支持自动更新的安装方式：允许检查与打开发布页，但拒绝下载安装，并说明原因。
"""

from __future__ import annotations

import atexit
import threading
from pathlib import Path

from PyQt6.QtCore import QObject, QThread, QUrl, pyqtSignal
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QProgressBar

from theme import DARK, LIGHT
from widgets import ElidedLabel, GlassCard, svg_icon

# updater.py 与本界面同包发布：缺失意味着安装包损坏，直接让启动失败，不静默降级。
import updater as _updater

#: 核心的用户可见异常：str(e) 就是给用户看的中文短句
UpdateError = _updater.UpdateError


#: 启动后延迟多久做第一次后台检查（给前端与运行时留出启动资源）
STARTUP_CHECK_DELAY_MS = 1500
#: 关闭时等待下载线程退出的上限（单次，事件驱动取消，不重复阻塞 GUI）
CANCEL_WAIT_MS = 8000
#: 进程退出时等待在途核心调用的上限。核心自身超时为：检查 20s、下载读取 60s、
#: 安装帮助进程 20s；取最大在途时长并留余量，保证运行中的 QThread 永不在退出时被销毁。
EXIT_JOIN_MS = 65000
#: demo 预览里展示的版本号（不读取真实构建信息，也不联网）
DEMO_VERSION = "1.1.1"

#: 每个在生命周期内的工作线程：强引用保证运行中的 QThread 永不被父对象销毁。
#: worker 一律没有 QObject 父对象，清理只走 finished 与进程退出时的 atexit。
_WORKERS: set = set()


def _join_late_workers() -> None:
    """进程退出前有界等待仍在运行的工作线程。

    真实核心调用本身有超时（检查 20s、下载取消轮询 256KB），这里给足上限，
    确保运行中的 QThread 对象永远不会在销毁时触发 Qt abort。
    """
    for worker in list(_WORKERS):
        if worker.isRunning():
            worker.wait(EXIT_JOIN_MS)


atexit.register(_join_late_workers)


def build_identity(build: dict, demo: bool = False) -> str:
    """构建身份小字：当前版本 / commit / 正式包或开发版。"""
    if demo:
        return f"当前版本 v{DEMO_VERSION} · 界面预览"
    version = str(build.get("version") or "").strip().lstrip("vV")
    commit = str(build.get("commit") or "").strip()
    if commit.lower() in ("unknown", "none", "n/a", "-"):
        commit = ""  # 核心取不到 commit 时给占位符，不当成真实提交号展示
    if not version and not commit:
        return "当前版本 不可用"
    head = f"v{version}" if version else "版本未知"
    commit_text = f" · {commit[:7]}" if commit else ""
    kind = "正式包" if build.get("packaged") else "开发版"
    return f"当前版本 {head}{commit_text} · {kind}"


def format_size(size) -> str:
    try:
        number = float(size or 0)
    except (TypeError, ValueError):
        return ""
    if number <= 0:
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if number < 1024 or unit == "GB":
            return f"{number:.0f} {unit}" if unit == "B" else f"{number:.1f} {unit}"
        number /= 1024
    return ""


def progress_text(received: int, total: int) -> str:
    got, want = format_size(received), format_size(total)
    if total and total > 0:
        percent = min(100, round((received or 0) * 100 / total))
        detail = f"（{got} / {want}）" if got and want else ""
        return f"正在下载新版本 {percent}%{detail}"
    return f"正在下载新版本…{f'已接收 {got}' if got else ''}"


class _CheckWorker(QThread):
    """后台执行阻塞的 check_for_update；成功与失败都通过信号回到主线程。"""

    done = pyqtSignal(object)
    failed = pyqtSignal(str)

    def __init__(self, root: Path):
        super().__init__()
        self._root = Path(root)

    def run(self) -> None:
        try:
            info = _updater.check_for_update(self._root)
        except Exception as exc:  # UpdateError 的中文短句可直接展示
            self.failed.emit(str(exc) or "检查更新失败，请稍后重试。")
            return
        if not isinstance(info, dict):
            self.failed.emit("检查更新返回了无法识别的结果。")
            return
        self.done.emit(info)


class _DownloadWorker(QThread):
    """后台执行阻塞的 prepare_update，带进度回调与取消事件。"""

    progress = pyqtSignal(int, int)
    ready = pyqtSignal(object)
    failed = pyqtSignal(str)

    def __init__(self, root: Path, release: dict):
        super().__init__()
        self._root = Path(root)
        self._release = dict(release)
        self._cancel = threading.Event()

    def request_cancel(self) -> None:
        self._cancel.set()

    def _on_progress(self, received, total) -> None:
        if self._cancel.is_set():
            return
        try:
            self.progress.emit(int(received or 0), int(total or 0))
        except (TypeError, ValueError):
            return

    def run(self) -> None:
        try:
            prepared = _updater.prepare_update(self._root, self._release, progress=self._on_progress, cancel=self._cancel)
        except Exception as exc:
            cancelled = self._cancel.is_set()
            self.failed.emit("下载已取消。" if cancelled else (str(exc) or "下载更新失败，请稍后重试。"))
            return
        if self._cancel.is_set() or not isinstance(prepared, dict):
            # prepare 刚成功就被取消：同样要清掉暂存目录，不能泄漏 staged/temp。
            if isinstance(prepared, dict):
                self._discard(prepared)
            self.failed.emit("下载已取消。" if self._cancel.is_set() else "更新包准备失败，请稍后重试。")
            return
        self.ready.emit(prepared)

    def _discard(self, prepared: dict) -> None:
        try:
            if hasattr(_updater, "cleanup_prepared"):
                _updater.cleanup_prepared(prepared)
        except Exception:
            pass


class UpdateController(QObject):
    """更新状态机：构建身份、后台/手动检查、下载线程生命周期、重启安装交接。

    只依赖 updater 的公共接口，不做任何网络或文件操作；UI 侧只连信号。
    """

    build_ready = pyqtSignal(dict)
    status = pyqtSignal(str)
    checked = pyqtSignal()
    prompt = pyqtSignal(str)
    failure = pyqtSignal(str)
    update_found = pyqtSignal(dict)
    download_progress = pyqtSignal(int, int)
    download_ready = pyqtSignal(dict)
    download_cancelling = pyqtSignal()

    def __init__(self, root, *, demo: bool = False, parent=None):
        super().__init__(parent)
        self.root = Path(root)
        self.demo = bool(demo)
        self._build: dict = {}
        self._release: dict | None = None
        self._prepared: dict | None = None
        self._installing = False
        self._checking = False
        self._downloading = False
        self._worker: QThread | None = None
        self._startup_checked = False
        self.refresh_build()

    # ------------------------------------------------------------------ 构建身份
    @property
    def build(self) -> dict:
        return self._build

    @property
    def install_supported(self) -> bool:
        return bool(self._build.get("install_supported"))

    @property
    def release_url(self) -> str:
        return str((self._release or {}).get("release_url") or "")

    def unsupported_reason(self) -> str:
        # 核心在 read_build 里给 install_reason；同时兼容旧的 reason 字段。
        return str(self._build.get("install_reason") or self._build.get("reason") or "").strip()

    def refresh_build(self) -> dict:
        """重新读取构建身份；demo 模式不调用 updater。"""
        build: dict = {}
        if not self.demo:
            try:
                loaded = _updater.read_build(self.root)
                if isinstance(loaded, dict):
                    build = dict(loaded)
            except Exception:
                build = {}
        if self.demo:
            build = {"version": DEMO_VERSION, "commit": "", "packaged": False,
                     "install_supported": False, "install_reason": "", "reason": "",
                     "demo": True}
        self._build = build
        self.build_ready.emit(self._build)
        return self._build

    # ------------------------------------------------------------------ 检查
    def startup_check(self) -> None:
        """每次启动至多一次的后台检查；失败静默，只在小条上留状态。"""
        if self.demo or self._startup_checked or self._checking or self._downloading:
            return
        self._startup_checked = True
        self._check(quiet=True)

    def check_now(self) -> None:
        """用户手动检查：失败要明确报错。"""
        if self.demo or self._checking or self._downloading:
            return
        self._check(quiet=False)

    def _check(self, quiet: bool) -> None:
        self._checking = True
        self.status.emit("正在检查更新…")
        worker = _CheckWorker(self.root)
        _WORKERS.add(worker)
        worker.finished.connect(self._retire_current)
        worker.done.connect(lambda info: self._on_checked(info, quiet))
        worker.failed.connect(lambda message: self._on_check_failed(message, quiet))
        self._worker = worker
        worker.start()

    def _on_checked(self, info: dict, quiet: bool) -> None:
        self._checking = False
        current = info.get("current")
        if isinstance(current, dict) and current:
            self._build = {**self._build, **current}
            self.build_ready.emit(self._build)
        if info.get("available"):
            self._release = info
            latest = str(info.get("latest") or "").strip().lstrip("vV")
            self.status.emit(f"发现新版本 v{latest}" if latest else "发现新版本")
            self.update_found.emit(info)
            if quiet:
                self.prompt.emit("发现新版本，可在概览页版本栏下载并更新。")
            self.checked.emit()
            return
        # 没有可用更新：清掉上一轮缓存的发布信息，避免“发现过又撤回”时还能下载旧包。
        self._release = None
        reason = str(info.get("reason") or "")
        latest = str(info.get("latest") or "").strip().lstrip("vV")
        local = str(self._build.get("version") or "").strip().lstrip("vV")
        if reason == "up-to-date":
            # 本地版本可能高于发布页（自测 1.1.0 vs 发布 1.0.0），只报本地版本。
            self.status.emit(f"已是最新版本 v{local}" if local else "已是最新版本")
        elif reason == "prerelease":
            self.status.emit(f"最新版 v{latest} 是预发布，暂不提供更新" if latest else "暂无可用更新")
        else:
            self.status.emit("当前没有可用的更新。")
        self.checked.emit()

    def _on_check_failed(self, message: str, quiet: bool) -> None:
        self._checking = False
        self.status.emit("检查更新未完成，可手动重试" if quiet else message)
        if not quiet:
            self.failure.emit(message)
        self.checked.emit()

    # ------------------------------------------------------------------ 下载
    def start_download(self) -> None:
        if self.demo or self._downloading or not self._release:
            return
        if not self.install_supported:
            reason = self.unsupported_reason() or "当前安装方式不支持自动更新。"
            self.status.emit(reason)
            self.failure.emit(f"无法自动更新：{reason}")
            return
        self._downloading = True
        worker = _DownloadWorker(self.root, self._release)
        _WORKERS.add(worker)
        worker.finished.connect(self._retire_current)
        worker.progress.connect(self.download_progress)
        worker.ready.connect(self._on_download_ready)
        worker.failed.connect(self._on_download_failed)
        self._worker = worker
        worker.start()
        self.status.emit("正在准备下载…")

    def cancel_download(self) -> None:
        """请求取消：只置取消事件，绝不阻塞 GUI；真正退出由 failed 信号事件驱动。"""
        worker = self._worker
        if not isinstance(worker, _DownloadWorker) or not worker.isRunning():
            return
        worker.request_cancel()
        self.status.emit("正在取消下载…")
        self.download_cancelling.emit()

    def _on_download_ready(self, prepared: dict) -> None:
        self._downloading = False
        self._prepared = dict(prepared)
        self.status.emit("新版本已下载完成，重启后安装")
        self.download_ready.emit(self._prepared)

    def _on_download_failed(self, message: str) -> None:
        self._downloading = False
        self._prepared = None
        self.status.emit(message)
        self.failure.emit(message)

    # ------------------------------------------------------------------ 重启安装
    def request_restart(self) -> None:
        """用户确认重启更新：走窗口既有关闭路径，只有关闭继续时才启动安装器。"""
        if self.demo or self._prepared is None:
            return
        prepared, root = self._prepared, self.root

        def handoff() -> bool:
            try:
                _updater.launch_installer(root, prepared)
            except Exception as exc:
                message = f"启动安装程序失败：{exc}"
                self.status.emit(message)
                self.failure.emit(message)
                return False
            self._installing = True
            self.status.emit("安装程序已启动，正在关闭工作台…")
            return True

        window = self.parent()
        if window is None or not hasattr(window, "begin_update_close"):
            return
        window.begin_update_close(handoff)

    def discard_prepared(self) -> None:
        """未选择重启更新就关闭：清掉已下载的暂存目录（保留 backup 与 root）。"""
        prepared, self._prepared = self._prepared, None
        if prepared is None or not hasattr(_updater, "cleanup_prepared"):
            return
        try:
            _updater.cleanup_prepared(prepared)
        except Exception:
            pass

    # ------------------------------------------------------------------ 生命周期
    def on_window_closing(self) -> None:
        self.shutdown()
        if self._prepared is not None and not self._installing:
            self.discard_prepared()

    def shutdown(self) -> None:
        """窗口关闭时调用：取消在途工作，然后只做一次有界等待。"""
        worker = self._worker
        if worker is None:
            return
        if isinstance(worker, _DownloadWorker) and worker.isRunning():
            worker.request_cancel()
        if worker.isRunning():
            # 单次有界等待；超时后由 _WORKERS 持有引用，进程退出时 atexit 再等。
            worker.wait(CANCEL_WAIT_MS)

    def _retire_current(self) -> None:
        """worker finished 后释放引用（无 QObject 父对象，只能这样清理）。"""
        worker = self._worker
        if worker is None:
            return
        self._worker = None
        if worker.isRunning():
            return
        _WORKERS.discard(worker)


class VersionStrip(GlassCard):
    """概览页顶部版本小条：构建身份 + 更新状态 + 更新操作。

    紧凑单行，随概览页滚动宽度自适应；所有文字标签都是 ElidedLabel，940px 最小宽度不溢出，
    也不挤占主导航。
    """

    def __init__(self, window, controller: UpdateController, parent=None):
        super().__init__(variant="subtle", radius=14, parent=parent)
        self._window = window
        self._controller = controller
        self._mode = "idle"
        lay = QHBoxLayout(self)
        lay.setContentsMargins(14, 7, 12, 7)
        lay.setSpacing(8)

        self.icon_label = QLabel()
        self.icon_label.setFixedSize(18, 18)
        lay.addWidget(self.icon_label)

        self.identity_label = ElidedLabel(build_identity(controller.build, controller.demo))
        self.identity_label.setObjectName("Sub")
        lay.addWidget(self.identity_label)

        self.status_label = ElidedLabel("尚未检查更新")
        self.status_label.setObjectName("Muted")
        lay.addWidget(self.status_label, 1)

        self.progress = QProgressBar()
        self.progress.setFixedSize(120, 8)
        self.progress.setTextVisible(False)
        self.progress.setRange(0, 100)
        self.progress.hide()
        lay.addWidget(self.progress)

        self.check_button = window.button("检查更新", self._on_check, "Quiet", "refresh", 13)
        self.action_button = window.button("下载并更新", self._on_action, "AccentSoft")
        self.release_button = window.button("发布页", self._on_release, "Quiet", "external", 13)
        for button in (self.check_button, self.action_button, self.release_button):
            lay.addWidget(button)
        self.action_button.hide()
        self.release_button.hide()

        controller.build_ready.connect(self._on_build)
        controller.status.connect(self.status_label.setText)
        controller.prompt.connect(window.inform)
        controller.failure.connect(self._on_failure)
        controller.update_found.connect(self._on_update_found)
        controller.checked.connect(self._on_checked_done)
        controller.download_progress.connect(self._on_progress)
        controller.download_ready.connect(self._on_ready)
        controller.download_cancelling.connect(lambda: self._state("cancelling"))
        window.closing.connect(controller.on_window_closing)
        self._state("idle")

    # ------------------------------------------------------------------ 状态
    def _on_build(self, build: dict) -> None:
        self.identity_label.setText(build_identity(build, self._controller.demo))
        self._state(self._mode)

    def _on_update_found(self, info: dict) -> None:
        size = format_size((info.get("asset") or {}).get("size"))
        self.status_label.setToolTip((info.get("notes") or "").strip())
        if size:
            self.action_button.setToolTip(f"下载 {size} 后重启安装")
        if not getattr(self._controller, "install_supported", True):
            reason = self._controller.unsupported_reason() or "当前安装方式不支持自动更新。"
            self.status_label.setText(f"发现新版本，但{reason}")
            self.status_label.setToolTip(reason)
        self._state("available")

    def _on_checked_done(self) -> None:
        self._state("available" if self._controller.release_url else "idle")

    def _on_progress(self, received: int, total: int) -> None:
        self.progress.setValue(min(100, round((received or 0) * 100 / total)) if total else 0)
        self.status_label.setText(progress_text(received, total))

    def _on_ready(self, prepared: dict) -> None:
        self.progress.setValue(100)
        self._state("ready")

    def _on_failure(self, message: str) -> None:
        self._window.inform(message)
        # 下载/检查失败回到可重试状态；安装器启动失败保持“重启更新”可再次点击。
        if self._mode in ("downloading", "cancelling", "checking"):
            self._state("available" if self._controller.release_url else "idle")

    def _state(self, mode: str) -> None:
        self._mode = mode
        checking = mode == "checking"
        downloading = mode in ("downloading", "cancelling")
        ready = mode == "ready"
        available = mode == "available"
        self.check_button.setVisible(not downloading)
        self.check_button.setText("检查中…" if checking else "检查更新")
        self.check_button.setEnabled(not checking and not downloading and not ready)
        self.progress.setVisible(downloading)
        self.action_button.setVisible(available or downloading or ready)
        if downloading:
            self.action_button.setText("取消中…" if mode == "cancelling" else "取消")
            self.action_button.setEnabled(mode == "downloading")
            self.action_button.setObjectName("Quiet")
        elif ready:
            self.action_button.setText("重启更新")
            self.action_button.setEnabled(True)
            self.action_button.setToolTip("重启后自动替换安装目录，账户数据保留。")
            self.action_button.setObjectName("Primary")
        else:
            self.action_button.setText("下载并更新")
            supported = bool(getattr(self._controller, "install_supported", True))
            self.action_button.setEnabled(available and supported)
            self.action_button.setToolTip(
                "" if (supported or not available) else
                (self._controller.unsupported_reason() or "当前安装方式不支持自动更新。")
            )
            self.action_button.setObjectName("AccentSoft")
        self.action_button.style().unpolish(self.action_button)
        self.action_button.style().polish(self.action_button)
        self.release_button.setVisible(bool(self._controller.release_url) and not downloading)
        self.release_button.setToolTip(self._controller.release_url)

    def update_enabled(self) -> None:
        """随窗口统一启停；关闭时全部禁用，否则按当前状态恢复。"""
        window, colors = self._window, (DARK if self._window.dark else LIGHT)
        self.icon_label.setPixmap(svg_icon("refresh", colors["accent"], 16).pixmap(18, 18))
        self.progress.setStyleSheet(
            "QProgressBar { background: %s; border: none; border-radius: 4px; }"
            "QProgressBar::chunk { background: %s; border-radius: 4px; }" % (colors["input"], colors["accent"])
        )
        if getattr(window, "_closing", False):
            for button in (self.check_button, self.action_button, self.release_button):
                button.setEnabled(False)
            return
        self._state(self._mode)

    # ------------------------------------------------------------------ 交互
    def _on_check(self, checked: bool = False) -> None:
        if self._controller.demo:
            self._window.preview_only("预览模式：不会检查或下载更新。")
            return
        if self._mode in ("downloading", "cancelling"):
            return
        self._state("checking")
        self._controller.check_now()
        if not self._controller._checking:
            self._state("idle")

    def _on_action(self, checked: bool = False) -> None:
        controller = self._controller
        if controller.demo:
            self._window.preview_only("预览模式：不会检查或下载更新。")
            return
        if self._mode == "ready":
            if not self._window.confirm("重启更新", "将关闭 Go-Antigravity 并安装已下载的新版本。账户与设置会保留，旧版本目录会备份。是否现在重启更新？"):
                return
            controller.request_restart()
        elif self._mode == "available":
            self._state("downloading")
            controller.start_download()
            if not controller._downloading:
                self._state("idle")
        elif self._mode == "downloading":
            controller.cancel_download()

    def _on_release(self, checked: bool = False) -> None:
        if self._controller.demo:
            self._window.preview_only("预览模式：不会打开发布页。")
            return
        url = self._controller.release_url or f"https://github.com/{getattr(_updater, 'REPOSITORY', '') or 'cooleava1-gif/Go-Antigravity'}/releases"
        if url:
            QDesktopServices.openUrl(QUrl(url))
