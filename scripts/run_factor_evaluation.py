#!/usr/bin/env python3
"""工作流 C：Runner 编排单条因子评估（Kaggle 确定性引擎 + 写回 Project）。"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
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


def git_commit_evaluation(
    repo: Path,
    title_hash: str,
    *,
    dry_run: bool,
) -> None:
    message = f"evaluate: factor evaluation {title_hash[:8]}"
    if dry_run:
        print(f"[dry-run] git commit -m {message!r}")
        return

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
    paths = [
        repo / "expressions" / f"{title_hash}.json",
        repo / "evaluations" / f"{title_hash}.json",
    ]
    for path in paths:
        if path.is_file():
            subprocess.run(["git", "add", str(path)], cwd=repo, check=True)

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
    parser.add_argument("--skip-commit", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo = REPO_ROOT
    kernel_dir = repo / "explorations" / "evaluate-factor-idea"
    evaluations_dir = repo / "evaluations"
    expressions_dir = repo / "expressions"

    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)
    with args.factor_sql.open(encoding="utf-8") as handle:
        factor_sql = json.load(handle)

    should_run, reason = needs_evaluation(
        idea,
        evaluations_dir=evaluations_dir,
        force=args.force,
    )
    if not should_run:
        print(f"跳过已验证想法: {idea['title']} ({reason})")
        return 0

    title_hash = idea["title_hash"]
    expressions_dir.mkdir(parents=True, exist_ok=True)
    evaluations_dir.mkdir(parents=True, exist_ok=True)
    expressions_dir.joinpath(f"{title_hash}.json").write_text(
        json.dumps(factor_sql, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    dataset_slug = factor_sql.get("data_source") or idea["data_sources"][0]
    kernel_inputs = {
        "idea": idea,
        "factor_sql": factor_sql,
        "sample_start": args.sample_start,
        "target_file": args.target_file,
        "engine_version": ENGINE_VERSION,
    }

    username = os.environ.get("KAGGLE_USERNAME", "").strip()
    if not args.dry_run:
        try:
            setup_kaggle_credentials()
            username = resolve_kaggle_username(username)
        except RuntimeError as exc:
            print(f"错误: {exc}", file=sys.stderr)
            return 1

    try:
        run_kernel_once(
            repo=repo,
            kernel_dir=kernel_dir,
            username=username or PLACEHOLDER_USERNAME,
            dataset_slug=dataset_slug,
            kernel_inputs=kernel_inputs,
            output_dir=args.output_dir,
            log_timeout=args.log_timeout,
            dry_run=args.dry_run,
        )
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"错误: Kernel 运行失败: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        return 0

    eval_path = args.output_dir / "evaluation.json"
    if not eval_path.is_file():
        print(f"错误: 缺少 Kernel 产出 {eval_path}", file=sys.stderr)
        return 1

    with eval_path.open(encoding="utf-8") as handle:
        evaluation = json.load(handle)

    try:
        validate_evaluation(
            evaluation,
            expected_title_hash=title_hash,
            expected_formula_hash=idea.get("formula_hash") or formula_hash(idea["formula_sketch"]),
        )
    except ValueError as exc:
        print(f"错误: 评估结果校验失败: {exc}", file=sys.stderr)
        return 1

    eval_archive = evaluations_dir / f"{title_hash}.json"
    eval_archive.write_text(
        json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if not args.skip_project_write and evaluation.get("status") in ("success", "skipped"):
        token = get_github_token()
        write_evaluation(evaluation, idea=idea, token=token, dry_run=False)

    if not args.skip_commit:
        git_commit_evaluation(repo, title_hash, dry_run=False)

    print(json.dumps(evaluation.get("metrics"), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
