#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${PYTHON:-}" ]]; then
  printf '%s\n' 'ROLLBACK_ERROR set PYTHON to bundled Python executable' >&2
  exit 2
fi
if [[ ! -f "$PYTHON" ]]; then
  printf 'ROLLBACK_ERROR Python executable not found: %s\n' "$PYTHON" >&2
  exit 2
fi

exec "$PYTHON" "$script_dir/restore_release.py"
