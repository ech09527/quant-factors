"""将因子验证结果写入 DagsHub / MLflow。"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

FACTOR_VALIDATION_EXPERIMENT = "factor-validation"
TEST_FACTOR_VALIDATION_EXPERIMENT = "test-factor-validation"


def resolve_mlflow_config(overrides: dict[str, Any] | None = None) -> dict[str, str]:
    """从环境变量与 overrides 解析 MLflow 连接配置。"""
    src = overrides or {}
    tracking_uri = (
        str(src.get("tracking_uri") or "").strip()
        or os.getenv("MLFLOW_TRACKING_URI", "").strip()
        or os.getenv("MLFLOW_TRACKING_URL", "").strip()
    )
    username = (
        str(src.get("username") or "").strip()
        or os.getenv("MLFLOW_TRACKING_USERNAME", "").strip()
        or os.getenv("DAGSHUB_USER", "").strip()
    )
    password = (
        str(src.get("password") or "").strip()
        or os.getenv("MLFLOW_TRACKING_PASSWORD", "").strip()
        or os.getenv("DAGSHUB_TOKEN", "").strip()
    )
    experiment = (
        str(src.get("experiment") or "").strip()
        or os.getenv("MLFLOW_EXPERIMENT_NAME", "").strip()
        or FACTOR_VALIDATION_EXPERIMENT
    )
    if not tracking_uri:
        raise ValueError("缺少 MLflow tracking URI（MLFLOW_TRACKING_URI 或 MLFLOW_TRACKING_URL）")
    if not username or not password:
        raise ValueError(
            "缺少 DagsHub 凭证（MLFLOW_TRACKING_USERNAME + MLFLOW_TRACKING_PASSWORD）"
        )
    return {
        "tracking_uri": tracking_uri,
        "username": username,
        "password": password,
        "experiment": experiment,
    }


def _apply_mlflow_env(config: dict[str, str]) -> None:
    os.environ["MLFLOW_TRACKING_URI"] = config["tracking_uri"]
    os.environ["MLFLOW_TRACKING_USERNAME"] = config["username"]
    os.environ["MLFLOW_TRACKING_PASSWORD"] = config["password"]


def slim_ic_series_for_artifact(ic_series: dict[str, Any] | None) -> dict[str, Any] | None:
    """保留图表所需序列，去掉冗余字段。"""
    if not isinstance(ic_series, dict):
        return None
    points = ic_series.get("points")
    if not isinstance(points, list):
        return ic_series
    slim_points = []
    for point in points:
        if not isinstance(point, dict):
            continue
        slim_points.append(
            {
                "t": point.get("t"),
                "ic": point.get("ic"),
                "rank_ic": point.get("rank_ic"),
            }
        )
    return {
        "period_axis": ic_series.get("period_axis"),
        "n_points": ic_series.get("n_points", len(slim_points)),
        "points": slim_points,
    }


def log_factor_validation_run(
    evaluation: dict[str, Any],
    *,
    task_id: int,
    factor_validation_id: int,
    idea_id: int,
    profile_key: str,
    mlflow_config: dict[str, Any] | None = None,
    slim: bool = True,
    business_type: str = "factor_validation",
) -> dict[str, Any]:
    """将单次因子验证 evaluation 写入 MLflow，返回 run 元数据。"""
    import mlflow

    config = resolve_mlflow_config(mlflow_config)
    _apply_mlflow_env(config)

    status = str(evaluation.get("status", "failed"))
    business_type = str(business_type or "factor_validation").strip()
    validation_id = int(factor_validation_id or 0)
    tags = {
        "business_type": business_type,
        "task_id": str(task_id),
        "idea_id": str(idea_id),
        "profile_key": profile_key,
        "status": status,
        "title_hash": str(evaluation.get("title_hash", "")),
        "formula_hash": str(evaluation.get("formula_hash", "")),
        "validation_profile_key": str(
            evaluation.get("validation_profile_key") or profile_key
        ),
    }
    if business_type == "test_factor_validation":
        tags["test_factor_validation_id"] = str(validation_id)
        if evaluation.get("diagnostics", {}).get("mock"):
            tags["mock_eval"] = "1"
    else:
        tags["factor_validation_id"] = str(validation_id)

    run_prefix = "tfv" if business_type == "test_factor_validation" else "fv"
    run_name = f"{run_prefix}-{validation_id}-task-{task_id}"
    mlflow.set_experiment(config["experiment"])

    with mlflow.start_run(run_name=run_name) as run:
        for key, value in tags.items():
            if value:
                mlflow.set_tag(key, value)

        mlflow.log_param("task_id", task_id)
        mlflow.log_param("idea_id", idea_id)
        mlflow.log_param("profile_key", profile_key)
        if business_type == "test_factor_validation":
            mlflow.log_param("test_factor_validation_id", validation_id)
        else:
            mlflow.log_param("factor_validation_id", validation_id)
        mlflow.log_param("business_type", business_type)
        mlflow.log_param("evaluation_type", str(evaluation.get("evaluation_type", "")))
        mlflow.log_param("engine_version", str(evaluation.get("engine_version", "")))
        mlflow.log_param("metrics_version", str(evaluation.get("metrics_version", "")))
        mlflow.log_param("sample_start", str(evaluation.get("data_range", {}).get("start", "")))

        metrics = evaluation.get("metrics") or {}
        if isinstance(metrics, dict):
            for name in (
                "mean_ic",
                "ic_ir",
                "mean_rank_ic",
                "rank_ic_ir",
                "n_periods",
                "ic_positive_ratio",
            ):
                value = metrics.get(name)
                if isinstance(value, (int, float)) and value is not None:
                    mlflow.log_metric(name, float(value))

        diagnostics = evaluation.get("diagnostics") or {}
        if isinstance(diagnostics, dict):
            for name in ("skipped_periods_low_n", "avg_universe_size"):
                value = diagnostics.get(name)
                if isinstance(value, (int, float)) and value is not None:
                    mlflow.log_metric(name, float(value))

        ic_series = evaluation.get("ic_series")
        if isinstance(ic_series, dict):
            artifact = (
                slim_ic_series_for_artifact(ic_series) if slim else ic_series
            )
            if artifact is not None:
                mlflow.log_dict(artifact, "ic_series.json")

        if not slim:
            mlflow.log_dict(evaluation, "evaluation.json")
            factor_sql = evaluation.get("factor_sql")
            if isinstance(factor_sql, dict):
                mlflow.log_dict(factor_sql, "factor_sql.json")

        run_id = run.info.run_id
        experiment_id = run.info.experiment_id

    tracking_uri = config["tracking_uri"].rstrip("/")
    run_url = f"{tracking_uri}/#/experiments/{experiment_id}/runs/{run_id}"
    return {
        "mlflow_run_id": run_id,
        "mlflow_experiment": config["experiment"],
        "mlflow_experiment_id": experiment_id,
        "mlflow_run_url": run_url,
    }


def write_ic_series_artifact(path: Path, ic_series: dict[str, Any]) -> None:
    path.write_text(json.dumps(ic_series, ensure_ascii=False, indent=2), encoding="utf-8")


def smoke_test_connection(mlflow_config: dict[str, Any] | None = None) -> dict[str, Any]:
    """测试 MLflow 读写连通性。"""
    import mlflow

    config = resolve_mlflow_config(mlflow_config)
    _apply_mlflow_env(config)
    experiments = [exp.name for exp in mlflow.search_experiments(max_results=5)]
    mlflow.set_experiment(config["experiment"])
    with mlflow.start_run(run_name="connectivity_test") as run:
        mlflow.set_tag("smoke_test", "1")
        mlflow.log_metric("ping", 1.0)
        run_id = run.info.run_id
    return {
        "ok": True,
        "tracking_uri": config["tracking_uri"],
        "experiment": config["experiment"],
        "existing_experiments": experiments,
        "run_id": run_id,
    }
