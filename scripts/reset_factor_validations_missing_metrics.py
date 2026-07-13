#!/usr/bin/env python3
"""将 success 但缺少 diagnostics.metrics 的 factor_validation 重置为 pending，便于重跑。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO_ROOT / "workers" / "factor-ideas"
DB_NAME = "quant-factors"

SELECT_AFFECTED_SQL = """
SELECT mt.id AS task_id, fv.id AS factor_validation_id, fv.idea_id
  FROM factor_validations fv
  JOIN ml_tasks mt ON mt.id = fv.task_id
 WHERE mt.status = 'success'
   AND json_extract(mt.diagnostics, '$.metrics.mean_rank_ic') IS NULL
 ORDER BY mt.id ASC
""".strip()


def run_d1(sql: str, *, remote: bool) -> list[dict]:
    cmd = [
        "npx",
        "wrangler",
        "d1",
        "execute",
        DB_NAME,
        "--command",
        sql,
        "--json",
    ]
    if remote:
        cmd.append("--remote")
    proc = subprocess.run(
        cmd,
        cwd=WORKER_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(proc.stdout)
    rows: list[dict] = []
    for block in payload:
        for row in block.get("results") or []:
            rows.append(row)
    return rows


def reset_rows(task_ids: list[int], *, remote: bool) -> None:
    if not task_ids:
        print("没有需要重置的记录")
        return
    id_list = ", ".join(str(task_id) for task_id in task_ids)
    business_ids = ", ".join(f"'{task_id}'" for task_id in task_ids)
    statements = [
        f"""
        DELETE FROM prefect_flow_runs
         WHERE business_type = 'factor_validation'
           AND business_id IN ({business_ids})
        """.strip(),
        f"""
        UPDATE factor_validations
           SET evaluated_at = NULL,
               updated_at = datetime('now')
         WHERE task_id IN ({id_list})
        """.strip(),
        f"""
        UPDATE ml_tasks
           SET status = 'pending',
               error_reason = NULL,
               mlflow_run_id = NULL,
               mlflow_experiment = NULL,
               completed_at = NULL,
               submitted_at = NULL,
               diagnostics = NULL,
               updated_at = datetime('now')
         WHERE id IN ({id_list})
           AND status = 'success'
           AND json_extract(diagnostics, '$.metrics.mean_rank_ic') IS NULL
        """.strip(),
    ]
    for sql in statements:
        run_d1(sql, remote=remote)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="重置缺少 metrics 的 factor_validation success 记录为 pending"
    )
    parser.add_argument(
        "--remote",
        action="store_true",
        help="操作远程 D1（默认仅打印将影响的 task_id）",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="执行重置（需配合 --remote 才会写远程库）",
    )
    args = parser.parse_args()

    affected = run_d1(SELECT_AFFECTED_SQL, remote=args.remote)
    print(f"受影响记录: {len(affected)}")
    for row in affected[:20]:
        print(
            f"  task_id={row['task_id']} "
            f"factor_validation_id={row['factor_validation_id']} "
            f"idea_id={row['idea_id']}"
        )
    if len(affected) > 20:
        print(f"  ... 另有 {len(affected) - 20} 条")

    if not args.apply:
        print("dry-run：追加 --apply" + (" --remote" if args.remote else ""))
        return 0

    task_ids = [int(row["task_id"]) for row in affected]
    reset_rows(task_ids, remote=args.remote)
    print(f"已重置 {len(task_ids)} 条为 pending")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
