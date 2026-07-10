"""GitHub Project 想法导入共用工具。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import requests

from scripts.github_graphql import get_github_token, graphql_request
from scripts.parse_project_idea import (
    infer_evaluation_type,
    load_factor_sql_from_evaluations,
    parse_factor_sql_from_body,
    parse_project_idea_body,
)

WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0"
DEFAULT_PROJECT_ID = "PVT_kwHOCuXpt84Bb4qu"
DEFAULT_API_BASE = "https://quant-factors-dashboard.pages.dev"
SOURCE_TAG = "github_project"
CACHE_DIR = REPO_ROOT / ".cache"

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
class ImportStats:
    fetched: int = 0
    ready: int = 0
    sql_from_body: int = 0
    sql_from_eval_file: int = 0
    skipped_no_sql: int = 0
    import_created: int = 0
    import_skipped: int = 0
    translated: int = 0
    errors: list[str] = field(default_factory=list)


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


def load_repo_env() -> None:
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(REPO_ROOT / "workers" / "factor-ideas" / ".dev.vars")


def normalize_title_python(title: str) -> str:
    lowered = title.lower()
    return re.sub(r"[\s\W_]+", "", lowered, flags=re.UNICODE)


def normalize_title_worker(title: str) -> str:
    return re.sub(r"[\s\W_]+", "", title.lower(), flags=re.ASCII)


def title_hash(title: str) -> str:
    return hashlib.sha256(normalize_title_python(title).encode("utf-8")).hexdigest()


def worker_import_title(title: str) -> str:
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


def ensure_github_token() -> str:
    try:
        return get_github_token()
    except RuntimeError:
        token = os.popen("gh auth token 2>/dev/null").read().strip()
        if not token:
            raise RuntimeError("需要 GITHUB_TOKEN/GH_TOKEN 或 gh auth login") from None
        os.environ["GITHUB_TOKEN"] = token
        return token


def project_cache_path(project_id: str, cache_path: Path | None = None) -> Path:
    if cache_path is not None:
        return cache_path
    env_path = os.environ.get("GITHUB_PROJECT_CACHE", "").strip()
    if env_path:
        return Path(env_path)
    short = hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:12]
    return CACHE_DIR / f"github-project-{short}.json"


def save_project_items_cache(cache_file: Path, project_id: str, items: list[dict[str, str]]) -> None:
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "project_id": project_id,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "count": len(items),
        "items": items,
    }
    cache_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_project_items_cache(cache_file: Path, project_id: str) -> list[dict[str, str]]:
    if not cache_file.is_file():
        raise FileNotFoundError(f"缓存不存在: {cache_file}")
    payload = json.loads(cache_file.read_text(encoding="utf-8"))
    if payload.get("project_id") != project_id:
        raise ValueError(
            f"缓存 project_id 不匹配: 期望 {project_id}, 实际 {payload.get('project_id')}"
        )
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError(f"缓存格式错误: {cache_file}")
    return items


def load_project_items(
    project_id: str,
    *,
    cache_path: Path | None = None,
    refresh: bool = False,
) -> tuple[list[dict[str, str]], str]:
    """加载 Project 条目：默认读本地缓存，--refresh 时重新拉取并更新缓存。"""
    cache_file = project_cache_path(project_id, cache_path)
    if refresh or not cache_file.is_file():
        token = ensure_github_token()
        print(f"从 GitHub 拉取 Project {project_id} ...", flush=True)
        items = fetch_project_items(project_id, token)
        save_project_items_cache(cache_file, project_id, items)
        print(f"已缓存 {len(items)} 条 -> {cache_file}", flush=True)
        return items, "remote"

    items = load_project_items_cache(cache_file, project_id)
    fetched_at = ""
    try:
        meta = json.loads(cache_file.read_text(encoding="utf-8"))
        fetched_at = str(meta.get("fetched_at") or "")
    except json.JSONDecodeError:
        pass
    when = f"（{fetched_at}）" if fetched_at else ""
    print(f"使用本地缓存 {cache_file}，共 {len(items)} 条{when}", flush=True)
    return items, "cache"


def add_project_cache_args(parser) -> None:
    parser.add_argument(
        "--cache",
        type=Path,
        help="Project 缓存文件路径（默认 .cache/github-project-<id>.json）",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="强制从 GitHub 重新拉取并更新缓存",
    )


def translate_progress_path(project_id: str) -> Path:
    short = hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:12]
    return CACHE_DIR / f"github-project-translate-progress-{short}.json"


def load_translate_progress(project_id: str) -> set[str]:
    path = translate_progress_path(project_id)
    if not path.is_file():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return set()
    if payload.get("project_id") != project_id:
        return set()
    hashes = payload.get("completed_title_hashes")
    if not isinstance(hashes, list):
        return set()
    return {str(value) for value in hashes if value}


def mark_translate_progress(project_id: str, item: dict[str, str]) -> None:
    path = translate_progress_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "project_id": project_id,
        "completed_title_hashes": [],
        "entries": [],
    }
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and existing.get("project_id") == project_id:
                payload = existing
        except json.JSONDecodeError:
            pass
    hashes = payload.get("completed_title_hashes")
    if not isinstance(hashes, list):
        hashes = []
    entries = payload.get("entries")
    if not isinstance(entries, list):
        entries = []
    title_hash_value = item["title_hash"]
    if title_hash_value not in hashes:
        hashes.append(title_hash_value)
    entries.append(
        {
            "title_hash": title_hash_value,
            "title": item["title"],
            "imported_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    payload["completed_title_hashes"] = hashes
    payload["entries"] = entries[-2000:]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


def resolve_factor_sql(item: dict[str, str], stats: ImportStats) -> dict[str, Any] | None:
    factor_sql = parse_factor_sql_from_body(item["body"])
    if factor_sql:
        stats.sql_from_body += 1
        return factor_sql
    factor_sql = load_factor_sql_from_evaluations(item["title_hash"], REPO_ROOT)
    if factor_sql:
        stats.sql_from_eval_file += 1
        return factor_sql
    return None


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


def validate_factor_sql_basic(factor_sql: dict[str, Any], data_sources: list[str]) -> None:
    from scripts.validate_sql import validate_factor_sql

    validate_factor_sql(factor_sql)
    primary = data_sources[0]
    if str(factor_sql.get("data_source")) != str(primary):
        factor_sql["data_source"] = primary


def build_import_record(item: dict[str, str], factor_sql: dict[str, Any]) -> dict[str, Any]:
    parsed = parse_project_idea_body(item["body"])
    factor_sql = normalize_factor_sql(factor_sql, parsed["data_sources"])
    validate_factor_sql_basic(factor_sql, parsed["data_sources"])
    return {
        "title": worker_import_title(item["title"]),
        "hypothesis": parsed["hypothesis"],
        "data_sources": parsed["data_sources"],
        "formula_sketch": parsed["formula_sketch"],
        "expected_signal": parsed["expected_signal"],
        "risks": parsed["risks"],
        "evaluation_type_hint": infer_evaluation_type(
            parsed["expected_signal"],
            parsed["formula_sketch"],
        ),
        "factor_sql": factor_sql,
        "factor_expr": placeholder_factor_expr(item["title_hash"]),
    }


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


def flush_import_batch(
    batch: list[dict[str, Any]],
    stats: ImportStats,
    *,
    dry_run: bool,
    batch_no: int,
) -> None:
    if not batch:
        return
    if dry_run:
        print(f"[dry-run] 批次 {batch_no}: {len(batch)} 条", flush=True)
        stats.ready += len(batch)
        return
    result = post_import_batch(batch)
    created = int(result.get("created", 0))
    skipped = int(result.get("skipped", 0))
    stats.import_created += created
    stats.import_skipped += skipped
    for err in result.get("errors") or []:
        stats.errors.append(str(err))
    print(
        f"批次 {batch_no}: created={created} skipped={skipped}",
        flush=True,
    )
