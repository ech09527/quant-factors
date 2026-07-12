"""两阶段 report 语义测试。"""

from __future__ import annotations

import subprocess
from pathlib import Path


def test_should_notify_coordinator_report_phases():
    root = Path(__file__).resolve().parent.parent
    proc = subprocess.run(
        ["node", str(root / "tests/factor_validation_report_phases_test.mjs")],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "OK" in proc.stdout
