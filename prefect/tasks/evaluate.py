"""因子验证各执行阶段（每个阶段对应独立 Prefect task）。"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from prefect import task

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.factor_validation_runner import (  # noqa: E402
    BUSINESS_TYPE_FACTOR_VALIDATION,
    assemble_factor_validation_run_result,
    ensure_factor_validation_mlflow_runtime,
    evaluate_factor_validation_sql,
    log_factor_validation_mlflow,
    report_items_from_run_result,
    resolve_factor_validation_data_path,
)
from scripts.mlflow_logger import resolve_mlflow_config  # noqa: E402


def _resolve_mlflow_config(mlflow_config: dict[str, Any] | None) -> dict[str, str]:
    overrides: dict[str, Any] = {}
    if isinstance(mlflow_config, dict) and str(mlflow_config.get("tracking_uri") or "").strip():
        overrides = mlflow_config
    return resolve_mlflow_config(overrides or None)


def _runtime_flags(runtime_config: dict[str, Any] | None) -> tuple[bool, bool]:
    runtime_config = runtime_config or {}
    mlflow_slim = bool(runtime_config.get("mlflow_slim", True))
    mlflow_preinstalled = bool(runtime_config.get("mlflow_preinstalled", True))
    return mlflow_slim, mlflow_preinstalled


@task(name="ensure-mlflow-runtime", retries=0, log_prints=True)
def ensure_mlflow_runtime_task(
    *,
    mlflow_preinstalled: bool = True,
) -> dict[str, int]:
    return ensure_factor_validation_mlflow_runtime(mlflow_preinstalled=mlflow_preinstalled)


@task(name="resolve-data-path", retries=0, log_prints=True)
def resolve_data_path_task(
    job: dict[str, Any],
    *,
    runtime_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return resolve_factor_validation_data_path(job, runtime_config=runtime_config)


@task(name="evaluate-factor-sql", retries=0, log_prints=True)
def evaluate_factor_sql_task(
    job: dict[str, Any],
    *,
    data_path: str,
    sample_start: str = "2023-01-01",
) -> dict[str, Any]:
    return evaluate_factor_validation_sql(
        job,
        data_path=data_path,
        sample_start=sample_start,
    )


@task(name="log-mlflow", retries=0, log_prints=True)
def log_mlflow_task(
    job: dict[str, Any],
    evaluation: dict[str, Any],
    *,
    runtime_config: dict[str, Any] | None = None,
    mlflow_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mlflow_slim, _ = _runtime_flags(runtime_config)
    return log_factor_validation_mlflow(
        job,
        evaluation,
        mlflow_config=_resolve_mlflow_config(mlflow_config),
        mlflow_slim=mlflow_slim,
    )


@task(name="assemble-run-result", retries=0)
def assemble_run_result_task(
    job: dict[str, Any],
    *,
    evaluation: dict[str, Any] | None,
    mlflow_meta: dict[str, Any] | None,
    data_path: str | None,
    timing: dict[str, int],
    error_reason: str | None = None,
    total_ms: int,
    mlflow_attempted: bool,
) -> dict[str, Any]:
    return assemble_factor_validation_run_result(
        job,
        evaluation=evaluation,
        mlflow_meta=mlflow_meta,
        data_path=data_path,
        timing=timing,
        error_reason=error_reason,
        total_ms=total_ms,
        mlflow_attempted=mlflow_attempted,
    )


@task(name="build-report-items", retries=0)
def build_report_items(
    business_type: str,
    job: dict[str, Any],
    run_result: dict[str, Any],
) -> list[dict[str, Any]]:
    return report_items_from_run_result(
        business_type or BUSINESS_TYPE_FACTOR_VALIDATION,
        job,
        run_result,
    )
