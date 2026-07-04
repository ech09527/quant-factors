"""setup_cursor_auth 优先级测试。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "explorations" / "generate-factor-ideas"))

from generate_factor_ideas import setup_cursor_auth  # noqa: E402


def test_prefers_kernel_inputs_over_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "kaggle-secret"}))
    inputs = {"cursor_auth_json": json.dumps({"source": "github-secret"})}

    assert setup_cursor_auth(inputs) is True

    auth_path = Path.home() / ".config" / "cursor" / "auth.json"
    assert json.loads(auth_path.read_text(encoding="utf-8")) == {"source": "github-secret"}


def test_falls_back_to_env_when_kernel_inputs_missing(monkeypatch) -> None:
    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "kaggle-secret"}))

    assert setup_cursor_auth({}) is True

    auth_path = Path.home() / ".config" / "cursor" / "auth.json"
    assert json.loads(auth_path.read_text(encoding="utf-8")) == {"source": "kaggle-secret"}


def test_returns_false_when_no_auth(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CURSOR_AUTH_JSON", raising=False)

    assert setup_cursor_auth({}) is False
