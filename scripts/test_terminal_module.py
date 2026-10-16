#!/usr/bin/env python3
"""Local smoke test for scripts/kernel_terminal.py (the code embedded into the
Kaggle workers): stateful shell, cmd record file, ffmpeg merge."""
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path("/home/z/my-project/vebai")
spec = importlib.util.spec_from_file_location("kernel_terminal", ROOT / "scripts" / "kernel_terminal.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f" | {extra}" if extra else ""))
    if not cond:
        fails.append(name)

# --- 1. PersistentShell: basic + statefulness
ws = Path(tempfile.mkdtemp()) / "term_test"
ws.mkdir(parents=True)
sh = mod.PersistentShell(ws)

out, rc, cwd = sh.run("echo hello_vebai", 30)
check("echo", rc == 0 and "hello_vebai" in out, f"rc={rc} out={out[:60]!r}")

out, rc, cwd = sh.run("mkdir -p demo && cd demo && echo x > f.txt", 30)
check("cd works", rc == 0 and cwd.endswith("demo"), f"cwd={cwd}")

out, rc, cwd = sh.run("pwd && echo $MYVAR", 30)
check("cwd persists", "demo" in out and cwd.endswith("demo"), f"out={out[:60]!r}")

out, rc, cwd = sh.run("export MYVAR=42", 30)
out, rc, cwd = sh.run("echo MYVAR=$MYVAR", 30)
check("env persists", "MYVAR=42" in out, f"out={out[:60]!r}")

out, rc, cwd = sh.run("sleep 999", 5)
check("timeout kills+respawns", rc == 124 and "timeout" in out, f"rc={rc}")

out, rc, cwd = sh.run("pwd", 30)
check("alive after timeout, cwd kept", rc == 0 and "demo" in out, f"out={out[:60]!r}")

# --- 2. run_cmd_entry writes a JSON record (no telegram cfg -> no mirror)
jobs = Path(tempfile.mkdtemp())
entry = {"job_id": "jobTEST123", "terminal_id": "testterm", "timeout_s": 20, "cmd": "echo record && whoami"}
rec, dest = mod.run_cmd_entry(entry, ws.parent, jobs)
saved = json.loads(dest.read_text(encoding="utf-8"))
check("cmd record file", dest.name == "cmd_jobTEST123.txt" and saved["exit_code"] == 0
      and "record" in saved["output"] and saved["terminal_id"] == "testterm", dest.name)

# --- 3. run_merge_entry: two 1s clips -> concat
base = Path(tempfile.mkdtemp())
a, b = base / "mergein_m1_1.mp4", base / "mergein_m1_2.mp4"
for p in (a, b):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                    "-i", "color=c=red:s=320x240:r=24:d=1", "-c:v", "libx264",
                    "-preset", "veryfast", str(p)], check=True, capture_output=True)
entry = {"job_id": "jobMERGE1", "mode": "merge", "input_files": [a.name, b.name]}
dest = mod.run_merge_entry(entry, base, jobs)
r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                    "-of", "csv=p=0", str(dest)], capture_output=True, text=True)
dur = float(r.stdout.strip() or 0)
check("merge concat", dest.is_file() and 1.8 <= dur <= 2.4, f"duration={dur:.2f}s size={dest.stat().st_size}")

# --- 4. handle_special merge path
state = {}
ok = mod.handle_special({"job_id": "jobMERGE2", "mode": "merge", "input_files": [a.name, b.name]},
                        base, state_dict=state, save_fn=lambda: None,
                        push_fn=lambda tag: None, out_store=jobs, seen=set())
check("handle_special merge", ok and state["jobMERGE2"]["status"] == "done")

print()
print("RESULT:", "ALL OK" if not fails else f"FAILURES: {fails}")
sys.exit(1 if fails else 0)
