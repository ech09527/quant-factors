"""中性化评估引擎：通用 exposures 规格。"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import evaluate_factor_sql, render_panel_sql  # noqa: E402
from scripts.factor_validation_runner import (  # noqa: E402
    _neutralization_key,
    _neutralization_spec,
)
from scripts.neutralization_spec import (  # noqa: E402
    NEUTRALIZATION_PROFILES,
    build_neutralization_cte_sql,
    default_neutralization_spec,
    normalize_neutralization_spec,
    resolve_neutralization_spec,
    spec_fingerprint,
)

FACTOR_SQL = {
    "version": "1",
    "dialect": "duckdb-factor-v1",
    "evaluation_type": "cross_sectional",
    "data_source": "yhydev97/quant-data",
    "signal_sql": "quote_volume",
    "postprocess": "cs_rank",
    "universe": {
        "dropna": ["open", "high", "low", "close", "quote_volume"],
        "min_symbol_bars": 30,
    },
}


def _build_synthetic_parquet(path: Path, *, n_symbols: int = 30, n_hours: int = 120) -> None:
    rng = np.random.default_rng(11)
    rows = []
    base_ms = 1_672_531_200_000
    for s in range(n_symbols):
        symbol = f"NEU{s:03d}"
        price = 50.0 + s
        for t in range(n_hours):
            ret = rng.normal(0, 0.01)
            price *= 1 + ret
            qv = abs(rng.normal(1_000_000 + s * 5_000, 100_000))
            rows.append(
                {
                    "symbol": symbol,
                    "open_time": base_ms + t * 3_600_000,
                    "open": price,
                    "high": price * 1.002,
                    "low": price * 0.998,
                    "close": price,
                    "volume": qv * 0.8,
                    "quote_volume": qv,
                    "count": abs(rng.normal(1000, 100)),
                    "taker_buy_volume": qv * 0.4,
                    "taker_buy_quote_volume": qv * 0.4,
                }
            )
    pd.DataFrame(rows).to_parquet(path, index=False)


def test_named_profiles_still_exist():
    assert "liq_mom" in NEUTRALIZATION_PROFILES
    assert "auto" in NEUTRALIZATION_PROFILES


def test_normalize_and_fingerprint_stable():
    spec = normalize_neutralization_spec(default_neutralization_spec())
    assert len(spec["exposures"]) == 2
    assert spec_fingerprint(spec) == spec_fingerprint(dict(spec))


def test_build_cte_from_generic_spec():
    spec = {
        "version": "1",
        "method": "sequential_ols",
        "exposures": [
            {"field": "quote_volume", "transform": "ln"},
            {"field": "vol_24h", "transform": "identity"},
        ],
    }
    sql = build_neutralization_cte_sql(neutralization_spec=spec)
    assert "exp_0" in sql
    assert "exp_1" in sql
    assert "regr_slope" in sql
    assert "neutral_signal" in sql


def test_liq_mom_alias_matches_default_exposures():
    named = resolve_neutralization_spec(neutralization_key="liq_mom")
    default = default_neutralization_spec()
    assert named["exposures"] == default["exposures"]


def test_render_panel_sql_with_spec():
    sql = render_panel_sql(
        FACTOR_SQL,
        data_path="/tmp/panel.parquet",
        sample_start_ms=1_672_531_200_000,
        neutralization_spec={
            "version": "1",
            "method": "sequential_ols",
            "exposures": [{"field": "ret_24h", "transform": "identity"}],
        },
    )
    assert "neutralized AS" in sql
    assert "PERCENT_RANK() OVER (PARTITION BY open_time ORDER BY neutral_signal)" in sql


def test_evaluate_with_custom_spec_runs():
    with tempfile.TemporaryDirectory() as tmp:
        parquet_path = Path(tmp) / "panel.parquet"
        _build_synthetic_parquet(parquet_path)
        custom = {
            "version": "1",
            "method": "sequential_ols",
            "exposures": [
                {"field": "quote_volume", "transform": "ln"},
                {"field": "ret_24h", "transform": "identity"},
            ],
        }
        result = evaluate_factor_sql(
            FACTOR_SQL,
            title="neutral-spec-test",
            title_hash="neutral" + "c" * 58,
            formula_sketch="quote_volume rank",
            data_path=str(parquet_path),
            sample_start="2023-01-01",
            neutralization_key="auto",
            neutralization_spec=custom,
        )
    assert result["status"] == "success"
    assert result["neutralization_spec"]["exposures"] == custom["exposures"]
    assert result["diagnostics"]["neutralization"]["spec"]["exposures"] == custom["exposures"]


def test_runner_reads_neutralization_spec():
    assert _neutralization_key({}) == "none"
    assert _neutralization_spec({"neutralization_spec": {"version": "1"}})["version"] == "1"
    assert _neutralization_spec({}) is None
