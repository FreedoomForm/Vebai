#!/usr/bin/env python3
"""Embed scripts/kernel_terminal.py into both Kaggle worker notebooks and hook
mode 'cmd' / 'merge' entries into their feeder loops. Idempotent: running it
twice is safe (anchors disappear after the first successful patch)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE = (ROOT / "scripts" / "kernel_terminal.py").read_text(encoding="utf-8")

REAL = ROOT / "kernels" / "rmc_studio_worker_real.ipynb"
TEST = ROOT / "kernels" / "rmc_studio_worker_test.ipynb"


def load(path: Path):
    nb = json.loads(path.read_text(encoding="utf-8"))
    return nb, "".join(nb["cells"][0]["source"] if len(nb["cells"]) == 1
                       else nb["cells"][4]["source"])


def save(path: Path, nb, src: str):
    cell = nb["cells"][0] if len(nb["cells"]) == 1 else nb["cells"][4]
    cell["source"] = src.splitlines(keepends=True)
    path.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")


def insert_before(src: str, anchor: str, block: str) -> str:
    if block.strip()[:40] in src:
        print(f"  already patched (module), skip")
        return src
    i = src.index(anchor)
    return src[:i] + block + "\n\n" + src[i:]


def replace_once(src: str, old: str, new: str, tag: str) -> str:
    if old not in src:
        if new in src:
            print(f"  already patched ({tag}), skip")
            return src
        raise SystemExit(f"ANCHOR NOT FOUND: {tag}")
    return src.replace(old, new, 1)


def patch_real():
    print(f"patching {REAL.name} (cell 4)")
    nb, src = load(REAL)
    src = insert_before(src, "def feeder():", MODULE)

    old = (
        "        accepted = False\n"
        "        for e in fresh:\n"
        "            jid = str(e.get(\"job_id\") or f\"n{e.get('num')}\")\n"
        "            if test_batch:\n"
    )
    new = (
        "        accepted = False\n"
        "        for e in fresh:\n"
        "            jid = str(e.get(\"job_id\") or f\"n{e.get('num')}\")\n"
        "            if e.get(\"mode\") in (\"cmd\", \"merge\"):\n"
        "                try:\n"
        "                    handle_special(e, base, state_dict=state[\"shots\"],\n"
        "                                   save_fn=save_state, push_fn=push_insurance,\n"
        "                                   out_store=OUT_STORE, seen=SEEN_JOBS)\n"
        "                    accepted = True\n"
        "                except Exception as exc:\n"
        "                    with state_lock:\n"
        "                        state[\"shots\"][jid] = {\"status\": \"failed\",\n"
        "                            \"error\": f\"{e.get('mode')}: {type(exc).__name__}: {exc}\"[:600]}\n"
        "                        save_state()\n"
        "                    push_insurance(f\"special failed {jid}\")\n"
        "                    print(f\"[special] {jid} FAILED: {exc}\", flush=True)\n"
        "                SEEN_JOBS.add(jid)\n"
        "                LAST_WORK[\"t\"] = time.time()\n"
        "                continue\n"
        "            if test_batch:\n"
    )
    src = replace_once(src, old, new, "real feeder hook")
    save(REAL, nb, src)
    print("  real worker patched")


def patch_test():
    print(f"patching {TEST.name} (cell 0)")
    nb, src = load(TEST)
    src = insert_before(src, "started = time.time()", MODULE)

    old = (
        "    for e in fresh:\n"
        "        jid = str(e.get(\"job_id\") or f\"n{e.get('num')}\")\n"
        "        try:\n"
        "            dest = render_stub(e)\n"
    )
    new = (
        "    for e in fresh:\n"
        "        jid = str(e.get(\"job_id\") or f\"n{e.get('num')}\")\n"
        "        if e.get(\"mode\") in (\"cmd\", \"merge\"):\n"
        "            try:\n"
        "                handle_special(e, base, state_dict=STATE[\"jobs\"],\n"
        "                               save_fn=(lambda: None), push_fn=push_outputs,\n"
        "                               out_store=OUT, seen=SEEN)\n"
        "            except Exception as exc:\n"
        "                STATE[\"jobs\"][jid] = {\"status\": \"failed\",\n"
        "                    \"error\": f\"{e.get('mode')}: {type(exc).__name__}: {exc}\"[:600]}\n"
        "                push_outputs(f\"special failed {jid}\")\n"
        "                print(f\"job {jid}: special FAILED: {exc}\", flush=True)\n"
        "            SEEN.add(jid)\n"
        "            last_work = time.time()\n"
        "            continue\n"
        "        try:\n"
        "            dest = render_stub(e)\n"
    )
    src = replace_once(src, old, new, "test worker hook")
    save(TEST, nb, src)
    print("  test worker patched")


if __name__ == "__main__":
    if "test" in sys.argv:
        patch_test()
    elif "real" in sys.argv:
        patch_real()
    else:
        patch_real()
        patch_test()
    # syntax check of the embedded module in isolation
    import ast
    ast.parse(MODULE)
    print("module syntax OK")
