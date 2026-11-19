"""Go-Antigravity native desktop workspace (Orderly Horizontal Liquid Glass v2)."""
from __future__ import annotations

import html
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

import qrcode
from PyQt6.QtCore import (
    QEasingCurve, QEvent, QPropertyAnimation, QSettings, QSize, Qt, QUrl, pyqtSignal,
)
from PyQt6.QtGui import QDesktopServices, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PyQt6.QtWidgets import (
    QApplication, QButtonGroup, QCheckBox, QComboBox, QFrame,
    QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox,
    QPushButton, QScrollArea, QSpinBox, QStackedWidget, QTextEdit, QVBoxLayout,
    QWidget, QGraphicsOpacityEffect,
)

from account_tools import AccountTools
from theme import ACCENT_TRANSITION_MS, DARK, LIGHT, apply_window_glass, stylesheet
from widgets import (
    AccountCardWidget, ElidedLabel, GlassCanvas, GlassCard, ModelDistributionBar,
    SegmentedControl, ToggleSwitch, svg_icon,
)


def label(text: str = "", role: str = "", wrap: bool = False) -> QLabel:
    w = QLabel(text)
    w.setTextFormat(Qt.TextFormat.PlainText)
    w.setObjectName(role)
    w.setWordWrap(wrap)
    return w


def hrow(*items, stretch: bool = False, spacing: int = 8) -> QHBoxLayout:
    l = QHBoxLayout()
    l.setSpacing(spacing)
    for w in items:
        if isinstance(w, (QHBoxLayout, QVBoxLayout, QGridLayout)):
            l.addLayout(w)
        else:
            l.addWidget(w)
    if stretch:
        l.addStretch()
    return l


def divider() -> QFrame:
    d = QFrame()
    d.setObjectName("Divider")
    return d


def short_number(value) -> str:
    try:
        n = max(0.0, float(value or 0))
    except (ValueError, TypeError):
        return "—"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1000:
        return f"{n / 1000:.1f}K"
    return f"{n:.0f}"


def masked_log(text: str) -> str:
    text = re.sub(r"(?i)https?://[^\s]*[?&](?:code|token|pin|state)=[^\s]*", "[敏感链接已隐藏]", text)
    text = re.sub(r"(?i)((?:refresh[_-]?token|access[_-]?token|tunnel[_-]?token|authorization|pin)\s*[=:：]\s*)[^\s,;]+", r"\1[已隐藏]", text)
    text = re.sub(r"(?<!\d)\d{8}(?!\d)", "[PIN已隐藏]", text)
    return re.sub(r"(?<!\w)[0-9a-f]{32,}(?!\w)", "[令牌已隐藏]", text, flags=re.I)


