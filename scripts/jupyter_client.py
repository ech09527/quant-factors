"""Jupyter Server/Kernel 网络客户端（支持 HTTP 代理 + Kernel WS 连接）。"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any

from scripts.bundle_evaluate_kernel import build_jupyter_inline_eval_code


@dataclass
class JupyterClientConfig:
    base_url: str
    auth_header: str = "Authorization"
    auth_scheme: str = "token"
    auth_token: str = ""
    proxy_url: str | None = None
    evaluate_path: str = "/api/quant-factors/evaluate-batch"
    connect_mode: str = "batch_api"
    ws_base_url: str | None = None
    kernel_name: str = "python3"


class JupyterClient:
    def __init__(self, config: JupyterClientConfig) -> None:
        self.config = config
        handlers: list[urllib.request.BaseHandler] = []
        if config.proxy_url:
            handlers.append(
                urllib.request.ProxyHandler(
                    {
                        "http": config.proxy_url,
                        "https": config.proxy_url,
                    }
                )
            )
        self.opener = urllib.request.build_opener(*handlers)

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            self.config.auth_header: f"{self.config.auth_scheme} {self.config.auth_token}",
        }

    def request_json(
        self,
        path: str,
        *,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        timeout_seconds: int = 120,
    ) -> dict[str, Any]:
        normalized = path if path.startswith("/") else f"/{path}"
        url = f"{self.config.base_url.rstrip('/')}{normalized}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(),
            method=method,
        )
        try:
            with self.opener.open(req, timeout=timeout_seconds) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Jupyter HTTP {exc.code}: {detail[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Jupyter 请求失败: {exc}") from exc

    def evaluate_batch(
        self,
        *,
        jobs: list[dict[str, Any]],
        sample_start: str,
        timeout_seconds: int = 7200,
    ) -> list[dict[str, Any]]:
        path = self.config.evaluate_path or "/api/quant-factors/evaluate-batch"
        payload = self.request_json(
            path,
            method="POST",
            body={"sample_start": sample_start, "jobs": jobs},
            timeout_seconds=timeout_seconds,
        )
        evaluations = payload.get("evaluations")
        if not isinstance(evaluations, list):
            raise RuntimeError("Jupyter evaluate-batch 响应缺少 evaluations")
        return evaluations

    @staticmethod
    def _extract_marker_json(output: str, marker: str) -> dict[str, Any]:
        for line in reversed(output.splitlines()):
            if line.startswith(marker):
                return json.loads(line[len(marker) :])
        raise RuntimeError(f"kernel 输出缺少标记行: {marker}")

    def evaluate_batch_via_kernel_channels(
        self,
        *,
        jobs: list[dict[str, Any]],
        sample_start: str,
        target_file: str = "futures/um/klines/1h.parquet",
        timeout_seconds: int = 7200,
    ) -> list[dict[str, Any]]:
        marker = "__QF_EVAL_JSON__"
        payload = {
            "sample_start": sample_start,
            "target_file": target_file,
            "jobs": jobs,
        }
        code = build_jupyter_inline_eval_code(payload, marker=marker)
        result = self.execute_code_via_kernel_ws(code=code, timeout_seconds=timeout_seconds)
        payload = self._extract_marker_json(result.get("output", ""), marker)
        evaluations = payload.get("evaluations")
        if not isinstance(evaluations, list):
            raise RuntimeError("kernel 执行结果缺少 evaluations")
        return evaluations

    def create_kernel(self, *, kernel_name: str | None = None) -> str:
        payload = self.request_json(
            "/api/kernels",
            method="POST",
            body={"name": kernel_name or self.config.kernel_name},
        )
        kernel_id = payload.get("id")
        if not isinstance(kernel_id, str) or not kernel_id:
            raise RuntimeError("创建 kernel 失败：缺少 id")
        return kernel_id

    def shutdown_kernel(self, kernel_id: str) -> None:
        self.request_json(f"/api/kernels/{kernel_id}", method="DELETE")

    def kernel_channels_url(self, kernel_id: str, *, session_id: str | None = None) -> str:
        base = (self.config.ws_base_url or "").strip()
        if not base:
            parsed = urllib.parse.urlparse(self.config.base_url)
            scheme = "wss" if parsed.scheme == "https" else "ws"
            base = f"{scheme}://{parsed.netloc}"
        sid = session_id or str(uuid.uuid4())
        return f"{base.rstrip('/')}/api/kernels/{kernel_id}/channels?session_id={sid}"

    def execute_code_via_kernel_ws(
        self,
        *,
        code: str,
        kernel_id: str | None = None,
        timeout_seconds: int = 120,
    ) -> dict[str, Any]:
        try:
            import websocket  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("缺少 websocket-client 依赖，无法通过 WS 执行 kernel 代码") from exc

        own_kernel = False
        resolved_kernel = kernel_id
        if not resolved_kernel:
            resolved_kernel = self.create_kernel()
            own_kernel = True

        session_id = str(uuid.uuid4())
        msg_id = str(uuid.uuid4())
        ws_url = self.kernel_channels_url(resolved_kernel, session_id=session_id)

        proxy_host = None
        proxy_port = None
        if self.config.proxy_url:
            parsed_proxy = urllib.parse.urlparse(self.config.proxy_url)
            proxy_host = parsed_proxy.hostname
            proxy_port = parsed_proxy.port

        headers = [f"{self.config.auth_header}: {self.config.auth_scheme} {self.config.auth_token}"]
        ws = websocket.create_connection(
            ws_url,
            header=headers,
            timeout=timeout_seconds,
            http_proxy_host=proxy_host,
            http_proxy_port=proxy_port,
        )
        try:
            message = {
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
            }
            ws.send(json.dumps(message))

            output_parts: list[str] = []
            execute_reply: dict[str, Any] | None = None
            while True:
                raw = ws.recv()
                payload = json.loads(raw)
                msg_type = payload.get("msg_type")
                channel = payload.get("channel")
                parent = payload.get("parent_header", {})
                if parent.get("msg_id") != msg_id:
                    continue

                if channel == "iopub":
                    content = payload.get("content", {})
                    if msg_type == "stream":
                        text = content.get("text")
                        if isinstance(text, str):
                            output_parts.append(text)
                    elif msg_type == "error":
                        traceback = content.get("traceback") or []
                        raise RuntimeError("\n".join(traceback) if traceback else str(content))
                    elif msg_type == "status" and content.get("execution_state") == "idle":
                        break
                elif channel == "shell" and msg_type == "execute_reply":
                    execute_reply = payload.get("content", {})

            return {
                "kernel_id": resolved_kernel,
                "status": (execute_reply or {}).get("status", "ok"),
                "output": "".join(output_parts),
            }
        finally:
            ws.close()
            if own_kernel:
                try:
                    self.shutdown_kernel(resolved_kernel)
                except Exception:
                    pass
