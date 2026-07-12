#!/usr/bin/env python3
"""在 Jupyter 服务器上配置 pip 国内镜像并安装 duckdb / mlflow。"""

from __future__ import annotations

import json
import ssl
import subprocess
import sys
import uuid
import urllib.request
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent / "workers" / "factor-ideas"
JUPYTER_KEY = "lynas-pub"
PIP_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
PACKAGES = ["duckdb>=1.0.0", "mlflow>=2.14.0"]


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


def jupyter_exec(code: str, timeout_sec: int = 900) -> tuple[str, list[str]]:
    try:
        import websocket  # type: ignore
    except ImportError:
        subprocess.run(["uv", "run", "pip", "install", "websocket-client"], check=True)
        import websocket  # type: ignore

    server = run_d1(
        f"SELECT base_url, ws_base_url, auth_token FROM jupyter_servers WHERE key='{JUPYTER_KEY}' LIMIT 1;"
    )[0]
    base_url = str(server["base_url"]).rstrip("/")
    token = str(server["auth_token"])
    ws_base = str(server.get("ws_base_url") or base_url.replace("https://", "wss://")).rstrip("/")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    create_req = urllib.request.Request(
        f"{base_url}/api/kernels",
        data=json.dumps({"name": "python3"}).encode(),
        method="POST",
        headers={"Authorization": f"token {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(create_req, timeout=60, context=ctx) as resp:
        kernel_id = json.loads(resp.read().decode())["id"]

    session_id = str(uuid.uuid4())
    msg_id = str(uuid.uuid4())
    ws_url = f"{ws_base}/api/kernels/{kernel_id}/channels?session_id={session_id}"
    ws = websocket.create_connection(
        ws_url,
        header=[f"Authorization: token {token}"],
        sslopt={"cert_reqs": ssl.CERT_NONE},
        timeout=timeout_sec,
    )
    ws.send(
        json.dumps(
            {
                "header": {
                    "msg_id": msg_id,
                    "msg_type": "execute_request",
                    "username": "",
                    "session": session_id,
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
            }
        )
    )

    stdout: list[str] = []
    errors: list[str] = []
    for _ in range(timeout_sec * 2):
        msg = json.loads(ws.recv())
        if msg.get("msg_type") == "stream":
            stdout.append(str(msg["content"].get("text", "")))
        if msg.get("msg_type") == "error":
            errors.append(str(msg["content"].get("evalue", "")))
        if (
            msg.get("parent_header", {}).get("msg_id") == msg_id
            and msg.get("msg_type") == "status"
            and msg["content"].get("execution_state") == "idle"
        ):
            break
    ws.close()

    delete_req = urllib.request.Request(
        f"{base_url}/api/kernels/{kernel_id}",
        method="DELETE",
        headers={"Authorization": f"token {token}"},
    )
    with urllib.request.urlopen(delete_req, timeout=30, context=ctx):
        pass

    return "".join(stdout), errors


def main() -> int:
    mirror_literal = json.dumps(PIP_MIRROR)
    trusted_literal = json.dumps(PIP_TRUSTED_HOST)
    packages_literal = json.dumps(PACKAGES)

    setup_code = f"""
import os
import sys
import subprocess
import time
from pathlib import Path

mirror = {mirror_literal}
trusted = {trusted_literal}
packages = {packages_literal}
conf_text = (
    "[global]\\n"
    f"index-url = {{mirror}}\\n"
    f"trusted-host = {{trusted}}\\n"
    "timeout = 120\\n"
    "[install]\\n"
    "trusted-host = " + trusted + "\\n"
)

written = []
for path in [
    Path.home() / ".pip" / "pip.conf",
    Path("/opt/conda/pip.conf"),
    Path("/etc/pip.conf"),
]:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(conf_text, encoding="utf-8")
        written.append(str(path))
    except Exception as exc:
        print("pip_conf_skip", path, repr(exc), flush=True)

print("pip_conf_written", written, flush=True)
print("python", sys.executable, flush=True)

for pkg in packages:
    t0 = time.perf_counter()
    print("installing", pkg, flush=True)
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-U", pkg],
        timeout=900,
    )
    print("installed", pkg, "ms", int((time.perf_counter() - t0) * 1000), flush=True)

for mod in ["duckdb", "mlflow"]:
    imported = __import__(mod)
    print(mod, "version", getattr(imported, "__version__", "ok"), flush=True)
"""

    print("Configuring pip mirror and installing packages on Jupyter...", flush=True)
    stdout, errors = jupyter_exec(setup_code, timeout_sec=900)
    print(stdout)
    if errors:
        print("ERRORS:", *errors, sep="\n", file=sys.stderr)
        return 1
    if "version" not in stdout:
        print("Install may have failed; missing version lines", file=sys.stderr)
        return 1
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
