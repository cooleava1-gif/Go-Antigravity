"""Go-Antigravity Liquid Glass desktop palette, DWM integration, and QSS."""
from __future__ import annotations

import ctypes
import sys
from pathlib import Path

ACCENT_TRANSITION_MS = 160
TRANSITION_MS = ACCENT_TRANSITION_MS
FOCUS_ANIMATION_MS = ACCENT_TRANSITION_MS
CARD_RADIUS_PX = 16
CARD_GAP_PX = 12

PALETTE_KEYS = (
    "bg", "panel", "sidebar", "text", "muted", "border", "accent", "hover",
    "soft", "green", "greenbg", "input", "selected", "primarytext",
)

LIGHT = dict(
    bg="#e7eef8",
    panel="#ffffff",
    sidebar="#f3f7fd",
    text="#0f172a",
    muted="#64748b",
    border="#cfdbe9",
    accent="#0284c7",
    hover="#e4f0fb",
    soft="#eef5fc",
    green="#059669",
    greenbg="#e5f8f1",
    input="#f8fbff",
    selected="#d8ecfc",
    primarytext="#ffffff",
    subtext="#334155",
    amber="#d97706",
    amberbg="#fef6e6",
    red="#e11d48",
    redbg="#fdecef",
    purple="#6d28d9",
    purplebg="#f3efff",
    accent2="#06b6d4",
)

DARK = dict(
    bg="#070b13",
    panel="#131c2c",
    sidebar="#0c121e",
    text="#f1f5f9",
    muted="#8899b0",
    border="#25334a",
    accent="#38bdf8",
    hover="#1b2940",
    soft="#132438",
    green="#34d399",
    greenbg="#11312a",
    input="#090f19",
    selected="#1a3450",
    primarytext="#061622",
    subtext="#cbd5e1",
    amber="#fbbf24",
    amberbg="#2f2411",
    red="#fb7185",
    redbg="#331520",
    purple="#c4b5fd",
    purplebg="#231c3d",
    accent2="#5eead4",
)


def palette(dark: bool = False) -> dict[str, str]:
    return dict(DARK if dark else LIGHT)


def _channels(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _mix(first: str, second: str, amount: float) -> str:
    a, b = _channels(first), _channels(second)
    mixed = tuple(max(0, min(255, int(round(x + (y - x) * amount)))) for x, y in zip(a, b))
    return "#" + "".join(f"{v:02x}" for v in mixed)


def _rgba(value: str, alpha: int) -> str:
    """Return CSS/QSS rgba() with integer alpha 0..255 (never fractional floats)."""
    r, g, b = _channels(value)
    a = max(0, min(255, int(round(alpha))))
    return f"rgba({r},{g},{b},{a})"


def apply_window_glass(window, dark: bool) -> None:
    """Sync Windows 10/11 titlebar and optional Mica/caption tint safely."""
    if sys.platform != "win32":
        return
    try:
        hwnd = int(window.winId())
        if not hwnd:
            return
        dwmapi = ctypes.windll.dwmapi
        use_dark = ctypes.c_int(1 if dark else 0)
        for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE (Win11 / Win10 1903+)
            dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(use_dark), ctypes.sizeof(use_dark))
        # DWMWA_CAPTION_COLOR = 35 expects COLORREF (0x00BBGGRR)
        r, g, b = _channels(DARK["bg"] if dark else LIGHT["bg"])
        colorref = ctypes.c_int((b << 16) | (g << 8) | r)
        dwmapi.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(colorref), ctypes.sizeof(colorref))
        # DWMWA_BORDER_COLOR = 34
        br, bg_c, bb = _channels(DARK["border"] if dark else LIGHT["border"])
        borderref = ctypes.c_int((bb << 16) | (bg_c << 8) | br)
        dwmapi.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(borderref), ctypes.sizeof(borderref))
    except (AttributeError, OSError, ValueError):
        pass


