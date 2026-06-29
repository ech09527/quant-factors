"""validate_sql 单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest

from scripts.validate_sql import validate_factor_sql


VALID_FACTOR_SQL = {
    "version": "1",
    "dialect": "duckdb-factor-v1",
    "evaluation_type": "cross_sectional",
    "data_source": "yhydev97/quant-data",
    "signal_sql": "ret_24h / (vol_24h + 1e-8)",
    "postprocess": "cs_rank",
    "universe": {
        "dropna": ["open", "high", "low", "close"],
        "min_symbol_bars": 168,
        "cs_quantile_gte": {"col": "quote_volume", "q": 0.2},
    },
}


def test_valid_factor_sql():
    validate_factor_sql(VALID_FACTOR_SQL)


def test_forbidden_lead():
    bad = dict(VALID_FACTOR_SQL)
    bad["signal_sql"] = "LEAD(close, 1) OVER w"
    with pytest.raises(ValueError, match="禁止关键字"):
        validate_factor_sql(bad)


def test_allows_nullif_function():
    factor_sql = dict(VALID_FACTOR_SQL)
    factor_sql["signal_sql"] = (
        "ABS(log_ret_1) / NULLIF(quote_volume, 0)"
    )
    validate_factor_sql(factor_sql)


def test_rejects_nested_window_functions():
    bad = dict(VALID_FACTOR_SQL)
    bad["signal_sql"] = (
        "CASE WHEN MAX(AVG((high - low) / close) "
        "OVER (w ROWS BETWEEN 23 PRECEDING AND CURRENT ROW)) "
        "OVER (w ROWS BETWEEN 47 PRECEDING AND CURRENT ROW) > 0 "
        "THEN 1 ELSE 0 END"
    )
    with pytest.raises(ValueError, match="DuckDB 执行校验失败"):
        validate_factor_sql(bad)
