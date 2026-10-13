#!/usr/bin/env python3
"""Verify experience-v2 archive, isolated behavior and 46-file rollback copy."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote

sys.dont_write_bytecode = True
import build_release


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
BASELINE_DIR = SCRIPT_DIR / "baseline"
MANIFEST_PATH = SCRIPT_DIR / "release-manifest.json"
MANIFEST_PIN_PATH = SCRIPT_DIR / "release-manifest.sha256"
ARCHIVE_PATH = SCRIPT_DIR / "MODIFIED_FILE.zip"
ROLLBACK_STATE_PATH = SCRIPT_DIR / "rollback-test-state.json"
ROLLBACK_TARGET = SCRIPT_DIR / "rollback-test"
FORBIDDEN_DIRS = {".git", ".venv", ".runtime", "__pycache__", "node_modules", "artifacts", "image-sources"}
FORBIDDEN_SUFFIXES = {
    ".pyc", ".pyo", ".log", ".out", ".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm",
    ".pem", ".key", ".p12", ".pfx", ".jks", ".wallet", ".exe", ".dll", ".so", ".dylib", ".bin",
}
FORBIDDEN_NAMES = {".env", ".env.local", ".env.production", "marketplace.db", "wallet.dat", "credentials.json", "secrets.json"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def validate_archive_path(name: str) -> None:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"unsafe archive path: {name!r}")
    parts = tuple(part.lower() for part in path.parts)
    filename = parts[-1]
    suffixes = {suffix.lower() for suffix in Path(filename).suffixes}
    if any(part in FORBIDDEN_DIRS for part in parts):
        raise ValueError(f"excluded directory in archive: {name}")
    if filename in FORBIDDEN_NAMES or suffixes.intersection(FORBIDDEN_SUFFIXES):
        raise ValueError(f"excluded file in archive: {name}")
    if any(marker in filename for marker in build_release.EXCLUDED_NAME_MARKERS):
        raise ValueError(f"excluded secret marker in archive: {name}")


def verify_archive() -> int:
    if not MANIFEST_PATH.is_file() or not ARCHIVE_PATH.is_file() or not MANIFEST_PIN_PATH.is_file():
        raise ValueError("release manifest, manifest pin, or archive missing; run build_release.py first")
    manifest_bytes = MANIFEST_PATH.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if manifest.get("schema_version") != 3 or manifest.get("archive") != ARCHIVE_PATH.name:
        raise ValueError("release manifest schema or archive name mismatch")
    for path in (MANIFEST_PATH, ARCHIVE_PATH, MANIFEST_PIN_PATH, build_release.DIFF_PATH):
        build_release.require_real_path(path, SCRIPT_DIR)
    expected_pin = f"{sha256(manifest_bytes)}  {MANIFEST_PATH.name}\n"
    if MANIFEST_PIN_PATH.read_text(encoding="ascii") != expected_pin:
        raise ValueError("release manifest SHA-256 pin mismatch")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ValueError("manifest files must be a list")
    expected: dict[str, tuple[str, int]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ValueError("malformed release manifest entry")
        name = entry["path"]
        validate_archive_path(name)
        if name == MANIFEST_PATH.name or name in expected:
            raise ValueError(f"duplicate or reserved manifest path: {name}")
        digest, size = entry.get("sha256"), entry.get("bytes")
        if not isinstance(digest, str) or len(digest) != 64 or not isinstance(size, int) or size < 0:
            raise ValueError(f"malformed hash/size for: {name}")
        expected[name] = (digest.upper(), size)

    baseline_hashes = build_release.load_baseline_hashes()
    if (manifest.get("checkpoint_manifest_sha256") != build_release.BASELINE_MANIFEST_SHA256
            or manifest.get("checkpoint_sums_sha256") != build_release.BASELINE_SUMS_SHA256):
        raise ValueError("release checkpoint pins differ from approved baseline")
    baseline_entries = manifest.get("baseline_files")
    if not isinstance(baseline_entries, list):
        raise ValueError("manifest baseline_files must be a list")
    actual_baseline = {entry.get("path"): str(entry.get("sha256", "")).upper() for entry in baseline_entries if isinstance(entry, dict)}
    if actual_baseline != baseline_hashes:
        raise ValueError("release manifest baseline hashes differ from immutable snapshot")

    current_files, _ = build_release.collect_files()
    diff_data = build_release.diff_bytes(current_files)
    rebuilt = build_release.manifest_for(current_files, baseline_hashes, diff_data)
    if build_release.json_bytes(rebuilt) != manifest_bytes:
        raise ValueError("release manifest does not match frozen source and rollback snapshots")
    if not build_release.DIFF_PATH.is_file() or build_release.DIFF_PATH.read_bytes() != diff_data:
        raise ValueError("DIFF_FILE.patch differs from frozen source tree")

    with zipfile.ZipFile(ARCHIVE_PATH, "r") as archive:
        bad_member = archive.testzip()
        if bad_member:
            raise ValueError(f"corrupt archive member: {bad_member}")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate entries in archive")
        for name in names:
            validate_archive_path(name)
        if set(names) != set(expected) | {MANIFEST_PATH.name}:
            missing = sorted((set(expected) | {MANIFEST_PATH.name}) - set(names))
            extra = sorted(set(names) - (set(expected) | {MANIFEST_PATH.name}))
            raise ValueError(f"archive entry mismatch missing={missing} extra={extra}")
        if archive.read(MANIFEST_PATH.name) != manifest_bytes:
            raise ValueError("embedded manifest differs from on-disk manifest")
        for name, (digest, size) in expected.items():
            data = archive.read(name)
            if len(data) != size or sha256(data) != digest:
                raise ValueError(f"archive payload mismatch: {name}")
    print(f"ARCHIVE_OK entries={len(expected)} sha256={sha256(ARCHIVE_PATH.read_bytes())}")
    return 0


def require_behavior_source(source_root: Path) -> None:
    build_release.require_real_path(source_root, source_root)
    if source_root.absolute() == BASELINE_DIR.absolute():
        build_release.load_baseline_hashes()


def _import_app(app_path: Path, import_root: Path):
    require_behavior_source(import_root)
    if not app_path.is_file():
        raise FileNotFoundError(app_path)
    sys.path.insert(0, str(import_root))
    name = "bitloja_release_smoke_app"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, app_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load app module: {app_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def isolated_environment(database: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update({
        "DATABASE_PATH": str(database),
        "BTC_MODE": "demo",
        "BTC_NETWORK": "regtest",
        "ALLOW_MAINNET": "0",
        "LN_MODE": "off",
        "CUSTODY_MODE": "demo",
        "ENABLE_DEMO_SEED": "0",
        "ENABLE_LIGHTNING_POLLER": "0",
        "APP_SECRET": "experience-v2-isolated-not-for-deployment",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return environment


def smoke_http(target: str, source_root: Path | None = None) -> dict[str, int]:
    if source_root is None:
        source_root = BASELINE_DIR if target == "baseline" else REPO_ROOT
    app_path = source_root / "app.py"
    if target not in {"baseline", "modified", "rollback-test"}:
        raise ValueError("smoke target must be baseline, modified, or rollback-test")
    if target == "baseline" and source_root.absolute() != BASELINE_DIR.absolute():
        raise ValueError("baseline smoke requires the fixed immutable checkpoint")
    require_behavior_source(source_root)
    with tempfile.TemporaryDirectory(prefix=f"bitloja-{target}-smoke-") as temp_dir:
        database = Path(temp_dir) / "isolated-marketplace.db"
        os.environ.update(isolated_environment(database))
        module = _import_app(app_path, source_root)
        module.init_db()
        client = module.app.test_client()
        statuses = {}
        for endpoint in ("/", "/api/bootstrap", "/api/products"):
            response = client.get(endpoint)
            if response.status_code != 200:
                raise ValueError(f"GET {endpoint} returned {response.status_code}")
            if endpoint != "/" and not response.is_json:
                raise ValueError(f"GET {endpoint} did not return JSON")
            payload = response.get_json(silent=True) if endpoint != "/" else None
            if endpoint == "/api/bootstrap" and not isinstance(payload, dict):
                raise ValueError("/api/bootstrap payload is not an object")
            if endpoint == "/api/products" and (
                not isinstance(payload, dict)
                or not isinstance(payload.get("categories"), list)
                or not isinstance(payload.get("products"), list)
            ):
                raise ValueError("/api/products payload must contain category and product lists")
            statuses[endpoint] = response.status_code
        static_count = 0
        require_behavior_source(source_root)
        for path in sorted((source_root / "static").rglob("*")):
            if not path.is_file():
                continue
            build_release.require_real_path(path, source_root)
            relative = path.relative_to(source_root).as_posix()
            validate_archive_path(relative)
            response = client.get("/" + quote(relative, safe="/"))
            if response.status_code != 200 or response.data != path.read_bytes():
                raise ValueError(f"static payload mismatch: {relative} HTTP {response.status_code}")
            static_count += 1
        if not static_count:
            raise ValueError("full current baseline must contain static assets")
        statuses["static_files"] = static_count
        return statuses


def node_executable() -> str:
    candidates = []
    configured = os.environ.get("NODE")
    if configured:
        candidates.append(Path(configured))
    candidates.append(Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe")
    located = shutil.which("node")
    if located:
        candidates.append(Path(located))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise ValueError("Node executable missing; set NODE or install node on PATH")


def smoke_javascript(source_root: Path = REPO_ROOT) -> int:
    require_behavior_source(source_root)
    scripts = sorted((source_root / "static" / "js").rglob("*.js"))
    if not scripts:
        raise ValueError("no static JavaScript files found")
    node = node_executable()
    for script in scripts:
        completed = subprocess.run([node, "--check", str(script)], capture_output=True, text=True)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()
            raise ValueError(f"node --check failed for {script.relative_to(source_root)}: {detail}")
    return len(scripts)


def smoke_tests(source_root: Path) -> int:
    """Run the repository suite in a separate interpreter with temporary SQLite."""
    require_behavior_source(source_root)
    with tempfile.TemporaryDirectory(prefix="bitloja-v2-suite-") as temporary:
        environment = isolated_environment(Path(temporary) / "isolated-suite.sqlite3")
        completed = subprocess.run(
            [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-q"],
            cwd=source_root, env=environment, capture_output=True, text=True, timeout=180,
        )
    output = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0:
        raise ValueError(f"isolated unit suite failed exit={completed.returncode}: {output[-8000:]}")
    matched = re.search(r"Ran (\d+) tests? in", output)
    if not matched or int(matched.group(1)) < 1:
        raise ValueError("isolated unit suite discovered no tests")
    return int(matched.group(1))


def checked_rollback_target() -> Path:
    fixed_target = (SCRIPT_DIR / "rollback-test").absolute()
    if ROLLBACK_TARGET.absolute() != fixed_target:
        raise ValueError("rollback target differs from fixed rollback-test path")
    build_release.require_real_path(fixed_target, SCRIPT_DIR)
    if fixed_target.resolve(strict=False) != fixed_target:
        raise ValueError("rollback-test target or ancestor is redirected")
    if fixed_target == REPO_ROOT.absolute() or fixed_target == BASELINE_DIR.absolute():
        raise ValueError("rollback target overlaps workspace or baseline")
    return fixed_target


def safe_target_path(root: Path, name: str) -> Path:
    if root.absolute() != checked_rollback_target():
        raise ValueError("rollback path root differs from fixed disposable target")
    relative = PurePosixPath(name)
    validate_archive_path(name)
    destination = root.joinpath(*relative.parts)
    build_release.require_real_path(destination, root)
    try:
        destination.resolve(strict=False).relative_to(root.resolve())
    except ValueError as error:
        raise ValueError(f"rollback target path escaped: {name}") from error
    return destination


def protected_source_snapshot() -> list[dict[str, object]]:
    snapshot = []
    for name in (".env", ".env.local", ".env.production", "marketplace.db", "marketplace.db-wal", "marketplace.db-shm"):
        path = REPO_ROOT / name
        build_release.require_real_path(path, REPO_ROOT)
        if path.is_file():
            data = path.read_bytes()
            snapshot.append({"path": name, "exists": True, "bytes": len(data), "sha256": sha256(data)})
        else:
            snapshot.append({"path": name, "exists": False, "bytes": None, "sha256": None})
    return snapshot


def expected_state(manifest: dict[str, object]) -> dict[str, object]:
    files = manifest["files"]
    return {
        "schema_version": 2,
        "archive_sha256": sha256(ARCHIVE_PATH.read_bytes()),
        "manifest_sha256": sha256(MANIFEST_PATH.read_bytes()),
        "files": [{"path": entry["path"], "sha256": entry["sha256"]} for entry in files],
        "protected_source": protected_source_snapshot(),
    }


def prepare_rollback_test() -> int:
    verify_archive()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    target = checked_rollback_target()
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError(f"rollback-test target must be absent or empty: {target}")
    state = expected_state(manifest)
    state_data = build_release.json_bytes(state)
    if ROLLBACK_STATE_PATH.exists():
        if not ROLLBACK_STATE_PATH.is_file() or ROLLBACK_STATE_PATH.read_bytes() != state_data:
            raise ValueError("rollback test state conflict; existing file left unchanged")
    checked_rollback_target().mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ARCHIVE_PATH, "r") as archive:
        for entry in manifest["files"]:
            name = entry["path"]
            data = archive.read(name)
            if sha256(data) != entry["sha256"] or len(data) != entry["bytes"]:
                raise ValueError(f"verified archive payload changed during staging: {name}")
            destination = safe_target_path(target, name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            safe_target_path(target, name)
            destination.write_bytes(data)
    if not ROLLBACK_STATE_PATH.exists():
        build_release.require_real_path(ROLLBACK_STATE_PATH, SCRIPT_DIR)
        build_release.write_atomic(ROLLBACK_STATE_PATH, state_data)
    print(f"ROLLBACK_TEST_PREPARED target={target} files={len(manifest['files'])} protected_source_paths={len(state['protected_source'])}")
    return 0


def verify_restored(unit_tests: bool = False) -> int:
    verify_archive()
    if not ROLLBACK_STATE_PATH.is_file():
        raise ValueError("rollback test state missing; run --rollback-test first")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    state = json.loads(ROLLBACK_STATE_PATH.read_text(encoding="utf-8"))
    if state != expected_state(manifest):
        raise ValueError("source files, archive, manifest, or protected source hashes changed after rollback staging")

    rollback = manifest.get("rollback")
    if not isinstance(rollback, dict):
        raise ValueError("rollback manifest section missing")
    restore_entries = rollback.get("restore_files")
    remove_entries = rollback.get("remove_files")
    if not isinstance(restore_entries, list) or not isinstance(remove_entries, list):
        raise ValueError("rollback restore/remove inventories malformed")
    file_hashes = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    restore_hashes = {entry["path"]: entry["sha256"] for entry in restore_entries}
    remove_hashes = {entry["path"]: entry["sha256"] for entry in remove_entries}
    if set(restore_hashes).intersection(remove_hashes):
        raise ValueError("rollback inventories overlap")
    target = checked_rollback_target()
    for name in remove_hashes:
        if file_hashes.get(name) != remove_hashes[name]:
            raise ValueError(f"removal hash differs from package payload: {name}")
        destination = safe_target_path(target, name)
        if destination.exists():
            raise ValueError(f"known release file remains after rollback: {name}")
    kept_paths = set(file_hashes).difference(remove_hashes)
    actual_paths = set()
    if target.exists():
        for path in target.rglob("*"):
            build_release.require_real_path(path, target)
            if path.is_file():
                actual_paths.add(path.relative_to(target).as_posix())
    if actual_paths != kept_paths:
        raise ValueError("rollback-test file inventory differs from expected restored inventory")
    for name in sorted(kept_paths):
        destination = safe_target_path(target, name)
        expected = restore_hashes.get(name, file_hashes[name])
        if not destination.is_file() or sha256(destination.read_bytes()) != expected:
            raise ValueError(f"restored file hash mismatch: {name}")

    protected_current = protected_source_snapshot()
    if protected_current != state["protected_source"]:
        raise ValueError("source database/environment hashes changed during rollback test")
    if actual_paths != build_release.BASELINE_PATHS:
        raise ValueError("rollback must restore exactly the approved 46 source files")
    statuses = smoke_http("rollback-test", target)
    js_files = smoke_javascript(target)
    cases = smoke_tests(target) if unit_tests else None
    if protected_source_snapshot() != state["protected_source"]:
        raise ValueError("protected workspace changed during restored behavior tests")
    case_result = f" UNIT_TESTS={cases}" if cases is not None else ""
    print(f"RESTORED_OK GET/={statuses['/']} GET/api/bootstrap={statuses['/api/bootstrap']} GET/api/products={statuses['/api/products']} STATIC_FILES={statuses['static_files']} JS_PARSE_FILES={js_files}{case_result} files={len(kept_paths)} removed_new_files={len(remove_hashes)} source_unchanged=true protected_unchanged=true isolated_database=true")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--archive", action="store_true", help="verify ZIP entries, manifest, and payload hashes")
    group.add_argument("--smoke", choices=("baseline", "modified"), help="run HTTP smoke checks against an isolated SQLite database")
    group.add_argument("--rollback-test", action="store_true", help="stage a hash-verified release copy at the fixed rollback-test path")
    group.add_argument("--restored", action="store_true", help="verify restored rollback copy, isolated HTTP behavior, JS parse, and source hashes")
    parser.add_argument("--js", action="store_true", help="also run node --check with either smoke mode")
    parser.add_argument("--unit-tests", action="store_true", help="run isolated unittest suite with --smoke or --restored")
    args = parser.parse_args()
    try:
        if args.archive:
            if args.js or args.unit_tests:
                parser.error("--js and --unit-tests apply only with --smoke or --restored")
            return verify_archive()
        if args.rollback_test:
            if args.js or args.unit_tests:
                parser.error("--js and --unit-tests do not apply with --rollback-test")
            return prepare_rollback_test()
        if args.restored:
            if args.js:
                parser.error("--js does not apply with --restored")
            return verify_restored(unit_tests=args.unit_tests)
        build_release.load_baseline_hashes()
        source_root = BASELINE_DIR if args.smoke == "baseline" else REPO_ROOT
        protected_before = protected_source_snapshot()
        statuses = smoke_http(args.smoke)
        js_files = None
        if args.js:
            js_files = smoke_javascript(source_root)
        cases = smoke_tests(source_root) if args.unit_tests else None
        if protected_source_snapshot() != protected_before:
            raise ValueError("protected workspace changed during isolated smoke tests")
        label = "BASELINE" if args.smoke == "baseline" else "MODIFIED"
        js_result = f" JS_PARSE_FILES={js_files}" if js_files is not None else ""
        case_result = f" UNIT_TESTS={cases}" if cases is not None else ""
        print(f"{label}_OK GET/={statuses['/']} GET/api/bootstrap={statuses['/api/bootstrap']} GET/api/products={statuses['/api/products']} STATIC_FILES={statuses['static_files']}{js_result}{case_result} protected_unchanged=true isolated_database=true")
        return 0
    except (OSError, ValueError, ImportError, zipfile.BadZipFile, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        print(f"VERIFY_ERROR {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
