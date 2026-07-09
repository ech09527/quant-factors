"""验证配置解析与 report 构建测试。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import resolve_label_expr
from scripts.run_d1_validation_batch import build_report_item
from scripts.validation_profiles import resolve_validation_profile


def test_resolve_validation_profile_prefers_builtin_key() -> None:
    profile = resolve_validation_profile(
        validation_profile_key="fwd_ret_24",
        label_kind="forward_return",
        horizon_bars=1,
    )
    assert profile["key"] == "fwd_ret_24"
    assert profile["horizon_bars"] == 24


def test_resolve_label_expr_differs_by_profile_key() -> None:
    expr_1, profile_1 = resolve_label_expr(validation_profile_key="fwd_ret_1")
    expr_24, profile_24 = resolve_label_expr(validation_profile_key="fwd_ret_24")
    assert profile_1["horizon_bars"] == 1
    assert profile_24["horizon_bars"] == 24
    assert expr_1 != expr_24


def test_resolve_validation_profile_custom_from_job_fields() -> None:
    profile = resolve_validation_profile(
        validation_profile_key="custom_fwd_6",
        label_kind="forward_return",
        horizon_bars=6,
    )
    assert profile["key"] == "custom_fwd_6"
    assert profile["horizon_bars"] == 6


def test_build_report_item_rejects_profile_mismatch() -> None:
    job = {
        "validation_id": 42,
        "profile_key": "fwd_ret_24",
        "validation_profile_key": "fwd_ret_24",
        "factor_sql": {"signal_sql": "close"},
    }
    evaluation = {
        "status": "success",
        "validation_profile_key": "fwd_ret_1",
        "metrics": {
            "validation_profile_key": "fwd_ret_1",
            "ic_ir": 0.01,
        },
        "factor_sql": job["factor_sql"],
    }
    item = build_report_item(job, evaluation)
    assert item["status"] == "failed"
    assert "不匹配" in (item.get("error_reason") or "")


def test_build_report_item_enriches_metrics_with_expected_profile() -> None:
    job = {
        "validation_id": 7,
        "profile_key": "fwd_vol_1",
        "validation_profile_key": "fwd_vol_1",
        "label_kind": "forward_volatility",
        "horizon_bars": 1,
        "factor_sql": {"signal_sql": "close"},
    }
    evaluation = {
        "status": "success",
        "validation_profile_key": "fwd_vol_1",
        "metrics": {"ic_ir": 0.5, "mean_ic": 0.05},
        "diagnostics": {},
        "factor_sql": job["factor_sql"],
    }
    item = build_report_item(job, evaluation)
    assert item["status"] == "success"
    assert item["metrics"]["validation_profile_key"] == "fwd_vol_1"
    assert item["metrics"]["label_kind"] == "forward_volatility"
    assert item["metrics"]["horizon_bars"] == 1
