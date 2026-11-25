#!/usr/bin/env bash
# Installs the tracer's Python engine into the repo-local .venv (no system-wide installs).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -c "import vtracer" 2>/dev/null || .venv/bin/pip install -q vtracer
echo "tools ready: $(.venv/bin/python -c 'import vtracer,sys;print("vtracer ok, python", sys.version.split()[0])')"
