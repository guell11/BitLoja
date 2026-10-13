#!/usr/bin/env python3
"""Build experience-v2 release against the frozen 46-file current baseline."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
BASELINE_DIR = SCRIPT_DIR / "baseline"
BASELINE_SUMS = BASELINE_DIR / "SHA256SUMS.txt"
BASELINE_SUMS_SHA256 = "CF4FCB515626282FC0D3E1A0CB84AA8DD0E61DDB6FD83E1567FDDAFC109D44E2"
BASELINE_MANIFEST = BASELINE_DIR / "checkpoint-manifest.json"
BASELINE_MANIFEST_SHA256 = "F8EE4F277F47EF7AFBD5FFBC79D810E32916AAC0427B0A83F9EE60C45C799FA0"
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
    ".gitignore",
    "LICENSE",
    "README.md",
    "app.py",
    "bitcoin.conf.example",
    "design-qa.md",
    "docs/screenshots/admin.png",
    "docs/screenshots/home.png",
    "docs/screenshots/product.png",
    "docs/security-wallets.md",
    "env.example",
    "lnd.conf.example",
    "marketplace_features.py",
    "requirements.txt",
    "run.bat",
    "run.sh",
    "static/assets/bitcoin-bag.webp",
    "static/assets/bitcoin-cart.webp",
    "static/assets/bitcoin-crystal.webp",
    "static/assets/blue-brush.webp",
    "static/assets/products/backpack.webp",
    "static/assets/products/bottle.webp",
    "static/assets/products/headset.webp",
    "static/assets/products/keyboard.webp",
    "static/assets/products/lamp.webp",
    "static/assets/products/organizer.webp",
    "static/assets/products/ssd.webp",
    "static/assets/products/watch.webp",
    "static/assets/seller-parcel.webp",
    "static/css/auth.css",
    "static/css/bitloja.css",
    "static/css/cart.css",
    "static/css/dashboard.css",
    "static/css/glass.css",
    "static/fonts/ARCHIVO-OFL.txt",
    "static/fonts/CAVEAT-OFL.txt",
    "static/fonts/JETBRAINS-MONO-OFL.txt",
    "static/fonts/archivo-variable-latin.woff2",
    "static/fonts/bootstrap-icons.woff2",
    "static/fonts/caveat-variable-latin.woff2",
    "static/fonts/jetbrains-mono-variable-latin.woff2",
    "static/icons/LICENSE",
    "static/icons/bootstrap-icons.css",
    "static/js/bitloja.js",
    "templates/index.html",
    "tests/test_marketplace.py",
}
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


def is_redirected_path(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def require_real_path(path: Path, root: Path) -> None:
    """Reject redirected paths, including Windows junctions and root ancestors."""
    path, root = path.absolute(), root.absolute()
    relative = path.relative_to(root)
    for ancestor in (*reversed(root.parents), root):
        if is_redirected_path(ancestor):
            raise ValueError(f"redirected source ancestor: {ancestor}")
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if is_redirected_path(cursor):
            raise ValueError(f"redirected source path: {cursor}")
    if not is_within(path, root):
        raise ValueError(f"source path escaped root: {path}")


def real_file_inventory(root: Path) -> set[str]:
    require_real_path(root, root)
    if not root.is_dir():
        raise ValueError(f"source directory missing: {root}")
    found: set[str] = set()
    pending = [root]
    while pending:
        directory = pending.pop()
        require_real_path(directory, root)
        for path in directory.iterdir():
            require_real_path(path, root)
            if path.is_dir():
                pending.append(path)
            elif path.is_file():
                found.add(path.relative_to(root).as_posix())
            else:
                raise ValueError(f"source path is not a regular file or directory: {path}")
    return found


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
    require_real_path(BASELINE_DIR, SCRIPT_DIR)
    expected_files = BASELINE_PATHS | {"SHA256SUMS.txt", "checkpoint-manifest.json"}
    actual_files = real_file_inventory(BASELINE_DIR)
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        raise ValueError(f"baseline inventory mismatch missing={missing} extra={extra}")
    require_real_path(BASELINE_SUMS, SCRIPT_DIR)
    require_real_path(BASELINE_MANIFEST, SCRIPT_DIR)
    if not BASELINE_SUMS.is_file():
        raise ValueError(f"Baseline checksums missing: {BASELINE_SUMS}")
    sums_data = BASELINE_SUMS.read_bytes()
    if sha256_bytes(sums_data) != BASELINE_SUMS_SHA256:
        raise ValueError("Immutable baseline checksum index changed")
    manifest_data = BASELINE_MANIFEST.read_bytes()
    if sha256_bytes(manifest_data) != BASELINE_MANIFEST_SHA256:
        raise ValueError("Immutable checkpoint manifest changed")
    checkpoint = json.loads(manifest_data.decode("utf-8"))
    if checkpoint.get("schema_version") != 1 or checkpoint.get("source") != "current-packaged-source":
        raise ValueError("Checkpoint schema mismatch")
    entries = checkpoint.get("files")
    if not isinstance(entries, list) or len(entries) != 46:
        raise ValueError("Checkpoint must contain 46 source files")
    checkpoint_hashes = {entry["path"]: entry["sha256"].upper() for entry in entries}
    if set(checkpoint_hashes) != BASELINE_PATHS:
        raise ValueError("Checkpoint inventory differs from approved 46 paths")
    hashes: dict[str, str] = {}
    for line in sums_data.decode("utf-8").splitlines():
        digest, separator, name = line.strip().partition("  ")
        if not separator or len(digest) != 64:
            raise ValueError("Malformed baseline SHA256SUMS.txt")
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or name in hashes:
            raise ValueError(f"Invalid baseline path: {name}")
        source = BASELINE_DIR.joinpath(*relative.parts)
        require_real_path(source, BASELINE_DIR)
        if not source.is_file() or sha256_bytes(source.read_bytes()) != digest.upper():
            raise ValueError(f"Baseline hash mismatch: {name}")
        hashes[name] = digest.upper()
    if set(hashes) != BASELINE_PATHS or hashes != checkpoint_hashes:
        raise ValueError("Baseline checksums differ from approved 46-file checkpoint")
    for entry in entries:
        if BASELINE_DIR.joinpath(*PurePosixPath(entry["path"]).parts).stat().st_size != entry["bytes"]:
            raise ValueError(f"Checkpoint size mismatch: {entry['path']}")
    return hashes


def add_candidate(path: Path, found: dict[str, Path], excluded: list[str]) -> None:
    if not path.exists() or not path.is_file():
        return
    require_real_path(path, REPO_ROOT)
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
    file_hashes = {entry["path"]: entry["sha256"] for entry in entries}
    removable_files = set(files).difference(BASELINE_PATHS)
    return {
        "schema_version": 3,
        "archive": ARCHIVE_PATH.name,
        "checkpoint_manifest_sha256": BASELINE_MANIFEST_SHA256,
        "checkpoint_sums_sha256": BASELINE_SUMS_SHA256,
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
    """Diff all approved baseline files; describe changed/new binaries by hash."""
    chunks: list[str] = []
    binary_metadata: list[str] = []
    for relative, source in files.items():
        current = source.read_bytes()
        baseline_path = BASELINE_DIR.joinpath(*PurePosixPath(relative).parts)
        old = baseline_path.read_bytes() if baseline_path.is_file() else None
        if old == current:
            continue
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
            + ("new file mode 100644\n" if old is None else "")
            + f"Binary files {'/dev/null' if old is None else 'a/' + relative} and b/{relative} differ\n"
            + (f"# BASELINE-BINARY bytes={len(old)} sha256={sha256_bytes(old)}\n" if old is not None else "")
            +
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
