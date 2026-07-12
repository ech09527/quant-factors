import engineTemplate from "../assets/bundled-eval-engine.py.txt";

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

function stripPythonFutureImports(code) {
  return code
    .split("\n")
    .filter((line) => !/^\s*from __future__ import/.test(line))
    .join("\n");
}

function wrapTestValidationCodeWithTopLevelHandler({
  engineTemplate,
  runner,
  payloadLiteral,
  marker
}) {
  const engineBody = stripPythonFutureImports(engineTemplate);
  const topLevelCatch = `
except Exception as _top_level_exc:
    import json as _json
    import traceback as _traceback
    _items_tl = []
    try:
        _payload_tl = _json.loads(${payloadLiteral})
        for _job_tl in (_payload_tl.get("jobs") or []):
            _items_tl.append({
                "task_id": _job_tl.get("task_id"),
                "test_factor_validation_id": _job_tl.get("test_factor_validation_id"),
                "status": "failed",
                "diagnostics": {
                    "error": str(_top_level_exc),
                    "traceback": _traceback.format_exc(limit=5),
                    "stage": "top_level",
                    "mock_eval": True,
                },
            })
    except Exception:
        pass
    print("${marker}" + _json.dumps({"results": _items_tl}, ensure_ascii=False), flush=True)
`;
  const body = `${engineBody}\n\n${runner.trimStart()}`;
  return `try:\n${indentPythonLines(body)}\n${topLevelCatch.trimStart()}`;
}

