#!/usr/bin/env python3
"""导出 Jupyter 评估引擎源码，供 Cloudflare Worker 打包进 bundle。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.bundle_evaluate_kernel import _build_bundled_engine_source


def main() -> int:
    repo = REPO_ROOT
    engine_src = _build_bundled_engine_source(repo)
    assets_dir = repo / "workers" / "factor-ideas" / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    engine_path = assets_dir / "bundled-eval-engine.py.txt"
    engine_path.write_text(engine_src, encoding="utf-8")

    meta = {
        "engine_bytes": len(engine_src.encode("utf-8")),
        "engine_path": str(engine_path.relative_to(repo)),
    }
    meta_path = assets_dir / "bundled-eval-engine.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {engine_path} ({meta['engine_bytes']} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
