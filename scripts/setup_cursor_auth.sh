#!/usr/bin/env bash
# 将 CURSOR_AUTH_JSON 写入 ~/.config/cursor/auth.json，供 Cursor CLI 使用。
set -euo pipefail

if [ -z "${CURSOR_AUTH_JSON:-}" ]; then
  echo "::error::未设置 CURSOR_AUTH_JSON secret" >&2
  exit 1
fi

mkdir -p "${HOME}/.config/cursor"
printf '%s' "$CURSOR_AUTH_JSON" > "${HOME}/.config/cursor/auth.json"
chmod 600 "${HOME}/.config/cursor/auth.json"
echo "Cursor auth.json 已写入 ${HOME}/.config/cursor/auth.json"
