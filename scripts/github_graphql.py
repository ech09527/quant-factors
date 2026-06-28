"""GitHub GraphQL API 共用客户端。"""

from __future__ import annotations

import os
import sys
from typing import Any

import requests

GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"


def get_github_token() -> str:
    """从 GITHUB_TOKEN 或 GH_TOKEN 环境变量读取 token。"""
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise RuntimeError("未设置 GITHUB_TOKEN 或 GH_TOKEN 环境变量")
    return token


def graphql_request(
    token: str,
    query: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """发送 GraphQL 请求，返回 data 字段；出错时抛出 RuntimeError。"""
    payload: dict[str, Any] = {"query": query}
    if variables is not None:
        payload["variables"] = variables

    response = requests.post(
        GITHUB_GRAPHQL_URL,
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=60,
    )
    response.raise_for_status()
    body = response.json()

    if body.get("errors"):
        messages = "; ".join(
            err.get("message", str(err)) for err in body["errors"]
        )
        raise RuntimeError(f"GraphQL 错误: {messages}")

    return body.get("data", {})
