#!/usr/bin/env python3
"""Resident headless terminal executor for vebai (GitHub Actions runner).

Claims queued TerminalCommands from the site API and executes each in bash
(cwd = persistent per-run workspace /tmp/ws, so cd / files / venvs survive
between commands). Command text, output and produced files NEVER reach the
(public) Actions logs - they travel between here and the site API only.

Resident mode (owner request 2026-10-18): the runner stays alive until the
~5h40m shift deadline, idling between commands. When the shift ends (or the
runner dies), the site's tick sees the stale heartbeat and dispatches a fresh
run - reconnect is automatic. Queue is drained continuously as commands
arrive; there is no per-run command cap anymore.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

SITE = (os.environ.get("SITE") or "https://vebai-six.vercel.app").rstrip("/")
SECRET = os.environ.get("SECRET") or ""
SESSION = os.environ.get("SESSION") or ""
CMDID = os.environ.get("CMDID") or ""
TMO_RAW = (os.environ.get("TMO") or "15").strip()
TMO = int(TMO_RAW) if TMO_RAW.isdigit() else 15
TMO = min(TMO, 30)

SHIFT_SECONDS = 340 * 60   # 5h40m shift, safely under the 6h GitHub job cap
IDLE_POLL = 10             # seconds between claim polls when queue is empty
WS = "/tmp/ws"             # persistent workspace for the whole shift

MIME = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv",
    ".zip": "application/zip", ".svg": "image/svg+xml", ".html": "text/html",
}
MAX_FILE = 3_000_000          # per-file inline cap (bytes)
MAX_TOTAL_B64 = 3_400_000     # total base64 budget for the callback body


def api(path: str, payload: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        SITE + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def collect_files(since_ts: float) -> list:
    """files created/modified inside the workspace since the command started"""
    files = []
    total = 0
    for root, _, names in os.walk(WS):
        for n in names:
            p = os.path.join(root, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_mtime < since_ts:
                continue
            sz = st.st_size
            b64len = (sz + 2) // 3 * 4
            if sz > MAX_FILE or total + b64len > MAX_TOTAL_B64:
                continue
            try:
                with open(p, "rb") as f:
                    b = f.read()
            except OSError:
                continue
            total += b64len
            ext = os.path.splitext(n)[1].lower()
            files.append({
                "path": os.path.relpath(p, WS),
                "b64": base64.b64encode(b).decode(),
                "mime": MIME.get(ext, "application/octet-stream"),
            })
    return files


def pack_result(cmd_id: str, rc: int, since_ts: float) -> dict:
    out = ""
    err = ""
    p_out = f"/tmp/.out-{cmd_id[:8]}"
    p_err = f"/tmp/.err-{cmd_id[:8]}"
    if os.path.exists(p_out):
        with open(p_out, encoding="utf-8", errors="replace") as f:
            out = f.read()[-12000:]
    if os.path.exists(p_err):
        with open(p_err, encoding="utf-8", errors="replace") as f:
            data = f.read()
        if data.strip():
            err = data[-3000:]
    output = out + (("\n[stderr]\n" + err) if err else "")
    return {
        "secret": SECRET, "session": SESSION, "cmdId": cmd_id,
        "status": "done" if rc == 0 else "failed", "exitCode": rc,
        "output": output, "files": collect_files(since_ts),
    }


def post_result(cmd_id: str, rc: int, since_ts: float) -> bool:
    """best effort: retry a few times; a lost result self-heals on the site
    (stuck-command reclaim) but only if we do not keep the shift alive"""
    for attempt in range(3):
        try:
            r = api("/api/terminal/gh/result", pack_result(cmd_id, rc, since_ts))
            print("cmd", cmd_id[:8], "exit", rc, "posted", r.get("ok"), flush=True)
            return True
        except Exception as e:
            print(f"result post failed ({attempt + 1}/3):", type(e).__name__, flush=True)
            time.sleep(10)
    return False


def main() -> int:
    if not SECRET or not SESSION:
        print("missing SECRET/SESSION env")
        return 2
    os.makedirs(WS, exist_ok=True)
    deadline = time.time() + SHIFT_SECONDS
    specific = CMDID
    done = 0
    print(f"resident shift start: workspace {WS}, shift {SHIFT_SECONDS // 60} min", flush=True)
    while time.time() < deadline:
        try:
            d = api("/api/terminal/gh/claim",
                    {"secret": SECRET, "session": SESSION, "cmd": specific})
        except Exception as e:
            # transient site/network hiccup: stay resident, retry shortly
            print("claim failed:", type(e).__name__, flush=True)
            specific = ""
            time.sleep(20)
            continue
        specific = ""
        c = (d.get("cmd") or {}) if d.get("ok") else {}
        if not c.get("id"):
            remaining = int(deadline - time.time())
            if remaining % 600 < IDLE_POLL + 1:
                print(f"idle, ~{remaining // 60} min left in shift", flush=True)
            time.sleep(IDLE_POLL)
            continue

        cmd_id = c["id"]
        done += 1
        since_ts = time.time() - 1
        os.makedirs("/tmp/cmds", exist_ok=True)
        script = f"/tmp/cmds/{cmd_id[:8]}.sh"
        with open(script, "w") as f:
            f.write(str(c.get("command", "")))
        rc = 1
        try:
            with open(f"/tmp/.out-{cmd_id[:8]}", "w") as fo, \
                 open(f"/tmp/.err-{cmd_id[:8]}", "w") as fe:
                p = subprocess.run(["bash", script], cwd=WS, stdin=subprocess.DEVNULL,
                                   stdout=fo, stderr=fe, timeout=TMO * 60)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            rc = 124
        except Exception:
            rc = 127
        post_result(cmd_id, rc, since_ts)
    print(f"resident shift over: {done} command(s) executed this run", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
