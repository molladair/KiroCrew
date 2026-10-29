"""Installing a theme from an uploaded ``.zip`` (``POST /api/themes/install-zip``).

``theme_zip.extract_theme_zip`` turns the archive into a directory, and the
handler hands that directory to the same install pipeline a local folder uses.
These tests cover what only an archive can express (traversal names, symlink
entries, size inflation, macOS metadata, a wrapping folder) and the HTTP surface
(size cap, empty body, governance, a pack landing under ``themes/``).

Every test points ``KIROCREW_HOME`` at ``tmp_path``. The HTTP tests run a real
aiohttp app on an OS-assigned loopback port.
"""

from __future__ import annotations

import io
import json
import os
import stat
import zipfile
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import kiro_crew.platform.governance_profiles as gov_mod
from kiro_crew.dashboard import theme_zip
from kiro_crew.dashboard.handlers import themes as th

_VARS = {
    "dark": {"--bg": "#000000", "--text": "#ffffff", "--accent": "#3366ff"},
    "light": {"--bg": "#ffffff", "--text": "#000000", "--accent": "#0033cc"},
}
_MANIFEST = {"slug": "zipped", "name": "Zipped", "emoji": "🎃", "level": 0, "formatVersion": 1}


def _zip(entries: dict[str, bytes | str], *, symlinks: tuple[str, ...] = ()) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            info = zipfile.ZipInfo(name)
            if name in symlinks:
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            else:
                info.external_attr = (stat.S_IFREG | 0o644) << 16
            zf.writestr(info, data)
    return buf.getvalue()


def _pack_entries(prefix: str = "") -> dict[str, bytes | str]:
    return {
        f"{prefix}theme.json": json.dumps(_MANIFEST),
        f"{prefix}variables.json": json.dumps(_VARS),
    }


@pytest.fixture
def themes_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "crew-home"
    home.mkdir()
    monkeypatch.setenv("KIROCREW_HOME", str(home))
    d = home / "themes"
    d.mkdir()
    assert os.path.realpath(str(th._themes_dir())) == os.path.realpath(str(d))
    return d


