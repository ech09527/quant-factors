import {
  readJupyterExecutionHeartbeatIntervalSeconds,
  readReportConfig
} from "./jupyter-execution-config.js";

function pythonJsonLoadsLiteral(value) {
  return JSON.stringify(JSON.stringify(value));
}

function indentPythonLines(code, spaces = 4) {
  const pad = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : pad + line))
    .join("\n");
}

/** Jupyter kernel 内嵌：执行期间 HTTP 心跳 + 完成后回调 Worker */
export function buildJupyterExecutionCallbackPreamble(callbackConfig) {
  const cfgLiteral = pythonJsonLoadsLiteral(callbackConfig);
  const intervalSec = Number(callbackConfig?.heartbeat_interval_sec ?? 15);
  return `
import json as _json
import threading as _threading
import traceback as _traceback
import urllib.request as _urllib_request

_EXEC_CALLBACK = _json.loads(${cfgLiteral})
_WORKFLOW_UA = "quant-factors-workflow/1.0"
_HEARTBEAT_STOP = _threading.Event()
_HEARTBEAT_THREAD = None


def _post_worker_json(url, payload, timeout=30):
    body = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
    token = str(_EXEC_CALLBACK.get("callback_token") or "")
    req = _urllib_request.Request(
        url,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": _WORKFLOW_UA,
        },
        method="POST",
    )
    with _urllib_request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return _json.loads(raw) if raw else {"ok": True}


def _notify_worker_execution_heartbeat(phase=None):
    url = str(_EXEC_CALLBACK.get("heartbeat_url") or "").rstrip("/")
    if not url:
        return {"ok": False, "skipped": True}
    payload = {
        "execution_id": _EXEC_CALLBACK.get("execution_id"),
        "phase": phase,
    }
    return _post_worker_json(url, payload, timeout=15)


def _heartbeat_loop(interval_sec):
    while not _HEARTBEAT_STOP.wait(interval_sec):
        try:
            _notify_worker_execution_heartbeat("alive")
        except Exception:
            pass


def _start_execution_heartbeat(interval_sec=${intervalSec}):
    global _HEARTBEAT_THREAD
    _HEARTBEAT_STOP.clear()
    try:
        _notify_worker_execution_heartbeat("started")
    except Exception:
        pass
    _HEARTBEAT_THREAD = _threading.Thread(
        target=_heartbeat_loop,
        args=(max(5, int(interval_sec or ${intervalSec})),),
        daemon=True,
    )
    _HEARTBEAT_THREAD.start()


def _stop_execution_heartbeat():
    _HEARTBEAT_STOP.set()


def _notify_worker_execution_done(results_payload=None, error=None):
    payload = {
        "execution_id": _EXEC_CALLBACK.get("execution_id"),
        "results": results_payload if isinstance(results_payload, dict) else {},
        "error": error,
    }
    url = str(_EXEC_CALLBACK.get("callback_url") or "").rstrip("/")
    return _post_worker_json(url, payload, timeout=180)
`.trimStart();
}

export function wrapJupyterExecutionCodeWithHttpCallback(innerCode, callbackConfig) {
  const preamble = buildJupyterExecutionCallbackPreamble(callbackConfig);
  const body = String(innerCode ?? "").trim();
  return `${preamble}

_start_execution_heartbeat()
try:
${indentPythonLines(body)}
    try:
        _notify_worker_execution_done({"results": _results})
    except NameError:
        _notify_worker_execution_done({"results": []}, error="kernel finished without _results")
except Exception as _exec_top_exc:
    try:
        _payload = {"results": _results} if "_results" in globals() else {"results": []}
    except Exception:
        _payload = {"results": []}
    try:
        _notify_worker_execution_done(
            _payload,
            error=str(_exec_top_exc) + "\\n" + _traceback.format_exc(limit=5),
        )
    except Exception as _callback_exc:
        print("__QF_EXEC_CALLBACK_FAILED__" + str(_callback_exc), flush=True)
    raise
finally:
    _stop_execution_heartbeat()
`;
}

export function buildJupyterExecutionCallbackConfig(env, execution, runtimeConfig) {
  const reportConfig = readReportConfig(env, runtimeConfig);
  const apiBase = reportConfig.api_base_url.replace(/\/$/, "");
  return {
    execution_id: String(execution.id),
    callback_url: `${apiBase}/api/jupyter-executions/callback`,
    heartbeat_url: `${apiBase}/api/jupyter-executions/heartbeat`,
    callback_token: reportConfig.api_token,
    heartbeat_interval_sec: readJupyterExecutionHeartbeatIntervalSeconds(env)
  };
}
