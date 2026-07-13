"""因子验证执行：DuckDB 评估 + MLflow + Worker report items（Prefect / 本地共用）。"""

from __future__ import annotations

import contextlib
import io
import logging
import time
import traceback
from datetime import datetime, timezone
from typing import Any

try:
    from scripts.evaluate_engine import evaluate_factor_sql, resolve_data_path
    from scripts.mlflow_logger import log_factor_validation_run
except ImportError:
    from evaluate_engine import evaluate_factor_sql, resolve_data_path
    from mlflow_logger import log_factor_validation_run

BUSINESS_TYPE_FACTOR_VALIDATION = "factor_validation"


def _elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def _profile_key(job: dict[str, Any]) -> str:
    return str(
        job.get("validation_profile_key")
        or job.get("profile_key")
        or "fwd_ret_1"
    )


def _idea_from_job(job: dict[str, Any]) -> dict[str, Any]:
    idea = job.get("idea")
    if isinstance(idea, dict):
        return idea
    return {
        "title": job.get("title", ""),
        "title_hash": job.get("title_hash", ""),
        "formula_sketch": job.get("formula_sketch", ""),
        "data_sources": job.get("data_sources") or [],
    }


def _resolve_data_path(
    *,
    factor_sql: dict[str, Any],
    idea: dict[str, Any],
    runtime_config: dict[str, Any],
    target_file: str,
) -> str:
    dataset_slug = (
        runtime_config.get("dataset_slug")
        or factor_sql.get("data_source")
        or ((idea.get("data_sources") or [""])[0])
    )
    return resolve_data_path(
        str(dataset_slug),
        target_file,
        data_path_override=runtime_config.get("data_path"),
    )


def build_report_item(
    business_type: str,
    job: dict[str, Any],
    *,
    status: str,
    evaluation: dict[str, Any] | None = None,
    mlflow_meta: dict[str, Any] | None = None,
    error_reason: str | None = None,
    diagnostics: dict[str, Any] | None = None,
    report_phase: str | None = None,
) -> dict[str, Any]:
    """构造与 Worker /api/workflow/*/report 兼容的单条 item。"""
    task_id = int(job.get("task_id") or 0)
    merged_diag = dict(diagnostics or {})
    if report_phase:
        merged_diag["report_phase"] = report_phase

    factor_sql = job.get("factor_sql")
    evaluated_at = None
    if isinstance(evaluation, dict):
        factor_sql = evaluation.get("factor_sql") or factor_sql
        evaluated_at = evaluation.get("evaluated_at")

    item: dict[str, Any] = {
        "task_id": task_id,
        "status": status,
        "factor_sql": factor_sql,
        "evaluated_at": evaluated_at,
        "error_reason": error_reason,
        "diagnostics": merged_diag or None,
        "factor_validation_id": int(job.get("factor_validation_id") or 0),
    }

    if isinstance(mlflow_meta, dict):
        item["mlflow_run_id"] = mlflow_meta.get("mlflow_run_id")
        item["mlflow_experiment"] = mlflow_meta.get("mlflow_experiment")
        item["mlflow_run_url"] = mlflow_meta.get("mlflow_run_url")

    return item


def report_items_from_run_result(
    business_type: str,
    job: dict[str, Any],
    result: dict[str, Any],
) -> list[dict[str, Any]]:
    """将单次 run 结果展开为按阶段上报的 items（eval → mlflow）。"""
    status = str(result.get("status") or "failed")
    evaluation = result.get("evaluation")
    if not isinstance(evaluation, dict):
        evaluation = None
    diagnostics = dict(result.get("diagnostics") or {})
    if isinstance(evaluation, dict):
        eval_diag = evaluation.get("diagnostics")
        if isinstance(eval_diag, dict):
            diagnostics = {**eval_diag, **diagnostics}
    timing = result.get("timing")
    if isinstance(timing, dict) and timing:
        diagnostics["timing"] = timing

    items: list[dict[str, Any]] = []
    eval_status = str((evaluation or {}).get("status") or status)

    if eval_status == "success" and status == "success":
        items.append(
            build_report_item(
                business_type,
                job,
                status="running",
                evaluation=evaluation,
                diagnostics={**diagnostics, "report_phase": "eval"},
                report_phase="eval",
            )
        )
        items.append(
            build_report_item(
                business_type,
                job,
                status=status,
                evaluation=evaluation,
                mlflow_meta=result.get("mlflow"),
                error_reason=result.get("error_reason"),
                diagnostics={**diagnostics, "report_phase": "mlflow"},
                report_phase="mlflow",
            )
        )
        return items

    if eval_status == "success" and status == "failed":
        items.append(
            build_report_item(
                business_type,
                job,
                status="running",
                evaluation=evaluation,
                diagnostics={**diagnostics, "report_phase": "eval"},
                report_phase="eval",
            )
        )
        items.append(
            build_report_item(
                business_type,
                job,
                status="failed",
                evaluation=evaluation,
                error_reason=result.get("error_reason"),
                diagnostics={**diagnostics, "report_phase": "mlflow"},
                report_phase="mlflow",
            )
        )
        return items

    phase = "eval" if eval_status != "success" else "mlflow"
    items.append(
        build_report_item(
            business_type,
            job,
            status=status,
            evaluation=evaluation,
            error_reason=result.get("error_reason"),
            diagnostics={**diagnostics, "report_phase": phase},
            report_phase=phase,
        )
    )
    return items