@pytest.fixture
def allow_install(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Allowed:
        permitted = True
        rule = "capabilities.theme_install"
        layer = "standalone"
        reason = ""

    monkeypatch.setattr(gov_mod, "governance_permits", lambda *a, **k: _Allowed())


class TestExtractThemeZip:
    def test_pack_at_the_archive_root(self, tmp_path: Path) -> None:
        root = theme_zip.extract_theme_zip(_zip(_pack_entries()), tmp_path)
        assert root == tmp_path
        assert (root / "theme.json").is_file()

    def test_pack_wrapped_in_one_folder_returns_that_folder(self, tmp_path: Path) -> None:
        entries = _pack_entries("haunted/")
        entries["__MACOSX/haunted/._theme.json"] = b"\x00\x05\x16\x07"
        entries["haunted/.DS_Store"] = b"junk"
        root = theme_zip.extract_theme_zip(_zip(entries), tmp_path)
        assert root == tmp_path / "haunted"
        assert sorted(p.name for p in root.iterdir()) == ["theme.json", "variables.json"]
        assert not (tmp_path / "__MACOSX").exists()

    @pytest.mark.parametrize(
        "name",
        [
            "../escape.json",
            "pack/../../escape.json",
            "/etc/escape.json",
            "C:/escape.json",
            "a\\b.json",
        ],
    )
    def test_entries_that_leave_the_directory_are_refused(self, tmp_path: Path, name: str) -> None:
        dest = tmp_path / "dest"
        dest.mkdir()
        entries = _pack_entries()
        entries[name] = "x"
        with pytest.raises(ValueError):
            theme_zip.extract_theme_zip(_zip(entries), dest)
        assert not (tmp_path / "escape.json").exists()

    def test_a_symlink_entry_is_refused(self, tmp_path: Path) -> None:
        entries = _pack_entries()
        entries["link"] = "/etc/passwd"
        with pytest.raises(ValueError, match="not a regular file"):
            theme_zip.extract_theme_zip(_zip(entries, symlinks=("link",)), tmp_path)
        assert not (tmp_path / "link").exists()

    def test_declared_size_over_the_cap_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(theme_zip, "_MAX_UNPACKED_BYTES", 100)
        entries = _pack_entries()
        entries["big.txt"] = "a" * 200
        with pytest.raises(ValueError, match="more than a theme"):
            theme_zip.extract_theme_zip(_zip(entries), tmp_path)
        assert not (tmp_path / "big.txt").exists()

    def test_a_header_that_under_reports_its_size_cannot_inflate(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The declared total passes; the bytes actually written are counted too.
        monkeypatch.setattr(theme_zip, "_MAX_UNPACKED_BYTES", 1000)
        data = _zip({"big.txt": "a" * 5000})
        real_infolist = zipfile.ZipFile.infolist

        def _lying_infolist(self: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
            infos = real_infolist(self)
            for info in infos:
                info.file_size = 10
            return infos

        monkeypatch.setattr(zipfile.ZipFile, "infolist", _lying_infolist)
        with pytest.raises(ValueError):
            theme_zip.extract_theme_zip(data, tmp_path)

    def test_too_many_entries_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(theme_zip, "_MAX_ENTRIES", 2)
        entries = _pack_entries()
        entries["extra.txt"] = "x"
        with pytest.raises(ValueError, match="too many entries"):
            theme_zip.extract_theme_zip(_zip(entries), tmp_path)

    def test_not_a_zip(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="not a valid .zip"):
            theme_zip.extract_theme_zip(b"definitely not a zip", tmp_path)


async def _post(data: bytes) -> tuple[int, dict]:
    app = web.Application()
    app.router.add_post("/api/themes/install-zip", th.api_themes_install_zip)
    async with TestClient(TestServer(app, host="127.0.0.1", port=0)) as client:
        resp = await client.post(
            "/api/themes/install-zip",
            data=data,
            headers={"Content-Type": "application/zip"},
        )
        return resp.status, await resp.json()


class TestInstallZipRoute:
    @pytest.mark.asyncio
    async def test_installs_a_wrapped_pack(self, themes_dir: Path, allow_install: None) -> None:
        status, body = await _post(_zip(_pack_entries("Zipped Theme/")))
        assert status == 200, body
        assert body["slug"] == "zipped"
        assert body["theme"]["source"] == "upload"
        assert (themes_dir / "zipped" / "theme.json").is_file()

    @pytest.mark.asyncio
    async def test_a_refused_archive_installs_nothing(
        self, themes_dir: Path, allow_install: None
    ) -> None:
        entries = _pack_entries()
        entries["../escape.json"] = "x"
        status, body = await _post(_zip(entries))
        assert status == 400
        assert "leaves the archive" in body["error"]
        assert list(themes_dir.iterdir()) == []

    @pytest.mark.asyncio
    async def test_an_invalid_pack_reports_the_validator_error(
        self, themes_dir: Path, allow_install: None
    ) -> None:
        status, body = await _post(_zip({"readme.md": "no manifest here"}))
        assert status == 400
        assert body["error"]
        assert list(themes_dir.iterdir()) == []

    @pytest.mark.asyncio
    async def test_empty_body_is_400(self, themes_dir: Path, allow_install: None) -> None:
        status, body = await _post(b"")
        assert status == 400
        assert body["error"] == "no theme archive was uploaded"

    @pytest.mark.asyncio
    async def test_oversized_upload_is_413(
        self, themes_dir: Path, allow_install: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(th, "THEME_ZIP_MAX_UPLOAD_BYTES", 64)
        status, body = await _post(_zip(_pack_entries()))
        assert status == 413
        assert list(themes_dir.iterdir()) == []

    @pytest.mark.asyncio
    async def test_governance_denial_is_403(
        self, themes_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class _Denied:
            permitted = False
            rule = "capabilities.theme_install"
            layer = "policy"
            reason = "theme installs are disabled here"

        monkeypatch.setattr(gov_mod, "governance_permits", lambda *a, **k: _Denied())
        status, body = await _post(_zip(_pack_entries()))
        assert status == 403
        assert body["error"] == "theme installs are disabled here"
        assert list(themes_dir.iterdir()) == []

    @pytest.mark.asyncio
    async def test_the_temporary_unpack_is_removed(
        self, themes_dir: Path, allow_install: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        made: list[Path] = []
        real_mkdtemp = th.tempfile.mkdtemp

        def _recording_mkdtemp(*a: object, **k: object) -> str:
            path = real_mkdtemp(*a, **k)  # type: ignore[arg-type]
            made.append(Path(path))
            return path

        monkeypatch.setattr(th.tempfile, "mkdtemp", _recording_mkdtemp)
        status, _ = await _post(_zip(_pack_entries()))
        assert status == 200
        assert made and all(not p.exists() for p in made)
