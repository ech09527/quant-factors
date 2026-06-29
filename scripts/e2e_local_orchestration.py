#!/usr/bin/env python3
"""本地编排层 E2E（不依赖 Kaggle/Cursor）。"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.fetch_pending_evaluations import build_pending, enrich_idea
from scripts.parse_project_idea import parse_project_idea_body
from scripts.translate_idea_to_sql import translate_idea
from scripts.validate_sql import validate_factor_sql
from scripts.write_to_project import format_idea_body


def main() -> int:
    idea_raw = json.loads((ROOT / "ideas" / "2026-06-29.json").read_text(encoding="utf-8"))[0]
    idea_raw["title_hash"] = "local" + "b" * 61
    idea_raw["project_item_id"] = "PVTI_test"
    idea_raw["content_id"] = "DI_test"
    idea_raw["body"] = format_idea_body(idea_raw)

    parsed = parse_project_idea_body(idea_raw["body"])
    idea = {**idea_raw, **parsed}
    idea = enrich_idea(idea)

    fixture = ROOT / "tests" / "fixtures" / "example_factor_sql.json"
    with tempfile.TemporaryDirectory() as tmp:
        factor_sql_path = Path(tmp) / "factor_sql.json"
        out = translate_idea(idea, factor_sql_override=fixture)
        factor_sql_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        validate_factor_sql(out)

    pending = build_pending([idea_raw], evaluations_dir=ROOT / "evaluations", force=True)
    assert len(pending) == 1, "pending 列表应包含 1 条"

    print("编排层 E2E OK")
    print(json.dumps({"title": idea["title"], "evaluation_type": out["evaluation_type"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
