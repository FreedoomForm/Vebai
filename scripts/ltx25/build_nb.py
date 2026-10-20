#!/usr/bin/env python3
"""Assemble the LTX-2.5 worker notebook from scripts/ltx25/* sources.

Cells:
  0 markdown  - header
  1 code      - scripts/ltx25/cell1_config.py
  2 code      - scripts/ltx25/cell2_setup.py
  3 code      - scripts/ltx25/cell3_models.py
  4 code      - scripts/ltx25/cell4_batch.py  (then patch_kernels.py injects
                kernel_terminal.py before `def feeder():`)
Writes kernels/rmc_studio_worker_real.ipynb (metadata preserved from the
existing notebook if present).
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # vebai/
SRC = ROOT / "scripts" / "ltx25"
OUT = ROOT / "kernels" / "rmc_studio_worker_real.ipynb"

# keep the original notebook metadata (kaggle whisper hints etc.)
meta = {}
if OUT.exists():
    try:
        meta = json.loads(OUT.read_text(encoding="utf-8")).get("metadata", {})
    except Exception:
        meta = {}

def code_cell(path: Path):
    src = path.read_text(encoding="utf-8")
    return {"cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": src.splitlines(keepends=True)}

md = (SRC / "cell0_header.md").read_text(encoding="utf-8")
nb = {
    "cells": [
        {"cell_type": "markdown", "metadata": {}, "source": md.splitlines(keepends=True)},
        code_cell(SRC / "cell1_config.py"),
        code_cell(SRC / "cell2_setup.py"),
        code_cell(SRC / "cell3_models.py"),
        code_cell(SRC / "cell4_batch.py"),
    ],
    "metadata": meta,
    "nbformat": 4,
    "nbformat_minor": 5,
}

OUT.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(nb['cells'])} cells)")

# syntax check of every code cell
import ast
for name in ("cell1_config.py", "cell2_setup.py", "cell3_models.py", "cell4_batch.py"):
    ast.parse((SRC / name).read_text(encoding="utf-8"), filename=name)
    print(f"  syntax OK: {name}")
