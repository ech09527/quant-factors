#!/usr/bin/env python3
"""工作流 B：Runner 编排 Kaggle Kernel（探索 + Cursor 生成想法）并写入 Project。"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.build_kernel_inputs import build_inputs, slug_to_dir  # noqa: E402
from scripts.fetch_existing_ideas import title_hash  # noqa: E402
from scripts.kaggle_kernel import (  # noqa: E402
    PLACEHOLDER_USERNAME,
    backup_file,
    download_kernel_output,
    inject_dataset_slug_default,
    kernel_ref,
    push_kernel,
    remove_dataset_slug_inject,
    replace_placeholder_username,
    resolve_kaggle_username,
    restore_file,
    setup_kaggle_credentials,
    update_kernel_metadata,
    wait_for_kernel_complete,
    wait_for_kernel_logs,
)
from scripts.parse_cursor_ideas import extract_ideas, load_schema, validate_ideas  # noqa: E402
from scripts.write_to_project import write_ideas  # noqa: E402
from scripts.github_graphql import get_github_token  # noqa: E402

DEFAULT_KERNEL_SLUG = "generate-factor-ideas"
MAX_RETRIES = 2


@dataclass
class RunSummary:
    dataset_slug: str
    attempts: int = 0
    ideas_generated: int = 0
    ideas_written: int = 0
    ideas_skipped: int = 0
    errors: list[str] = field(default_factory=list)


def repo_root() -> Path:
    return REPO_ROOT


def load_datasets_yaml(path: Path) -> list[dict[str, Any]]:
    import yaml

    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    datasets = data.get("datasets")
    if not isinstance(datasets, list):
        raise ValueError(f"{path} 中缺少 datasets 列表")
    return datasets


def select_dataset_slug(entries: list[dict[str, Any]], slug_filter: str | None) -> str:
    if slug_filter:
        matched = [e for e in entries if e.get("slug") == slug_filter]
        if not matched:
            raise ValueError(f"在 datasets.yaml 中未找到 slug: {slug_filter}")
        return slug_filter

    enabled = [e for e in entries if e.get("enabled") is True and e.get("slug")]
    if not enabled:
        raise ValueError("datasets.yaml 中没有 enabled: true 的数据集")
    if len(enabled) > 1:
        print(
            f"警告: 多个 enabled 数据集，使用第一个: {enabled[0]['slug']}",
            file=sys.stderr,
        )
    return str(enabled[0]["slug"])


def bundle_kernel(kernel_dir: Path, repo: Path) -> None:
    prompts_dir = kernel_dir / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)

    explore_py = repo / "explorations" / "explore-dataset" / "explore_dataset.py"
    shutil.copy2(explore_py, kernel_dir / "explore_dataset.py")
    shutil.copy2(
        repo / "scripts" / "prompts" / "explore-dataset.txt",
        prompts_dir / "explore-dataset.txt",
    )
    shutil.copy2(
        repo / "scripts" / "prompts" / "generate-ideas-kaggle.txt",
        prompts_dir / "generate-ideas-kaggle.txt",
    )


def write_kernel_inputs(
    kernel_dir: Path,
    *,
    dataset_slug: str,
    max_ideas: int,
    mode: str,
    existing_titles: list[str],
    forbidden_titles: list[str],
    target_file: str,
    repo: Path,
) -> Path:
    inputs_path = kernel_dir / "kernel_inputs.json"
    payload = build_inputs(
        dataset_slug=dataset_slug,
        max_ideas=max_ideas,
        mode=mode,
        existing_titles=existing_titles,
        forbidden_titles=forbidden_titles,
        target_file=target_file,
        repo=repo,
    )
    inputs_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return inputs_path


def load_ideas_from_output(output_dir: Path) -> list[dict[str, Any]]:
    ideas_json = output_dir / "ideas.json"
    if ideas_json.is_file():
        with ideas_json.open(encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("ideas"), list):
            return data["ideas"]

    ideas_raw = output_dir / "ideas_raw.txt"
    if ideas_raw.is_file():
        text = ideas_raw.read_text(encoding="utf-8")
        ideas = extract_ideas(text)
        schema = load_schema()
        validate_ideas(ideas, schema)
        return ideas

    raise FileNotFoundError(
        f"Kernel 产出缺少 ideas.json 或 ideas_raw.txt: {output_dir}"
    )


def filter_new_ideas(
    ideas: list[dict[str, Any]],
    existing_hashes: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    new_ideas: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    seen: set[str] = set(existing_hashes)

    for idea in ideas:
        th = title_hash(idea["title"])
        if th in seen:
            skipped.append({"title": idea["title"], "title_hash": th})
            continue
        new_ideas.append(idea)
        seen.add(th)

    return new_ideas, skipped


def sync_dataset_artifacts(output_dir: Path, repo: Path, slug: str) -> bool:
    """将 Kernel 探索产物同步到 datasets/（有 schema 时）。"""
    src_schema = output_dir / "schema.json"
    if not src_schema.is_file():
        return False

    target_dir = repo / "datasets" / slug_to_dir(slug)
    target_dir.mkdir(parents=True, exist_ok=True)

    for name in ("schema.json", "README.md", "exploration_narrative.md"):
        src = output_dir / name
        if src.is_file():
            shutil.copy2(src, target_dir / name)
    return True


def git_commit_datasets(repo: Path, slug: str, dry_run: bool) -> bool:
    message = f"chore(datasets): 因子想法工作流更新探索产物 ({slug})"
    if dry_run:
        print(f"[dry-run] git commit datasets/ -m {message!r}")
        return True

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("警告: 未设置 GITHUB_TOKEN，跳过 datasets/ commit", file=sys.stderr)
        return False

    subprocess.run(
        ["git", "config", "user.name", "github-actions[bot]"],
        cwd=repo,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"],
        cwd=repo,
        check=True,
    )
    subprocess.run(["git", "add", "datasets/"], cwd=repo, check=True)
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo,
        check=False,
    )
    if diff.returncode == 0:
        return False

    subprocess.run(["git", "commit", "-m", message], cwd=repo, check=True)
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    remote_url = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    if remote_url.startswith("https://github.com/"):
        auth_url = remote_url.replace(
            "https://github.com/",
            f"https://x-access-token:{token}@github.com/",
            1,
        )
        subprocess.run(
            ["git", "pull", "--rebase", auth_url, branch],
            cwd=repo,
            check=False,
        )
        subprocess.run(["git", "push", auth_url, f"HEAD:{branch}"], cwd=repo, check=True)
    else:
        subprocess.run(["git", "push", "-u", "origin", branch], cwd=repo, check=True)
    return True


def run_kernel_once(
    *,
    repo: Path,
    kernel_dir: Path,
    username: str,
    dataset_slug: str,
    max_ideas: int,
    mode: str,
    existing_titles: list[str],
    forbidden_titles: list[str],
    target_file: str,
    output_dir: Path,
    log_timeout: int,
    dry_run: bool,
) -> str:
    kernel = kernel_ref(username, DEFAULT_KERNEL_SLUG)
    metadata_path = kernel_dir / "kernel-metadata.json"
    explore_py = kernel_dir / "explore_dataset.py"
    inputs_path = kernel_dir / "kernel_inputs.json"

    metadata_backup = backup_file(metadata_path)
    explore_backup = backup_file(explore_py) if explore_py.is_file() else ""
    inputs_backup = backup_file(inputs_path) if inputs_path.is_file() else None
    auth_injected_path = kernel_dir / ".cursor_auth_injected.json"
    auth_backup: str | None = None
    if auth_injected_path.is_file():
        auth_backup = backup_file(auth_injected_path)

    cursor_auth = os.environ.get("CURSOR_AUTH_JSON", "").strip()
    if cursor_auth:
        auth_injected_path.write_text(cursor_auth, encoding="utf-8")
        auth_injected_path.chmod(0o600)

    try:
        bundle_kernel(kernel_dir, repo)
        write_kernel_inputs(
            kernel_dir,
            dataset_slug=dataset_slug,
            max_ideas=max_ideas,
            mode=mode,
            existing_titles=existing_titles,
            forbidden_titles=forbidden_titles,
            target_file=target_file,
            repo=repo,
        )
        update_kernel_metadata(
            metadata_path,
            username,
            dataset_slug,
            kernel_slug=DEFAULT_KERNEL_SLUG,
        )
        replace_placeholder_username(metadata_path, username)
        inject_dataset_slug_default(kernel_dir / "explore_dataset.py", dataset_slug)

        push_kernel(kernel_dir, dry_run=dry_run)
        wait_for_kernel_logs(kernel, log_timeout, dry_run=dry_run)
        status = wait_for_kernel_complete(kernel, log_timeout, dry_run=dry_run)
        if status != "complete":
            raise RuntimeError(f"Kernel 未成功完成，status={status}")

        download_kernel_output(kernel, output_dir, dry_run=dry_run)
        return status

    finally:
        restore_file(metadata_path, metadata_backup)
        if explore_backup:
            restore_file(explore_py, explore_backup)
        if inputs_backup is not None:
            restore_file(inputs_path, inputs_backup)
        elif inputs_path.is_file():
            inputs_path.unlink()
        if cursor_auth:
            if auth_backup is not None:
                restore_file(auth_injected_path, auth_backup)
            elif auth_injected_path.is_file():
                auth_injected_path.unlink()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Runner 编排 Kaggle 因子想法生成")
    parser.add_argument("--slug", help="指定数据集 slug，默认取 datasets.yaml 首个 enabled")
    parser.add_argument("--max-ideas", type=int, default=int(os.environ.get("MAX_IDEAS", "3")))
    parser.add_argument(
        "--mode",
        choices=("explore_and_generate", "generate_only"),
        default=os.environ.get("KERNEL_MODE", "explore_and_generate"),
    )
    parser.add_argument(
        "--target-file",
        default=os.environ.get("TARGET_FILE", "futures/um/klines/1h.parquet"),
    )
    parser.add_argument("--existing", type=Path, help="已有想法 JSON 路径")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--log-timeout",
        type=int,
        default=int(os.environ.get("KERNEL_LOG_TIMEOUT_SECONDS", "5400")),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/tmp/factor-ideas-out"),
    )
    parser.add_argument("--skip-project-write", action="store_true")
    parser.add_argument("--skip-datasets-commit", action="store_true")
    return parser.parse_args(argv)


def load_existing_data(path: Path | None) -> tuple[list[str], set[str]]:
    if path is None or not path.is_file():
        return [], set()
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        ideas = data.get("ideas", [])
        hashes = set(data.get("title_hashes") or [])
        titles = [item["title"] for item in ideas if item.get("title")]
        if not hashes and titles:
            hashes = {title_hash(t) for t in titles}
        return titles, hashes
    return [], set()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo = repo_root()
    datasets_yaml = repo / "datasets" / "datasets.yaml"
    kernel_dir = repo / "explorations" / "generate-factor-ideas"

    if not datasets_yaml.is_file():
        print(f"错误: 未找到 {datasets_yaml}", file=sys.stderr)
        return 1
    if not kernel_dir.is_dir():
        print(f"错误: 未找到 Kernel 目录 {kernel_dir}", file=sys.stderr)
        return 1

    try:
        entries = load_datasets_yaml(datasets_yaml)
        dataset_slug = select_dataset_slug(entries, args.slug)
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    existing_titles, existing_hashes = load_existing_data(args.existing)
    forbidden_extra: list[str] = []
    collected_new: list[dict[str, Any]] = []
    summary = RunSummary(dataset_slug=dataset_slug)

    username = os.environ.get("KAGGLE_USERNAME", "").strip()
    if not args.dry_run:
        try:
            setup_kaggle_credentials()
            username = resolve_kaggle_username(username)
        except RuntimeError as exc:
            print(f"错误: {exc}", file=sys.stderr)
            return 1

    for attempt in range(MAX_RETRIES + 1):
        summary.attempts = attempt + 1
        all_titles = list(dict.fromkeys(existing_titles + forbidden_extra))
        need = args.max_ideas - len(collected_new)
        if need <= 0:
            break

        print(f"\n=== 第 {attempt + 1} 次 Kernel 运行（目标补 {need} 条）===")
        per_output = args.output_dir / f"attempt-{attempt + 1}"

        try:
            run_kernel_once(
                repo=repo,
                kernel_dir=kernel_dir,
                username=username or PLACEHOLDER_USERNAME,
                dataset_slug=dataset_slug,
                max_ideas=need,
                mode=args.mode,
                existing_titles=all_titles,
                forbidden_titles=forbidden_extra,
                target_file=args.target_file,
                output_dir=per_output,
                log_timeout=args.log_timeout,
                dry_run=args.dry_run,
            )
        except (RuntimeError, subprocess.CalledProcessError, FileNotFoundError) as exc:
            summary.errors.append(str(exc))
            print(f"错误: Kernel 运行失败: {exc}", file=sys.stderr)
            break

        if args.dry_run:
            print("[dry-run] 跳过后续解析与写入")
            break

        try:
            ideas = load_ideas_from_output(per_output)
            summary.ideas_generated += len(ideas)
            new_ideas, skipped = filter_new_ideas(ideas, existing_hashes)
            summary.ideas_skipped += len(skipped)
            if skipped:
                print(f"去重跳过 {len(skipped)} 条: {[s['title'] for s in skipped]}")
            collected_new.extend(new_ideas)
            for idea in ideas:
                existing_hashes.add(title_hash(idea["title"]))
            forbidden_extra.extend([s["title"] for s in skipped])
            forbidden_extra.extend([i["title"] for i in new_ideas])

            if len(collected_new) >= args.max_ideas:
                break
            if attempt < MAX_RETRIES and len(new_ideas) < need:
                print("有效想法不足，将重试...")
                continue
        except (ValueError, FileNotFoundError) as exc:
            summary.errors.append(str(exc))
            print(f"错误: 解析想法失败: {exc}", file=sys.stderr)
            break

    collected_new = collected_new[: args.max_ideas]
    print(f"\n共收集 {len(collected_new)} 条新想法（目标 {args.max_ideas}）")

    if args.dry_run:
        return 0

    last_output = args.output_dir / f"attempt-{summary.attempts}"
    if last_output.is_dir() and not args.skip_datasets_commit:
        if sync_dataset_artifacts(last_output, repo, dataset_slug):
            git_commit_datasets(repo, dataset_slug, dry_run=False)

    if not collected_new:
        print("无新想法可写入 Project", file=sys.stderr)
        return 1 if summary.errors else 0

    if args.skip_project_write:
        out_path = args.output_dir / "parsed-ideas.json"
        out_path.write_text(
            json.dumps(collected_new, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已写入 {out_path}（--skip-project-write）")
        return 0

    project_id = os.environ.get("GITHUB_PROJECT_ID")
    if not project_id:
        print("错误: 未设置 GITHUB_PROJECT_ID", file=sys.stderr)
        return 1

    token = get_github_token()
    schema = load_schema()
    validate_ideas(collected_new, schema)

    _, initial_hashes = load_existing_data(args.existing)
    result = write_ideas(
        collected_new,
        project_id,
        token,
        set(initial_hashes),
        dry_run=False,
    )
    summary.ideas_written = len(result["created"])
    summary.ideas_skipped += len(result["skipped"])

    print(json.dumps(result, ensure_ascii=False, indent=2))

    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ideas_backup = repo / "ideas" / f"{date}.json"
    ideas_backup.parent.mkdir(parents=True, exist_ok=True)
    ideas_backup.write_text(
        json.dumps(collected_new, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if os.environ.get("GITHUB_TOKEN"):
        try:
            subprocess.run(
                ["git", "config", "user.name", "github-actions[bot]"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "config",
                    "user.email",
                    "github-actions[bot]@users.noreply.github.com",
                ],
                cwd=repo,
                check=True,
            )
            subprocess.run(["git", "add", str(ideas_backup)], cwd=repo, check=True)
            diff = subprocess.run(
                ["git", "diff", "--cached", "--quiet"],
                cwd=repo,
                check=False,
            )
            if diff.returncode != 0:
                subprocess.run(
                    ["git", "commit", "-m", f"chore(ideas): backup factor ideas {date}"],
                    cwd=repo,
                    check=True,
                )
                branch = subprocess.run(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=repo,
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout.strip()
                token_git = os.environ["GITHUB_TOKEN"]
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
                        f"https://x-access-token:{token_git}@github.com/",
                        1,
                    )
                    subprocess.run(
                        ["git", "pull", "--rebase", auth_url, branch],
                        cwd=repo,
                        check=False,
                    )
                    subprocess.run(
                        ["git", "push", auth_url, f"HEAD:{branch}"],
                        cwd=repo,
                        check=True,
                    )
        except subprocess.CalledProcessError as exc:
            print(f"警告: ideas 备份 commit 失败: {exc}", file=sys.stderr)

    return 0 if summary.ideas_written > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
