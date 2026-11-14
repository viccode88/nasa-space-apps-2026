#!/usr/bin/env bash
# Rebuild every data file from the FIRMS source CSVs.
# Usage: pipeline/build_all.sh [region ...]     (default: all four regions)
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-.venv/bin/python}

"$PY" pipeline/01_download.py "$@"
# Current-year data needs a FIRMS MAP_KEY (environment variable or .env file).
if [ -n "${FIRMS_MAP_KEY:-}" ] || grep -qs '^FIRMS_MAP_KEY=.' .env; then
  "$PY" pipeline/01b_download_current_year.py "$@"
else
  echo "FIRMS_MAP_KEY not set: skipping 2026, data will end in 2025"
fi
"$PY" pipeline/02_clean.py "$@"
"$PY" pipeline/03_grid.py "$@"
"$PY" pipeline/04_harmonize.py
"$PY" pipeline/05_export.py
