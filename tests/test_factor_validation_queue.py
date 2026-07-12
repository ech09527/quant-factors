from pathlib import Path


def test_factor_validation_errors_module_exists():
    src = (Path(__file__).resolve().parents[1] / "workers/factor-ideas/src/factor-validation-errors.js").read_text(
        encoding="utf-8"
    )
    assert "isPermanentFactorValidationError" in src
    assert "resolveFactorValidationTerminalStatus" in src


def test_pending_queue_deprioritizes_failed():
    src = (Path(__file__).resolve().parents[1] / "workers/factor-ideas/src/factor-validation-db.js").read_text(
        encoding="utf-8"
    )
    assert "WHEN 'failed' THEN 2" in src


def test_signal_sql_rejects_dsl_leak():
    src = (Path(__file__).resolve().parents[1] / "workers/factor-ideas/src/factor-sql-validate.js").read_text(
        encoding="utf-8"
    )
    assert "detectDslLeakInSignalSql" in src
    assert "Div|Add|Sub" in src
