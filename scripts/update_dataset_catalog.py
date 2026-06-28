#!/usr/bin/env python3
"""工作流 A：遍历 datasets.yaml 中启用的数据集，在 Kaggle 探索并更新 datasets/ 目录。"""

from __future__ import annotations

import argparse
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DATASET_SLUG_MARKER = "# __DATASET_SLUG_DEFAULT__"
PLACEHOLDER_USERNAME = "PLACEHOLDER_USERNAME"


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def slug_to_safe_name(slug: str) -> str:
    return slug.strip().strip("/").replace("/", "__")


@dataclass
class RunResult:
    slug: str
    status: str
    changed: bool = False
    error: str | None = None


@dataclass
class CatalogSummary:
    processed: list[RunResult] = field(default_factory=list)
    changed_slugs: list[str] = field(default_factory=list)
    committed: bool = False
    dry_run: bool = False


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="工作流 A：更新 datasets/ 目录下的数据集 schema 与 README",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "环境变量:\n"
            "  KAGGLE_API_TOKEN  Kaggle API Token（推荐，非 dry-run）\n"
            "  KAGGLE_USERNAME   Kaggle 用户名（kernel id；可与 token 联用）\n"
            "  KAGGLE_KEY        旧版 Kaggle API Key（与 username 成对）\n"
            "  KAGGLE_KERNEL_SLUG  探索 Kernel slug，默认 explore-dataset\n"
            "  GITHUB_TOKEN      提交变更时使用（Actions 中自动注入）\n"
        ),
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=repo_root(),
        help="仓库根目录（默认自动检测）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅打印将执行的操作，不调用 Kaggle 或 git push",
    )
    parser.add_argument(
        "--slug",
        help="仅处理指定 slug（owner/dataset-name），可处理 disabled 条目",
    )
    parser.add_argument(
        "--log-timeout",
        type=int,
        default=int(os.environ.get("KERNEL_LOG_TIMEOUT_SECONDS", "5400")),
        help="kaggle kernels logs --follow 超时秒数（默认 5400）",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/tmp/explore-out"),
        help="kaggle kernels output 下载目录（默认 /tmp/explore-out）",
    )
    return parser.parse_args(argv)


