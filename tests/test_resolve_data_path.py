"""数据路径解析（QUANT_DATA_PATH / Kaggle）单元测试。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import (  # noqa: E402
    DEFAULT_TARGET_FILE,
    resolve_data_path,
    resolve_quant_data_path,
)


def test_resolve_quant_data_path_from_env(monkeypatch):
    monkeypatch.setenv("QUANT_DATA_PATH", "/data/root")
    assert (
        resolve_quant_data_path(DEFAULT_TARGET_FILE)
        == "/data/root/quant-data/futures/um/klines/1h.parquet"
    )


def test_resolve_quant_data_path_missing_env(monkeypatch):
    monkeypatch.delenv("QUANT_DATA_PATH", raising=False)
    assert resolve_quant_data_path(DEFAULT_TARGET_FILE) is None


def test_resolve_data_path_prefers_override(monkeypatch):
    monkeypatch.setenv("QUANT_DATA_PATH", "/data/root")
    assert (
        resolve_data_path(
            "owner/dataset",
            DEFAULT_TARGET_FILE,
            data_path_override="/custom/file.parquet",
        )
        == "/custom/file.parquet"
    )


def test_resolve_data_path_uses_quant_env(monkeypatch):
    monkeypatch.setenv("QUANT_DATA_PATH", "/mnt/quant")
    assert (
        resolve_data_path("owner/dataset", DEFAULT_TARGET_FILE)
        == "/mnt/quant/quant-data/futures/um/klines/1h.parquet"
    )


def test_resolve_data_path_falls_back_to_kaggle(monkeypatch):
    monkeypatch.delenv("QUANT_DATA_PATH", raising=False)
    path = resolve_data_path("yhydev97/quant-data", DEFAULT_TARGET_FILE)
    assert path.endswith("futures/um/klines/1h.parquet")
    assert "/kaggle/input/" in path
