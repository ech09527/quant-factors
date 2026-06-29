"""Kaggle Kernel 编排共用工具（push / logs / status / output）。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

PLACEHOLDER_USERNAME = "PLACEHOLDER_USERNAME"
DATASET_SLUG_MARKER = "# __DATASET_SLUG_DEFAULT__"


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


def kernel_ref(username: str, kernel_slug: str | None = None) -> str:
    slug = kernel_slug or os.environ.get("KAGGLE_KERNEL_SLUG", "explore-dataset")
    return f"{username}/{slug}"


def update_kernel_metadata(
    metadata_path: Path, username: str, slug: str, *, kernel_slug: str | None = None
) -> None:
    with metadata_path.open(encoding="utf-8") as handle:
        metadata = json.load(handle)

    ks = kernel_slug or os.environ.get(
        "KAGGLE_KERNEL_SLUG", metadata.get("title", "explore-dataset")
    )
    metadata["id"] = f"{username}/{ks}"
    metadata["dataset_sources"] = [slug]

    with metadata_path.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def replace_placeholder_username(metadata_path: Path, username: str) -> None:
    text = metadata_path.read_text(encoding="utf-8")
    metadata_path.write_text(text.replace(PLACEHOLDER_USERNAME, username), encoding="utf-8")


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


def remove_dataset_slug_inject(py_path: Path) -> None:
    lines = py_path.read_text(encoding="utf-8").splitlines(keepends=True)
    filtered = [line for line in lines if DATASET_SLUG_MARKER not in line]
    py_path.write_text("".join(filtered), encoding="utf-8")


def wait_for_kernel_logs(
    kernel: str, timeout_seconds: int, dry_run: bool
) -> subprocess.CompletedProcess[str] | None:
    if dry_run:
        print(f"[dry-run] kaggle kernels logs {kernel} --follow --interval 15")
        return None

    cmd = ["kaggle", "kernels", "logs", kernel, "--follow", "--interval", "15"]
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
    if dry_run:
        print(f"[dry-run] poll kaggle kernels status {kernel}")
        return "complete"

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


def push_kernel(explore_dir: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] kaggle kernels push -p {explore_dir}")
        return
    run_command(["kaggle", "kernels", "push", "-p", str(explore_dir)])


def restore_file(path: Path, backup: str) -> None:
    path.write_text(backup, encoding="utf-8")


def backup_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")
