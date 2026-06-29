#!/usr/bin/env python3
"""只读 DuckDB 查询助手：供 Cursor Agent 探索 K 线 Parquet。"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb

MAX_ROWS = int(os.environ.get("QUERY_KLINES_MAX_ROWS", "5000"))
QUERY_TIMEOUT_SECONDS = int(os.environ.get("QUERY_KLINES_TIMEOUT_SECONDS", "120"))
PARQUET_ENV = "KLINES_PARQUET_PATH"
LOG_PATH = Path(os.environ.get("EXPLORATION_LOG_PATH", "/kaggle/working/exploration_log.json"))

FORBIDDEN_PATTERN = re.compile(
    r"\b("
    r"insert|update|delete|drop|create|alter|truncate|copy|attach|detach|"
    r"export|import|load|install|replace|merge|grant|revoke|call|execute|"
    r"pragma|set\s+"
    r")\b",
    re.IGNORECASE,
)

VIEW_NAME = "klines"


def validate_read_only_sql(sql: str) -> None:
    """校验 SQL 为只读 SELECT / WITH 查询。"""
    stripped = re.sub(r"--[^\n]*", "", sql)
    stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL).strip()
    if not stripped:
        raise ValueError("SQL 不能为空")
    if FORBIDDEN_PATTERN.search(stripped):
        raise ValueError("仅允许只读 SELECT 查询")
    first_token = stripped.split(None, 1)[0].upper()
    if first_token not in {"SELECT", "WITH"}:
        raise ValueError("查询必须以 SELECT 或 WITH 开头")


def ensure_limit(sql: str, max_rows: int = MAX_ROWS) -> str:
    """无 LIMIT 时自动追加行数上限。"""
    stripped = sql.strip().rstrip(";")
    if re.search(r"\blimit\b", stripped, re.IGNORECASE):
        return stripped
    return f"{stripped}\nLIMIT {max_rows}"


def append_log_entry(sql: str, row_count: int, elapsed_ms: float) -> None:
    entries: list[dict] = []
    if LOG_PATH.is_file():
        try:
            with LOG_PATH.open(encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, list):
                entries = data
        except (json.JSONDecodeError, OSError):
            entries = []
    entries.append(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sql": sql,
            "row_count": row_count,
            "elapsed_ms": round(elapsed_ms, 1),
        }
    )
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_parquet_path() -> Path:
    raw = os.environ.get(PARQUET_ENV, "").strip()
    if not raw:
        raise RuntimeError(f"未设置环境变量 {PARQUET_ENV}")
    path = Path(raw)
    if not path.is_file():
        raise FileNotFoundError(f"Parquet 不存在: {path}")
    return path


def run_query(sql: str, *, parquet_path: Path | None = None) -> str:
    validate_read_only_sql(sql)
    bounded = ensure_limit(sql)
    parquet = parquet_path or resolve_parquet_path()

    started = time.monotonic()
    con = duckdb.connect()
    try:
        con.execute("SET enable_progress_bar = false")
        con.execute(
            f"CREATE OR REPLACE VIEW {VIEW_NAME} AS SELECT * FROM read_parquet(?)",
            [str(parquet)],
        )
        relation = con.sql(bounded)
        df = relation.fetchdf()
    finally:
        con.close()

    elapsed_ms = (time.monotonic() - started) * 1000
    append_log_entry(bounded, len(df), elapsed_ms)

    if df.empty:
        return "(0 rows)"
    if len(df) > MAX_ROWS:
        df = df.head(MAX_ROWS)
    return df.to_csv(index=False)


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print(
            f"用法: python query_klines.py \"SELECT ... FROM {VIEW_NAME} ...\"\n"
            f"环境: {PARQUET_ENV} 指向 Parquet 文件；单次最多返回 {MAX_ROWS} 行。",
            file=sys.stderr,
        )
        return 1

    sql = " ".join(args).strip()
    try:
        print(run_query(sql))
        return 0
    except (ValueError, FileNotFoundError, RuntimeError, duckdb.Error) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
