"""生产因子验证 Prefect flow。"""

from __future__ import annotations

import time
from typing import Any

from prefect import flow

from tasks.evaluate import (
    assemble_run_result_task,
    build_report_items,
    ensure_mlflow_runtime_task,
    evaluate_factor_sql_task,
    log_mlflow_task,
    resolve_data_path_task,
)
from tasks.report_to_worker import report_to_worker


def _merge_timing(*parts: dict[str, int] | None) -> dict[str, int]:
    timing: dict[str, int] = {}
    for part in parts:
        if isinstance(part, dict):
            timing.update(part)
    return timing


def _report_phase_name(phase: str | None) -> str:
    text = str(phase or "unknown").strip() or "unknown"
    return f"report-{text}-to-worker"


@flow(name="factor-validation", log_prints=True)
def run_factor_validation(
    business_type: str = "factor_validation",
    task_id: int = 0,
    validation_id: int = 0,
    job: dict[str, Any] | None = None,
    sample_start: str = "2023-01-01",
    runtime_config: dict[str, Any] | None = None,
    callback_base_url: str | None = None,
    mlflow_config: dict[str, Any] | None = None,
    skip_mlflow: bool = False,
) -> dict[str, Any]:
    """按阶段执行 factor_validation，各阶段在 Prefect UI 中独立可见。"""
    job = job or {}
    runtime_config = runtime_config or {}
    mlflow_preinstalled = bool(runtime_config.get("mlflow_preinstalled", True))
    flow_started = time.perf_counter()

    import_timing = ensure_mlflow_runtime_task(mlflow_preinstalled=mlflow_preinstalled)
    resolve_result = resolve_data_path_task(job, runtime_config=runtime_config)
    data_path = str(resolve_result["data_path"])

    eval_result = evaluate_factor_sql_task(
        job,
        data_path=data_path,
        sample_start=sample_start,
    )
    evaluation = eval_result["evaluation"]

    mlflow_meta = None
    mlflow_error = None
    mlflow_timing: dict[str, int] = {}
    mlflow_attempted = False
    if not skip_mlflow and eval_result["status"] == "success":
        mlflow_attempted = True
        mlflow_result = log_mlflow_task(
            job,
            evaluation,
            runtime_config=runtime_config,
            mlflow_config=mlflow_config,
        )
        mlflow_meta = mlflow_result.get("mlflow")
        mlflow_error = mlflow_result.get("error_reason")
        mlflow_timing = mlflow_result.get("timing") or {}

    timing = _merge_timing(
        import_timing,
        resolve_result.get("timing"),
        eval_result.get("timing"),
        mlflow_timing,
    )
    total_ms = int((time.perf_counter() - flow_started) * 1000)

    run_result = assemble_run_result_task(
        job,
        evaluation=evaluation,
        mlflow_meta=mlflow_meta,
        data_path=data_path,
        timing=timing,
        error_reason=mlflow_error or evaluation.get("error_reason"),
        total_ms=total_ms,
        mlflow_attempted=mlflow_attempted,
    )

    items = build_report_items(business_type, job, run_result)
    report_responses: list[dict[str, Any]] = []
    for item in items:
        phase = (item.get("diagnostics") or {}).get("report_phase")
        reporter = report_to_worker.with_options(name=_report_phase_name(phase))
        response = reporter(
            business_type,
            [item],
            callback_base_url=callback_base_url,
        )
        report_responses.append({"phase": phase, "response": response})

    return {
        "task_id": task_id,
        "validation_id": validation_id,
        "business_type": business_type,
        "status": run_result.get("status"),
        "report_responses": report_responses,
        "timing": run_result.get("timing"),
    }
