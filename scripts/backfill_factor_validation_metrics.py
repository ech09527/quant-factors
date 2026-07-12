#!/usr/bin/env python3
"""将 MLflow run 指标回填到 D1 ml_tasks.diagnostics.metrics，避免列表页 N+1 请求。"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO / "workers" / "factor-ideas"

METRIC_KEYS = (
    "mean_ic",
    "ic_ir",
    "mean_rank_ic",
    "rank_ic_ir",
    "n_periods",
    "ic_positive_ratio",
    "validation_profile_key",
    "label_kind",
    "horizon_bars",
)


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def run_d1(sql: str) -> list[dict]:
    proc = subprocess.run(
        [
            "npx",
            "wrangler",
            "d1",
            "execute",
            "quant-factors",
            "--remote",
            "--json",
            "--command",
            sql,
        ],
        cwd=WORKER_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    rows: list[dict] = []
    for block in json.loads(proc.stdout):
        rows.extend(block.get("results") or [])
    return rows


def read_worker_api() -> tuple[str, str]:
    base = (
        os.environ.get("FACTOR_API_BASE_URL", "").strip()
        or "https://quant-factors-factor-ideas.996died.workers.dev"
    ).rstrip("/")
    password = os.environ.get("AUTH_PASSWORD", "").strip()
    if not password:
        raise SystemExit("缺少 AUTH_PASSWORD（可用 vault kv/quant-factors/auth PASSWORD）")
    return base, password


def fetch_mlflow_run(run_id: str, retries: int = 4) -> dict:
    base, password = read_worker_api()
    url = f"{base}/api/mlflow/runs/{urllib.request.quote(run_id)}"
    last_error = "unknown"
    for attempt in range(retries):
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-m",
                "90",
                "-H",
                f"Authorization: Bearer {password}",
                url,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout)
        last_error = proc.stderr.strip() or f"curl exit {proc.returncode}"
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(last_error)


def parse_mlflow_metrics(payload: dict) -> dict:
    metrics_list = payload.get("run", {}).get("data", {}).get("metrics")
    if not isinstance(metrics_list, list):
        return {}
    raw: dict[str, float] = {}
    for item in metrics_list:
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        value = item.get("value")
        if isinstance(value, (int, float)):
            raw[key] = float(value)
    metrics: dict[str, float | str | int] = {}
    for key in METRIC_KEYS:
        if key not in raw:
            continue
        value = raw[key]
        if key in {"validation_profile_key", "label_kind"}:
            metrics[key] = str(value)
        elif key == "horizon_bars":
            metrics[key] = int(value)
        else:
            metrics[key] = value
    return metrics


def sql_quote_json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("'", "''")


def needs_backfill(diagnostics_raw: object) -> bool:
    if diagnostics_raw is None or diagnostics_raw == "":
        return True
    try:
        diagnostics = (
            diagnostics_raw
            if isinstance(diagnostics_raw, dict)
            else json.loads(str(diagnostics_raw))
        )
    except json.JSONDecodeError:
        return True
    metrics = diagnostics.get("metrics")
    if not isinstance(metrics, dict):
        return True
    return not any(
        isinstance(metrics.get(key), (int, float))
        for key in ("mean_ic", "mean_rank_ic")
    )


def main() -> int:
    load_dotenv(REPO / ".env")
    load_dotenv(WORKER_DIR / ".env")
    if not os.environ.get("AUTH_PASSWORD", "").strip():
        proc = subprocess.run(
            ["vault", "kv", "get", "-field=PASSWORD", "kv/quant-factors/auth"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            os.environ["AUTH_PASSWORD"] = proc.stdout.strip()

    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    rows = run_d1(
        "SELECT id, mlflow_run_id, diagnostics "
        "FROM ml_tasks "
        "WHERE business_type = 'factor_validation' "
        "AND status = 'success' "
        "AND mlflow_run_id IS NOT NULL "
        f"ORDER BY id DESC LIMIT {max(1, min(limit, 1000))};"
    )

    candidates = [row for row in rows if needs_backfill(row.get("diagnostics"))]
    print(f"扫描 {len(rows)} 条 success，需回填 {len(candidates)} 条", flush=True)

    updated = 0
    skipped = 0
    failed = 0
    for row in candidates:
        task_id = int(row["id"])
        run_id = str(row["mlflow_run_id"]).strip()
        try:
            payload = fetch_mlflow_run(run_id)
            metrics = parse_mlflow_metrics(payload)
            if not metrics:
                skipped += 1
                print(f"skip #{task_id}: MLflow 无指标", flush=True)
                continue

            diagnostics_raw = row.get("diagnostics")
            if isinstance(diagnostics_raw, dict):
                diagnostics = dict(diagnostics_raw)
            elif diagnostics_raw:
                diagnostics = json.loads(str(diagnostics_raw))
            else:
                diagnostics = {}
            diagnostics["metrics"] = metrics
            diag_sql = sql_quote_json(diagnostics)
            run_d1(
                "UPDATE ml_tasks "
                f"SET diagnostics = '{diag_sql}', updated_at = datetime('now') "
                f"WHERE id = {task_id};"
            )
            updated += 1
            print(f"updated #{task_id} run={run_id[:8]} mean_ic={metrics.get('mean_ic')}", flush=True)
            time.sleep(1.0)
        except RuntimeError as exc:
            failed += 1
            print(f"fail #{task_id}: {exc}", flush=True)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"fail #{task_id}: {exc}", flush=True)

    print(
        json.dumps(
            {"scanned": len(rows), "candidates": len(candidates), "updated": updated, "skipped": skipped, "failed": failed},
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
