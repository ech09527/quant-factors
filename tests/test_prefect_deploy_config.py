"""Prefect deployment 使用 git clone 而非本地目录。"""

from __future__ import annotations

from pathlib import Path


def test_prefect_yaml_uses_git_clone_pull():
    text = (Path(__file__).resolve().parents[1] / "prefect" / "prefect.yaml").read_text(
        encoding="utf-8"
    )
    assert "prefect.deployments.steps.git_clone" in text
    assert "git@github.com:ech09527/quant-factors.git" in text
    assert "/prefect" in text
    assert "/root/quant-factors" not in text
