#!/usr/bin/env python3
"""Terminal statefulness E2E: create a file via one command, verify the file
lands in the workspace + Telegram, then read it back in a separate command."""
import json
import sys
import time
import uuid

import requests

PROD = "https://vebai-six.vercel.app"
EMAIL = "term-e2e-9ba1a2ec@vebai.com"
PASSWORD = "test123456"
CONV = "cmvaupplm0002jz08w07x9j6b"
CMD1 = ("mkdir -p ~/demo && echo persistent_proof_42 > ~/demo/proof.txt && "
        "ls -la ~/demo && cat ~/demo/proof.txt")
CMD2 = "cat ~/demo/proof.txt && ls ~/demo"

NEON = "postgresql://neondb_owner:npg_O1yFNxm6HuId@ep-silent-bonus-b8rr7hvo-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require"

def dbq(sql, params):
    import subprocess
    s = ("const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
         f"p.$queryRawUnsafe({json.dumps(sql)}, ...{json.dumps(params)})"
         ".then(r=>{console.log(JSON.stringify(r));return p.$disconnect()})"
         ".catch(e=>{console.error(e.message);process.exit(1)})")
    r = subprocess.run(["node", "-e", s], capture_output=True, text=True,
                       cwd="/home/z/my-project/vebai", timeout=60,
                       env={"DATABASE_URL": NEON, "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/z"})
    return json.loads(r.stdout.strip() or "null") if r.returncode == 0 else None

def run_command(s, conv_id, cmd_text):
    """send a chat message asking to run cmd_text; return terminal task id"""
    r = s.post(f"{PROD}/api/chat/start",
               json={"conversationId": conv_id, "content": f"Выполни в терминале: {cmd_text}"},
               timeout=30)
    d = r.json()
    conv_id, history = d["conversationId"], d["history"]
    answer = ""
    with s.post(f"{PROD}/api/chat/stream",
                json={"messages": history, "conversationId": conv_id,
                      "model": "glm-4.5-flash", "effort": "high"},
                stream=True, timeout=240) as resp:
        for line in resp.iter_lines(decode_unicode=True):
            if line.startswith("data:"):
                try:
                    evt = json.loads(line[5:].strip())
                except Exception:
                    continue
                if evt.get("type") == "delta":
                    answer += evt.get("text", "")
    time.sleep(2)
    rows = dbq('SELECT id, status FROM "AgentTask" WHERE type=$1 AND "conversationId"=$2 '
               'ORDER BY "createdAt" DESC LIMIT 1', ["terminal", conv_id])
    return (rows[0] if rows else None), answer

def wait_done(task_id, conv_id, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(20)
        try:
            requests.get(f"{PROD}/api/agent/tick", timeout=120)  # drive the worker
        except Exception:
            pass
        import subprocess
        s = ("const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
             f"p.$queryRawUnsafe({json.dumps('SELECT status, error FROM \"AgentTask\" WHERE id=$1')}, "
             f"{json.dumps(task_id)})"
             ".then(r=>{console.log(JSON.stringify(r));return p.$disconnect()})"
             ".catch(e=>{console.error(e.message);process.exit(1)})")
        r = subprocess.run(["node", "-e", s], capture_output=True, text=True,
                           cwd="/home/z/my-project/vebai", timeout=60,
                           env={"DATABASE_URL": NEON, "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/z"})
        rows = json.loads(r.stdout.strip() or "[]") if r.returncode == 0 else []
        st = rows[0]["status"] if rows else "?"
        print(f"    [{int(time.time()-t0):3d}s] {st}", flush=True)
        if st in ("completed", "failed"):
            return st
    return "timeout"

def main():
    s = requests.Session()
    r = s.post(f"{PROD}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code == 200, f"login {r.status_code}"

    print("[1] create file via terminal")
    task, answer = run_command(s, CONV, CMD1)
    print("    task:", task["id"] if task else None, "| run-terminal in answer:", "run-terminal" in answer)
    if not task:
        print("!! no terminal task"); return 1
    st = wait_done(task["id"], CONV)
    msgs = dbq('SELECT content FROM "Message" WHERE "conversationId"=$1 AND role=$2 '
               'ORDER BY "createdAt" DESC LIMIT 1', [CONV, "assistant"])
    print("    last msg:", (msgs[0]["content"][:300] if msgs else "-").replace("\n", " | "))

    print("[2] read the file back (same workspace, new command)")
    task2, answer2 = run_command(s, CONV, CMD2)
    print("    task:", task2["id"] if task2 else None, "| run-terminal in answer:", "run-terminal" in answer2)
    if not task2:
        print("!! no terminal task 2"); return 1
    st2 = wait_done(task2["id"], CONV)
    msgs = dbq('SELECT content FROM "Message" WHERE "conversationId"=$1 AND role=$2 '
               'ORDER BY "createdAt" DESC LIMIT 1', [CONV, "assistant"])
    content = msgs[0]["content"] if msgs else ""
    print("    last msg:", content[:300].replace("\n", " | "))
    ok = "persistent_proof_42" in content and st2 == "completed"
    print("E2E:", "PASS" if ok else "FAIL")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
