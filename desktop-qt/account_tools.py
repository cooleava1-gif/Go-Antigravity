"""Native account-pool tools, using only the existing local desktop API.

Integration: mount(layout), render_status(snapshot), and update_enabled() from
MainWindow's enablement pass. Import/export files are chosen explicitly by users.

Demo windows keep every account affordance enabled so the layout can be reviewed, but a click
only shows the preview notice: no dialog opens, no file is written, and no request is sent.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from PyQt6.QtCore import QIODevice, QSaveFile
from PyQt6.QtWidgets import (
    QDialog, QDialogButtonBox, QFileDialog, QHBoxLayout, QLabel, QLineEdit,
    QPlainTextEdit, QPushButton, QVBoxLayout,
)

MAX_BODY_BYTES = 64 * 1024


def build_import_payload(raw_input: str, email: str = "") -> tuple[dict, int]:
    """Match agoauth's supported shapes; reject masked exports before upsert."""
    text = raw_input.strip()
    if not text:
        raise ValueError("请填写 refresh_token 或 JSON 令牌内容。")
    count = 1
    if text.startswith(("[", "{")):
        try:
            parsed = json.loads(text)
        except (ValueError, RecursionError):
            raise ValueError("JSON 格式无效，请检查括号与引号。") from None
        entries = parsed if isinstance(parsed, list) else (
            parsed.get("accounts") if isinstance(parsed, dict)
            and isinstance(parsed.get("accounts"), list) else [parsed])
        count = 0
        for item in entries:
            if not isinstance(item, dict):
                continue
            nested = item.get("token")
            nested = nested if isinstance(nested, dict) else {}
            token = (item.get("refresh_token") or item.get("refreshToken")
                     or nested.get("refresh_token") or nested.get("refreshToken"))
            if item.get("refreshTokenMasked") is True:
                raise ValueError("这是脱敏导出，不能恢复账户。请使用完整令牌备份。")
            if isinstance(token, str) and token.strip():
                if "…" in token or "..." in token or "*" in token:
                    raise ValueError("令牌似乎已脱敏，请使用完整 refresh_token。")
                for key in ("email", "name", "displayName"):
                    if item.get(key) is not None and not isinstance(item[key], str):
                        raise ValueError("账户的邮箱和名称必须是文本。")
                user = item.get("user")
                if isinstance(user, dict) and user.get("email") is not None and not isinstance(user["email"], str):
                    raise ValueError("账户邮箱必须是文本。")
                count += 1
        if not count:
            raise ValueError("JSON 中未找到有效的 refresh_token 字段。")
    elif "…" in text or "..." in text or "*" in text:
        raise ValueError("令牌似乎已脱敏，请使用完整 refresh_token。")
    payload = {"rawInput": text}
    if email.strip():
        payload["email"] = email.strip()
    if len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("导入请求超过 64 KiB，请拆成较小的批次。")
    return payload, count


