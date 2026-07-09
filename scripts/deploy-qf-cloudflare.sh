#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

load_env_file() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(OPENAI_|AUTH_PASSWORD|CLOUDFLARE_API_TOKEN)=' "${file}" | sed 's/^/export /')
  set +a
}

load_env_file "${ROOT}/.env"

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN in repo .env}"
: "${AUTH_PASSWORD:?Set AUTH_PASSWORD in repo .env}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY in repo .env}"

export CLOUDFLARE_API_TOKEN AUTH_PASSWORD OPENAI_API_KEY OPENAI_BASE_URL

echo "==> Deploy Worker (factor-ideas)"
"${ROOT}/workers/factor-ideas/deploy.sh"

echo ""
echo "==> Deploy Pages (factor-dashboard)"
"${ROOT}/pages/factor-dashboard/deploy.sh"