def load_datasets_yaml(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    datasets = data.get("datasets")
    if not isinstance(datasets, list):
        raise ValueError(f"{path} 中缺少 datasets 列表")
    return datasets


def select_datasets(
    entries: list[dict[str, Any]], slug_filter: str | None
) -> list[dict[str, Any]]:
    if slug_filter:
        matched = [e for e in entries if e.get("slug") == slug_filter]
        if not matched:
            raise ValueError(f"在 datasets.yaml 中未找到 slug: {slug_filter}")
        entry = matched[0]
        if not entry.get("enabled", False):
            print(
                f"警告: slug '{slug_filter}' 未启用 (enabled: false)，"
                "因指定 --slug 仍将处理",
                file=sys.stderr,
            )
        return matched

    enabled = [e for e in entries if e.get("enabled") is True and e.get("slug")]
    return enabled


def run_command(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    display = " ".join(cmd)
    print(f"$ {display}")
    result = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, cmd, output=result.stdout, stderr=result.stderr
        )
    return result


def resolve_kaggle_username(explicit: str) -> str:
    """从环境变量或 kaggle config 解析用户名（用于 kernel id）。"""
    if explicit.strip():
        return explicit.strip()
    try:
        result = subprocess.run(
            ["kaggle", "config", "view"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise RuntimeError(
            "无法解析 Kaggle 用户名：请设置 KAGGLE_USERNAME 或配置 kaggle CLI"
        ) from exc
    for line in result.stdout.splitlines():
        if line.strip().startswith("- username:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("kaggle config view 未返回 username")


def setup_kaggle_credentials() -> None:
    """配置 Kaggle CLI：优先 KAGGLE_API_TOKEN，否则 username + key。"""
    api_token = os.environ.get("KAGGLE_API_TOKEN", "").strip()
    if api_token:
        os.environ["KAGGLE_API_TOKEN"] = api_token
        return

    username = os.environ.get("KAGGLE_USERNAME", "").strip()
    kaggle_key = os.environ.get("KAGGLE_KEY", "").strip()
    if not username or not kaggle_key:
        raise RuntimeError(
            "需要 KAGGLE_API_TOKEN，或同时设置 KAGGLE_USERNAME 与 KAGGLE_KEY"
        )

    kaggle_dir = Path.home() / ".kaggle"
    kaggle_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    kaggle_json = kaggle_dir / "kaggle.json"
    kaggle_json.write_text(
        json.dumps({"username": username, "key": kaggle_key}),
        encoding="utf-8",
    )
    kaggle_json.chmod(0o600)


def update_kernel_metadata(metadata_path: Path, username: str, slug: str) -> None:
    with metadata_path.open(encoding="utf-8") as handle:
        metadata = json.load(handle)

    kernel_slug = os.environ.get("KAGGLE_KERNEL_SLUG", "explore-dataset")
    metadata["id"] = f"{username}/{kernel_slug}"
    metadata["dataset_sources"] = [slug]

    with metadata_path.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def replace_placeholder_username(metadata_path: Path, username: str) -> None:
    text = metadata_path.read_text(encoding="utf-8")
    updated = text.replace(PLACEHOLDER_USERNAME, username)
    metadata_path.write_text(updated, encoding="utf-8")


def remove_dataset_slug_inject(py_path: Path) -> None:
    lines = py_path.read_text(encoding="utf-8").splitlines(keepends=True)
    filtered = [line for line in lines if DATASET_SLUG_MARKER not in line]
    py_path.write_text("".join(filtered), encoding="utf-8")


def inject_dataset_slug_default(py_path: Path, slug: str) -> None:
    remove_dataset_slug_inject(py_path)
    lines = py_path.read_text(encoding="utf-8").splitlines(keepends=True)
    inject_line = (
        f'os.environ.setdefault("DATASET_SLUG", "{slug}")  {DATASET_SLUG_MARKER}\n'
    )

    insert_at = None
    for index, line in enumerate(lines):
        if line.startswith("import os") or line.startswith("from os"):
            insert_at = index + 1

    if insert_at is None:
        raise RuntimeError(f"无法在 {py_path} 中找到 import os 以注入 DATASET_SLUG")

    lines.insert(insert_at, inject_line)
    py_path.write_text("".join(lines), encoding="utf-8")


def kernel_ref(username: str) -> str:
    kernel_slug = os.environ.get("KAGGLE_KERNEL_SLUG", "explore-dataset")
    return f"{username}/{kernel_slug}"


def wait_for_kernel_logs(
    kernel: str, timeout_seconds: int, dry_run: bool
) -> subprocess.CompletedProcess[str] | None:
    if dry_run:
        print(f"[dry-run] kaggle kernels logs {kernel} --follow --interval 15")
        return None

    cmd = [
        "kaggle",
        "kernels",
        "logs",
        kernel,
        "--follow",
        "--interval",
        "15",
    ]
    try:
        return run_command(cmd, timeout=timeout_seconds, check=False)
    except subprocess.TimeoutExpired as exc:
        print(
            f"警告: kernels logs 在 {timeout_seconds}s 后超时，将继续检查 status",
            file=sys.stderr,
        )
        if exc.stdout:
            print(exc.stdout.decode() if isinstance(exc.stdout, bytes) else exc.stdout)
        if exc.stderr:
            print(
                exc.stderr.decode() if isinstance(exc.stderr, bytes) else exc.stderr,
                file=sys.stderr,
            )
        return None


def wait_for_kernel_complete(
    kernel: str, timeout_seconds: int, dry_run: bool, poll_interval: int = 20
) -> str:
    """轮询 kernels status 直至 complete / error 或超时。"""
    if dry_run:
        print(f"[dry-run] poll kaggle kernels status {kernel}")
        return "complete"

    import time

    deadline = time.monotonic() + timeout_seconds
    last_status = "unknown"
    while time.monotonic() < deadline:
        last_status = get_kernel_status(kernel, dry_run=False)
        if "complete" in last_status:
            return "complete"
        if "error" in last_status or "failed" in last_status:
            return last_status
        if "running" in last_status or "queued" in last_status:
            print(f"Kernel 状态: {last_status}，{poll_interval}s 后重试...")
            time.sleep(poll_interval)
            continue
        time.sleep(poll_interval)
    return last_status


def get_kernel_status(kernel: str, dry_run: bool) -> str:
    if dry_run:
        print(f"[dry-run] kaggle kernels status {kernel}")
        return "complete"

    result = run_command(["kaggle", "kernels", "status", kernel], check=False)
    output = (result.stdout or result.stderr or "").strip().lower()
    if "complete" in output and "error" not in output:
        return "complete"
    if "error" in output or "failed" in output:
        return "error"
    if "running" in output or "queued" in output:
        return "running"
    return output or "unknown"


def download_kernel_output(kernel: str, output_dir: Path, dry_run: bool) -> Path:
    if dry_run:
        print(f"[dry-run] kaggle kernels output {kernel} -p {output_dir}")
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    run_command(["kaggle", "kernels", "output", kernel, "-p", str(output_dir)])
    return output_dir


def schema_changed(old_path: Path, new_path: Path) -> bool:
    if not old_path.is_file():
        return True
    if not new_path.is_file():
        return False
    try:
        with old_path.open(encoding="utf-8") as handle:
            old_data = json.load(handle)
        with new_path.open(encoding="utf-8") as handle:
            new_data = json.load(handle)
        return old_data != new_data
    except json.JSONDecodeError:
        return not filecmp.cmp(old_path, new_path, shallow=False)


def copy_artifacts(
    output_dir: Path, datasets_root: Path, slug: str
) -> tuple[Path, Path, bool]:
    safe_name = slug_to_safe_name(slug)
    target_dir = datasets_root / safe_name
    target_dir.mkdir(parents=True, exist_ok=True)

    src_schema = output_dir / "schema.json"
    src_readme = output_dir / "README.md"
    dst_schema = target_dir / "schema.json"
    dst_readme = target_dir / "README.md"

    if not src_schema.is_file():
        raise FileNotFoundError(f"Kernel 产出缺少 schema.json: {src_schema}")
    if not src_readme.is_file():
        raise FileNotFoundError(f"Kernel 产出缺少 README.md: {src_readme}")

    changed = schema_changed(dst_schema, src_schema)
    shutil.copy2(src_schema, dst_schema)
    shutil.copy2(src_readme, dst_readme)
    return dst_schema, dst_readme, changed


def git_commit_and_push(
    repo: Path, changed_slugs: list[str], dry_run: bool
) -> bool:
    if not changed_slugs:
        print("无 schema 变更，跳过 git commit。")
        return False

    slug_list = ", ".join(changed_slugs)
    message = f"chore(datasets): 更新探索产物 ({slug_list})"

    if dry_run:
        print(f"[dry-run] git commit datasets/ -m {message!r}")
        print("[dry-run] git push")
        return True

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print(
            "警告: 未设置 GITHUB_TOKEN，无法 push；变更已写入本地 datasets/",
            file=sys.stderr,
        )
        return False

    run_command(
        ["git", "config", "user.name", "github-actions[bot]"],
        cwd=repo,
    )
    run_command(
        ["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"],
        cwd=repo,
    )
    run_command(["git", "add", "datasets/"], cwd=repo)

    diff = run_command(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo,
        check=False,
    )
    if diff.returncode == 0:
        print("git 暂存区无变更，跳过 commit。")
        return False

    run_command(["git", "commit", "-m", message], cwd=repo)

    branch = run_command(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo,
    ).stdout.strip()
    remote_url = run_command(
        ["git", "remote", "get-url", "origin"],
        cwd=repo,
    ).stdout.strip()

    # 使用一次性 auth URL，避免污染 origin remote（防止重复注入 token）
    if remote_url.startswith("https://github.com/"):
        auth_url = remote_url.replace(
            "https://github.com/",
            f"https://x-access-token:{token}@github.com/",
            1,
        )
        # 并发 workflow 可能已推送其他 commit，push 前先 rebase
        run_command(
            ["git", "pull", "--rebase", auth_url, branch],
            cwd=repo,
            check=False,
        )
        run_command(["git", "push", auth_url, f"HEAD:{branch}"], cwd=repo)
    elif remote_url.startswith("git@"):
        env = os.environ.copy()
        env["GIT_ASKPASS"] = "echo"
        env["GIT_TERMINAL_PROMPT"] = "0"
        run_command(["git", "push", "-u", "origin", branch], cwd=repo, env=env)
    else:
        run_command(["git", "push", "-u", "origin", branch], cwd=repo)

    return True


def process_slug(
    slug: str,
    *,
    repo: Path,
    username: str,
    explore_dir: Path,
    output_base: Path,
    log_timeout: int,
    dry_run: bool,
) -> RunResult:
    kernel = kernel_ref(username)
    metadata_path = explore_dir / "kernel-metadata.json"
    py_path = explore_dir / "explore_dataset.py"
    per_slug_output = output_base / slug_to_safe_name(slug)

    print(f"\n=== 处理数据集: {slug} ===")

    if dry_run:
        print(f"[dry-run] 更新 {metadata_path} dataset_sources -> [{slug}]")
        print(f"[dry-run] 设置 kernel id -> {kernel}")
        print(f"[dry-run] 注入 DATASET_SLUG 默认值 -> {slug}")
        print(f"[dry-run] kaggle kernels push -p {explore_dir}")
        wait_for_kernel_logs(kernel, log_timeout, dry_run=True)
        status = get_kernel_status(kernel, dry_run=True)
        download_kernel_output(kernel, per_slug_output, dry_run=True)
        safe = slug_to_safe_name(slug)
        print(f"[dry-run] 复制产出到 datasets/{safe}/")
        return RunResult(slug=slug, status=status, changed=False)

    metadata_backup = metadata_path.read_text(encoding="utf-8")
    py_backup = py_path.read_text(encoding="utf-8")

    try:
        update_kernel_metadata(metadata_path, username, slug)
        replace_placeholder_username(metadata_path, username)
        inject_dataset_slug_default(py_path, slug)

        run_command(["kaggle", "kernels", "push", "-p", str(explore_dir)])

        wait_for_kernel_logs(kernel, log_timeout, dry_run=False)

        status = wait_for_kernel_complete(kernel, log_timeout, dry_run=False)
        if status != "complete":
            return RunResult(
                slug=slug,
                status=status,
                error=f"Kernel 未成功完成，status={status}",
            )

        download_kernel_output(kernel, per_slug_output, dry_run=False)
        _, _, changed = copy_artifacts(
            per_slug_output,
            repo / "datasets",
            slug,
        )
        print(f"完成: {slug}，schema {'已变更' if changed else '未变更'}")
        return RunResult(slug=slug, status=status, changed=changed)

    except (subprocess.CalledProcessError, FileNotFoundError, RuntimeError) as exc:
        print(f"错误: 处理 {slug} 失败: {exc}", file=sys.stderr)
        return RunResult(slug=slug, status="error", error=str(exc))

    finally:
        metadata_path.write_text(metadata_backup, encoding="utf-8")
        py_path.write_text(py_backup, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo = args.repo_root.resolve()
    datasets_yaml = repo / "datasets" / "datasets.yaml"
    explore_dir = repo / "explorations" / "explore-dataset"

    if not datasets_yaml.is_file():
        print(f"错误: 未找到 {datasets_yaml}", file=sys.stderr)
        return 1
    if not explore_dir.is_dir():
        print(f"错误: 未找到探索目录 {explore_dir}", file=sys.stderr)
        return 1

    try:
        entries = load_datasets_yaml(datasets_yaml)
        selected = select_datasets(entries, args.slug)
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    if not selected:
        print(
            "提示: datasets.yaml 中没有 enabled: true 的数据集，无需执行探索。",
        )
        return 0

    username = os.environ.get("KAGGLE_USERNAME", "").strip()

    if not args.dry_run:
        try:
            setup_kaggle_credentials()
            username = resolve_kaggle_username(username)
        except RuntimeError as exc:
            print(f"错误: {exc}", file=sys.stderr)
            return 1

    summary = CatalogSummary(dry_run=args.dry_run)
    slugs = [str(entry["slug"]) for entry in selected]
    print(f"将处理 {len(slugs)} 个数据集: {', '.join(slugs)}")

    for slug in slugs:
        result = process_slug(
            slug,
            repo=repo,
            username=username or PLACEHOLDER_USERNAME,
            explore_dir=explore_dir,
            output_base=args.output_dir,
            log_timeout=args.log_timeout,
            dry_run=args.dry_run,
        )
        summary.processed.append(result)
        if result.changed:
            summary.changed_slugs.append(slug)

    failed = [r for r in summary.processed if r.error]
    if failed:
        print("\n以下数据集处理失败:", file=sys.stderr)
        for item in failed:
            print(f"  - {item.slug}: {item.error}", file=sys.stderr)

    if summary.changed_slugs and not args.dry_run:
        summary.committed = git_commit_and_push(
            repo, summary.changed_slugs, dry_run=False
        )
    elif summary.changed_slugs and args.dry_run:
        git_commit_and_push(repo, summary.changed_slugs, dry_run=True)
        summary.committed = True

    print("\n=== 汇总 ===")
    print(json.dumps(
        {
            "processed": [
                {
                    "slug": r.slug,
                    "status": r.status,
                    "changed": r.changed,
                    "error": r.error,
                }
                for r in summary.processed
            ],
            "changed_slugs": summary.changed_slugs,
            "committed": summary.committed,
            "dry_run": summary.dry_run,
        },
        ensure_ascii=False,
        indent=2,
    ))

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
