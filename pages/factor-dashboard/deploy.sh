#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"

cd "$(dirname "$0")"
npx wrangler pages deploy . --project-name quant-factors-dashboard --commit-dirty=true

echo "Done. https://quant-factors-dashboard.pages.dev"
