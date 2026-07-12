#!/usr/bin/env python3
"""One-off: shutdown all Jupyter kernels and reconcile D1 task bindings."""

from __future__ import annotations

import json
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

WORKER_DIR = "workers/factor-ideas"
JUPYTER_KEY = "lynas-pub"


def run_d1(sql: str) -> list[dict]:
    proc = subprocess.run(
        [
            "npx",
            "wrangler",
            "d1",
            "execute",
            "quant-factors",
            "--remote",
            "--json",
            "--command",
            sql,
        ],
        cwd=WORKER_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(proc.stdout)
    rows: list[dict] = []
    for block in payload:
        rows.extend(block.get("results") or [])
    return rows


def jupyter_request(base_url: str, token: str, path: str, method: str = "GET") -> object:
    url = f"{base_url.rstrip('/')}{path}"
    req = urllib.request.Request(
        url,
        method=method,
        headers={"Authorization": f"token {token}"},
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else None


def main() -> int:
    servers = run_d1(
        f"SELECT base_url, auth_token FROM jupyter_servers WHERE key='{JUPYTER_KEY}' LIMIT 1;"
    )
    if not servers:
        print("jupyter server not found", file=sys.stderr)
        return 1
    base_url = str(servers[0]["base_url"])
    token = str(servers[0]["auth_token"])

    kernels = jupyter_request(base_url, token, "/api/kernels")
    if not isinstance(kernels, list):
        print("unexpected kernels response", file=sys.stderr)
        return 1

    deleted = 0
    failed = 0
    for kernel in kernels:
        kernel_id = str(kernel.get("id") or "").strip()
        if not kernel_id:
            continue
        try:
            jupyter_request(base_url, token, f"/api/kernels/{kernel_id}", method="DELETE")
            deleted += 1
            print(f"shutdown {kernel_id} ({kernel.get('execution_state')})")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                print(f"already gone {kernel_id}")
                continue
            failed += 1
            print(f"failed {kernel_id}: {exc}", file=sys.stderr)

    cleaned_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    run_d1(
        "UPDATE ml_tasks "
        "SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, "
        "error_reason = CASE WHEN status = 'running' THEN COALESCE(error_reason, 'force kernel cleanup') ELSE error_reason END, "
        "completed_at = CASE WHEN status = 'running' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END, "
        f"diagnostics = json_set(COALESCE(diagnostics, '{{}}'), '$.kernel_cleaned_at', '{cleaned_at}'), "
        "updated_at = datetime('now') "
        "WHERE diagnostics IS NOT NULL "
        "AND json_extract(diagnostics, '$.kernel_id') IS NOT NULL "
        "AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL;"
    )
    run_d1(
        "UPDATE idea_validations "
        "SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, "
        "error_reason = CASE WHEN status = 'running' THEN COALESCE(error_reason, 'force kernel cleanup') ELSE error_reason END, "
        f"diagnostics = json_set(COALESCE(diagnostics, '{{}}'), '$.kernel_cleaned_at', '{cleaned_at}'), "
        "updated_at = datetime('now') "
        "WHERE diagnostics IS NOT NULL "
        "AND json_extract(diagnostics, '$.kernel_id') IS NOT NULL "
        "AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL;"
    )

    remaining = jupyter_request(base_url, token, "/api/kernels")
    remaining_count = len(remaining) if isinstance(remaining, list) else "?"
    print(
        json.dumps(
            {
                "shutdown_attempted": len(kernels),
                "shutdown_deleted": deleted,
                "shutdown_failed": failed,
                "remaining_kernels": remaining_count,
            },
            ensure_ascii=False,
        )
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
