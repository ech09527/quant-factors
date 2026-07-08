#!/usr/bin/env python3
"""D1 验证批处理：API 拉取 pending × profile，翻译 SQL，Jupyter/Kaggle 验证，回写结果。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.jupyter_client import JupyterClient, JupyterClientConfig
from scripts.translate_idea_to_sql_openai import translate_idea as translate_idea_with_model

# Cloudflare workers.dev 会拒绝 Python-urllib 默认 UA（error 1010）
WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0"


def api_base() -> str:
    value = os.environ.get("FACTOR_API_BASE_URL", "").strip().rstrip("/")
    if not value:
        raise RuntimeError("缺少 FACTOR_API_BASE_URL")
    return value


def api_token() -> str:
    value = os.environ.get("FACTOR_API_TOKEN", "").strip()
    if not value:
        raise RuntimeError("缺少 FACTOR_API_TOKEN")
    return value


def workflow_proxy_url() -> str | None:
    for key in ("WORKFLOW_HTTP_PROXY", "HTTPS_PROXY", "HTTP_PROXY"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return None


def api_request(path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{api_base()}{path}"
    headers = {
        "Authorization": f"Bearer {api_token()}",
        "Content-Type": "application/json",
        "User-Agent": WORKFLOW_HTTP_USER_AGENT,
    }
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    handlers: list[urllib.request.BaseHandler] = []
    proxy_url = workflow_proxy_url()
    if proxy_url:
        handlers.append(
            urllib.request.ProxyHandler(
                {
                    "http": proxy_url,
                    "https": proxy_url,
                }
            )
        )
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"API 请求失败: {path} HTTP {exc.code} {detail[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"API 请求失败: {path} {exc}") from exc


@dataclass
class JobResult:
    validation_id: int
    status: str
    error: str | None = None
    profile_key: str | None = None


def fetch_pending_jobs(limit: int) -> list[dict[str, Any]]:
    payload = api_request(f"/api/workflow/validation-jobs?limit={limit}")
    items = payload.get("items")
    if not isinstance(items, list):
        raise RuntimeError("workflow jobs 响应格式错误")
    return items


def claim_jobs(ids: list[int]) -> set[int]:
    payload = api_request(
        "/api/workflow/validation-jobs/claim",
        method="POST",
        body={"ids": ids},
    )
    claimed_ids = payload.get("ids")
    if not isinstance(claimed_ids, list):
        return set()
    return {int(x) for x in claimed_ids if isinstance(x, int) or str(x).isdigit()}


def report_results(items: list[dict[str, Any]]) -> dict[str, Any]:
    return api_request(
        "/api/workflow/validation-jobs/report",
        method="POST",
        body={"items": items},
    )


def execution_backend() -> str:
    return os.environ.get("VALIDATION_EXECUTION_BACKEND", "jupyter").strip().lower()


def select_jupyter_server(
    servers: list[dict[str, Any]],
    *,
    preferred_key: str | None = None,
) -> dict[str, Any]:
    if not servers:
        raise RuntimeError("D1 中没有可用的 jupyter server 配置")
    if preferred_key:
        for item in servers:
            if str(item.get("key", "")) == preferred_key:
                return item
        raise RuntimeError(f"未找到指定 jupyter server: {preferred_key}")
    return servers[0]


def call_jupyter_evaluate_batch(
    *,
    server: dict[str, Any],
    jobs: list[dict[str, Any]],
    sample_start: str,
    timeout_seconds: int,
) -> list[dict[str, Any]]:
    config = JupyterClientConfig(
        base_url=str(server.get("base_url", "")).strip().rstrip("/"),
        auth_header=str(server.get("auth_header", "Authorization")).strip() or "Authorization",
        auth_scheme=str(server.get("auth_scheme", "token")).strip() or "token",
        auth_token=str(server.get("auth_token", "")).strip(),
        proxy_url=(str(server.get("proxy_url")).strip() if server.get("proxy_url") else None)
            or workflow_proxy_url(),
        evaluate_path=str(server.get("evaluate_path", "/api/quant-factors/evaluate-batch")).strip(),
        connect_mode=str(server.get("connect_mode", "batch_api")).strip() or "batch_api",
        ws_base_url=(str(server.get("ws_base_url")).strip() if server.get("ws_base_url") else None),
        kernel_name=str(server.get("kernel_name", "python3")).strip() or "python3",
    )
    if not config.base_url:
        raise RuntimeError("jupyter server 缺少 base_url")
    if not config.auth_token:
        raise RuntimeError(f"jupyter server {server.get('key')} 缺少 auth_token")

    client = JupyterClient(config)

    if config.connect_mode == "kernel_channels":
        return client.evaluate_batch_via_kernel_channels(
            jobs=jobs,
            sample_start=sample_start,
            timeout_seconds=timeout_seconds,
        )
    return client.evaluate_batch(
        jobs=jobs,
        sample_start=sample_start,
        timeout_seconds=timeout_seconds,
    )


def build_idea_for_translation(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": job["title"],
        "title_hash": job["title_hash"],
        "hypothesis": job["hypothesis"],
        "formula_sketch": job["formula_sketch"],
        "expected_signal": job["expected_signal"],
        "data_sources": job["data_sources"],
    }


def fetch_jupyter_servers() -> list[dict[str, Any]]:
    payload = api_request("/api/workflow/jupyter-servers")
    items = payload.get("items")
    if not isinstance(items, list):
        raise RuntimeError("jupyter servers 响应格式错误")
    return items


def mark_jupyter_server_used(key: str) -> None:
    api_request(
        "/api/workflow/jupyter-servers/mark-used",
        method="POST",
        body={"key": key},
    )


def run_batch(
    *,
    jobs: list[dict[str, Any]],
    sample_start: str,
    log_timeout: int,
    dry_run: bool,
    jupyter_server_key: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    factor_sql_cache: dict[int, dict[str, Any]] = {}
    translation_errors: dict[int, str] = {}
    runnable_jobs: list[dict[str, Any]] = []
    local_results: list[JobResult] = []

    for job in jobs:
        validation_id = int(job["validation_id"])
        idea_id = int(job["idea_id"])
        profile_key = str(job["profile_key"])

        factor_sql = factor_sql_cache.get(idea_id)
        if factor_sql is None and idea_id not in translation_errors:
            idea_payload = build_idea_for_translation(job)
            try:
                factor_sql = translate_idea_with_model(
                    idea_payload,
                    validation_profile_key=profile_key,
                    with_local_eval=False,
                    sample_start=sample_start,
                )
                factor_sql_cache[idea_id] = factor_sql
            except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
                translation_errors[idea_id] = f"翻译失败: {exc}"

        if idea_id in translation_errors:
            local_results.append(
                JobResult(
                    validation_id=validation_id,
                    status="failed",
                    error=translation_errors[idea_id],
                    profile_key=profile_key,
                )
            )
            continue

        assert factor_sql is not None
        idea_for_eval = {
            "title": job["title"],
            "title_hash": job["title_hash"],
            "formula_sketch": job["formula_sketch"],
            "data_sources": job["data_sources"],
        }
        runnable_jobs.append(
            {
                "validation_id": validation_id,
                "idea": idea_for_eval,
                "factor_sql": factor_sql,
                "validation_profile_key": profile_key,
                "label_kind": job.get("label_kind"),
                "horizon_bars": job.get("horizon_bars"),
            }
        )

    if not runnable_jobs:
        return [], {"count": len(local_results), "results": [asdict(item) for item in local_results]}

    backend = execution_backend()
    if dry_run:
        evaluations: list[dict[str, Any]] = []
    elif backend == "jupyter":
        server = select_jupyter_server(
            fetch_jupyter_servers(),
            preferred_key=jupyter_server_key,
        )
        evaluations = call_jupyter_evaluate_batch(
            server=server,
            jobs=runnable_jobs,
            sample_start=sample_start,
            timeout_seconds=log_timeout,
        )
        mark_jupyter_server_used(str(server.get("key", "")))
    elif backend == "kaggle":
        from scripts.run_factor_evaluation import BatchKernelJob, run_batch_kernel_evaluation, setup_kaggle_for_evaluation

        kernel_jobs = [
            BatchKernelJob(
                idea=item["idea"],
                factor_sql=item["factor_sql"],
                validation_profile_key=item["validation_profile_key"],
            )
            for item in runnable_jobs
        ]
        username = setup_kaggle_for_evaluation()
        with tempfile.TemporaryDirectory(prefix="d1-validation-batch-") as tmp_dir:
            kernel_results = run_batch_kernel_evaluation(
                kernel_jobs,
                sample_start=sample_start,
                output_dir=Path(tmp_dir),
                log_timeout=log_timeout,
                dry_run=False,
                force=True,
                username=username,
            )
        evaluations = []
        for item, result in zip(runnable_jobs, kernel_results):
            if result.error:
                evaluations.append(
                    {
                        "validation_id": item["validation_id"],
                        "status": "failed",
                        "factor_sql": item["factor_sql"],
                        "diagnostics": {"error": result.error},
                    }
                )
            elif result.evaluation is not None:
                payload = dict(result.evaluation)
                payload["validation_id"] = item["validation_id"]
                evaluations.append(payload)
    else:
        raise RuntimeError(f"未知执行后端: {backend}")

    report_items: list[dict[str, Any]] = []
    for item in local_results:
        report_items.append(
            {
                "validation_id": item.validation_id,
                "status": item.status,
                "error_reason": item.error,
            }
        )

    for item in runnable_jobs:
        validation_id = int(item["validation_id"])
        evaluation = next(
            (
                row
                for row in evaluations
                if int(row.get("validation_id", -1)) == validation_id
            ),
            None,
        )
        if evaluation is None:
            report_items.append(
                {
                    "validation_id": validation_id,
                    "status": "failed",
                    "factor_sql": item["factor_sql"],
                    "error_reason": "缺少 validation_id 对应的评估结果",
                }
            )
            continue

        report_items.append(
            {
                "validation_id": validation_id,
                "status": evaluation.get("status", "failed"),
                "factor_sql": evaluation.get("factor_sql") or item["factor_sql"],
                "metrics": evaluation.get("metrics"),
                "diagnostics": evaluation.get("diagnostics"),
                "error_reason": (evaluation.get("diagnostics") or {}).get("error"),
                "engine_version": evaluation.get("engine_version"),
                "metrics_version": evaluation.get("metrics_version"),
                "evaluated_at": evaluation.get("evaluated_at"),
            }
        )

    summary = {
        "count": len(report_items),
        "success": sum(1 for item in report_items if item.get("status") == "success"),
        "failed": sum(1 for item in report_items if item.get("status") == "failed"),
        "skipped": sum(1 for item in report_items if item.get("status") == "skipped"),
    }
    return report_items, summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="D1 因子验证批处理")
    parser.add_argument("--max-items", type=int, default=int(os.environ.get("MAX_VALIDATION_ITEMS", "10")))
    parser.add_argument("--sample-start", default=os.environ.get("SAMPLE_START", "2023-01-01"))
    parser.add_argument(
        "--log-timeout",
        type=int,
        default=int(os.environ.get("KERNEL_LOG_TIMEOUT_SECONDS", "7200")),
    )
    parser.add_argument(
        "--backend",
        default=os.environ.get("VALIDATION_EXECUTION_BACKEND", "jupyter"),
        help="执行后端: jupyter 或 kaggle（默认 jupyter）",
    )
    parser.add_argument(
        "--jupyter-server-key",
        default=os.environ.get("JUPYTER_SERVER_KEY", "").strip() or None,
        help="指定 D1 中的 jupyter server key；不传则按 sort_order 取第一个",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("-o", "--output", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    os.environ["VALIDATION_EXECUTION_BACKEND"] = args.backend.strip().lower()
    jobs = fetch_pending_jobs(max(1, args.max_items))
    if not jobs:
        print(json.dumps({"count": 0, "message": "no pending jobs"}, ensure_ascii=False))
        return 0

    ids = [int(item["validation_id"]) for item in jobs]
    claimed = claim_jobs(ids)
    claimed_jobs = [item for item in jobs if int(item["validation_id"]) in claimed]
    if not claimed_jobs:
        print(json.dumps({"count": 0, "message": "no claimed jobs"}, ensure_ascii=False))
        return 0

    report_items, summary = run_batch(
        jobs=claimed_jobs,
        sample_start=args.sample_start,
        log_timeout=args.log_timeout,
        dry_run=args.dry_run,
        jupyter_server_key=args.jupyter_server_key,
    )
    if report_items and not args.dry_run:
        report_results(report_items)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
