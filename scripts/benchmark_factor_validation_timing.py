#!/usr/bin/env python3
"""在 Jupyter kernel 内跑一次因子验证，输出分段耗时 timing。"""

from __future__ import annotations

import json
import os
import re
import ssl
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO / "workers" / "factor-ideas"
MARKER = "__QF_FACTOR_VALIDATION_JSON__"
TIMING_MARKER = "__QF_FV_TIMING__"
JUPYTER_KEY = os.environ.get("JUPYTER_SERVER_KEY", "lynas-pub")
WORKER_API_BASE = os.environ.get(
    "FACTOR_API_BASE_URL", "https://quant-factors-factor-ideas.996died.workers.dev"
).rstrip("/")


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


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


def http_json(url: str, token: str, method: str = "GET", body: dict | None = None) -> object:
    import urllib.request

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"token {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else {}


def pick_benchmark_job() -> dict:
    rows = run_d1(
        """
        SELECT
          mt.id AS task_id,
          fv.id AS factor_validation_id,
          fv.idea_id,
          fv.profile_key,
          fv.factor_sql,
          i.title,
          i.title_hash,
          i.formula_sketch,
          i.data_sources,
          vp.label_kind,
          vp.horizon_bars
        FROM ml_tasks mt
        JOIN factor_validations fv ON fv.task_id = mt.id
        JOIN ideas i ON i.id = fv.idea_id
        JOIN validation_profiles vp ON vp.key = fv.profile_key
        WHERE mt.status = 'success'
          AND fv.factor_sql IS NOT NULL
          AND length(fv.factor_sql) > 20
        ORDER BY mt.id DESC
        LIMIT 1;
        """
    )
    if not rows:
        raise SystemExit("D1 中未找到可用于 benchmark 的 success 任务")
    row = rows[0]
    factor_sql = row.get("factor_sql")
    if isinstance(factor_sql, str):
        factor_sql = json.loads(factor_sql)
    data_sources = row.get("data_sources")
    if isinstance(data_sources, str):
        data_sources = json.loads(data_sources)
    return {
        "task_id": int(row["task_id"]),
        "factor_validation_id": int(row["factor_validation_id"]),
        "idea_id": int(row["idea_id"]),
        "profile_key": str(row["profile_key"]),
        "factor_sql": factor_sql,
        "idea": {
            "title": row.get("title") or "",
            "title_hash": row.get("title_hash") or "",
            "formula_sketch": row.get("formula_sketch") or "",
            "data_sources": data_sources or [],
        },
        "label_kind": row.get("label_kind"),
        "horizon_bars": row.get("horizon_bars"),
    }


def build_kernel_code(payload: dict, report_config: dict) -> str:
    builder_src = (WORKER_DIR / "src" / "factor-validation-kernel-builder.js").read_text(
        encoding="utf-8"
    )
    start = builder_src.index("const runner = `") + len("const runner = `")
    end = builder_src.index("`;\n  return `${engineTemplate}", start)
    runner_template = builder_src[start:end]
    marker = "__QF_FACTOR_VALIDATION_JSON__"
    payload_literal = json.dumps(json.dumps(payload))
    report_literal = json.dumps(json.dumps(report_config))
    runner = (
        runner_template.replace("${payloadLiteral}", payload_literal)
        .replace("${reportLiteral}", report_literal)
        .replace("${marker}", marker)
        .replace("${timingMarker}", TIMING_MARKER)
    )
    engine = (WORKER_DIR / "assets" / "bundled-eval-engine.py.txt").read_text(encoding="utf-8")
    return f"{engine}\n\n{runner}"


