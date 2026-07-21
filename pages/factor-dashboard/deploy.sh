#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"

ROOT="$(cd "$(dirname "$0")" && pwd)"

# 先构建 React 研究助手到 ./research-chat/
(
  cd "$ROOT/../factor-research-chat"
  npm ci --prefer-offline 2>/dev/null || npm install
  npm run build
)

cd "$ROOT"
npx wrangler pages deploy . --project-name quant-factors-dashboard --commit-dirty=true

echo "Done. https://quant-factors-dashboard.pages.dev"
echo "Research chat: https://quant-factors-dashboard.pages.dev/research-chat/"
