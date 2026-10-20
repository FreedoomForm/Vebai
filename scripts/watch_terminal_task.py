#!/usr/bin/env python3
"""Watch the terminal task cmvaupvcn0001l20883r3htuy through its full cycle."""
import base64
import json
import subprocess
import time

NEON = "postgresql://neondb_owner:npg_O1yFNxm6HuId@ep-silent-bonus-b8rr7hvo-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require"
TASK = "cmvaupvcn0001l20883r3htuy"
CONV = "cmvaupplm0002jz08w07x9j6b"

def q(script):
    r = subprocess.run(["node", "-e", script], capture_output=True, text=True,
                       cwd="/home/z/my-project/vebai", timeout=60,
                       env={"DATABASE_URL": NEON, "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/z"})
    if r.returncode != 0:
        return None
    return json.loads(r.stdout.strip() or "null")

def one(sql, *params):
    s = ("const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();"
         f"p.$queryRawUnsafe({json.dumps(sql)}, ...{json.dumps(list(params))})"
         ".then(r=>{console.log(JSON.stringify(r));return p.$disconnect()})"
         ".catch(e=>{console.error(e.message);process.exit(1)})")
    rows = q(s)
    return rows or []

t0 = time.time()
last = ""
while time.time() - t0 < 800:
    time.sleep(20)
    t = one('SELECT status, progress, error, "jobIds" as job_ids FROM "AgentTask" WHERE id=$1', TASK)
    if not t:
        print("!! task row lost"); break
    t = t[0]
    jid = (t.get("job_ids") or [None])[0]
    j = one('SELECT status, error FROM "Job" WHERE id=$1', jid) if jid else []
    jc = j[0]["status"] if j else "-"
    line = f"[{int(time.time()-t0):4d}s] task={t['status']:10s} job={jc:10s} prog={(t.get('progress') or '')[:55]}"
    if line != last:
        print(line, flush=True)
        last = line
    if t["status"] in ("completed", "failed"):
        if t["status"] == "failed":
            print("!! FAILED:", t.get("error"))
            if j and j[0].get("error"):
                print("   job error:", j[0]["error"])
            break
        msgs = one('SELECT content, "createdAt" FROM "Message" WHERE "conversationId"=$1 AND role=$2 ORDER BY "createdAt" DESC LIMIT 2', CONV, "assistant")
        for m in msgs:
            if "Терминал:" in m["content"]:
                print("== RESULT MESSAGE ==")
                print(m["content"][:900])
                break
        else:
            print("(no terminal result message found)")
        break
else:
    print("!! watcher timeout")

# also dump cmd record if job complete
if jid:
    rec = one('SELECT "videoData" FROM "Job" WHERE id=$1', jid)
    if rec and rec[0].get("videoData"):
        raw = rec[0]["videoData"]
        try:
            data = json.loads(raw if isinstance(raw, str) else base64.b64decode(raw).decode())
            print("== CMD RECORD ==")
            print(json.dumps({k: (v[:300] if isinstance(v, str) else v) for k, v in data.items()}, ensure_ascii=False, indent=1))
        except Exception as e:
            print("cmd record parse:", e)
