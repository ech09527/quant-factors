#!/usr/bin/env python3
"""注册 Prefect work pool 与 deployments（git clone pull 模式）。"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import yaml

PREFECT_DIR = Path(__file__).resolve().parent
REPO_ROOT = PREFECT_DIR.parent
DEFAULT_WORK_POOL = "quant-factors-eval"
DEFAULT_GIT_REPOSITORY = "git@github.com:ech09527/quant-factors.git"
DEFAULT_GIT_BRANCH = "main"
PREFECT_YAML_PATH = PREFECT_DIR / "prefect.yaml"


def run(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd or PREFECT_DIR, check=True)


def read_prefect_yaml() -> dict:
    with PREFECT_YAML_PATH.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def write_prefect_yaml(config: dict) -> None:
    PREFECT_YAML_PATH.write_text(
        yaml.safe_dump(config, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def apply_git_pull_settings(
    config: dict,
    *,
    repository: str,
    branch: str,
) -> dict:
    pull = config.get("pull")
    if not isinstance(pull, list) or not pull:
        raise ValueError("prefect.yaml 缺少 pull 配置")

    clone_step = pull[0].get("prefect.deployments.steps.git_clone")
    if not isinstance(clone_step, dict):
        raise ValueError("prefect.yaml pull[0] 必须是 git_clone")

    clone_step["repository"] = repository
    clone_step["branch"] = branch
    if "id" not in clone_step:
        clone_step["id"] = "clone-quant-factors"

    clone_id = str(clone_step["id"])
    if len(pull) < 2:
        pull.append(
            {
                "prefect.deployments.steps.set_working_directory": {
                    "directory": f"{{{{ {clone_id}.directory }}}}/prefect"
                }
            }
        )
    else:
        workdir_step = pull[1].get("prefect.deployments.steps.set_working_directory")
        if not isinstance(workdir_step, dict):
            raise ValueError("prefect.yaml pull[1] 必须是 set_working_directory")
        workdir_step["directory"] = f"{{{{ {clone_id}.directory }}}}/prefect"

    config["pull"] = pull
    return config


def ensure_work_pool(name: str) -> None:
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
    except subprocess.CalledProcessError as exc:
        print(f"work pool setup warning: {exc}")


def deploy_flows(work_pool: str) -> None:
    config = read_prefect_yaml()
    repository = os.getenv("PREFECT_DEPLOY_GIT_REPOSITORY", DEFAULT_GIT_REPOSITORY).strip()
    branch = os.getenv("PREFECT_DEPLOY_GIT_BRANCH", DEFAULT_GIT_BRANCH).strip() or DEFAULT_GIT_BRANCH
    config = apply_git_pull_settings(config, repository=repository, branch=branch)

    for deployment in config.get("deployments", []):
        if isinstance(deployment, dict):
            work_pool_cfg = deployment.setdefault("work_pool", {})
            if isinstance(work_pool_cfg, dict) and not work_pool_cfg.get("name"):
                work_pool_cfg["name"] = work_pool

    write_prefect_yaml(config)
    run([sys.executable, "-m", "prefect", "deploy", "--all", "--no-prompt"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy quant-factors Prefect flows")
    parser.add_argument("--work-pool", default=os.getenv("PREFECT_WORK_POOL", DEFAULT_WORK_POOL))
    parser.add_argument("--skip-pool", action="store_true")
    parser.add_argument(
        "--git-repository",
        default=os.getenv("PREFECT_DEPLOY_GIT_REPOSITORY", DEFAULT_GIT_REPOSITORY),
    )
    parser.add_argument(
        "--git-branch",
        default=os.getenv("PREFECT_DEPLOY_GIT_BRANCH", DEFAULT_GIT_BRANCH),
    )
    args = parser.parse_args()

    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))

    os.environ["PREFECT_DEPLOY_GIT_REPOSITORY"] = args.git_repository
    os.environ["PREFECT_DEPLOY_GIT_BRANCH"] = args.git_branch

    if not args.skip_pool:
        ensure_work_pool(args.work_pool)
    deploy_flows(args.work_pool)
    print(
        f"Deployed factor-validation/production on pool {args.work_pool} (git pull: {args.git_repository}@{args.git_branch})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
