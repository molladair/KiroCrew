"""Unpack an uploaded theme ``.zip`` into a private directory for install.

The dashboard's local install source is a folder path on the GATEWAY host, so a
browser on another machine (a phone, a laptop reaching the gateway through a
tunnel) has no way to hand it a pack. ``POST /api/themes/install-zip`` takes the
archive bytes instead; this module turns them into a plain directory that the
existing install pipeline (stage -> validate -> promote) then treats exactly like
a local folder. Nothing here decides what a theme may contain: every allowlist,
size cap and content check stays in that pipeline.

What this module does refuse is the part only an ARCHIVE can express: an entry
that would land outside the extraction directory (absolute name, drive letter,
``..``), a symlink or other non-regular entry, and an archive whose declared or
actual uncompressed size is larger than the biggest pack the validator accepts.
Each file is written with a byte budget, so a header that under-reports its size
cannot inflate past the cap either.
"""

from __future__ import annotations

import io
import stat
import zipfile
from pathlib import Path, PurePosixPath

from kiro_crew.dashboard.theme_validate import (
    _THEME_ENTRIES_BY_LEVEL,
    _THEME_MANIFEST_NAME,
    _THEME_TOTAL_BYTES_BY_LEVEL,
)

#: The largest upload accepted, compressed. A pack that fits the validator's
#: biggest total also fits this, since zip never grows a stored file by more than
#: its small per-entry header.
THEME_ZIP_MAX_UPLOAD_BYTES = max(_THEME_TOTAL_BYTES_BY_LEVEL.values()) + 1024 * 1024

#: The largest total the archive may unpack to.
_MAX_UNPACKED_BYTES = max(_THEME_TOTAL_BYTES_BY_LEVEL.values())

#: Entries beyond the validator's biggest tier, with headroom for the folder
#: entries and macOS metadata an archiver adds and this module skips.
_MAX_ENTRIES = 4 * max(_THEME_ENTRIES_BY_LEVEL.values())

_COPY_CHUNK_BYTES = 64 * 1024


def _is_archiver_metadata(parts: tuple[str, ...]) -> bool:
    """True for files a desktop archiver adds that are never part of a pack."""
    if parts and parts[0] == "__MACOSX":
        return True
    leaf = parts[-1] if parts else ""
    return leaf == ".DS_Store" or leaf.startswith("._")


def _entry_parts(info: zipfile.ZipInfo) -> tuple[str, ...]:
    """The safe relative path parts of *info*, or raise ``ValueError``."""
    name = info.filename
    if "\\" in name or "\x00" in name:
        raise ValueError(f"archive entry has an unsupported name: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or (path.parts and ":" in path.parts[0]):
        raise ValueError(f"archive entry is an absolute path: {name!r}")
    parts = tuple(p for p in path.parts if p not in ("", "."))
    if ".." in parts:
        raise ValueError(f"archive entry leaves the archive: {name!r}")
    return parts


def _entry_is_regular_file(info: zipfile.ZipInfo) -> bool:
    """True when *info* is a regular file; ``False`` for a directory entry.

    Raises ``ValueError`` for a symlink or any other special file. An entry
    written by a non-Unix archiver carries no mode bits, which reads as 0 and
    counts as a regular file.
    """
    if info.is_dir():
        return False
    mode = (info.external_attr >> 16) & 0xFFFF
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFREG):
        raise ValueError(f"archive entry is not a regular file: {info.filename!r}")
    return True


def extract_theme_zip(data: bytes, dest: Path) -> Path:
    """Unpack *data* into the empty directory *dest* and return the pack root.

    The pack root is *dest* itself when ``theme.json`` sits at the top of the
    archive, or the single top-level folder when the archive wraps the pack in
    one (what zipping a folder produces). Raises ``ValueError`` with a message
    fit for the user when the archive is unreadable or refused.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError) as exc:
        raise ValueError("the file is not a valid .zip archive") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > _MAX_ENTRIES:
            raise ValueError("the archive has too many entries for a theme")
        declared = 0
        planned: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
        for info in infos:
            parts = _entry_parts(info)
            if not parts or _is_archiver_metadata(parts):
                continue
            if not _entry_is_regular_file(info):
                continue
            declared += info.file_size
            if declared > _MAX_UNPACKED_BYTES:
                raise ValueError("the archive unpacks to more than a theme may hold")
            planned.append((info, parts))
        written = 0
        for info, parts in planned:
            target = dest.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(info) as src, open(target, "xb") as out:
                    while True:
                        chunk = src.read(_COPY_CHUNK_BYTES)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > _MAX_UNPACKED_BYTES:
                            raise ValueError("the archive unpacks to more than a theme may hold")
                        out.write(chunk)
            except FileExistsError as exc:
                raise ValueError(f"archive lists a file twice: {info.filename!r}") from exc
            except (zipfile.BadZipFile, NotImplementedError, RuntimeError) as exc:
                # A corrupt member, an unsupported compression method, or an
                # encrypted entry.
                raise ValueError(f"cannot read archive entry {info.filename!r}") from exc
    if (dest / _THEME_MANIFEST_NAME).is_file():
        return dest
    children = list(dest.iterdir())
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return dest
