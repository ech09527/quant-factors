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
    "signal_sql": (
        "(close / LAG(close, 24) OVER w - 1) / "
        "(STDDEV_SAMP(LN(close / LAG(close, 1) OVER w)) "
        "OVER (PARTITION BY symbol ORDER BY open_time "
        "ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) + 1e-8)"
    ),
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
