#!/usr/bin/env python3
"""Production E2E for the Vebai stateful terminal pipeline:
register -> chat asking to RUN a command -> model must emit ```run-terminal
-> stream route queues a terminal AgentTask -> agent worker ships CMD: job to
the Kaggle Linux worker -> output comes back as a chat message.
DB is polled directly over Neon for task/job transitions."""
import json
import os
import re
import sys
import time
import uuid

import requests

PROD = "https://vebai-six.vercel.app"
EMAIL = f"term-e2e-{uuid.uuid4().hex[:8]}@vebai.com"
PASSWORD = "test123456"
ASK = ("Выполни в терминале команду: echo vebai_term_ok && whoami && uname -a && "
       "python3 --version. Только выполни, не показывай код.")

os.environ.setdefault("DATABASE_URL",
    "postgresql://neondb_owner:npg_O1yFNxm6HuId@ep-silent-bonus-b8rr7hvo-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require")

def db_rows(sql, params=()):
    """one-off prisma query via the repo's node_modules"""
    script = (
        "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();" +
        f"p.$queryRawUnsafe({json.dumps(sql)}, ...{json.dumps(list(params))})" +
        ".then(r=>{console.log(JSON.stringify(r));return p.$disconnect()})"
        ".catch(e=>{console.error(e.message);process.exit(1)})")
    r = subprocess_run_node(script)
    return json.loads(r) if r else []

NEON = "postgresql://neondb_owner:npg_O1yFNxm6HuId@ep-silent-bonus-b8rr7hvo-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require"

def subprocess_run_node(script):
    import subprocess
    env = {**os.environ, "DATABASE_URL": NEON}  # force Neon (shell has a stale DATABASE_URL)
    r = subprocess.run(["node", "-e", script], capture_output=True, text=True,
                       cwd="/home/z/my-project/vebai", timeout=60, env=env)
    return r.stdout.strip() if r.returncode == 0 else ""

def db_agent_tasks():
    return db_rows(
        'SELECT id, status, progress, error, "jobIds" as job_ids, title '
        'FROM "AgentTask" WHERE type=$1 ORDER BY "createdAt" DESC LIMIT 5', ("terminal",))

def db_job_by_id(jid):
    rows = db_rows('SELECT id, status, error, prompt FROM "Job" WHERE id=$1', (jid,))
    return rows[0] if rows else None

def db_cmd_output(jid):
    rows = db_rows('SELECT "videoData" FROM "Job" WHERE id=$1', (jid,))
    if not rows or not rows[0]["videoData"]:
        return None
    data = rows[0]["videoData"]
    if isinstance(data, str):
        return json.loads(data)
    import base64
    raw = base64.b64decode(data) if isinstance(data, str) else bytes(data)
    return json.loads(raw.decode("utf-8", "replace"))

def db_result_message(conv_id, since_iso):
    return db_rows(
        'SELECT role, content, "createdAt" FROM "Message" WHERE "conversationId"=$1 '
        'AND "createdAt" > $2::timestamptz ORDER BY "createdAt" DESC LIMIT 3',
        (conv_id, since_iso))

def main():
    s = requests.Session()
    print(f"[*] register {EMAIL}")
    r = s.post(f"{PROD}/api/auth/register", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code < 500, f"register {r.status_code}: {r.text[:200]}"
    if r.status_code in (400, 409):  # maybe exists -> login
        r = s.post(f"{PROD}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code == 200, f"auth {r.status_code}: {r.text[:200]}"
    print("[*] auth ok")

    r = s.post(f"{PROD}/api/chat/start", json={"content": ASK}, timeout=30)
    data = r.json()
    conv_id = data["conversationId"]
    history = data["history"]
    print(f"[*] conversation {conv_id}")

    print("[*] streaming answer (asking the model to run a command)…")
    got_notice, answer = "", ""
    with s.post(f"{PROD}/api/chat/stream",
                json={"messages": history, "conversationId": conv_id,
                      "model": "glm-4.5-flash", "effort": "high", "webSearch": False},
                stream=True, timeout=240) as resp:
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            try:
                evt = json.loads(line[5:].strip())
            except Exception:
                continue
            if evt.get("type") == "delta":
                answer += evt.get("text", "")
            elif evt.get("type") == "notice":
                got_notice = evt.get("text", "")
                print(f"    [notice] {got_notice}")
            elif evt.get("type") == "error":
                print(f"    [stream error] {evt.get('message')}")
    has_block = "run-terminal" in answer
    print(f"[*] answer {len(answer)} chars, run-terminal block: {has_block}")

    tasks = db_agent_tasks()
    print(f"[*] terminal tasks in DB: {len(tasks)}")
    for t in tasks:
        print(f"    {t['status']:10s} {t['title'][:70]}")
    if not tasks:
        print("!! FAIL: no terminal task created (model did not emit run-terminal)")
        print("---- answer tail ----"); print(answer[-800:])
        return 1

    task = tasks[0]
    job_ids = task.get("job_ids") or []
    t0 = time.time()
    final_msg = None
    while time.time() - t0 < 780:  # up to 13 min (Kaggle CPU session spawn is slow)
        time.sleep(20)
        rows = db_rows('SELECT status, progress, error FROM "AgentTask" WHERE id=$1', (task["id"],))
        st = rows[0]["status"] if rows else "?"
        jrow = db_job_by_id(job_ids[0]) if job_ids else None
        print(f"[{int(time.time()-t0):4d}s] task={st:10s} job={(jrow or {}).get('status','?'):10s} "
              f"progress={(rows[0].get('progress') or '')[:60] if rows else ''}")
        if st == "completed":
            msgs = db_result_message(conv_id, task.get("createdAt") or "1970-01-01")
            final_msg = next((m["content"] for m in msgs if "Терминал:" in m["content"]), None)
            break
        if st == "failed":
            print(f"!! task FAILED: {rows[0].get('error')}")
            if jrow and jrow.get("error"):
                print(f"   job error: {jrow['error']}")
            return 1

    if final_msg:
        print("== TERMINAL RESULT MESSAGE ==")
        print(final_msg[:1200])
        ok = "vebai_term_ok" in final_msg and ("Linux" in final_msg or "linux" in final_msg)
        print("E2E:", "PASS" if ok else "WEAK (no expected output in message)")
        return 0 if ok else 1
    print("!! TIMEOUT waiting for task completion")
    return 1

if __name__ == "__main__":
    sys.exit(main())
