#!/usr/bin/env python3
"""测试 DagsHub MLflow 连接（需 .env 中配置凭证）。"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.mlflow_logger import resolve_mlflow_config, smoke_test_connection


def main() -> int:
    load_dotenv(ROOT / ".env")
    try:
        config = resolve_mlflow_config()
    except ValueError as exc:
        print(f"配置错误: {exc}", file=sys.stderr)
        return 1
    print(f"tracking_uri: {config['tracking_uri']}")
    print(f"username: {config['username']}")
    try:
        result = smoke_test_connection()
    except Exception as exc:
        print(f"连接失败: {exc}", file=sys.stderr)
        return 2
    print("连接成功:", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
