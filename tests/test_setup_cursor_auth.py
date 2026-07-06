"""Cursor CLI 凭据优先级测试。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.cursor_auth import (  # noqa: E402
    build_kernel_cursor_inputs,
    resolve_cursor_api_key,
    resolve_cursor_auth_json,
    setup_cursor_auth,
)


def test_resolve_prefers_kernel_inputs_over_env(monkeypatch) -> None:
    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "env"}))
    inputs = {"cursor_auth_json": json.dumps({"source": "runner"})}

    assert resolve_cursor_auth_json(inputs=inputs) == json.dumps({"source": "runner"})


def test_resolve_falls_back_to_env(monkeypatch) -> None:
    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "env"}))

    assert resolve_cursor_auth_json(inputs={}) == json.dumps({"source": "env"})


def test_resolve_api_key_from_inputs(monkeypatch) -> None:
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)
    inputs = {"cursor_api_key": "sk-runner-key"}

    assert resolve_cursor_api_key(inputs=inputs) == "sk-runner-key"


def test_setup_prefers_auth_json_over_api_key(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "auth-json"}))
    monkeypatch.setenv("CURSOR_API_KEY", "sk-should-not-win")
    auth_path = tmp_path / "auth.json"
    monkeypatch.setattr(
        "scripts.cursor_auth.DEFAULT_AUTH_PATH",
        auth_path,
    )

    assert setup_cursor_auth() is True
    assert json.loads(auth_path.read_text(encoding="utf-8")) == {"source": "auth-json"}


def test_setup_uses_api_key_when_auth_json_missing(monkeypatch) -> None:
    monkeypatch.delenv("CURSOR_AUTH_JSON", raising=False)
    monkeypatch.setenv("CURSOR_API_KEY", "sk-test-key")

    assert setup_cursor_auth() is True
    assert resolve_cursor_api_key() == "sk-test-key"


def test_setup_falls_back_to_existing_auth_file(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CURSOR_AUTH_JSON", raising=False)
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"source": "local-file"}), encoding="utf-8")
    monkeypatch.setattr(
        "scripts.cursor_auth.DEFAULT_AUTH_PATH",
        auth_path,
    )

    assert setup_cursor_auth() is True


def test_setup_returns_false_when_no_credentials(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CURSOR_AUTH_JSON", raising=False)
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)
    auth_path = tmp_path / "missing-auth.json"
    monkeypatch.setattr(
        "scripts.cursor_auth.DEFAULT_AUTH_PATH",
        auth_path,
    )

    assert setup_cursor_auth() is False


def test_build_kernel_inputs_from_auth_json(monkeypatch) -> None:
    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "github-secret"}))
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)

    assert build_kernel_cursor_inputs() == {
        "cursor_auth_json": json.dumps({"source": "github-secret"})
    }


def test_build_kernel_inputs_from_api_key(monkeypatch) -> None:
    monkeypatch.delenv("CURSOR_AUTH_JSON", raising=False)
    monkeypatch.setenv("CURSOR_API_KEY", "sk-github-key")

    assert build_kernel_cursor_inputs() == {"cursor_api_key": "sk-github-key"}


def test_kernel_setup_prefers_injected_auth_json(monkeypatch, tmp_path: Path) -> None:
    import shutil

    kernel_dir = tmp_path / "kernel"
    kernel_dir.mkdir()
    shutil.copy2(REPO_ROOT / "scripts" / "cursor_auth.py", kernel_dir / "cursor_auth.py")
    shutil.copy2(
        REPO_ROOT / "explorations" / "generate-factor-ideas" / "generate_factor_ideas.py",
        kernel_dir / "generate_factor_ideas.py",
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    sys.path.insert(0, str(kernel_dir))
    from generate_factor_ideas import setup_cursor_auth as kernel_setup  # noqa: E402

    monkeypatch.setenv("CURSOR_AUTH_JSON", json.dumps({"source": "kaggle-secret"}))
    inputs = {"cursor_auth_json": json.dumps({"source": "github-secret"})}

    assert kernel_setup(inputs) is True

    auth_path = tmp_path / ".config" / "cursor" / "auth.json"
    assert json.loads(auth_path.read_text(encoding="utf-8")) == {"source": "github-secret"}
