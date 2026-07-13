from pathlib import Path


def test_jupyter_execution_callback_python_wraps_results():
    root = Path(__file__).resolve().parents[1]
    src = (root / "workers/factor-ideas/src/jupyter-execution-callback-python.js").read_text(
        encoding="utf-8"
    )
    assert "wrapJupyterExecutionCodeWithHttpCallback" in src
    assert "_notify_worker_execution_done" in src
    assert "_start_execution_heartbeat" in src
    assert "/api/jupyter-executions/callback" in src
    assert "/api/jupyter-executions/heartbeat" in src


def test_jupyter_execution_runtime_modules_exist():
    root = Path(__file__).resolve().parents[1]
    assert (root / "workers/factor-ideas/src/jupyter-execution-runtime.js").is_file()
    assert (root / "workers/factor-ideas/src/jupyter-execution-callback-api.js").is_file()
    runtime = (root / "workers/factor-ideas/src/jupyter-execution-runtime.js").read_text(encoding="utf-8")
    assert "dispatchJupyterExecution" in runtime
    assert "handleJupyterExecutionCallback" in runtime
    assert "handleJupyterExecutionHeartbeat" in runtime
    assert "submitExecuteAsync" in runtime


def test_jupyter_execution_code_uses_callback_wrapper():
    src = (
        Path(__file__).resolve().parents[1]
        / "workers/factor-ideas/src/jupyter-execution-code.js"
    ).read_text(encoding="utf-8")
    assert "wrapJupyterExecutionCodeWithHttpCallback" in src
    assert "buildJupyterExecutionCallbackConfig" in src


def test_jupyter_execution_runtime_uses_business_completion_handler():
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "workers/factor-ideas/src/jupyter-execution-runtime.js").read_text(
        encoding="utf-8"
    )
    executor = (root / "workers/factor-ideas/src/jupyter-executor.js").read_text(encoding="utf-8")
    worker = (root / "workers/factor-ideas/src/worker-main.js").read_text(encoding="utf-8")
    assert "applyMarkerCompletion" not in runtime
    assert "handleJupyterExecutionBusinessCompletion" in executor
    assert "handleJupyterExecutionCallbackApiRequest" in worker
