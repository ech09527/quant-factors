"""测试因子验证 kernel 代码生成（mock eval + 真实 MLflow）。"""

from __future__ import annotations

from pathlib import Path


def test_test_factor_validation_kernel_uses_real_mlflow():
    root = Path(__file__).resolve().parent.parent
    src = (
        root / "workers/factor-ideas/src/test-factor-validation-kernel-builder.js"
    ).read_text(encoding="utf-8")
    assert "/api/workflow/test-ml-tasks/report" not in src
    assert "urllib.request" not in src
    assert "def _mock_evaluation" in src
    assert "log_factor_validation_run" in src
    assert 'business_type="test_factor_validation"' in src
    assert "_mock_mlflow_meta" not in src
    assert "_skip_mlflow" in src
    assert "skip_mlflow" in src
    assert "__QF_TEST_FACTOR_VALIDATION_JSON__" in src
