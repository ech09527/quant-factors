"""Jupyter kernel 账本对账单元测试。"""

from __future__ import annotations

import subprocess
from pathlib import Path


def test_jupyter_kernel_reconcile_audit_script():
    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        ["node", str(root / "tests/jupyter_kernel_reconcile_test.mjs")],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "OK" in proc.stdout