class NoHorizontalScrollArea(QScrollArea):
    """Vertical-only transparent scroll container ensuring zero horizontal overflow."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setAutoFillBackground(False)
        self.viewport().setAutoFillBackground(False)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self.horizontalScrollBar().setRange(0, 0)


class MainWindow(QMainWindow):
    closing = pyqtSignal()
    PAGES = [
        ("workbench", "概览", "workbench"),
        ("accounts", "账户", "accounts"),
        ("mobile", "远程", "mobile"),
        ("logs", "日志", "logs"),
    ]

    TIER_HINTS = {
        "stock": "保留官方提示词，适合对照使用或恢复默认。",
        "1": "旧 1 档：仅保留兼容识别。请主动选择新版，或恢复官方原版。",
        "2": "旧 2 档：仅保留兼容识别。请主动选择新版，或恢复官方原版。",
        "3": "精简·防编造：保留辅助模板，用更短的核心规则约束证据、工具调用与结果核验。",
        "4": "旧 4 档：仅保留兼容识别。请主动选择新版，或恢复官方原版。",
    }
    # Only two tiers stay selectable. Tier "custom" still exists in the backend vocabulary for
    # recognising kernels patched by an older build, but it is never offered here.
    VISIBLE_TIERS = ("stock", "3")

    CTX_HINTS = {
        "stock": "沿用当前客户端的默认上限；所有受支持模型实际上都支持 1M 上下文。",
        "512k": "本机客户端上限设为 512,000 Token；所有受支持模型实际上都支持 1M 上下文。",
        "900k": "本机客户端上限设为 983,040 Token（约 960K）；所有受支持模型实际上都支持 1M 上下文。",
    }

    def __init__(self, demo: bool = False):
        super().__init__()
        self.demo, self.client = demo, None
        self.snapshot: dict = {}
        self._online, self._closing = demo, False
        self._dirty: set[str] = set()
        self._pending: dict[str, tuple] = {}
        self._account_items: list[dict] = []
        self._log_items: list[dict] = []
        self._accounts_key = ""
        self._selected_account_id: str | None = None
        self._account_cards: list[AccountCardWidget] = []
        self._glass_cards: list[GlassCard] = []
        self._switches: list[ToggleSwitch] = []
        self._port_chips: list[tuple[int, QPushButton]] = []
        self._icons: list[tuple[QPushButton, str]] = []
        self._animations: list[QPropertyAnimation] = []
        self._page_effects: list[QGraphicsOpacityEffect] = []
        self._qr_url = ""
        self._clear_tunnel_token = False

        self.settings = QSettings("Go-Antigravity", "Desktop")
        self.dark = True if demo else self.settings.value("dark", True, type=bool)
        self.active_card = 0

        self.setWindowTitle("Go-Antigravity")
        self.setWindowIcon(QIcon(str(Path(__file__).parent / "assets/go-antigravity.ico")))
        self.setMinimumSize(940, 580)
        self.resize(1120, 640)

        self._build()
        # Building the widgets selects their default segments, which marks "kernel" dirty through the
        # ordinary change handlers. Nothing the user did has happened yet, so the marks are cleared —
        # otherwise the first render_status() would skip syncing the controls to the saved backend state.
        self._dirty.clear()
        self.set_dark(self.dark, persist=False)

        QShortcut(QKeySequence("Ctrl+R"), self, activated=self.refresh)
        QShortcut(QKeySequence("Ctrl+1"), self, activated=lambda: self.navigate(0))
        QShortcut(QKeySequence("Ctrl+2"), self, activated=lambda: self.navigate(1))
        QShortcut(QKeySequence("Ctrl+3"), self, activated=lambda: self.navigate(2))
        QShortcut(QKeySequence("Ctrl+4"), self, activated=lambda: self.navigate(3))
        QShortcut(QKeySequence("Ctrl+5"), self, activated=lambda: self.navigate(4))
        QShortcut(QKeySequence("Ctrl+6"), self, activated=lambda: self.navigate(5))
        self._update_enabled()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        apply_window_glass(self, self.dark)

    def _register_glass(self, card: GlassCard) -> GlassCard:
        card.set_dark(self.dark)
        self._glass_cards.append(card)
        return card

    def button(self, text: str, action, role: str = "", symbol: str = "", size: int = 15) -> QPushButton:
        w = QPushButton(text)
        if role:
            w.setObjectName(role)
        w.setCursor(Qt.CursorShape.PointingHandCursor)
        w.clicked.connect(action)
        if symbol:
            self._icons.append((w, symbol))
            w.setIconSize(QSize(size, size))
        return w

    def switch(self, text: str, scope: str) -> ToggleSwitch:
        w = ToggleSwitch(text)
        w.set_dark(self.dark)
        w.toggled.connect(lambda: self._dirty.add(scope))
        self._switches.append(w)
        return w

    def _build(self) -> None:
        self.canvas = GlassCanvas(self)
        self.setCentralWidget(self.canvas)

        shell = QVBoxLayout(self.canvas)
        shell.setContentsMargins(0, 0, 0, 0)
        shell.setSpacing(0)

        # Clean 3-Group Top Bar (58px)
        topbar = self._register_glass(GlassCard(variant="topbar", radius=0))
        topbar.setFixedHeight(58)
        tl = QHBoxLayout(topbar)
        tl.setContentsMargins(18, 8, 18, 8)
        tl.setSpacing(12)

        # Left: Brand + Compact Connection Subtitle
        brand_box = QHBoxLayout()
        brand_box.setSpacing(9)
        self.brand_icon = QLabel()
        self.brand_icon.setFixedSize(24, 24)
        self.brand_icon.setPixmap(QIcon(str(Path(__file__).parent / "assets/go-antigravity.svg")).pixmap(24, 24))
        brand_box.addWidget(self.brand_icon)

        brand_meta = QVBoxLayout()
        brand_meta.setSpacing(1)
        title_row = QHBoxLayout()
        title_row.setSpacing(6)
        title_row.addWidget(label("Go-Antigravity", "Brand"))
        self.connection = label("连接中", "Small")
        title_row.addWidget(self.connection)
        brand_meta.addLayout(title_row)
        self.runtime_detail = label("已就绪 · :7890", "Small")
        brand_meta.addWidget(self.runtime_detail)
        brand_box.addLayout(brand_meta)
        tl.addLayout(brand_box)
        tl.addStretch(1)

        # Center: 4 Short 2-Word Liquid Glass Nav Pills
        nav_track = self._register_glass(GlassCard(variant="track", radius=18))
        nl = QHBoxLayout(nav_track)
        nl.setContentsMargins(4, 4, 4, 4)
        nl.setSpacing(3)
        self.nav_buttons: list[QPushButton] = []
        self.nav_group = QButtonGroup(self)
        self.nav_group.setExclusive(True)
        for idx, (_key, title, sym) in enumerate(self.PAGES):
            btn = self.button(title, lambda checked=False, n=idx: self.navigate(n), "NavPill", sym, 14)
            btn.setCheckable(True)
            btn.setMinimumWidth(78)
            btn.setToolTip(f"{title} (Ctrl+{idx + 1})")
            self.nav_group.addButton(btn, idx)
            self.nav_buttons.append(btn)
            nl.addWidget(btn)
        tl.addWidget(nav_track)
        tl.addStretch(1)

        # Right: Only 3 Essential Controls (Theme + Check + Launch)
        right_box = QHBoxLayout()
        right_box.setSpacing(8)
        self.theme_button = self.button("", self.toggle_theme, "IconPill", "sun", 15)
        self.theme_button.setFixedSize(32, 32)
        self.theme_button.setToolTip("切换深色 / 浅色外观")
        self.theme_button.setAccessibleName("切换主题")
        right_box.addWidget(self.theme_button)

        self.proxy_button = self.button("检测连接", self.check_proxy, "", "pulse", 14)
        self.proxy_button.setAccessibleName("检测连接")
        right_box.addWidget(self.proxy_button)

        self.launch_button = self.button("启动 Antigravity", self.launch, "Primary", "play", 13)
        self.launch_button.setMinimumWidth(134)
        self.overview_launch = self.launch_button
        right_box.addWidget(self.launch_button)

        tl.addLayout(right_box)
        shell.addWidget(topbar)

        # Main Body
        body = QWidget()
        body.setObjectName("PagesHost")
        bl = QVBoxLayout(body)
        bl.setContentsMargins(18, 14, 18, 14)
        bl.setSpacing(10)

        self.stack = QStackedWidget()
        self.stack.setObjectName("PagesHost")
        self.pages: list[QWidget] = []

        for builder in (
            self._build_workbench_page,
            self._build_accounts_page,
            self._build_mobile_page,
            self._build_logs_page,
        ):
            page = QWidget()
            page.setObjectName("ViewRoot")
            pl = QVBoxLayout(page)
            pl.setContentsMargins(0, 0, 0, 0)
            pl.setSpacing(10)
            builder(pl)
            eff = QGraphicsOpacityEffect(page)
            eff.setOpacity(1.0)
            page.setGraphicsEffect(eff)
            self._page_effects.append(eff)
            self.pages.append(page)
            self.stack.addWidget(page)

        bl.addWidget(self.stack, 1)

        self.notice = label("", "Notice", True)
        self.notice.hide()
        bl.addWidget(self.notice)

        shell.addWidget(body, 1)
        self.navigate(0, animate=False)

    # ------------------------------------------------------------------ Page 0: Overview (6:6 Symmetrical)
    def _build_workbench_page(self, layout: QVBoxLayout) -> None:
        columns = QHBoxLayout()
        columns.setSpacing(14)

        # Left Card (6): Proxy & Connection
        net_card = self._register_glass(GlassCard(radius=18))
        nl = QVBoxLayout(net_card)
        nl.setContentsMargins(18, 16, 18, 14)
        nl.setSpacing(12)

        net_head = QHBoxLayout()
        net_head.setSpacing(8)
        self._net_icon_lbl = QLabel()
        self._net_icon_lbl.setFixedSize(22, 22)
        net_head.addWidget(self._net_icon_lbl)
        nh_txt = QVBoxLayout()
        nh_txt.setSpacing(2)
        nh_txt.addWidget(label("代理与连接", "Section"))
        nh_txt.addWidget(label("为 Antigravity 设置代理，并检查连接是否可用", "Small", True))
        net_head.addLayout(nh_txt, 1)
        self.network_dirty_badge = label("未保存", "PillAmber")
        self.network_dirty_badge.hide()
        net_head.addWidget(self.network_dirty_badge)
        self.hero_badge = label("尚未检测", "PillInfo")
        net_head.addWidget(self.hero_badge)
        nl.addLayout(net_head)

        nl.addWidget(divider())

        # Row 1: Port + Presets
        port_row = QHBoxLayout()
        port_row.setSpacing(10)
        p_txt = QVBoxLayout()
        p_txt.setSpacing(1)
        p_txt.addWidget(label("本地代理端口", "Sub"))
        p_txt.addWidget(label("HTTP / Mixed 入站端口", "Small"))
        port_row.addLayout(p_txt, 1)

        self.port = QSpinBox()
        self.port.setRange(1, 65535)
        self.port.setValue(7890)
        self.port.setFixedWidth(84)
        self.port.setAccessibleName("代理端口")
        self.port.valueChanged.connect(self._on_port_changed)
        self.save_network_button = self.button("保存", self.save_network, "AccentSoft")
        port_row.addLayout(hrow(label("127.0.0.1:", "MonoMuted"), self.port, self.save_network_button, spacing=6))
        nl.addLayout(port_row)

        presets_row = QHBoxLayout()
        presets_row.setSpacing(6)
        presets_row.addStretch(1)
        presets_row.addWidget(label("常用预设", "Small"))
        for port_num, tip in [(7890, "Clash / Mihomo 默认端口 7890"), (7897, "Clash Verge 默认端口 7897"), (10808, "v2rayN 默认端口 10808")]:
            chip = self.button(str(port_num), lambda checked=False, p=port_num: self._apply_port_preset(p), "Chip")
            chip.setToolTip(tip)
            chip.setProperty("active", "true" if port_num == 7890 else "false")
            self._port_chips.append((port_num, chip))
            presets_row.addWidget(chip)
        nl.addLayout(presets_row)

        nl.addWidget(divider())

        # Row 2: Preflight Switch
        pf_row = QHBoxLayout()
        pf_row.setSpacing(12)
        pf_txt = QVBoxLayout()
        pf_txt.setSpacing(1)
        pf_txt.addWidget(label("启动前自动检测出口", "Sub"))
        pf_txt.addWidget(label("连接异常时暂停启动，并显示原因", "Small", True))
        pf_row.addLayout(pf_txt, 1)
        self.preflight = self.switch("", "network")
        self.preflight.setAccessibleName("启动前自动检测代理出口")
        pf_row.addWidget(self.preflight)
        nl.addLayout(pf_row)

        nl.addWidget(divider())

        # Clean Flat Diagnostic Area (No Nested Box)
        diag_head = QHBoxLayout()
        diag_head.addWidget(label("最近检测出口", "Sub"))
        diag_head.addStretch(1)
        self.proxy_egress = label("—", "MonoMuted")
        diag_head.addWidget(self.proxy_egress)
        nl.addLayout(diag_head)

        self.proxy_state = label("尚未检测", "Small")
        self.proxy_detail = label("点击右上角「检测连接」，检查代理端口和 Google 服务响应。", "Muted", True)
        nl.addWidget(self.proxy_state)
        nl.addWidget(self.proxy_detail)
        nl.addStretch(1)

        nl.addWidget(divider())
        foot_l = QHBoxLayout()
        self.overview_account_label = label("当前生效账户：未读取", "Small")
        foot_l.addWidget(self.overview_account_label, 1)
        foot_l.addWidget(self.button("切换账户 →", lambda: self.navigate(1), "Quiet"))
        nl.addLayout(foot_l)

        columns.addWidget(net_card, 1)

        # Right Card (6): Kernel & Experience (Clean Hairline Rows, Zero Nested Boxes)
        kern_card = self._register_glass(GlassCard(radius=18))
        kl = QVBoxLayout(kern_card)
        kl.setContentsMargins(18, 16, 18, 14)
        kl.setSpacing(10)

        kern_head = QHBoxLayout()
        kern_head.setSpacing(8)
        self._kern_icon_lbl = QLabel()
        self._kern_icon_lbl.setFixedSize(22, 22)
        kern_head.addWidget(self._kern_icon_lbl)
        kh_txt = QVBoxLayout()
        kh_txt.setSpacing(2)
        kh_txt.addWidget(label("内核与体验", "Section"))
        self.kernel_hint = label("等待读取本机内核状态…", "Small", True)
        kh_txt.addWidget(self.kernel_hint)
        kern_head.addLayout(kh_txt, 1)
        self.kernel_dirty_badge = label("未保存", "PillAmber")
        self.kernel_dirty_badge.hide()
        kern_head.addWidget(self.kernel_dirty_badge)
        self.strip_backup_pill = label("待检测", "PillMuted")
        kern_head.addWidget(self.strip_backup_pill)
        kl.addLayout(kern_head)

        kl.addWidget(divider())

        # Prompt Tier Segmented Control + Underneath Description (Zero Clipping!)
        kl.addWidget(label("系统提示词", "Sub"))
        self.tier = self._register_glass(SegmentedControl())
        self.tier.setAccessibleName("提示词档位")
        for text, key, tip in [
            ("官方原版", "stock", self.TIER_HINTS["stock"]),
            ("精简·防编造", "3", self.TIER_HINTS["3"]),
        ]:
            self.tier.addItem(text, key, tip)
        self.tier.currentIndexChanged.connect(self._on_tier_changed)
        kl.addWidget(self.tier)
        self.tier_hint_label = label(self.TIER_HINTS["3"], "Small", True)
        kl.addWidget(self.tier_hint_label)
        self.tier.setCurrentIndex(self.tier.findData("3"))

        # Context Window Segmented Control + Underneath Description
        kl.addWidget(label("上下文窗口上限", "Sub"))
        self.context = self._register_glass(SegmentedControl())
        self.context.setAccessibleName("上下文窗口")
        for text, key, tip in [
            ("官方原版", "stock", self.CTX_HINTS["stock"]),
            ("512K", "512k", self.CTX_HINTS["512k"]),
            ("900K / 1M", "900k", self.CTX_HINTS["900k"]),
        ]:
            self.context.addItem(text, key, tip)
        self.context.currentIndexChanged.connect(self._on_context_changed)
        kl.addWidget(self.context)
        self.context_hint_label = label(self.CTX_HINTS["512k"], "Small", True)
        kl.addWidget(self.context_hint_label)

        kl.addWidget(divider())

        # 3 Clean Vertical Experience Toggle Rows
        self.i18n = self.switch("", "enhance")
        self.monitor = self.switch("", "enhance")
        self.auto_kernel = self.switch("", "enhance")

        rows_spec = [
            (self.i18n, "中文界面", "翻译支持的客户端文字"),
            (self.monitor, "会话统计", "小圆环显示占用，悬停查看详情"),
            (self.auto_kernel, "启动前同步", "更新后恢复已选设置"),
        ]
        for idx, (sw, title_txt, desc_txt) in enumerate(rows_spec):
            sw.setAccessibleName(title_txt)
            sw.setToolTip(desc_txt)
            row = QHBoxLayout()
            row.setSpacing(10)
            row.addWidget(label(title_txt, "Sub"))
            row.addWidget(label(desc_txt, "Small", True), 1)
            row.addWidget(sw)
            kl.addLayout(row)
            if idx < len(rows_spec) - 1:
                kl.addWidget(divider())

        kl.addStretch(1)
        kl.addWidget(divider())

        foot_r = QHBoxLayout()
        foot_r.setSpacing(8)
        self.save_enhance_button = self.button("保存体验开关", self.save_enhance)
        foot_r.addWidget(self.save_enhance_button)
        foot_r.addStretch(1)
        self.restore_button = self.button("恢复默认", lambda: self.apply_kernel(restore=True))
        self.kernel_button = self.button("应用内核", self.apply_kernel, "AccentSoft")
        foot_r.addWidget(self.restore_button)
        foot_r.addWidget(self.kernel_button)
        kl.addLayout(foot_r)

        columns.addWidget(kern_card, 1)
        layout.addLayout(columns, 1)

    # ------------------------------------------------------------------ Page 1: Accounts (7:5 Master-Detail)
    def _build_accounts_page(self, layout: QVBoxLayout) -> None:
        # Calm 4-Control Toolbar
        toolbar = QHBoxLayout()
        toolbar.setSpacing(8)

        self.account_search = QLineEdit()
        self.account_search.setPlaceholderText("搜索账户名称或邮箱…")
        self.account_search.setClearButtonEnabled(True)
        self.account_search.setFixedWidth(210)
        self.account_search.textChanged.connect(lambda: self.render_accounts(force=True))
        toolbar.addWidget(self.account_search)

        self.account_sort = QComboBox()
        self.account_sort.setAccessibleName("账户排序")
        self.account_sort.setFixedWidth(108)
        for text, key in [("默认顺序", "default"), ("余量优先", "quota"), ("最近切换", "recent"), ("名称排序", "name")]:
            self.account_sort.addItem(text, key)
        self.account_sort.currentIndexChanged.connect(lambda: self.render_accounts(force=True))
        toolbar.addWidget(self.account_sort)

        toolbar.addStretch(1)

        self.oauth_button = self.button("授权添加", self.start_oauth, "Primary", "plus", 14)
        toolbar.addWidget(self.oauth_button)

        self.account_tools = AccountTools(self)
        # Detail actions will be mounted into the right panel below
        self._detail_actions_host = QHBoxLayout()
        self._detail_actions_host.setSpacing(6)
        self.account_tools.mount(toolbar, self._detail_actions_host)
        layout.addLayout(toolbar)

        split = QHBoxLayout()
        split.setSpacing(14)

        # Left (7): OAuth Banner + Scrollable Account Cards (NO duplicated quota text!)
        left_col = QVBoxLayout()
        left_col.setSpacing(8)

        self.oauth_box = self._register_glass(GlassCard(variant="accent", radius=14))
        ol = QVBoxLayout(self.oauth_box)
        ol.setContentsMargins(14, 10, 14, 10)
        ol.setSpacing(7)
        oh = QHBoxLayout()
        oh.addWidget(label("浏览器授权进行中 · 登录后自动完成，或手动粘贴回调地址", "Section"))
        oh.addStretch(1)
        self.oauth_cancel_button = self.button("取消授权", self.cancel_oauth, "Quiet")
        oh.addWidget(self.oauth_cancel_button)
        ol.addLayout(oh)

        self.oauth_url = QLineEdit()
        self.oauth_url.setReadOnly(True)
        self.oauth_url.setEchoMode(QLineEdit.EchoMode.Password)
        self.oauth_url.setPlaceholderText("授权链接（点击复制或重新打开）")
        self.oauth_url.setAccessibleName("浏览器授权链接")
        self.oauth_open_button = self.button("重新打开", self.open_oauth, symbol="external", size=14)
        self.oauth_copy_button = self.button("复制链接", self.copy_oauth)
        ol.addLayout(hrow(self.oauth_url, self.oauth_open_button, self.oauth_copy_button))

        self.callback = QLineEdit()
        self.callback.setEchoMode(QLineEdit.EchoMode.Password)
        self.callback.setPlaceholderText("未自动完成时粘贴浏览器回调地址（隐藏显示）")
        self.oauth_submit_button = self.button("提交回调", self.submit_oauth, "AccentSoft")
        ol.addLayout(hrow(self.callback, self.oauth_submit_button))

        self.oauth_box.hide()
        left_col.addWidget(self.oauth_box)

        meta_row = QHBoxLayout()
        self.account_summary = label("等待读取账户池…", "Small")
        meta_row.addWidget(self.account_summary)
        meta_row.addStretch(1)
        meta_row.addWidget(self.account_tools.progress)
        left_col.addLayout(meta_row)

        self.accounts_scroll = NoHorizontalScrollArea()
        self.accounts_container = QWidget()
        self.accounts_container.setObjectName("CardContent")
        self.accounts_layout = QVBoxLayout(self.accounts_container)
        self.accounts_layout.setContentsMargins(0, 0, 4, 0)
        self.accounts_layout.setSpacing(10)
        self.account_empty = label("还没有账户。通过浏览器授权，或读取本地客户端账户。", "Muted", True)
        self.account_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.account_empty.hide()
        self.accounts_layout.addWidget(self.account_empty)
        self.accounts_layout.addStretch(1)
        self.accounts_scroll.setWidget(self.accounts_container)
        left_col.addWidget(self.accounts_scroll, 1)

        split.addLayout(left_col, 7)

        # Right (5): Selected Account Details + Token Usage Overview
        right_card = self._register_glass(GlassCard(radius=18))
        rl = QVBoxLayout(right_card)
        rl.setContentsMargins(16, 15, 16, 14)
        rl.setSpacing(10)

        sel_head = QHBoxLayout()
        sel_txt = QVBoxLayout()
        sel_txt.setSpacing(1)
        self.selected_acc_name = ElidedLabel("未选择账户")
        self.selected_acc_name.setObjectName("Section")
        self.selected_acc_email = ElidedLabel("点击左侧卡片查看账户操作")
        self.selected_acc_email.setObjectName("MonoMuted")
        sel_txt.addWidget(self.selected_acc_name)
        sel_txt.addWidget(self.selected_acc_email)
        sel_head.addLayout(sel_txt, 1)
        self.selected_acc_badge = label("—", "PillMuted")
        sel_head.addWidget(self.selected_acc_badge)
        rl.addLayout(sel_head)

        self.select_account_button = self.button("设为启动", self.select_account)
        self.quota_button = self.button("刷新配额", self.refresh_quota)
        self.remove_account_button = self.button("删除", self.remove_account, "DangerSoft")

        act_row = QHBoxLayout()
        act_row.setSpacing(6)
        act_row.addWidget(self.select_account_button)
        act_row.addWidget(self.quota_button)
        act_row.addLayout(self._detail_actions_host)
        act_row.addWidget(self.remove_account_button)
        act_row.addStretch(1)
        rl.addLayout(act_row)

        rl.addWidget(divider())

        uh = QHBoxLayout()
        uh_txt = QVBoxLayout()
        uh_txt.setSpacing(1)
        uh_txt.addWidget(label("本机 Token 用量", "Section"))
        self.usage_conv_label = label("统计本机全部会话，不区分账户", "Small")
        uh_txt.addWidget(self.usage_conv_label)
        uh.addLayout(uh_txt, 1)
        uh.addWidget(self.button("明细", self.show_usage, "Quiet"))
        rl.addLayout(uh)

        u_grid = QGridLayout()
        u_grid.setSpacing(8)
        self.usage_tiles: dict[str, tuple[QLabel, QLabel, QLabel]] = {}
        for idx, (key, title_txt) in enumerate([("today", "今日"), ("days7", "近 7 天"), ("days30", "近 30 天"), ("all", "累计总计")]):
            tile = QFrame()
            tile.setObjectName("MetricTile")
            tl_box = QVBoxLayout(tile)
            tl_box.setContentsMargins(10, 8, 10, 8)
            tl_box.setSpacing(2)
            top_t = QHBoxLayout()
            top_t.addWidget(label(title_txt, "Small"))
            top_t.addStretch(1)
            req_lbl = label("0 次", "Small")
            top_t.addWidget(req_lbl)
            tl_box.addLayout(top_t)
            val_lbl = label("—", "MetricAccent" if key == "today" else "Metric")
            io_lbl = label("入 — · 出 —", "MonoMuted")
            tl_box.addWidget(val_lbl)
            tl_box.addWidget(io_lbl)
            self.usage_tiles[key] = (val_lbl, req_lbl, io_lbl)
            u_grid.addWidget(tile, idx // 2, idx % 2)
        rl.addLayout(u_grid)

        dist_head = QHBoxLayout()
        dist_head.addWidget(label("模型分布（近 7 天）", "Small"))
        dist_head.addStretch(1)
        self.usage_dist_total = label("—", "MonoMuted")
        dist_head.addWidget(self.usage_dist_total)
        rl.addLayout(dist_head)

        self.model_dist_bar = ModelDistributionBar()
        self.model_dist_bar.set_dark(self.dark)
        rl.addWidget(self.model_dist_bar)

        self.model_dist_list = QVBoxLayout()
        self.model_dist_list.setSpacing(4)
        rl.addLayout(self.model_dist_list)
        rl.addStretch(1)

        # Preserve text at its natural height; scroll when the viewport is short.
        self.account_details_scroll = NoHorizontalScrollArea()
        self.account_details_scroll.setWidget(right_card)
        split.addWidget(self.account_details_scroll, 5)
        layout.addLayout(split, 1)

    # ------------------------------------------------------------------ Page 2: Mobile Remote (Full-Width URL Row!)
    def _build_mobile_page(self, layout: QVBoxLayout) -> None:
        split = QHBoxLayout()
        split.setSpacing(14)

        # Left (7): Clean Hairline-Separated Controls
        ctrl_card = self._register_glass(GlassCard(radius=18))
        cl = QVBoxLayout(ctrl_card)
        cl.setContentsMargins(18, 16, 18, 14)
        cl.setSpacing(12)

        head = QHBoxLayout()
        head_txt = QVBoxLayout()
        head_txt.setSpacing(2)
        head_txt.addWidget(label("手机远程", "Section"))
        head_txt.addWidget(label("在手机浏览器中继续桌面对话", "Small", True))
        head.addLayout(head_txt, 1)
        self.mobile_state = label("未启动", "PillMuted")
        head.addWidget(self.mobile_state)
        cl.addLayout(head)

        cl.addWidget(divider())

        # Dedicated Full-Width URL Row (Never Truncates .com!)
        cl.addWidget(label("手机访问地址（完整显示）", "Sub"))
        self.mobile_url = QLineEdit()
        self.mobile_url.setReadOnly(True)
        self.mobile_url.setPlaceholderText("启动远程服务后生成访问地址")
        self.mobile_url.setAccessibleName("手机访问地址")
        self.copy_mobile_button = self.button("复制", self.copy_mobile)
        self.open_mobile_button = self.button("打开", self.open_mobile, symbol="external", size=14)
        self.open_mobile_button.setToolTip("在系统浏览器中打开访问地址")
        cl.addLayout(hrow(self.mobile_url, self.copy_mobile_button, self.open_mobile_button, spacing=6))

        # Dedicated Separate Row for PIN
        pin_row = QHBoxLayout()
        pin_row.setSpacing(10)
        pin_txt = QVBoxLayout()
        pin_txt.setSpacing(1)
        pin_txt.addWidget(label("8 位临时访问 PIN", "Sub"))
        pin_txt.addWidget(label("离开页面或窗口失焦时自动重新遮盖", "Small"))
        pin_row.addLayout(pin_txt, 1)

        self.mobile_pin = QLineEdit()
        self.mobile_pin.setReadOnly(True)
        self.mobile_pin.setEchoMode(QLineEdit.EchoMode.Password)
        self.mobile_pin.setPlaceholderText("••••••••")
        self.mobile_pin.setFixedWidth(104)
        self.mobile_pin.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.mobile_pin.setAccessibleName("手机访问 PIN")
        self.reveal_pin = ToggleSwitch("显示")
        self.reveal_pin.set_dark(self.dark)
        self.reveal_pin.toggled.connect(
            lambda v: self.mobile_pin.setEchoMode(QLineEdit.EchoMode.Normal if v else QLineEdit.EchoMode.Password)
        )
        self._switches.append(self.reveal_pin)
        self.copy_pin_button = self.button("复制", self.copy_pin)
        pin_row.addLayout(hrow(self.mobile_pin, self.reveal_pin, self.copy_pin_button, spacing=6))
        cl.addLayout(pin_row)

        cl.addWidget(divider())

        # Tunnel Mode + Conditional Fixed URL
        cl.addWidget(label("隧道接入模式", "Sub"))
        self.mobile_mode = self._register_glass(SegmentedControl())
        self.mobile_mode.setAccessibleName("手机远程模式")
        self.mobile_mode.addItem("临时隧道", "quick", "免配置，启动时生成随机网址")
        self.mobile_mode.addItem("固定域名", "fixed", "填写 Cloudflare Tunnel Token 和固定 HTTPS 域名")
        self.mobile_mode.currentIndexChanged.connect(self._mobile_mode_changed)
        cl.addWidget(self.mobile_mode)

        self.fixed_fields = QWidget()
        fl = QVBoxLayout(self.fixed_fields)
        fl.setContentsMargins(0, 0, 0, 0)
        fl.setSpacing(6)
        fl.addWidget(label("Cloudflare Tunnel Token", "Sub"))
        self.tunnel_token = QLineEdit()
        self.tunnel_token.setEchoMode(QLineEdit.EchoMode.Password)
        self.tunnel_token.setPlaceholderText("首次粘贴 Token，保存后留空即可")
        self.tunnel_token.setAccessibleName("Cloudflare Tunnel Token")
        self.tunnel_token.textEdited.connect(self._mobile_token_edited)
        self.clear_tunnel_token_button = self.button("清除已存", self.clear_mobile_token, "Quiet")
        self.clear_tunnel_token_button.setAccessibleName("清除本机 Tunnel Token")
        fl.addLayout(hrow(self.tunnel_token, self.clear_tunnel_token_button, spacing=6))
        self.tunnel_token_status = label("尚未保存 Token", "Small", True)
        fl.addWidget(self.tunnel_token_status)
        self.fixed_url = QLineEdit()
        self.fixed_url.setPlaceholderText("固定域名，例如 https://pocket.example.com")
        self.fixed_url.textEdited.connect(lambda: self._dirty.add("mobile"))
        self.fixed_url.setAccessibleName("固定域名")
        fl.addWidget(self.fixed_url)
        fl.addWidget(label("在 Cloudflare 为隧道配置此域名，服务指向 http://127.0.0.1:3082。", "Small", True))
        self.fixed_fields.hide()
        self.fixed_url.hide()
        cl.addWidget(self.fixed_fields)

        auto_row = QHBoxLayout()
        auto_row.addWidget(label("启动 AG 时自动开启手机远程", "Sub"), 1)
        self.mobile_auto = self.switch("", "mobile")
        self.mobile_auto.setAccessibleName("启动时开启手机远程")
        auto_row.addWidget(self.mobile_auto)
        cl.addLayout(auto_row)

        self.mobile_detail = label("等待读取远程服务状态…", "Small", True)
        cl.addWidget(self.mobile_detail)
        cl.addStretch(1)

        cl.addWidget(divider())
        self.mobile_start_button = self.button("启动远程服务", self.start_mobile, "Primary", "mobile", 14)
        self.mobile_stop_button = self.button("停止服务", self.stop_mobile, "DangerSoft")
        self.save_mobile_button = self.button("保存设置", self.save_mobile)
        cl.addLayout(hrow(self.mobile_start_button, self.mobile_stop_button, self.save_mobile_button, stretch=True))

        split.addWidget(ctrl_card, 7)

        # Right (5): QR Pairing Glass Card
        qr_card = self._register_glass(GlassCard(radius=18))
        ql = QVBoxLayout(qr_card)
        ql.setContentsMargins(20, 20, 20, 20)
        ql.setSpacing(14)
        ql.addStretch(1)

        self.mobile_qr_frame = QFrame()
        self.mobile_qr_frame.setFixedSize(184, 184)
        self.mobile_qr_frame.setStyleSheet("background: #ffffff; border-radius: 16px; border: 1px solid rgba(255,255,255,220);")
        qfl = QVBoxLayout(self.mobile_qr_frame)
        qfl.setContentsMargins(10, 10, 10, 10)
        self.mobile_qr = QLabel()
        self.mobile_qr.setAccessibleName("手机访问地址二维码")
        self.mobile_qr.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.mobile_qr.setFixedSize(164, 164)
        self.mobile_qr.setScaledContents(True)
        qfl.addWidget(self.mobile_qr)
        self.mobile_qr_frame.hide()
        ql.addWidget(self.mobile_qr_frame, 0, Qt.AlignmentFlag.AlignCenter)

        self.mobile_qr_placeholder = QFrame()
        self.mobile_qr_placeholder.setObjectName("DiagnosticBox")
        self.mobile_qr_placeholder.setFixedSize(184, 184)
        qpl = QVBoxLayout(self.mobile_qr_placeholder)
        qpl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        qpl.setSpacing(8)
        self._qr_ph_icon = QLabel()
        self._qr_ph_icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
        qpl.addWidget(self._qr_ph_icon)
        self.qr_ph_label = label("启动服务后生成配对二维码", "Small", True)
        self.qr_ph_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        qpl.addWidget(self.qr_ph_label)
        ql.addWidget(self.mobile_qr_placeholder, 0, Qt.AlignmentFlag.AlignCenter)

        self.qr_caption_title = label("扫码在手机继续对话", "Section")
        self.qr_caption_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ql.addWidget(self.qr_caption_title)

        qr_note = label("二维码仅包含访问入口，不包含 PIN。\n扫码打开后请输入左侧 8 位 PIN。", "Small", True)
        qr_note.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ql.addWidget(qr_note)
        ql.addStretch(1)

        split.addWidget(qr_card, 5)
        content = QWidget()
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.addLayout(split, 1)
        self.mobile_scroll = NoHorizontalScrollArea()
        self.mobile_scroll.setWidget(content)
        layout.addWidget(self.mobile_scroll, 1)

    # ------------------------------------------------------------------ Page 3: Logs
    def _build_logs_page(self, layout: QVBoxLayout) -> None:
        bar = QHBoxLayout()
        bar.setSpacing(8)

        bar.addWidget(label("全部日志", "Section"))

        bar.addStretch(1)

        self.log_filter = QLineEdit()
        self.log_filter.setPlaceholderText("筛选关键字…")
        self.log_filter.setClearButtonEnabled(True)
        self.log_filter.setFixedWidth(190)
        self.log_filter.textChanged.connect(self.render_logs)
        bar.addWidget(self.log_filter)

        bar.addWidget(self.button("复制", self.copy_logs))
        bar.addWidget(self.button("清屏", self.clear_logs))
        bar.addWidget(self.button("刷新", self.refresh, symbol="refresh", size=14))
        layout.addLayout(bar)

        log_card = self._register_glass(GlassCard(radius=18))
        ll = QVBoxLayout(log_card)
        ll.setContentsMargins(14, 14, 14, 10)
        ll.setSpacing(8)

        self.logs = QTextEdit()
        self.logs.setReadOnly(True)
        self.logs.setAcceptRichText(False)
        self.logs.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        self.logs.setPlaceholderText("连接工作区后，运行事件会显示在这里。")
        self.logs.setStyleSheet("QTextEdit { font-family: 'Cascadia Mono', 'Consolas', monospace; font-size: 12px; }")
        ll.addWidget(self.logs, 1)

        foot = QHBoxLayout()
        foot.addWidget(label("自动脱敏已启用 · 令牌 / 回调参数 / PIN 永不进入可复制日志", "Small"))
        foot.addStretch(1)
        self.log_count_label = label("共 0 条事件", "MonoMuted")
        foot.addWidget(self.log_count_label)
        ll.addLayout(foot)

        layout.addWidget(log_card, 1)

    # ------------------------------------------------------------------ Navigation & Theme
    def navigate(self, index: int, animate: bool = True) -> None:
        i = int(index)
        if i == 4:
            i = 2
        elif i == 5:
            i = 3
        elif i < 0 or i > 3:
            return
        self._stop_animations()
        self.active_card = i
        self.stack.setCurrentIndex(i)
        for n, b in enumerate(self.nav_buttons):
            b.setChecked(n == i)
        if i != 2 and hasattr(self, "reveal_pin"):
            self.reveal_pin.setChecked(False)
        if animate and self.isVisible():
            self._animate_page(i)

    def focus_card(self, index: int) -> None:
        self.navigate(index)

    def _animate_page(self, index: int) -> None:
        if not (0 <= index < len(self._page_effects)):
            return
        effect = self._page_effects[index]
        anim = QPropertyAnimation(effect, b"opacity", self)
        anim.setDuration(ACCENT_TRANSITION_MS)
        anim.setStartValue(0.80)
        anim.setEndValue(1.0)
        anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._animations.append(anim)
        anim.start()

    def _stop_animations(self) -> None:
        for anim in list(self._animations):
            try:
                anim.stop()
                target = anim.targetObject()
                if target is not None and hasattr(target, "setOpacity"):
                    target.setOpacity(1.0)
            except RuntimeError:
                pass
        self._animations.clear()

    def settle_animations(self) -> None:
        self._stop_animations()
        QApplication.processEvents()

    def set_dark(self, dark: bool, persist: bool = True) -> None:
        self.dark = dark
        self.setStyleSheet(stylesheet(dark))
        self.canvas.set_dark(dark)
        apply_window_glass(self, dark)
        for card in self._glass_cards:
            card.set_dark(dark)
        for sw in self._switches:
            sw.set_dark(dark)
        for card in self._account_cards:
            card.set_dark(dark)
        if hasattr(self, "model_dist_bar"):
            self.model_dist_bar.set_dark(dark)

        c = DARK if dark else LIGHT
        primary = c["primarytext"]
        for b, name in self._icons:
            color = primary if b.objectName() == "Primary" else c["subtext"]
            b.setIcon(svg_icon(name, color, 15))
        self.theme_button.setIcon(svg_icon("sun" if dark else "moon", c["subtext"], 15))
        self.theme_button.setToolTip("切换浅色外观" if dark else "切换深色外观")
        self._net_icon_lbl.setPixmap(svg_icon("globe", c["accent"], 18).pixmap(22, 22))
        self._kern_icon_lbl.setPixmap(svg_icon("cpu", c["purple"], 18).pixmap(22, 22))
        self._qr_ph_icon.setPixmap(svg_icon("qr", c["muted"], 36).pixmap(36, 36))
        self.render_logs()
        self._update_enabled()
        if persist and not self.demo:
            self.settings.setValue("dark", dark)

    def toggle_theme(self) -> None:
        self.set_dark(not self.dark)

    # ------------------------------------------------------------------ Client & Actions
    def bind_client(self, client) -> None:
        self.client = client
        client.status_received.connect(self.render_status)
        client.logs_received.connect(self.set_logs)
        client.operation_finished.connect(self.on_result)
        client.error.connect(self.on_error)
        client.connection_changed.connect(self.set_online)
        client.start()

    def set_online(self, online: bool) -> None:
        self._online = online
        self.connection.setText("已连接" if online else "正在重连")
        self.connection.setObjectName("Small" if online else "PillAmber")
        self.connection.style().unpolish(self.connection)
        self.connection.style().polish(self.connection)
        self._update_enabled()

    def inform(self, message: str) -> None:
        self.notice.setText(masked_log(str(message))[:500])
        self.notice.show()

    def refresh(self) -> None:
        if self.client:
            self.client.refresh()
            self.client.request("logs", "/api/logs?limit=120")
        elif self.demo:
            self.inform("这是界面预览，未连接真实服务。")

    def _is_busy(self, *actions: str) -> bool:
        if not actions:
            return bool(self._pending)
        return any(a in self._pending for a in actions)

    def perform(self, action: str, route: str, body=None, callback=None, scope: str | None = None, timeout: int = 20000) -> bool:
        if self.demo:
            self.inform("预览模式：此操作不会修改账户、设置或启动服务。")
            return False
        if not self.client or not self._online or self._closing:
            self.inform("本机服务尚未连接，请稍后重试。")
            return False
        if action in self._pending:
            return False
        # Config responses contain all settings; only this request owns its submitted fields.
        setting_keys = frozenset(body) if route == "/api/config" and isinstance(body, dict) else frozenset()
        self._pending[action] = (callback, scope, setting_keys)
        if not self.client.request(action, route, body, timeout_ms=timeout):
            self._pending.pop(action, None)
            return False
        self.notice.hide()
        self._update_enabled()
        return True

    def on_result(self, action: str, data) -> None:
        entry = self._pending.pop(action, None)
        if entry is None:
            return
        callback, scope, setting_keys = entry
        if scope:
            self._dirty.discard(scope)
        patch = {}
        if isinstance(data, dict):
            if isinstance(data.get("settings"), dict):
                patch.update((key, value) for key, value in data["settings"].items() if key in setting_keys)
            for key in ("kernel", "proxy", "accounts", "mobile", "tokenUsage"):
                if key in data:
                    patch[key] = data[key]
        if patch:
            self.render_status({**self.snapshot, **patch})
        self._update_enabled()
        if callable(callback):
            callback(data)
        else:
            self.inform("操作已完成。")
        if self.client:
            self.client.refresh()

    def on_error(self, action: str, message: str) -> None:
        self._pending.pop(action, None)
        self._update_enabled()
        self.inform(message)

    @staticmethod
    def set_control(w, value) -> None:
        old = w.blockSignals(True)
        if isinstance(w, QCheckBox):
            w.setChecked(bool(value))
        elif isinstance(w, QSpinBox):
            w.setValue(int(value or 7890))
        elif isinstance(w, (QComboBox, SegmentedControl)):
            i = w.findData(value)
            if i >= 0:
                w.setCurrentIndex(i)
        else:
            w.setText(str(value or ""))
        w.blockSignals(old)

    # ------------------------------------------------------------------ Form Handlers
    def _on_port_changed(self, value: int) -> None:
        self._dirty.add("network")
        self._sync_port_chips(value)
        self._update_dirty_badges()

    def _apply_port_preset(self, port: int) -> None:
        if not self.port.isEnabled():
            return
        self.port.setValue(port)
        self._sync_port_chips(port)

    def _sync_port_chips(self, port_val: int) -> None:
        for num, chip in self._port_chips:
            chip.setProperty("active", "true" if num == port_val else "false")
            chip.style().unpolish(chip)
            chip.style().polish(chip)

    def _on_tier_changed(self, _idx: int) -> None:
        self._dirty.add("kernel")
        key = str(self.tier.currentData() or "3")
        self.tier_hint_label.setText(self.TIER_HINTS.get(key, ""))
        self._update_dirty_badges()

    def _on_context_changed(self, _idx: int) -> None:
        self._dirty.add("kernel")
        key = str(self.context.currentData() or "512k")
        self.context_hint_label.setText(self.CTX_HINTS.get(key, ""))
        self._update_dirty_badges()

    def _update_dirty_badges(self) -> None:
        if hasattr(self, "network_dirty_badge"):
            self.network_dirty_badge.setVisible("network" in self._dirty)
        if hasattr(self, "kernel_dirty_badge"):
            self.kernel_dirty_badge.setVisible("kernel" in self._dirty or "enhance" in self._dirty)

    # ------------------------------------------------------------------ Render Status
    def render_status(self, state: dict) -> None:
        self.snapshot = state
        phase = state.get("phase", (state.get("session") or {}).get("phase", "idle"))
        running = phase == "running"
        connected = bool(state.get("cdpSockets"))
        port = state.get("port", 7890)
        phase_text = "运行中" if running else ("正在启动…" if phase in ("preparing", "launching") else "已就绪")
        self.runtime_detail.setText(
            f"{phase_text}" + (" · 已挂载增强" if running and connected else "") + f" · :{port}"
        )

        if "network" not in self._dirty:
            self.set_control(self.port, port)
            self._sync_port_chips(int(port or 7890))
            self.set_control(self.preflight, state.get("preflightProxy", True))
        if "enhance" not in self._dirty:
            for w, key in [
                (self.i18n, "enableI18n"),
                (self.monitor, "enableContextMonitor"),
                (self.auto_kernel, "autoApplyKernelPatch"),
            ]:
                self.set_control(w, state.get(key, True))

        kernel = state.get("kernel") or {}
        desired = kernel.get("desired") or {}
        if "kernel" not in self._dirty:
            t_val = desired.get("promptTier", state.get("promptTier", "3"))
            c_val = desired.get("contextMode", state.get("contextMode", "512k"))
            self.set_control(self.tier, t_val)
            if str(t_val) not in self.VISIBLE_TIERS:
                self.tier._group.setExclusive(False)
                for button in self.tier._buttons:
                    button.setChecked(False)
                self.tier._group.setExclusive(True)
            self.set_control(self.context, c_val)
            self.tier_hint_label.setText(self.TIER_HINTS.get(str(t_val), ""))
            self.context_hint_label.setText(self.CTX_HINTS.get(str(c_val), ""))

        targets = [t for t in kernel.get("targets", []) if t.get("exists")]
        errors = [t.get("error") for t in targets if t.get("error")]
        hint = "尚未检测到可用内核，请先安装 Antigravity。"
        if errors:
            hint = "内核解析失败：" + str(errors[0])
        elif targets:
            backed = all(t.get("backupExists") for t in targets)
            hint = f"检测到 {len(targets)} 个本机内核 · " + ("已有 .bak 备份" if backed else "首次修改自动创建备份")
            self.strip_backup_pill.setText("已备份 .bak" if backed else "待备份")
            self.strip_backup_pill.setObjectName("PillGreen" if backed else "PillMuted")
        else:
            self.strip_backup_pill.setText("未检测")
            self.strip_backup_pill.setObjectName("PillMuted")
        self.strip_backup_pill.style().unpolish(self.strip_backup_pill)
        self.strip_backup_pill.style().polish(self.strip_backup_pill)
        if any(t.get("promptLegacy") for t in targets):
            hint += " · 正在使用旧版提示词，应用所选档位后更新。"
        self.kernel_hint.setText(hint)

        self.render_proxy(state.get("proxy") or {})
        items = (state.get("accounts") or {}).get("items") or []
        self._account_items = items
        self._render_overview_account(items, (state.get("accounts") or {}).get("activeId"))
        self.render_accounts()
        self.render_oauth(state.get("oauthFlow"))
        self.render_usage(state.get("tokenUsage") or {})
        self.render_mobile(state.get("mobile") or {})
        self.account_tools.render_status(state)
        self._update_dirty_badges()
        self._update_enabled()

    def _render_overview_account(self, items: list[dict], active_id: str | None) -> None:
        live = next((a for a in items if a.get("isLive")), None)
        target = live or next((a for a in items if a.get("id") == active_id), None)
        if target:
            name = str(target.get("name") or target.get("email") or "账户")
            tier = str(target.get("tier") or "").upper()
            suffix = f" ({tier})" if tier and tier != "UNKNOWN" else ""
            tag = "当前生效" if live else "启动账户"
            self.overview_account_label.setText(f"{tag}：{name[:14]}{suffix}")
        else:
            self.overview_account_label.setText(f"已保存 {len(items)} 个账户" if items else "尚未添加账户")

    @staticmethod
    def proxy_label(last: dict | None) -> str:
        return {
            "ok": "出口正常",
            "geo-blocked": "地域受限",
            "proxy-down": "代理未连接",
            "proxy-rejected": "代理拒绝转发",
            "timeout": "检测超时",
            "bad-response": "响应异常",
        }.get((last or {}).get("code"), "尚未检测")

    def render_proxy(self, proxy: dict) -> None:
        last = proxy.get("lastResult") or {}
        code = last.get("code")
        status_text = self.proxy_label(last)
        self.proxy_state.setText(status_text)
        badge_txt = f"{status_text} · {last['ms']} ms" if code == "ok" and "ms" in last else status_text
        self.hero_badge.setText(badge_txt)
        pill_role = (
            "PillGreen" if code == "ok"
            else "PillRed" if code in ("geo-blocked", "proxy-down", "proxy-rejected", "bad-response")
            else "PillAmber" if code == "timeout"
            else "PillInfo"
        )
        self.hero_badge.setObjectName(pill_role)
        self.hero_badge.style().unpolish(self.hero_badge)
        self.hero_badge.style().polish(self.hero_badge)

        msg = str(last.get("message") or "点击右上角「检测连接」，检查代理端口和 Google 服务响应。")
        if last.get("advice"):
            msg += " " + str(last["advice"])
        self.proxy_detail.setText(msg)

        egress = last.get("egress") or {}
        place = " · ".join(str(egress[k]) for k in ("ip", "countryName", "city") if egress.get(k))
        self.proxy_egress.setText(place or "—")

    def render_usage(self, usage: dict) -> None:
        self.usage_conv_label.setText(f"统计本机全部会话 · {usage.get('conversationCount', 0)} 次会话")

        for key in ("today", "days7", "days30", "all"):
            bucket = usage.get(key) or {}
            val_lbl, req_lbl, io_lbl = self.usage_tiles[key]
            val_lbl.setText(short_number(bucket.get("totalTokens")))
            req_lbl.setText(f"{bucket.get('requests', 0)} 次")
            if "inputTokens" in bucket or "outputTokens" in bucket:
                io_lbl.setText(f"入 {short_number(bucket.get('inputTokens'))} · 出 {short_number(bucket.get('outputTokens'))}")
            else:
                io_lbl.setText("Token 总计")

        # Keep the period, chart, legend, and total on the same seven-day dataset.
        models = (usage.get("days7") or {}).get("models") or []
        dist_items = [(str(m.get("name") or "其他"), float(m.get("totalTokens") or 0)) for m in models]
        dist_items = [(name, total) for name, total in dist_items if total > 0]
        if len(dist_items) > 3:
            dist_items = dist_items[:2] + [("其他", sum(total for _, total in dist_items[2:]))]
        self.model_dist_bar.set_items(dist_items)
        dist_total = sum(total for _, total in dist_items)
        self.usage_dist_total.setText(short_number(dist_total) if dist_total > 0 else "—")

        while self.model_dist_list.count():
            item = self.model_dist_list.takeAt(0)
            w = item.widget()
            if w is not None:
                w.hide()
                w.setParent(None)
                w.deleteLater()
            elif item.layout() is not None:
                sub = item.layout()
                while sub.count():
                    cw = sub.takeAt(0).widget()
                    if cw is not None:
                        cw.hide()
                        cw.setParent(None)
                        cw.deleteLater()

        if dist_items:
            for idx, (name, total) in enumerate(dist_items):
                row = QHBoxLayout()
                row.setSpacing(6)
                dot = QLabel("●")
                color = ModelDistributionBar.COLORS[idx % len(ModelDistributionBar.COLORS)]
                dot.setStyleSheet(f"color: {color}; font-size: 10px;")
                row.addWidget(dot)
                model_name = ElidedLabel(name)
                model_name.setObjectName("Small")
                row.addWidget(model_name, 1)
                row.addWidget(label(short_number(total), "MonoMuted"))
                self.model_dist_list.addLayout(row)
        else:
            self.model_dist_list.addWidget(label("暂无模型用量记录", "Small"))

    def render_accounts(self, force: bool = False) -> None:
        key = json.dumps(
            [
                self._account_items,
                (self.snapshot.get("accounts") or {}).get("activeId"),
                (self.snapshot.get("accounts") or {}).get("liveId"),
                self._selected_account_id,
            ],
            ensure_ascii=False,
            sort_keys=True,
        )
        if key == self._accounts_key and not force:
            return
        self._accounts_key = key

        query = self.account_search.text().strip().casefold()
        visible = [
            a for a in self._account_items
            if query in (str(a.get("name", "")) + " " + str(a.get("email", ""))).casefold()
        ]
        mode = self.account_sort.currentData()
        if mode == "name":
            visible.sort(key=lambda a: str(a.get("name") or a.get("email") or "").casefold())
        elif mode == "recent":
            visible.sort(key=lambda a: a.get("lastSwitchedAt") or 0, reverse=True)
        elif mode == "quota":
            def remaining(a):
                q = a.get("quota") or {}
                values = [
                    m["percentage"]
                    for m in ((q.get("models") or []) + (q.get("windows") or []))
                    if isinstance(m, dict) and isinstance(m.get("percentage"), (int, float))
                ]
                return min(values) if values else -1
            visible.sort(key=remaining, reverse=True)

        if self._selected_account_id and not any(a.get("id") == self._selected_account_id for a in self._account_items):
            self._selected_account_id = None
        if self._selected_account_id is None and visible:
            self._selected_account_id = visible[0].get("id")

        for old_card in self._account_cards:
            self.accounts_layout.removeWidget(old_card)
            old_card.hide()
            old_card.setParent(None)
            old_card.deleteLater()
        self._account_cards.clear()

        active_id = (self.snapshot.get("accounts") or {}).get("activeId")
        busy = self._is_busy("account-select", "account-switch", "account-remove", "account-quota", "launch")
        insert_pos = 0
        for a in visible:
            aid = str(a.get("id") or "")
            card = AccountCardWidget(
                a,
                active_id=active_id,
                selected=(aid == self._selected_account_id),
                busy=busy,
                online=self._online,
                dark=self.dark,
            )
            card.clicked.connect(self._select_card_id)
            card.action_triggered.connect(self._on_account_card_action)
            self._account_cards.append(card)
            self.accounts_layout.insertWidget(insert_pos, card)
            insert_pos += 1

        self.account_summary.setText(
            f"共 {len(self._account_items)} 个账户" + (f" · 筛选出 {len(visible)} 个" if query else "")
        )
        self.account_empty.setVisible(not visible)
        self.account_empty.setText(
            "没有匹配的账户。" if self._account_items else "还没有账户。点击「授权添加」登录，或使用上方按钮导入/读取账户。"
        )
        self._update_selected_panel()
        self._update_enabled()

    def _select_card_id(self, account_id: str) -> None:
        if self._selected_account_id != account_id:
            self._selected_account_id = account_id
            self.render_accounts(force=True)
        else:
            self._update_selected_panel()
            self._update_enabled()

    def _on_account_card_action(self, action: str, account_id: str) -> None:
        self._select_card_id(account_id)
        if action == "select":
            self.select_account()
        elif action == "switch":
            self.switch_account()
        elif action == "quota":
            self.refresh_quota()
        elif action == "reauth":
            self.account_tools.reauthorize(account_id)
        elif action == "remove":
            self.remove_account()

    def selected_account(self) -> dict | None:
        if not self._selected_account_id:
            return None
        return next((a for a in self._account_items if a.get("id") == self._selected_account_id), None)

    def _update_selected_panel(self) -> None:
        selected = self.selected_account()
        if not selected:
            self.selected_acc_name.setText("未选择账户")
            self.selected_acc_email.setText("点击左侧卡片查看账户操作")
            self.selected_acc_badge.setText("—")
            self.selected_acc_badge.setObjectName("PillMuted")
        else:
            name = str(selected.get("name") or selected.get("email") or "未命名账户")
            self.selected_acc_name.setText(name)
            self.selected_acc_email.setText(str(selected.get("email") or "—"))
            tier = str(selected.get("tier") or "—").upper()
            self.selected_acc_badge.setText(tier)
            self.selected_acc_badge.setObjectName("PillPurple" if tier == "PRO" else "PillAmber" if tier == "ULTRA" else "PillMuted")


        self.selected_acc_badge.style().unpolish(self.selected_acc_badge)
        self.selected_acc_badge.style().polish(self.selected_acc_badge)

    # ------------------------------------------------------------------ Mobile Remote Logic
    def render_mobile(self, mobile: dict) -> None:
        status = str(mobile.get("state") or "stopped")
        recovering = status == "degraded" and not str(mobile.get("publicUrl") or "").strip()
        labels = {
            "stopped": ("未启动", "PillMuted"),
            "starting": ("正在启动", "PillAmber"),
            "running": ("运行中", "PillGreen"),
            "degraded": ("连接异常", "PillAmber"),
            "stopping": ("正在停止", "PillAmber"),
            "error": ("启动失败", "PillRed"),
            "external": ("外部服务", "PillInfo"),
        }
        st_text, st_role = labels.get(status, (status, "PillMuted"))
        if recovering:
            st_text = "正在恢复"
        self.mobile_state.setText(st_text)
        self.mobile_state.setObjectName(st_role)
        self.mobile_state.style().unpolish(self.mobile_state)
        self.mobile_state.style().polish(self.mobile_state)

        public_url = str(mobile.get("publicUrl") or "").strip()
        local_url = str(mobile.get("localUrl") or "").strip()
        display_url = public_url if status in ("running", "degraded", "external") else ""
        self.mobile_url.setText(display_url)
        self.mobile_url.setCursorPosition(0)

        pin_val = str(mobile.get("pin") or "") if status in ("starting", "running", "degraded", "external") else ""
        self.mobile_pin.setText(pin_val)
        if not pin_val:
            self.reveal_pin.setChecked(False)

        self.render_qr(display_url)
        if status == "starting":
            stage = {
                "origin": "正在启动本地手机服务…",
                "connector": "正在连接 Cloudflare…",
                "public": "正在验证公网入口…",
                "recovering": "正在切换连接方式…",
            }.get(str(mobile.get("startupPhase") or ""), "正在建立 Cloudflare 隧道…")
            self.qr_ph_label.setText(stage)
            self.qr_caption_title.setText("隧道准备中，请稍候")
        elif recovering:
            self.qr_ph_label.setText("正在恢复 Cloudflare 隧道…")
            self.qr_caption_title.setText("连接恢复后将更新二维码")
        elif status == "external" and not display_url:
            self.qr_ph_label.setText("外部进程占用 3082 端口")
            self.qr_caption_title.setText("工作台未托管此外部服务")
        elif display_url:
            self.qr_caption_title.setText("隧道已就绪 · 扫码立即连接")
        else:
            self.qr_ph_label.setText("启动服务后生成配对二维码")
            self.qr_caption_title.setText("扫码在手机继续对话")

        if mobile.get("lastError"):
            detail = str(mobile["lastError"])
        elif status == "external":
            detail = f"本地入口 {local_url or 'http://127.0.0.1:3082/'} 已被其他进程占用，工作台不能停止或读取其 PIN。"
        elif status == "starting":
            detail = "正在建立安全隧道，网络不通时会自动切换连接方式；首次启动最多约 125 秒，可随时停止。"
        elif status == "running":
            detail = (f"本地入口 {local_url} · " if local_url else "") + "隧道每 5 秒自动健康检查一次。"
        elif status == "degraded":
            detail = "连接异常，正在自动尝试恢复；随机地址可能变化，恢复后请使用最新二维码，也可随时停止。"
        elif not mobile.get("available", True):
            detail = "未检测到完整的 backend/mobile 运行时文件。"
        else:
            detail = "选择临时隧道（免配置）或固定域名，点击「启动远程服务」即可手机扫码接入。"
        self.mobile_detail.setText(detail)

        if "mobile" not in self._dirty:
            self.set_control(self.mobile_mode, mobile.get("mode", self.snapshot.get("mobileMode", "quick")))
            self.set_control(self.fixed_url, mobile.get("fixedUrl", self.snapshot.get("mobileFixedUrl", "")))
            self.set_control(self.mobile_auto, mobile.get("autoStart", self.snapshot.get("mobileAutoStart", False)))
        self._render_mobile_token_status()

    def _render_mobile_token_status(self) -> None:
        mobile = self.snapshot.get("mobile") or {}
        is_fixed = self.mobile_mode.currentData() == "fixed"
        self.fixed_fields.setVisible(is_fixed)
        self.fixed_url.setVisible(is_fixed)
        if self._clear_tunnel_token:
            text = "保存后将清除本机 Token。"
        elif self.tunnel_token.text():
            text = "待保存 · Token 将加密保存在本机。"
        elif mobile.get("tunnelTokenConfigured"):
            text = "已加密保存在本机 · 留空沿用" if mobile.get("fixedAuth") == "token" else "已保存，凭据暂不可用；可重新填写或清除。"
        elif mobile.get("fixedAuth") == "config":
            text = "正在使用本机 YAML 配置；也可填写 Token。"
        else:
            text = "尚未保存 · 填写 Token 后保存，仅用于此隧道。"
        self.tunnel_token_status.setText(text)
        self.tunnel_token.setPlaceholderText("留空沿用已保存 Token" if mobile.get("tunnelTokenConfigured") else "粘贴 Cloudflare Tunnel Token")

    def _mobile_token_edited(self) -> None:
        self._clear_tunnel_token = False
        self._dirty.add("mobile")
        self._render_mobile_token_status()
        self._update_enabled()

    def clear_mobile_token(self) -> None:
        if not self.clear_tunnel_token_button.isEnabled():
            return
        self.tunnel_token.clear()
        self._clear_tunnel_token = True
        self._dirty.add("mobile")
        self._render_mobile_token_status()
        self._update_enabled()

    def _mobile_mode_changed(self) -> None:
        self._dirty.add("mobile")
        self._render_mobile_token_status()
        self._update_enabled()

    def _update_enabled(self) -> None:
        if not hasattr(self, "mobile_start_button"):
            return
        online = self._online and not self._closing
        phase = self.snapshot.get("phase", (self.snapshot.get("session") or {}).get("phase", "idle"))
        ag_active = phase in ("running", "preparing", "launching")

        net_busy = self._is_busy("config-network", "config-launch", "proxy-check", "launch")
        can_edit_port = online and not ag_active and not net_busy
        self.port.setEnabled(can_edit_port)
        for _, chip in self._port_chips:
            chip.setEnabled(can_edit_port)
        self.preflight.setEnabled(online and not net_busy)
        self.save_network_button.setEnabled(online and not net_busy)
        self.proxy_button.setEnabled(online and not net_busy)
        self.proxy_button.setText("检测中…" if "proxy-check" in self._pending else "检测连接")

        launch_busy = self._is_busy("launch", "config-launch", "account-switch", "kernel-apply")
        self.launch_button.setEnabled(online and not ag_active and not launch_busy)
        self.launch_button.setProperty("running", "true" if phase == "running" else "false")
        self.launch_button.style().unpolish(self.launch_button)
        self.launch_button.style().polish(self.launch_button)
        self.launch_button.setText(
            "Antigravity 运行中" if phase == "running"
            else "正在启动…" if phase in ("preparing", "launching") or "launch" in self._pending
            else "启动 Antigravity"
        )

        enh_busy = self._is_busy("config-enhance", "config-launch", "kernel-apply", "launch")
        for w in (self.i18n, self.monitor, self.auto_kernel, self.save_enhance_button):
            w.setEnabled(online and not enh_busy)

        kernel = self.snapshot.get("kernel") or {}
        can_kernel = (
            online
            and not enh_busy
            and phase not in ("preparing", "launching")
            and kernel.get("platformSupported", True)
            and any(t.get("exists") for t in kernel.get("targets", []))
        )
        for w in (self.tier, self.context, self.kernel_button, self.restore_button):
            w.setEnabled(bool(can_kernel))

        acc_busy = self._is_busy("oauth-start", "oauth-submit", "oauth-cancel", "capture", "account-switch", "launch")
        self.oauth_button.setEnabled(online and not acc_busy)
        self.oauth_submit_button.setEnabled(online and not self._is_busy("oauth-submit"))
        self.oauth_cancel_button.setEnabled(online and not self._is_busy("oauth-cancel"))
        self.oauth_open_button.setEnabled(bool(self.oauth_url.text()) and not self._closing)
        self.oauth_copy_button.setEnabled(bool(self.oauth_url.text()) and not self._closing)

        selected = self.selected_account()
        active_id = (self.snapshot.get("accounts") or {}).get("activeId")
        sel_busy = self._is_busy("account-select", "account-switch", "account-remove", "account-quota", "launch")
        self.select_account_button.setEnabled(bool(online and selected and not sel_busy and selected.get("id") != active_id))
        self.quota_button.setEnabled(bool(online and selected and not sel_busy and not selected.get("locked")))
        self.remove_account_button.setEnabled(bool(online and selected and not sel_busy))
        for card in self._account_cards:
            card.set_interaction_state(online=online, busy=sel_busy)
        self.account_tools.update_enabled()

        mobile = self.snapshot.get("mobile") or {}
        m_state = str(mobile.get("state") or "stopped")
        m_locked = bool(mobile.get("managed")) or m_state in ("starting", "running", "degraded", "stopping", "external")
        m_cfg_busy = self._is_busy("mobile-config", "mobile-start", "mobile-stop")
        mutable = online and not m_locked and not m_cfg_busy
        for w in (self.mobile_mode, self.mobile_auto, self.save_mobile_button):
            w.setEnabled(bool(mutable))
        is_fixed = self.mobile_mode.currentData() == "fixed"
        self.fixed_fields.setVisible(is_fixed)
        self.fixed_url.setVisible(is_fixed)
        self.fixed_url.setEnabled(bool(mutable and is_fixed))
        self.tunnel_token.setEnabled(bool(mutable and is_fixed))
        self.clear_tunnel_token_button.setEnabled(bool(mutable and is_fixed and (mobile.get("tunnelTokenConfigured") or self.tunnel_token.text()) and not self._clear_tunnel_token))
        self.mobile_start_button.setEnabled(bool(mutable and mobile.get("available", True)))

        can_stop_mobile = (
            online
            and not self._is_busy("mobile-stop")
            and m_state != "external"
            and m_state != "stopping"
            and (bool(mobile.get("managed")) or m_state in ("starting", "running", "degraded") or "mobile-start" in self._pending)
        )
        self.mobile_stop_button.setEnabled(bool(can_stop_mobile))

        has_url = bool(self.mobile_url.text())
        self.copy_mobile_button.setEnabled(has_url)
        self.open_mobile_button.setEnabled(self._valid_mobile_open_url(self.mobile_url.text()) and not self._closing)
        has_pin = bool(self.mobile_pin.text())
        self.reveal_pin.setEnabled(has_pin)
        self.copy_pin_button.setEnabled(has_pin)

        c = DARK if self.dark else LIGHT
        self.launch_button.setIcon(
            svg_icon(
                "play",
                c["green"] if phase == "running" else (c["primarytext"] if self.launch_button.isEnabled() else c["muted"]),
                14,
            )
        )
        self.mobile_start_button.setIcon(
            svg_icon("mobile", c["primarytext"] if self.mobile_start_button.isEnabled() else c["muted"], 15)
        )

    # ------------------------------------------------------------------ Network / Kernel Actions
    def save_network(self, checked: bool = False, callback=None) -> bool:
        return self.perform(
            "config-network",
            "/api/config",
            {"port": self.port.value(), "preflightProxy": self.preflight.isChecked()},
            callback=callback,
            scope="network",
        )

    def save_enhance(self) -> bool:
        return self.perform(
            "config-enhance",
            "/api/config",
            {
                "enableI18n": self.i18n.isChecked(),
                "enableContextMonitor": self.monitor.isChecked(),
                "autoApplyKernelPatch": self.auto_kernel.isChecked(),
            },
            scope="enhance",
        )

    def check_proxy(self) -> None:
        def check(_=None):
            self.perform("proxy-check", "/api/proxy/check", {}, timeout=60000)

        if "network" in self._dirty:
            self.save_network(callback=check)
        else:
            check()

    def launch(self) -> None:
        def start(_=None):
            self.perform("launch", "/api/launch", {}, timeout=120000)

        if "network" in self._dirty or "enhance" in self._dirty:
            if not self.confirm("保存设置并启动", "将保存当前代理和体验设置，再启动 Antigravity。内核档位的改动需要单独点击「应用内核」。"):
                return
            data = {
                "port": self.port.value(),
                "preflightProxy": self.preflight.isChecked(),
                "enableI18n": self.i18n.isChecked(),
                "enableContextMonitor": self.monitor.isChecked(),
                "autoApplyKernelPatch": self.auto_kernel.isChecked(),
            }

            def saved(_):
                self._dirty.discard("network")
                self._dirty.discard("enhance")
                self._update_dirty_badges()
                start()

            self.perform("config-launch", "/api/config", data, callback=saved)
        else:
            start()

    def confirm(self, title: str, text: str) -> bool:
        return (
            QMessageBox.question(
                self,
                title,
                text,
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            == QMessageBox.StandardButton.Yes
        )

    def apply_kernel(self, checked: bool = False, restore: bool = False) -> None:
        values = (
            {"promptTier": "stock", "contextMode": "stock"}
            if restore
            else {"promptTier": self.tier.currentData(), "contextMode": self.context.currentData()}
        )
        if not restore:
            if values["promptTier"] not in self.VISIBLE_TIERS:
                self.inform("请选择官方原版或精简·防编造，再应用设置。")
                return
            self._dirty.add("kernel")
        if self.confirm(
            "恢复官方内核" if restore else "应用本机内核设置",
            "这会修改本机 Antigravity 的 language_server.exe，首次修改自动创建 .bak 备份。建议先退出 AG。是否继续？",
        ):
            self.perform("kernel-apply", "/api/kernel/apply", values, scope="kernel", timeout=120000)

    # ------------------------------------------------------------------ OAuth & Account Actions
    @staticmethod
    def valid_oauth_url(value: str) -> bool:
        try:
            p = urlsplit(str(value or ""))
            return (
                p.scheme == "https"
                and p.hostname == "accounts.google.com"
                and not (p.username or p.password or p.port)
                and p.path == "/o/oauth2/v2/auth"
            )
        except ValueError:
            return False

    def render_oauth(self, flow: dict | None) -> None:
        url = (flow or {}).get("authUrl", "")
        self.oauth_url.setText(url if self.valid_oauth_url(url) else "")
        self.oauth_box.setVisible(bool(flow))
        if not flow:
            self.callback.clear()

    def open_oauth(self) -> None:
        url = self.oauth_url.text()
        if self.valid_oauth_url(url) and not QDesktopServices.openUrl(QUrl(url)):
            self.inform("系统浏览器未打开，请复制授权链接后手动打开。")

    def copy_oauth(self) -> None:
        url = self.oauth_url.text()
        if self.valid_oauth_url(url):
            QApplication.clipboard().setText(url)
            self.inform("授权链接已复制，请在浏览器中完成登录。")

    def cancel_oauth(self) -> None:
        self.perform("oauth-cancel", "/api/accounts/oauth/cancel", {}, callback=lambda _: self.render_oauth(None))

    def start_oauth(self) -> None:
        def started(data):
            self.render_oauth(data)
            self._update_enabled()
            self.inform("已发起浏览器授权；若浏览器未打开，可使用上方重新打开或复制链接。")

        self.perform("oauth-start", "/api/accounts/oauth/start", {"openBrowser": True}, callback=started)

    def submit_oauth(self) -> None:
        value = self.callback.text().strip()
        if not value:
            self.inform("请粘贴浏览器回调地址。")
            return

        def done(_):
            self.render_oauth(None)
            self.inform("账户授权已完成。")

        self.perform("oauth-submit", "/api/accounts/oauth/submit", {"callbackUrl": value}, callback=done, timeout=60000)

    def select_account(self) -> None:
        a = self.selected_account()
        if a:
            self.perform("account-select", "/api/accounts/select", {"id": a["id"]})

    def switch_account(self) -> None:
        a = self.selected_account()
        if a and self.confirm("切换账户", f"将切换至 {a.get('name') or a.get('email') or a['id']}（{a.get('email') or a['id']}），替换本机客户端凭据，下次启动 Antigravity 时生效。请先保存工作并退出 Antigravity，再确认切换。"):
            self.perform("account-switch", "/api/accounts/switch", {"id": a["id"]}, timeout=120000)

    def refresh_quota(self) -> None:
        a = self.selected_account()
        if a:
            self.perform("account-quota", "/api/accounts/quota", {"id": a["id"]}, timeout=60000)

    def remove_account(self) -> None:
        a = self.selected_account()
        if a and self.confirm("删除账户", f"从本地账户池移除 {a.get('name') or a.get('email') or a['id']}（{a.get('email') or a['id']}）？不会注销 Google 账户。"):
            self.perform("account-remove", "/api/accounts/remove", {"id": a["id"]})

    # ------------------------------------------------------------------ Mobile Remote Actions
    @staticmethod
    def _valid_mobile_open_url(url: str) -> bool:
        try:
            p = urlsplit(str(url or ""))
            return (
                p.scheme in ("http", "https")
                and bool(p.hostname)
                and not (p.username or p.password or p.query or p.fragment)
                and p.path in ("", "/")
                and len(str(url)) <= 600
            )
        except ValueError:
            return False

    def start_mobile(self) -> None:
        def start(_=None):
            mobile = self.snapshot.get("mobile") or {}
            if self.mobile_mode.currentData() == "fixed" and not mobile.get("fixedAuth"):
                self.inform("请先填写并保存 Tunnel Token；已配置本机 YAML 时可直接启动。")
                return
            self.perform("mobile-start", "/api/mobile/start", {}, timeout=135000)

        if "mobile" in self._dirty:
            self.save_mobile(callback=start)
        else:
            start()

    def save_mobile(self, checked: bool = False, callback=None) -> None:
        url = self.fixed_url.text().strip()
        values = {"mode": self.mobile_mode.currentData(), "autoStart": self.mobile_auto.isChecked()}
        if values["mode"] == "fixed":
            try:
                p = urlsplit(url)
                valid = (
                    p.scheme == "https"
                    and bool(p.hostname)
                    and not (p.username or p.password or p.port or p.query or p.fragment)
                    and p.path in ("", "/")
                )
            except ValueError:
                valid = False
            if not valid:
                self.inform("固定域名必须是不含路径、端口或凭据的 HTTPS 地址。")
                return
            values["fixedUrl"] = url
            token = self.tunnel_token.text().strip()
            if token:
                values["tunnelToken"] = token
            elif self._clear_tunnel_token:
                values["clearTunnelToken"] = True

        def saved(data):
            if values["mode"] == "fixed":
                self.tunnel_token.clear()
                self._clear_tunnel_token = False
            self._render_mobile_token_status()
            self._update_enabled()
            if callable(callback):
                callback(data)
            else:
                self.inform("远程设置已保存。")

        return self.perform(
            "mobile-config",
            "/api/mobile/config",
            values,
            scope="mobile",
            callback=saved,
        )

    def stop_mobile(self) -> None:
        if self.confirm("停止远程服务", "手机上的现有连接会断开。是否停止？"):
            self.perform("mobile-stop", "/api/mobile/stop", {}, timeout=30000)

    def copy_mobile(self) -> None:
        if self.mobile_url.text():
            QApplication.clipboard().setText(self.mobile_url.text())
            self.inform("访问地址已复制，PIN 请单独输入。")

    def open_mobile(self) -> None:
        url = self.mobile_url.text().strip()
        if self._valid_mobile_open_url(url):
            QDesktopServices.openUrl(QUrl(url))

    def copy_pin(self) -> None:
        if self.mobile_pin.text():
            QApplication.clipboard().setText(self.mobile_pin.text())
            self.inform("PIN 已复制。")

    def render_qr(self, url: str) -> None:
        if url == self._qr_url and (bool(url) == (not self.mobile_qr_frame.isHidden())):
            return
        self._qr_url = url
        try:
            if not self._valid_mobile_open_url(url):
                self.mobile_qr.clear()
                self.mobile_qr.hide()
                self.mobile_qr_frame.hide()
                self.mobile_qr_placeholder.show()
                return
            qr = qrcode.QRCode(border=3, error_correction=qrcode.constants.ERROR_CORRECT_M)
            qr.add_data(url)
            qr.make(fit=True)
            matrix = qr.get_matrix()
            scale = max(1, 164 // len(matrix))
            pix = QPixmap(len(matrix) * scale, len(matrix) * scale)
            pix.fill(Qt.GlobalColor.white)
            painter = QPainter(pix)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(Qt.GlobalColor.black)
            for row, line in enumerate(matrix):
                for col, on in enumerate(line):
                    if on:
                        painter.drawRect(col * scale, row * scale, scale, scale)
            painter.end()
            self.mobile_qr.setPixmap(pix)
            self.mobile_qr.show()
            self.mobile_qr_placeholder.hide()
            self.mobile_qr_frame.show()
        except (ValueError, TypeError, qrcode.exceptions.DataOverflowError):
            self.mobile_qr.clear()
            self.mobile_qr.hide()
            self.mobile_qr_frame.hide()
            self.mobile_qr_placeholder.show()

    def changeEvent(self, event) -> None:
        if event.type() in (QEvent.Type.WindowDeactivate, QEvent.Type.ActivationChange) and hasattr(self, "reveal_pin"):
            self.reveal_pin.setChecked(False)
        super().changeEvent(event)

    # ------------------------------------------------------------------ Usage Dialog & Logs
    def show_usage(self) -> None:
        usage = self.snapshot.get("tokenUsage") or {}
        lines = []
        for key, title in [("today", "今日"), ("days7", "近 7 天"), ("days30", "近 30 天"), ("all", "累计")]:
            b = usage.get(key) or {}
            lines.append(f"{title}  {short_number(b.get('totalTokens'))} Token / {b.get('requests', 0)} 次请求")
        lines.append(f"会话数  {usage.get('conversationCount', 0)}")
        models = (usage.get("days7") or {}).get("models") or (usage.get("days30") or {}).get("models") or []
        if models:
            lines.append("\n模型用量（近 7 天，缺数据时用近 30 天）")
            for m in models:
                lines.append(str(m.get("name") or "未知模型") + "  " + short_number(m.get("totalTokens")) + " Token")
        QMessageBox.information(self, "本机用量", "\n".join(lines))

    def copy_logs(self) -> None:
        QApplication.clipboard().setText(self.logs.toPlainText())
        self.inform("已复制当前日志。")

    def clear_logs(self) -> None:
        self._cleared_log_keys = getattr(self, "_cleared_log_keys", set()) | {self.log_key(item) for item in self._log_items}
        times = [str(item.get("at") or "") for item in self._log_items if isinstance(item, dict)]
        self._cleared_log_at = max([getattr(self, "_cleared_log_at", "")] + times)
        self._log_items = []
        self.logs.clear()
        self.log_count_label.setText("共 0 条事件")

    @staticmethod
    def log_key(item) -> str:
        return json.dumps(item, sort_keys=True, ensure_ascii=False)

    def set_logs(self, items: list[dict]) -> None:
        cleared = getattr(self, "_cleared_log_keys", set())
        cutoff = getattr(self, "_cleared_log_at", "")
        self._log_items = [
            item for item in items[-120:]
            if self.log_key(item) not in cleared and (not cutoff or str(item.get("at") or "") >= cutoff)
        ]
        self.render_logs()

    @staticmethod
    def log_time(value) -> str:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
        except (ValueError, TypeError):
            return "--:--:--"

    def render_logs(self) -> None:
        query = self.log_filter.text().strip().casefold()
        c = DARK if self.dark else LIGHT
        cat_colors = {
            "PROXY": c["accent"],
            "KERNEL": c["purple"],
            "OAUTH": c["green"],
            "I18N": c["accent2"],
            "MOBILE": c["amber"],
        }
        plain_lines = []
        html_rows = []
        for i in self._log_items:
            cat = str(i.get("category") or "SYSTEM").upper()
            ts = self.log_time(i.get("at"))
            msg = masked_log(str(i.get("message", "")))
            plain = f"{ts}  [{cat}]  {msg}"
            if query and query not in plain.casefold():
                continue
            plain_lines.append(plain)
            badge_color = cat_colors.get(cat, c["muted"])
            safe_msg = html.escape(msg)
            html_rows.append(
                f'<div style="white-space:pre-wrap; margin:2px 0;">'
                f'<span style="color:{c["muted"]};">{html.escape(ts)}</span>  '
                f'<span style="color:{badge_color}; font-weight:700;">[{html.escape(cat)}]</span>  '
                f'<span style="color:{c["text"]};">{safe_msg}</span>'
                f'</div>'
            )

        self.log_count_label.setText(f"共 {len(plain_lines)} 条事件")
        plain_joined = "\n".join(plain_lines)
        if self.logs.toPlainText() == plain_joined and getattr(self, "_last_logs_dark", None) == self.dark:
            return
        self._last_logs_dark = self.dark
        scroll = self.logs.verticalScrollBar()
        bottom, previous = scroll.value() >= scroll.maximum() - 8, scroll.value()
        if html_rows:
            self.logs.setHtml("".join(html_rows))
        else:
            self.logs.clear()
        scroll.setValue(scroll.maximum() if bottom else previous)

    def closeEvent(self, event) -> None:
        if self._closing:
            event.ignore()
            return
        if self._dirty and not self.demo and not self.confirm("关闭工作台", "有尚未保存的设置，关闭会放弃这些改动。是否继续？"):
            event.ignore()
            return
        self._closing = True
        self.tunnel_token.clear()
        self._clear_tunnel_token = False
        self._update_enabled()
        self.hide()
        self.closing.emit()
        event.ignore()
