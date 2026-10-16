#!/usr/bin/env python3
"""Regenerate src/lib/kernels.ts from kernels/*.ipynb.

The notebooks live IN THE REPO (kernels/). Edit them there, then run:
    python3 scripts/embed_kernels.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
names = [
    "rmc_studio_real.ipynb",
    "rmc_studio_test.ipynb",
    "rmc_studio_worker_real.ipynb",
    "rmc_studio_worker_test.ipynb",
]

with open(os.path.join(ROOT, "src", "lib", "kernels.ts"), "w", encoding="utf-8") as f:
    f.write("// AUTO-GENERATED from kernels/*.ipynb — do not edit by hand.\n")
    f.write("// Kaggle notebook sources pushed verbatim via the REST API.\n")
    f.write("// Regenerate: python3 scripts/embed_kernels.py\n")
    for n in names:
        raw = open(os.path.join(ROOT, "kernels", n), encoding="utf-8").read()
        var = n.replace(".ipynb", "").upper()
        f.write(f"export const KERNEL_{var} = {json.dumps(raw)};\n")
print("kernels.ts regenerated")
