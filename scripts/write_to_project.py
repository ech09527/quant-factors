"""将 Cursor 生成的因子想法写入 GitHub Project。"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import json
import os
from pathlib import Path
from typing import Any

import jsonschema
import requests

from scripts.fetch_existing_ideas import title_hash
from scripts.github_graphql import get_github_token, graphql_request

ADD_DRAFT_ISSUE_MUTATION = """
mutation($projectId: ID!, $title: String!, $body: String!) {
  addProjectV2DraftIssue(input: {
    projectId: $projectId
    title: $title
    body: $body
  }) {
    projectItem {
      id
    }
  }
}
"""


def repo_root() -> Path:
    """返回仓库根目录（scripts/ 的上级）。"""
    return Path(__file__).resolve().parent.parent


def load_schema() -> dict[str, Any]:
    """加载 idea-schema.json。"""
    schema_path = repo_root() / "schemas" / "idea-schema.json"
    with open(schema_path, encoding="utf-8") as f:
        return json.load(f)


def load_ideas(path: Path) -> list[dict[str, Any]]:
    """读取 ideas JSON 文件，支持数组或 {\"ideas\": [...]} 格式。"""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("ideas"), list):
        return data["ideas"]
    raise ValueError("输入文件须为 JSON 数组或包含 ideas 数组的对象")


def validate_ideas(ideas: list[dict[str, Any]], schema: dict[str, Any]) -> None:
    """逐条校验想法是否符合 schema。"""
    for index, idea in enumerate(ideas):
        try:
            jsonschema.validate(instance=idea, schema=schema)
        except jsonschema.ValidationError as exc:
            raise ValueError(f"第 {index + 1} 条想法校验失败: {exc.message}") from exc


def format_idea_body(idea: dict[str, Any]) -> str:
    """将想法字段格式化为 Markdown body。"""
    data_sources = idea.get("data_sources") or []
    risks = idea.get("risks") or []
    sources_md = "\n".join(f"- `{s}`" for s in data_sources)
    risks_md = "\n".join(f"- {r}" for r in risks)

    return "\n".join(
        [
            "## 假设",
            "",
            idea["hypothesis"],
            "",
            "## 数据来源",
            "",
            sources_md,
            "",
            "## 公式草稿",
            "",
            idea["formula_sketch"],
            "",
            "## 预期信号",
            "",
            idea["expected_signal"],
            "",
            "## 风险",
            "",
            risks_md,
        ]
    )


def add_draft_issue(
    project_id: str,
    token: str,
    title: str,
    body: str,
) -> str:
    """调用 addProjectV2DraftIssue，返回 projectItem id。"""
    data = graphql_request(
        token,
        ADD_DRAFT_ISSUE_MUTATION,
        {"projectId": project_id, "title": title, "body": body},
    )
    item = data["addProjectV2DraftIssue"]["projectItem"]
    return item["id"]


def write_ideas(
    ideas: list[dict[str, Any]],
    project_id: str,
    token: str,
    existing_hashes: set[str],
    dry_run: bool = False,
) -> dict[str, Any]:
    """写入新想法，跳过已存在 title_hash。"""
    created: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []

    for idea in ideas:
        th = title_hash(idea["title"])
        if th in existing_hashes:
            skipped.append({"title": idea["title"], "title_hash": th})
            continue

        body = format_idea_body(idea)
        if dry_run:
            created.append({"title": idea["title"], "title_hash": th, "dry_run": True})
        else:
            item_id = add_draft_issue(project_id, token, idea["title"], body)
            created.append(
                {"title": idea["title"], "title_hash": th, "project_item_id": item_id}
            )
        existing_hashes.add(th)

    return {"created": created, "skipped": skipped}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="校验并写入因子想法到 GitHub Project"
    )
    parser.add_argument("input", type=Path, help="Cursor 输出的 ideas JSON 文件")
    parser.add_argument(
        "--project-id",
        default=os.environ.get("GITHUB_PROJECT_ID"),
        help="Project node ID（默认 GITHUB_PROJECT_ID 环境变量）",
    )
    parser.add_argument(
        "--existing",
        type=Path,
        help="已有想法 JSON（fetch_existing_ideas 输出），用于去重",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅校验与去重，不实际写入 Project",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="写入结果 JSON 输出路径（默认 stdout）",
    )
    return parser.parse_args(argv)


def load_existing_hashes(path: Path | None) -> set[str]:
    """从已有想法文件加载 title_hash 集合。"""
    if path is None:
        return set()
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "title_hashes" in data:
        return set(data["title_hashes"])
    if isinstance(data, list):
        return {title_hash(item["title"]) for item in data if "title" in item}
    raise ValueError("已有想法文件格式无效")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.project_id:
        print("错误: 请设置 GITHUB_PROJECT_ID 或使用 --project-id", file=sys.stderr)
        return 1

    try:
        schema = load_schema()
        ideas = load_ideas(args.input)
        validate_ideas(ideas, schema)

        existing_hashes = load_existing_hashes(args.existing)
        token = get_github_token() if not args.dry_run else ""

        result = write_ideas(
            ideas,
            args.project_id,
            token,
            existing_hashes,
            dry_run=args.dry_run,
        )
        text = json.dumps(result, ensure_ascii=False, indent=2)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(text)
                f.write("\n")
        else:
            print(text)
        return 0
    except (ValueError, RuntimeError, json.JSONDecodeError, requests.HTTPError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
