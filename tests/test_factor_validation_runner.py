"""factor_validation_runner 单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.factor_validation_runner import (
    BUSINESS_TYPE_FACTOR_VALIDATION,
    assemble_factor_validation_run_result,
    build_report_item,
    report_items_from_run_result,
)


def test_build_report_item_factor_validation():
    item = build_report_item(
        BUSINESS_TYPE_FACTOR_VALIDATION,
        {"task_id": 1, "factor_validation_id": 10, "factor_sql": {"version": "1"}},
        status="running",
        report_phase="eval",
        diagnostics={"report_phase": "eval"},
    )
    assert item["task_id"] == 1
    assert item["factor_validation_id"] == 10
    assert item["status"] == "running"
    assert item["diagnostics"]["report_phase"] == "eval"


def test_report_items_two_phase_success():
    job = {"task_id": 2, "factor_validation_id": 20}
    result = {
        "status": "success",
        "evaluation": {
            "status": "success",
            "evaluated_at": "2024-01-01T00:00:00Z",
            "factor_sql": {"version": "1"},
            "metrics": {"mean_ic": 0.1},
        },
        "mlflow": {
            "mlflow_run_id": "abc",
            "mlflow_experiment": "factor-validation",
            "mlflow_run_url": "https://example/run",
        },
        "timing": {"t_eval_ms": 100},
    }
    items = report_items_from_run_result(BUSINESS_TYPE_FACTOR_VALIDATION, job, result)
    assert len(items) == 2
    assert items[0]["status"] == "running"
    assert items[0]["diagnostics"]["report_phase"] == "eval"
    assert items[1]["status"] == "success"
    assert items[1]["diagnostics"]["report_phase"] == "mlflow"
    assert items[1]["mlflow_run_id"] == "abc"


def test_report_items_eval_failed_single_phase():
    job = {"task_id": 3, "factor_validation_id": 30}
    result = {
        "status": "failed",
        "evaluation": {"status": "failed", "error_reason": "duckdb error"},
        "error_reason": "duckdb error",
    }
    items = report_items_from_run_result(BUSINESS_TYPE_FACTOR_VALIDATION, job, result)
    assert len(items) == 1
    assert items[0]["status"] == "failed"
    assert items[0]["diagnostics"]["report_phase"] == "eval"


def test_assemble_run_result_allows_skip_mlflow():
    job = {"task_id": 4, "factor_validation_id": 40}
    evaluation = {
        "status": "success",
        "factor_sql": {"version": "1"},
        "evaluated_at": "2024-01-01T00:00:00Z",
    }
    result = assemble_factor_validation_run_result(
        job,
        evaluation=evaluation,
        mlflow_meta=None,
        data_path="/data/test.parquet",
        timing={"t_eval_ms": 120},
        mlflow_attempted=False,
    )
    assert result["status"] == "success"
    assert result["mlflow"] is None
