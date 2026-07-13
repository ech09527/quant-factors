"""factor_validation_runner 单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.factor_validation_runner import (
    BUSINESS_TYPE_FACTOR_VALIDATION,
    BUSINESS_TYPE_TEST_FACTOR_VALIDATION,
    build_report_item,
    report_items_from_run_result,
    run_test_factor_validation_job,
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


def test_mock_test_factor_validation_skip_mlflow():
    job = {
        "task_id": 99,
        "test_factor_validation_id": 88,
        "idea_id": 1,
        "profile_key": "fwd_ret_1",
        "idea": {"title": "t", "title_hash": "h", "formula_sketch": "f"},
    }
    result = run_test_factor_validation_job(job, skip_mlflow=True)
    assert result["status"] == "success"
    assert result["evaluation"]["diagnostics"]["mock"] is True
    items = report_items_from_run_result(
        BUSINESS_TYPE_TEST_FACTOR_VALIDATION, job, result
    )
    assert items[-1]["status"] == "success"
    assert items[-1]["test_factor_validation_id"] == 88