def stylesheet(dark: bool = False) -> str:
    c = palette(dark)
    c.update(
        check=(Path(__file__).parent / "assets/check.svg").as_posix(),
        chevron=(Path(__file__).parent / "assets/chevron.svg").as_posix(),
        radius=f"{CARD_RADIUS_PX}px",
        small_radius="10px",
        pill_radius="12px",
        glass_input=_rgba(c["input"], 165 if dark else 190),
        glass_input_focus=_rgba(c["input"], 220 if dark else 245),
        glass_btn=_rgba("#ffffff", 14 if dark else 155),
        glass_btn_hover=_rgba(c["accent"], 36 if dark else 26),
        glass_btn_press=_rgba(c["accent"], 60 if dark else 45),
        rim=_rgba("#ffffff", 30 if dark else 210),
        rim_border=_rgba("#ffffff", 32 if dark else 160) if dark else _rgba("#94a3b8", 85),
        rim_top=_rgba("#ffffff", 64 if dark else 250),
        accent_soft=_rgba(c["accent"], 38 if dark else 28),
        accent_border=_rgba(c["accent"], 115 if dark else 95),
        accent_hover=_mix(c["accent"], "#ffffff" if dark else "#000000", 0.12),
        accent_press=_mix(c["accent"], "#000000", 0.22),
        green_bg=_rgba(c["green"], 38 if dark else 28),
        green_border=_rgba(c["green"], 95 if dark else 80),
        amber_bg=_rgba(c["amber"], 40 if dark else 28),
        amber_border=_rgba(c["amber"], 100 if dark else 85),
        red_bg=_rgba(c["red"], 40 if dark else 26),
        red_border=_rgba(c["red"], 100 if dark else 85),
        purple_bg=_rgba(c["purple"], 42 if dark else 26),
        purple_border=_rgba(c["purple"], 100 if dark else 80),
        popup_bg=_mix(c["panel"], c["bg"], 0.08) if dark else "#ffffff",
        scroll_thumb=_rgba(c["muted"], 95),
        scroll_hover=_rgba(c["accent"], 150),
        tab_active_bg=_rgba("#ffffff", 24 if dark else 225),
        tab_active_border=_rgba("#ffffff", 54 if dark else 245),
        tab_hover_bg=_rgba("#ffffff", 14 if dark else 135),
        cta_top=c["accent2"] if dark else c["accent"],
        cta_bot=c["accent"] if dark else _mix(c["accent"], "#1d4ed8", 0.35),
        cta_hover_top=_mix(c["accent2"] if dark else c["accent"], "#ffffff", 0.14),
        cta_hover_bot=_mix(c["accent"], "#ffffff" if dark else "#000000", 0.08),
    )
    return """
* {
    font-family: 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    color: %(text)s;
}
QMainWindow {
    background: %(bg)s;
    color: %(text)s;
}
QWidget {
    color: %(text)s;
}
QWidget#GlassCanvas, QWidget#PagesHost, QWidget#ViewRoot, QWidget#CardContent {
    background: transparent;
    border: none;
}
QScrollArea, QScrollArea QWidget, QScrollArea > QWidget > QWidget {
    background: transparent;
    border: none;
}
QLabel {
    background: transparent;
    border: none;
}
QLabel#Brand {
    font-size: 13px;
    font-weight: 700;
    color: %(text)s;
}
QLabel#PageTitle, QLabel#Title, QLabel#HeroTitle {
    font-size: 14px;
    font-weight: 700;
    color: %(text)s;
}
QLabel#Section {
    font-size: 13px;
    font-weight: 700;
    color: %(text)s;
}
QLabel#Muted {
    color: %(muted)s;
    font-size: 12px;
}
QLabel#Small {
    color: %(muted)s;
    font-size: 12px;
}
QLabel#Sub {
    color: %(subtext)s;
    font-size: 12px;
}
QLabel#Metric {
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-size: 18px;
    font-weight: 700;
    color: %(text)s;
}
QLabel#MetricAccent {
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-size: 18px;
    font-weight: 700;
    color: %(accent)s;
}
QLabel#MonoLabel {
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-size: 12px;
    color: %(text)s;
}
QLabel#MonoMuted {
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-size: 11px;
    color: %(muted)s;
}
QLabel#Badge, QLabel#PillInfo {
    color: %(accent)s;
    background: %(accent_soft)s;
    border: 1px solid %(accent_border)s;
    padding: 2px 9px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#Success, QLabel#PillGreen {
    color: %(green)s;
    background: %(green_bg)s;
    border: 1px solid %(green_border)s;
    padding: 2px 9px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#PillAmber {
    color: %(amber)s;
    background: %(amber_bg)s;
    border: 1px solid %(amber_border)s;
    padding: 2px 9px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#PillRed {
    color: %(red)s;
    background: %(red_bg)s;
    border: 1px solid %(red_border)s;
    padding: 2px 9px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#PillPurple {
    color: %(purple)s;
    background: %(purple_bg)s;
    border: 1px solid %(purple_border)s;
    padding: 2px 8px;
    border-radius: 9px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#PillMuted {
    color: %(muted)s;
    background: %(glass_btn)s;
    border: 1px solid %(rim_border)s;
    padding: 2px 8px;
    border-radius: 9px;
    font-size: 11px;
    font-weight: 600;
}
QLabel#AvatarBadge {
    background: %(accent_soft)s;
    color: %(accent)s;
    border: 1px solid %(accent_border)s;
    border-radius: 11px;
    font-size: 13px;
    font-weight: 700;
}
QLabel#AvatarBadgeDanger {
    background: %(red_bg)s;
    color: %(red)s;
    border: 1px solid %(red_border)s;
    border-radius: 11px;
    font-size: 13px;
    font-weight: 700;
}
QLabel#Notice {
    background: %(soft)s;
    color: %(text)s;
    padding: 8px 14px;
    border: 1px solid %(accent_border)s;
    border-radius: 12px;
    font-size: 12px;
}
QLabel#DividerDot {
    color: %(rim_border)s;
    font-size: 12px;
}
QFrame#Divider {
    background: %(rim_border)s;
    border: none;
    min-height: 1px;
    max-height: 1px;
}
QFrame#DiagnosticBox, QFrame#MetricTile {
    background: %(glass_input)s;
    border: 1px solid %(rim_border)s;
    border-radius: 12px;
}
QFrame#SubtleTile {
    background: %(glass_btn)s;
    border: 1px solid %(rim_border)s;
    border-radius: 12px;
}

/* Buttons */
QPushButton {
    background: %(glass_btn)s;
    color: %(text)s;
    border: 1px solid %(rim_border)s;
    border-top: 1px solid %(rim_top)s;
    border-radius: 14px;
    padding: 5px 12px;
    min-height: 20px;
    font-weight: 600;
}
QPushButton:hover {
    background: %(glass_btn_hover)s;
    border-color: %(accent_border)s;
    color: %(text)s;
}
QPushButton:pressed {
    background: %(glass_btn_press)s;
    border-color: %(accent)s;
}
QPushButton:focus {
    border-color: %(accent)s;
}
QPushButton:disabled {
    color: %(muted)s;
    background: %(glass_input)s;
    border-color: %(rim_border)s;
}
QPushButton#Primary {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 %(cta_top)s, stop:1 %(cta_bot)s);
    color: %(primarytext)s;
    border: 1px solid %(rim_top)s;
    border-radius: 15px;
    font-weight: 700;
    padding: 6px 16px;
}
QPushButton#Primary:hover {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 %(cta_hover_top)s, stop:1 %(cta_hover_bot)s);
    color: %(primarytext)s;
}
QPushButton#Primary:pressed {
    background: %(accent_press)s;
    color: %(primarytext)s;
}
QPushButton#Primary:disabled {
    background: %(glass_btn)s;
    color: %(muted)s;
    border: 1px solid %(rim_border)s;
}
QPushButton#Primary[running="true"] {
    background: %(green_bg)s;
    color: %(green)s;
    border: 1px solid %(green_border)s;
}
QPushButton#AccentSoft {
    background: %(accent_soft)s;
    color: %(accent)s;
    border: 1px solid %(accent_border)s;
    border-radius: 14px;
    font-weight: 600;
    padding: 5px 13px;
}
QPushButton#AccentSoft:hover {
    background: %(glass_btn_press)s;
}
QPushButton#AccentSoft:disabled {
    color: %(muted)s;
    background: %(glass_input)s;
    border-color: %(rim_border)s;
}
QPushButton#DangerSoft {
    background: %(red_bg)s;
    color: %(red)s;
    border: 1px solid %(red_border)s;
    border-radius: 14px;
    font-weight: 600;
    padding: 5px 12px;
}
QPushButton#DangerSoft:hover {
    border-color: %(red)s;
}
QPushButton#DangerSoft:disabled {
    color: %(muted)s;
    background: %(glass_input)s;
    border-color: %(rim_border)s;
}
QPushButton#Quiet, QPushButton#IconPill {
    background: transparent;
    border: 1px solid transparent;
    color: %(subtext)s;
    border-radius: 14px;
    padding: 5px 9px;
}
QPushButton#Quiet:hover, QPushButton#IconPill:hover {
    background: %(glass_btn_hover)s;
    border-color: %(accent_border)s;
    color: %(text)s;
}
QPushButton#IconPill {
    background: %(glass_btn)s;
    border: 1px solid %(rim_border)s;
    border-top: 1px solid %(rim_top)s;
}
QPushButton#Chip {
    background: %(glass_btn)s;
    color: %(subtext)s;
    border: 1px solid %(rim_border)s;
    border-radius: 11px;
    padding: 3px 9px;
    min-height: 16px;
    font-size: 11px;
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-weight: 600;
}
QPushButton#Chip:hover {
    background: %(glass_btn_hover)s;
    border-color: %(accent_border)s;
    color: %(text)s;
}
QPushButton#Chip[active="true"] {
    background: %(accent_soft)s;
    color: %(accent)s;
    border: 1px solid %(accent_border)s;
}
QPushButton#SegmentBtn {
    background: transparent;
    color: %(subtext)s;
    border: 1px solid transparent;
    border-radius: 12px;
    padding: 5px 11px;
    min-height: 18px;
    font-weight: 600;
}
QPushButton#SegmentBtn:hover {
    background: %(tab_hover_bg)s;
    color: %(text)s;
}
QPushButton#SegmentBtn:checked {
    background: %(tab_active_bg)s;
    color: %(accent)s;
    border: 1px solid %(rim_border)s;
    border-top: 1px solid %(tab_active_border)s;
    font-weight: 700;
}
QPushButton#NavPill {
    background: transparent;
    color: %(subtext)s;
    border: 1px solid transparent;
    border-radius: 15px;
    padding: 6px 13px;
    min-height: 20px;
    font-weight: 600;
}
QPushButton#NavPill:hover {
    background: %(tab_hover_bg)s;
    color: %(text)s;
}
QPushButton#NavPill:checked {
    background: %(tab_active_bg)s;
    color: %(text)s;
    border: 1px solid %(rim_border)s;
    border-top: 1px solid %(tab_active_border)s;
    font-weight: 700;
}
QPushButton#AccountChip {
    background: %(glass_btn)s;
    border: 1px solid %(rim_border)s;
    border-top: 1px solid %(rim_top)s;
    border-radius: 15px;
    padding: 4px 11px;
    min-height: 20px;
    font-weight: 600;
}
QPushButton#AccountChip:hover {
    background: %(glass_btn_hover)s;
    border-color: %(accent_border)s;
}

/* Inputs */
QLineEdit, QSpinBox, QComboBox, QPlainTextEdit, QTextEdit {
    background: %(glass_input)s;
    color: %(text)s;
    border: 1px solid %(rim_border)s;
    border-radius: 11px;
    padding: 5px 10px;
    min-height: 20px;
    selection-background-color: %(selected)s;
}
QLineEdit:hover, QSpinBox:hover, QComboBox:hover, QPlainTextEdit:hover, QTextEdit:hover {
    border-color: %(accent_border)s;
}
QLineEdit:focus, QSpinBox:focus, QComboBox:focus, QPlainTextEdit:focus, QTextEdit:focus {
    background: %(glass_input_focus)s;
    border: 1px solid %(accent)s;
}
QLineEdit:disabled, QSpinBox:disabled, QComboBox:disabled {
    color: %(muted)s;
    background: %(glass_input)s;
    border-color: %(rim_border)s;
}
QSpinBox {
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-weight: 700;
    padding-right: 22px;
}
QSpinBox::up-button, QSpinBox::down-button {
    width: 16px;
    border: none;
    background: transparent;
}
QComboBox {
    padding-right: 24px;
}
QComboBox::drop-down {
    subcontrol-origin: padding;
    subcontrol-position: top right;
    width: 22px;
    border: 0;
    background: transparent;
}
QComboBox::down-arrow {
    image: url("%(chevron)s");
    width: 12px;
    height: 12px;
}
QComboBox QAbstractItemView {
    background: %(popup_bg)s;
    color: %(text)s;
    selection-background-color: %(selected)s;
    border: 1px solid %(border)s;
    border-radius: 10px;
    padding: 4px;
}
QComboBox QAbstractItemView::item {
    min-height: 24px;
    padding: 4px 8px;
    border-radius: 6px;
}
QComboBox QAbstractItemView::item:selected {
    background: %(accent_soft)s;
    color: %(text)s;
}

/* Scrollbars */
QScrollBar:vertical {
    background: transparent;
    width: 7px;
    margin: 2px;
    border: none;
}
QScrollBar::handle:vertical {
    background: %(scroll_thumb)s;
    min-height: 28px;
    border-radius: 3px;
}
QScrollBar::handle:vertical:hover {
    background: %(scroll_hover)s;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical,
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
    height: 0;
    border: none;
    background: none;
}
QScrollBar:horizontal {
    background: transparent;
    height: 7px;
    margin: 2px;
    border: none;
}
QScrollBar::handle:horizontal {
    background: %(scroll_thumb)s;
    min-width: 28px;
    border-radius: 3px;
}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal,
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {
    width: 0;
    border: none;
    background: none;
}

/* Dialogs, Menus, Tooltips */
QToolTip {
    background: %(popup_bg)s;
    color: %(text)s;
    border: 1px solid %(border)s;
    border-radius: 8px;
    padding: 6px 9px;
    font-size: 11px;
}
QDialog, QMessageBox {
    background: %(popup_bg)s;
    border: 1px solid %(border)s;
    border-radius: 14px;
}
QMenu {
    background: %(popup_bg)s;
    border: 1px solid %(border)s;
    border-radius: 10px;
    padding: 4px;
}
QMenu::item {
    padding: 6px 14px;
    border-radius: 6px;
}
QMenu::item:selected {
    background: %(accent_soft)s;
    color: %(text)s;
}
QMenu::item:disabled {
    color: %(muted)s;
}
QMenu::separator {
    height: 1px;
    background: %(border)s;
    margin: 4px 6px;
}
""" % c
