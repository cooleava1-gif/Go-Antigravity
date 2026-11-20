"""GitHub auto-update core for the packaged Windows desktop build (stdlib only).

The Qt layer owns the user-visible flow (checking, progress, asking before quitting); this module
owns everything that has to be correct: release selection, asset verification, safe extraction and
the hand-off to the installer helper.

Nothing downloaded here is ever executed. The helper script that performs the directory swap is
copied out of the *current* installation (desktop-qt/update_install.ps1) into a temporary folder
outside the install root, and waits until this process has exited before renaming directories.

Public contract used by desktop-qt/update_ui.py:
    read_build(root) -> dict
    check_for_update(root) -> dict
    prepare_update(root, release, *, progress=None, cancel=None) -> dict
    launch_installer(root, prepared) -> None
    cleanup_prepared(prepared) -> None
    UpdateError
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

REPOSITORY = "cooleava1-gif/Go-Antigravity"
ASSET_NAME = "Go-Antigravity-windows-x64.zip"
CHECKSUM_ASSET_NAME = ASSET_NAME + ".sha256"
PACKAGE_NAME = "Go-Antigravity"
PLATFORM = "windows-x64"
LAUNCHER_NAME = "Go-Antigravity.exe"
MANIFEST_RELATIVE = "runtime/manifest.json"
HELPER_RELATIVE = "desktop-qt/update_install.ps1"

API_LATEST_URL = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest"
API_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "Go-Antigravity-Updater",
}
DOWNLOAD_HEADERS = {
    "Accept": "application/octet-stream",
    "User-Agent": "Go-Antigravity-Updater",
}
# Only these hosts may serve the update archive. github.com hands out the release URL and redirects
# to the asset CDN, so both the first URL and every redirect target are checked against this set.
DOWNLOAD_HOSTS = frozenset({
    "github.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "release-assets.githubusercontent.com",
})
API_HOSTS = frozenset({"api.github.com"})

API_TIMEOUT_SECONDS = 20.0
DOWNLOAD_TIMEOUT_SECONDS = 60.0
CHUNK_BYTES = 256 * 1024
MAX_JSON_BYTES = 1024 * 1024
MAX_CHECKSUM_BYTES = 4096
MAX_RELEASE_NOTES = 8000
MAX_DOWNLOAD_BYTES = 4 * 1024 ** 3
MAX_UNCOMPRESSED_BYTES = 8 * 1024 ** 3
MAX_ARCHIVE_ENTRIES = 200_000
ROOT_RENAME_RETRY_SECONDS = 30
LAUNCHER_WAIT_SECONDS = 180

REQUIRED_INSTALL_FILES = (
    LAUNCHER_NAME,
    "Start-Go-Antigravity.ps1",
    "Start-Go-Antigravity.cmd",
    "backend/server.js",
    "backend/package.json",
    "backend/package-lock.json",
    "runtime/node/node.exe",
    "runtime/python/python.exe",
    "runtime/python/pythonw.exe",
    "desktop-qt/main.py",
    "desktop-qt/update_ui.py",
    "desktop-qt/updater.py",
    HELPER_RELATIVE,
)
REQUIRED_INSTALL_DIRECTORIES = ("backend/node_modules",)

_VERSION_RE = re.compile(
    r"^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class UpdateError(Exception):
    """A short, user-facing Chinese message: str(error) is shown as-is."""


def _report_progress(progress: Callable[[int, int], Any] | None, received: int, total: int) -> None:
    """The UI label may already be gone while the dialog closes; a callback must not break us."""
    if progress is None:
        return
    try:
        progress(int(received), int(total))
    except Exception:
        return


def _check_cancel(cancel: Any) -> None:
    if cancel is not None and bool(getattr(cancel, "is_set", lambda: False)()):
        raise UpdateError("更新已取消。")


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------


def _version_tuple(text: Any) -> tuple[int, int, int, str]:
    match = _VERSION_RE.match(str(text or "").strip())
    if not match:
        raise UpdateError(f"版本号格式无效：{text!r}")
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)),
            str(match.group(4) or ""))


def normalize_version(text: Any) -> str:
    """Return 'X.Y.Z' or 'X.Y.Z-pre' with any 'v' prefix removed."""
    major, minor, patch, pre = _version_tuple(text)
    base = f"{major}.{minor}.{patch}"
    return f"{base}-{pre}" if pre else base


def is_prerelease(text: Any) -> bool:
    return bool(_version_tuple(text)[3])


def _compare_prerelease(left: str, right: str) -> int:
    left_parts = left.split(".")
    right_parts = right.split(".")
    for left_part, right_part in zip(left_parts, right_parts):
        if left_part == right_part:
            continue
        left_number = left_part.isdigit()
        right_number = right_part.isdigit()
        if left_number and right_number:
            return 1 if int(left_part) > int(right_part) else -1
        if left_number != right_number:
            return -1 if left_number else 1
        return 1 if left_part > right_part else -1
    if len(left_parts) == len(right_parts):
        return 0
    return 1 if len(left_parts) > len(right_parts) else -1


def compare_versions(left: Any, right: Any) -> int:
    left_core = _version_tuple(left)
    right_core = _version_tuple(right)
    for left_value, right_value in zip(left_core[:3], right_core[:3]):
        if left_value != right_value:
            return 1 if left_value > right_value else -1
    left_pre, right_pre = left_core[3], right_core[3]
    if left_pre == right_pre:
        return 0
    if not left_pre:
        return 1
    if not right_pre:
        return -1
    return _compare_prerelease(left_pre, right_pre)


def is_newer(candidate: Any, current: Any) -> bool:
    return compare_versions(candidate, current) > 0


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _normalized_path(path: Any) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def _is_within(child: Any, parent: Any) -> bool:
    child_path = _normalized_path(child)
    parent_path = _normalized_path(parent).rstrip("\\/")
    if not parent_path:
        return False
    return child_path == parent_path or child_path.startswith(parent_path + os.sep)


def _same_directory(left: Any, right: Any) -> bool:
    return _normalized_path(left) == _normalized_path(right)


def _data_directory(root: Path, packaged: bool, environment: dict[str, str] | None = None) -> Path:
    """Mirror runtime.backend_data_directory without importing Qt.

    A configured GO_ANTIGRAVITY_DATA_DIR wins (relative values are resolved against the install
    root, exactly like the desktop runtime); a packaged install otherwise keeps its data under
    %LOCALAPPDATA%, and a source checkout keeps the in-root .go-antigravity-data folder.
    """
    env = os.environ if environment is None else environment
    configured = str(env.get("GO_ANTIGRAVITY_DATA_DIR") or "").strip()
    root = Path(root).resolve()
    if configured:
        candidate = Path(configured)
        return (candidate if candidate.is_absolute() else root / candidate).resolve()
    if packaged:
        base = str(env.get("LOCALAPPDATA") or "").strip() or str(env.get("APPDATA") or "").strip()
        if base:
            return (Path(base) / PACKAGE_NAME).resolve()
        return (Path.home() / "AppData" / "Local" / PACKAGE_NAME).resolve()
    return (root / ".go-antigravity-data").resolve()


# ---------------------------------------------------------------------------
# Build description
# ---------------------------------------------------------------------------


def _read_manifest(root: Path) -> dict | None:
    path = Path(root) / MANIFEST_RELATIVE
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            return None
        with path.open("r", encoding="utf-8-sig") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return manifest if isinstance(manifest, dict) else None


def _source_version(root: Path) -> str:
    path = Path(root) / "backend/package.json"
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            package = json.load(handle)
    except (OSError, ValueError, UnicodeDecodeError):
        return "0.0.0"
    if not isinstance(package, dict):
        return "0.0.0"
    try:
        return normalize_version(package.get("version"))
    except UpdateError:
        return "0.0.0"


def _layout_problem(root: Path, manifest: dict | None) -> str:
    """Return one concrete Chinese reason an install cannot be replaced, or '' when it can."""
    root = Path(root)
    if not manifest:
        return "安装目录不完整：缺少 runtime/manifest.json。"
    if manifest.get("package") != PACKAGE_NAME or manifest.get("platform") != PLATFORM:
        return "当前目录不是 Go-Antigravity 的 Windows 安装包。"
    if (root / ".git").exists():
        return "安装目录内含 .git，判定为源码目录，不能就地更新。"
    for relative in REQUIRED_INSTALL_FILES:
        if not (root / relative).is_file():
            return f"安装目录不完整：缺少 {relative}。"
    for relative in REQUIRED_INSTALL_DIRECTORIES:
        if not (root / relative).is_dir():
            return f"安装目录不完整：缺少 {relative} 目录。"
    return ""


def read_build(root: Path) -> dict:
    """Describe the tree the desktop is running from. Never raises for a broken source checkout."""
    root = Path(root).resolve()
    manifest = _read_manifest(root)
    packaged = False
    version = _source_version(root)
    commit = "unknown"
    if manifest and manifest.get("package") == PACKAGE_NAME and manifest.get("platform") == PLATFORM:
        try:
            manifest_version = normalize_version(manifest.get("version"))
        except UpdateError:
            manifest_version = ""
        if manifest_version:
            packaged = True
            version = manifest_version
            commit = str(manifest.get("commit") or "unknown").strip()[:64] or "unknown"
    data_directory = _data_directory(root, packaged)
    # In-place replacement is only safe for a complete packaged install whose account data lives
    # outside the tree that gets renamed: the swap keeps the backup, and data inside would move.
    if not packaged:
        if (root / MANIFEST_RELATIVE).is_file():
            reason = "runtime/manifest.json 无效，当前目录不是正式安装包。"
        else:
            reason = "未找到 runtime/manifest.json，当前目录是源码工作区。"
    else:
        reason = _layout_problem(root, manifest)
        if not reason and _is_within(data_directory, root):
            reason = f"数据目录位于安装目录内（{data_directory}），替换安装目录会丢失数据。"
    install_supported = bool(packaged and not reason)
    return {
        "root": str(root),
        "version": version,
        "commit": commit,
        "packaged": packaged,
        "repository": REPOSITORY,
        "install_supported": install_supported,
        "install_reason": "" if install_supported else reason,
        "launcher": LAUNCHER_NAME,
        "data_directory": str(data_directory),
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _check_download_host(url: str, hosts: frozenset[str]) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(url))
    except ValueError:
        raise UpdateError("更新下载地址无效，已停止更新。") from None
    if parsed.scheme != "https" or not parsed.hostname:
        raise UpdateError("更新下载地址不是 HTTPS，已停止更新。")
    if parsed.username or parsed.password:
        raise UpdateError("更新下载地址包含凭据，已停止更新。")
    if parsed.port not in (None, 443):
        raise UpdateError("更新下载地址使用了非标准端口，已停止更新。")
    if parsed.hostname.lower() not in hosts:
        raise UpdateError("更新下载地址不是本项目的 GitHub 地址，已停止更新。")
    return url


def _validate_asset_url(url: str) -> str:
    _check_download_host(url, DOWNLOAD_HOSTS)
    parsed = urllib.parse.urlsplit(str(url))
    if parsed.hostname.lower() == "github.com":
        prefix = f"/{REPOSITORY}/releases/download/".lower()
        if not parsed.path.lower().startswith(prefix):
            raise UpdateError("更新包下载地址不属于本项目的发布文件，已停止更新。")
    return url


def _validate_release_page(url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(url))
    except ValueError:
        raise UpdateError("GitHub 发布页地址无效，已停止更新。") from None
    prefix = f"/{REPOSITORY}/releases".lower()
    if (parsed.scheme != "https" or (parsed.hostname or "").lower() != "github.com"
            or not parsed.path.lower().startswith(prefix)):
        raise UpdateError("GitHub 发布页地址不属于本项目，已停止更新。")
    return url


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow only HTTPS redirects that stay on the allowed download hosts."""

    def __init__(self, hosts: frozenset[str]):
        super().__init__()
        self._hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_download_host(newurl, self._hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener(hosts: frozenset[str]) -> urllib.request.OpenerDirector:
    # ProxyHandler() with no arguments takes the system/environment proxy settings, so corporate
    # and local proxies keep working without this module ever reading proxy credentials.
    return urllib.request.build_opener(urllib.request.ProxyHandler(),
                                       _GuardedRedirectHandler(hosts))


def _fetch_json(url: str, *, timeout: float = API_TIMEOUT_SECONDS) -> Any:
    request = urllib.request.Request(url, headers=API_HEADERS)
    try:
        with _opener(API_HOSTS).open(request, timeout=timeout) as response:
            raw = response.read(MAX_JSON_BYTES)
    except urllib.error.HTTPError as error:
        raise UpdateError(f"GitHub 接口返回 HTTP {error.code}，请稍后重试。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise UpdateError("无法连接 GitHub 检查更新，请检查网络或代理设置。") from None
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise UpdateError("GitHub 返回了无法解析的更新信息。") from None


def _fetch_text(url: str, *, timeout: float = API_TIMEOUT_SECONDS) -> str:
    _validate_asset_url(url)
    request = urllib.request.Request(url, headers=DOWNLOAD_HEADERS)
    try:
        with _opener(DOWNLOAD_HOSTS).open(request, timeout=timeout) as response:
            raw = response.read(MAX_CHECKSUM_BYTES)
    except urllib.error.HTTPError as error:
        raise UpdateError(f"下载校验文件失败：HTTP {error.code}。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise UpdateError("下载校验文件失败，请检查网络或代理设置。") from None
    return raw.decode("utf-8", "replace")


def _download(url: str, destination: Path, *, expected_size: int = 0,
              progress: Callable[[int, int], Any] | None = None,
              cancel: Any = None,
              timeout: float = DOWNLOAD_TIMEOUT_SECONDS) -> dict:
    """Stream one asset into destination.part, then rename it into place."""
    _validate_asset_url(url)
    if expected_size > MAX_DOWNLOAD_BYTES:
        raise UpdateError("更新包体积异常，已停止更新。")
    destination = Path(destination)
    part = destination.with_name(destination.name + ".part")
    request = urllib.request.Request(url, headers=DOWNLOAD_HEADERS)
    digest = hashlib.sha256()
    received = 0
    total = int(expected_size)
    try:
        with _opener(DOWNLOAD_HOSTS).open(request, timeout=timeout) as response, \
                open(part, "wb") as handle:
            if not total:
                header = response.headers.get("Content-Length") if response.headers else None
                if header and str(header).isdigit():
                    total = int(header)
            if total > MAX_DOWNLOAD_BYTES:
                raise UpdateError("更新包体积异常，已停止更新。")
            _report_progress(progress, 0, total)
            while True:
                _check_cancel(cancel)
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                handle.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                if received > MAX_DOWNLOAD_BYTES:
                    raise UpdateError("更新包体积异常，已停止更新。")
                _report_progress(progress, received, total)
            handle.flush()
            os.fsync(handle.fileno())
        _check_cancel(cancel)
        os.replace(part, destination)
    except UpdateError:
        raise
    except urllib.error.HTTPError as error:
        raise UpdateError(f"下载更新包失败：HTTP {error.code}。") from None
    except (urllib.error.URLError, TimeoutError):
        raise UpdateError("下载更新包失败，请检查网络或代理设置。") from None
    except OSError:
        raise UpdateError("下载或写入更新包失败，请检查网络与磁盘空间。") from None
    finally:
        try:
            if part.exists():
                part.unlink()
        except OSError:
            pass
    return {"size": received, "sha256": digest.hexdigest()}


# ---------------------------------------------------------------------------
# Release selection
# ---------------------------------------------------------------------------


def _normalize_sha256(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = text[len("sha256:"):] if text.startswith("sha256:") else text
    return text if _SHA256_RE.match(text) else ""


def _asset_sha256(asset: dict, assets: list, *, timeout: float) -> str:
    """Prefer the API digest; fall back to the published .zip.sha256 sidecar."""
    digest = _normalize_sha256(asset.get("digest"))
    if digest:
        return digest
    for sibling in assets:
        if not isinstance(sibling, dict):
            continue
        if str(sibling.get("name") or "").casefold() != CHECKSUM_ASSET_NAME.casefold():
            continue
        sidecar_url = str(sibling.get("browser_download_url") or sibling.get("url") or "")
        if not sidecar_url:
            continue
        text = _fetch_text(sidecar_url, timeout=timeout)
        match = re.search(r"\b([0-9a-fA-F]{64})\b", text)
        if match:
            return match.group(1).lower()
    return ""


def _select_asset(payload: dict, *, timeout: float) -> dict | None:
    assets = payload.get("assets")
    if not isinstance(assets, list):
        return None
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        if str(asset.get("name") or "").casefold() != ASSET_NAME.casefold():
            continue
        url = _validate_asset_url(str(asset.get("browser_download_url") or asset.get("url") or ""))
        size = asset.get("size")
        try:
            size_value = int(size)
        except (TypeError, ValueError):
            raise UpdateError("GitHub 没有提供更新包大小，已拒绝安装。") from None
        if size_value <= 0 or size_value > MAX_DOWNLOAD_BYTES:
            raise UpdateError("GitHub 提供的更新包大小异常，已拒绝安装。")
        sha256 = _asset_sha256(asset, assets, timeout=timeout)
        if not sha256:
            raise UpdateError("更新包缺少 SHA-256 校验值，已拒绝安装。")
        return {"name": ASSET_NAME, "url": url, "size": size_value, "sha256": sha256}
    return None


def _parse_release(payload: Any) -> dict:
    """Release identity only: an up-to-date answer must not depend on the asset being usable."""
    if not isinstance(payload, dict):
        raise UpdateError("GitHub 返回了无法解析的发布信息。")
    if payload.get("draft") is True:
        raise UpdateError("GitHub 最新发布仍是草稿，暂时无法自动更新。")
    tag = str(payload.get("tag_name") or "").strip()
    if not tag:
        raise UpdateError("GitHub 发布缺少版本标签，暂时无法自动更新。")
    version = normalize_version(tag)
    release_url = str(payload.get("html_url") or "")
    if release_url:
        _validate_release_page(release_url)
    return {
        "version": version,
        "tag": tag,
        "prerelease": bool(payload.get("prerelease")) or is_prerelease(version),
        "release_url": release_url,
        "notes": str(payload.get("body") or "")[:MAX_RELEASE_NOTES],
        "published_at": str(payload.get("published_at") or ""),
    }


def check_for_update(root: Path, *, timeout: float = API_TIMEOUT_SECONDS) -> dict:
    """Compare the running build with the latest stable GitHub release.

    Same version or a downgrade is simply not available (no asset is required); a newer release
    without a usable, checksummed Windows asset raises UpdateError instead of offering a download.
    """
    root = Path(root).resolve()
    current = read_build(root)
    payload = _fetch_json(API_LATEST_URL, timeout=timeout)
    release = _parse_release(payload)
    result = {
        "current": current,
        "latest": release["version"],
        "available": False,
        "release_url": release["release_url"],
        "notes": release["notes"],
        "published_at": release["published_at"],
        "asset": None,
        "reason": "",
    }
    if release["prerelease"]:
        # /releases/latest excludes prereleases by contract; if one still shows up it is reported
        # but never offered for automatic installation.
        result["reason"] = "prerelease"
        return result
    if not is_newer(release["version"], current["version"]):
        result["reason"] = "up-to-date"
        return result
    asset = _select_asset(payload, timeout=timeout)
    if not asset:
        raise UpdateError("GitHub 最新发布没有提供 Windows 安装包，暂时无法自动更新。")
    result["asset"] = asset
    result["available"] = True
    result["reason"] = "newer"
    return result


# ---------------------------------------------------------------------------
# Safe extraction and package verification
# ---------------------------------------------------------------------------


def _safe_member_name(name: str) -> str:
    text = str(name or "")
    if not text or "\x00" in text:
        raise UpdateError("更新包包含无效路径，已拒绝安装。")
    if "\\" in text:
        raise UpdateError("更新包包含 Windows 路径分隔符，已拒绝安装。")
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise UpdateError("更新包包含绝对路径，已拒绝安装。")
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts:
        raise UpdateError("更新包包含无效路径，已拒绝安装。")
    if any(part == ".." for part in parts):
        raise UpdateError("更新包包含父目录路径，已拒绝安装。")
    if any(part != part.rstrip(" .") for part in parts):
        # Win32 drops trailing dots and spaces, so "dir." aliases "dir" and could slip past checks.
        raise UpdateError("更新包包含以空格或点结尾的目录名，已拒绝安装。")
    if any(":" in part for part in parts):
        raise UpdateError("更新包包含 Windows 驱动器路径，已拒绝安装。")
    return "/".join(parts)


def _is_symlink_member(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    return stat.S_ISLNK(mode)


def _extract_archive(archive: Path, destination: Path, *, cancel: Any = None) -> Path:
    destination = Path(destination)
    try:
        destination.mkdir(parents=True, exist_ok=False)
    except OSError:
        raise UpdateError("更新暂存目录已存在，请稍后重试。") from None
    try:
        archive_file = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError):
        raise UpdateError("下载的更新包不是有效的 ZIP 文件。") from None
    try:
        infos = archive_file.infolist()
    except (zipfile.BadZipFile, OSError):
        archive_file.close()
        raise UpdateError("下载的更新包已损坏。") from None
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        archive_file.close()
        raise UpdateError("更新包文件条目过多，已拒绝安装。")
    destination_root = os.path.abspath(str(destination))
    total_bytes = 0
    extracted_files: set[str] = set()
    with archive_file:
        for info in infos:
            _check_cancel(cancel)
            relative = _safe_member_name(info.filename)
            if _is_symlink_member(info):
                raise UpdateError("更新包包含符号链接，已拒绝安装。")
            target = os.path.abspath(os.path.join(destination_root, *relative.split("/")))
            if target != destination_root and not target.startswith(
                    destination_root.rstrip("\\/") + os.sep):
                raise UpdateError("更新包路径越出了安装目录，已拒绝安装。")
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            if info.file_size > MAX_UNCOMPRESSED_BYTES:
                raise UpdateError("更新包解压后体积异常，已拒绝安装。")
            total_bytes += info.file_size
            if total_bytes > MAX_UNCOMPRESSED_BYTES:
                raise UpdateError("更新包解压后体积异常，已拒绝安装。")
            key = os.path.normcase(target)
            if key in extracted_files:
                raise UpdateError("更新包包含重复路径，已拒绝安装。")
            extracted_files.add(key)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            try:
                with archive_file.open(info) as source, open(target, "wb") as sink:
                    shutil.copyfileobj(source, sink, CHUNK_BYTES)
            except (zipfile.BadZipFile, RuntimeError, OSError):
                raise UpdateError("解压更新包失败，文件可能已损坏。") from None
    _check_cancel(cancel)
    return destination


def _single_root(extract_dir: Path) -> Path:
    entries = list(Path(extract_dir).iterdir())
    directories = [entry for entry in entries if entry.is_dir() and not entry.is_symlink()]
    if len(entries) != 1 or len(directories) != 1:
        raise UpdateError("更新包结构不是单一安装目录，已拒绝安装。")
    return directories[0]


def _verify_package(directory: Path, version: str) -> None:
    directory = Path(directory)
    if (directory / ".git").exists():
        raise UpdateError("更新包内含 .git，已拒绝安装。")
    manifest = _read_manifest(directory)
    if not manifest:
        raise UpdateError("更新包缺少 runtime/manifest.json，已拒绝安装。")
    if manifest.get("package") != PACKAGE_NAME:
        raise UpdateError("更新包不是 Go-Antigravity 的发布包，已拒绝安装。")
    if manifest.get("platform") != PLATFORM:
        raise UpdateError("更新包不是 Windows x64 版本，已拒绝安装。")
    try:
        manifest_version = normalize_version(manifest.get("version"))
    except UpdateError:
        raise UpdateError("更新包的版本信息无效，已拒绝安装。") from None
    if manifest_version != version:
        raise UpdateError("更新包版本与 GitHub 发布信息不一致，已拒绝安装。")
    for relative in REQUIRED_INSTALL_FILES:
        if not (directory / relative).is_file():
            raise UpdateError(f"更新包不完整：缺少 {relative}。")
    for relative in REQUIRED_INSTALL_DIRECTORIES:
        if not (directory / relative).is_dir():
            raise UpdateError(f"更新包不完整：缺少 {relative} 目录。")


# ---------------------------------------------------------------------------
# Download preparation
# ---------------------------------------------------------------------------


def _release_version(release: Any) -> str:
    if not isinstance(release, dict):
        raise UpdateError("更新信息无效，请重新检查更新。")
    candidate = release.get("version") or release.get("latest")
    if not candidate:
        raise UpdateError("更新信息缺少版本号，请重新检查更新。")
    return normalize_version(candidate)


def _unique_path(parent: Path, name: str) -> Path:
    candidate = parent / name
    counter = 1
    while candidate.exists():
        candidate = parent / f"{name}-{counter}"
        counter += 1
    return candidate


def prepare_update(root: Path, release: dict, *,
                   progress: Callable[[int, int], Any] | None = None,
                   cancel: Any = None) -> dict:
    """Download, verify and stage the release next to the install root (same volume).

    The archive is fetched into the system temp folder; extraction happens in a sibling of the
    install root so the later rename stays on one volume. Any failure or cancellation removes the
    partial archive and the staged tree and leaves the running install untouched.
    """
    root = Path(root).resolve()
    build = read_build(root)
    version = _release_version(release)
    if not build["packaged"]:
        raise UpdateError("当前目录是源码工作区，不能就地更新；请手动替换为新的发布包。")
    if not build["install_supported"]:
        raise UpdateError("当前安装不满足就地更新条件：安装不完整，或数据目录位于安装目录内。")
    if not is_newer(version, build["version"]):
        raise UpdateError("当前已是最新版本，无需下载更新。")
    asset = release.get("asset")
    if not isinstance(asset, dict):
        raise UpdateError("更新信息缺少安装包，请重新检查更新。")
    if str(asset.get("name") or "").casefold() != ASSET_NAME.casefold():
        raise UpdateError(f"更新包不是 {ASSET_NAME}，已拒绝安装。")
    url = _validate_asset_url(str(asset.get("url") or ""))
    sha256 = _normalize_sha256(asset.get("sha256"))
    if not sha256:
        raise UpdateError("更新包缺少 SHA-256 校验值，已拒绝安装。")
    try:
        size = int(asset.get("size"))
    except (TypeError, ValueError):
        raise UpdateError("更新包缺少大小信息，已拒绝安装。") from None
    if size <= 0 or size > MAX_DOWNLOAD_BYTES:
        raise UpdateError("更新包大小异常，已拒绝安装。")
    _check_cancel(cancel)

    parent = root.parent
    token = secrets.token_hex(6)
    staged = parent / f".{root.name}.update-{token}"
    extract = parent / f".{root.name}.extract-{token}"
    backup = _unique_path(parent, f"{root.name}.backup-{time.strftime('%Y%m%d-%H%M%S')}")
    if staged.exists() or extract.exists():
        raise UpdateError("更新暂存目录已存在，请稍后重试。")
    temp = Path(tempfile.mkdtemp(prefix="go-antigravity-update-"))
    if _is_within(temp, root) or _is_within(root, temp):
        shutil.rmtree(temp, ignore_errors=True)
        raise UpdateError("无法在安装目录外创建临时目录，请检查系统临时目录设置。")
    archive = temp / ASSET_NAME
    try:
        downloaded = _download(url, archive, expected_size=size,
                               progress=progress, cancel=cancel)
        _check_cancel(cancel)
        if int(downloaded.get("size") or 0) != size:
            raise UpdateError("更新包大小与 GitHub 发布信息不一致，已停止更新。")
        if not hmac.compare_digest(str(downloaded.get("sha256") or "").lower(), sha256):
            raise UpdateError("更新包 SHA-256 校验失败，已停止更新。")
        try:
            _extract_archive(archive, extract, cancel=cancel)
            inner = _single_root(extract)
            _verify_package(inner, version)
            os.replace(inner, staged)
            shutil.rmtree(extract, ignore_errors=True)
            _verify_package(staged, version)
        except OSError:
            raise UpdateError("准备更新文件失败，请检查磁盘空间后重试。") from None
    except BaseException:
        shutil.rmtree(staged, ignore_errors=True)
        shutil.rmtree(extract, ignore_errors=True)
        shutil.rmtree(temp, ignore_errors=True)
        raise
    return {
        "version": version,
        "root": str(root),
        "staged": str(staged),
        "backup": str(backup),
        "download": str(archive),
        "temp": str(temp),
        "asset_name": ASSET_NAME,
        "asset_size": size,
        "asset_sha256": sha256,
        "release_url": str(release.get("release_url") or ""),
        "published_at": str(release.get("published_at") or ""),
        "prepared_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Installer hand-off
# ---------------------------------------------------------------------------


def _powershell() -> str:
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    candidate = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if candidate.is_file():
        return str(candidate)
    found = shutil.which("powershell.exe")
    if found:
        return found
    raise UpdateError("找不到 Windows PowerShell，无法完成更新安装。")


def _creation_flags() -> int:
    if os.name != "nt":
        return 0
    detached = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    own_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    return detached | own_group


def _write_job(path: Path, payload: dict) -> None:
    # Windows PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, which would garble Chinese
    # paths in the job file; the BOM keeps Get-Content -Encoding UTF8 unambiguous.
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    path.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))


def launch_installer(root: Path, prepared: dict) -> None:
    """Start the copied helper and return; the caller closes the GUI right after this.

    The helper lives outside the install root and waits for this process to exit before it renames
    anything. It inherits this process environment, so GO_ANTIGRAVITY_DATA_DIR keeps the restarted
    app on the same account data.
    """
    root = Path(root).resolve()
    if not isinstance(prepared, dict):
        raise UpdateError("更新准备信息无效，请重新下载更新。")
    prepared_root = str(prepared.get("root") or "")
    if not prepared_root or not _same_directory(prepared_root, root):
        raise UpdateError("更新准备信息与当前安装目录不一致，已停止更新。")
    staged = Path(str(prepared.get("staged") or ""))
    backup = Path(str(prepared.get("backup") or ""))
    if not staged.is_dir():
        raise UpdateError("更新文件已不存在，请重新下载。")
    if not _same_directory(staged.parent, root.parent) or not _same_directory(backup.parent, root.parent):
        raise UpdateError("更新暂存目录不在安装目录旁边，已停止更新。")
    if backup.exists():
        raise UpdateError("更新备份目录已存在，请稍后重试。")
    helper_source = root / HELPER_RELATIVE
    if not helper_source.is_file():
        raise UpdateError("当前安装缺少更新安装脚本，无法完成更新。")
    temp = Path(tempfile.mkdtemp(prefix="go-antigravity-update-run-"))
    try:
        if _is_within(temp, root) or _is_within(root, temp):
            raise UpdateError("无法在安装目录外创建临时目录，请检查系统临时目录设置。")
        helper = temp / "update_install.ps1"
        shutil.copyfile(helper_source, helper)
        log_path = temp / "update.log"
        job = {
            "root": str(root),
            "staged": str(staged),
            "backup": str(backup),
            "launcher": LAUNCHER_NAME,
            "version": str(prepared.get("version") or ""),
            "waitPid": os.getpid(),
            "retrySeconds": ROOT_RENAME_RETRY_SECONDS,
            "waitSeconds": LAUNCHER_WAIT_SECONDS,
            "restart": True,
            "download": str(prepared.get("download") or ""),
            "logPath": str(log_path),
        }
        job_path = temp / "job.json"
        _write_job(job_path, job)
        command = [
            _powershell(),
            "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", str(helper),
            "-JobFile", str(job_path),
            "-LogPath", str(log_path),
        ]
        subprocess.Popen(
            command,
            cwd=str(temp),
            env=dict(os.environ),
            creationflags=_creation_flags(),
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except UpdateError:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    except OSError:
        shutil.rmtree(temp, ignore_errors=True)
        raise UpdateError("无法启动更新安装程序，请稍后重试。") from None


def cleanup_prepared(prepared: dict) -> None:
    """Remove the staged tree and temp download; the backup and the install root stay."""
    try:
        if not isinstance(prepared, dict):
            return
        root_value = prepared.get("root")
        root_path = Path(str(root_value)).resolve() if root_value else None
        staged_value = prepared.get("staged")
        if staged_value:
            staged_path = Path(str(staged_value))
            allowed = staged_path.parent
            if root_path is not None and _same_directory(allowed, root_path.parent) \
                    and not _same_directory(staged_path, root_path):
                shutil.rmtree(staged_path, ignore_errors=True)
        temp_value = prepared.get("temp")
        if temp_value:
            temp_path = Path(str(temp_value))
            if temp_path.name.startswith("go-antigravity-update-"):
                if root_path is None or (
                        not _is_within(temp_path, root_path)
                        and not _same_directory(temp_path, root_path)):
                    shutil.rmtree(temp_path, ignore_errors=True)
    except OSError:
        # Cleanup is best effort: the caller is closing the app and must not fail on a stale path.
        return
