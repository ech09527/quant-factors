"""run_local_factor_evaluation 单元测试。"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.run_local_factor_evaluation import run_local_evaluation

IDEA = {
    "title": "本地评估测试",
    "title_hash": "local" + "a" * 60,
    "formula_sketch": "ret_24h / vol_24h",
    "data_sources": ["yhydev97/quant-data"],
}

FACTOR_SQL = {
    "version": "1",
    "dialect": "duckdb-factor-v1",
    "evaluation_type": "cross_sectional",
    "data_source": "yhydev97/quant-data",
    "signal_sql": "ret_24h / (vol_24h + 1e-8)",
    "postprocess": "cs_rank",
    "universe": {
        "dropna": ["open", "high", "low", "close"],
        "min_symbol_bars": 50,
        "cs_quantile_gte": {"col": "quote_volume", "q": 0.2},
    },
}


def test_run_local_evaluation_success():
    evaluation = run_local_evaluation(IDEA, FACTOR_SQL)
    assert evaluation["status"] == "success"
    assert evaluation["n_rows"] >= 50
    assert evaluation.get("local_eval") is True


def test_run_local_evaluation_rejects_nested_windows():
    bad = dict(FACTOR_SQL)
    bad["signal_sql"] = (
        "CASE WHEN MAX(AVG((high - low) / close) "
        "OVER (w ROWS BETWEEN 23 PRECEDING AND CURRENT ROW)) "
        "OVER (w ROWS BETWEEN 47 PRECEDING AND CURRENT ROW) > 0 "
        "THEN 1 ELSE 0 END"
    )
    with pytest.raises(ValueError, match="本地 DuckDB 执行失败|DuckDB 执行校验失败"):
        run_local_evaluation(IDEA, bad)


def test_cli_writes_output():
    from scripts.run_local_factor_evaluation import main

    with tempfile.TemporaryDirectory() as tmp:
        idea_path = Path(tmp) / "idea.json"
        factor_sql_path = Path(tmp) / "factor_sql.json"
        out_path = Path(tmp) / "evaluation.json"
        idea_path.write_text(json.dumps(IDEA), encoding="utf-8")
        factor_sql_path.write_text(json.dumps(FACTOR_SQL), encoding="utf-8")
        assert (
            main(
                [
                    "--idea",
                    str(idea_path),
                    "--factor-sql",
                    str(factor_sql_path),
                    "-o",
                    str(out_path),
                ]
            )
            == 0
        )
        payload = json.loads(out_path.read_text(encoding="utf-8"))
        assert payload["status"] == "success"
