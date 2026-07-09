#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

load_env_file() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(GITHUB_PAT|CLOUDFLARE_API_TOKEN)=' "${file}" | sed 's/^/export /')
  set +a
}

load_env_file "${ROOT}/../../.env"

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${GITHUB_PAT:?Set GITHUB_PAT}"

export CLOUDFLARE_API_TOKEN

if [[ ! -d node_modules ]]; then
  npm install
fi

echo "Setting Worker secret GITHUB_PAT..."
printf '%s' "${GITHUB_PAT}" | npx wrangler secret put GITHUB_PAT

echo "Deploying Cloudflare Worker..."
npx wrangler deploy

echo "Done. Cron trigger: disabled (validation batch scheduler paused)"
