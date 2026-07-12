#!/usr/bin/env python3
"""轮询 D1 ml_tasks 与 Jupyter kernel 状态，观察因子验证是否完成。"""

from __future__ import annotations

import json
import ssl
import subprocess
import sys
import time
import urllib.request
from collections import Counter

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
    rows: list[dict] = []
    for block in json.loads(proc.stdout):
        rows.extend(block.get("results") or [])
    return rows


def jupyter_kernels() -> list[dict]:
    servers = run_d1(
        f"SELECT base_url, auth_token FROM jupyter_servers WHERE key='{JUPYTER_KEY}' LIMIT 1;"
    )
    base_url = str(servers[0]["base_url"]).rstrip("/")
    token = str(servers[0]["auth_token"])
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        f"{base_url}/api/kernels",
        headers={"Authorization": f"token {token}"},
    )
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data if isinstance(data, list) else []


def snapshot() -> dict:
    tasks = run_d1(
        "SELECT id, status, mlflow_run_id, error_reason, "
        "json_extract(diagnostics, '$.stage') AS stage "
        "FROM ml_tasks ORDER BY id;"
    )
    status = Counter(str(row["status"]) for row in tasks)
    success = [row for row in tasks if row.get("mlflow_run_id")]
    return {
        "status": dict(status),
        "success_with_mlflow": len(success),
        "mlflow_run_ids": [row["mlflow_run_id"] for row in success[:5]],
        "kernels": Counter(str(k.get("execution_state")) for k in jupyter_kernels()),
    }


def main() -> int:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    interval = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    for i in range(rounds):
        data = snapshot()
        print(
            f"[{i + 1}/{rounds}]",
            json.dumps(data, ensure_ascii=False),
            flush=True,
        )
        if data["status"].get("success", 0) >= 3:
            print("至少 3 个 success，停止轮询", flush=True)
            return 0
        if i + 1 < rounds:
            time.sleep(interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
