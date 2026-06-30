"""将因子评估结果写回 GitHub Project Draft Issue body。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.github_graphql import get_github_token, graphql_request
from scripts.write_to_project import format_idea_body

UPDATE_DRAFT_ISSUE_MUTATION = """
mutation($draftIssueId: ID!, $body: String!) {
  updateProjectV2DraftIssue(input: {
    draftIssueId: $draftIssueId
    body: $body
  }) {
    draftIssue {
      id
      body
    }
  }
}
"""

EVAL_SECTION_HEADER = "## 评估结果"


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def format_metrics_table(evaluation: dict[str, Any]) -> str:
    metrics = evaluation.get("metrics") or {}
    status = evaluation.get("status")

    if status == "skipped":
        reason = evaluation.get("skipped_reason", "unknown")
        return "\n".join(
            [
                EVAL_SECTION_HEADER,
                "",
                f"**状态**：skipped（{reason}）",
                "",
                f"- **评估时间**：{evaluation.get('evaluated_at')}",
                f"- **formula_hash**：`{evaluation.get('formula_hash')}`",
            ]
        )

    def fmt_num(value: Any) -> str:
        if value is None:
            return "N/A"
        if isinstance(value, float):
            return f"{value:.4f}"
        return str(value)

    return "\n".join(
        [
            EVAL_SECTION_HEADER,
            "",
            "| 指标 | 值 |",
            "|------|-----|",
            f"| Mean IC | {fmt_num(metrics.get('mean_ic'))} |",
            f"| IC IR | {fmt_num(metrics.get('ic_ir'))} |",
            f"| Mean Rank IC | {fmt_num(metrics.get('mean_rank_ic'))} |",
            f"| Rank IC IR | {fmt_num(metrics.get('rank_ic_ir'))} |",
            f"| 评估期数 | {metrics.get('n_periods', 0):,} |",
            f"| 引擎版本 | {evaluation.get('engine_version')} |",
            "",
            f"- **评估时间**：{evaluation.get('evaluated_at')}",
            f"- **formula_hash**：`{evaluation.get('formula_hash')}`",
            "",
            "<details>",
            "<summary>因子 SQL</summary>",
            "",
            "```json",
            json.dumps(evaluation.get("factor_sql"), ensure_ascii=False, indent=2),
            "```",
            "",
            "</details>",
        ]
    )


def merge_evaluation_section(original_body: str, evaluation: dict[str, Any]) -> str:
    section = format_metrics_table(evaluation)
    if EVAL_SECTION_HEADER in original_body:
        prefix = original_body.split(EVAL_SECTION_HEADER, 1)[0].rstrip()
        return f"{prefix}\n\n{section}\n"
    return f"{original_body.rstrip()}\n\n{section}\n"


def update_draft_issue_body(content_id: str, body: str, token: str) -> None:
    graphql_request(
        token,
        UPDATE_DRAFT_ISSUE_MUTATION,
        {"draftIssueId": content_id, "body": body},
    )


def write_evaluation(
    evaluation: dict[str, Any],
    *,
    idea: dict[str, Any],
    token: str,
    dry_run: bool = False,
) -> dict[str, Any]:
    content_id = idea.get("content_id")
    if not content_id:
        raise ValueError("idea 缺少 content_id，请重新 fetch_existing_ideas")

    base_body = format_idea_body(idea)
    merged = merge_evaluation_section(base_body, evaluation)

    if dry_run:
        return {"content_id": content_id, "dry_run": True, "body_chars": len(merged)}

    update_draft_issue_body(content_id, merged, token)
    return {"content_id": content_id, "updated": True}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="写回评估结果到 GitHub Project")
    parser.add_argument("--evaluation", type=Path, required=True)
    parser.add_argument("--idea", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    with args.evaluation.open(encoding="utf-8") as handle:
        evaluation = json.load(handle)
    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)

    try:
        token = "" if args.dry_run else get_github_token()
        result = write_evaluation(evaluation, idea=idea, token=token, dry_run=args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (RuntimeError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
