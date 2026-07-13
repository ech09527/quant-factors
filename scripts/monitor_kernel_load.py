#!/usr/bin/env python3
"""采样 Coordinator / D1 / Jupyter kernel，观察并发是否接近 max_slots。"""

from __future__ import annotations

import json
import ssl
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO / "workers" / "factor-ideas"
WORKER_BASE = "https://quant-factors-factor-ideas.996died.workers.dev"
AUTH = "123qwe"
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


def worker_json(path: str) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        f"{WORKER_BASE}{path}",
        headers={"Authorization": f"Bearer {AUTH}"},
    )
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        return json.loads(resp.read().decode("utf-8"))


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
    coord = worker_json("/api/jupyter-coordinator/status?key=lynas-pub")
    exec_rows = run_d1(
        "SELECT status, COUNT(*) AS n FROM jupyter_executions "
        "WHERE server_key='lynas-pub' AND status IN ('queued','submitting','running') "
        "GROUP BY status;"
    )
    pending = run_d1(
        "SELECT COUNT(*) AS n FROM ml_tasks "
        "WHERE business_type='factor_validation' AND status='pending';"
    )[0]["n"]
    recent = run_d1(
        "SELECT COUNT(*) AS n FROM jupyter_executions "
        "WHERE business_type='factor_validation' AND status='succeeded' "
        "AND completed_at > datetime('now','-1 minute');"
    )[0]["n"]
    kernels = jupyter_kernels()
    states: dict[str, int] = {}
    for kernel in kernels:
        state = str(kernel.get("execution_state") or "unknown")
        states[state] = states.get(state, 0) + 1
    return {
        "max_slots": coord.get("max_slots"),
        "running_count": coord.get("running_count"),
        "queue_length": coord.get("queue_length"),
        "exec_rows": exec_rows,
        "pending_factor": pending,
        "succeeded_last_minute": recent,
        "jupyter_kernel_count": len(kernels),
        "jupyter_states": states,
    }


def main() -> int:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    interval = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    peaks = {"running_count": 0, "jupyter_kernel_count": 0, "busy_kernels": 0}
    for i in range(rounds):
        try:
            data = snapshot()
        except Exception as error:  # noqa: BLE001
            print(f"[{i + 1}/{rounds}] ERROR {error}", flush=True)
            time.sleep(interval)
            continue
        running = int(data.get("running_count") or 0)
        jk = int(data.get("jupyter_kernel_count") or 0)
        busy = int(data.get("jupyter_states", {}).get("busy", 0))
        peaks["running_count"] = max(peaks["running_count"], running)
        peaks["jupyter_kernel_count"] = max(peaks["jupyter_kernel_count"], jk)
        peaks["busy_kernels"] = max(peaks["busy_kernels"], busy)
        print(f"[{i + 1}/{rounds}] {json.dumps(data, ensure_ascii=False)}", flush=True)
        time.sleep(interval)
    print(f"PEAKS {json.dumps(peaks, ensure_ascii=False)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