export function buildTestFactorValidationEvalCode(payload) {
  const skipMlflow = Boolean(payload?.skip_mlflow);
  const marker = "__QF_TEST_FACTOR_VALIDATION_JSON__";
  const timingMarker = "__QF_TEST_FV_TIMING__";
  const payloadLiteral = pythonJsonLoadsLiteral(payload);
  const runner = `
import json
import os
import time
import traceback
import contextlib
import io
from datetime import datetime, timezone

_TIMING_MARKER = "${timingMarker}"
_MARKER = "${marker}"
_payload = json.loads(${payloadLiteral})
_mlflow_config = _payload.get("mlflow_config") or {}
if not isinstance(_mlflow_config, dict):
    _mlflow_config = {}
_mlflow_slim = _payload.get("mlflow_slim", True)
_mlflow_preinstalled = bool(_payload.get("mlflow_preinstalled", True))
_jobs = _payload.get("jobs", [])
_results = []
_skip_mlflow = bool(_payload.get("skip_mlflow", False))


def _elapsed_ms(started_at):
    return int((time.perf_counter() - started_at) * 1000)


def _ensure_mlflow():
    try:
        import mlflow  # noqa: F401
        return
    except ImportError:
        if _mlflow_preinstalled:
            raise RuntimeError(
                "mlflow 未安装：请在 Jupyter 镜像中预装 mlflow>=2.14.0"
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
                "test_factor_validation_id": _test_factor_validation_id,
                "status": status,
                "timing": dict(_timing),
                "mlflow_run_id": (mlflow_meta or {}).get("mlflow_run_id"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def _mock_factor_sql(job):
    existing = job.get("factor_sql")
    if isinstance(existing, dict) and existing.get("signal_sql"):
        return existing
    return {
        "version": "1",
        "dialect": "duckdb",
        "evaluation_type": "cross_sectional",
        "data_source": "mock",
        "signal_sql": "SELECT 1 AS mock_factor",
        "postprocess": {},
        "universe": "mock",
    }


def _mock_evaluation(job):
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    profile_key = str(job.get("profile_key") or job.get("validation_profile_key") or "fwd_ret_1")
    idea = job.get("idea") or {}
    title = str(idea.get("title") or "mock-title")
    title_hash = str(idea.get("title_hash") or ("0" * 64))
    factor_sql = _mock_factor_sql(job)
    return {
        "status": "success",
        "title": title,
        "title_hash": title_hash,
        "formula_hash": title_hash,
        "expression_version": "mock",
        "engine_version": "test-mock/1.0",
        "metrics_version": "mock/1.0",
        "evaluation_type": "cross_sectional",
        "validation_profile_key": profile_key,
        "evaluated_at": now,
        "data_range": {"start": "2023-01-01", "end": "2023-12-31", "n_bars": 100},
        "factor_sql": factor_sql,
        "metrics": {
            "mean_ic": 0.05,
            "ic_ir": 1.2,
            "mean_rank_ic": 0.04,
            "rank_ic_ir": 1.0,
            "n_periods": 100,
            "ic_positive_ratio": 0.55,
        },
        "diagnostics": {"mock": True, "avg_universe_size": 120},
        "ic_series": {
            "period_axis": "daily",
            "n_points": 3,
            "points": [
                {"t": "2023-01-01", "ic": 0.03, "rank_ic": 0.02},
                {"t": "2023-01-02", "ic": 0.04, "rank_ic": 0.03},
                {"t": "2023-01-03", "ic": 0.05, "rank_ic": 0.04},
            ],
        },
    }


for _job in _jobs:
    _task_id = _job.get("task_id")
    _test_factor_validation_id = _job.get("test_factor_validation_id")
    _idea_id = int(_job.get("idea_id") or 0)
    _profile_key = (
        _job.get("validation_profile_key")
        or _job.get("profile_key")
        or "fwd_ret_1"
    )
    _job_started = time.perf_counter()
    _timing = {}
    try:
        if not _skip_mlflow:
            _import_started = time.perf_counter()
            _ensure_mlflow()
            _timing["t_import_mlflow_ms"] = _elapsed_ms(_import_started)

        _eval_started = time.perf_counter()
        time.sleep(0.05)
        _evaluation = _mock_evaluation(_job)
        _timing["t_eval_ms"] = _elapsed_ms(_eval_started)
        _evaluation["task_id"] = _task_id
        _evaluation["test_factor_validation_id"] = _test_factor_validation_id
        _status = str(_evaluation.get("status", "failed"))
        _mlflow_meta = None
        _final_status = _status
        _error_reason = _evaluation.get("error_reason")
        _diagnostics = dict(_evaluation.get("diagnostics") or {})
        _diagnostics["timing"] = dict(_timing)

        if _status == "success":
            _emit_timing_snapshot("success_eval")

            if _skip_mlflow:
                _diagnostics["skip_mlflow"] = True
                _diagnostics["timing"] = dict(_timing)
                _final_status = "success"
                _emit_timing_snapshot("success", None)
            else:
                _mlflow_started = time.perf_counter()
                try:
                    import logging
                    logging.getLogger("mlflow").setLevel(logging.ERROR)
                    os.environ["MLFLOW_ENABLE_ARTIFACTS_PROGRESS_BAR"] = "false"
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        _mlflow_meta = log_factor_validation_run(
                            _evaluation,
                            task_id=int(_task_id or 0),
                            factor_validation_id=int(_test_factor_validation_id or 0),
                            idea_id=_idea_id,
                            profile_key=_profile_key,
                            mlflow_config=_mlflow_config,
                            slim=bool(_mlflow_slim),
                            business_type="test_factor_validation",
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
        _results.append({
            "task_id": _task_id,
            "test_factor_validation_id": _test_factor_validation_id,
            "status": _final_status,
            "evaluation": _evaluation,
            "mlflow": _mlflow_meta,
            "timing": _timing,
        })
    except Exception as _exc:
        _timing["t_total_ms"] = _elapsed_ms(_job_started)
        _failed_diag = {
            "error": str(_exc),
            "traceback": traceback.format_exc(limit=3),
            "timing": _timing,
            "mock_eval": True,
        }
        _results.append({
            "task_id": _task_id,
            "test_factor_validation_id": _test_factor_validation_id,
            "status": "failed",
            "diagnostics": _failed_diag,
        })

print(_MARKER + json.dumps({"results": _results}, ensure_ascii=False), flush=True)
try:
    print(_TIMING_MARKER + json.dumps({
        "results": [
            {
                "task_id": r.get("task_id"),
                "test_factor_validation_id": r.get("test_factor_validation_id"),
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
  return wrapTestValidationCodeWithTopLevelHandler({
    engineTemplate: skipMlflow ? "" : engineTemplate,
    runner,
    payloadLiteral,
    marker
  });
}
