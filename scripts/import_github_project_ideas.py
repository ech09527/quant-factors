#!/usr/bin/env python3
"""导入 GitHub Project 中已有 factor_sql 的想法（评估章节或 evaluations/ 文件）。

只处理 body 内已有 SQL、或本地 evaluations/{title_hash}.json 可补全的条目；
解析一批即 POST 一批，无需等待全量完成。

用法:
  # 首次或需更新时拉取并写缓存
  uv run python scripts/import_github_project_ideas.py --refresh

  # 之后默认读 .cache/github-project-*.json，不再请求 GitHub
  AUTH_PASSWORD=... uv run python scripts/import_github_project_ideas.py

需 LLM 翻译的条目请用 scripts/import_github_project_ideas_translate.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.github_project_import_common import (
    DEFAULT_PROJECT_ID,
    ImportStats,
    add_project_cache_args,
    build_import_record,
    flush_import_batch,
    load_project_items,
    load_repo_env,
    resolve_factor_sql,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="导入 GitHub Project 中已有 factor_sql 的因子想法"
    )
    parser.add_argument(
        "--project-id",
        default=os.environ.get("GITHUB_PROJECT_ID", DEFAULT_PROJECT_ID),
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--sleep", type=float, default=0.3)
    add_project_cache_args(parser)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    load_repo_env()
    if not args.dry_run:
        from scripts.github_project_import_common import api_token

        _ = api_token()

    items, _source = load_project_items(
        args.project_id,
        cache_path=args.cache,
        refresh=args.refresh,
    )
    if args.limit > 0:
        items = items[: args.limit]
    print(f"共 {len(items)} 条，仅导入已有 factor_sql 的条目", flush=True)

    stats = ImportStats(fetched=len(items))
    batch: list[dict] = []
    batch_no = 0
    batch_size = max(1, args.batch_size)

    for index, item in enumerate(items, start=1):
        factor_sql = resolve_factor_sql(item, stats)
        if factor_sql is None:
            stats.skipped_no_sql += 1
            print(f"[{index}/{len(items)}] 跳过（无 SQL）: {item['title']}", flush=True)
            continue
        try:
            record = build_import_record(item, factor_sql)
            batch.append(record)
            stats.ready += 1
            print(f"[{index}/{len(items)}] 就绪: {item['title']}", flush=True)
        except Exception as exc:  # noqa: BLE001
            stats.errors.append(f"{item['title']}: {exc}")
            print(f"[{index}/{len(items)}] 失败: {item['title']}: {exc}", file=sys.stderr, flush=True)
            continue

        if len(batch) >= batch_size:
            batch_no += 1
            flush_import_batch(batch, stats, dry_run=args.dry_run, batch_no=batch_no)
            batch = []
            if not args.dry_run and args.sleep > 0:
                time.sleep(args.sleep)

    if batch:
        batch_no += 1
        flush_import_batch(batch, stats, dry_run=args.dry_run, batch_no=batch_no)

    summary = {
        "mode": "ready_sql_only",
        "ok": len(stats.errors) == 0,
        "stats": stats.__dict__,
    }
    print(
        f"完成: ready={stats.ready} created={stats.import_created} "
        f"skipped_api={stats.import_skipped} no_sql={stats.skipped_no_sql} "
        f"errors={len(stats.errors)}",
        flush=True,
    )
    if args.report:
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"摘要已写入 {args.report}", flush=True)
    if stats.errors:
        for err in stats.errors[:20]:
            print(f"  - {err}", file=sys.stderr)
    return 0 if not stats.errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
