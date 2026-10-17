#!/usr/bin/env python3
"""Headless terminal executor for vebai (GitHub Actions runner).

Claims queued TerminalCommands from the site API, executes each in a clean
bash environment (cwd = fresh scratch dir), and posts stdout/stderr plus any
produced files back. Command text and output never reach the (public) Actions
logs - they live only in /tmp and travel between here and the site API.

Loop: up to 10 commands or 29 minutes per workflow run.
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

MIME = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv",
    ".zip": "application/zip", ".svg": "image/svg+xml", ".html": "text/html",
}
MAX_FILE = 3_000_000          # per-file inline cap (bytes)
MAX_TOTAL_B64 = 3_400_000     # total base64 budget for the callback body


def api(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        SITE + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def collect_files(workdir: str) -> list:
    files = []
    total = 0
    for root, _, names in os.walk(workdir):
        for n in names:
            if n in (".stdout", ".stderr"):
                continue
            p = os.path.join(root, n)
            try:
                sz = os.path.getsize(p)
            except OSError:
                continue
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
                "path": os.path.relpath(p, workdir),
                "b64": base64.b64encode(b).decode(),
                "mime": MIME.get(ext, "application/octet-stream"),
            })
    return files


def pack_result(cmd_id: str, rc: int, workdir: str) -> dict:
    out = ""
    err = ""
    p_out = os.path.join(workdir, ".stdout")
    p_err = os.path.join(workdir, ".stderr")
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
        "output": output, "files": collect_files(workdir),
    }


def main() -> int:
    if not SECRET or not SESSION:
        print("missing SECRET/SESSION env")
        return 2
    deadline = time.time() + 29 * 60
    specific = CMDID
    for _ in range(10):
        if time.time() >= deadline:
            break
        try:
            d = api("/api/terminal/gh/claim",
                    {"secret": SECRET, "session": SESSION, "cmd": specific})
        except Exception as e:
            print("claim failed:", type(e).__name__)
            return 1
        specific = ""
        c = (d.get("cmd") or {}) if d.get("ok") else {}
        if not c.get("id"):
            print("queue empty - done")
            return 0
        cmd_id = c["id"]
        workdir = "/tmp/task-" + cmd_id[:8]
        os.makedirs(workdir, exist_ok=True)
        script = "/tmp/task-" + cmd_id[:8] + ".sh"
        with open(script, "w") as f:
            f.write(str(c.get("command", "")))
        rc = 1
        try:
            with open(os.path.join(workdir, ".stdout"), "w") as fo, \
                 open(os.path.join(workdir, ".stderr"), "w") as fe:
                p = subprocess.run(["bash", script], cwd=workdir, stdin=subprocess.DEVNULL,
                                   stdout=fo, stderr=fe, timeout=TMO * 60)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            rc = 124
        except Exception:
            rc = 127
        try:
            r = api("/api/terminal/gh/result", pack_result(cmd_id, rc, workdir))
            print("cmd", cmd_id[:8], "exit", rc, "posted", r.get("ok"))
        except Exception as e:
            print("result post failed:", type(e).__name__)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
