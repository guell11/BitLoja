"""Disposable Windows-junction and immutable-baseline regression fixtures."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
import build_release
import restore_release
import verify_release


ARTIFACT_ROOT = Path(__file__).resolve().parent


class HelperGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="helper-guards-", dir=ARTIFACT_ROOT)
        self.root = Path(self.temporary.name)
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        self.junctions: list[Path] = []

    def tearDown(self):
        for link in reversed(self.junctions):
            link.absolute().relative_to(self.root.absolute())
            if os.path.lexists(link):
                os.rmdir(link)
        build_release.require_real_path(self.root, ARTIFACT_ROOT)
        self.root.resolve().relative_to(ARTIFACT_ROOT.resolve())
        self.temporary.cleanup()

    def junction(self, link: Path, destination: Path):
        if os.name == "nt":
            completed = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(destination)],
                capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertFalse(link.is_symlink())
        else:
            link.symlink_to(destination, target_is_directory=True)
        self.junctions.append(link)
        self.assertTrue(build_release.is_redirected_path(link))

    def fixed_target_context(self, artifact: Path | None = None, target: Path | None = None):
        artifact = artifact or self.artifact
        stack = ExitStack()
        stack.enter_context(mock.patch.object(verify_release, "SCRIPT_DIR", artifact))
        stack.enter_context(mock.patch.object(verify_release, "ROLLBACK_TARGET", target or artifact / "rollback-test"))
        stack.enter_context(mock.patch.object(verify_release, "BASELINE_DIR", artifact / "baseline"))
        stack.enter_context(mock.patch.object(verify_release, "REPO_ROOT", self.root / "workspace"))
        return stack

    def test_root_junction_rejected_before_stage_preflight_and_restore_write(self):
        other = self.artifact / "another-copy"
        other.mkdir()
        sentinel = other / "README.md"
        original = b"another-copy must remain unchanged\n"
        sentinel.write_bytes(original)
        target = self.artifact / "rollback-test"
        self.junction(target, other)
        manifest = self.artifact / "fixture-manifest.json"
        manifest.write_text('{"files": []}', encoding="utf-8")
        release = {"README.md": restore_release.digest(original)}
        restores = {"README.md": (b"must not write\n", restore_release.digest(b"must not write\n"))}
        with self.fixed_target_context(), mock.patch.object(verify_release, "verify_archive", return_value=0), \
                mock.patch.object(verify_release, "MANIFEST_PATH", manifest):
            checks = (
                verify_release.checked_rollback_target,
                lambda: build_release.require_real_path(target / "README.md", self.artifact),
                verify_release.prepare_rollback_test,
                lambda: restore_release.preflight(target, release, restores, {}),
                lambda: restore_release.write_baseline("README.md", b"must not write\n", target),
            )
            for check in checks:
                with self.subTest(check=check):
                    with self.assertRaisesRegex(ValueError, "redirected"):
                        check()
            self.assertEqual(sentinel.read_bytes(), original)
            self.assertEqual(set(other.iterdir()), {sentinel})
        print("JUNCTION_GUARD_OK stage=blocked preflight=blocked write=blocked sentinel_unchanged=true")

    def test_junction_ancestor_and_nested_destination_are_rejected(self):
        alias = self.root / "artifact-alias"
        self.junction(alias, self.artifact)
        with self.fixed_target_context(artifact=alias):
            with self.assertRaisesRegex(ValueError, "redirected"):
                verify_release.checked_rollback_target()
        target = self.artifact / "rollback-test"
        target.mkdir()
        other = self.artifact / "another-copy"
        other.mkdir()
        self.junction(target / "nested", other)
        with self.fixed_target_context():
            with self.assertRaisesRegex(ValueError, "redirected"):
                verify_release.safe_target_path(target, "nested/README.md")
        print("JUNCTION_ANCESTORS_OK artifact_ancestor=blocked nested_destination=blocked")

    def test_nonfixed_target_rejected(self):
        other = self.artifact / "another-copy"
        other.mkdir()
        with self.fixed_target_context(target=other):
            with self.assertRaisesRegex(ValueError, "fixed rollback-test"):
                verify_release.checked_rollback_target()
        with self.fixed_target_context():
            with self.assertRaisesRegex(ValueError, "fixed disposable"):
                verify_release.safe_target_path(other, "README.md")
        print("FIXED_TARGET_OK sibling_target=blocked")

    def test_unpinned_baseline_files_rejected_before_behavior(self):
        build_release.load_baseline_hashes()
        baseline = self.artifact / "baseline"
        baseline.mkdir()
        for name in build_release.BASELINE_PATHS | {"SHA256SUMS.txt", "checkpoint-manifest.json"}:
            destination = baseline / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((build_release.BASELINE_DIR / name).read_bytes())
        with ExitStack() as patches:
            for module in (build_release, verify_release):
                patches.enter_context(mock.patch.object(module, "BASELINE_DIR", baseline))
            patches.enter_context(mock.patch.object(build_release, "SCRIPT_DIR", self.artifact))
            patches.enter_context(mock.patch.object(build_release, "BASELINE_SUMS", baseline / "SHA256SUMS.txt"))
            patches.enter_context(mock.patch.object(build_release, "BASELINE_MANIFEST", baseline / "checkpoint-manifest.json"))
            self.assertEqual(len(build_release.load_baseline_hashes()), 46)
            for name in ("tests/test_unpinned_review.py", "static/js/unpinned-review.js", "static/css/unpinned-review.css"):
                extra = baseline / name
                extra.parent.mkdir(parents=True, exist_ok=True)
                extra.write_text("raise RuntimeError('UNPINNED_EXECUTED')\n", encoding="utf-8")
                with mock.patch.object(verify_release.importlib.util, "spec_from_file_location", side_effect=AssertionError("unexpected import")), \
                        mock.patch.object(verify_release.subprocess, "run", side_effect=AssertionError("unexpected subprocess")), \
                        mock.patch.object(Path, "rglob", side_effect=AssertionError("unexpected scan")):
                    checks = (
                        build_release.load_baseline_hashes,
                        lambda: verify_release._import_app(baseline / "app.py", baseline),
                        lambda: verify_release.smoke_http("baseline", baseline),
                        lambda: verify_release.smoke_javascript(baseline),
                        lambda: verify_release.smoke_tests(baseline),
                    )
                    for check in checks:
                        with self.subTest(extra=name, check=check):
                            with self.assertRaisesRegex(ValueError, "baseline inventory mismatch"):
                                check()
                extra.unlink()
            self.assertEqual(len(build_release.load_baseline_hashes()), 46)
        print("BASELINE_INVENTORY_OK files=46 metadata=2 extra_test=blocked extra_js=blocked extra_css=blocked imports=not_run scans=not_run discovery=not_run")


if __name__ == "__main__":
    unittest.main(verbosity=1)
