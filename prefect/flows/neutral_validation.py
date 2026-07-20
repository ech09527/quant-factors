"""中性化二次验证 Prefect flow：claim（含 LLM）→ 评估 → 回写 D1。

与 factor-validation 共用 runner/evaluate 代码，但使用独立 flow / deployment，
避免一次验证与二次验证在 Prefect UI 中混淆。
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from prefect import flow, task
from prefect.runtime import flow_run as runtime_flow_run

from tasks.evaluate import (
    assemble_run_result_task,
    build_report_items,
    ensure_mlflow_runtime_task,
    evaluate_factor_sql_task,
    log_mlflow_task,
    resolve_data_path_task,
)
from tasks.report_to_worker import report_to_worker

WORKFLOW_UA = "quant-factors-prefect-neutral-validation/1.0"
DEFAULT_DEPLOYMENT = "neutral_validation/production"


def _callback_base_url(explicit: str | None = None) -> str:
    base = (
        (explicit or "").strip()
        or os.getenv("FACTOR_API_BASE_URL", "").strip()
        or os.getenv("VALIDATION_API_BASE_URL", "").strip()
    )
    if not base:
        raise ValueError("缺少 FACTOR_API_BASE_URL（Worker 回调地址）")
    return base.rstrip("/")


def _auth_token() -> str:
    token = (
        os.getenv("AUTH_PASSWORD", "").strip()
        or os.getenv("FACTOR_API_TOKEN", "").strip()
    )
    if not token:
        raise ValueError("缺少 AUTH_PASSWORD / FACTOR_API_TOKEN")
    return token


def _worker_request(
    path: str,
    *,
    method: str = "POST",
    body: dict[str, Any] | None = None,
    callback_base_url: str | None = None,
) -> dict[str, Any]:
    base = _callback_base_url(callback_base_url)
    url = base + path
    token = _auth_token()
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": WORKFLOW_UA,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {"ok": True}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Worker {path} HTTP {exc.code}: {detail}") from exc


def _merge_timing(*parts: dict[str, int] | None) -> dict[str, int]:
    timing: dict[str, int] = {}
    for part in parts:
        if isinstance(part, dict):
            timing.update(part)
    return timing


def _report_phase_name(phase: str | None, task_id: int) -> str:
    text = str(phase or "unknown").strip() or "unknown"
    return f"report-{text}-task-{task_id}"


def _current_flow_run_id() -> str:
    try:
        rid = getattr(runtime_flow_run, "id", None)
        if rid:
            return str(rid)
    except Exception:  # noqa: BLE001 — runtime 在本地直调时可能不可用
        pass
    return ""


@task(name="claim-neutral-validation", retries=1, retry_delay_seconds=5, log_prints=True)
def claim_neutral_validation(
    *,
    limit: int | None = None,
    ignore_schedule_enabled: bool = False,
    callback_base_url: str | None = None,
) -> dict[str, Any]:
    """拉取优秀因子 + Worker 侧 LLM 选型 + reserve。"""
    body: dict[str, Any] = {"ignore_schedule_enabled": ignore_schedule_enabled}
    if limit is not None:
        body["limit"] = int(limit)
    return _worker_request(
        "/api/workflow/factor-neutral-validations/claim-batch",
        body=body,
        callback_base_url=callback_base_url,
    )


@task(name="attach-neutral-flow-run", retries=2, retry_delay_seconds=3, log_prints=True)
def attach_neutral_flow_run(
    *,
    task_id: int,
    flow_run_id: str,
    deployment_name: str = DEFAULT_DEPLOYMENT,
    callback_base_url: str | None = None,
) -> dict[str, Any]:
    return _worker_request(
        "/api/workflow/factor-neutral-validations/attach-flow-run",
        body={
            "task_id": int(task_id),
            "flow_run_id": str(flow_run_id),
            "deployment_name": deployment_name,
        },
        callback_base_url=callback_base_url,
    )


def _run_one_neutral_item(
    *,
    flow_parameters: dict[str, Any],
    callback_base_url: str | None = None,
) -> dict[str, Any]:
    """在 flow 内按 task 阶段执行单条中性化验证（复用 evaluate/report task）。"""
    job = flow_parameters.get("job") or {}
    if not isinstance(job, dict):
        raise ValueError("flow_parameters.job 必须是对象")

    business_type = str(
        flow_parameters.get("business_type") or "factor_neutral_validation"
    )
    task_id = int(flow_parameters.get("task_id") or job.get("task_id") or 0)
    validation_id = int(
        flow_parameters.get("validation_id") or job.get("factor_validation_id") or 0
    )
    sample_start = str(flow_parameters.get("sample_start") or "2023-01-01")
    runtime_config = flow_parameters.get("runtime_config") or {}
    if not isinstance(runtime_config, dict):
        runtime_config = {}
    mlflow_config = flow_parameters.get("mlflow_config")
    skip_mlflow = bool(flow_parameters.get("skip_mlflow"))
    report_base = (
        str(flow_parameters.get("callback_base_url") or "").strip() or callback_base_url
    )
    mlflow_preinstalled = bool(runtime_config.get("mlflow_preinstalled", True))
    flow_started = time.perf_counter()
    suffix = f"task-{task_id}"

    import_timing = ensure_mlflow_runtime_task.with_options(
        name=f"ensure-mlflow-runtime-{suffix}"
    )(mlflow_preinstalled=mlflow_preinstalled)

    resolve_result = resolve_data_path_task.with_options(
        name=f"resolve-data-path-{suffix}"
    )(job, runtime_config=runtime_config)
    data_path = str(resolve_result["data_path"])

    eval_result = evaluate_factor_sql_task.with_options(
        name=f"evaluate-factor-sql-{suffix}"
    )(job, data_path=data_path, sample_start=sample_start)
    evaluation = eval_result["evaluation"]

    mlflow_meta = None
    mlflow_error = None
    mlflow_timing: dict[str, int] = {}
    mlflow_attempted = False
    if not skip_mlflow and eval_result["status"] == "success":
        mlflow_attempted = True
        mlflow_result = log_mlflow_task.with_options(name=f"log-mlflow-{suffix}")(
            job,
            evaluation,
            runtime_config=runtime_config,
            mlflow_config=mlflow_config if isinstance(mlflow_config, dict) else None,
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

    run_result = assemble_run_result_task.with_options(
        name=f"assemble-run-result-{suffix}"
    )(
        job,
        evaluation=evaluation,
        mlflow_meta=mlflow_meta,
        data_path=data_path,
        timing=timing,
        error_reason=mlflow_error or evaluation.get("error_reason"),
        total_ms=total_ms,
        mlflow_attempted=mlflow_attempted,
    )

    items = build_report_items.with_options(name=f"build-report-items-{suffix}")(
        business_type, job, run_result
    )
    report_responses: list[dict[str, Any]] = []
    for item in items:
        phase = (item.get("diagnostics") or {}).get("report_phase")
        reporter = report_to_worker.with_options(name=_report_phase_name(phase, task_id))
        response = reporter(
            business_type,
            [item],
            callback_base_url=report_base,
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


@flow(name="neutral_validation", log_prints=True)
def run_neutral_validation(
    limit: int | None = None,
    ignore_schedule_enabled: bool = False,
    callback_base_url: str | None = None,
) -> dict[str, Any]:
    """
    独立中性化二次验证入口：
    1) claim（筛优 + LLM exposures + reserve）
    2) attach 当前 flow_run_id
    3) 本 flow 内 task 评估并 report（不复用 factor-validation deployment）
    """
    deployment = (
        os.getenv("PREFECT_DEPLOYMENT_NEUTRAL_VALIDATION", "").strip()
        or DEFAULT_DEPLOYMENT
    )
    parent_flow_run_id = _current_flow_run_id()

    claim = claim_neutral_validation(
        limit=limit,
        ignore_schedule_enabled=ignore_schedule_enabled,
        callback_base_url=callback_base_url,
    )
    if claim.get("skipped"):
        print(f"claim skipped: {claim.get('reason')}")
        return claim

    items = claim.get("items") or []
    completed = 0
    attach_failed = 0
    errors: list[dict[str, Any]] = list(claim.get("errors") or [])
    results: list[dict[str, Any]] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        task_id = int(item.get("task_id") or 0)
        flow_parameters = item.get("flow_parameters")
        if task_id <= 0 or not isinstance(flow_parameters, dict):
            continue
        try:
            flow_run_id = parent_flow_run_id or f"neutral_validation:task:{task_id}"
            attached = attach_neutral_flow_run.with_options(
                name=f"attach-neutral-flow-run-task-{task_id}"
            )(
                task_id=task_id,
                flow_run_id=flow_run_id,
                deployment_name=str(item.get("deployment") or deployment),
                callback_base_url=callback_base_url,
            )
            if int(attached.get("updated") or 0) <= 0:
                attach_failed += 1
                errors.append(
                    {
                        "task_id": task_id,
                        "error": f"attach failed: {attached.get('reason')}",
                    }
                )
                continue

            one = _run_one_neutral_item(
                flow_parameters=flow_parameters,
                callback_base_url=callback_base_url,
            )
            results.append(one)
            completed += 1
        except Exception as exc:  # noqa: BLE001 — 批内单条失败继续
            errors.append({"task_id": task_id, "error": str(exc)})

    result = {
        **claim,
        "completed": completed,
        "attach_failed": attach_failed,
        "deployment": deployment,
        "flow_run_id": parent_flow_run_id,
        "errors": errors,
        "results": results,
        "mode": "neutral_validation_flow",
    }
    print(
        json.dumps(
            {
                "claimed": claim.get("claimed"),
                "completed": completed,
                "attach_failed": attach_failed,
                "errors": len(errors),
            },
            ensure_ascii=False,
        )
    )
    return result
