"""bundle_evaluate_kernel 异步回调模式测试。"""

from __future__ import annotations

import json
from pathlib import Path

from scripts.bundle_evaluate_kernel import build_jupyter_async_eval_code


def test_build_jupyter_async_eval_code_includes_report_callback() -> None:
    code = build_jupyter_async_eval_code(
        {
            "sample_start": "2023-01-01",
            "jobs": [{"validation_id": 42, "profile_key": "fwd_ret_1"}],
            "runtime_config": {"data_path": "/data/1h.parquet"},
        },
        report_config={
            "api_base_url": "https://example.workers.dev",
            "api_token": "secret-token",
        },
    )
    assert "def _report_item" in code
    assert "/api/workflow/validation-jobs/report" in code
    assert "secret-token" in code
    assert "resolve_validation_profile" in code or "evaluate_factor_sql" in code


def test_export_worker_assets_file_exists() -> None:
    repo = Path(__file__).resolve().parent.parent
    asset = repo / "workers" / "factor-ideas" / "assets" / "bundled-eval-engine.py.txt"
    assert asset.is_file()
    assert asset.stat().st_size > 10_000
