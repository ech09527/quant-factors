"""run_batch_factor_evaluation 的 pending 筛选逻辑测试。"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.run_batch_factor_evaluation import select_pending
from scripts.write_to_project import format_idea_body


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_select_pending_respects_max_ideas() -> None:
    pending = [
        {"title": "A", "title_hash": "a" * 64},
        {"title": "B", "title_hash": "b" * 64},
        {"title": "C", "title_hash": "c" * 64},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        pending_path = Path(tmp) / "pending.json"
        _write_json(pending_path, {"pending": pending, "count": len(pending)})

        selected = select_pending(
            pending_file=pending_path,
            ideas_file=None,
            evaluations_dir=ROOT / "evaluations",
            force=False,
            max_ideas=2,
        )
        assert len(selected) == 2
        assert selected[0]["title_hash"] == "a" * 64
        assert selected[1]["title_hash"] == "b" * 64


def test_select_pending_from_ideas_builds_pending_list() -> None:
    idea = {
        "title": "Never evaluated",
        "hypothesis": "假设",
        "data_sources": ["yhydev97/quant-data"],
        "formula_sketch": "close / lag(close, 24) - 1",
        "expected_signal": "横截面 rank",
        "risks": ["过拟合"],
    }
    ideas = [
        {
            "title": idea["title"],
            "title_hash": "never" + "0" * 59,
            "body": format_idea_body(idea),
        }
    ]
    with tempfile.TemporaryDirectory() as tmp:
        ideas_path = Path(tmp) / "ideas.json"
        eval_dir = Path(tmp) / "evaluations"
        eval_dir.mkdir()
        _write_json(ideas_path, {"ideas": ideas})

        selected = select_pending(
            pending_file=None,
            ideas_file=ideas_path,
            evaluations_dir=eval_dir,
            force=False,
            max_ideas=None,
        )
        assert len(selected) == 1
        assert selected[0]["pending_reason"] == "never_evaluated"
