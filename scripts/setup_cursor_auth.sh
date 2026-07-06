#!/usr/bin/env bash
# 按 CURSOR_AUTH_JSON > CURSOR_API_KEY > ~/.config/cursor/auth.json 配置 Cursor CLI。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

python - <<'PY'
from scripts.cursor_auth import setup_cursor_auth
import sys

if not setup_cursor_auth():
    print(
        "::error::未找到 Cursor 凭据：请配置 CURSOR_AUTH_JSON、CURSOR_API_KEY "
        "或 ~/.config/cursor/auth.json",
        file=sys.stderr,
    )
    sys.exit(1)

print("Cursor 凭据已就绪")
PY
