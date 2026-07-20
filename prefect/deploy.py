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


def _strip_schedules_for_compat(config: dict) -> list[dict]:
    """Client 3.7 写入 schedules.replaces=null 会被部分 Server 422；先剥离再 API 挂回。"""
    pending: list[dict] = []
    for deployment in config.get("deployments", []):
        if not isinstance(deployment, dict):
            continue
        schedules = deployment.pop("schedules", None)
        if not schedules:
            continue
        entrypoint = str(deployment.get("entrypoint") or "")
        flow_file = entrypoint.split(":")[0]
        # deployment 对外名 = flow.name / deployment.name；neutral 的 flow.name 固定
        flow_name = None
        if flow_file.endswith("neutral_validation.py") or flow_file.endswith(
            "neutral_validation"
        ):
            flow_name = "neutral_validation"
        elif "factor_validation" in flow_file and "test_" not in flow_file:
            flow_name = "factor-validation"
        if flow_name is None:
            continue
        pending.append(
            {
                "deployment_ref": f"{flow_name}/{deployment.get('name') or 'production'}",
                "schedules": schedules,
            }
        )
    return pending


def _apply_schedules_via_api(pending: list[dict]) -> None:
    api_url = os.getenv("PREFECT_API_URL", "").strip().rstrip("/")
    if not api_url or not pending:
        return
    import json
    import ssl
    import urllib.error
    import urllib.request

    # 部分环境 CA 不完整；与 prefect CLI 行为对齐，避免挂 schedule 失败
    ctx = ssl.create_default_context()
    if os.getenv("PREFECT_API_TLS_INSECURE", "").strip() in {"1", "true", "yes"}:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    def _open(req: urllib.request.Request | str):
        return urllib.request.urlopen(req, timeout=30, context=ctx)

    for item in pending:
        ref = item["deployment_ref"]
        try:
            with _open(f"{api_url}/deployments/name/{ref}") as resp:
                dep = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            print(f"WARN: lookup {ref} failed: {exc}")
            continue
        except urllib.error.URLError as exc:
            print(f"WARN: lookup {ref} failed: {exc}")
            continue
        dep_id = dep.get("id")
        if not dep_id:
            continue
        # 清掉旧 schedule，避免重复
        for existing in dep.get("schedules") or []:
            sid = existing.get("id")
            if not sid:
                continue
            req = urllib.request.Request(
                f"{api_url}/deployments/{dep_id}/schedules/{sid}",
                method="DELETE",
            )
            try:
                _open(req).read()
            except urllib.error.HTTPError as exc:
                print(f"WARN: delete schedule {sid}: {exc}")
        body = []
        for sched in item["schedules"]:
            if not isinstance(sched, dict):
                continue
            cron = sched.get("cron")
            if not cron:
                continue
            body.append(
                {
                    "schedule": {
                        "cron": cron,
                        "timezone": sched.get("timezone") or "UTC",
                    },
                    "active": bool(sched.get("active", True)),
                }
            )
        if not body:
            continue
        req = urllib.request.Request(
            f"{api_url}/deployments/{dep_id}/schedules",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with _open(req) as resp:
                print(f"Attached {len(body)} schedule(s) to {ref}: {resp.status}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            print(f"WARN: attach schedules to {ref}: {exc} {detail}")
        except urllib.error.URLError as exc:
            print(f"WARN: attach schedules to {ref}: {exc}")


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

    pending_schedules = _strip_schedules_for_compat(config)
    write_prefect_yaml(config)
    # 写回带 schedules 的源文件意图：deploy 用剥离版，仓库意图仍保留 schedules
    # 但 write 已去掉 schedules；重新读原始意图需要从 pending 恢复
    try:
        run([sys.executable, "-m", "prefect", "deploy", "--all", "--no-prompt"])
    finally:
        restored = read_prefect_yaml()
        by_entrypoint = {
            p["deployment_ref"].split("/", 1)[0]: p["schedules"] for p in pending_schedules
        }
        for deployment in restored.get("deployments", []):
            if not isinstance(deployment, dict):
                continue
            ep = str(deployment.get("entrypoint") or "")
            if ep.endswith("neutral_validation.py:run_neutral_validation") or (
                "neutral_validation.py" in ep and "neutral_validation" in by_entrypoint
            ):
                deployment["schedules"] = by_entrypoint["neutral_validation"]
            elif (
                "factor_validation" in ep
                and "test_" not in ep
                and "factor-validation" in by_entrypoint
            ):
                deployment["schedules"] = by_entrypoint["factor-validation"]
        write_prefect_yaml(restored)

    _apply_schedules_via_api(pending_schedules)


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

    config = read_prefect_yaml()
    pool_names: list[str] = []
    for deployment in config.get("deployments", []):
        if not isinstance(deployment, dict):
            continue
        work_pool_cfg = deployment.get("work_pool")
        if isinstance(work_pool_cfg, dict):
            name = str(work_pool_cfg.get("name") or "").strip()
            if name and name not in pool_names:
                pool_names.append(name)
    if args.work_pool and args.work_pool not in pool_names:
        pool_names.insert(0, args.work_pool)

    if not args.skip_pool:
        for name in pool_names:
            ensure_work_pool(name)
    deploy_flows(args.work_pool)
    pools_desc = ", ".join(pool_names) if pool_names else args.work_pool
    print(
        f"Deployed factor-validation/production and "
        f"neutral_validation/production on pools [{pools_desc}] "
        f"(git pull: {args.git_repository}@{args.git_branch})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
