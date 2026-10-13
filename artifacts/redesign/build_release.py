#!/usr/bin/env python3
"""Build reproducible BitLoja release archive and its SHA-256 manifest."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
BASELINE_DIR = SCRIPT_DIR / "baseline"
BASELINE_SUMS = BASELINE_DIR / "SHA256SUMS.txt"
BASELINE_SUMS_SHA256 = "CAE4B21E4FC7A20856ECCE651123B11ABB616A8F99012400D7834D547D2E1951"
MANIFEST_PATH = SCRIPT_DIR / "release-manifest.json"
MANIFEST_PIN_PATH = SCRIPT_DIR / "release-manifest.sha256"
ARCHIVE_PATH = SCRIPT_DIR / "MODIFIED_FILE.zip"
DIFF_PATH = SCRIPT_DIR / "DIFF_FILE.patch"

ROOT_FILES = (
    ".gitignore",
    "app.py",
    "marketplace_features.py",
    "README.md",
    "requirements.txt",
    "env.example",
    "LICENSE",
    "run.bat",
    "run.sh",
    "bitcoin.conf.example",
    "lnd.conf.example",
    "design-qa.md",
)
SOURCE_DIRS = ("templates", "static", "docs", "tests")
BASELINE_PATHS = {
    "app.py",
    "templates/index.html",
    "env.example",
    "README.md",
    "requirements.txt",
}
UNCHANGED_TRACKED_FILES = {
    "LICENSE",
    "bitcoin.conf.example",
    "lnd.conf.example",
    "run.bat",
    "run.sh",
    "docs/screenshots/admin.png",
    "docs/screenshots/home.png",
    "docs/screenshots/product.png",
}
KNOWN_NEW_FILES = (
    "marketplace_features.py",
    "docs/security-wallets.md",
    "tests/test_marketplace.py",
    "design-qa.md",
    ".gitignore",
)
EXCLUDED_DIRS = {
    ".git",
    ".venv",
    ".runtime",
    "__pycache__",
    "node_modules",
    "artifacts",
    "image-sources",
    "rollback-test",
}
EXCLUDED_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".log",
    ".out",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".db-wal",
    ".db-shm",
    ".sqlite-wal",
    ".sqlite-shm",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".wallet",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
}
EXCLUDED_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    "marketplace.db",
    "wallet.dat",
    "credentials.json",
    "secrets.json",
}
EXCLUDED_NAME_MARKERS = ("private-key", "private_key", "credentials", "secret-key", "secret_key")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def is_excluded(relative: PurePosixPath) -> bool:
    parts = tuple(part.lower() for part in relative.parts)
    if any(part in EXCLUDED_DIRS for part in parts):
        return True
    name = parts[-1] if parts else ""
    suffixes = {suffix.lower() for suffix in Path(name).suffixes}
    if name in EXCLUDED_NAMES or suffixes.intersection(EXCLUDED_SUFFIXES):
        return True
    return any(marker in name for marker in EXCLUDED_NAME_MARKERS)


def load_baseline_hashes() -> dict[str, str]:
    if not BASELINE_SUMS.is_file():
        raise ValueError(f"Baseline checksums missing: {BASELINE_SUMS}")
    sums_data = BASELINE_SUMS.read_bytes()
    if sha256_bytes(sums_data) != BASELINE_SUMS_SHA256:
        raise ValueError("Immutable baseline checksum index changed")
    hashes: dict[str, str] = {}
    for line in sums_data.decode("utf-8").splitlines():
        digest, separator, name = line.strip().partition("  ")
        if not separator or len(digest) != 64:
            raise ValueError("Malformed baseline SHA256SUMS.txt")
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or name in hashes:
            raise ValueError(f"Invalid baseline path: {name}")
        source = BASELINE_DIR.joinpath(*relative.parts)
        if not source.is_file() or sha256_bytes(source.read_bytes()) != digest.upper():
            raise ValueError(f"Baseline hash mismatch: {name}")
        hashes[name] = digest.upper()
    if set(hashes) != BASELINE_PATHS:
        raise ValueError("Baseline checksum list differs from expected five source files")
    return hashes


def add_candidate(path: Path, found: dict[str, Path], excluded: list[str]) -> None:
    if not path.exists() or not path.is_file():
        return
    if path.is_symlink() or not is_within(path, REPO_ROOT):
        excluded.append(path.as_posix())
        return
    relative = PurePosixPath(path.relative_to(REPO_ROOT).as_posix())
    if is_excluded(relative):
        excluded.append(relative.as_posix())
        return
    found[relative.as_posix()] = path


def collect_files() -> tuple[dict[str, Path], list[str]]:
    found: dict[str, Path] = {}
    excluded: list[str] = []
    for name in ROOT_FILES:
        add_candidate(REPO_ROOT / name, found, excluded)
    for directory in SOURCE_DIRS:
        source_dir = REPO_ROOT / directory
        if not source_dir.is_dir():
            continue
        for path in sorted(source_dir.rglob("*")):
            if path.is_dir():
                continue
            add_candidate(path, found, excluded)
    missing_baseline = BASELINE_PATHS.difference(found)
    if missing_baseline:
        raise ValueError("Release omits baseline files: " + ", ".join(sorted(missing_baseline)))
    return dict(sorted(found.items())), excluded


def manifest_for(files: dict[str, Path], baseline_hashes: dict[str, str], diff_data: bytes) -> dict[str, object]:
    entries = []
    for relative, path in files.items():
        raw = path.read_bytes()
        entries.append({"path": relative, "bytes": len(raw), "sha256": sha256_bytes(raw)})
    restore_files = [
        {
            "path": path,
            "source": f"baseline/{path}",
            "sha256": baseline_hashes[path],
        }
        for path in sorted(BASELINE_PATHS)
    ]
    missing_new_files = set(KNOWN_NEW_FILES).difference(files)
    if missing_new_files:
        raise ValueError("known release files missing: " + ", ".join(sorted(missing_new_files)))
    file_hashes = {entry["path"]: entry["sha256"] for entry in entries}
    removable_files = set(KNOWN_NEW_FILES) | {
        path for path in files if path.startswith(("static/", "tests/"))
    }
    return {
        "schema_version": 2,
        "archive": ARCHIVE_PATH.name,
        "baseline_files": [
            {"path": path, "sha256": baseline_hashes[path]}
            for path in sorted(baseline_hashes)
        ],
        "diff": {
            "path": DIFF_PATH.name,
            "bytes": len(diff_data),
            "sha256": sha256_bytes(diff_data),
        },
        "files": entries,
        "rollback": {
            "restore_files": restore_files,
            "remove_files": [
                {"path": path, "sha256": file_hashes[path]}
                for path in sorted(removable_files)
            ],
        },
    }


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")


def diff_bytes(files: dict[str, Path]) -> bytes:
    """Create text diffs against the five-file baseline and metadata for binaries."""
    chunks: list[str] = []
    binary_metadata: list[str] = []
    for relative, source in files.items():
        if relative in UNCHANGED_TRACKED_FILES:
            continue
        current = source.read_bytes()
        baseline_path = BASELINE_DIR.joinpath(*PurePosixPath(relative).parts)
        old = baseline_path.read_bytes() if baseline_path.is_file() else None
        try:
            current.decode("utf-8")
            if old is not None:
                old.decode("utf-8")
            is_text = b"\0" not in current and (old is None or b"\0" not in old)
        except UnicodeDecodeError:
            is_text = False

        if is_text:
            old_lines = old.decode("utf-8").splitlines(keepends=True) if old is not None else []
            new_lines = current.decode("utf-8").splitlines(keepends=True)
            if old_lines == new_lines:
                continue
            from_name = f"a/{relative}" if old is not None else "/dev/null"
            to_name = f"b/{relative}"
            chunks.extend(difflib.unified_diff(
                old_lines,
                new_lines,
                fromfile=from_name,
                tofile=to_name,
                lineterm="\n",
            ))
            continue

        binary_metadata.append(
            f"diff --git a/{relative} b/{relative}\n"
            f"new file mode 100644\n"
            f"Binary files /dev/null and b/{relative} differ\n"
            f"# BINARY-METADATA bytes={len(current)} sha256={sha256_bytes(current)}\n"
        )

    if binary_metadata:
        if chunks and not chunks[-1].endswith("\n"):
            chunks.append("\n")
        chunks.extend(binary_metadata)
    return "".join(chunks).encode("utf-8")


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def build(dry_run: bool = False) -> int:
    baseline_hashes = load_baseline_hashes()
    files, excluded = collect_files()
    diff_data = diff_bytes(files)
    manifest = manifest_for(files, baseline_hashes, diff_data)
    manifest_data = json_bytes(manifest)
    if dry_run:
        print(f"DRY_RUN files={len(files)} excluded={len(excluded)} baseline_files={len(baseline_hashes)}")
        print("DRY_RUN baseline_sha256=" + sha256_bytes(BASELINE_SUMS.read_bytes()))
        return 0

    descriptor, temporary_name = tempfile.mkstemp(prefix=".MODIFIED_FILE.", suffix=".tmp", dir=SCRIPT_DIR)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative, source in files.items():
                info = zipfile.ZipInfo(relative, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, source.read_bytes())
            info = zipfile.ZipInfo(MANIFEST_PATH.name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, manifest_data)
        archive_data_hash = sha256_bytes(temporary.read_bytes())
        pin_data = f"{sha256_bytes(manifest_data)}  {MANIFEST_PATH.name}\n".encode("ascii")
        for output, expected in ((MANIFEST_PATH, manifest_data), (ARCHIVE_PATH, None), (MANIFEST_PIN_PATH, pin_data), (DIFF_PATH, diff_data)):
            if output.exists():
                if not output.is_file() or output.is_symlink():
                    raise ValueError(f"release output is not a regular file: {output}")
                current = output.read_bytes()
                matches = current == expected if expected is not None else sha256_bytes(current) == archive_data_hash
                if not matches:
                    raise ValueError(f"release output conflict; existing file left unchanged: {output}")
        if not MANIFEST_PATH.exists():
            write_atomic(MANIFEST_PATH, manifest_data)
        if not ARCHIVE_PATH.exists():
            temporary.replace(ARCHIVE_PATH)
        if not MANIFEST_PIN_PATH.exists():
            write_atomic(MANIFEST_PIN_PATH, pin_data)
        if not DIFF_PATH.exists():
            write_atomic(DIFF_PATH, diff_data)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"BUILD_OK archive={ARCHIVE_PATH} files={len(files)} excluded={len(excluded)} manifest={MANIFEST_PATH} diff={DIFF_PATH} manifest_sha256={sha256_bytes(manifest_data)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="validate file inventory without writing release artifacts")
    args = parser.parse_args()
    try:
        return build(dry_run=args.dry_run)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"BUILD_ERROR {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
