"""Reusable Liquid Glass widgets and crisp monochrome SVG icons for Go-Antigravity."""
from __future__ import annotations

from typing import Any
from PyQt6.QtCore import Qt, QRectF, QSize, pyqtSignal, QByteArray
from PyQt6.QtGui import (
    QColor, QFont, QFontMetrics, QIcon, QLinearGradient, QPainter, QPainterPath,
    QPen, QPixmap, QRadialGradient,
)
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QButtonGroup, QCheckBox, QFrame, QGridLayout, QHBoxLayout, QLabel, QPushButton,
    QSizePolicy, QStyle, QStyleOptionFrame, QStylePainter, QVBoxLayout, QWidget,
)
from theme import DARK, LIGHT, _channels

ICONS = {
    "workbench": '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="3.5"/>',
    "accounts": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    "mobile": '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 18h4"/>',
    "logs": '<path d="m5 7 5 5-5 5M12 17h7"/>',
    "overview": '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    "globe": '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    "cpu": '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
    "pulse": '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    "play": '<polygon points="7 4 20 12 7 20 7 4" fill="currentColor" stroke="none"/>',
    "refresh": '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    "moon": '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    "external": '<path d="M14 3h7v7M21 3 10 14M10 5H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "copy": '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "trash": '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    "qr": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM17 17h4v4h-4zM14 20h2"/>',
}


def svg_icon(name: str, color: str = "#8899b0", size: int = 16) -> QIcon:
    body = ICONS.get(name, ICONS["overview"]).replace("currentColor", color)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
        f'stroke="{color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{body}</svg>'
    )
    pix = QPixmap(size * 2, size * 2)
    pix.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pix)
    QSvgRenderer(QByteArray(svg.encode("utf-8"))).render(painter)
    painter.end()
    pix.setDevicePixelRatio(2)
    return QIcon(pix)


def _qcolor(hex_str: str, alpha: int = 255) -> QColor:
    r, g, b = _channels(hex_str)
    return QColor(r, g, b, max(0, min(255, alpha)))


class ElidedLabel(QLabel):
    """Single-line plain-text label that can shrink without losing its value."""

    def __init__(self, text: str = "", parent: QWidget | None = None):
        super().__init__(parent)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        self.setMinimumWidth(0)
        self.setText(text)

    def setText(self, text: str) -> None:
        super().setText(text)
        self.setToolTip(text)

    def minimumSizeHint(self) -> QSize:
        hint = super().minimumSizeHint()
        return QSize(0, hint.height())

    def paintEvent(self, event) -> None:
        rect = self.contentsRect().adjusted(self.margin(), self.margin(), -self.margin(), -self.margin())
        indent = self.indent()
        if indent < 0:
            indent = self.fontMetrics().horizontalAdvance("x") // 2 if self.frameWidth() else 0
        if self.alignment() & Qt.AlignmentFlag.AlignLeft:
            rect.adjust(indent, 0, 0, 0)
        elif self.alignment() & Qt.AlignmentFlag.AlignRight:
            rect.adjust(0, 0, -indent, 0)
        text = self.fontMetrics().elidedText(self.text(), Qt.TextElideMode.ElideRight, max(0, rect.width()))
        if text == self.text():
            super().paintEvent(event)
            return
        painter = QStylePainter(self)
        option = QStyleOptionFrame()
        self.initStyleOption(option)
        painter.drawControl(QStyle.ControlElement.CE_ShapedFrame, option)
        self.style().drawItemText(painter, rect, int(self.alignment()) | int(Qt.TextFlag.TextSingleLine),
                                  self.palette(), self.isEnabled(), text, self.foregroundRole())


