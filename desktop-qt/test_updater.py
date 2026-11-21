"""Updater regressions: release selection, safe extraction and the installer hand-off.

Everything here runs offline against synthetic fixtures: no GitHub request, no real release
asset, no Qt import and no process is ever started (the PowerShell swap is covered by
scripts/update-install-tests.ps1).
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

import updater

ASSET_URL = ("https://github.com/cooleava1-gif/Go-Antigravity/releases/download/v1.1.0/"
             + updater.ASSET_NAME)
RELEASE_PAGE = "https://github.com/cooleava1-gif/Go-Antigravity/releases/tag/v1.1.0"
EXPECTED_REQUIRED_FILES = {
    "Go-Antigravity.exe",
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
    "desktop-qt/update_install.ps1",
}


def write_file(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@contextmanager
def clean_environment(**values):
    """Run with the update-relevant environment variables fully controlled."""
    keys = ("GO_ANTIGRAVITY_DATA_DIR", "GO_ANTIGRAVITY_PACKAGED", "LOCALAPPDATA", "APPDATA")
    saved = {key: os.environ.get(key) for key in keys}
    try:
        for key in keys:
            os.environ.pop(key, None)
        for key, value in values.items():
            if value is not None:
                os.environ[key] = str(value)
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextmanager
def temp_under(base: Path):
    """Keep updater temp folders inside the test base so cleanup can be observed."""
    counter = itertools.count()

    def fake_mkdtemp(prefix: str = "") -> str:
        path = Path(base) / f".temp-{next(counter)}"
        path.mkdir(parents=True, exist_ok=False)
        return str(path)

    with patch.object(updater.tempfile, "mkdtemp", fake_mkdtemp):
        yield


def make_packaged_install(base: Path, *, version: str = "1.0.0", helper: bool = True,
                          updater_module: bool = True, update_ui_module: bool = True,
                          git: bool = False) -> Path:
    root = base / "Go-Antigravity-windows-x64"
    for relative in sorted(EXPECTED_REQUIRED_FILES):
        if relative == "desktop-qt/update_install.ps1" and not helper:
            continue
        if relative == "desktop-qt/updater.py" and not updater_module:
            continue
        if relative == "desktop-qt/update_ui.py" and not update_ui_module:
            continue
        write_file(root / relative, "synthetic " + relative)
    write_file(root / "backend/node_modules/ws/index.js", "third-party dependency")
    write_file(root / "runtime/manifest.json", json.dumps({
        "package": "Go-Antigravity",
        "platform": "windows-x64",
        "version": version,
        "commit": "abc1234",
        "launcher": "Go-Antigravity.exe",
    }))
    if git:
        write_file(root / ".git" / "HEAD", "ref: refs/heads/main")
    return root


def make_source_checkout(base: Path, version: str = "1.0.0") -> Path:
    root = base / "source"
    write_file(root / "backend/package.json", json.dumps({"name": "go-antigravity", "version": version}))
    write_file(root / "desktop-qt/main.py", "print('dev')")
    return root


def release_payload(version: str = "1.1.0", *, digest: str | None = "sha256:" + "a" * 64,
                    assets: list | None = None, draft: bool = False, prerelease: bool = False,
                    tag: str | None = None, body: str = "release notes",
                    published: str = "2026-11-01T00:00:00Z",
                    html_url: str | None = None) -> dict:
    if assets is None:
        asset = {
            "name": updater.ASSET_NAME,
            "size": 1234,
            "browser_download_url": ASSET_URL,
        }
        if digest is not None:
            asset["digest"] = digest
        assets = [asset]
    return {
        "tag_name": tag if tag is not None else "v" + version,
        "draft": draft,
        "prerelease": prerelease,
        "assets": assets,
        "body": body,
        "published_at": published,
        "html_url": html_url if html_url is not None else RELEASE_PAGE,
    }


def make_zip(path: Path, *, version: str = "1.1.0", root: str = "Go-Antigravity-windows-x64",
             omit: tuple = (), extra: dict | None = None, manifest: dict | bytes | None = None,
             symlink_name: str | None = None, stray_top_level: str | None = None,
             include_manifest: bool = True) -> Path:
    entries = {}
    if manifest is None:
        manifest_bytes = json.dumps({
            "package": "Go-Antigravity",
            "platform": "windows-x64",
            "version": version,
            "commit": "abc1234",
        }).encode("utf-8")
    elif isinstance(manifest, bytes):
        manifest_bytes = manifest
    else:
        manifest_bytes = json.dumps(manifest).encode("utf-8")
    if include_manifest:
        entries[f"{root}/runtime/manifest.json"] = manifest_bytes
    for relative in sorted(EXPECTED_REQUIRED_FILES):
        if relative in omit:
            continue
        entries[f"{root}/{relative}"] = ("synthetic " + relative).encode("utf-8")
    entries[f"{root}/backend/node_modules/ws/index.js"] = b"third-party dependency"
    for name, data in (extra or {}).items():
        entries[name] = data
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        if symlink_name:
            info = zipfile.ZipInfo(symlink_name)
            info.external_attr = (0o120777 << 16)
            archive.writestr(info, b"target")
        if stray_top_level:
            archive.writestr(stray_top_level, b"stray")
    return path


class FakeDownload:
    """Stand-in for updater._download: writes a fixture archive and reports progress."""

    def __init__(self, payload: bytes, *, sha256: str | None = None, size: int | None = None,
                 cancel_at_start: bool = False):
        self.payload = payload
        self.sha256 = sha256
        self.size = size
        self.cancel_at_start = cancel_at_start
        self.calls: list[dict] = []

    def __call__(self, url, destination, *, expected_size=0, progress=None, cancel=None,
                 timeout=None):
        self.calls.append({"url": url, "expected_size": expected_size,
                           "destination": str(destination)})
        if self.cancel_at_start:
            raise updater.UpdateError("更新已取消。")
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(self.payload)
        if progress is not None:
            progress(0, len(self.payload))
            progress(len(self.payload), len(self.payload))
        return {
            "size": len(self.payload) if self.size is None else self.size,
            "sha256": self.sha256 or hashlib.sha256(self.payload).hexdigest(),
        }


class FakeResponse:
    def __init__(self, chunks, headers=None):
        self._chunks = list(chunks)
        self.headers = headers or {}

    def read(self, size=-1):
        return self._chunks.pop(0) if self._chunks else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request.full_url)
        return self.response


class BaseFixture(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="go-antigravity-updater-test-"))
        self.addCleanup(shutil.rmtree, self.base, True)

    def leftovers(self) -> list[str]:
        return sorted(entry.name for entry in self.base.iterdir())


class ReadBuildTests(BaseFixture):
    def test_source_checkout_is_not_installable(self):
        root = make_source_checkout(self.base)
        with clean_environment():
            build = updater.read_build(root)
        self.assertEqual(build["version"], "1.0.0")
        self.assertFalse(build["packaged"])
        self.assertFalse(build["install_supported"])
        self.assertIn("源码", build["install_reason"])
        self.assertEqual(build["repository"], "cooleava1-gif/Go-Antigravity")

    def test_packaged_install_with_external_data_is_installable(self):
        root = make_packaged_install(self.base)
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            build = updater.read_build(root)
        self.assertTrue(build["packaged"])
        self.assertTrue(build["install_supported"])
        self.assertEqual(build["version"], "1.0.0")
        self.assertEqual(build["commit"], "abc1234")
        self.assertEqual(build["install_reason"], "")

    def test_packaged_install_defaults_to_localappdata(self):
        root = make_packaged_install(self.base)
        local = self.base / "LocalAppData"
        with clean_environment(LOCALAPPDATA=str(local)):
            build = updater.read_build(root)
        self.assertTrue(build["install_supported"])
        self.assertEqual(build["install_reason"], "")
        self.assertEqual(Path(build["data_directory"]), (local / "Go-Antigravity").resolve())

    def test_data_directory_inside_root_blocks_in_place_update(self):
        root = make_packaged_install(self.base)
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR="data"):
            build = updater.read_build(root)
        self.assertTrue(build["packaged"])
        self.assertFalse(build["install_supported"])
        self.assertIn("数据目录位于安装目录内", build["install_reason"])
        self.assertEqual(Path(build["data_directory"]), (root / "data").resolve())

    def test_git_tree_blocks_in_place_update(self):
        root = make_packaged_install(self.base, git=True)
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            build = updater.read_build(root)
        self.assertTrue(build["packaged"])
        self.assertFalse(build["install_supported"])
        self.assertIn(".git", build["install_reason"])

    def test_missing_helper_keeps_version_visible_but_blocks_install(self):
        root = make_packaged_install(self.base, helper=False)
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            build = updater.read_build(root)
        self.assertTrue(build["packaged"])
        self.assertEqual(build["version"], "1.0.0")
        self.assertFalse(build["install_supported"])
        self.assertIn("update_install.ps1", build["install_reason"])

    def test_current_install_without_update_ui_blocks_install(self):
        root = make_packaged_install(self.base, update_ui_module=False)
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            build = updater.read_build(root)
        self.assertTrue(build["packaged"])
        self.assertEqual(build["version"], "1.0.0")
        self.assertFalse(build["install_supported"])
        self.assertIn("desktop-qt/update_ui.py", build["install_reason"])

    def test_package_without_update_ui_is_rejected(self):
        root = make_packaged_install(self.base, version="1.1.0", update_ui_module=False)
        with self.assertRaises(updater.UpdateError) as raised:
            updater._verify_package(root, "1.1.0")
        self.assertIn("desktop-qt/update_ui.py", str(raised.exception))

    def test_broken_manifest_is_not_packaged(self):
        root = make_packaged_install(self.base)
        write_file(root / "runtime/manifest.json", "{not json")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            build = updater.read_build(root)
        self.assertFalse(build["packaged"])
        self.assertFalse(build["install_supported"])
        self.assertIn("无效", build["install_reason"])

    def test_list_shaped_package_json_does_not_break_read_build(self):
        root = make_source_checkout(self.base)
        write_file(root / "backend/package.json", json.dumps([1, 2, 3]))
        with clean_environment():
            build = updater.read_build(root)
        self.assertEqual(build["version"], "0.0.0")
        self.assertFalse(build["install_supported"])

    def test_helper_script_is_local_and_offline(self):
        helper = Path(updater.__file__).with_name("update_install.ps1")
        source = helper.read_text(encoding="utf-8")
        self.assertIn("-NoRestart", source)
        self.assertNotIn("http://", source)
        self.assertNotIn("https://", source)
        self.assertIn("Wait-ForProcessExit", source)
        self.assertIn("Move-RootWithRetry", source)
        self.assertIn("rollback-restored-after-restart-failure", source)

    def test_required_install_files_contract(self):
        self.assertEqual(set(updater.REQUIRED_INSTALL_FILES), EXPECTED_REQUIRED_FILES)
        self.assertEqual(updater.REPOSITORY, "cooleava1-gif/Go-Antigravity")
        self.assertEqual(updater.ASSET_NAME, "Go-Antigravity-windows-x64.exe")

    def test_module_does_not_import_qt(self):
        source = Path(updater.__file__).read_text(encoding="utf-8")
        self.assertNotIn("PyQt6", source)


class CheckForUpdateTests(BaseFixture):
    def check(self, payload, *, version="1.0.0", sidecar_text=None):
        root = make_source_checkout(self.base, version)
        with clean_environment(), \
                patch.object(updater, "_fetch_json", lambda url, timeout=None: payload) as fetch, \
                patch.object(updater, "_fetch_text",
                             lambda url, timeout=None: sidecar_text or "") as text:
            result = updater.check_for_update(root)
        self.fetch = fetch
        self.text = text
        return result

    def test_newer_release_is_available_with_digest(self):
        payload = release_payload("1.1.0")
        result = self.check(payload)
        self.assertTrue(result["available"])
        self.assertEqual(result["reason"], "newer")
        self.assertEqual(result["latest"], "1.1.0")
        self.assertEqual(result["asset"]["name"], updater.ASSET_NAME)
        self.assertEqual(result["asset"]["sha256"], "a" * 64)
        self.assertEqual(result["asset"]["size"], 1234)
        self.assertEqual(result["release_url"], RELEASE_PAGE)
        self.assertEqual(result["notes"], "release notes")
        self.assertEqual(result["published_at"], "2026-11-01T00:00:00Z")
        self.assertEqual(result["current"]["version"], "1.0.0")

    def test_same_version_is_not_available(self):
        payload = release_payload("1.0.0")
        result = self.check(payload)
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "up-to-date")
        self.assertIsNone(result["asset"])

    def test_downgrade_is_not_available(self):
        result = self.check(release_payload("0.9.9"))
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "up-to-date")

    def test_v_prefixed_tag_is_normalized(self):
        result = self.check(release_payload("1.1.0", tag="v1.1.0"))
        self.assertEqual(result["latest"], "1.1.0")
        self.assertTrue(result["available"])

    def test_prerelease_is_not_offered(self):
        result = self.check(release_payload("1.2.0", tag="v1.2.0-beta.1", prerelease=True))
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "prerelease")
        self.assertIsNone(result["asset"])

    def test_semver_prerelease_suffix_is_not_offered(self):
        result = self.check(release_payload("1.2.0", tag="v1.2.0-rc.1"))
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "prerelease")

    def test_draft_release_is_rejected(self):
        with self.assertRaises(updater.UpdateError) as caught:
            self.check(release_payload("1.1.0", draft=True))
        self.assertIn("草稿", str(caught.exception))

    def test_missing_asset_is_rejected(self):
        with self.assertRaises(updater.UpdateError) as caught:
            self.check(release_payload("1.1.0", assets=[]))
        self.assertIn("安装包", str(caught.exception))

    def test_asset_without_checksum_is_rejected(self):
        payload = release_payload("1.1.0", digest=None)
        with self.assertRaises(updater.UpdateError) as caught:
            self.check(payload, sidecar_text="")
        self.assertIn("SHA-256", str(caught.exception))

    def test_sidecar_checksum_is_used_when_digest_is_missing(self):
        payload = release_payload("1.1.0", digest=None)
        payload["assets"].append({
            "name": updater.ASSET_NAME + ".sha256",
            "size": 100,
            "browser_download_url": ASSET_URL + ".sha256",
        })
        result = self.check(payload, sidecar_text=("b" * 64) + "  " + updater.ASSET_NAME)
        self.assertEqual(result["asset"]["sha256"], "b" * 64)

    def test_foreign_asset_host_is_rejected(self):
        payload = release_payload("1.1.0")
        payload["assets"][0]["browser_download_url"] = "https://evil.example.com/asset.zip"
        with self.assertRaises(updater.UpdateError) as caught:
            self.check(payload)
        self.assertIn("GitHub", str(caught.exception))

    def test_foreign_release_page_is_rejected(self):
        payload = release_payload("1.1.0", html_url="https://evil.example.com/releases")
        with self.assertRaises(updater.UpdateError):
            self.check(payload)

    def test_network_error_is_reported_in_chinese(self):
        root = make_source_checkout(self.base)

        def explode(url, timeout=None):
            raise updater.UpdateError("无法连接 GitHub 检查更新，请检查网络或代理设置。")

        with clean_environment(), patch.object(updater, "_fetch_json", explode):
            with self.assertRaises(updater.UpdateError) as caught:
                updater.check_for_update(root)
        self.assertIn("网络", str(caught.exception))


class DownloadTests(BaseFixture):
    def test_download_streams_to_part_then_final_name(self):
        destination = self.base / "asset.zip"
        response = FakeResponse([b"abc", b"def"], headers={"Content-Length": "6"})
        seen = []
        with patch.object(updater, "_opener", lambda hosts: FakeOpener(response)):
            result = updater._download(ASSET_URL, destination,
                                       progress=lambda received, total: seen.append((received, total)))
        self.assertEqual(result["size"], 6)
        self.assertEqual(result["sha256"], hashlib.sha256(b"abcdef").hexdigest())
        self.assertEqual(destination.read_bytes(), b"abcdef")
        self.assertFalse((self.base / "asset.zip.part").exists())
        self.assertEqual(seen[0], (0, 6))
        self.assertEqual(seen[-1], (6, 6))

    def test_download_cancel_removes_partial_file(self):
        destination = self.base / "asset.zip"
        cancel = threading.Event()
        cancel.set()
        response = FakeResponse([b"abc"])
        with patch.object(updater, "_opener", lambda hosts: FakeOpener(response)):
            with self.assertRaises(updater.UpdateError) as caught:
                updater._download(ASSET_URL, destination, cancel=cancel)
        self.assertIn("取消", str(caught.exception))
        self.assertFalse(destination.exists())
        self.assertFalse((self.base / "asset.zip.part").exists())

    def test_insecure_url_is_rejected_before_any_request(self):
        with self.assertRaises(updater.UpdateError):
            updater._validate_asset_url("http://github.com/cooleava1-gif/Go-Antigravity/releases/download/v1/x.zip")
        with self.assertRaises(updater.UpdateError):
            updater._validate_asset_url("https://github.com/other/repo/releases/download/v1/x.zip")
        with self.assertRaises(updater.UpdateError):
            updater._check_download_host("https://evil.example.com/x.zip", updater.DOWNLOAD_HOSTS)

    def test_asset_cdn_redirect_target_is_allowed(self):
        url = "https://objects.githubusercontent.com/github-production-release-asset/1?a=b"
        self.assertEqual(updater._check_download_host(url, updater.DOWNLOAD_HOSTS), url)


class PrepareTests(BaseFixture):
    def prepare(self, root: Path, zip_path: Path, *, version: str = "1.1.0",
                sha256: str | None = None, size: int | None = None,
                cancel_at_start: bool = False, asset_name: str = None,
                asset_url: str = ASSET_URL, progress=None):
        payload = zip_path.read_bytes()
        asset = {
            "name": asset_name or updater.ASSET_NAME,
            "url": asset_url,
            "size": len(payload) if size is None else size,
            "sha256": sha256 if sha256 is not None else hashlib.sha256(payload).hexdigest(),
        }
        release = {"version": version, "asset": asset, "release_url": RELEASE_PAGE,
                   "published_at": "2026-11-01T00:00:00Z"}
        self.download = FakeDownload(payload, cancel_at_start=cancel_at_start)
        with patch.object(updater, "_download", self.download):
            return updater.prepare_update(root, release, progress=progress)

    def assert_no_staging_left(self):
        leftovers = [name for name in self.leftovers()
                     if name.startswith(".") or ".update-" in name or ".extract-" in name
                     or ".backup-" in name]
        self.assertEqual(leftovers, [])

    def test_prepare_downloads_verifies_and_stages(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        seen = []
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            prepared = self.prepare(root, zip_path, progress=lambda r, t: seen.append((r, t)))
        self.addCleanup(updater.cleanup_prepared, prepared)
        staged = Path(prepared["staged"])
        self.assertTrue(staged.is_dir())
        self.assertEqual(staged.parent.resolve(), root.parent.resolve())
        self.assertTrue(staged.name.startswith("."))
        self.assertTrue((staged / "runtime/manifest.json").is_file())
        self.assertTrue((staged / "backend/node_modules/ws/index.js").is_file())
        self.assertTrue(Path(prepared["download"]).is_file())
        self.assertFalse(updater._is_within(prepared["temp"], root))
        self.assertEqual(prepared["version"], "1.1.0")
        self.assertEqual(prepared["asset_sha256"], hashlib.sha256(zip_path.read_bytes()).hexdigest())
        self.assertEqual(prepared["asset_size"], len(zip_path.read_bytes()))
        self.assertEqual(seen[-1][0], len(zip_path.read_bytes()))
        self.assertEqual(self.download.calls[0]["expected_size"], len(zip_path.read_bytes()))
        self.assertEqual(self.download.calls[0]["url"], ASSET_URL)
        self.assertEqual(Path(prepared["backup"]).parent.resolve(), root.parent.resolve())
        self.assertFalse(Path(prepared["backup"]).exists())

    def test_prepare_rejects_same_version(self):
        root = make_packaged_install(self.base, version="1.1.0")
        zip_path = make_zip(self.base / "asset.zip", version="1.1.0")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path, version="1.1.0")
        self.assertIn("最新版本", str(caught.exception))

    def test_prepare_rejects_source_directory(self):
        root = make_source_checkout(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment():
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("源码", str(caught.exception))

    def test_prepare_rejects_install_with_data_inside_root(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR="data"):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("数据目录", str(caught.exception))

    def test_checksum_mismatch_cleans_everything(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")), temp_under(self.base):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path, sha256="0" * 64)
        self.assertIn("SHA-256", str(caught.exception))
        for name in self.leftovers():
            self.assertFalse(name.startswith(".temp-") or ".update-" in name or ".extract-" in name,
                             name)

    def test_size_mismatch_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path, size=len(zip_path.read_bytes()) + 10)
        self.assertIn("大小", str(caught.exception))

    def test_cancel_during_download_cleans_everything(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")), temp_under(self.base):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path, cancel_at_start=True)
        self.assertIn("取消", str(caught.exception))
        for name in self.leftovers():
            self.assertFalse(name.startswith(".temp-") or ".update-" in name or ".extract-" in name,
                             name)

    def test_parent_traversal_zip_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip", extra={"../evil.txt": b"evil"})
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("父目录", str(caught.exception))
        self.assertFalse((self.base / "evil.txt").exists())

    def test_absolute_path_zip_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip", extra={"/evil.txt": b"evil"})
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("绝对路径", str(caught.exception))

    def test_drive_letter_zip_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip", extra={"C:/evil.txt": b"evil"})
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("绝对路径", str(caught.exception))

    def test_windows_separator_paths_are_rejected(self):
        # zipfile rewrites os.sep when writing, so the guard is exercised where it lives.
        for name in ("Go-Antigravity-windows-x64\\evil.txt", "C:\\evil.txt", "..\\evil.txt"):
            with self.assertRaises(updater.UpdateError) as caught:
                updater._safe_member_name(name)
            self.assertIn("Windows 路径分隔符", str(caught.exception))

    def test_trailing_dot_component_zip_is_rejected(self):
        # "dir." and "dir" are the same directory to Win32, so a trailing dot could escape a guard.
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip",
                            extra={"Go-Antigravity-windows-x64/dir./evil.txt": b"evil"})
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("空格或点", str(caught.exception))
        self.assertFalse((self.base / "Go-Antigravity-windows-x64" / "dir").exists())

    def test_symlink_zip_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip",
                            symlink_name="Go-Antigravity-windows-x64/link.txt")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("符号链接", str(caught.exception))

    def test_single_root_is_required(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip", stray_top_level="stray.txt")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("单一安装目录", str(caught.exception))

    def test_manifest_version_mismatch_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip", version="9.9.9")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("版本", str(caught.exception))

    def test_missing_runtime_file_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip",
                            omit=("runtime/python/pythonw.exe",))
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("pythonw.exe", str(caught.exception))

    def test_missing_manifest_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip", include_manifest=False)
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path)
        self.assertIn("manifest", str(caught.exception))

    def test_wrong_asset_name_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path, asset_name="other.zip")
        self.assertIn(updater.ASSET_NAME, str(caught.exception))

    def test_foreign_download_host_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError):
                self.prepare(root, zip_path, asset_url="https://evil.example.com/asset.zip")

    def test_missing_checksum_is_rejected(self):
        root = make_packaged_install(self.base)
        zip_path = make_zip(self.base / "asset.zip")
        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")):
            with self.assertRaises(updater.UpdateError) as caught:
                self.prepare(root, zip_path, sha256="")
        self.assertIn("SHA-256", str(caught.exception))


class LaunchInstallerTests(BaseFixture):
    def setUp(self):
        super().setUp()
        self.root = make_packaged_install(self.base)
        self.staged = self.root.parent / ".Go-Antigravity-windows-x64.update-test"
        write_file(self.staged / "runtime/manifest.json", "{}")
        self.backup = self.root.parent / "Go-Antigravity-windows-x64.backup-test"
        self.prepared = {
            "version": "1.1.0",
            "root": str(self.root),
            "staged": str(self.staged),
            "backup": str(self.backup),
            "download": str(self.base / "asset.zip"),
            "temp": str(self.base / ".temp-download"),
            "asset_name": updater.ASSET_NAME,
            "asset_size": 10,
            "asset_sha256": "a" * 64,
            "release_url": RELEASE_PAGE,
            "published_at": "2026-11-01T00:00:00Z",
        }

    def launch(self, prepared=None):
        captured = {}

        class FakeProcess:
            pass

        def fake_popen(command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
            return FakeProcess()

        with clean_environment(GO_ANTIGRAVITY_DATA_DIR=str(self.base / "data")), \
                patch.object(updater.subprocess, "Popen", fake_popen):
            updater.launch_installer(self.root, prepared or self.prepared)
        self.addCleanup(shutil.rmtree, captured["kwargs"]["cwd"], True)
        return captured

    def test_helper_is_copied_outside_root_into_temp(self):
        captured = self.launch()
        workdir = Path(captured["kwargs"]["cwd"])
        self.assertFalse(updater._is_within(workdir, self.root))
        helper = workdir / "update_install.ps1"
        self.assertTrue(helper.is_file())
        self.assertEqual(helper.read_bytes(),
                         (self.root / "desktop-qt/update_install.ps1").read_bytes())
        command = captured["command"]
        self.assertTrue(str(Path(command[0]).name).lower() == "powershell.exe")
        self.assertIn("-File", command)
        self.assertEqual(command[command.index("-File") + 1], str(helper))
        self.assertIn("-JobFile", command)
        self.assertIn("-LogPath", command)
        self.assertTrue(str(workdir / "job.json") in command)

    def test_job_file_is_utf8_bom_and_records_wait_pid(self):
        captured = self.launch()
        workdir = Path(captured["kwargs"]["cwd"])
        raw = (workdir / "job.json").read_bytes()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        job = json.loads(raw.decode("utf-8-sig"))
        self.assertEqual(job["waitPid"], os.getpid())
        self.assertEqual(job["root"], str(self.root.resolve()))
        self.assertEqual(job["staged"], str(self.staged))
        self.assertEqual(job["backup"], str(self.backup))
        self.assertEqual(job["launcher"], "Go-Antigravity.exe")
        self.assertEqual(job["retrySeconds"], updater.ROOT_RENAME_RETRY_SECONDS)
        self.assertTrue(job["restart"])
        self.assertEqual(job["download"], self.prepared["download"])

    def test_environment_is_inherited(self):
        captured = self.launch()
        env = captured["kwargs"]["env"]
        self.assertEqual(env["GO_ANTIGRAVITY_DATA_DIR"], str(self.base / "data"))
        self.assertEqual(env.get("GO_ANTIGRAVITY_NODE_EXE"), os.environ.get("GO_ANTIGRAVITY_NODE_EXE"))

    def test_popen_is_detached(self):
        captured = self.launch()
        if os.name == "nt":
            self.assertTrue(captured["kwargs"]["creationflags"] & 0x00000008)

    def test_missing_current_helper_is_rejected(self):
        helper = self.root / "desktop-qt/update_install.ps1"
        helper.unlink()
        with self.assertRaises(updater.UpdateError) as caught:
            self.launch()
        self.assertIn("更新安装脚本", str(caught.exception))

    def test_missing_staged_directory_is_rejected(self):
        shutil.rmtree(self.staged)
        with self.assertRaises(updater.UpdateError) as caught:
            self.launch()
        self.assertIn("重新下载", str(caught.exception))

    def test_prepared_from_another_root_is_rejected(self):
        other = dict(self.prepared)
        other["root"] = str(self.base / "elsewhere")
        with self.assertRaises(updater.UpdateError) as caught:
            self.launch(other)
        self.assertIn("不一致", str(caught.exception))

    def test_staged_outside_root_parent_is_rejected(self):
        other = dict(self.prepared)
        elsewhere = self.base / "nested"
        elsewhere.mkdir()
        other["staged"] = str(elsewhere / "staged-elsewhere")
        Path(other["staged"]).mkdir()
        with self.assertRaises(updater.UpdateError) as caught:
            self.launch(other)
        self.assertIn("旁边", str(caught.exception))

    def test_existing_backup_is_rejected(self):
        self.backup.mkdir()
        with self.assertRaises(updater.UpdateError) as caught:
            self.launch()
        self.assertIn("备份", str(caught.exception))


class CleanupTests(BaseFixture):
    def test_cleanup_removes_staged_and_temp_but_keeps_backup_and_root(self):
        root = make_packaged_install(self.base)
        staged = root.parent / ".Go-Antigravity-windows-x64.update-x"
        write_file(staged / "runtime/manifest.json", "{}")
        temp = self.base / "go-antigravity-update-abc"
        write_file(temp / "asset.zip", "zip")
        backup = root.parent / "Go-Antigravity-windows-x64.backup-20260101-000000"
        write_file(backup / "old.txt", "old")
        prepared = {"root": str(root), "staged": str(staged), "temp": str(temp), "backup": str(backup)}
        updater.cleanup_prepared(prepared)
        self.assertFalse(staged.exists())
        self.assertFalse(temp.exists())
        self.assertTrue(backup.is_dir())
        self.assertTrue((root / "runtime/manifest.json").is_file())

    def test_cleanup_never_touches_the_install_root(self):
        root = make_packaged_install(self.base)
        prepared = {"root": str(root), "staged": str(root), "temp": str(root)}
        updater.cleanup_prepared(prepared)
        self.assertTrue((root / "runtime/manifest.json").is_file())

    def test_cleanup_tolerates_unknown_payloads(self):
        updater.cleanup_prepared({})
        updater.cleanup_prepared(None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
