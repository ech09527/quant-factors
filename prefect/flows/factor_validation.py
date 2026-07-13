"""生产因子验证 Prefect flow。"""

from __future__ import annotations

from typing import Any

from prefect import flow

from tasks.evaluate import build_report_items, evaluate_validation_job
from tasks.report_to_worker import report_phases_to_worker


@flow(name="factor-validation", log_prints=True)
def run_factor_validation(
    business_type: str = "factor_validation",
    task_id: int = 0,
    validation_id: int = 0,
    job: dict[str, Any] | None = None,
    sample_start: str = "2023-01-01",
    runtime_config: dict[str, Any] | None = None,
    callback_base_url: str | None = None,
    skip_mlflow: bool = False,
) -> dict[str, Any]:
    """执行单条 factor_validation 并回写 Worker。"""
    job = job or {}
    run_result = evaluate_validation_job(
        business_type,
        job,
        sample_start=sample_start,
        runtime_config=runtime_config or {},
        skip_mlflow=skip_mlflow,
    )
    items = build_report_items(business_type, job, run_result)
    report_responses = report_phases_to_worker(
        business_type,
        items,
        callback_base_url=callback_base_url,
    )
    return {
        "task_id": task_id,
        "validation_id": validation_id,
        "business_type": business_type,
        "status": run_result.get("status"),
        "report_responses": report_responses,
        "timing": run_result.get("timing"),
    }
