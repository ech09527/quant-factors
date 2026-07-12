"""factor validation kernel bundle 测试。"""

from __future__ import annotations

from pathlib import Path


def test_factor_validation_kernel_builder_contains_mlflow_report():
    root = Path(__file__).resolve().parent.parent
    src = (root / "workers/factor-ideas/src/factor-validation-kernel-builder.js").read_text(
        encoding="utf-8"
    )
    assert "/api/workflow/ml-tasks/report" not in src
    assert "urllib.request" not in src
    assert "def _report_item" not in src
    assert "def _safe_report_item" not in src
    assert "def _emit_timing_snapshot" in src
    assert "log_factor_validation_run" in src
    assert "t_eval_ms" in src
    assert "__QF_FACTOR_VALIDATION_JSON__" in src
    assert "stripPythonFutureImports" in src
