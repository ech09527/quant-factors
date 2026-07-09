"""Jupyter server 选取逻辑测试。"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.run_d1_validation_batch import select_jupyter_server


def test_select_jupyter_server_falls_back_when_preferred_disabled() -> None:
    servers = [
        {"key": "lynas-pub", "enabled": True},
        {"key": "other", "enabled": True},
    ]
    picked = select_jupyter_server(servers, preferred_key="lynas")
    assert picked["key"] == "lynas-pub"


def test_select_jupyter_server_uses_preferred_when_present() -> None:
    servers = [{"key": "lynas-pub"}, {"key": "lynas"}]
    picked = select_jupyter_server(servers, preferred_key="lynas-pub")
    assert picked["key"] == "lynas-pub"
