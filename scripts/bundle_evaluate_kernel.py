"""将 evaluate_engine 合并为 Kaggle / Jupyter 可执行的单一脚本。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _strip_header(source: str) -> str:
    lines = source.splitlines()
    cleaned: list[str] = []
    for line in lines:
        if line.startswith("#!"):
            continue
        if line.startswith("from __future__ import"):
            continue
        cleaned.append(line)
    text = "\n".join(cleaned).lstrip("\n")
    return text


def _patch_engine_source(engine_src: str, template_src: str) -> str:
    scripts_import_block = (
        "try:\n"
        "    from scripts.compute_metrics import METRICS_VERSION, compute_metrics\n"
        "    from scripts.validation_profiles import (\n"
        "        DEFAULT_PROFILE_KEY,\n"
        "        build_label_expr,\n"
        "        get_validation_profile,\n"
        "    )\n"
        "except ImportError:\n"
        "    from compute_metrics import METRICS_VERSION, compute_metrics\n"
        "    from validation_profiles import (\n"
        "        DEFAULT_PROFILE_KEY,\n"
        "        build_label_expr,\n"
        "        get_validation_profile,\n"
        "    )\n"
    )
    if scripts_import_block not in engine_src:
        raise ValueError("evaluate_engine 导入块已变，请更新 bundle 逻辑")
    engine_src = engine_src.replace(scripts_import_block, "")

    old_loader = (
        'def load_template() -> Template:\n'
        '    path = scripts_dir() / "templates" / "evaluate_panel.sql.j2"\n'
        '    return Template(path.read_text(encoding="utf-8"))'
    )
    new_loader = (
        "def load_template() -> Template:\n"
        f"    return Template({json.dumps(template_src)})"
    )
    if old_loader not in engine_src:
        raise ValueError("evaluate_engine.load_template 结构已变，请更新 bundle 逻辑")
    return engine_src.replace(old_loader, new_loader)


def _build_bundled_engine_source(repo: Path) -> str:
    profiles_src = _strip_header(
        (repo / "scripts" / "validation_profiles.py").read_text(encoding="utf-8")
    )
    metrics_src = _strip_header(
        (repo / "scripts" / "compute_metrics.py").read_text(encoding="utf-8")
    )
    engine_src = _strip_header(
        (repo / "scripts" / "evaluate_engine.py").read_text(encoding="utf-8")
    )
    template_src = (
        repo / "scripts" / "templates" / "evaluate_panel.sql.j2"
    ).read_text(encoding="utf-8")
    engine_src = _patch_engine_source(engine_src, template_src)

    return (
        "# Bundled evaluate engine\n"
        "from __future__ import annotations\n\n"
        f"{profiles_src}\n\n"
        f"{metrics_src}\n\n"
        f"{engine_src}"
    )


def build_jupyter_inline_eval_code(
    payload: dict[str, Any],
    *,
    marker: str = "__QF_EVAL_JSON__",
    repo: Path | None = None,
) -> str:
    """生成可在 Jupyter kernel 内直接执行的评估代码（不依赖 scripts 包）。"""
    root = repo or Path(__file__).resolve().parent.parent
    engine_src = _build_bundled_engine_source(root)
    payload_literal = repr(json.dumps(payload, ensure_ascii=False))
    runner_src = f"""
import json
import traceback

_payload = json.loads({payload_literal})
_sample_start = _payload.get("sample_start", "2023-01-01")
_target_file = _payload.get("target_file", "futures/um/klines/1h.parquet")
_jobs = _payload.get("jobs", [])
_evaluations = []
for _job in _jobs:
    _validation_id = _job.get("validation_id")
    _idea = _job.get("idea") or {{}}
    _factor_sql = _job.get("factor_sql") or {{}}
    _profile_key = _job.get("validation_profile_key") or "fwd_ret_1"
    _label_kind = _job.get("label_kind")
    _horizon_bars = _job.get("horizon_bars")
    try:
        _dataset_slug = _factor_sql.get("data_source") or ((_idea.get("data_sources") or [""])[0])
        _data_path = resolve_kaggle_data_path(str(_dataset_slug), _target_file)
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
    except Exception as _exc:
        _evaluations.append({{
            "validation_id": _validation_id,
            "status": "failed",
            "factor_sql": _factor_sql,
            "diagnostics": {{
                "error": str(_exc),
                "traceback": traceback.format_exc(limit=3),
            }},
        }})
print("{marker}" + json.dumps({{"evaluations": _evaluations}}, ensure_ascii=False))
"""
    return f"{engine_src}\n\n{runner_src.lstrip()}"


def build_bundled_kernel_source(repo: Path, runner_path: Path) -> str:
    engine_src = _build_bundled_engine_source(repo)
    runner_src = _strip_header(runner_path.read_text(encoding="utf-8"))

    runner_src = runner_src.replace(
        "    from evaluate_engine import evaluate_factor_sql, resolve_kaggle_data_path\n\n",
        "",
    )
    runner_src = runner_src.replace(
        "    from evaluate_engine import ENGINE_VERSION, METRICS_VERSION, evaluate_factor_sql, formula_hash, resolve_kaggle_data_path\n\n",
        "",
    )

    return (
        "# Bundled kernel for Kaggle (generated at push time)\n"
        f"{engine_src.split(chr(10), 1)[1]}\n\n"
        f"{runner_src}"
    )
