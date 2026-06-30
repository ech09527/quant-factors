"""fetch_pending_evaluations 的 Project body 解析测试。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import ENGINE_VERSION, formula_hash
from scripts.fetch_pending_evaluations import needs_evaluation, parse_evaluation_from_body
from scripts.write_evaluation_to_project import format_metrics_table
from scripts.write_to_project import format_idea_body


def _idea_with_body(body: str) -> dict:
    return {
        "title": "测试因子",
        "title_hash": "abc" * 21 + "a",
        "body": body,
        "formula_sketch": "close / lag(close, 24) - 1",
        "formula_hash": formula_hash("close / lag(close, 24) - 1"),
    }


def test_parse_evaluation_from_body_success_roundtrip() -> None:
    idea = {
        "title": "测试因子",
        "hypothesis": "假设",
        "data_sources": ["yhydev97/quant-data"],
        "formula_sketch": "close / lag(close, 24) - 1",
        "expected_signal": "横截面 rank",
        "risks": ["过拟合"],
    }
    evaluation = {
        "title_hash": "abc" * 21 + "a",
        "status": "success",
        "engine_version": ENGINE_VERSION,
        "formula_hash": formula_hash(idea["formula_sketch"]),
        "evaluated_at": "2026-06-30T00:00:00Z",
        "metrics": {
            "mean_ic": 0.01,
            "ic_ir": 0.2,
            "mean_rank_ic": 0.015,
            "rank_ic_ir": 0.25,
            "n_periods": 100,
        },
        "factor_sql": {"signal_sql": "close"},
    }
    body = format_idea_body(idea) + "\n\n" + format_metrics_table(evaluation)
    parsed = parse_evaluation_from_body(body)
    assert parsed is not None
    assert parsed["status"] == "success"
    assert parsed["formula_hash"] == evaluation["formula_hash"]
    assert parsed["engine_version"] == ENGINE_VERSION


def test_needs_evaluation_uses_project_body() -> None:
    idea = {
        "title": "测试因子",
        "hypothesis": "假设",
        "data_sources": ["yhydev97/quant-data"],
        "formula_sketch": "close / lag(close, 24) - 1",
        "expected_signal": "横截面 rank",
        "risks": ["过拟合"],
    }
    evaluation = {
        "title_hash": "abc" * 21 + "a",
        "status": "success",
        "engine_version": ENGINE_VERSION,
        "formula_hash": formula_hash(idea["formula_sketch"]),
        "evaluated_at": "2026-06-30T00:00:00Z",
        "metrics": {
            "mean_ic": 0.01,
            "ic_ir": 0.2,
            "mean_rank_ic": 0.015,
            "rank_ic_ir": 0.25,
            "n_periods": 100,
        },
        "factor_sql": {"signal_sql": "close"},
    }
    body = format_idea_body(idea) + "\n\n" + format_metrics_table(evaluation)
    enriched = _idea_with_body(body)
    should_run, reason = needs_evaluation(enriched, evaluations_dir=Path("/nonexistent"))
    assert should_run is False
    assert reason == "already_validated"
