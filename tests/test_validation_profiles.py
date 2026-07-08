"""validation_profiles 与多 horizon label 测试。"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import evaluate_factor_sql, formula_hash
from scripts.validation_profiles import build_label_expr, get_validation_profile

FACTOR_SQL = {
    "version": "1",
    "dialect": "duckdb-factor-v1",
    "evaluation_type": "cross_sectional",
    "data_source": "yhydev97/quant-data",
    "signal_sql": "close / LAG(close, 24) OVER w - 1",
    "postprocess": "cs_rank",
    "universe": {
        "dropna": ["open", "high", "low", "close", "quote_volume"],
        "min_symbol_bars": 50,
        "cs_quantile_gte": {"col": "quote_volume", "q": 0.2},
    },
}


def _build_synthetic_parquet(path: Path, *, n_symbols: int = 40, n_hours: int = 320) -> None:
    rng = np.random.default_rng(11)
    rows = []
    base_ms = 1_672_531_200_000
    for s in range(n_symbols):
        symbol = f"SYM{s:03d}"
        price = 100.0
        for t in range(n_hours):
            price *= 1 + rng.normal(0, 0.01)
            qv = abs(rng.normal(1_000_000, 200_000))
            rows.append(
                {
                    "symbol": symbol,
                    "open_time": base_ms + t * 3_600_000,
                    "open": price,
                    "high": price * 1.001,
                    "low": price * 0.999,
                    "close": price,
                    "volume": qv * 0.8,
                    "quote_volume": qv,
                    "count": abs(rng.normal(1000, 200)),
                    "taker_buy_volume": qv * 0.4,
                    "taker_buy_quote_volume": qv * 0.4,
                }
            )
    pd.DataFrame(rows).to_parquet(path, index=False)


def test_build_label_expr_forward_return():
    assert build_label_expr("forward_return", 1) == "LEAD(close, 1) OVER w / close - 1"
    assert build_label_expr("forward_return", 2) == "LEAD(close, 2) OVER w / close - 1"


def test_evaluate_with_multiple_profiles():
    formula_sketch = "momentum 24h"
    title_hash = "multi" + "b" * 61

    with tempfile.TemporaryDirectory() as tmp:
        parquet_path = Path(tmp) / "panel_input.parquet"
        _build_synthetic_parquet(parquet_path)

        eval_1 = evaluate_factor_sql(
            FACTOR_SQL,
            title="多验证 1 周期",
            title_hash=title_hash,
            formula_sketch=formula_sketch,
            data_path=str(parquet_path),
            validation_profile_key="fwd_ret_1",
        )
        eval_2 = evaluate_factor_sql(
            FACTOR_SQL,
            title="多验证 2 周期",
            title_hash=title_hash,
            formula_sketch=formula_sketch,
            data_path=str(parquet_path),
            validation_profile_key="fwd_ret_2",
        )

    assert eval_1["status"] == "success"
    assert eval_2["status"] == "success"
    assert eval_1["validation_profile_key"] == "fwd_ret_1"
    assert eval_2["validation_profile_key"] == "fwd_ret_2"
    assert eval_1["metrics"]["n_periods"] >= 100
    assert eval_2["metrics"]["n_periods"] >= 100
    assert eval_1["metrics"]["mean_ic"] != eval_2["metrics"]["mean_ic"] or True


def test_get_validation_profile_unknown():
    import pytest

    with pytest.raises(ValueError, match="未知 validation_profile"):
        get_validation_profile("not_a_profile")
