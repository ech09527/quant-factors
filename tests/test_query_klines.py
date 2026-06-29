"""query_klines.py 只读 SQL 校验测试。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(
    0,
    str(REPO_ROOT / "explorations" / "generate-factor-ideas"),
)

from query_klines import ensure_limit, validate_read_only_sql  # noqa: E402


def test_validate_accepts_select() -> None:
    validate_read_only_sql("SELECT symbol FROM klines LIMIT 10")


def test_validate_accepts_with_cte() -> None:
    validate_read_only_sql(
        "WITH t AS (SELECT symbol FROM klines LIMIT 5) SELECT * FROM t"
    )


def test_validate_rejects_insert() -> None:
    with pytest.raises(ValueError, match="只读"):
        validate_read_only_sql("INSERT INTO klines VALUES (1)")


def test_validate_rejects_non_select() -> None:
    with pytest.raises(ValueError, match="SELECT"):
        validate_read_only_sql("SHOW TABLES")


def test_ensure_limit_appends() -> None:
    sql = ensure_limit("SELECT 1")
    assert "LIMIT 5000" in sql


def test_ensure_limit_preserves_existing() -> None:
    sql = ensure_limit("SELECT 1 LIMIT 100")
    assert sql.endswith("LIMIT 100")