def _ensure_mlflow(mlflow_preinstalled: bool = True) -> None:
    try:
        import mlflow  # noqa: F401
        return
    except ImportError:
        if mlflow_preinstalled:
            raise RuntimeError(
                "mlflow 未安装：请在运行环境中预装 mlflow>=2.14.0"
            )
        import subprocess
        import sys

        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "mlflow>=2.14.0"],
            timeout=300,
        )


def _log_mlflow(
    *,
    evaluation: dict[str, Any],
    job: dict[str, Any],
    mlflow_config: dict[str, Any],
    mlflow_slim: bool,
) -> dict[str, Any]:
    task_id = int(job.get("task_id") or 0)
    idea_id = int(job.get("idea_id") or 0)
    profile_key = _profile_key(job)
    validation_id = int(job.get("factor_validation_id") or 0)
    logging.getLogger("mlflow").setLevel(logging.ERROR)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
        io.StringIO()
    ):
        return log_factor_validation_run(
            evaluation,
            task_id=task_id,
            factor_validation_id=validation_id,
            idea_id=idea_id,
            profile_key=profile_key,
            mlflow_config=mlflow_config,
            slim=mlflow_slim,
        )


def ensure_factor_validation_mlflow_runtime(
    *, mlflow_preinstalled: bool = True
) -> dict[str, int]:
    started = time.perf_counter()
    _ensure_mlflow(mlflow_preinstalled)
    return {"t_import_mlflow_ms": _elapsed_ms(started)}


