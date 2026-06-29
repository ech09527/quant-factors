#!/usr/bin/env python3
"""Kaggle Kernel：DuckDB 计算因子 panel + 确定性 IC 指标。"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

KERNEL_INPUTS_INLINE = None  # __KERNEL_INPUTS_INLINE__

WORKING = Path("/kaggle/working")


def load_kernel_inputs() -> dict[str, Any]:
    if KERNEL_INPUTS_INLINE is not None:
        return json.loads(KERNEL_INPUTS_INLINE)
    path = SCRIPT_DIR / "kernel_inputs.json"
    if path.is_file():
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    raise RuntimeError("缺少 kernel_inputs")


def main() -> int:
    from evaluate_engine import evaluate_factor_sql, resolve_kaggle_data_path

    inputs = load_kernel_inputs()
    idea = inputs["idea"]
    factor_sql = inputs["factor_sql"]
    sample_start = inputs.get("sample_start", "2023-01-01")
    dataset_slug = factor_sql.get("data_source") or idea["data_sources"][0]
    target_file = inputs.get("target_file", "futures/um/klines/1h.parquet")

    data_path = resolve_kaggle_data_path(dataset_slug, target_file)
    print(f"数据路径: {data_path}")

    evaluation = evaluate_factor_sql(
        factor_sql,
        title=idea["title"],
        title_hash=idea["title_hash"],
        formula_sketch=idea["formula_sketch"],
        data_path=data_path,
        sample_start=sample_start,
        save_panel_path=WORKING / "panel.parquet",
    )

    out_path = WORKING / "evaluation.json"
    out_path.write_text(
        json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(evaluation.get("metrics"), ensure_ascii=False, indent=2))
    print(f"已写入 {out_path}")
    return 0 if evaluation.get("status") in ("success", "skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
