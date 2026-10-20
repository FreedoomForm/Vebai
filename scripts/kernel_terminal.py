# --- [vebai] stateful terminal + merge + telegram mirror -----------------------
# Shared code embedded into BOTH Kaggle workers (GPU real + CPU test).
# Provides:
#   * PersistentShell  - a real long-lived bash per terminal_id: cd, exports,
#                        venv activation and background processes survive
#                        between commands; timeout kills the process group and
#                        respawns the shell (cwd is preserved).
#   * handle_special() - manifest entries with mode 'cmd' / 'merge'.
#   * Telegram mirror  - workspace snapshot (tar.gz) + files produced during a
#                        command are uploaded to the owner channel with the
#                        terminal id in the caption; latest snapshot file_id is
#                        returned to the server (cmd_<job>.txt) so the next
#                        worker session can restore the workspace.
import json
import os
import subprocess
import time
from pathlib import Path

import re as _re
import selectors as _selectors
import signal as _signal
import tarfile as _tarfile
import uuid as _uuid

TERM_ROOT = Path("/kaggle/working/terminals")
try:
    TERM_ROOT.mkdir(parents=True, exist_ok=True)
except Exception:  # non-Kaggle environment (local tests): fall back to /tmp
    TERM_ROOT = Path("/tmp/vebai_terminals")
    TERM_ROOT.mkdir(parents=True, exist_ok=True)
TG = {"token": None, "chat_id": None, "restored": False}
SHELLS = {}
_LAST_SNAP = {}   # terminal_id -> ((files, bytes), file_id)


def _requests():
    import requests
    return requests


def _load_telegram_cfg(base):
    """lazy read of config.json shipped with the jobs batch; re-reads on every
    batch until token+chat_id are known (the first batch can race the server's
    chat_id discovery). Workspace snapshot restore happens once per session."""
    need_cfg = not (TG["token"] and TG["chat_id"])
    if not need_cfg and TG["restored"]:
        return
    try:
        cfg = json.loads((Path(base) / "config.json").read_text(encoding="utf-8"))
        if not TG["token"]:
            TG["token"] = cfg.get("telegram_token") or None
        if not TG["chat_id"] and cfg.get("telegram_chat_id"):
            TG["chat_id"] = str(cfg.get("telegram_chat_id"))
        snaps = cfg.get("term_snapshots") or {}
        if TG["restored"] or not (TG["token"] and TG["chat_id"]):
            return
        TG["restored"] = True
        if TG["token"] and TG["chat_id"]:
            for tid, fid in snaps.items():
                try:
                    ws = _term_ws(tid)
                    if any(ws.iterdir()):
                        continue  # session already has this workspace
                    dest = Path("/tmp") / f"vebai_restore_{tid}.tgz"
                    if _tg_download(TG["token"], fid, dest):
                        with _tarfile.open(dest, "r:gz") as tf:
                            tf.extractall(TERM_ROOT)
                        print(f"[term] restored workspace for {tid} "
                              f"({sum(1 for _ in ws.rglob('*'))} entries)", flush=True)
                except Exception as exc:
                    print(f"[term] restore {tid} failed: {type(exc).__name__}: {exc}",
                          flush=True)
    except Exception:
        pass  # config optional (older batches) - terminal still works w/o mirror


def _tg_upload_file(token, chat_id, path, caption):
    """upload a document; returns the telegram file_id or None"""
    try:
        with open(path, "rb") as fh:
            r = _requests().post(
                f"https://api.telegram.org/bot{token}/sendDocument",
                data={"chat_id": chat_id, "caption": caption[:900]},
                files={"document": (Path(path).name, fh)}, timeout=300)
        j = r.json()
        if j.get("ok"):
            return (j["result"].get("document") or {}).get("file_id")
        print(f"[tg] upload failed: {j.get('description')}", flush=True)
    except Exception as exc:
        print(f"[tg] upload error: {type(exc).__name__}: {exc}", flush=True)
    return None


def _tg_download(token, file_id, dest):
    try:
        r = _requests().get(f"https://api.telegram.org/bot{token}/getFile",
                            params={"file_id": file_id}, timeout=60)
        fp = (r.json().get("result") or {}).get("file_path")
        if not fp:
            return False
        r2 = _requests().get(f"https://api.telegram.org/file/bot{token}/{fp}",
                             timeout=600)
        Path(dest).write_bytes(r2.content)
        return True
    except Exception as exc:
        print(f"[tg] download error: {type(exc).__name__}: {exc}", flush=True)
        return False


