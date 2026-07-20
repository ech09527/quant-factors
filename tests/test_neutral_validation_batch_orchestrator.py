"""neutral_validation Prefect flow 冒烟测试。"""

from __future__ import annotations

import ast
from pathlib import Path


def test_neutral_validation_flow_is_valid_python():
    root = Path(__file__).resolve().parent.parent
    src = root / "prefect/flows/neutral_validation.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    names = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    assert "run_neutral_validation" in names
    assert "claim_neutral_validation" in names
    assert "attach_neutral_flow_run" in names
    text = src.read_text(encoding="utf-8")
    assert "run_deployment" not in text
    assert 'name="neutral_validation"' in text or "name='neutral_validation'" in text


def test_prefect_yaml_registers_neutral_validation():
    text = (Path(__file__).resolve().parent.parent / "prefect/prefect.yaml").read_text(
        encoding="utf-8"
    )
    assert "neutral_validation.py:run_neutral_validation" in text
    assert "*/5 * * * *" in text
    assert "neutral-validation" in text or "neutral_validation" in text
    assert "child_deployment" not in text


def test_worker_exposes_claim_and_attach_apis():
    root = Path(__file__).resolve().parent.parent
    main = (root / "workers/factor-ideas/src/worker-main.js").read_text(encoding="utf-8")
    assert "/api/workflow/factor-neutral-validations/claim-batch" in main
    assert "/api/workflow/factor-neutral-validations/attach-flow-run" in main
    assert "dispatchFactorNeutralValidationViaPrefect(env)" not in main.split("scheduled")[1].split("async fetch")[0]


def test_old_batch_flow_removed():
    root = Path(__file__).resolve().parent.parent
    assert not (root / "prefect/flows/neutral_validation_batch.py").exists()
