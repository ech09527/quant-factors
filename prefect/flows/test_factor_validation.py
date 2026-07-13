"""测试因子验证 Prefect flow（mock eval）。"""

from __future__ import annotations

from typing import Any

from prefect import flow

from flows.factor_validation import run_factor_validation


@flow(name="test-factor-validation", log_prints=True)
def run_test_factor_validation(
    business_type: str = "test_factor_validation",
    task_id: int = 0,
    validation_id: int = 0,
    job: dict[str, Any] | None = None,
    sample_start: str = "2023-01-01",
    runtime_config: dict[str, Any] | None = None,
    callback_base_url: str | None = None,
    skip_mlflow: bool | None = None,
) -> dict[str, Any]:
    """执行单条 test_factor_validation（默认 mock，可 skip_mlflow）。"""
    import os

    if skip_mlflow is None:
        flag = os.getenv("TEST_FACTOR_VALIDATION_SKIP_MLFLOW", "1").strip().lower()
        skip_mlflow = flag in {"1", "true", "yes", "on"}

    return run_factor_validation(
        business_type=business_type,
        task_id=task_id,
        validation_id=validation_id,
        job=job,
        sample_start=sample_start,
        runtime_config=runtime_config,
        callback_base_url=callback_base_url,
        skip_mlflow=bool(skip_mlflow),
    )
