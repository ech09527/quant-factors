#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

: "${VAULT_ADDR:?Set VAULT_ADDR}"
: "${VAULT_TOKEN:?Set VAULT_TOKEN}"

read_vault_field() {
  local path="$1"
  local field="$2"
  curl -fsS \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    "${VAULT_ADDR%/}/v1/kv/data/${path}" \
    | jq -r --arg field "$field" '.data.data[$field] // empty'
}

CF_API_KEY="$(read_vault_field cloudflare API_KEY)"
if [[ -z "${CF_API_KEY}" ]]; then
  echo "Missing kv/cloudflare API_KEY in Vault" >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN="${CF_API_KEY}"

if [[ ! -d node_modules ]]; then
  npm install
fi

echo "Setting Worker secret VAULT_TOKEN from environment..."
printf '%s' "${VAULT_TOKEN}" | npx wrangler secret put VAULT_TOKEN

echo "Deploying Cloudflare Worker..."
npx wrangler deploy

echo "Done. Cron trigger: */15 * * * *"
