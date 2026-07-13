import engineTemplate from "../assets/bundled-eval-engine.py.txt";

function pythonJsonLoadsLiteral(value) {
  return JSON.stringify(JSON.stringify(value));
}

export function buildAsyncEvalCode(payload, reportConfig) {
  if (!reportConfig?.api_base_url || !reportConfig?.api_token) {
    throw new Error("reportConfig 需要 api_base_url 与 api_token");
  }
  const marker = "__QF_EVAL_JSON__";
  const payloadLiteral = pythonJsonLoadsLiteral(payload);
  const reportLiteral = pythonJsonLoadsLiteral(reportConfig);
  const runner = `
import json
import traceback
import urllib.request

_WORKFLOW_UA = "quant-factors-workflow/1.0"
_payload = json.loads(${payloadLiteral})
_report_cfg = json.loads(${reportLiteral})
_sample_start = _payload.get("sample_start", "2023-01-01")
_runtime_config = _payload.get("runtime_config") or {}
if not isinstance(_runtime_config, dict):
    _runtime_config = {}
_target_file = _runtime_config.get("target_file") or _payload.get("target_file", "futures/um/klines/1h.parquet")
_data_path_override = _runtime_config.get("data_path")
_jobs = _payload.get("jobs", [])
_evaluations = []


def _report_item(item):
    body = json.dumps({"items": [item]}, ensure_ascii=False).encode("utf-8")
    url = _report_cfg["api_base_url"].rstrip("/") + "/api/workflow/validation-jobs/report"
    token = _report_cfg["api_token"]
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": _WORKFLOW_UA,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _build_report_item(job, evaluation):
    validation_id = int(job.get("validation_id") or 0)
    expected = str(
        job.get("validation_profile_key") or job.get("profile_key") or ""
    ).strip()
    status = str(evaluation.get("status", "failed"))
    metrics = evaluation.get("metrics")
    if isinstance(metrics, dict):
        metrics = dict(metrics)
        if expected and not metrics.get("validation_profile_key"):
            metrics["validation_profile_key"] = expected
        if job.get("label_kind") is not None and metrics.get("label_kind") is None:
            metrics["label_kind"] = job.get("label_kind")
        if job.get("horizon_bars") is not None and metrics.get("horizon_bars") is None:
            metrics["horizon_bars"] = job.get("horizon_bars")
    actual = ""
    if isinstance(metrics, dict) and metrics.get("validation_profile_key"):
        actual = str(metrics["validation_profile_key"]).strip()
    diagnostics = dict(evaluation.get("diagnostics") or {})
    factor_sql = evaluation.get("factor_sql") or job.get("factor_sql")
    error_reason = evaluation.get("error_reason")
    if status == "success" and expected and actual and expected != actual:
        status = "failed"
        error_reason = "validation_profile 不匹配: 期望 " + expected + ", 实际 " + actual
        diagnostics["profile_mismatch"] = {"expected": expected, "actual": actual}
    if status == "failed" and not error_reason:
        error_reason = diagnostics.get("error")
    return {
        "validation_id": validation_id,
        "status": status,
        "factor_sql": factor_sql,
        "metrics": metrics,
        "diagnostics": diagnostics or None,
        "error_reason": error_reason,
        "engine_version": evaluation.get("engine_version"),
        "metrics_version": evaluation.get("metrics_version"),
        "evaluated_at": evaluation.get("evaluated_at"),
    }


for _job in _jobs:
    _validation_id = _job.get("validation_id")
    _idea = _job.get("idea") or {}
    _factor_sql = _job.get("factor_sql") or {}
    _profile_key = (
        _job.get("validation_profile_key")
        or _job.get("profile_key")
        or "fwd_ret_1"
    )
    _label_kind = _job.get("label_kind")
    _horizon_bars = _job.get("horizon_bars")
    try:
        _dataset_slug = _runtime_config.get("dataset_slug") or _factor_sql.get("data_source") or ((_idea.get("data_sources") or [""])[0])
        _data_path = resolve_data_path(
            str(_dataset_slug),
            _target_file,
            data_path_override=str(_data_path_override) if _data_path_override else None,
        )
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
        _evaluation["validation_id"] = _validation_id
        _evaluations.append(_evaluation)
        _report_item(_build_report_item(_job, _evaluation))
    except Exception as _exc:
        _failed = {
            "validation_id": _validation_id,
            "status": "failed",
            "factor_sql": _factor_sql,
            "diagnostics": {
                "error": str(_exc),
                "traceback": traceback.format_exc(limit=3),
            },
        }
        _evaluations.append(_failed)
        _report_item(_build_report_item(_job, _failed))

print("${marker}" + json.dumps({"evaluations": _evaluations}, ensure_ascii=False))
`;
  return `${engineTemplate}\n\n${runner.trimStart()}`;
}
