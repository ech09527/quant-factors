#!/usr/bin/env python3
"""注册 Prefect work pool 与 deployments。"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

PREFECT_DIR = Path(__file__).resolve().parent
REPO_ROOT = PREFECT_DIR.parent
DEFAULT_WORK_POOL = "quant-factors-eval"


def run(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd or PREFECT_DIR, check=True)


def ensure_work_pool(name: str, concurrency: int) -> None:
    api_url = os.getenv("PREFECT_API_URL", "").strip()
    if not api_url:
        print("WARN: PREFECT_API_URL 未设置，跳过 work pool 创建")
        return
    try:
        run(
            [
                sys.executable,
                "-m",
                "prefect",
                "work-pool",
                "create",
                name,
                "--type",
                "process",
                "--overwrite",
            ]
        )
        run(
            [
                sys.executable,
                "-m",
                "prefect",
                "work-pool",
                "update",
                name,
                "--concurrency-limit",
                str(concurrency),
            ]
        )
    except subprocess.CalledProcessError as exc:
        print(f"work pool setup warning: {exc}")


def deploy_flows(work_pool: str) -> None:
    run(
        [
            sys.executable,
            "-m",
            "prefect",
            "deploy",
            "flows/factor_validation.py:run_factor_validation",
            "--name",
            "production",
            "--pool",
            work_pool,
            "--tag",
            "quant-factors",
            "--tag",
            "factor-validation",
        ]
    )
    run(
        [
            sys.executable,
            "-m",
            "prefect",
            "deploy",
            "flows/test_factor_validation.py:run_test_factor_validation",
            "--name",
            "production",
            "--pool",
            work_pool,
            "--tag",
            "quant-factors",
            "--tag",
            "test-factor-validation",
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy quant-factors Prefect flows")
    parser.add_argument("--work-pool", default=os.getenv("PREFECT_WORK_POOL", DEFAULT_WORK_POOL))
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(os.getenv("PREFECT_WORK_POOL_CONCURRENCY", "10")),
    )
    parser.add_argument("--skip-pool", action="store_true")
    args = parser.parse_args()

    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))

    if not args.skip_pool:
        ensure_work_pool(args.work_pool, args.concurrency)
    deploy_flows(args.work_pool)
    print(
        f"Deployed factor-validation/production and test-factor-validation/production "
        f"on pool {args.work_pool}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
