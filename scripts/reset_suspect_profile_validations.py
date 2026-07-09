#!/usr/bin/env python3
"""将疑似 profile 错配的 success 验证记录重置为 failed，便于 workflow 重跑。"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

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


def api_request(path: str) -> dict[str, Any]:
    url = f"{api_base()}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_token()}",
            "User-Agent": WORKFLOW_HTTP_USER_AGENT,
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_success_validations(*, limit: int = 5000) -> list[dict[str, Any]]:
    payload = api_request(f"/api/validations?status=success&limit={limit}")
    items = payload.get("items")
    if not isinstance(items, list):
        raise RuntimeError("validations 响应格式错误")
    return items


def metric_ic_ir(metrics: dict[str, Any] | None) -> str | None:
    if not isinstance(metrics, dict):
        return None
    value = metrics.get("ic_ir")
    if value is None:
        return None
    return str(value)


def find_suspect_validation_ids(items: list[dict[str, Any]]) -> list[int]:
    suspect: set[int] = set()

    by_idea: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in items:
        by_idea[int(row["idea_id"])].append(row)

    for idea_id, rows in by_idea.items():
        if len(rows) < 2:
            continue
        by_ic: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            ic_key = metric_ic_ir(row.get("metrics"))
            if ic_key is None:
                continue
            by_ic[ic_key].append(row)
        for group in by_ic.values():
            profiles = {str(row["profile_key"]) for row in group}
            if len(group) >= 2 and len(profiles) >= 2:
                for row in group:
                    suspect.add(int(row["id"]))

    for row in items:
        metrics = row.get("metrics") or {}
        profile_key = str(row.get("profile_key") or "")
        metric_profile = str(metrics.get("validation_profile_key") or "")
        if profile_key and metric_profile and profile_key != metric_profile:
            suspect.add(int(row["id"]))
        if profile_key and not metric_profile:
            suspect.add(int(row["id"]))

    return sorted(suspect)


def reset_via_wrangler(ids: list[int], *, dry_run: bool) -> None:
    if not ids:
        print(json.dumps({"reset": 0, "message": "no suspect validations"}, ensure_ascii=False))
        return

    placeholders = ", ".join(str(item) for item in ids)
    sql = (
        "UPDATE idea_validations "
        "SET status = 'failed', "
        "error_reason = 'profile 疑似错配，等待重跑', "
        "updated_at = datetime('now') "
        f"WHERE id IN ({placeholders});"
    )
    if dry_run:
        print(json.dumps({"dry_run": True, "count": len(ids), "ids": ids, "sql": sql}, ensure_ascii=False))
        return

    worker_dir = REPO_ROOT / "workers" / "factor-ideas"
    cmd = [
        "npx",
        "wrangler",
        "d1",
        "execute",
        "quant-factors",
        "--remote",
        "--command",
        sql,
    ]
    subprocess.run(cmd, cwd=worker_dir, check=True)
    print(json.dumps({"reset": len(ids), "ids": ids}, ensure_ascii=False))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="重置疑似 profile 错配的验证记录")
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    items = fetch_success_validations(limit=max(1, args.limit))
    suspect_ids = find_suspect_validation_ids(items)
    reset_via_wrangler(suspect_ids, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
