#!/usr/bin/env python3
"""Kaggle Kernel：DuckDB 计算因子 panel + 确定性 IC 指标（支持批量）。"""

from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

KERNEL_INPUTS_INLINE = None  # __KERNEL_INPUTS_INLINE__

WORKING = Path("/kaggle/working")


def load_kernel_inputs() -> dict[str, Any]:
    if KERNEL_INPUTS_INLINE is not None:
        return json.loads(KERNEL_INPUTS_INLINE)
    path = SCRIPT_DIR / "kernel_inputs.json"
    if path.is_file():
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    raise RuntimeError("缺少 kernel_inputs")


def normalize_kernel_jobs(inputs: dict[str, Any]) -> list[dict[str, Any]]:
    batch = inputs.get("batch")
    if isinstance(batch, list) and batch:
        return batch
    if "idea" in inputs and "factor_sql" in inputs:
        return [{"idea": inputs["idea"], "factor_sql": inputs["factor_sql"]}]
    raise RuntimeError("kernel_inputs 缺少 batch 或 idea/factor_sql")


def build_failed_evaluation(
    *,
    idea: dict[str, Any],
    factor_sql: dict[str, Any],
    error: str,
    engine_version: str,
    metrics_version: str,
    formula_hash_fn,
) -> dict[str, Any]:
    evaluation_type = factor_sql.get("evaluation_type", "cross_sectional")
    sample_start = ""
    return {
        "status": "failed",
        "title": idea["title"],
        "title_hash": idea["title_hash"],
        "formula_hash": idea.get("formula_hash") or formula_hash_fn(idea["formula_sketch"]),
        "expression_version": factor_sql.get("version", "1"),
        "engine_version": engine_version,
        "metrics_version": metrics_version,
        "evaluation_type": evaluation_type,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "data_range": {"start": sample_start, "end": sample_start, "n_bars": 0},
        "factor_sql": factor_sql,
        "metrics": {
            "mean_ic": 0.0,
            "ic_ir": None,
            "mean_rank_ic": 0.0,
            "rank_ic_ir": None,
            "n_periods": 0,
            "ic_positive_ratio": 0.0,
        },
        "diagnostics": {"error": error},
    }


def evaluate_job(
    job: dict[str, Any],
    *,
    sample_start: str,
    target_file: str,
    engine_version: str,
    metrics_version: str,
    evaluate_factor_sql,
    resolve_kaggle_data_path,
    formula_hash,
    index: int,
    total: int,
) -> dict[str, Any]:
    idea = job["idea"]
    factor_sql = job["factor_sql"]
    title = idea["title"]
    print(f"[{index}/{total}] 评估: {title}")

    dataset_slug = factor_sql.get("data_source") or idea["data_sources"][0]
    data_path = resolve_kaggle_data_path(dataset_slug, target_file)
    print(f"  数据路径: {data_path}")

    try:
        panel_path = WORKING / f"panel_{idea['title_hash']}.parquet"
        return evaluate_factor_sql(
            factor_sql,
            title=title,
            title_hash=idea["title_hash"],
            formula_sketch=idea["formula_sketch"],
            data_path=data_path,
            sample_start=sample_start,
            save_panel_path=panel_path,
        )
    except Exception as exc:
        print(f"  评估失败: {exc}")
        traceback.print_exc()
        return build_failed_evaluation(
            idea=idea,
            factor_sql=factor_sql,
            error=str(exc),
            engine_version=engine_version,
            metrics_version=metrics_version,
            formula_hash_fn=formula_hash,
        )


def main() -> int:
    from evaluate_engine import ENGINE_VERSION, METRICS_VERSION, evaluate_factor_sql, formula_hash, resolve_kaggle_data_path

    inputs = load_kernel_inputs()
    jobs = normalize_kernel_jobs(inputs)
    sample_start = inputs.get("sample_start", "2023-01-01")
    target_file = inputs.get("target_file", "futures/um/klines/1h.parquet")
    engine_version = inputs.get("engine_version", ENGINE_VERSION)

    evaluations: list[dict[str, Any]] = []
    for index, job in enumerate(jobs, start=1):
        evaluations.append(
            evaluate_job(
                job,
                sample_start=sample_start,
                target_file=target_file,
                engine_version=engine_version,
                metrics_version=METRICS_VERSION,
                evaluate_factor_sql=evaluate_factor_sql,
                resolve_kaggle_data_path=resolve_kaggle_data_path,
                formula_hash=formula_hash,
                index=index,
                total=len(jobs),
            )
        )

    batch_payload = {
        "evaluations": evaluations,
        "count": len(evaluations),
        "success": sum(1 for item in evaluations if item.get("status") == "success"),
        "failed": sum(1 for item in evaluations if item.get("status") == "failed"),
        "skipped": sum(1 for item in evaluations if item.get("status") == "skipped"),
    }
    batch_path = WORKING / "batch_evaluations.json"
    batch_path.write_text(
        json.dumps(batch_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(batch_payload, ensure_ascii=False, indent=2))
    print(f"已写入 {batch_path}")

    if len(evaluations) == 1:
        single_path = WORKING / "evaluation.json"
        single_path.write_text(
            json.dumps(evaluations[0], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已写入 {single_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
