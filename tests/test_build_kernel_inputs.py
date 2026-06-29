"""build_kernel_inputs agent_generate 模式测试。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.build_kernel_inputs import build_inputs  # noqa: E402


def test_agent_generate_requires_schema(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "schemas").mkdir(parents=True)
    (repo / "schemas" / "idea-schema.json").write_text(
        json.dumps({"type": "object"}),
        encoding="utf-8",
    )
    try:
        build_inputs(
            dataset_slug="owner/data",
            max_ideas=2,
            mode="agent_generate",
            existing_titles=[],
            forbidden_titles=[],
            target_file="futures/um/klines/1h.parquet",
            repo=repo,
        )
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "schema.json" in str(exc)


def test_agent_generate_includes_dataset_schema(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "schemas").mkdir(parents=True)
    (repo / "schemas" / "idea-schema.json").write_text(
        json.dumps({"type": "object", "properties": {"title": {"type": "string"}}}),
        encoding="utf-8",
    )
    dataset_dir = repo / "datasets" / "owner__data"
    dataset_dir.mkdir(parents=True)
    schema = {"slug": "owner/data", "files": []}
    (dataset_dir / "schema.json").write_text(json.dumps(schema), encoding="utf-8")

    payload = build_inputs(
        dataset_slug="owner/data",
        max_ideas=2,
        mode="agent_generate",
        existing_titles=["已有因子"],
        forbidden_titles=[],
        target_file="futures/um/klines/1h.parquet",
        repo=repo,
    )
    assert payload["mode"] == "agent_generate"
    assert payload["dataset_schema"]["slug"] == "owner/data"
    assert payload["existing_titles"] == ["已有因子"]
