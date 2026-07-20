"""运行 factor_neutral_validation_selection JS 测试。"""

from __future__ import annotations

import subprocess
from pathlib import Path


def test_factor_neutral_validation_selection_js():
    root = Path(__file__).resolve().parent.parent
    subprocess.run(
        ["node", "--test", str(root / "tests/factor_neutral_validation_selection_test.mjs")],
        check=True,
    )
