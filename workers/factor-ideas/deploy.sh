#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${ROOT}/../.." && pwd)"

cd "${ROOT}"

echo "==> Export Jupyter eval engine assets"
(cd "${REPO_ROOT}" && uv run python scripts/export_worker_eval_assets.py)

echo "==> Deploy Worker"
npx wrangler deploy "$@"