class GlassCanvas(QWidget):
    """Ambient Liquid Glass backdrop canvas painting soft glowing orbs behind glass cards."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("GlassCanvas")
        self._dark = True

    def set_dark(self, dark: bool) -> None:
        self._dark = dark
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = self.rect()
        w, h = max(1, rect.width()), max(1, rect.height())

        base = QLinearGradient(0, 0, w, h)
        if self._dark:
            base.setColorAt(0.0, QColor("#060a12"))
            base.setColorAt(0.55, QColor("#09101d"))
            base.setColorAt(1.0, QColor("#070d17"))
        else:
            base.setColorAt(0.0, QColor("#dfe9f6"))
            base.setColorAt(0.55, QColor("#eaf1fa"))
            base.setColorAt(1.0, QColor("#e3eef8"))
        painter.fillRect(rect, base)

        orbs = (
            [
                (w * 0.16, h * 0.08, w * 0.36, QColor(14, 165, 233, 62)),
                (w * 0.86, h * 0.24, w * 0.34, QColor(99, 102, 241, 48)),
                (w * 0.48, h * 0.96, w * 0.38, QColor(45, 212, 191, 42)),
            ]
            if self._dark
            else [
                (w * 0.14, h * 0.08, w * 0.36, QColor(56, 189, 248, 72)),
                (w * 0.86, h * 0.22, w * 0.34, QColor(167, 139, 250, 56)),
                (w * 0.46, h * 0.96, w * 0.38, QColor(45, 212, 191, 56)),
            ]
        )
        for cx, cy, radius, color in orbs:
            grad = QRadialGradient(cx, cy, radius)
            grad.setColorAt(0.0, color)
            grad.setColorAt(1.0, QColor(color.red(), color.green(), color.blue(), 0))
            painter.fillRect(rect, grad)


class GlassCard(QFrame):
    """Translucent glass container with specular sheen and top refractive rim."""

    def __init__(self, variant: str = "default", radius: int = 16, parent: QWidget | None = None):
        super().__init__(parent)
        self._variant = variant
        self._radius = radius
        self._dark = True
        self.setObjectName("GlassCard")
        self.setAutoFillBackground(False)

    def set_dark(self, dark: bool) -> None:
        self._dark = dark
        self.update()

    def set_variant(self, variant: str) -> None:
        if self._variant != variant:
            self._variant = variant
            self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        if r.width() <= 2 or r.height() <= 2:
            return
        rad = min(self._radius, r.height() / 2.0, r.width() / 2.0) if self._variant == "track" else self._radius
        path = QPainterPath()
        path.addRoundedRect(r, rad, rad)
        painter.setClipPath(path)

        dark = self._dark
        if self._variant == "topbar":
            fill = QColor(13, 20, 34, 165) if dark else QColor(255, 255, 255, 165)
            painter.fillPath(path, fill)
            painter.setClipping(False)
            pen = QPen(QColor(255, 255, 255, 32) if dark else QColor(148, 163, 184, 70), 1.0)
            painter.setPen(pen)
            painter.drawLine(int(r.left()), int(r.bottom()), int(r.right()), int(r.bottom()))
            return

        if self._variant == "track":
            fill = QColor(7, 11, 19, 130) if dark else QColor(222, 232, 245, 175)
            painter.fillPath(path, fill)
            painter.setClipping(False)
            border = QColor(255, 255, 255, 22) if dark else QColor(148, 163, 184, 75)
            painter.setPen(QPen(border, 1.0))
            painter.drawRoundedRect(r, rad, rad)
            return

        if self._variant == "subtle":
            fill = QColor(255, 255, 255, 13) if dark else QColor(255, 255, 255, 145)
            painter.fillPath(path, fill)
        else:
            grad = QLinearGradient(r.topLeft(), r.bottomRight())
            if dark:
                grad.setColorAt(0.0, QColor(255, 255, 255, 26))
                grad.setColorAt(0.45, QColor(24, 35, 55, 148))
                grad.setColorAt(1.0, QColor(14, 22, 36, 175))
            else:
                grad.setColorAt(0.0, QColor(255, 255, 255, 232))
                grad.setColorAt(0.55, QColor(255, 255, 255, 168))
                grad.setColorAt(1.0, QColor(240, 247, 255, 188))
            painter.fillPath(path, grad)

            sheen = QRadialGradient(r.left() + r.width() * 0.12, r.top(), max(r.width(), r.height()) * 0.72)
            sheen.setColorAt(0.0, QColor(255, 255, 255, 26 if dark else 140))
            sheen.setColorAt(1.0, QColor(255, 255, 255, 0))
            painter.fillPath(path, sheen)

        painter.setClipping(False)
        if self._variant == "accent":
            border_color = QColor(56, 189, 248, 125) if dark else QColor(2, 132, 199, 105)
        elif self._variant == "danger":
            border_color = QColor(251, 113, 133, 115) if dark else QColor(225, 29, 72, 95)
        else:
            border_color = QColor(255, 255, 255, 30) if dark else QColor(148, 163, 184, 72)

        painter.setPen(QPen(border_color, 1.0))
        painter.drawRoundedRect(r, rad, rad)

        # Specular top rim refraction
        top_rim = QLinearGradient(r.left() + rad, r.top(), r.right() - rad, r.top())
        rim_alpha = 72 if dark else 245
        top_rim.setColorAt(0.0, QColor(255, 255, 255, 12 if dark else 90))
        top_rim.setColorAt(0.25, QColor(255, 255, 255, rim_alpha))
        top_rim.setColorAt(0.75, QColor(255, 255, 255, rim_alpha))
        top_rim.setColorAt(1.0, QColor(255, 255, 255, 12 if dark else 90))
        painter.setPen(QPen(top_rim, 1.0))
        painter.drawLine(int(r.left() + rad), int(r.top()), int(r.right() - rad), int(r.top()))


class ToggleSwitch(QCheckBox):
    """Liquid Glass pill switch compatible with QCheckBox APIs."""

    def __init__(self, text: str = "", parent: QWidget | None = None):
        super().__init__(text, parent)
        self._dark = True
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def set_dark(self, dark: bool) -> None:
        self._dark = dark
        self.update()

    def sizeHint(self) -> QSize:
        if not self.text():
            return QSize(38, 22)
        fm = self.fontMetrics()
        return QSize(38 + 10 + fm.horizontalAdvance(self.text()) + 4, max(24, fm.height() + 4))

    def minimumSizeHint(self) -> QSize:
        return self.sizeHint()

    def hitButton(self, pos) -> bool:
        return self.rect().contains(pos)

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        c = DARK if self._dark else LIGHT
        checked = self.isChecked()
        enabled = self.isEnabled()

        sw_w, sw_h = 36.0, 20.0
        y = (self.height() - sw_h) / 2.0
        x = 1.0
        track = QRectF(x, y, sw_w, sw_h)

        if checked:
            grad = QLinearGradient(track.topLeft(), track.bottomRight())
            if self._dark:
                grad.setColorAt(0.0, _qcolor(c["accent2"], 230 if enabled else 110))
                grad.setColorAt(1.0, _qcolor(c["accent"], 230 if enabled else 110))
            else:
                grad.setColorAt(0.0, _qcolor("#0ea5e9", 235 if enabled else 110))
                grad.setColorAt(1.0, _qcolor("#2563eb", 230 if enabled else 110))
            painter.setBrush(grad)
            painter.setPen(QPen(QColor(255, 255, 255, 110 if enabled else 40), 1.0))
        else:
            bg = QColor(7, 11, 19, 145) if self._dark else QColor(203, 213, 225, 180)
            border = QColor(255, 255, 255, 38) if self._dark else QColor(148, 163, 184, 120)
            painter.setBrush(bg)
            painter.setPen(QPen(border, 1.0))

        painter.drawRoundedRect(track, sw_h / 2.0, sw_h / 2.0)

        knob_d = 14.0
        kx = (x + sw_w - knob_d - 3.0) if checked else (x + 3.0)
        ky = y + (sw_h - knob_d) / 2.0
        knob_color = QColor(255, 255, 255, 245 if enabled else 150) if checked else (
            QColor(148, 163, 184, 210 if enabled else 110) if self._dark else QColor(255, 255, 255, 235 if enabled else 140)
        )
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(knob_color)
        painter.drawEllipse(QRectF(kx, ky, knob_d, knob_d))

        if self.text():
            text_color = _qcolor(c["text"] if enabled else c["muted"])
            painter.setPen(text_color)
            text_rect = QRectF(x + sw_w + 8, 0, max(0, self.width() - (x + sw_w + 8)), self.height())
            painter.drawText(text_rect, Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self.text())


class SegmentedControl(GlassCard):
    """Liquid Glass segmented pill selector with QComboBox-compatible helpers."""

    currentIndexChanged = pyqtSignal(int)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(variant="track", radius=14, parent=parent)
        self._items: list[tuple[str, Any]] = []
        self._buttons: list[QPushButton] = []
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._group.idClicked.connect(self._on_clicked)
        self._layout = QHBoxLayout(self)
        self._layout.setContentsMargins(3, 3, 3, 3)
        self._layout.setSpacing(3)

    def addItem(self, text: str, data: Any = None, tooltip: str = "") -> None:
        idx = len(self._items)
        self._items.append((text, data))
        btn = QPushButton(text)
        btn.setObjectName("SegmentBtn")
        btn.setCheckable(True)
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn.setMinimumWidth(0)
        if tooltip:
            btn.setToolTip(tooltip)
        if idx == 0:
            btn.setChecked(True)
        self._group.addButton(btn, idx)
        self._buttons.append(btn)
        self._layout.addWidget(btn, 1)

    def _on_clicked(self, idx: int) -> None:
        self.currentIndexChanged.emit(idx)

    def currentIndex(self) -> int:
        return self._group.checkedId()

    def currentData(self) -> Any:
        idx = self.currentIndex()
        return self._items[idx][1] if 0 <= idx < len(self._items) else None

    def findData(self, value: Any) -> int:
        for idx, (_, data) in enumerate(self._items):
            if data == value:
                return idx
        return -1

    def setCurrentIndex(self, idx: int) -> None:
        if 0 <= idx < len(self._buttons):
            was_checked = self._buttons[idx].isChecked()
            self._buttons[idx].setChecked(True)
            if not was_checked and not self.signalsBlocked():
                self.currentIndexChanged.emit(idx)

    def setEnabled(self, enabled: bool) -> None:
        super().setEnabled(enabled)
        for btn in self._buttons:
            btn.setEnabled(enabled)


def _short_quota_label(label: str) -> str:
    text = str(label or "模型")
    mapping = {
        "Gemini 4 Argon (周限)": "Argon 周",
        "Gemini 3.8 (5h)": "Gemini 5h",
        "Claude (5h)": "Claude 5h",
        "Claude (周限)": "Claude 周",
        "Gemini (周限)": "Gemini 周",
    }
    if text in mapping:
        return mapping[text]
    return text.replace(" (", " ").rstrip(")")


# Mirror the backend's exact shared-bucket aliases for pre-quotaKey cached snapshots.
_QUOTA_ALIASES = {
    "claude": ("claude", "5h"), "3p-5h": ("claude", "5h"), "claude:5h": ("claude", "5h"),
    "3p-weekly": ("claude", "weekly"), "claude:weekly": ("claude", "weekly"),
    "gemini": ("gemini", "5h"), "gemini-5h": ("gemini", "5h"), "gemini:5h": ("gemini", "5h"),
    "gemini-weekly": ("gemini", "weekly"), "gemini:weekly": ("gemini", "weekly"),
    "gemini-argon": ("gemini-argon", "weekly"),
    "gemini-argon-wtu-weekly": ("gemini-argon", "weekly"), "gemini-argon:weekly": ("gemini-argon", "weekly"),
}


def _quota_identity(item: dict[str, Any]) -> str:
    quota_key = item.get("quotaKey")
    if isinstance(quota_key, str) and quota_key.strip():
        return quota_key.strip()
    key = str(item.get("key") or item.get("id") or item.get("bucketId") or item.get("label") or "").strip()
    if not key:
        return ""
    family, default_window = _QUOTA_ALIASES.get(key.lower(), (key, ""))
    window = str(item.get("window") or default_window).strip().lower()
    return family + ":" + window


def _quota_entries(quota: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    positions: dict[str, int] = {}
    for source in ("models", "windows"):
        items = quota.get(source)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            key = _quota_identity(item)
            if not key:
                continue
            if key in positions:
                index = positions[key]
                previous = entries[index]
                # A real window is more useful than an unavailable model placeholder.
                if (previous.get("disabled") or previous.get("percentage") is None) and not item.get("disabled") and item.get("percentage") is not None:
                    entries[index] = item
                continue
            positions[key] = len(entries)
            entries.append(item)
    return entries


class QuotaBarWidget(QWidget):
    """Inline horizontal model quota progress pill."""

    def __init__(self, label: str, percentage: float | None, reset_text: str = "", disabled: bool = False, parent: QWidget | None = None):
        super().__init__(parent)
        self._full_label = str(label or "模型")
        self._label = _short_quota_label(self._full_label)
        self._pct = None if percentage is None else max(0.0, min(100.0, float(percentage)))
        self._reset = reset_text
        self._disabled = disabled
        self._dark = True
        self.setMinimumHeight(30)
        self.setMaximumHeight(34)
        self.setToolTip(f"{self._full_label}：{f'{self._pct:.0f}%' if self._pct is not None else '未开放'}" + (f" ({self._reset})" if self._reset else ""))

    def set_dark(self, dark: bool) -> None:
        self._dark = dark
        self.update()

    def _text_layout(self, label_metrics: QFontMetrics, value_metrics: QFontMetrics) -> tuple[QRectF, QRectF, str, str]:
        if self._disabled or self._pct is None:
            value_text = self._reset or "未开放"
        else:
            value_text = f"{self._pct:.0f}%" + (f" · {self._reset}" if self._reset else "")
        width = float(self.width())
        gap = min(6.0, width)
        # Qt elision can need one extra pixel after integer font-metric rounding.
        label_reserve = min(float(label_metrics.horizontalAdvance(self._label) + 1), width * 0.45)
        value_width = min(float(value_metrics.horizontalAdvance(value_text) + 1), max(0.0, width - gap - label_reserve))
        label_width = max(0.0, width - value_width - gap)
        label_rect = QRectF(0, 0, label_width, 16)
        value_rect = QRectF(width - value_width, 0, value_width, 16)
        label_text = label_metrics.elidedText(self._label, Qt.TextElideMode.ElideRight, int(label_width))
        value_text = value_metrics.elidedText(value_text, Qt.TextElideMode.ElideRight, int(value_width))
        return label_rect, value_rect, label_text, value_text

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        c = DARK if self._dark else LIGHT
        w = self.width()

        if self._disabled or self._pct is None:
            bar_color = _qcolor(c["muted"])
            pct_val = 0.0
        else:
            pct_val = self._pct
            bar_color = _qcolor(c["red"] if pct_val <= 0 else c["amber"] if pct_val < 25 else c["green"])

        font = QFont(self.font())
        font.setPointSize(9)
        mono = QFont("Cascadia Mono", 9)
        mono.setBold(True)

        label_rect, value_rect, left_text, value_text = self._text_layout(QFontMetrics(font), QFontMetrics(mono))

        painter.setFont(font)
        painter.setPen(_qcolor(c["subtext"]))
        painter.drawText(label_rect, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, left_text)

        painter.setFont(mono)
        painter.setPen(bar_color)
        painter.drawText(value_rect, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, value_text)

        track = QRectF(0, 20, max(12.0, float(w)), 6.0)
        track_bg = QColor(7, 11, 19, 130) if self._dark else QColor(203, 213, 225, 165)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(track_bg)
        painter.drawRoundedRect(track, 3.0, 3.0)

        if pct_val > 0:
            fill_w = max(6.0, track.width() * (pct_val / 100.0))
            fill = QRectF(track.left(), track.top(), fill_w, track.height())
            painter.setBrush(bar_color)
            painter.drawRoundedRect(fill, 3.0, 3.0)


class ModelDistributionBar(QWidget):
    """Stacked horizontal color bar showing token distribution across model families."""

    COLORS = ("#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185")

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._items: list[tuple[str, float]] = []
        self._dark = True
        self.setFixedHeight(8)

    def set_dark(self, dark: bool) -> None:
        self._dark = dark
        self.update()

    def set_items(self, items: list[tuple[str, float]]) -> None:
        self._items = [(name, max(0.0, float(val))) for name, val in items if float(val or 0) > 0]
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(0, 0, max(12.0, float(self.width())), 8.0)
        track = QColor(7, 11, 19, 135) if self._dark else QColor(203, 213, 225, 165)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(track)
        painter.drawRoundedRect(r, 4.0, 4.0)
        total = sum(v for _, v in self._items)
        if total <= 0:
            return
        path = QPainterPath()
        path.addRoundedRect(r, 4.0, 4.0)
        painter.setClipPath(path)
        x = r.left()
        for idx, (_, val) in enumerate(self._items):
            seg_w = r.width() * (val / total)
            painter.setBrush(_qcolor(self.COLORS[idx % len(self.COLORS)]))
            painter.drawRect(QRectF(x, r.top(), seg_w, r.height()))
            x += seg_w


class AccountCardWidget(GlassCard):
    """Horizontal high-density account card with inline quota progress bars and actions."""

    clicked = pyqtSignal(str)
    action_triggered = pyqtSignal(str, str)

    def __init__(self, account: dict[str, Any], active_id: str | None, selected: bool, busy: bool, online: bool, dark: bool, parent: QWidget | None = None):
        self._account_id = str(account.get("id") or "")
        expired = account.get("status") == "expired" or bool(account.get("locked"))
        variant = "danger" if expired else ("accent" if selected else "default")
        super().__init__(variant=variant, radius=15, parent=parent)
        self._dark = dark
        self._quota_bars: list[QuotaBarWidget] = []
        self._action_buttons: list[tuple[QPushButton, bool]] = []
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        root = QVBoxLayout(self)
        root.setContentsMargins(13, 11, 13, 11)
        root.setSpacing(8)

        # Top Row: Identity + Status Badges + Quick Action Pills
        top = QHBoxLayout()
        top.setSpacing(9)

        name = str(account.get("name") or account.get("email") or "未命名账户")
        email = str(account.get("email") or "")
        avatar = QLabel(name[:1].upper())
        avatar.setObjectName("AvatarBadgeDanger" if expired else "AvatarBadge")
        avatar.setFixedSize(32, 32)
        avatar.setAlignment(Qt.AlignmentFlag.AlignCenter)
        top.addWidget(avatar)

        info_col = QVBoxLayout()
        info_col.setSpacing(2)

        badge_row = QHBoxLayout()
        badge_row.setSpacing(6)
        name_lbl = ElidedLabel(name)
        name_lbl.setObjectName("Section")
        badge_row.addWidget(name_lbl)

        tier = str(account.get("tier") or "").upper()
        if tier and tier != "UNKNOWN":
            tier_lbl = QLabel(tier)
            tier_lbl.setObjectName("PillPurple" if tier == "PRO" else "PillAmber" if tier == "ULTRA" else "PillMuted")
            badge_row.addWidget(tier_lbl)

        is_live = bool(account.get("isLive"))
        is_active = self._account_id == active_id
        if account.get("locked"):
            st_text, st_role = "凭据已锁定", "PillRed"
        elif account.get("status") == "expired":
            st_text, st_role = "令牌失效", "PillRed"
        elif is_live:
            st_text, st_role = "当前生效", "PillGreen"
        elif is_active:
            st_text, st_role = "启动账户", "PillInfo"
        elif account.get("status") == "pending":
            st_text, st_role = "待校验", "PillAmber"
        else:
            st_text, st_role = "已保存", "PillMuted"

        status_lbl = QLabel(st_text)
        status_lbl.setObjectName(st_role)
        badge_row.addWidget(status_lbl)
        badge_row.addStretch(1)
        info_col.addLayout(badge_row)

        sub_parts = []
        if email and email != name:
            sub_parts.append(email)
        switched = account.get("lastSwitchedAt")
        if switched:
            from datetime import datetime
            try:
                sub_parts.append("切换于 " + datetime.fromtimestamp(float(switched) / 1000).strftime("%m-%d %H:%M"))
            except (ValueError, TypeError, OSError):
                pass
        sub_lbl = ElidedLabel(" · ".join(sub_parts) or "本地已保存账户")
        sub_lbl.setObjectName("MonoMuted")
        info_col.addWidget(sub_lbl)
        top.addLayout(info_col, 1)

        # Single primary card action; secondary actions live in the right selected-account panel
        actions = QHBoxLayout()
        actions.setSpacing(6)
        locked = bool(account.get("locked"))
        if expired:
            reauth_btn = QPushButton("重新授权")
            reauth_btn.setObjectName("DangerSoft")
            reauth_btn.setCursor(Qt.CursorShape.PointingHandCursor)
            self._action_buttons.append((reauth_btn, True))
            reauth_btn.clicked.connect(lambda: self.action_triggered.emit("reauth", self._account_id))
            actions.addWidget(reauth_btn)
        else:
            sw_btn = QPushButton("切换账户")
            sw_btn.setObjectName("AccentSoft")
            sw_btn.setCursor(Qt.CursorShape.PointingHandCursor)
            self._action_buttons.append((sw_btn, not locked))
            sw_btn.clicked.connect(lambda: self.action_triggered.emit("switch", self._account_id))
            actions.addWidget(sw_btn)

        self.set_interaction_state(online=online, busy=busy)
        top.addLayout(actions)
        root.addLayout(top)

        # Optional Masked Error Banner
        err_msg = account.get("lastError")
        if err_msg and expired:
            err_lbl = QLabel(f"失效原因：{str(err_msg)[:140]}")
            err_lbl.setObjectName("PillRed")
            err_lbl.setWordWrap(True)
            root.addWidget(err_lbl)

        # Two columns keep quota labels readable; extra entries add natural-height rows.
        quota = account.get("quota") or {}
        entries = []
        if isinstance(quota, dict):
            for item in _quota_entries(quota):
                title = item.get("shortLabel") or item.get("label") or item.get("displayName") or item.get("id") or "模型"
                entries.append((str(title), item.get("percentage"), str(item.get("resetText") or ""), bool(item.get("disabled"))))

        if entries:
            q_grid = QGridLayout()
            q_grid.setHorizontalSpacing(14)
            q_grid.setVerticalSpacing(4)
            columns = min(2, len(entries))
            for column in range(columns):
                q_grid.setColumnStretch(column, 1)
            for index, (title, pct, reset_txt, dis) in enumerate(entries):
                bar = QuotaBarWidget(title, pct, reset_txt, dis)
                bar.set_dark(dark)
                self._quota_bars.append(bar)
                span = columns if index == len(entries) - 1 and index % columns == 0 else 1
                q_grid.addWidget(bar, index // columns, index % columns, 1, span)
            root.addLayout(q_grid)
        else:
            empty_q = QLabel("暂无缓存配额 · 点击右侧刷新按钮获取模型余量")
            empty_q.setObjectName("Small")
            root.addWidget(empty_q)

    def set_interaction_state(self, *, online: bool, busy: bool) -> None:
        for button, allowed in self._action_buttons:
            button.setEnabled(online and not busy and allowed)

    def set_dark(self, dark: bool) -> None:
        super().set_dark(dark)
        for bar in self._quota_bars:
            bar.set_dark(dark)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self._account_id)
        super().mousePressEvent(event)