def resolve_factor_validation_data_path(
    job: dict[str, Any],
    *,
    runtime_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    runtime_config = runtime_config or {}
    idea = _idea_from_job(job)
    factor_sql = job.get("factor_sql") or {}
    target_file = runtime_config.get("target_file") or "futures/um/klines/1h.parquet"
    started = time.perf_counter()
    data_path = _resolve_data_path(
        factor_sql=factor_sql,
        idea=idea,
        runtime_config=runtime_config,
        target_file=target_file,
    )
    return {
        "data_path": data_path,
        "timing": {"t_resolve_data_path_ms": _elapsed_ms(started)},
    }


def evaluate_factor_validation_sql(
    job: dict[str, Any],
    *,
    data_path: str,
    sample_start: str = "2023-01-01",
) -> dict[str, Any]:
    idea = _idea_from_job(job)
    factor_sql = job.get("factor_sql") or {}
    profile_key = _profile_key(job)
    started = time.perf_counter()
    evaluation = evaluate_factor_sql(
        factor_sql,
        title=str(idea.get("title", "")),
        title_hash=str(idea.get("title_hash", "")),
        formula_sketch=str(idea.get("formula_sketch", "")),
        data_path=data_path,
        sample_start=sample_start,
        validation_profile_key=profile_key,
        label_kind=job.get("label_kind"),
        horizon_bars=job.get("horizon_bars"),
    )
    evaluation["task_id"] = job.get("task_id")
    evaluation["factor_validation_id"] = job.get("factor_validation_id")
    return {
        "evaluation": evaluation,
        "timing": {"t_eval_ms": _elapsed_ms(started)},
        "status": str(evaluation.get("status", "failed")),
    }


def log_factor_validation_mlflow(
    job: dict[str, Any],
    evaluation: dict[str, Any],
    *,
    mlflow_config: dict[str, Any] | None = None,
    mlflow_slim: bool = True,
) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        mlflow_meta = _log_mlflow(
            evaluation=evaluation,
            job=job,
            mlflow_config=mlflow_config or {},
            mlflow_slim=mlflow_slim,
        )
        return {
            "mlflow": mlflow_meta,
            "timing": {"t_mlflow_ms": _elapsed_ms(started)},
            "status": "success" if mlflow_meta else "failed",
        }
    except Exception as exc:
        return {
            "mlflow": None,
            "timing": {"t_mlflow_ms": _elapsed_ms(started)},
            "status": "failed",
            "error_reason": f"MLflow 写入失败: {exc}",
        }


def assemble_factor_validation_run_result(
    job: dict[str, Any],
    *,
    evaluation: dict[str, Any] | None,
    mlflow_meta: dict[str, Any] | None,
    data_path: str | None,
    timing: dict[str, int] | None,
    error_reason: str | None = None,
    total_ms: int | None = None,
    mlflow_attempted: bool = True,
) -> dict[str, Any]:
    task_id = job.get("task_id")
    factor_validation_id = job.get("factor_validation_id")
    evaluation = evaluation if isinstance(evaluation, dict) else None
    eval_status = str((evaluation or {}).get("status", "failed"))
    final_status = eval_status
    merged_error = error_reason or (evaluation or {}).get("error_reason")
    diagnostics = dict((evaluation or {}).get("diagnostics") or {})
    merged_timing = dict(timing or {})
    if total_ms is not None:
        merged_timing["t_total_ms"] = total_ms
    if data_path:
        diagnostics["data_path"] = data_path
    diagnostics["timing"] = dict(merged_timing)

    if eval_status == "success":
        if not mlflow_attempted:
            final_status = "success"
        else:
            final_status = "success" if mlflow_meta else "failed"

    return {
        "task_id": task_id,
        "factor_validation_id": factor_validation_id,
        "status": final_status,
        "evaluation": evaluation,
        "mlflow": mlflow_meta,
        "timing": merged_timing,
        "diagnostics": diagnostics,
        "error_reason": merged_error,
    }


def run_factor_validation_job(
    job: dict[str, Any],
    *,
    sample_start: str = "2023-01-01",
    runtime_config: dict[str, Any] | None = None,
    mlflow_config: dict[str, Any] | None = None,
    mlflow_slim: bool = True,
    mlflow_preinstalled: bool = True,
) -> dict[str, Any]:
    """DuckDB 评估 + MLflow（factor_validation）。"""
    runtime_config = runtime_config or {}
    job_started = time.perf_counter()
    timing: dict[str, int] = {}

    try:
        timing.update(
            ensure_factor_validation_mlflow_runtime(mlflow_preinstalled=mlflow_preinstalled)
        )
        resolve_result = resolve_factor_validation_data_path(
            job, runtime_config=runtime_config
        )
        timing.update(resolve_result["timing"])
        eval_result = evaluate_factor_validation_sql(
            job,
            data_path=resolve_result["data_path"],
            sample_start=sample_start,
        )
        timing.update(eval_result["timing"])
        evaluation = eval_result["evaluation"]
        mlflow_meta = None
        error_reason = evaluation.get("error_reason")
        if eval_result["status"] == "success":
            mlflow_result = log_factor_validation_mlflow(
                job,
                evaluation,
                mlflow_config=mlflow_config,
                mlflow_slim=mlflow_slim,
            )
            timing.update(mlflow_result["timing"])
            mlflow_meta = mlflow_result.get("mlflow")
            error_reason = mlflow_result.get("error_reason") or error_reason

        return assemble_factor_validation_run_result(
            job,
            evaluation=evaluation,
            mlflow_meta=mlflow_meta,
            data_path=resolve_result["data_path"],
            timing=timing,
            error_reason=error_reason,
            total_ms=_elapsed_ms(job_started),
            mlflow_attempted=eval_result["status"] == "success",
        )
    except Exception as exc:
        timing["t_total_ms"] = _elapsed_ms(job_started)
        return {
            "task_id": job.get("task_id"),
            "factor_validation_id": job.get("factor_validation_id"),
            "status": "failed",
            "diagnostics": {
                "error": str(exc),
                "traceback": traceback.format_exc(limit=3),
                "timing": timing,
            },
            "error_reason": str(exc),
            "timing": timing,
        }


def run_validation_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """执行 payload（含 jobs 列表），返回 kernel 兼容的 results 列表。"""
    business_type = str(payload.get("business_type") or BUSINESS_TYPE_FACTOR_VALIDATION)
    jobs = payload.get("jobs") or []
    if not isinstance(jobs, list):
        jobs = []

    sample_start = str(payload.get("sample_start") or "2023-01-01")
    runtime_config = payload.get("runtime_config") or {}
    mlflow_config = payload.get("mlflow_config") or {}
    mlflow_slim = bool(payload.get("mlflow_slim", True))
    mlflow_preinstalled = bool(payload.get("mlflow_preinstalled", True))
    skip_mlflow = bool(payload.get("skip_mlflow", False))

    results: list[dict[str, Any]] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        results.append(
            run_factor_validation_job(
                job,
                sample_start=sample_start,
                runtime_config=runtime_config,
                mlflow_config=mlflow_config,
                mlflow_slim=mlflow_slim,
                mlflow_preinstalled=mlflow_preinstalled,
            )
        )
    return results


def build_prefect_job_payload(
    job: dict[str, Any],
    *,
    business_type: str,
    runtime_config: dict[str, Any] | None = None,
    sample_start: str = "2023-01-01",
    skip_mlflow: bool = False,
) -> dict[str, Any]:
    """构造 Prefect flow 参数中的 job 字段。"""
    idea = _idea_from_job(job)
    enriched = {
        **job,
        "idea": idea,
        "validation_profile_key": _profile_key(job),
    }
    return {
        "business_type": business_type,
        "task_id": int(job.get("task_id") or 0),
        "validation_id": int(job.get("factor_validation_id") or 0),
        "job": enriched,
        "sample_start": sample_start,
        "runtime_config": runtime_config or {},
        "skip_mlflow": skip_mlflow,
    }
