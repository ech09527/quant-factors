"""识别待评估的因子想法（Project 条目 − 已验证 evaluations）。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.evaluate_engine import ENGINE_VERSION, formula_hash
from scripts.parse_project_idea import infer_evaluation_type, parse_project_idea_body
from scripts.write_evaluation_to_project import EVAL_SECTION_HEADER

FORMULA_HASH_PATTERN = re.compile(r"\*\*formula_hash\*\*：`([^`]+)`")
ENGINE_VERSION_PATTERN = re.compile(r"\| 引擎版本 \| ([^|]+) \|")
SKIPPED_STATUS_PATTERN = re.compile(r"\*\*状态\*\*：skipped（([^）)]+)）")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_evaluation(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def parse_evaluation_from_body(body: str) -> dict[str, Any] | None:
    """从 Project Draft Issue body 的「评估结果」章节解析已写入的评估摘要。"""
    if EVAL_SECTION_HEADER not in body:
        return None

    section = body.split(EVAL_SECTION_HEADER, 1)[1]
    formula_match = FORMULA_HASH_PATTERN.search(section)
    if not formula_match:
        return None

    parsed: dict[str, Any] = {"formula_hash": formula_match.group(1).strip()}

    skipped_match = SKIPPED_STATUS_PATTERN.search(section)
    if skipped_match:
        parsed["status"] = "skipped"
        parsed["skipped_reason"] = skipped_match.group(1)
        return parsed

    engine_match = ENGINE_VERSION_PATTERN.search(section)
    if engine_match:
        parsed["engine_version"] = engine_match.group(1).strip()

    if "| Mean IC |" in section:
        parsed["status"] = "success"
        return parsed

    return None


def load_previous_evaluation(
    idea: dict[str, Any],
    *,
    evaluations_dir: Path,
) -> dict[str, Any] | None:
    body_eval = parse_evaluation_from_body(idea.get("body", ""))
    if body_eval is not None:
        return body_eval

    eval_path = evaluations_dir / f"{idea['title_hash']}.json"
    return load_evaluation(eval_path)


def needs_evaluation(
    idea: dict[str, Any],
    *,
    evaluations_dir: Path,
    force: bool = False,
) -> tuple[bool, str]:
    if force:
        return True, "force"

    prev = load_previous_evaluation(idea, evaluations_dir=evaluations_dir)
    if prev is None:
        return True, "never_evaluated"

    current_fh = idea.get("formula_hash") or formula_hash(idea["formula_sketch"])
    if prev.get("formula_hash") != current_fh:
        return True, "formula_changed"

    if prev.get("engine_version") != ENGINE_VERSION:
        return True, "engine_upgraded"

    status = prev.get("status")
    if status == "success":
        return False, "already_validated"
    if status == "skipped":
        return False, "skipped"
    return True, f"retry_after_{status}"


def enrich_idea(raw: dict[str, Any]) -> dict[str, Any]:
    parsed = parse_project_idea_body(raw["body"])
    idea = {
        "title": raw["title"],
        "title_hash": raw["title_hash"],
        "project_item_id": raw.get("project_item_id"),
        "content_id": raw.get("content_id"),
        "body": raw.get("body") or "",
        **parsed,
    }
    idea["formula_hash"] = formula_hash(idea["formula_sketch"])
    idea["evaluation_type_hint"] = infer_evaluation_type(
        idea["expected_signal"],
        idea["formula_sketch"],
    )
    return idea


def build_pending(
    all_ideas: list[dict[str, Any]],
    *,
    evaluations_dir: Path,
    force: bool = False,
) -> list[dict[str, Any]]:
    pending: list[dict[str, Any]] = []
    for raw in all_ideas:
        try:
            idea = enrich_idea(raw)
        except ValueError as exc:
            print(f"跳过无法解析的想法 «{raw.get('title')}»: {exc}", file=sys.stderr)
            continue
        should_run, reason = needs_evaluation(
            idea,
            evaluations_dir=evaluations_dir,
            force=force,
        )
        if should_run:
            idea["pending_reason"] = reason
            pending.append(idea)
    return pending


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="输出待评估因子想法列表")
    parser.add_argument("--ideas", type=Path, required=True, help="fetch_existing_ideas 输出")
    parser.add_argument(
        "--evaluations-dir",
        type=Path,
        default=repo_root() / "evaluations",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("-o", "--output", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    with args.ideas.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    ideas = payload.get("ideas") if isinstance(payload, dict) else payload
    if not isinstance(ideas, list):
        print("错误: ideas 输入格式无效", file=sys.stderr)
        return 1

    pending = build_pending(ideas, evaluations_dir=args.evaluations_dir, force=args.force)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps({"pending": pending, "count": len(pending)}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"待评估 {len(pending)} 条 → {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
