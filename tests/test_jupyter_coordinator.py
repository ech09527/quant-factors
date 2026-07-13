from pathlib import Path


def test_jupyter_execution_modules_exist():
    root = Path(__file__).resolve().parents[1]
    files = [
        "workers/factor-ideas/src/jupyter-coordinator-do.js",
        "workers/factor-ideas/src/jupyter-execution-db.js",
        "workers/factor-ideas/src/jupyter-execution-dispatch.js",
        "workers/factor-ideas/migrations/0010_jupyter_executions.sql",
    ]
    for rel in files:
        assert (root / rel).is_file(), rel


def test_jupyter_executor_dispatches_directly():
    root = Path(__file__).resolve().parents[1]
    src = (root / "workers/factor-ideas/src/jupyter-executor.js").read_text(encoding="utf-8")
    assert "dispatchJupyterExecution" in src
    assert "jupyter-execution-queue.js" not in src


def test_coordinator_exposes_submit_endpoint():
    coordinator = (
        Path(__file__).resolve().parents[1]
        / "workers/factor-ideas/src/jupyter-coordinator-do.js"
    ).read_text(encoding="utf-8")
    assert 'path === "/submit"' in coordinator
    assert "dispatchJupyterExecution" in coordinator
    assert "getExecutionCapacity" in coordinator
    assert "submitExecution" not in coordinator
    assert "watchExecutionViaWebSocket" not in coordinator


def test_wrangler_prefect_execution_backend():
    text = (Path(__file__).resolve().parents[1] / "workers/factor-ideas/wrangler.toml").read_text(
        encoding="utf-8"
    )
    assert 'EXECUTION_BACKEND = "prefect"' in text
    assert "JUPYTER_EXECUTION_QUEUE" not in text
    assert "[[queues.producers]]" not in text
    assert "[[queues.consumers]]" not in text


def test_wrangler_jupyter_coordinator_do_deleted():
    text = (Path(__file__).resolve().parents[1] / "workers/factor-ideas/wrangler.toml").read_text(
        encoding="utf-8"
    )
    assert "JUPYTER_COORDINATOR" not in text
    assert "deleted_classes" in text
    assert "JupyterServerCoordinator" in text
    assert 'JUPYTER_EXECUTION_VIA_DO = "0"' in text


def test_timed_out_execution_query_uses_julianday():
    src = (
        Path(__file__).resolve().parents[1]
        / "workers/factor-ideas/src/jupyter-execution-db.js"
    ).read_text(encoding="utf-8")
    assert "listTimedOutRunningExecutions" in src
    assert "julianday(submitted_at)" in src
    assert "listOrphanedRunningExecutions" in src


def test_kernel_reconcile_modules_exist():
    root = Path(__file__).resolve().parents[1]
    assert (root / "workers/factor-ideas/src/jupyter-kernel-reconcile.js").is_file()
    assert (root / "workers/factor-ideas/src/jupyter-kernel-ledger-audit.js").is_file()
    assert (root / "workers/factor-ideas/src/jupyter-websocket-monitor.js").is_file()
    reconcile = (root / "workers/factor-ideas/src/jupyter-kernel-reconcile.js").read_text(
        encoding="utf-8"
    )
    assert "reconcileJupyterKernelLedger" in reconcile
    coordinator = (root / "workers/factor-ideas/src/jupyter-coordinator-do.js").read_text(
        encoding="utf-8"
    )
    assert "/reconcile" in coordinator
    assert "submitExecuteStart" in (root / "workers/factor-ideas/src/jupyter-async.js").read_text(
        encoding="utf-8"
    )
    assert "handleJupyterExecutionBusinessCompletion" in (
        root / "workers/factor-ideas/src/jupyter-execution-business-handlers.js"
    ).read_text(encoding="utf-8")
