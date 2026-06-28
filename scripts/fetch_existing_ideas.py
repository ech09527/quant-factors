"""从 GitHub Project 分页拉取已有因子想法。"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import hashlib
import json
import os
import re
from typing import Any

import requests

from scripts.github_graphql import get_github_token, graphql_request

PROJECT_ITEMS_QUERY = """
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          content {
            ... on DraftIssue {
              title
              body
            }
            ... on Issue {
              title
              body
            }
          }
        }
      }
    }
  }
}
"""


def normalize_title(title: str) -> str:
    """小写并去除空格与标点，用于标题去重。"""
    lowered = title.lower()
    return re.sub(r"[\s\W_]+", "", lowered, flags=re.UNICODE)


def title_hash(title: str) -> str:
    """对 normalize 后的标题计算 sha256 十六进制摘要。"""
    normalized = normalize_title(title)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def fetch_project_ideas(project_id: str, token: str) -> list[dict[str, str]]:
    """分页拉取 Project 中 DraftIssue/Issue 的 title 与 body。"""
    ideas: list[dict[str, str]] = []
    cursor: str | None = None

    while True:
        data = graphql_request(
            token,
            PROJECT_ITEMS_QUERY,
            {"projectId": project_id, "cursor": cursor},
        )
        project = data.get("node")
        if not project:
            raise RuntimeError(f"无法访问 Project: {project_id}")

        items = project["items"]
        for node in items["nodes"]:
            content = node.get("content")
            if not content:
                continue
            title = content.get("title") or ""
            if not title.strip():
                continue
            ideas.append(
                {
                    "title": title,
                    "body": content.get("body") or "",
                    "title_hash": title_hash(title),
                }
            )

        page_info = items["pageInfo"]
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]

    return ideas


def build_output(ideas: list[dict[str, str]]) -> dict[str, Any]:
    """组装输出 JSON 结构。"""
    title_hashes = [idea["title_hash"] for idea in ideas]
    return {"ideas": ideas, "title_hashes": title_hashes}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从 GitHub Project 拉取已有因子想法并输出 JSON"
    )
    parser.add_argument(
        "--project-id",
        default=os.environ.get("GITHUB_PROJECT_ID"),
        help="Project node ID（默认 GITHUB_PROJECT_ID 环境变量）",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="输出文件路径（默认 stdout）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.project_id:
        print("错误: 请设置 GITHUB_PROJECT_ID 或使用 --project-id", file=sys.stderr)
        return 1

    try:
        token = get_github_token()
        ideas = fetch_project_ideas(args.project_id, token)
        payload = build_output(ideas)
        text = json.dumps(payload, ensure_ascii=False, indent=2)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(text)
                f.write("\n")
        else:
            print(text)
        return 0
    except (RuntimeError, requests.HTTPError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
