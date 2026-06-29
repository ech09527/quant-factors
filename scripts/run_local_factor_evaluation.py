#!/usr/bin/env python3
"""在 Runner 上用合成数据本地执行因子评估（供 Cursor 修复循环快速反馈）。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import duckdb

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.evaluate_engine import (  # noqa: E402
    parse_sample_start_ms,
    run_panel_query,
    write_minimal_validation_parquet,
)

MIN_LOCAL_FACTOR_ROWS = int(os.environ.get("LOCAL_EVAL_MIN_FACTOR_ROWS", "50"))


def run_local_evaluation(
    idea: dict[str, Any],
    factor_sql: dict[str, Any],
    *,
    sample_start: str = "2023-01-01",
) -> dict[str, Any]:
    """在合成 parquet 上 dry-run panel SQL，验证 signal 非空（不算 IC 指标）。"""
    if factor_sql["evaluation_type"] != "cross_sectional":
        return {
            "status": "skipped",
            "local_eval": True,
            "skipped_reason": "time_series_local_smoke_skipped",
        }

    sample_start_ms = parse_sample_start_ms(sample_start)
    with tempfile.TemporaryDirectory() as tmp:
        parquet_path = Path(tmp) / "local_eval.parquet"
        write_minimal_validation_parquet(parquet_path, sample_start_ms=sample_start_ms)
        try:
            panel = run_panel_query(
                factor_sql,
                data_path=str(parquet_path),
                sample_start=sample_start,
            )
        except duckdb.Error as exc:
            raise ValueError(f"本地 DuckDB 执行失败: {exc}") from exc

    valid = panel.dropna(subset=["factor"])
    if len(valid) < MIN_LOCAL_FACTOR_ROWS:
        raise ValueError(
            f"本地 panel 有效 factor 行过少 ({len(valid)} < {MIN_LOCAL_FACTOR_ROWS})，"
            "signal_sql 可能产生空 panel"
        )

    return {
        "status": "success",
        "local_eval": True,
        "title": idea["title"],
        "title_hash": idea["title_hash"],
        "n_rows": int(len(valid)),
        "n_symbols": int(panel["symbol"].nunique()),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Runner 本地因子评估（合成数据）")
    parser.add_argument("--idea", type=Path, required=True)
    parser.add_argument("--factor-sql", type=Path, required=True)
    parser.add_argument(
        "--sample-start",
        default=os.environ.get("SAMPLE_START", "2023-01-01"),
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="可选：写入 evaluation JSON 的路径",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)
    with args.factor_sql.open(encoding="utf-8") as handle:
        factor_sql = json.load(handle)

    try:
        evaluation = run_local_evaluation(
            idea,
            factor_sql,
            sample_start=args.sample_start,
        )
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": evaluation["status"],
                "n_rows": evaluation.get("n_rows"),
                "n_symbols": evaluation.get("n_symbols"),
            },
            ensure_ascii=False,
        )
    )

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已写入 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
