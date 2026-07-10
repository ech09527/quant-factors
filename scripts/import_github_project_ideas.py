#!/usr/bin/env python3
"""临时脚本：从 GitHub Project 解析、翻译（如需）、导入 D1。

用法:
  uv run python scripts/import_github_project_ideas.py --dry-run --limit 5
  uv run python scripts/import_github_project_ideas.py --limit 20
  uv run python scripts/import_github_project_ideas.py

环境变量（仓库根 .env）:
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL  — LLM 翻译
  AUTH_PASSWORD 或 FACTOR_API_TOKEN              — API 鉴权
  FACTOR_API_BASE_URL                            — 默认 https://quant-factors-dashboard.pages.dev
  GITHUB_PROJECT_ID                              — 默认 Quant Factor Ideas
  GITHUB_TOKEN / GH_TOKEN                        — GitHub API（或 gh auth token）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import requests

from scripts.github_graphql import get_github_token, graphql_request
from scripts.parse_project_idea import (
    infer_evaluation_type,
    load_factor_sql_from_evaluations,
    parse_factor_sql_from_body,
    parse_project_idea_body,
)
from scripts.validation_profiles import DEFAULT_PROFILE_KEY

WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0"
DEFAULT_PROJECT_ID = "PVT_kwHOCuXpt84Bb4qu"
DEFAULT_API_BASE = "https://quant-factors-dashboard.pages.dev"
SOURCE_TAG = "github_project"

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
              id
              title
              body
            }
            ... on Issue {
              id
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


@dataclass
class RunStats:
    fetched: int = 0
    parsed: int = 0
    sql_from_body: int = 0
    sql_from_eval_file: int = 0
    translated: int = 0
    import_created: int = 0
    import_skipped: int = 0
    errors: list[str] = field(default_factory=list)
    skipped_no_sql: int = 0


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, _, value = text.partition("=")
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def normalize_title_python(title: str) -> str:
    lowered = title.lower()
    return re.sub(r"[\s\W_]+", "", lowered, flags=re.UNICODE)


def normalize_title_worker(title: str) -> str:
    """与 workers/factor-ideas normalizeTitle 一致（仅保留 ASCII 字母数字）。"""
    return re.sub(r"[\s\W_]+", "", title.lower(), flags=re.ASCII)


def title_hash(title: str) -> str:
    return hashlib.sha256(normalize_title_python(title).encode("utf-8")).hexdigest()


def worker_import_title(title: str) -> str:
    """Worker 对纯中文标题会得到空 title_hash；追加 ASCII 后缀保证去重唯一。"""
    if normalize_title_worker(title):
        return title
    suffix = f"ghproj{title_hash(title)[:16]}"
    return f"{title} {suffix}"


def placeholder_factor_expr(hash_value: str) -> str:
    jitter = int(hash_value[:12], 16) / 1e18
    if jitter <= 0:
        jitter = 1e-12
    return f"CSRank(Add($close, {jitter:.18f}))"


def api_base() -> str:
    value = os.environ.get("FACTOR_API_BASE_URL", DEFAULT_API_BASE).strip().rstrip("/")
    if not value:
        raise RuntimeError("缺少 FACTOR_API_BASE_URL")
    return value


def api_token() -> str:
    for key in ("AUTH_PASSWORD", "FACTOR_API_TOKEN"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    raise RuntimeError("缺少 AUTH_PASSWORD 或 FACTOR_API_TOKEN")


def fetch_project_items(project_id: str, token: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
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

        page = project["items"]
        for node in page["nodes"]:
            content = node.get("content")
            if not content:
                continue
            title = (content.get("title") or "").strip()
            if not title:
                continue
            items.append(
                {
                    "title": title,
                    "body": content.get("body") or "",
                    "title_hash": title_hash(title),
                    "project_item_id": node["id"],
                }
            )

        page_info = page["pageInfo"]
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]
    return items


def load_translation_assets() -> tuple[str, dict[str, Any]]:
    template_path = REPO_ROOT / "workers" / "factor-ideas" / "assets" / "translate-idea-to-sql.txt"
    schema_path = REPO_ROOT / "workers" / "factor-ideas" / "assets" / "factor-sql-schema.json"
    template = template_path.read_text(encoding="utf-8")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    return template, schema


def build_translation_prompt(
    template: str,
    schema: dict[str, Any],
    idea: dict[str, Any],
    profile_key: str,
    feedback: str = "",
) -> str:
    parts = [
        template,
        "",
        "## factor-sql-schema.json",
        json.dumps(schema, ensure_ascii=False, indent=2),
        "",
        "## 本次验证目标",
        json.dumps({"validation_profile_key": profile_key}, ensure_ascii=False, indent=2),
        "",
        "## 因子想法",
        json.dumps(
            {
                "title": idea["title"],
                "hypothesis": idea["hypothesis"],
                "formula_sketch": idea["formula_sketch"],
                "expected_signal": idea["expected_signal"],
                "evaluation_type_hint": idea.get("evaluation_type_hint"),
                "data_sources": idea["data_sources"],
            },
            ensure_ascii=False,
            indent=2,
        ),
    ]
    if feedback:
        parts.extend(["", "## 上次校验/执行失败（必须修正 signal_sql）", feedback])
    return "\n".join(parts)


def extract_json_object(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    if trimmed.startswith("{"):
        payload = json.loads(trimmed)
    else:
        match = re.search(r"\{[\s\S]*\}", trimmed)
        if not match:
            raise ValueError("模型输出中未找到 JSON 对象")
        payload = json.loads(match.group(0))
    if not isinstance(payload, dict):
        raise ValueError("模型输出不是 JSON 对象")
    return payload


def call_openai_chat(prompt: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("缺少 OPENAI_API_KEY")

    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()

    response = requests.post(
        f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": WORKFLOW_HTTP_USER_AGENT,
        },
        json={
            "model": model,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": "你是量化因子 SQL 翻译器，只输出合法 JSON 对象。",
                },
                {"role": "user", "content": prompt},
            ],
        },
        timeout=180,
    )
    response.raise_for_status()
    body = response.json()
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError(f"OpenAI 响应无 choices: {body}")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("OpenAI 响应 content 为空")
    return content


def validate_factor_sql_basic(factor_sql: dict[str, Any], data_sources: list[str]) -> None:
    from scripts.validate_sql import validate_factor_sql

    validate_factor_sql(factor_sql)
    primary = data_sources[0]
    if str(factor_sql.get("data_source")) != str(primary):
        factor_sql["data_source"] = primary


def translate_idea_to_factor_sql(
    idea: dict[str, Any],
    profile_key: str,
    *,
    max_attempts: int = 3,
) -> dict[str, Any]:
    template, schema = load_translation_assets()
    feedback = ""
    last_error: Exception | None = None
    for _attempt in range(1, max_attempts + 1):
        try:
            prompt = build_translation_prompt(template, schema, idea, profile_key, feedback)
            raw = call_openai_chat(prompt)
            factor_sql = extract_json_object(raw)
            validate_factor_sql_basic(factor_sql, idea["data_sources"])
            return factor_sql
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            feedback = str(exc)
    raise RuntimeError(
        f"翻译失败: {last_error}" if last_error else "翻译失败"
    )


def normalize_factor_sql(
    factor_sql: dict[str, Any],
    data_sources: list[str],
) -> dict[str, Any]:
    normalized = dict(factor_sql)
    normalized["data_source"] = data_sources[0]
    if "version" not in normalized:
        normalized["version"] = "1"
    if "dialect" not in normalized:
        normalized["dialect"] = "duckdb-factor-v1"
    return normalized


def build_import_record(
    item: dict[str, str],
    *,
    skip_translate: bool,
    profile_key: str,
    stats: RunStats,
) -> dict[str, Any] | None:
    parsed = parse_project_idea_body(item["body"])
    idea: dict[str, Any] = {
        "title": item["title"],
        **parsed,
        "evaluation_type_hint": infer_evaluation_type(
            parsed["expected_signal"],
            parsed["formula_sketch"],
        ),
    }

    factor_sql = parse_factor_sql_from_body(item["body"])
    if factor_sql:
        stats.sql_from_body += 1
    else:
        factor_sql = load_factor_sql_from_evaluations(item["title_hash"], REPO_ROOT)
        if factor_sql:
            stats.sql_from_eval_file += 1

    if factor_sql is None:
        if skip_translate:
            stats.skipped_no_sql += 1
            return None
        print(f"  → 串行翻译: {item['title']}", flush=True)
        factor_sql = translate_idea_to_factor_sql(idea, profile_key)
        stats.translated += 1

    factor_sql = normalize_factor_sql(factor_sql, idea["data_sources"])
    try:
        validate_factor_sql_basic(factor_sql, idea["data_sources"])
    except Exception as exc:  # noqa: BLE001
        if skip_translate:
            stats.skipped_no_sql += 1
            stats.errors.append(f"{item['title']}: factor_sql 校验失败: {exc}")
            return None
        print(f"  → 串行重译: {item['title']}", flush=True)
        factor_sql = translate_idea_to_factor_sql(idea, profile_key)
        stats.translated += 1
        factor_sql = normalize_factor_sql(factor_sql, idea["data_sources"])
        validate_factor_sql_basic(factor_sql, idea["data_sources"])

    idea["factor_sql"] = factor_sql
    idea["factor_expr"] = placeholder_factor_expr(item["title_hash"])
    idea["title"] = worker_import_title(item["title"])
    stats.parsed += 1
    return idea


def post_import_batch(ideas: list[dict[str, Any]]) -> dict[str, Any]:
    url = f"{api_base()}/api/ideas"
    response = requests.post(
        url,
        json={"source": SOURCE_TAG, "ideas": ideas},
        headers={
            "Authorization": f"Bearer {api_token()}",
            "User-Agent": WORKFLOW_HTTP_USER_AGENT,
        },
        timeout=120,
    )
    if not response.ok:
        raise RuntimeError(f"HTTP {response.status_code}: {response.text}")
    return response.json()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从 GitHub Project 导入因子想法到 D1")
    parser.add_argument(
        "--project-id",
        default=os.environ.get("GITHUB_PROJECT_ID", DEFAULT_PROJECT_ID),
        help=f"GitHub Project node ID（默认 {DEFAULT_PROJECT_ID}）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只解析/翻译，不写入 API")
    parser.add_argument("--limit", type=int, default=0, help="最多处理 N 条（0=全部）")
    parser.add_argument(
        "--skip-translate",
        action="store_true",
        help="跳过无 factor_sql 的条目（不调用 LLM）",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=10,
        help="每批 POST 条数（默认 10）",
    )
    parser.add_argument(
        "--profile-key",
        default=DEFAULT_PROFILE_KEY,
        help=f"翻译时使用的 validation profile（默认 {DEFAULT_PROFILE_KEY}）",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="将 dry-run 结果或导入摘要写入 JSON 文件",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.5,
        help="批间休眠秒数，避免 LLM/API 限流",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(REPO_ROOT / "workers" / "factor-ideas" / ".dev.vars")

    if not args.dry_run:
        _ = api_token()

    try:
        gh_token = get_github_token()
    except RuntimeError:
        try:
            gh_token = os.popen("gh auth token 2>/dev/null").read().strip()
        except OSError:
            gh_token = ""
        if not gh_token:
            print("错误: 需要 GITHUB_TOKEN/GH_TOKEN 或 gh auth login", file=sys.stderr)
            return 1
        os.environ["GITHUB_TOKEN"] = gh_token

    print(f"拉取 Project {args.project_id} ...")
    items = fetch_project_items(args.project_id, get_github_token())
    if args.limit > 0:
        items = items[: args.limit]
    print(f"共 {len(items)} 条待处理")

    stats = RunStats(fetched=len(items))
    prepared: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        try:
            record = build_import_record(
                item,
                skip_translate=args.skip_translate,
                profile_key=args.profile_key,
                stats=stats,
            )
            if record:
                prepared.append(record)
                print(f"[{index}/{len(items)}] 就绪: {item['title']}", flush=True)
            else:
                print(f"[{index}/{len(items)}] 跳过（无 SQL）: {item['title']}", flush=True)
        except Exception as exc:  # noqa: BLE001
            stats.errors.append(f"{item['title']}: {exc}")
            print(f"[{index}/{len(items)}] 失败: {item['title']}: {exc}", file=sys.stderr, flush=True)

    print(
        f"解析完成: 可导入 {len(prepared)}，"
        f"body SQL {stats.sql_from_body}，eval 文件 {stats.sql_from_eval_file}，"
        f"LLM 翻译 {stats.translated}，无 SQL 跳过 {stats.skipped_no_sql}"
    )

    if args.dry_run:
        preview = {
            "dry_run": True,
            "stats": stats.__dict__,
            "ideas": prepared,
        }
        if args.report:
            args.report.write_text(
                json.dumps(preview, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(f"预览已写入 {args.report}")
        else:
            print(json.dumps(preview, ensure_ascii=False, indent=2)[:4000])
        return 0 if not stats.errors else 1

    batch_size = max(1, args.batch_size)
    for start in range(0, len(prepared), batch_size):
        batch = prepared[start : start + batch_size]
        try:
            result = post_import_batch(batch)
            stats.import_created += int(result.get("created", 0))
            stats.import_skipped += int(result.get("skipped", 0))
            for err in result.get("errors") or []:
                stats.errors.append(str(err))
            print(
                f"批次 {start // batch_size + 1}: "
                f"created={result.get('created', 0)} skipped={result.get('skipped', 0)}"
            )
        except Exception as exc:  # noqa: BLE001
            stats.errors.append(f"batch@{start}: {exc}")
            print(f"批次导入失败: {exc}", file=sys.stderr)
        if start + batch_size < len(prepared):
            time.sleep(max(0.0, args.sleep))

    summary = {
        "ok": len(stats.errors) == 0,
        "stats": stats.__dict__,
        "created": stats.import_created,
        "skipped": stats.import_skipped,
    }
    if args.report:
        args.report.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"摘要已写入 {args.report}")

    print(
        f"导入完成: created={stats.import_created} skipped={stats.import_skipped} "
        f"errors={len(stats.errors)}"
    )
    if stats.errors:
        for err in stats.errors[:20]:
            print(f"  - {err}", file=sys.stderr)
        if len(stats.errors) > 20:
            print(f"  ... 另有 {len(stats.errors) - 20} 条错误", file=sys.stderr)
    return 0 if not stats.errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
