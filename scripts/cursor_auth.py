"""Cursor CLI 凭据解析与配置。

优先级：CURSOR_AUTH_JSON > CURSOR_API_KEY > ~/.config/cursor/auth.json

工作流 B 每次运行时，Runner 从 GitHub Secrets 读取凭据并嵌入 kernel_inputs，
Kaggle Kernel 优先使用嵌入字段，避免 Kaggle Notebook Secret 过期。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

DEFAULT_AUTH_PATH = Path.home() / ".config" / "cursor" / "auth.json"
DEFAULT_CURSOR_MODEL = "auto"


def resolve_cursor_auth_json(*, inputs: dict[str, Any] | None = None) -> str:
    """返回 auth.json 内容（最高优先级来源），无则返回空字符串。"""
    inputs = inputs or {}

    auth = str(inputs.get("cursor_auth_json") or "").strip()
    if auth:
        return auth

    return os.environ.get("CURSOR_AUTH_JSON", "").strip()


def resolve_cursor_api_key(*, inputs: dict[str, Any] | None = None) -> str:
    """返回 CURSOR_API_KEY（Runner 注入或环境变量），无则返回空字符串。"""
    inputs = inputs or {}

    api_key = str(inputs.get("cursor_api_key") or "").strip()
    if api_key:
        return api_key

    return os.environ.get("CURSOR_API_KEY", "").strip()


def resolve_cursor_model(*, inputs: dict[str, Any] | None = None) -> str:
    """返回 Cursor CLI 模型名；优先级：kernel_inputs > CURSOR_MODEL 环境变量 > auto。"""
    inputs = inputs or {}

    model = str(inputs.get("cursor_model") or "").strip()
    if model:
        return model

    return os.environ.get("CURSOR_MODEL", DEFAULT_CURSOR_MODEL).strip() or DEFAULT_CURSOR_MODEL


def has_cursor_credentials(*, inputs: dict[str, Any] | None = None) -> bool:
    if resolve_cursor_auth_json(inputs=inputs):
        return True
    if resolve_cursor_api_key(inputs=inputs):
        return True
    return DEFAULT_AUTH_PATH.is_file()


def _write_auth_json(auth_json: str) -> None:
    config_dir = DEFAULT_AUTH_PATH.parent
    config_dir.mkdir(parents=True, exist_ok=True)
    DEFAULT_AUTH_PATH.write_text(auth_json, encoding="utf-8")
    DEFAULT_AUTH_PATH.chmod(0o600)


def setup_cursor_auth(*, inputs: dict[str, Any] | None = None) -> bool:
    """配置 Cursor CLI 凭据，任一来源可用则返回 True。"""
    auth_json = resolve_cursor_auth_json(inputs=inputs)
    if auth_json:
        _write_auth_json(auth_json)
        return True

    api_key = resolve_cursor_api_key(inputs=inputs)
    if api_key:
        os.environ["CURSOR_API_KEY"] = api_key
        return True

    if DEFAULT_AUTH_PATH.is_file():
        return True

    return False


def build_kernel_cursor_inputs() -> dict[str, str]:
    """Runner 侧：从 GitHub Secrets / 环境 / 本地文件构建 kernel_inputs 凭据与模型字段。"""
    result: dict[str, str] = {}
    auth_json = os.environ.get("CURSOR_AUTH_JSON", "").strip()
    if auth_json:
        result["cursor_auth_json"] = auth_json
    else:
        api_key = os.environ.get("CURSOR_API_KEY", "").strip()
        if api_key:
            result["cursor_api_key"] = api_key
        elif DEFAULT_AUTH_PATH.is_file():
            result["cursor_auth_json"] = DEFAULT_AUTH_PATH.read_text(
                encoding="utf-8"
            ).strip()

    if not result:
        return {}

    result["cursor_model"] = resolve_cursor_model()
    return result
