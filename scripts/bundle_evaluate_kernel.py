"""将 evaluate_engine 合并为 Kaggle 可执行的单一脚本。"""

from __future__ import annotations

import json
from pathlib import Path


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


def build_bundled_kernel_source(repo: Path, runner_path: Path) -> str:
    metrics_src = _strip_header(
        (repo / "scripts" / "compute_metrics.py").read_text(encoding="utf-8")
    )
    engine_src = _strip_header(
        (repo / "scripts" / "evaluate_engine.py").read_text(encoding="utf-8")
    )
    template_src = (
        repo / "scripts" / "templates" / "evaluate_panel.sql.j2"
    ).read_text(encoding="utf-8")
    runner_src = _strip_header(runner_path.read_text(encoding="utf-8"))

    engine_src = engine_src.replace(
        "try:\n    from scripts.compute_metrics import METRICS_VERSION, compute_metrics\n"
        "except ImportError:\n    from compute_metrics import METRICS_VERSION, compute_metrics\n",
        "",
    )

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
    engine_src = engine_src.replace(old_loader, new_loader)

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
        "from __future__ import annotations\n\n"
        f"{metrics_src}\n\n"
        f"{engine_src}\n\n"
        f"{runner_src}"
    )
