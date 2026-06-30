#!/usr/bin/env python3
"""工作流 C：Runner 编排单条因子评估（Kaggle 确定性引擎 + 写回 Project）。"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.evaluate_engine import ENGINE_VERSION, formula_hash  # noqa: E402
from scripts.fetch_pending_evaluations import needs_evaluation  # noqa: E402
from scripts.github_graphql import get_github_token  # noqa: E402
from scripts.kaggle_kernel import (  # noqa: E402
    PLACEHOLDER_USERNAME,
    backup_file,
    download_kernel_output,
    inject_kernel_inputs_inline,
    kernel_ref,
    push_kernel,
    remove_kernel_inputs_inline,
    replace_placeholder_username,
    resolve_kaggle_username,
    restore_file,
    setup_kaggle_credentials,
    update_kernel_metadata,
    wait_for_kernel_complete,
    wait_for_kernel_logs,
)
from scripts.validate_evaluation import validate_evaluation  # noqa: E402
from scripts.write_evaluation_to_project import write_evaluation  # noqa: E402

from scripts.bundle_evaluate_kernel import build_bundled_kernel_source

DEFAULT_KERNEL_SLUG = "evaluate-factor-idea"
DEFAULT_TARGET_FILE = "futures/um/klines/1h.parquet"


@dataclass
class EvaluationRunResult:
    title_hash: str
    success: bool
    skipped: bool = False
    reason: str | None = None
    error: str | None = None
    metrics: dict[str, Any] | None = None


def setup_kaggle_for_evaluation() -> str:
    username = os.environ.get("KAGGLE_USERNAME", "").strip()
    setup_kaggle_credentials()
    return resolve_kaggle_username(username)


def _git_push_evaluation_commit(repo: Path, message: str) -> None:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("警告: 未设置 GITHUB_TOKEN，跳过 commit", file=sys.stderr)
        return

    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"],
        cwd=repo,
        check=True,
    )

    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=repo, check=False)
    if diff.returncode == 0:
        return

    subprocess.run(["git", "commit", "-m", message], cwd=repo, check=True)
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    remote = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if remote.startswith("https://github.com/"):
        auth_url = remote.replace(
            "https://github.com/",
            f"https://x-access-token:{token}@github.com/",
            1,
        )
        subprocess.run(["git", "pull", "--rebase", auth_url, branch], cwd=repo, check=False)
        subprocess.run(["git", "push", auth_url, f"HEAD:{branch}"], cwd=repo, check=True)


def git_commit_evaluation(
    repo: Path,
    title_hash: str,
    *,
    dry_run: bool,
) -> None:
    message = f"evaluate: factor evaluation {title_hash[:8]}"
    git_commit_evaluations_batch(repo, [title_hash], dry_run=dry_run, message=message)


def archive_evaluation_to_repo(
    repo: Path,
    *,
    title_hash: str,
    factor_sql: dict[str, Any],
    evaluation: dict[str, Any],
    dry_run: bool,
) -> None:
    if dry_run:
        print(f"[dry-run] archive evaluations/{title_hash}.json")
        return

    expressions_dir = repo / "expressions"
    evaluations_dir = repo / "evaluations"
    expressions_dir.mkdir(parents=True, exist_ok=True)
    evaluations_dir.mkdir(parents=True, exist_ok=True)
    expressions_dir.joinpath(f"{title_hash}.json").write_text(
        json.dumps(factor_sql, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    evaluations_dir.joinpath(f"{title_hash}.json").write_text(
        json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def git_commit_evaluations_batch(
    repo: Path,
    title_hashes: list[str],
    *,
    dry_run: bool,
    message: str | None = None,
) -> None:
    if not title_hashes:
        return

    if message is None:
        if len(title_hashes) == 1:
            message = f"evaluate: factor evaluation {title_hashes[0][:8]}"
        else:
            preview = ", ".join(title_hash[:8] for title_hash in title_hashes[:3])
            suffix = "..." if len(title_hashes) > 3 else ""
            message = f"evaluate: batch factor evaluation ({len(title_hashes)}): {preview}{suffix}"

    if dry_run:
        print(f"[dry-run] git commit -m {message!r}")
        return

    paths: list[Path] = []
    for title_hash in title_hashes:
        paths.extend(
            [
                repo / "expressions" / f"{title_hash}.json",
                repo / "evaluations" / f"{title_hash}.json",
            ]
        )
    for path in paths:
        if path.is_file():
            subprocess.run(["git", "add", str(path)], cwd=repo, check=True)

    _git_push_evaluation_commit(repo, message)


def run_kernel_once(
    *,
    repo: Path,
    kernel_dir: Path,
    username: str,
    dataset_slug: str,
    kernel_inputs: dict[str, Any],
    output_dir: Path,
    log_timeout: int,
    dry_run: bool,
) -> None:
    metadata_path = kernel_dir / "kernel-metadata.json"
    main_py = kernel_dir / "evaluate_factor_idea.py"
    metadata_backup = backup_file(metadata_path)
    main_backup = backup_file(main_py)
    kernel = kernel_ref(username, DEFAULT_KERNEL_SLUG)

    try:
        bundled = build_bundled_kernel_source(repo, main_py)
        main_py.write_text(bundled, encoding="utf-8")
        inject_kernel_inputs_inline(main_py, kernel_inputs)
        update_kernel_metadata(
            metadata_path,
            username,
            dataset_slug,
            kernel_slug=DEFAULT_KERNEL_SLUG,
        )
        replace_placeholder_username(metadata_path, username)
        push_kernel(kernel_dir, dry_run=dry_run)
        wait_for_kernel_logs(kernel, log_timeout, dry_run=dry_run)
        status = wait_for_kernel_complete(kernel, log_timeout, dry_run=dry_run)
        if status != "complete":
            raise RuntimeError(f"Kernel 未成功完成，status={status}")
        if not dry_run:
            download_kernel_output(kernel, output_dir, dry_run=False)
    finally:
        restore_file(metadata_path, metadata_backup)
        restore_file(main_py, main_backup)
        remove_kernel_inputs_inline(main_py)


def build_batch_kernel_inputs(
    jobs: list[dict[str, Any]],
    *,
    sample_start: str,
    target_file: str,
) -> dict[str, Any]:
    return {
        "batch": jobs,
        "sample_start": sample_start,
        "target_file": target_file,
        "engine_version": ENGINE_VERSION,
    }


def load_batch_kernel_output(output_dir: Path) -> list[dict[str, Any]]:
    batch_path = output_dir / "batch_evaluations.json"
    if batch_path.is_file():
        with batch_path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        evaluations = payload.get("evaluations")
        if isinstance(evaluations, list):
            return evaluations

    single_path = output_dir / "evaluation.json"
    if single_path.is_file():
        with single_path.open(encoding="utf-8") as handle:
            return [json.load(handle)]

    raise FileNotFoundError(f"缺少 Kernel 产出 {batch_path} 或 {single_path}")


@dataclass
class BatchKernelJob:
    idea: dict[str, Any]
    factor_sql: dict[str, Any]


@dataclass
class BatchKernelItemResult:
    idea: dict[str, Any]
    factor_sql: dict[str, Any]
    evaluation: dict[str, Any] | None = None
    error: str | None = None
    skipped: bool = False
    skip_reason: str | None = None


def run_batch_kernel_evaluation(
    jobs: list[BatchKernelJob],
    *,
    repo: Path = REPO_ROOT,
    sample_start: str = "2023-01-01",
    target_file: str = DEFAULT_TARGET_FILE,
    output_dir: Path,
    log_timeout: int,
    dry_run: bool = False,
    force: bool = False,
    username: str | None = None,
) -> list[BatchKernelItemResult]:
    if not jobs:
        return []

    kernel_dir = repo / "explorations" / "evaluate-factor-idea"
    evaluations_dir = repo / "evaluations"
    runnable_jobs: list[BatchKernelJob] = []
    results: list[BatchKernelItemResult] = []

    for job in jobs:
        should_run, reason = needs_evaluation(
            job.idea,
            evaluations_dir=evaluations_dir,
            force=force,
        )
        if should_run:
            runnable_jobs.append(job)
            continue
        print(f"跳过已验证想法: {job.idea['title']} ({reason})")
        results.append(
            BatchKernelItemResult(
                idea=job.idea,
                factor_sql=job.factor_sql,
                skipped=True,
                skip_reason=reason,
            )
        )

    if not runnable_jobs:
        return results

    batch_payload = build_batch_kernel_inputs(
        [{"idea": job.idea, "factor_sql": job.factor_sql} for job in runnable_jobs],
        sample_start=sample_start,
        target_file=target_file,
    )
    dataset_slug = (
        runnable_jobs[0].factor_sql.get("data_source") or runnable_jobs[0].idea["data_sources"][0]
    )

    resolved_username = username
    if not dry_run and resolved_username is None:
        resolved_username = setup_kaggle_for_evaluation()

    try:
        run_kernel_once(
            repo=repo,
            kernel_dir=kernel_dir,
            username=resolved_username or PLACEHOLDER_USERNAME,
            dataset_slug=dataset_slug,
            kernel_inputs=batch_payload,
            output_dir=output_dir,
            log_timeout=log_timeout,
            dry_run=dry_run,
        )
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        for job in runnable_jobs:
            results.append(
                BatchKernelItemResult(
                    idea=job.idea,
                    factor_sql=job.factor_sql,
                    error=f"Kernel 运行失败: {exc}",
                )
            )
        return results

    if dry_run:
        for job in runnable_jobs:
            results.append(BatchKernelItemResult(idea=job.idea, factor_sql=job.factor_sql))
        return results

    evaluations = load_batch_kernel_output(output_dir)
    evaluation_by_hash = {
        item.get("title_hash"): item for item in evaluations if item.get("title_hash")
    }

    for job in runnable_jobs:
        title_hash = job.idea["title_hash"]
        evaluation = evaluation_by_hash.get(title_hash)
        if evaluation is None:
            results.append(
                BatchKernelItemResult(
                    idea=job.idea,
                    factor_sql=job.factor_sql,
                    error=f"缺少 title_hash={title_hash} 的评估结果",
                )
            )
            continue

        if evaluation.get("status") == "failed":
            error = (evaluation.get("diagnostics") or {}).get("error", "Kernel 评估失败")
            results.append(
                BatchKernelItemResult(
                    idea=job.idea,
                    factor_sql=job.factor_sql,
                    evaluation=evaluation,
                    error=error,
                )
            )
            continue

        try:
            validate_evaluation(
                evaluation,
                expected_title_hash=title_hash,
                expected_formula_hash=job.idea.get("formula_hash")
                or formula_hash(job.idea["formula_sketch"]),
            )
        except ValueError as exc:
            results.append(
                BatchKernelItemResult(
                    idea=job.idea,
                    factor_sql=job.factor_sql,
                    evaluation=evaluation,
                    error=f"评估结果校验失败: {exc}",
                )
            )
            continue

        results.append(
            BatchKernelItemResult(
                idea=job.idea,
                factor_sql=job.factor_sql,
                evaluation=evaluation,
            )
        )

    return results


def run_factor_evaluation_for_idea(
    idea: dict[str, Any],
    factor_sql: dict[str, Any],
    *,
    repo: Path = REPO_ROOT,
    sample_start: str = "2023-01-01",
    target_file: str = DEFAULT_TARGET_FILE,
    output_dir: Path,
    log_timeout: int,
    dry_run: bool = False,
    skip_project_write: bool = False,
    skip_commit: bool = True,
    force: bool = False,
    username: str | None = None,
) -> EvaluationRunResult:
    batch_results = run_batch_kernel_evaluation(
        [BatchKernelJob(idea=idea, factor_sql=factor_sql)],
        repo=repo,
        sample_start=sample_start,
        target_file=target_file,
        output_dir=output_dir,
        log_timeout=log_timeout,
        dry_run=dry_run,
        force=force,
        username=username,
    )
    if not batch_results:
        title_hash = idea["title_hash"]
        return EvaluationRunResult(title_hash=title_hash, success=False, error="未产生评估结果")

    item = batch_results[0]
    title_hash = idea["title_hash"]
    if item.skipped:
        return EvaluationRunResult(
            title_hash=title_hash,
            success=True,
            skipped=True,
            reason=item.skip_reason,
        )
    if item.error:
        return EvaluationRunResult(title_hash=title_hash, success=False, error=item.error)

    evaluation = item.evaluation
    assert evaluation is not None

    if not skip_project_write and evaluation.get("status") in ("success", "skipped"):
        token = get_github_token()
        write_evaluation(evaluation, idea=idea, token=token, dry_run=False)

    if not skip_commit:
        archive_evaluation_to_repo(
            repo,
            title_hash=title_hash,
            factor_sql=factor_sql,
            evaluation=evaluation,
            dry_run=dry_run,
        )
        git_commit_evaluation(repo, title_hash, dry_run=dry_run)

    return EvaluationRunResult(
        title_hash=title_hash,
        success=True,
        metrics=evaluation.get("metrics"),
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="运行单条因子评估 Kaggle 流水线")
    parser.add_argument("--idea", type=Path, required=True)
    parser.add_argument("--factor-sql", type=Path, required=True)
    parser.add_argument("--sample-start", default=os.environ.get("SAMPLE_START", "2023-01-01"))
    parser.add_argument("--target-file", default=DEFAULT_TARGET_FILE)
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/factor-eval-out"))
    parser.add_argument("--log-timeout", type=int, default=int(os.environ.get("KERNEL_LOG_TIMEOUT_SECONDS", "7200")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-project-write", action="store_true")
    parser.add_argument(
        "--commit",
        action="store_true",
        help="将评估结果写入 evaluations/ 与 expressions/ 并提交 git（默认不写回仓库）",
    )
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)
    with args.factor_sql.open(encoding="utf-8") as handle:
        factor_sql = json.load(handle)

    result = run_factor_evaluation_for_idea(
        idea,
        factor_sql,
        sample_start=args.sample_start,
        target_file=args.target_file,
        output_dir=args.output_dir,
        log_timeout=args.log_timeout,
        dry_run=args.dry_run,
        skip_project_write=args.skip_project_write,
        skip_commit=not args.commit,
        force=args.force,
    )

    if result.skipped:
        return 0
    if not result.success:
        print(f"错误: {result.error}", file=sys.stderr)
        return 1

    if result.metrics is not None:
        print(json.dumps(result.metrics, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
