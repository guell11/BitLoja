#!/usr/bin/env python3
"""Restore all 46 current baseline files in a contained disposable release copy."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True
import build_release
import verify_release


SCRIPT_DIR = Path(__file__).resolve().parent
BASELINE_DIR = SCRIPT_DIR / "baseline"
MANIFEST_PATH = SCRIPT_DIR / "release-manifest.json"
BASELINE_PATHS = build_release.BASELINE_PATHS


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def artifact_source_path(name: str) -> Path:
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or "\\" in name:
        raise ValueError(f"unsafe rollback source path: {name!r}")
    if not relative.parts or relative.parts[0] != "baseline":
        raise ValueError(f"rollback source is not an approved snapshot: {name}")
    source = SCRIPT_DIR.joinpath(*relative.parts)
    build_release.require_real_path(source, SCRIPT_DIR)
    try:
        source.resolve().relative_to(SCRIPT_DIR.resolve())
    except ValueError as error:
        raise ValueError(f"rollback snapshot escaped artifact directory: {name}") from error
    return source


def load_plan() -> tuple[dict[str, str], dict[str, tuple[bytes, str]], dict[str, str]]:
    verify_release.verify_archive()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    baseline_hashes = build_release.load_baseline_hashes()
    release_hashes = {entry["path"]: entry["sha256"].upper() for entry in manifest["files"]}
    rollback = manifest.get("rollback")
    if not isinstance(rollback, dict):
        raise ValueError("trusted release manifest has no rollback plan")
    restore_entries = rollback.get("restore_files")
    remove_entries = rollback.get("remove_files")
    if not isinstance(restore_entries, list) or not isinstance(remove_entries, list):
        raise ValueError("malformed rollback inventories")

    restores: dict[str, tuple[bytes, str]] = {}
    for entry in restore_entries:
        if not isinstance(entry, dict):
            raise ValueError("malformed restore entry")
        name, source_name = entry.get("path"), entry.get("source")
        expected = entry.get("sha256")
        if not isinstance(name, str) or not isinstance(source_name, str) or not isinstance(expected, str) or len(expected) != 64:
            raise ValueError("malformed restore path/hash")
        verify_release.validate_archive_path(name)
        source = artifact_source_path(source_name)
        data = source.read_bytes()
        if digest(data) != expected.upper():
            raise ValueError(f"trusted rollback snapshot hash mismatch: {source_name}")
        restores[name] = (data, expected.upper())

    if set(restores) != set(BASELINE_PATHS):
        raise ValueError("trusted rollback restore inventory differs from approved paths")
    for name in BASELINE_PATHS:
        if restores[name][1] != baseline_hashes[name]:
            raise ValueError(f"manifest baseline restore hash mismatch: {name}")
    removals: dict[str, str] = {}
    for entry in remove_entries:
        if not isinstance(entry, dict):
            raise ValueError("malformed removal entry")
        name, expected = entry.get("path"), entry.get("sha256")
        if not isinstance(name, str) or not isinstance(expected, str) or len(expected) != 64:
            raise ValueError("malformed removal path/hash")
        verify_release.validate_archive_path(name)
        removals[name] = expected.upper()
    expected_removals = set(release_hashes).difference(BASELINE_PATHS)
    if set(removals) != expected_removals:
        raise ValueError("trusted rollback removal inventory differs from new release paths")
    if set(restores).intersection(removals):
        raise ValueError("restore and removal inventories overlap")
    for name, expected in removals.items():
        if release_hashes.get(name) != expected:
            raise ValueError(f"removal hash differs from release payload: {name}")
    for name in set(restores) | set(removals):
        if name not in release_hashes:
            raise ValueError(f"rollback path missing from release payload: {name}")
    return release_hashes, restores, removals


def target_path(target: Path, name: str) -> Path:
    destination = verify_release.safe_target_path(target, name)
    return destination


def preflight(target: Path, release_hashes: dict[str, str], restores: dict[str, tuple[bytes, str]], removals: dict[str, str]) -> None:
    if target.absolute() != verify_release.checked_rollback_target() or not target.is_dir():
        raise ValueError(f"rollback-test directory missing or invalid: {target}")
    actual_files = build_release.real_file_inventory(target)
    if actual_files != set(release_hashes):
        missing = sorted(set(release_hashes) - actual_files)
        extra = sorted(actual_files - set(release_hashes))
        raise ValueError(f"rollback-test inventory mismatch missing={missing} extra={extra}")

    for name, release_hash in release_hashes.items():
        destination = target_path(target, name)
        if not destination.is_file():
            raise ValueError(f"rollback-test release file missing: {name}")
        current = digest(destination.read_bytes())
        allowed = {release_hash}
        if name in restores:
            allowed.add(restores[name][1])
        if current not in allowed:
            raise ValueError(f"rollback hash guard stopped on unknown content: {name}")
    for name, expected in removals.items():
        if release_hashes[name] != expected:
            raise ValueError(f"known-new-file hash guard failed: {name}")


def write_baseline(name: str, data: bytes, target: Path) -> None:
    destination = target_path(target, name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = target_path(target, name)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".restore", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        destination = target_path(target, name)
        build_release.require_real_path(temporary, target)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def restore(dry_run: bool = False) -> int:
    release_hashes, restores, removals = load_plan()
    target = verify_release.checked_rollback_target()
    preflight(target, release_hashes, restores, removals)
    if dry_run:
        print(f"ROLLBACK_DRY_RUN target={target} baseline_files={len(BASELINE_PATHS)} release_files_to_remove={len(removals)}")
        return 0

    for name in sorted(removals, key=lambda value: (value.count("/"), value), reverse=True):
        destination = target_path(target, name)
        if digest(destination.read_bytes()) != removals[name]:
            raise ValueError(f"release file changed after preflight: {name}")
        destination.unlink()
        parent = destination.parent
        while parent != target:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    for name, (data, _) in sorted(restores.items()):
        write_baseline(name, data, target)
    for name, (_, expected) in restores.items():
        if digest(target_path(target, name).read_bytes()) != expected:
            raise ValueError(f"restored baseline hash mismatch: {name}")
    actual = {path.relative_to(target).as_posix() for path in target.rglob("*") if path.is_file()}
    if actual != BASELINE_PATHS:
        raise ValueError("restored copy inventory differs from approved 46-file baseline")
    print(f"RESTORE_OK target={target} baseline_files={len(BASELINE_PATHS)} removed_new_files={len(removals)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="validate rollback target without changing files")
    args = parser.parse_args()
    try:
        return restore(dry_run=args.dry_run)
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as error:
        print(f"RESTORE_ERROR {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