def _term_ws(tid):
    safe = _re.sub(r"[^A-Za-z0-9_-]", "_", str(tid))[:48] or "default"
    ws = TERM_ROOT / f"term_{safe}"
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def _dir_signature(d):
    n = s = 0
    try:
        for p in d.rglob("*"):
            try:
                if not p.is_file() or "__pycache__" in str(p):
                    continue
                parts = set(p.parts)
                if parts & {".cache", ".npm", ".cargo", ".rustup", ".conda"}:
                    continue  # tool caches never survive the snapshot anyway
                n += 1
                s += p.stat().st_size
            except Exception:
                pass
    except Exception:
        pass
    return (n, s)


def _snapshot_terminal(tid, tag):
    """tar the workspace and push to the channel; throttled by content signature"""
    if not TG["token"] or not TG["chat_id"]:
        return None
    ws = _term_ws(tid)
    sig = _dir_signature(ws)
    if sig[1] == 0:
        return None
    prev = _LAST_SNAP.get(tid)
    if prev and prev[0] == sig:
        return prev[1]
    if sig[1] > 45 * 1024 * 1024:
        print(f"[term] {tid}: workspace {sig[1] / 1e6:.0f}MB > 45MB cap, "
              "snapshot skipped", flush=True)
        return "SKIP_BIG"
    arc = Path("/tmp") / f"vebai_term_{_re.sub(r'[^A-Za-z0-9_-]', '_', tid)}.tgz"
    try:
        with _tarfile.open(arc, "w:gz") as tf:
            tf.add(ws, arcname=ws.name)
        fid = _tg_upload_file(TG["token"], TG["chat_id"], arc,
                              f"vebai-snap term:{tid} | {tag} | "
                              f"{sig[0]} files, {sig[1] / 1e6:.1f}MB")
        _LAST_SNAP[tid] = (sig, fid)
        return fid
    except Exception as exc:
        print(f"[term] snapshot failed: {type(exc).__name__}: {exc}", flush=True)
        return None


def _upload_new_files(ws, t_start, tid, tag, limit=5):
    """files that appeared during the command -> channel (pip artifacts, dumps)"""
    sent = []
    if not TG["token"] or not TG["chat_id"]:
        return sent
    cands = []
    try:
        for p in sorted(ws.rglob("*")):
            try:
                if not p.is_file() or "__pycache__" in str(p):
                    continue
                if set(p.parts) & {".cache", ".npm", ".cargo", ".rustup", ".conda"}:
                    continue
                if p.name.endswith(".tgz"):
                    continue
                st = p.stat()
                if st.st_mtime < t_start - 1:
                    continue
                if 512 < st.st_size < 45 * 1024 * 1024:
                    cands.append((st.st_mtime, st.st_size, p))
            except Exception:
                pass
    except Exception:
        pass
    for _mt, sz, p in sorted(cands, reverse=True)[:limit]:
        fid = _tg_upload_file(TG["token"], TG["chat_id"], p,
                              f"vebai-file term:{tid} | {tag} | "
                              f"{p.name} ({sz / 1e6:.2f}MB)")
        if fid:
            sent.append(p.name)
    return sent


