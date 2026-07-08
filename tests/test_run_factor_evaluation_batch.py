"""run_factor_evaluation 批量 kernel 输入/输出测试。"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.bundle_evaluate_kernel import (
    build_bundled_kernel_source,
    build_jupyter_inline_eval_code,
)
from scripts.evaluate_engine import ENGINE_VERSION
from scripts.run_factor_evaluation import (
    build_batch_kernel_inputs,
    load_batch_kernel_output,
)


def test_build_batch_kernel_inputs() -> None:
    jobs = [
        {
            "idea": {"title": "A", "title_hash": "a" * 64},
            "factor_sql": {"data_source": "yhydev97/quant-data", "signal_sql": "close"},
        }
    ]
    payload = build_batch_kernel_inputs(jobs, sample_start="2023-01-01", target_file="f.parquet")
    assert payload["batch"] == jobs
    assert payload["engine_version"] == ENGINE_VERSION
    assert payload["sample_start"] == "2023-01-01"


def test_load_batch_kernel_output_prefers_batch_file() -> None:
    evaluation = {"title_hash": "a" * 64, "status": "success"}
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        (out_dir / "batch_evaluations.json").write_text(
            json.dumps({"evaluations": [evaluation]}, ensure_ascii=False),
            encoding="utf-8",
        )
        (out_dir / "evaluation.json").write_text(
            json.dumps({"title_hash": "b" * 64, "status": "success"}, ensure_ascii=False),
            encoding="utf-8",
        )
        loaded = load_batch_kernel_output(out_dir)
        assert len(loaded) == 1
        assert loaded[0]["title_hash"] == "a" * 64


def test_bundled_kernel_does_not_import_evaluate_engine_module() -> None:
    runner = ROOT / "explorations" / "evaluate-factor-idea" / "evaluate_factor_idea.py"
    bundled = build_bundled_kernel_source(ROOT, runner)
    assert "from evaluate_engine import" not in bundled
    assert "from scripts." not in bundled
    assert "def evaluate_factor_sql(" in bundled
    assert "DEFAULT_VALIDATION_PROFILES" in bundled
    assert "batch_evaluations.json" in bundled


def test_jupyter_inline_eval_code_is_self_contained() -> None:
    code = build_jupyter_inline_eval_code(
        {
            "sample_start": "2023-01-01",
            "runtime_config": {
                "target_file": "futures/um/klines/1h.parquet",
                "data_path": "/kaggle/input/custom/data.parquet",
            },
            "jobs": [],
        }
    )
    assert "from scripts." not in code
    assert "def evaluate_factor_sql(" in code
    assert "DEFAULT_VALIDATION_PROFILES" in code
    assert "__QF_EVAL_JSON__" in code
    assert "_runtime_config" in code
    assert "_data_path_override" in code
