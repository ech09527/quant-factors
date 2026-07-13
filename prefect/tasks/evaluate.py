"""执行因子验证并生成 report items。"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from prefect import task

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.factor_validation_runner import (  # noqa: E402
    BUSINESS_TYPE_FACTOR_VALIDATION,
    BUSINESS_TYPE_TEST_FACTOR_VALIDATION,
    report_items_from_run_result,
    run_factor_validation_job,
    run_test_factor_validation_job,
)


def _read_mlflow_config() -> dict[str, Any]:
    return {
        "tracking_uri": (
            os.getenv("MLFLOW_TRACKING_URI", "").strip()
            or os.getenv("MLFLOW_TRACKING_URL", "").strip()
        ),
        "username": (
            os.getenv("MLFLOW_TRACKING_USERNAME", "").strip()
            or os.getenv("DAGSHUB_USER", "").strip()
        ),
        "password": (
            os.getenv("MLFLOW_TRACKING_PASSWORD", "").strip()
            or os.getenv("DAGSHUB_TOKEN", "").strip()
        ),
        "experiment": (
            os.getenv("MLFLOW_EXPERIMENT_NAME", "").strip()
            or (
                os.getenv("MLFLOW_EXPERIMENT_TEST_FACTOR_VALIDATION", "").strip()
                if os.getenv("QF_BUSINESS_TYPE") == BUSINESS_TYPE_TEST_FACTOR_VALIDATION
                else os.getenv("MLFLOW_EXPERIMENT_FACTOR_VALIDATION", "factor-validation")
            )
        ),
    }


@task(name="evaluate-validation-job", retries=0, log_prints=True)
def evaluate_validation_job(
    business_type: str,
    job: dict[str, Any],
    *,
    sample_start: str = "2023-01-01",
    runtime_config: dict[str, Any] | None = None,
    skip_mlflow: bool = False,
) -> dict[str, Any]:
    """运行单条验证任务，返回 run result。"""
    mlflow_config = _read_mlflow_config()
    runtime_config = runtime_config or {}
    mlflow_slim = bool(runtime_config.get("mlflow_slim", True))
    mlflow_preinstalled = bool(runtime_config.get("mlflow_preinstalled", True))

    if business_type == BUSINESS_TYPE_TEST_FACTOR_VALIDATION:
        return run_test_factor_validation_job(
            job,
            mlflow_config=mlflow_config,
            mlflow_slim=mlflow_slim,
            mlflow_preinstalled=mlflow_preinstalled,
            skip_mlflow=skip_mlflow,
        )

    return run_factor_validation_job(
        job,
        sample_start=sample_start,
        runtime_config=runtime_config,
        mlflow_config=mlflow_config,
        mlflow_slim=mlflow_slim,
        mlflow_preinstalled=mlflow_preinstalled,
    )


@task(name="build-report-items", retries=0)
def build_report_items(
    business_type: str,
    job: dict[str, Any],
    run_result: dict[str, Any],
) -> list[dict[str, Any]]:
    return report_items_from_run_result(business_type, job, run_result)
