"""compute_metrics 单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.compute_metrics import compute_cross_sectional_metrics, compute_metrics


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


def test_cross_sectional_metrics_positive_ic():
    panel = _make_cross_sectional_panel()
    metrics = compute_cross_sectional_metrics(panel)
    assert metrics["n_periods"] == 50
    assert metrics["mean_ic"] > 0.5
    assert metrics["ic_ir"] is not None


def test_compute_metrics_wrapper():
    panel = _make_cross_sectional_panel()
    metrics = compute_metrics(panel, "cross_sectional")
    assert "mean_rank_ic" in metrics
