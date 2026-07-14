"""将因子验证结果写入 DagsHub / MLflow。"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

FACTOR_VALIDATION_EXPERIMENT = "factor-validation"
_logger = logging.getLogger(__name__)


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
        or os.getenv("MLFLOW_EXPERIMENT_FACTOR_VALIDATION", "").strip()
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


def artifact_proxy_relative_path(
    artifact_uri: str | None, run_id: str, artifact_path: str
) -> str | None:
    """从 run artifact_uri 推导 /api/2.0/mlflow-artifacts/artifacts/<path> 的相对路径。"""
    uri = str(artifact_uri or "").strip().rstrip("/")
    run = str(run_id or "").strip()
    file_name = str(artifact_path or "").lstrip("/")
    if not uri or not run or not file_name:
        return None

    if uri.startswith("mlflow-artifacts:"):
        root = uri.split(":", 1)[1].lstrip("/")
    elif re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", uri):
        root = (urllib.parse.urlparse(uri).path or "").lstrip("/")
    else:
        root = uri.lstrip("/")

    match = re.search(rf"(?:^|/)([^/]+)/{re.escape(run)}/artifacts$", root)
    if not match:
        return None
    return f"{match.group(1)}/{run}/artifacts/{file_name}"


def upload_artifact_via_tracking_server(
    *,
    tracking_uri: str,
    username: str,
    password: str,
    artifact_uri: str | None,
    experiment_id: str,
    run_id: str,
    artifact_path: str,
    content: bytes,
) -> bool:
    """通过 tracking server artifact proxy PUT 上传，兼容本地 artifact_uri 的自托管 MLflow。"""
    base = str(tracking_uri or "").rstrip("/")
    if not base or not content:
        return False

    candidates: list[str] = []
    proxy_path = artifact_proxy_relative_path(artifact_uri, run_id, artifact_path)
    if proxy_path:
        candidates.append(proxy_path)
    exp = str(experiment_id or "").strip()
    run = str(run_id or "").strip()
    file_name = str(artifact_path or "").lstrip("/")
    if exp and run and file_name:
        by_exp = f"{exp}/{run}/artifacts/{file_name}"
        if by_exp not in candidates:
            candidates.append(by_exp)

    auth = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    last_error = ""
    for relative in candidates:
        encoded = "/".join(urllib.parse.quote(part, safe="") for part in relative.split("/"))
        url = f"{base}/api/2.0/mlflow-artifacts/artifacts/{encoded}"
        request = urllib.request.Request(
            url,
            data=content,
            method="PUT",
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/octet-stream",
                "User-Agent": "quant-factors-mlflow-logger/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                if 200 <= getattr(response, "status", 200) < 300:
                    return True
                last_error = f"HTTP {getattr(response, 'status', '?')}"
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {exc.read()[:200]!r}"
        except Exception as exc:  # noqa: BLE001 - best-effort upload path
            last_error = str(exc)
    if last_error:
        _logger.warning("MLflow artifact proxy upload failed: %s", last_error)
    return False


def log_factor_validation_run(
    evaluation: dict[str, Any],
    *,
    task_id: int,
    factor_validation_id: int,
    idea_id: int,
    profile_key: str,
    mlflow_config: dict[str, Any] | None = None,
    slim: bool = True,
) -> dict[str, Any]:
    """将单次因子验证 evaluation 写入 MLflow，返回 run 元数据。"""
    import mlflow

    config = resolve_mlflow_config(mlflow_config)
    _apply_mlflow_env(config)

    status = str(evaluation.get("status", "failed"))
    validation_id = int(factor_validation_id or 0)
    tags = {
        "business_type": "factor_validation",
        "task_id": str(task_id),
        "idea_id": str(idea_id),
        "profile_key": profile_key,
        "status": status,
        "title_hash": str(evaluation.get("title_hash", "")),
        "formula_hash": str(evaluation.get("formula_hash", "")),
        "validation_profile_key": str(
            evaluation.get("validation_profile_key") or profile_key
        ),
        "factor_validation_id": str(validation_id),
    }

    run_name = f"fv-{validation_id}-task-{task_id}"
    mlflow.set_experiment(config["experiment"])

    pending_http_artifacts: list[tuple[str, bytes]] = []

    with mlflow.start_run(run_name=run_name) as run:
        for key, value in tags.items():
            if value:
                mlflow.set_tag(key, value)

        mlflow.log_param("task_id", task_id)
        mlflow.log_param("idea_id", idea_id)
        mlflow.log_param("profile_key", profile_key)
        mlflow.log_param("factor_validation_id", validation_id)
        mlflow.log_param("business_type", "factor_validation")
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
                try:
                    mlflow.log_dict(artifact, "ic_series.json")
                except Exception as exc:  # noqa: BLE001 - fall back to HTTP proxy
                    _logger.warning("mlflow.log_dict(ic_series.json) failed: %s", exc)
                pending_http_artifacts.append(
                    (
                        "ic_series.json",
                        json.dumps(artifact, ensure_ascii=False).encode("utf-8"),
                    )
                )

        if not slim:
            try:
                mlflow.log_dict(evaluation, "evaluation.json")
            except Exception as exc:  # noqa: BLE001
                _logger.warning("mlflow.log_dict(evaluation.json) failed: %s", exc)
            pending_http_artifacts.append(
                (
                    "evaluation.json",
                    json.dumps(evaluation, ensure_ascii=False).encode("utf-8"),
                )
            )
            factor_sql = evaluation.get("factor_sql")
            if isinstance(factor_sql, dict):
                try:
                    mlflow.log_dict(factor_sql, "factor_sql.json")
                except Exception as exc:  # noqa: BLE001
                    _logger.warning("mlflow.log_dict(factor_sql.json) failed: %s", exc)
                pending_http_artifacts.append(
                    (
                        "factor_sql.json",
                        json.dumps(factor_sql, ensure_ascii=False).encode("utf-8"),
                    )
                )

        run_id = run.info.run_id
        experiment_id = run.info.experiment_id
        artifact_uri = run.info.artifact_uri

    # 自托管 MLflow 常把 artifact_uri 配成本机路径；远端 client 的 log_dict
    # 写不到 tracking server。再经 artifact proxy PUT 一次，保证密度图可下载。
    uses_artifact_proxy = str(artifact_uri or "").startswith("mlflow-artifacts:")
    for artifact_path, content in pending_http_artifacts:
        uploaded = upload_artifact_via_tracking_server(
            tracking_uri=config["tracking_uri"],
            username=config["username"],
            password=config["password"],
            artifact_uri=artifact_uri,
            experiment_id=str(experiment_id),
            run_id=str(run_id),
            artifact_path=artifact_path,
            content=content,
        )
        if not uploaded and not uses_artifact_proxy:
            raise RuntimeError(
                f"MLflow artifact 未能经 tracking server 上传: {artifact_path}"
            )

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
