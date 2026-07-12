#!/usr/bin/env python3
"""在 Jupyter kernel 内测试 Pages report 回调。"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import sys
import time
import uuid
import urllib.request

WORKER_DIR = "workers/factor-ideas"
REPORT_URL = "https://quant-factors-dashboard.pages.dev/api/workflow/ml-tasks/report"


def run_d1(sql: str) -> list[dict]:
    proc = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "quant-factors", "--remote", "--json", "--command", sql],
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
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"token {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else {}


def main() -> int:
  auth_pass = os.environ.get("AUTH_PASS", "").strip()
  if not auth_pass:
    print("需要 AUTH_PASS", file=sys.stderr)
    return 1

  try:
    import websocket  # type: ignore
  except ImportError:
    subprocess.run(["uv", "run", "pip", "install", "websocket-client"], check=True)
    import websocket  # type: ignore

  server = run_d1(
    "SELECT base_url, ws_base_url, auth_token FROM jupyter_servers WHERE key='lynas-pub' LIMIT 1;"
  )[0]
  base_url = str(server["base_url"]).rstrip("/")
  token = str(server["auth_token"])
  ws_base = str(server.get("ws_base_url") or base_url.replace("https://", "wss://"))
  kernel_id = http_json(f"{base_url}/api/kernels", token, "POST", {"name": "python3"})["id"]
  session_id = str(uuid.uuid4())
  msg_id = str(uuid.uuid4())
  ws_url = f"{ws_base.rstrip('/')}/api/kernels/{kernel_id}/channels?session_id={session_id}"

  code = f"""
import json, urllib.request
body = json.dumps({{"items": [{{"task_id": 99999, "factor_validation_id": 99999, "status": "failed", "error_reason": "jupyter pages probe"}}]}}).encode()
req = urllib.request.Request(
    "{REPORT_URL}",
    data=body,
    headers={{
        "Authorization": "Bearer {auth_pass}",
        "Content-Type": "application/json",
        "User-Agent": "quant-factors-workflow/1.0",
    }},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print("REPORT_OK", r.status, r.read()[:120])
except Exception as e:
    print("REPORT_FAIL", repr(e))
"""

  outputs: list[str] = []
  ws = websocket.create_connection(
    ws_url,
    header=[f"Authorization: token {token}"],
    sslopt={"cert_reqs": ssl.CERT_NONE},
    timeout=60,
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
  deadline = time.time() + 90
  while time.time() < deadline:
    raw = ws.recv()
    if not raw:
      break
    msg = json.loads(raw)
    msg_type = msg.get("header", {}).get("msg_type")
    parent = msg.get("parent_header", {}).get("msg_id")
    if msg_type == "stream" and parent == msg_id:
      outputs.append(str(msg.get("content", {}).get("text", "")))
    if msg_type == "status" and msg.get("content", {}).get("execution_state") == "idle" and parent == msg_id:
      break
  ws.close()
  try:
    http_json(f"{base_url}/api/kernels/{kernel_id}", token, "DELETE")
  except Exception:
    pass
  print("".join(outputs).strip())
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
