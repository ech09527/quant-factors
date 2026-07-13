"""将验证结果 POST 回 Cloudflare Worker。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from prefect import task

WORKFLOW_UA = "quant-factors-prefect/1.0"


def _report_path(business_type: str) -> str:
    if business_type == "test_factor_validation":
        return "/api/workflow/test-ml-tasks/report"
    return "/api/workflow/ml-tasks/report"


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


@task(name="report-to-worker", retries=2, retry_delay_seconds=5, log_prints=True)
def report_to_worker(
    business_type: str,
    items: list[dict[str, Any]],
    *,
    callback_base_url: str | None = None,
) -> dict[str, Any]:
    """按阶段将 items POST 到 Worker report API。"""
    if not items:
        return {"updated": 0, "skipped": True}

    base = _callback_base_url(callback_base_url)
    url = base + _report_path(business_type)
    token = _auth_token()
    body = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": WORKFLOW_UA,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {"ok": True}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Worker report HTTP {exc.code}: {detail}") from exc


@task(name="report-phases-to-worker", retries=1, log_prints=True)
def report_phases_to_worker(
    business_type: str,
    report_items: list[dict[str, Any]],
    *,
    callback_base_url: str | None = None,
) -> list[dict[str, Any]]:
    """逐阶段上报（eval 与 mlflow 分开 POST，与 Coordinator 语义一致）。"""
    responses: list[dict[str, Any]] = []
    for item in report_items:
        phase = (item.get("diagnostics") or {}).get("report_phase")
        resp = report_to_worker(
            business_type,
            [item],
            callback_base_url=callback_base_url,
        )
        responses.append({"phase": phase, "response": resp})
    return responses
