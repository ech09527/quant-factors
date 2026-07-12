#!/usr/bin/env python3
"""在 DagsHub MLflow 上创建/确认测试因子验证实验。"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.mlflow_logger import TEST_FACTOR_VALIDATION_EXPERIMENT, resolve_mlflow_config


def main() -> int:
    load_dotenv(ROOT / ".env")
    config = resolve_mlflow_config({"experiment": TEST_FACTOR_VALIDATION_EXPERIMENT})
    import mlflow

    from scripts.mlflow_logger import _apply_mlflow_env

    _apply_mlflow_env(config)
    exp = mlflow.set_experiment(TEST_FACTOR_VALIDATION_EXPERIMENT)
    print(
        {
            "ok": True,
            "experiment": TEST_FACTOR_VALIDATION_EXPERIMENT,
            "experiment_id": exp.experiment_id,
            "tracking_uri": config["tracking_uri"],
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