class AccountTools:
    """Decluttered toolbar + detail actions; all mutations pass through owner's guarded client."""

    def __init__(self, owner: Any):
        self.owner = owner
        self._mounted = False
        self._quota_task: dict = {}

    def mount(self, toolbar_layout, detail_layout=None) -> None:
        if self._mounted:
            return
        self._mounted = True

        self.refresh_button = self.owner.button("刷新全部配额", self.refresh_all, symbol="refresh")
        self.capture_button = self.owner.button("读取本地客户端账户", self.capture_current)
        self.import_button = self.owner.button("导入账户 / 令牌", self.import_accounts)

        toolbar_layout.addWidget(self.refresh_button)
        toolbar_layout.addWidget(self.capture_button)
        toolbar_layout.addWidget(self.import_button)

        self.reauth_button = self.owner.button("重新授权", self.reauthorize)
        if detail_layout is not None:
            detail_layout.addWidget(self.reauth_button)

        self.progress = QLabel("")
        self.progress.setObjectName("Muted")
        self.progress.setMinimumWidth(0)
        self.update_enabled()

    def capture_current(self) -> None:
        if self._preview():
            return
        if self._ready("capture"):
            self.owner.perform("capture", "/api/accounts/capture", {})

    def _demo(self) -> bool:
        return bool(getattr(self.owner, "demo", False))

    def _ready(self, action: str) -> bool:
        """Real execution only: a demo window never reaches the backend."""
        pending = getattr(self.owner, "_pending", {}) or {}
        return bool(
            getattr(self.owner, "client", None)
            and getattr(self.owner, "_online", False)
            and not getattr(self.owner, "_closing", False)
            and not self._demo()
            and action not in pending
        )

    def _enabled(self, action: str) -> bool:
        """Demo windows advertise the same affordances as a live window; a click explains instead."""
        if self._demo():
            return bool(
                getattr(self.owner, "_online", False)
                and not getattr(self.owner, "_closing", False)
                and action not in (getattr(self.owner, "_pending", {}) or {})
            )
        return self._ready(action)

    def _preview(self) -> bool:
        if self._demo():
            self.owner.preview_only("预览模式：不会读取、导入或导出账户，也不会修改任何设置。")
            return True
        return False

    def update_enabled(self) -> None:
        if not self._mounted:
            return
        self.capture_button.setEnabled(self._enabled("capture"))
        self.import_button.setEnabled(self._enabled("accounts-import"))

        accounts = (getattr(self.owner, "snapshot", {}).get("accounts") or {}).get("items") or []
        self.refresh_button.setEnabled(
            self._enabled("quota-refresh-all")
            and self._quota_task.get("state") != "running"
            and any(not item.get("locked") for item in accounts)
        )
        self.reauth_button.setEnabled(self._enabled("oauth-start") and bool(self.owner.selected_account()))

    def render_status(self, state: dict) -> None:
        if "quotaTask" in state:
            self._quota_task = state.get("quotaTask") or {}
        if self._mounted:
            task = self._quota_task
            done, total, failed = (task.get("done", 0), task.get("total", 0), task.get("failed", 0))
            if task.get("state") == "running":
                self.progress.setText(f"配额 {done}/{total}" + (f" · 失败 {failed}" if failed else ""))
            elif task.get("state") == "done":
                self.progress.setText(f"已完成 {done}/{total}" + (f" · 失败 {failed}" if failed else ""))
            else:
                self.progress.clear()
            self.update_enabled()

    def import_accounts(self) -> None:
        if self._preview():
            return
        if not self._ready("accounts-import"):
            return
        dialog = QDialog(self.owner)
        dialog.setWindowTitle("导入账户")
        dialog.resize(560, 400)
        layout = QVBoxLayout(dialog)
        hint = QLabel("粘贴 refresh_token、单个账户 JSON、JSON 数组或完整账户池备份。\n重复账户会更新凭据；导入后会校验配额，最后一项会设为启动账户。")
        hint.setWordWrap(True)
        layout.addWidget(hint)
        editor = QPlainTextEdit()
        editor.setPlaceholderText("令牌只发送到本机服务；不要粘贴脱敏导出。")
        layout.addWidget(editor, 1)
        email = QLineEdit()
        email.setPlaceholderText("默认邮箱（可选，用于未携带邮箱的条目）")
        layout.addWidget(email)
        error = QLabel("")
        error.setObjectName("PillRed")
        error.setWordWrap(True)
        error.hide()
        layout.addWidget(error)
        row = QHBoxLayout()
        load = QPushButton("从文件读取…")
        row.addWidget(load)
        row.addStretch(1)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("导入")
        row.addWidget(buttons)
        layout.addLayout(row)
        result = {}

        def load_file():
            filename, _ = QFileDialog.getOpenFileName(dialog, "选择账户备份", "", "JSON / 文本 (*.json *.txt);;所有文件 (*)")
            if not filename:
                return
            try:
                with Path(filename).open("rb") as stream:
                    raw = stream.read(MAX_BODY_BYTES + 1)
                if len(raw) > MAX_BODY_BYTES:
                    raise ValueError("文件超过 64 KiB，请拆成较小的批次。")
                text = raw.decode("utf-8-sig")
                editor.setPlainText(text)
                error.clear()
                error.hide()
            except (OSError, UnicodeError, ValueError):
                error.setText("无法读取：请选择不超过 64 KiB 的 UTF-8 文本或 JSON 文件。")
                error.show()

        def accept():
            try:
                payload, count = build_import_payload(editor.toPlainText(), email.text())
            except ValueError as exc:
                error.setText(str(exc))
                error.show()
                return
            result.update(payload=payload, count=count)
            dialog.accept()

        load.clicked.connect(load_file)
        buttons.accepted.connect(accept)
        buttons.rejected.connect(dialog.reject)
        accepted = dialog.exec() == QDialog.DialogCode.Accepted
        editor.clear()
        email.clear()
        dialog.deleteLater()
        if not accepted:
            return
        count = result["count"]
        self.owner.perform(
            "accounts-import",
            "/api/accounts/add",
            result["payload"],
            callback=lambda _: self.owner.inform(f"已提交 {count} 项账户，正在后台校验配额与令牌状态。"),
            timeout=60000,
        )

    def export_accounts(self, include_tokens: bool = False) -> None:
        if self._preview():
            return
        if not self._ready("accounts-export"):
            return
        if include_tokens and not self.owner.confirm(
            "导出完整令牌备份",
            "备份将包含可登录账户的完整 refresh_token。请只保存到可信位置，不要发送给他人。是否继续？",
        ):
            return
        suffix = "backup" if include_tokens else "masked"
        filename, _ = QFileDialog.getSaveFileName(
            self.owner,
            "保存完整账户备份" if include_tokens else "保存脱敏账户资料",
            f"accounts-{suffix}-{datetime.now():%Y%m%d-%H%M%S}.json",
            "JSON (*.json)",
        )
        if not filename:
            return
        body = {"includeTokens": True, "confirm": "export-tokens"} if include_tokens else None

        def saved(data):
            pool = data.get("pool") if isinstance(data, dict) else None
            if not isinstance(pool, dict) or not isinstance(pool.get("accounts"), list):
                self.owner.inform("账户导出响应格式无效，未写入文件。")
                return
            target = QSaveFile(filename)
            try:
                raw = json.dumps(pool, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8") + b"\n"
                if not target.open(QIODevice.OpenModeFlag.WriteOnly):
                    raise OSError
                if target.write(raw) != len(raw):
                    target.cancelWriting()
                    raise OSError
                if not target.commit():
                    raise OSError
            except (OSError, TypeError, ValueError):
                target.cancelWriting()
                self.owner.inform("保存失败，请检查目标目录权限与磁盘空间。")
                return
            self.owner.inform(
                f"已保存 {len(pool['accounts'])} 项"
                + ("完整令牌备份，请妥善保管。" if include_tokens else "脱敏资料；此文件不能用于恢复账户。")
            )

        self.owner.perform("accounts-export", "/api/accounts/export", body, callback=saved)

    def refresh_all(self) -> None:
        if self._preview():
            return
        if not self._ready("quota-refresh-all") or self._quota_task.get("state") == "running":
            return

        def started(data):
            task = data.get("task") if isinstance(data, dict) else None
            if isinstance(task, dict):
                self.render_status({"quotaTask": task})
            self.owner.inform("正在逐个刷新账户配额。" if data.get("started") else "已有配额刷新任务正在进行。")

        self.owner.perform("quota-refresh-all", "/api/accounts/quota/refresh-all", {}, callback=started)

    def reauthorize(self, account_id: str | None = None) -> None:
        if self._preview():
            return
        if not self._ready("oauth-start"):
            return
        account = None
        if account_id:
            account = next(
                (a for a in getattr(self.owner, "_account_items", []) if a.get("id") == account_id),
                None,
            )
        if account is None:
            account = self.owner.selected_account()
        if not account:
            return

        def started(data):
            self.owner.render_oauth(data)
            self.owner._update_enabled()
            self.owner.inform("已为选中账户发起重新授权，请在浏览器中登录对应账户。")

        self.owner.perform(
            "oauth-start",
            "/api/accounts/oauth/start",
            {"openBrowser": True, "loginHint": account.get("email"), "accountId": account["id"]},
            callback=started,
        )
