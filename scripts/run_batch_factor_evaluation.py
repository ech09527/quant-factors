#!/usr/bin/env python3
"""工作流 C：批量评估待验证因子想法（并行 Cursor + 单次 Kaggle 批量计算）。"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.fetch_pending_evaluations import build_pending  # noqa: E402
from scripts.github_graphql import get_github_token  # noqa: E402
from scripts.run_factor_evaluation import (  # noqa: E402
    BatchKernelJob,
    run_batch_kernel_evaluation,
    setup_kaggle_for_evaluation,
)
from scripts.translate_idea_to_sql import resolve_agent_binary, translate_idea  # noqa: E402
from scripts.write_evaluation_to_project import write_evaluation  # noqa: E402


@dataclass
class BatchItemResult:
    title: str
    title_hash: str
    status: str
    error: str | None = None
    pending_reason: str | None = None


@dataclass
class TranslationResult:
    idea: dict[str, Any]
    factor_sql: dict[str, Any] | None = None
    error: str | None = None


def load_pending_from_file(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    pending = payload.get("pending")
    if not isinstance(pending, list):
        raise ValueError("pending 输入格式无效，缺少 pending 数组")
    return pending


def select_pending(
    *,
    pending_file: Path | None,
    ideas_file: Path | None,
    evaluations_dir: Path,
    force: bool,
    max_ideas: int | None,
) -> list[dict[str, Any]]:
    if pending_file is not None:
        pending = load_pending_from_file(pending_file)
    elif ideas_file is not None:
        with ideas_file.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        ideas = payload.get("ideas") if isinstance(payload, dict) else payload
        if not isinstance(ideas, list):
            raise ValueError("ideas 输入格式无效")
        pending = build_pending(ideas, evaluations_dir=evaluations_dir, force=force)
    else:
        raise ValueError("必须提供 --pending 或 --ideas")

    if max_ideas is not None and max_ideas > 0:
        pending = pending[:max_ideas]
    return pending


def translate_one_idea(
    idea: dict[str, Any],
    *,
    sample_start: str,
) -> TranslationResult:
    title = idea["title"]
    title_hash = idea["title_hash"]
    try:
        factor_sql = translate_idea(
            idea,
            with_local_eval=True,
            sample_start=sample_start,
        )
        print(f"翻译成功: {title} ({title_hash})")
        return TranslationResult(idea=idea, factor_sql=factor_sql)
    except (RuntimeError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        error = f"翻译 SQL 失败: {exc}"
        print(f"::warning::{title} ({title_hash}): {error}", file=sys.stderr)
        return TranslationResult(idea=idea, error=error)


def translate_pending_parallel(
    pending: list[dict[str, Any]],
    *,
    sample_start: str,
    cursor_workers: int,
) -> tuple[list[TranslationResult], list[BatchItemResult]]:
    if not pending:
        return [], []

    if cursor_workers <= 1 or len(pending) == 1:
        translations = [translate_one_idea(idea, sample_start=sample_start) for idea in pending]
        return translations, []

    translations: list[TranslationResult | None] = [None] * len(pending)
    with ThreadPoolExecutor(max_workers=cursor_workers) as executor:
        future_map = {
            executor.submit(translate_one_idea, idea, sample_start=sample_start): index
            for index, idea in enumerate(pending)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            translations[index] = future.result()

    return [item for item in translations if item is not None], []


def write_batch_results_to_project(
    kernel_results: list,
    *,
    dry_run: bool,
) -> list[BatchItemResult]:
    results: list[BatchItemResult] = []
    token = "" if dry_run else get_github_token()

    for item in kernel_results:
        idea = item.idea
        title = idea["title"]
        title_hash = idea["title_hash"]
        pending_reason = idea.get("pending_reason")

        if item.skipped:
            results.append(
                BatchItemResult(
                    title=title,
                    title_hash=title_hash,
                    status="skipped",
                    pending_reason=pending_reason,
                )
            )
            print(f"跳过: {title} ({item.skip_reason})")
            continue

        if item.error:
            results.append(
                BatchItemResult(
                    title=title,
                    title_hash=title_hash,
                    status="failed",
                    error=item.error,
                    pending_reason=pending_reason,
                )
            )
            continue

        evaluation = item.evaluation
        assert evaluation is not None
        if not dry_run and evaluation.get("status") in ("success", "skipped"):
            write_evaluation(evaluation, idea=idea, token=token, dry_run=False)

        results.append(
            BatchItemResult(
                title=title,
                title_hash=title_hash,
                status="success" if evaluation.get("status") == "success" else str(evaluation.get("status")),
                pending_reason=pending_reason,
            )
        )
        print(f"已写回 Project: {title} ({title_hash})")

    return results


def evaluate_pending_batch(
    pending: list[dict[str, Any]],
    *,
    sample_start: str,
    force: bool,
    continue_on_error: bool,
    dry_run: bool,
    log_timeout: int,
    cursor_workers: int,
) -> tuple[list[BatchItemResult], list[str]]:
    if not pending:
        return [], []

    print(f"阶段 1/3: 并行 Cursor 翻译（workers={cursor_workers}）")
    try:
        resolve_agent_binary()
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        error = f"Cursor CLI 初始化失败: {exc}"
        print(f"::error::{error}", file=sys.stderr)
        for idea in pending:
            results.append(
                BatchItemResult(
                    title=idea["title"],
                    title_hash=idea["title_hash"],
                    status="failed",
                    error=error,
                    pending_reason=idea.get("pending_reason"),
                )
            )
        return results, []

    translations, _ = translate_pending_parallel(
        pending,
        sample_start=sample_start,
        cursor_workers=cursor_workers,
    )

    results: list[BatchItemResult] = []
    translated_jobs: list[BatchKernelJob] = []
    for translation in translations:
        idea = translation.idea
        if translation.error:
            results.append(
                BatchItemResult(
                    title=idea["title"],
                    title_hash=idea["title_hash"],
                    status="failed",
                    error=translation.error,
                    pending_reason=idea.get("pending_reason"),
                )
            )
            if not continue_on_error:
                return results, []
            continue
        assert translation.factor_sql is not None
        translated_jobs.append(BatchKernelJob(idea=idea, factor_sql=translation.factor_sql))

    if not translated_jobs:
        return results, []

    username: str | None = None
    if not dry_run:
        try:
            username = setup_kaggle_for_evaluation()
        except RuntimeError as exc:
            error = str(exc)
            print(f"::error::{error}", file=sys.stderr)
            for job in translated_jobs:
                results.append(
                    BatchItemResult(
                        title=job.idea["title"],
                        title_hash=job.idea["title_hash"],
                        status="failed",
                        error=error,
                        pending_reason=job.idea.get("pending_reason"),
                    )
                )
            return results, []

    print(f"阶段 2/3: 单次 Kaggle 批量评估 {len(translated_jobs)} 条")
    with tempfile.TemporaryDirectory(prefix="factor-eval-batch-") as tmp_dir:
        output_dir = Path(tmp_dir)
        kernel_results = run_batch_kernel_evaluation(
            translated_jobs,
            sample_start=sample_start,
            output_dir=output_dir,
            log_timeout=log_timeout,
            dry_run=dry_run,
            force=force,
            username=username,
        )

    print("阶段 3/3: 写回 GitHub Project")
    project_results = write_batch_results_to_project(kernel_results, dry_run=dry_run)
    results.extend(project_results)

    succeeded_hashes = [item.title_hash for item in project_results if item.status == "success"]
    return results, succeeded_hashes


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="批量运行因子评估流水线")
    parser.add_argument("--pending", type=Path, help="fetch_pending_evaluations 输出")
    parser.add_argument("--ideas", type=Path, help="fetch_existing_ideas 输出（将自动筛选 pending）")
    parser.add_argument(
        "--evaluations-dir",
        type=Path,
        default=REPO_ROOT / "evaluations",
    )
    parser.add_argument(
        "--max-ideas",
        type=int,
        default=int(os.environ.get("MAX_IDEAS", "0")) or None,
        help="最多处理条数，0 表示不限制",
    )
    parser.add_argument(
        "--cursor-workers",
        type=int,
        default=int(os.environ.get("CURSOR_WORKERS", "2")),
        help="Cursor 翻译并发数（默认 2）",
    )
    parser.add_argument("--sample-start", default=os.environ.get("SAMPLE_START", "2023-01-01"))
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--continue-on-error",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="单条失败后继续处理剩余想法（默认开启）",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--log-timeout",
        type=int,
        default=int(os.environ.get("KERNEL_LOG_TIMEOUT_SECONDS", "7200")),
    )
    parser.add_argument("-o", "--output", type=Path, help="写入批量结果 JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.pending is None and args.ideas is None:
        print("错误: 必须提供 --pending 或 --ideas", file=sys.stderr)
        return 1

    try:
        pending = select_pending(
            pending_file=args.pending,
            ideas_file=args.ideas,
            evaluations_dir=args.evaluations_dir,
            force=args.force,
            max_ideas=args.max_ideas,
        )
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    print(f"待批量评估 {len(pending)} 条")
    if not pending:
        summary = {"count": 0, "results": [], "succeeded_title_hashes": []}
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        return 0

    results, succeeded_hashes = evaluate_pending_batch(
        pending,
        sample_start=args.sample_start,
        force=args.force,
        continue_on_error=args.continue_on_error,
        dry_run=args.dry_run,
        log_timeout=args.log_timeout,
        cursor_workers=max(1, args.cursor_workers),
    )

    summary = {
        "count": len(results),
        "success": sum(1 for item in results if item.status == "success"),
        "failed": sum(1 for item in results if item.status == "failed"),
        "skipped": sum(1 for item in results if item.status == "skipped"),
        "succeeded_title_hashes": succeeded_hashes,
        "results": [asdict(item) for item in results],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
