"""compute_ic_series 与 mlflow_logger 单元测试。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.compute_metrics import compute_ic_series, compute_metrics
from scripts.mlflow_logger import resolve_mlflow_config, slim_ic_series_for_artifact


def _make_cross_sectional_panel(n_times: int = 50, n_symbols: int = 40) -> pd.DataFrame:
    rows = []
    rng = np.random.default_rng(42)
    for t in range(n_times):
        open_time = 1_700_000_000_000 + t * 3_600_000
        factor_base = rng.normal(size=n_symbols)
        for i in range(n_symbols):
            factor = float(factor_base[i])
            fwd_ret = 0.01 * factor + rng.normal(scale=0.01)
            rows.append(
                {
                    "symbol": f"S{i:03d}",
                    "open_time": open_time,
                    "factor": factor,
                    "fwd_ret": float(fwd_ret),
                }
            )
    return pd.DataFrame(rows)


def test_compute_ic_series_cross_sectional():
    panel = _make_cross_sectional_panel()
    series = compute_ic_series(panel, "cross_sectional")
    assert series["period_axis"] == "open_time"
    assert series["n_points"] == 50
    assert len(series["points"]) == 50
    first = series["points"][0]
    assert "t" in first and "ic" in first and "rank_ic" in first and "n" in first


def test_compute_metrics_still_works():
    panel = _make_cross_sectional_panel()
    metrics = compute_metrics(panel, "cross_sectional")
    assert metrics["mean_ic"] > 0.5


def test_resolve_mlflow_config_from_env(monkeypatch):
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "https://dagshub.com/user/repo.mlflow")
    monkeypatch.setenv("MLFLOW_TRACKING_USERNAME", "user")
    monkeypatch.setenv("MLFLOW_TRACKING_PASSWORD", "token")
    config = resolve_mlflow_config()
    assert config["tracking_uri"].endswith(".mlflow")
    assert config["username"] == "user"
    assert config["experiment"] == "factor-validation"


def test_resolve_mlflow_config_missing_password():
    with pytest.raises(ValueError, match="凭证"):
        resolve_mlflow_config(
            {
                "tracking_uri": "https://dagshub.com/user/repo.mlflow",
                "username": "user",
                "password": "",
            }
        )


def test_slim_ic_series_for_artifact_drops_n_field():
    raw = {
        "period_axis": "open_time",
        "n_points": 1,
        "points": [{"t": "1", "ic": 0.1, "rank_ic": 0.2, "n": 99}],
    }
    slim = slim_ic_series_for_artifact(raw)
    assert slim is not None
    assert slim["points"][0] == {"t": "1", "ic": 0.1, "rank_ic": 0.2}
    assert "n" not in slim["points"][0]
