"""端到端：合成 parquet → DuckDB panel → IC 指标。"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import evaluate_factor_sql, formula_hash
from scripts.validate_evaluation import validate_evaluation
from scripts.validate_sql import validate_factor_sql

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


def _build_synthetic_parquet(path: Path, *, n_symbols: int = 40, n_hours: int = 300) -> None:
    rng = np.random.default_rng(7)
    rows = []
    base_ms = 1_672_531_200_000
    for s in range(n_symbols):
        symbol = f"SYM{s:03d}"
        price = 100.0
        for t in range(n_hours):
            ret = rng.normal(0, 0.01)
            price *= 1 + ret
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


def test_e2e_evaluate_engine_pipeline():
    validate_factor_sql(FACTOR_SQL)
    formula_sketch = "quote_volume / rolling_std(log ret, 24)"
    title_hash = "e2e" + "a" * 61

    with tempfile.TemporaryDirectory() as tmp:
        parquet_path = Path(tmp) / "panel_input.parquet"
        _build_synthetic_parquet(parquet_path)

        evaluation = evaluate_factor_sql(
            FACTOR_SQL,
            title="E2E 合成横截面因子",
            title_hash=title_hash,
            formula_sketch=formula_sketch,
            data_path=str(parquet_path),
            sample_start="2023-01-01",
        )

        assert evaluation["status"] == "success"
        assert evaluation["metrics"]["n_periods"] >= 100
        validate_evaluation(
            evaluation,
            expected_title_hash=title_hash,
            expected_formula_hash=formula_hash(formula_sketch),
        )