class PersistentShell:
    """one bash process per terminal: cd/export/venv state persists; a watchdog
    deadline is enforced via selectors (no blocked readline) and a hang kills
    the process group + respawns the shell."""

    def __init__(self, cwd):
        self.cwd = str(cwd)
        self.mark = f"__VEBAI_DONE_{_uuid.uuid4().hex[:10]}_"
        self.p = None
        self.sel = None
        self._spawn()

    def _spawn(self):
        # HOME points INTO the workspace: the agent naturally writes to ~, and
        # only the workspace tree gets snapshotted to Telegram
        env = {**os.environ, "HOME": self.cwd}
        self.p = subprocess.Popen(
            ["bash", "--noprofile", "--norc"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=self.cwd,
            preexec_fn=os.setsid, text=True, bufsize=1, env=env)
        self.sel = _selectors.DefaultSelector()
        self.sel.register(self.p.stdout, _selectors.EVENT_READ)

    def _kill(self):
        try:
            os.killpg(os.getpgid(self.p.pid), _signal.SIGKILL)
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            pass

    def run(self, cmd, timeout_s=240):
        payload = (cmd + f" </dev/null\necho \"{self.mark}$?__$(pwd)\"\n")
        try:
            self.p.stdin.write(payload)
            self.p.stdin.flush()
        except Exception:
            self._kill()
            self._spawn()
            return ("[vebai] shell died, restarted", 1, self.cwd)
        out = []
        done = None
        deadline = time.time() + max(5, int(timeout_s))
        while time.time() < deadline:
            remaining = max(0.1, deadline - time.time())
            events = self.sel.select(timeout=min(1.0, remaining))
            if not events:
                continue
            line = self.p.stdout.readline()
            if line == "":  # EOF -> shell died
                break
            if line.startswith(self.mark):
                body = line[len(self.mark):].strip()
                try:
                    rc_s, cwd_s = body.split("__", 1)
                    done = (int(rc_s.strip() or "1"), cwd_s.strip() or self.cwd)
                except Exception:
                    done = (1, self.cwd)
                break
            out.append(line)
        if done is None:
            self._kill()
            self._spawn()
            out.append(f"\n[vebai] timeout after {timeout_s}s -> shell restarted "
                       "(state kept: cwd/env of last completed command)")
            return ("\n".join(out), 124, self.cwd)
        self.cwd = done[1] or self.cwd
        return ("\n".join(out), done[0], self.cwd)


def run_cmd_entry(e, base, out_store):
    jid = str(e["job_id"])
    tid = str(e.get("terminal_id") or "default")
    _load_telegram_cfg(base)
    ws = _term_ws(tid)
    sh = SHELLS.get(tid)
    if sh is None:
        sh = PersistentShell(ws)
        SHELLS[tid] = sh
    tmo = max(10, min(900, int(e.get("timeout_s") or 240)))
    cmd = str(e.get("cmd") or "")
    t0 = time.time()
    out, rc, cwd = sh.run(cmd, tmo)
    tag = f"$ {cmd[:60]}"
    snap = _snapshot_terminal(tid, tag)
    files_sent = _upload_new_files(ws, t0, tid, tag)
    rec = {"cmd": cmd, "exit_code": rc, "output": out[:60000],
           "terminal_id": tid, "cwd": cwd, "workspace": str(ws),
           "snapshot_file_id": snap if isinstance(snap, str) and snap != "SKIP_BIG" else None,
           "snapshot_state": snap, "files_sent": files_sent,
           "elapsed_s": round(time.time() - t0, 1),
           "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    dest = Path(out_store) / f"cmd_{jid}.txt"
    dest.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    print(f"[term] {tid}: rc={rc} out={len(out)}B snap={'yes' if isinstance(snap, str) else 'no'} "
          f"files={files_sent} ({rec['elapsed_s']}s)", flush=True)
    return rec, dest


def run_merge_entry(e, base, out_store):
    jid = str(e["job_id"])
    names = list(e.get("input_files") or [])
    if not names:
        names = sorted(p.name for p in Path(base).glob("merge_*.mp4"))
    inputs = [Path(base) / n for n in names]
    missing = [str(p) for p in inputs if not p.is_file()]
    assert not missing, f"merge inputs missing: {missing}"
    assert inputs, f"no merge inputs for {jid}"
    lst = Path("/tmp") / f"vebai_concat_{jid}.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in inputs), encoding="utf-8")
    dest = Path(out_store) / f"job_{jid}.mp4"
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
         "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(dest)],
        capture_output=True, text=True, timeout=1200)
    ok = r.returncode == 0 and dest.is_file() and dest.stat().st_size > 1_000
    if not ok:
        r2 = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
             "-i", str(lst), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dest)],
            capture_output=True, text=True, timeout=2400)
        assert r2.returncode == 0 and dest.is_file() and dest.stat().st_size > 30_000, \
            f"merge failed: {(r.stderr or r2.stderr)[-400:]}"
    print(f"[merge] {jid}: {len(inputs)} clips -> {dest.name} "
          f"({dest.stat().st_size / 1e6:.1f}MB)", flush=True)
    return dest


def handle_special(e, base, state_dict, save_fn, push_fn, out_store, seen):
    """manifest entries with mode 'cmd' or 'merge'; returns True when accepted"""
    mode = e.get("mode")
    jid = str(e["job_id"])
    if mode == "merge":
        dest = run_merge_entry(e, base, out_store)
        rec = {"status": "done", "file": str(dest), "bytes": dest.stat().st_size,
               "mode": "merge"}
    elif mode == "cmd":
        rec_json, dest = run_cmd_entry(e, base, out_store)
        rec = {"status": "done", "file": str(dest), "bytes": dest.stat().st_size,
               "mode": "cmd", "exit_code": rec_json["exit_code"],
               "terminal_id": rec_json["terminal_id"]}
    else:
        return False
    state_dict[jid] = rec
    try:
        save_fn()
    except Exception:
        pass
    if seen is not None:
        seen.add(jid)
    try:
        push_fn(f"{mode} {jid}")
    except Exception:
        pass
    return True