def execute_on_jupyter(code: str, *, dry_run: bool = False) -> tuple[dict, list[str]]:
    try:
        import websocket  # type: ignore
    except ImportError:
        subprocess.run(["uv", "run", "pip", "install", "websocket-client"], cwd=REPO, check=True)
        import websocket  # type: ignore

    server = run_d1(
        f"SELECT base_url, ws_base_url, auth_token, runtime_config FROM jupyter_servers WHERE key='{JUPYTER_KEY}' LIMIT 1;"
    )[0]
    base_url = str(server["base_url"]).rstrip("/")
    token = str(server["auth_token"])
    ws_base = str(server.get("ws_base_url") or base_url.replace("https://", "wss://"))
    runtime_config = server.get("runtime_config")
    if isinstance(runtime_config, str) and runtime_config.strip():
        runtime_config = json.loads(runtime_config)
    elif not isinstance(runtime_config, dict):
        runtime_config = {}

    kernel_id = http_json(f"{base_url}/api/kernels", token, "POST", {"name": "python3"})["id"]
    session_id = str(uuid.uuid4())
    msg_id = str(uuid.uuid4())
    ws_url = f"{ws_base.rstrip('/')}/api/kernels/{kernel_id}/channels?session_id={session_id}"

    outputs: list[str] = []
    started = time.time()
    ws = websocket.create_connection(
        ws_url,
        header=[f"Authorization: token {token}"],
        sslopt={"cert_reqs": ssl.CERT_NONE},
        timeout=7200,
    )
    ws.send(
        json.dumps(
            {
                "header": {
                    "msg_id": msg_id,
                    "username": "quant-factors",
                    "session": session_id,
                    "msg_type": "execute_request",
                    "version": "5.3",
                },
                "parent_header": {},
                "metadata": {},
                "content": {
                    "code": code,
                    "silent": False,
                    "store_history": False,
                    "user_expressions": {},
                    "allow_stdin": False,
                    "stop_on_error": True,
                },
                "channel": "shell",
                "buffers": [],
            }
        )
    )

    deadline = time.time() + 7200
    while time.time() < deadline:
        raw = ws.recv()
        if not raw:
            break
        msg = json.loads(raw)
        msg_type = msg.get("header", {}).get("msg_type")
        parent = msg.get("parent_header", {}).get("msg_id")
        if msg_type == "stream" and parent == msg_id:
            outputs.append(str(msg.get("content", {}).get("text", "")))
        if msg_type == "execute_result" and parent == msg_id:
            outputs.append(str(msg.get("content", {}).get("data", {}).get("text/plain", "")))
        if msg_type == "error" and parent == msg_id:
            outputs.append("ERROR " + "\n".join(msg.get("content", {}).get("traceback", [])))
        if msg_type == "status" and msg.get("content", {}).get("execution_state") == "idle":
            if parent == msg_id:
                break
    ws.close()
    wall_ms = int((time.time() - started) * 1000)

    try:
        http_json(f"{base_url}/api/kernels/{kernel_id}", token, "DELETE")
    except Exception:
        pass

    joined = "".join(outputs)
    matches = list(re.finditer(re.escape(TIMING_MARKER) + r"(\{.+?\})(?:\n|$)", joined))
    if matches:
        raw = matches[-1].group(1)
        payload = json.loads(raw)
        if "results" not in payload and "timing" in payload:
            payload = {"results": [payload]}
        payload["wall_ms"] = wall_ms
        if len(matches) > 1:
            payload["timing_snapshots"] = len(matches)
        return payload, outputs

    raise RuntimeError(f"未找到 kernel timing marker，输出片段:\n{joined[-4000:]}")


def mlflow_config_from_env() -> dict:
    return {
        "tracking_uri": os.environ.get("MLFLOW_TRACKING_URI")
        or os.environ.get("MLFLOW_TRACKING_URL")
        or "",
        "username": os.environ.get("MLFLOW_TRACKING_USERNAME")
        or os.environ.get("DAGSHUB_USER")
        or "",
        "password": os.environ.get("MLFLOW_TRACKING_PASSWORD")
        or os.environ.get("DAGSHUB_TOKEN")
        or "",
        "experiment": os.environ.get("MLFLOW_EXPERIMENT_FACTOR_VALIDATION", "factor-validation"),
    }


def main() -> int:
    load_dotenv(REPO / ".env")
    load_dotenv(WORKER_DIR / ".env")
    dry_run = "--dry-run" in sys.argv

    auth_password = os.environ.get("AUTH_PASSWORD", "").strip()
    skip_report = "--skip-report" in sys.argv or not auth_password
    if skip_report and not dry_run:
        print("未设置 AUTH_PASSWORD，将跳过 report HTTP（benchmark_skip_report）")

    mlflow_cfg = mlflow_config_from_env()
    if not dry_run and (not mlflow_cfg["tracking_uri"] or not mlflow_cfg["password"]):
        raise SystemExit("请设置 MLFLOW_TRACKING_URI 与 MLFLOW_TRACKING_PASSWORD")

    job = pick_benchmark_job()
    server_runtime = run_d1(
        f"SELECT runtime_config FROM jupyter_servers WHERE key='{JUPYTER_KEY}' LIMIT 1;"
    )[0].get("runtime_config")
    if isinstance(server_runtime, str) and server_runtime.strip():
        runtime_config = json.loads(server_runtime)
    else:
        runtime_config = {}

    payload = {
        "sample_start": os.environ.get("SAMPLE_START", "2023-01-01"),
        "jobs": [job],
        "runtime_config": runtime_config,
        "mlflow_config": mlflow_cfg,
        "mlflow_slim": True,
        "mlflow_preinstalled": True,
        "benchmark_skip_report": skip_report,
    }
    report_config = {
        "api_base_url": WORKER_API_BASE,
        "api_token": auth_password or "benchmark",
    }

    print(f"Benchmark job: task_id={job['task_id']} idea_id={job['idea_id']} profile={job['profile_key']}")
    print(f"Jupyter server: {JUPYTER_KEY}, dry_run={dry_run}")
    code = build_kernel_code(payload, report_config)
    print(f"Generated kernel code: {len(code)} bytes")

    if dry_run:
        # 仅验证代码生成
        assert MARKER in code
        assert "t_eval_ms" in code
        assert "report_phase" in code
        print("dry-run OK: kernel code contains timing + report phases")
        return 0

    result, outputs = execute_on_jupyter(code, dry_run=dry_run)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    items = result.get("results") if isinstance(result.get("results"), list) else [result]
    for item in items:
        timing = item.get("timing") or {}
        if not timing:
            continue
        print("\n=== Timing (ms) ===")
        for key in sorted(timing):
            print(f"  {key}: {timing[key]}")
        print(f"  wall_ms (kernel session): {result.get('wall_ms')}")
        if item.get("mlflow_run_id"):
            print(f"  mlflow_run_id: {item.get('mlflow_run_id')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
