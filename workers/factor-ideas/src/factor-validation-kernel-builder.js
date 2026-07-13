import engineTemplate from "../assets/bundled-eval-engine.py.txt";

function pythonJsonLoadsLiteral(value) {
  return JSON.stringify(JSON.stringify(value));
}

function stripPythonFutureImports(code) {
  return code
    .split("\n")
    .filter((line) => !/^\s*from __future__ import/.test(line))
    .join("\n");
}

export function buildFactorValidationEvalCode(payload) {
  const marker = "__QF_FACTOR_VALIDATION_JSON__";
  const timingMarker = "__QF_FV_TIMING__";
  const payloadLiteral = pythonJsonLoadsLiteral(payload);
  const runner = `
import json
import os
import time
import traceback
import warnings
import contextlib
import io

warnings.filterwarnings("ignore", category=RuntimeWarning)

_TIMING_MARKER = "${timingMarker}"
_payload = json.loads(${payloadLiteral})
_sample_start = _payload.get("sample_start", "2023-01-01")
_runtime_config = _payload.get("runtime_config") or {}
if not isinstance(_runtime_config, dict):
    _runtime_config = {}
_mlflow_config = _payload.get("mlflow_config") or {}
if not isinstance(_mlflow_config, dict):
    _mlflow_config = {}
_mlflow_slim = _payload.get("mlflow_slim", True)
_mlflow_preinstalled = bool(
    _payload.get("mlflow_preinstalled", _runtime_config.get("mlflow_preinstalled", True))
)
_target_file = _runtime_config.get("target_file") or _payload.get("target_file", "futures/um/klines/1h.parquet")
_data_path_override = _runtime_config.get("data_path")
_jobs = _payload.get("jobs", [])
_results = []


def _elapsed_ms(started_at):
    return int((time.perf_counter() - started_at) * 1000)


def _ensure_mlflow():
    try:
        import mlflow  # noqa: F401
        return
    except ImportError:
        if _mlflow_preinstalled:
            raise RuntimeError(
                "mlflow 未安装：请在 Jupyter 镜像中预装 mlflow>=2.14.0，"
                "或将 runtime_config.mlflow_preinstalled 设为 false 以允许 pip 安装"
            )
        import subprocess
        import sys
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "mlflow>=2.14.0"],
            timeout=300,
        )


def _emit_timing_snapshot(status, mlflow_meta=None):
    print(
        _TIMING_MARKER
        + json.dumps(
            {
                "task_id": _task_id,
                "factor_validation_id": _factor_validation_id,
                "status": status,
                "timing": dict(_timing),
                "mlflow_run_id": (mlflow_meta or {}).get("mlflow_run_id"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


for _job in _jobs:
    _task_id = _job.get("task_id")
    _factor_validation_id = _job.get("factor_validation_id")
    _idea_id = int(_job.get("idea_id") or 0)
    _idea = _job.get("idea") or {}
    _factor_sql = _job.get("factor_sql") or {}
    _profile_key = (
        _job.get("validation_profile_key")
        or _job.get("profile_key")
        or "fwd_ret_1"
    )
    _label_kind = _job.get("label_kind")
    _horizon_bars = _job.get("horizon_bars")
    _job_started = time.perf_counter()
    _timing = {}
    try:
        _import_started = time.perf_counter()
        _ensure_mlflow()
        _timing["t_import_mlflow_ms"] = _elapsed_ms(_import_started)

        _resolve_started = time.perf_counter()
        _dataset_slug = _runtime_config.get("dataset_slug") or _factor_sql.get("data_source") or ((_idea.get("data_sources") or [""])[0])
        _data_path = resolve_data_path(
            str(_dataset_slug),
            _target_file,
            data_path_override=str(_data_path_override) if _data_path_override else None,
        )
        _timing["t_resolve_data_path_ms"] = _elapsed_ms(_resolve_started)

        _eval_started = time.perf_counter()
        _evaluation = evaluate_factor_sql(
            _factor_sql,
            title=str(_idea.get("title", "")),
            title_hash=str(_idea.get("title_hash", "")),
            formula_sketch=str(_idea.get("formula_sketch", "")),
            data_path=_data_path,
            sample_start=_sample_start,
            validation_profile_key=_profile_key,
            label_kind=_label_kind,
            horizon_bars=_horizon_bars,
        )
        _timing["t_eval_ms"] = _elapsed_ms(_eval_started)
        _evaluation["task_id"] = _task_id
        _evaluation["factor_validation_id"] = _factor_validation_id
        _status = str(_evaluation.get("status", "failed"))
        _mlflow_meta = None
        _final_status = _status
        _error_reason = _evaluation.get("error_reason")
        _diagnostics = dict(_evaluation.get("diagnostics") or {})
        _diagnostics["timing"] = dict(_timing)
        _diagnostics["data_path"] = _data_path

        if _status == "success":
            _emit_timing_snapshot("success_eval")

            _mlflow_started = time.perf_counter()
            try:
                import logging
                logging.getLogger("mlflow").setLevel(logging.ERROR)
                os.environ["MLFLOW_ENABLE_ARTIFACTS_PROGRESS_BAR"] = "false"
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    _mlflow_meta = log_factor_validation_run(
                    _evaluation,
                    task_id=int(_task_id or 0),
                    factor_validation_id=int(_factor_validation_id or 0),
                    idea_id=_idea_id,
                    profile_key=_profile_key,
                    mlflow_config=_mlflow_config,
                    slim=bool(_mlflow_slim),
                    )
            except Exception as _mlflow_exc:
                _error_reason = "MLflow 写入失败: " + str(_mlflow_exc)
                _diagnostics["mlflow_error"] = str(_mlflow_exc)
            _timing["t_mlflow_ms"] = _elapsed_ms(_mlflow_started)

            _diagnostics["timing"] = dict(_timing)
            _mlflow_status = "success" if _mlflow_meta else "failed"
            _final_status = _mlflow_status
            _emit_timing_snapshot(_mlflow_status, _mlflow_meta)
        else:
            _emit_timing_snapshot(_status)

        _timing["t_total_ms"] = _elapsed_ms(_job_started)
        _diagnostics["timing"] = dict(_timing)
        _result = {
            "task_id": _task_id,
            "factor_validation_id": _factor_validation_id,
            "status": _final_status,
            "evaluation": _evaluation,
            "mlflow": _mlflow_meta,
            "timing": _timing,
        }
        _results.append(_result)
    except Exception as _exc:
        _timing["t_total_ms"] = _elapsed_ms(_job_started)
        _failed = {
            "task_id": _task_id,
            "factor_validation_id": _factor_validation_id,
            "status": "failed",
            "diagnostics": {
                "error": str(_exc),
                "traceback": traceback.format_exc(limit=3),
                "timing": _timing,
            },
        }
        _results.append(_failed)

print("${marker}" + json.dumps({"results": _results}, ensure_ascii=False), flush=True)
try:
    print(_TIMING_MARKER + json.dumps({
        "results": [
            {
                "task_id": r.get("task_id"),
                "factor_validation_id": r.get("factor_validation_id"),
                "status": r.get("status"),
                "timing": r.get("timing"),
                "mlflow_run_id": (r.get("mlflow") or {}).get("mlflow_run_id"),
            }
            for r in _results
        ]
    }, ensure_ascii=False))
except Exception as _marker_exc:
    print("timing marker failed: " + str(_marker_exc), flush=True)
`;
  return `${stripPythonFutureImports(engineTemplate)}\n\n${runner.trimStart()}`;
}
