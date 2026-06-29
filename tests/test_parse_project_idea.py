"""parse_project_idea 单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.parse_project_idea import infer_evaluation_type, parse_project_idea_body
from scripts.write_to_project import format_idea_body


def test_parse_and_infer_cross_sectional():
    idea = {
        "title": "测试因子",
        "hypothesis": "假设",
        "data_sources": ["yhydev97/quant-data"],
        "formula_sketch": "横截面 rank",
        "expected_signal": "横截面做多高分位",
        "risks": ["风险1"],
    }
    body = format_idea_body(idea)
    parsed = parse_project_idea_body(body)
    assert parsed["formula_sketch"] == "横截面 rank"
    assert infer_evaluation_type(parsed["expected_signal"], parsed["formula_sketch"]) == "cross_sectional"
