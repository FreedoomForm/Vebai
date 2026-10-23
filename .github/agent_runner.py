#!/usr/bin/env python3
"""Agentic loop for vebai's resident GitHub Actions executor (owner request
2026-10-18): instead of one big shell command, the runner becomes a real
agent - it reads AGENT.md, plans with GLM (same official Z.ai API as the
site), executes its own bash commands one by one inside the persistent
/tmp/ws workspace, observes the output, fixes its mistakes and only then
reports the final answer.

T16 (owner request 2026-10-18): the user sees ONLY what the agent wants to
show. No progress lines are mirrored to Telegram any more - the runner just
sends a silent heartbeat to /api/terminal/gh/progress (running-timeout +
resident keepalive). The final answer follows the <answer>/<file> protocol
(see AGENT.md): <answer>...</answer> is the text the user gets, <file>
tags pick which workspace files are delivered - everything else (steps,
commands, search, intermediate notes) never reaches the user. Produced
files are collected by the executor's post_result (mtime diff of /tmp/ws)
as before; /api/terminal/gh/result does the parsing/filtering.

T48 (owner request 2026-10-23) - the agent gets INTERNAL APPS for deciding
ITSELF when to talk and when to hand over files (they complement the
shell/terminal and the Telegram app):
  1. <answer>...</answer> - CONTACT THE USER, at ANY step (not only inside
     <final>): intermediate result, a problem, an important finding. The
     text is delivered immediately (Telegram + mirrored into the site chat).
  2. <file>name</file> - ATTACH A FILE, at ANY step: the workspace file is
     delivered to the user right away; already-delivered files are deduped
     out of the final batch so nothing arrives twice.
T49 (owner request 2026-10-23): the STOP app - <end></end> (or
  <end>комментарий</end>). After every delivered <answer>/<file> the model
  gets a delivery receipt and decides ITSELF: keep working OR finish the
  task with <end>. <end> gracefully stops the loop: a <final> in the same
  reply is honoured, otherwise the (optional) <end> body becomes the short
  closing answer.
T52 (owner request 2026-10-23): three protocol changes:
  - <work> is REMOVED (the agent just works; contact the user when there
    is something to say).
  - NEW <memory>...</memory> - WRITE TO THE SHARED AGENT MEMORY: important
    facts (user preferences, agreements, names, outcomes) the agent MUST
    remember; the text is appended to the site's shared memory (visible and
    editable on the site's memory page) and to the local shift memory.
  - TAGS ARE OPTIONAL: a reply with no real actions (or only <memory>) is
    the plain ANSWER and finishes the task. No format retries anywhere.

Protocol (see AGENT.md): the model answers with <cmd to="900">...</cmd>,
<search>...</search>, <read>...</read>, <send to="owner" file="...">...</send>
or <final>...</final> blocks - OR just plain text (the answer). <send>
delivers texts/files to a person via the Telegram bot right now (the task
sender's private chat by default) instead of waiting for the end-of-task
result batch.
Stdlib only - nothing to install on the runner.
"""
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zai_client  # noqa: E402

WS = "/tmp/ws"                   # default workspace (overridden per-run, see run_agent)
MEMORY = "/tmp/agent_memory.md"   # default shift memory (overridden per-run)
SITE = (os.environ.get("SITE") or "https://vebai-six.vercel.app").rstrip("/")
SECRET = os.environ.get("SECRET") or ""
SESSION = os.environ.get("SESSION") or ""
SKILLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")
# T33: the Telegram APP on the agent's computer (full MTProto API from the
# owner's connected account). Exposed to every bash command as "$TG".
TG_APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tg.js")

# T24 (owner request 2026-10-19): 0 / unset = NO step cap - the model works
# until the task deadline (AGENT_BUDGET_MIN) or the shift deadline, exactly
# like the Z.ai reference agent. The only remaining guards are the task
# budget, the same-command-repeats detector and the truth guard.
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS") or "0")
BUDGET_MIN = float(os.environ.get("AGENT_BUDGET_MIN") or "45")
STEP_TMO_DEFAULT = 180   # seconds per bash command
STEP_TMO_MAX = 900       # hard cap: keeps command-row heartbeat gaps < 25 min
TOOL_OUT_CAP = 6000      # per-step output chars fed back to the model
HISTORY_SOFT_CAP = 60_000

AGENT_MD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "AGENT.md")

RE_CMD = re.compile(r"<cmd(?:\s+to\s*=\s*[\"']?(\d+)[\"']?)?\s*>([\s\S]*?)</cmd>", re.I)
RE_SEARCH = re.compile(r"<search>([\s\S]*?)</search>", re.I)
RE_READ = re.compile(r"<read>([\s\S]*?)</read>", re.I)
RE_SEND = re.compile(r"<send\b([^>]*?)/?>([\s\S]*?)</send>", re.I)
RE_ATTR = re.compile(r"(\w+)\s*=\s*[\"']([^\"']*)[\"']")
RE_FINAL = re.compile(r"<final>([\s\S]*?)</final>", re.I)
RE_THINK = re.compile(r"<think>[\s\S]*?</think>|<thought>[\s\S]*?</thought>", re.I)
RE_ANSWER = re.compile(r"<answer>([\s\S]*?)</answer>", re.I)
RE_FTAG = re.compile(r"<file>([\s\S]*?)</file>", re.I)
RE_MEMORY = re.compile(r"<memory>([\s\S]*?)</memory>", re.I)

# T48: one combined scanner so actions execute in the order the model wrote
# them (cmd -> search -> read -> send -> answer -> file -> memory -> end are
# all matched by a single pass, ordered by position in the reply).
# T52: the <work> slot became <memory> (same group index - the scanner
# structure is unchanged).
RE_ACTION = re.compile(
    r"<cmd(?:\s+to\s*=\s*[\"']?(\d+)[\"']?)?\s*>([\s\S]*?)</cmd>"
    r"|<search>([\s\S]*?)</search>"
    r"|<read>([\s\S]*?)</read>"
    r"|<send\b([^>]*?)/?>([\s\S]*?)</send>"
    r"|<answer>([\s\S]*?)</answer>"
    r"|<file>([\s\S]*?)</file>"
    r"|<memory>([\s\S]*?)</memory>"
    r"|(<end\s*/>)|<end>([\s\S]*?)</end>", re.I)

# T52b: the fake-refusal pattern the owner caught in the field (2026-10-23):
# asked "+998… ответ ей исходя из контекста того, что мы обсуждали", the agent
# answered "у меня нет доступа к содержанию вашей предыдущей переписки" instead
# of READING the chat with its own Telegram app. CORE = the refusal claim,
# TG = the subject the tools obviously cover.
RE_REFUSAL_CORE = re.compile(
    r"не имею доступа|нет доступа|у меня нет доступа|не могу получить доступ|"
    r"нет доступа к|не могу (прочитать|видеть|увидеть|узнать)|не имею возможности (прочитать|видеть)|"
    r"я не (видел|вижу|знаю) (вашей |этой )?(переписки|диалога|истории)",
    re.I)
RE_REFUSAL_TG = re.compile(
    r"переписк|диалог|контекст|обсужда|истори[ию] сообщений|ваших сообщений", re.I)
RE_PERSON_TASK = re.compile(
    r"\+\d{7,}|@[A-Za-z][A-Za-z0-9_]{3,}|ответ (ей|ему|им)|напиши (ей|ему|им)|"
    r"переписк|обсужда|диалог", re.I)


def dedup_final_files(final_text: str, delivered: set) -> str:
    """T48: remove <file> tags for files the user ALREADY received mid-task
    (the result-route batch must not ship the same file twice)."""
    def drop(m):
        names = [s.strip().replace("/tmp/ws/", "").lstrip("./")
                 for s in re.split(r"[\n,;]+", m.group(1) or "")]
        kept = [n for n in names if n and n.lower() not in delivered]
        return "<file>" + "\n".join(kept) + "</file>" if kept else ""
    return re.sub(r"<file>([\s\S]*?)</file>", drop, final_text or "", flags=re.I)


def memory_append(text: str, source: str) -> bool:
    """T52: append a note to the SHARED agent memory on the site (visible and
    editable on the site's memory page). Best-effort: a site outage must not
    break the task; the note also lands in the local shift memory file."""
    t = " ".join((text or "").split()).strip()
    if not t:
        return False
    ok = False
    if SECRET:
        try:
            api("/api/agent/memory",
                {"secret": SECRET, "text": t[:1500], "source": source},
                timeout=30)
            ok = True
        except Exception:
            ok = False
    try:
        with open(MEMORY, "a", encoding="utf-8") as f:
            f.write("\n[%s] %s" % (source, t[:800]))
    except OSError:
        pass
    return ok


def shared_memory() -> str:
    """T52: fetch the shared agent memory from the site (best-effort)."""
    if not SECRET:
        return ""
    try:
        r = api("/api/agent/memory", {"secret": SECRET}, timeout=30)
        return str(r.get("text") or "")[:12000]
    except Exception:
        return ""


def strip_protocol_tags(text: str) -> str:
    """T52: remove ALL protocol machinery from a reply, leaving only the
    visible text (used when the model answers in plain text without tags)."""
    t = RE_THINK.sub("", text or "")
    t = re.sub(r"<end\s*/>|<end\b[^>]*>[\s\S]*?</end\s*>", " ", t, flags=re.I)
    t = re.sub(r"<memory\b[^>]*>[\s\S]*?</memory\s*>", " ", t, flags=re.I)
    t = re.sub(r"<final\b[^>]*>[\s\S]*?</final\s*>", " ", t, flags=re.I)
    t = re.sub(r"<(cmd|search|read|send)\b[^>]*>[\s\S]*?</\1\s*>", " ", t, flags=re.I)
    t = re.sub(r"</?(?:cmd|search|read|send|answer|file|final|end|memory|work)\b[^>]*/?>", " ", t, flags=re.I)
    return re.sub(r"\n{3,}", "\n\n", t).strip()

# T21a truth guard: file names mentioned in the visible answer, and claims
# that something was already sent/attached (the agent must never say it
# created/sent a file that does not exist).
RE_EXT_FILE = re.compile(
    r"[\w\-.]+\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|7z|rar|png|jpe?g|gif|webp|mp4|mp3|wav|txt|json|html?|svg|md)\b",
    re.I)
RE_SEND_CLAIM = re.compile(
    r"отправ(?:лен|ил|лю|ка)|доставл|прикрепл|выслал|вложени", re.I)
# T52b: the DM flow delivers via the Telegram APP on the computer
# (node "$TG" send/sendfile inside <cmd>) - a successful such command is
# honest evidence behind "отправил" claims in the final (tg.js prints exactly
# one JSON line; ok:true = delivered).
RE_TG_SEND_OK = re.compile(r'"ok"\s*:\s*true')

# ------------------------------------------------------ T54: report guard
# Owner request 2026-10-23: what the OWNER sees must be a REPORT of what was
# done — «Отвечал Mirsaid (chat id: …) на сообщение «…». Ответ: «…»» — NOT a
# copy of the text sent to the correspondent. The runner tracks every text
# actually delivered to other people ($TG send via <cmd>, <send> to a person);
# when the final <answer> duplicates one of them, report_guard gets ONE
# corrective round to rewrite it as a proper report.
SENT_TEXTS: list = []  # normalized texts delivered to correspondents (this task)


def norm_txt(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _loose(s: str) -> str:
    """strip the leading ✅/punctuation the runner or model may prepend"""
    return s.lstrip("✅☑✔→-—:;,.;!? ").strip()


def track_tg_send(cmd: str, outp: str) -> None:
    """record the text a successful `$TG send/sendfile` actually delivered
    (the last quoted argument of the command, >=16 chars)."""
    if not re.search(r'(\$TG|tg\.js)', cmd) or not re.search(r'\bsend(file)?\b', cmd):
        return
    if not RE_TG_SEND_OK.search(outp or ""):
        return
    # proper left-to-right quoted pairs (the greedy [^"\n]{16,} cross-pairs
    # the "$TG" quotes with the message quotes and misses the real text)
    quotes = [q for q in re.findall(r'"([^"]*)"', cmd) if len(norm_txt(q)) >= 16]
    if quotes:
        SENT_TEXTS.append(norm_txt(quotes[-1]))


def track_send(to: str, body: str, ok: bool) -> None:
    """record a successful <send> text delivered to a person (not the owner)."""
    if ok and (to or "").strip().lower() != "owner" and len(norm_txt(body)) >= 16:
        SENT_TEXTS.append(norm_txt(body))

MAX_SEND_BYTES = 3_400_000   # per request: Vercel body limit ~4.5MB base64-encoded


# ------------------------------------------------------------------ plumbing

def api(path: str, payload: dict, timeout: int = 60):
    import urllib.request
    req = urllib.request.Request(
        SITE + path, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


_last_progress = 0.0


def heartbeat(status: str = "") -> None:
    """T16: SILENT keepalive - no step text ever travels to users. Same
    /api/terminal/gh/progress endpoint, generic payload; the route only
    touches the running command's updatedAt (30-min timeout guard) and the
    session's lastSeenAt (resident redispatch guard). Throttled to one
    beat per 4 minutes - far below both timeouts."""
    global _last_progress
    now = time.time()
    if now - _last_progress < 240:  # one beat / 4 min is enough
        return
    _last_progress = now
    if not (SECRET and SESSION):
        return
    try:
        api("/api/terminal/gh/progress",
            {"secret": SECRET, "session": SESSION,
             "text": (status or "работаю")[:200]},
            timeout=30)
    except Exception:
        pass  # keepalive must never break the loop


def do_send(to: str, file_path: str, text: str, mirror: bool = False):
    """deliver a text/file to a person via the site's /api/terminal/gh/send;
    returns (one-line report the model reads on its next turn, ok, files_sent).
    T48: mirror=True additionally posts the delivery into the site chat
    conversation the task came from (mid-task <answer>/<file> visibility)."""
    to = (to or "owner").strip() or "owner"
    files = []
    n_files = 0
    if file_path:
        p = os.path.realpath(
            file_path if os.path.isabs(file_path) else os.path.join(WS, file_path))
        ws_root = os.path.realpath(WS)
        if os.path.commonpath([p, ws_root]) != ws_root:
            return (f"[send → {to}] ❌ файл должен лежать внутри {WS} "
                    f"(получено: {file_path})"), False, 0
        if not os.path.isfile(p):
            return f"[send → {to}] ❌ файл не найден: {file_path}", False, 0
        size = os.path.getsize(p)
        if size == 0:
            return f"[send → {to}] ❌ файл пустой: {file_path}", False, 0
        if size > MAX_SEND_BYTES:
            return (f"[send → {to}] ❌ файл {size // 1024} КБ больше лимита 3.3 МБ — "
                    "сожми (zip -9, jpg-качество) или раздели на части"), False, 0
        import base64
        with open(p, "rb") as f:
            files.append({"name": os.path.basename(p),
                          "b64": base64.b64encode(f.read()).decode()})
    text = (text or "").strip()
    if not text and not files:
        return f"[send → {to}] ❌ пусто: укажи file=\"...\" или напиши текст", False, 0
    if not (SECRET and SESSION):
        return "[send] ❌ SECRET/SESSION не заданы — отправка недоступна", False, 0
    try:
        res = api("/api/terminal/gh/send",
                  {"secret": SECRET, "session": SESSION, "chat": to,
                   "text": text[:8000], "files": files, "mirror": mirror},
                  timeout=120)
    except Exception as e:
        return f"[send → {to}] ❌ доставка не удалась: {str(e)[:150]}", False, 0
    if res.get("ok"):
        n_files = int(res.get("filesSent") or 0)
        done = []
        if res.get("textSent"):
            done.append(f"текст доставлен ({res['textSent']} сообщ.)")
        if n_files:
            done.append(f"файлов доставлено: {n_files}")
        return (f"[send → {res.get('chat') or to}] ✅ " + "; ".join(done)), True, n_files
    errs = "; ".join(res.get("errors") or [res.get("error") or "неизвестная ошибка"])
    return f"[send → {to}] ❌ {errs[:300]}", False, 0


def run_bash(script: str, timeout: int):
    """execute in the persistent workspace; returns (rc, combined_output)."""
    out_path = "/tmp/.agent-out"
    err_path = "/tmp/.agent-err"
    t0 = time.time()
    rc = 1
    try:
        with open(out_path, "w") as fo, open(err_path, "w") as fe:
            p = subprocess.run(["bash", "-c", script], cwd=WS,
                               stdin=subprocess.DEVNULL, stdout=fo, stderr=fe,
                               timeout=timeout)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        rc = 124
    except Exception as e:
        with open(err_path, "a") as fe:
            fe.write(f"\n[runner] {type(e).__name__}: {e}\n")
        rc = 127
    dt = int(time.time() - t0)
    out = err = ""
    try:
        with open(out_path, encoding="utf-8", errors="replace") as f:
            out = f.read()
        with open(err_path, encoding="utf-8", errors="replace") as f:
            err = f.read()
    except OSError:
        pass
    combined = out.strip()
    if err.strip():
        combined += ("\n" if combined else "") + "[stderr]\n" + err.strip()
    if rc == 124:
        combined += f"\n[ПРЕРВАНО: таймаут {timeout} с - раздели команду или подними to]"
    return rc, dt, combined[-TOOL_OUT_CAP:]


# ------------------------------------------------------------------- parsing

def parse_actions(reply: str):
    """extract (final_text|None, [action tuples]) from a model reply.
    T48: everything OUTSIDE <final> is scanned in reply order; <answer> and
    <file> there are IMMEDIATE user-contact actions ('answer'/'mfile').
    T49: <end> (any form: <end/>, <end></end>, <end>note</end>) is the
    agent's own STOP command - the loop finishes gracefully after the
    remaining actions of this reply are executed.
    T52: <memory> writes to the shared agent memory; <work> is gone."""
    reply = RE_THINK.sub("", reply)
    final = None
    rest = reply
    m = RE_FINAL.search(reply)
    if m:
        final = m.group(1).strip()
        rest = reply[:m.start()] + reply[m.end():]
    actions = []
    for m in RE_ACTION.finditer(rest):
        g = m.groups()
        if g[1] is not None:  # <cmd to=...>
            to = g[0]
            actions.append(("cmd", g[1].strip(),
                            min(int(to) if to and to.isdigit() else STEP_TMO_DEFAULT,
                                STEP_TMO_MAX)))
        elif g[2] is not None:  # <search>
            q = g[2].strip()
            if q:
                actions.append(("search", q, 30))
        elif g[3] is not None:  # <read>
            u = g[3].strip()
            if u:
                actions.append(("read", u, 40))
        elif g[5] is not None:  # <send to= file=>
            attrs = {k.lower(): v for k, v in RE_ATTR.findall(g[4] or "")}
            body = g[5].strip()
            # tolerate file specified inside the body: "file: /tmp/ws/x.pdf"
            fpath = attrs.get("file", "").strip()
            if not fpath:
                fm = re.search(r"^\s*(?:file|файл)\s*[:=]\s*(\S+)", body, re.I | re.M)
                if fm:
                    fpath = fm.group(1)
                    body = re.sub(r"^\s*(?:file|файл)\s*[:=].*$", "", body, flags=re.I | re.M).strip()
            actions.append(("send", (attrs.get("to", "").strip(), fpath, body), 60))
        elif g[6] is not None:  # T48 <answer> outside final -> contact NOW
            t = g[6].strip()
            if t:
                actions.append(("answer", t, 60))
        elif g[7] is not None:  # T48 <file> outside final -> deliver NOW
            for line in re.split(r"[\n,;]+", g[7] or ""):
                p = line.strip().replace("/tmp/ws/", "").lstrip("./")
                if p:
                    actions.append(("mfile", p, 60))
        elif g[8] is not None:  # T52 <memory> -> write to the shared memory
            t = g[8].strip()
            if t:
                actions.append(("memory", t, 0))
        elif g[9] is not None or g[10] is not None:  # T49 <end> -> stop
            actions.append(("end", (g[10] or "").strip(), 0))
    return final, actions


def compact(history: list) -> None:
    """keep context small: truncate tool outputs in all but the last 6 turns."""
    total = sum(len(m.get("content") or "") for m in history)
    if total <= HISTORY_SOFT_CAP:
        return
    for m in history[:-6]:
        c = m.get("content") or ""
        if len(c) > 2200:
            m["content"] = c[:1500] + "\n…[усечено для контекста]"


# ----------------------------------------------------- T21a: truth guard
# Owner report 2026-10-18: the bot once said «файл создал и отправил», but
# nothing was created or delivered. The final answer is now mechanically
# verified against the real workspace before it leaves the runner.

def ws_files_basenames() -> set:
    """every file currently in the workspace (basename, lowercase)."""
    out = set()
    for root, _, names in os.walk(WS):
        for n in names:
            out.add(n.lower())
    return out


def analyze_final(final_text: str, real: set, send_files_ok: int, tg_ok: int = 0):
    """returns (answer, missing, claimed):
    answer  — the visible <answer> text ('' if the final is not tagged);
    missing — file names the final promises (via <file> tags or mentions in
              the answer) that do NOT exist in the workspace;
    claimed — the answer says the file was sent/attached, but no <send> of a
              file and no successful "$TG send/sendfile" ever happened and
              none of the promised files exists."""
    answers = [m.group(1).strip() for m in RE_ANSWER.finditer(final_text) if m.group(1).strip()]
    answer = "\n\n".join(answers)
    promised = []
    seen = set()

    def add(n: str) -> None:
        n = n.strip().replace("\\", "/").split("/")[-1].strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            promised.append(n)

    for m in RE_FTAG.finditer(final_text):
        for line in re.split(r"[\n,;]+", m.group(1) or ""):
            add(line.replace("/tmp/ws/", "").lstrip("./"))
    if not answers:
        # legacy untagged final: scan the whole text for file mentions
        for m in RE_EXT_FILE.finditer(final_text):
            add(m.group(0))
    missing = [n for n in promised if n.lower() not in real]
    # send-claims are checked in the VISIBLE text: the <answer> for tagged
    # finals, the whole final for legacy untagged ones (answer is empty there)
    claim_scope = answer if answers else final_text
    claimed = bool(
        claim_scope and RE_SEND_CLAIM.search(claim_scope)
        and send_files_ok == 0 and tg_ok == 0
        and not any(n.lower() in real for n in promised))
    return answer, missing, claimed


def append_honest_note(final_text: str, missing: list, claimed: bool) -> str:
    """append a truthful system note INSIDE the visible answer (or at the
    end for legacy untagged finals) so the user never keeps a false
    "file created/sent" belief."""
    bits = []
    if missing:
        bits.append("файл(ы) " + ", ".join(missing) + " в итоге НЕ были созданы — задача выполнена не полностью")
    if claimed:
        bits.append("файл НЕ был доставлен в Telegram — сообщение о готовности было ошибочным")
    if not bits:
        return final_text
    note = "⚠️ " + "; ".join(bits) + "."
    last = None
    for m in RE_ANSWER.finditer(final_text):
        last = m
    if last:
        i = last.end(1)
        return final_text[:i] + "\n\n" + note + final_text[i:]
    return final_text + "\n\n" + note


def truth_guard(final_text: str, system: str, history: list, send_files_ok: int,
                tg_ok: int = 0) -> str:
    """verify the final against reality: ONE corrective round-trip (create
    the missing files / re-send / rewrite the final honestly), then an
    honest note if the agent still fails to deliver."""
    final_text = (final_text or "").strip()
    if not final_text:
        return final_text
    _, missing, claimed = analyze_final(final_text, ws_files_basenames(),
                                        send_files_ok, tg_ok)
    if not missing and not claimed:
        return final_text
    problems = []
    if missing:
        problems.append("заявлен(ы) файл(ы), которых НЕТ в workspace: " + ", ".join(missing))
    if claimed:
        problems.append("в ответе сказано, что файл отправлен, но ни одна отправка <send> не удалась и ни один из обещанных файлов не существует")
    history.append({"role": "user", "content":
        ("[СИСТЕМА] ПРОВЕРКА ЧЕСТНОСТИ ФИНАЛА: " + "; ".join(problems) +
         ". У тебя один ход: создай недостающий(е) файл(ы) через <cmd> (проверь ls и размер!), при необходимости отправь <send>, и дай новый <final> — только о РЕАЛЬНО существующих файлах. Если файл создать невозможно — честно скажи об этом в <answer>.")})
    try:
        reply, _ = zai_client.chat(
            [{"role": "system", "content": system}] + history,
            temperature=0.2, max_tokens=4000)
    except Exception:
        return append_honest_note(final_text, missing, claimed)
    final2, actions = parse_actions(reply)
    outs = []
    for kind, arg, tmo in actions[:4]:
        if kind == "cmd":
            rc, dt, outp = run_bash(arg, min(tmo, 300))
            outs.append(f"$ {arg[:200]}\n(exit {rc}, {dt} c)\n{outp or '(пусто)'}")
        elif kind == "send":
            report, ok, n = do_send(*arg)
            if ok and n:
                send_files_ok += n
            outs.append(report)
    if outs:
        history.append({"role": "assistant", "content": reply})
        history.append({"role": "user", "content":
            "=== вывод исправления ===\n" + "\n\n".join(outs) +
            "\n\n[СИСТЕМА] Дай <final> сейчас — только правда о реально существующих файлах."})
        try:
            reply2, _ = zai_client.chat(
                [{"role": "system", "content": system}] + history,
                temperature=0.2, max_tokens=2500)
            final3, _ = parse_actions(reply2)
            final2 = final3 or final2 or reply2[:3000]
        except Exception:
            pass
    if not final2:
        final2 = reply[:3000]
    _, missing2, claimed2 = analyze_final(final2, ws_files_basenames(),
                                          send_files_ok, tg_ok)
    if missing2 or claimed2:
        final2 = append_honest_note(final2, missing2, claimed2)
    return final2


# T35 format guard REMOVED (T52, owner request 2026-10-23): tags are optional
# now - a plain-text final IS the answer, no mechanical auto-repeat anywhere.
# The truth guard below still guarantees file-claims honesty.


def report_problem(final_text: str) -> str:
    """the copy-defect description when the final <answer> duplicates a text
    already delivered to a correspondent; '' when clean."""
    answers = [m.group(1).strip() for m in RE_ANSWER.finditer(final_text or "") if m.group(1).strip()]
    for a in answers:
        na = norm_txt(a)
        if len(na) >= 16 and any(_loose(na) == _loose(s) for s in SENT_TEXTS):
            return "<answer> — это КОПИЯ текста, отправленного собеседнику, а не отчёт владельцу"
    return ""


def report_guard(final_text: str, system: str, history: list) -> str:
    """T54 (owner request 2026-10-23: «чтобы он именно говорил мне то что хотел,
    типа отчёт давал, а не просто слова которые он сам сказал»): when the final
    <answer> is an exact copy of a text already delivered to a correspondent,
    ONE corrective round rewrites it as a proper owner-facing report
    («Отвечал Mirsaid (chat id: …) на сообщение «…». Ответ: «…»»).
    Same shape as truth_guard/refusal_guard — NOT the removed T35 format retry:
    it fires only on the mechanical copy-defect, never on style."""
    final_text = (final_text or "").strip()
    if not SENT_TEXTS or not final_text:
        return final_text
    if not report_problem(final_text):
        return final_text
    history.append({"role": "user", "content":
        ("[СИСТЕМА] ПРОВЕРКА ОТЧЁТА: твой <answer> — это КОПИЯ текста, который ты отправил собеседнику, "
         "а не отчёт владельцу. Текст для собеседника уже доставлен ($TG/<send>) — в <answer> он не нужен. "
         "Напиши в <answer> ОТЧЁТ ВЛАДЕЛЬЦУ о сделанном: кому ответил, на какое сообщение, чем именно. "
         "Одобренный владельцем формат отчёта: «Отвечал Mirsaid (chat id: 7660731569) на сообщение "
         "«Juma ayyomlarin bilan». Ответ: «Juma ayyomlarin bilan! …»» — то есть КОМУ, НА ЧТО и ЧЕМ ответил. "
         "Дай новый <final> с отчётом в <answer> (ничего повторно не отправляй).")})
    try:
        reply, _ = zai_client.chat(
            [{"role": "system", "content": system}] + history,
            temperature=0.2, max_tokens=2500)
    except Exception:
        return final_text
    final3, actions3 = parse_actions(reply)
    end_body = next((arg for kind, arg, _t in actions3 if kind == "end"), None)
    final2 = (final3 or (end_body or "").strip() or strip_protocol_tags(reply) or "").strip()
    if not final2:
        return final_text
    if not report_problem(final2):
        return final2
    return final_text


def refusal_guard(final_text: str, tg_available: bool, task_text: str,
                  system: str, history: list) -> tuple:
    """T52b (owner field report 2026-10-23): the agent must EXPLORE its tools
    instead of faking inability. A final that claims "no access to the
    correspondence/context" while the Telegram app sits on the computer gets
    ONE corrective round (same shape as truth_guard - NOT the removed T35
    format retry): read the chat yourself (node "$TG" read), do the job with
    the real transcript, give a new final. A refusal is acceptable only AFTER
    a real attempt (then the tool error makes it honest).
    Returns (final_text, tg_sends) - tg_sends counts successful "$TG
    send/sendfile" deliveries done inside this corrective round."""
    final_text = (final_text or "").strip()
    if not tg_available or not final_text:
        return final_text, 0
    if not RE_REFUSAL_CORE.search(final_text):
        return final_text, 0
    if not (RE_REFUSAL_TG.search(final_text) or RE_PERSON_TASK.search(task_text or "")):
        return final_text, 0
    # the plain-final path breaks out of the loop BEFORE the assistant reply
    # lands in history - make sure the model sees its own refusal when asked
    # to redo the job (in the <end> path it is already there - no duplicate).
    last_ass = next((m for m in reversed(history) if m.get("role") == "assistant"), None)
    if not (last_ass and final_text[:100] in (last_ass.get("content") or "")):
        history.append({"role": "assistant", "content": final_text})
    history.append({"role": "user", "content":
        ("[СИСТЕМА] ПРОВЕРКА ОТКАЗА: ты ответил отказом в духе «у меня нет доступа к переписке/контексту» — "
         "это неправда. На твоём компьютере стоит приложение Telegram от имени личного аккаунта владельца "
         "(node \"$TG\"), и оно читает ЛЮБОЕ количество сообщений из любых его чатов. Контекст переписки "
         "достаётся САМ, а не запросом у пользователя: node \"$TG\" dialogs (найти чат по номеру/имени) → "
         "node \"$TG\" read \"<чат>\" 50 (--search слово). Действуй: прочитай нужный чат, выполни задание "
         "по РЕАЛЬНОЙ переписке и дай новый <final>. Отказ допустим только после реальной попытки — "
         "если инструмент вернул ошибку, честно процитируй её.")})
    try:
        reply, _ = zai_client.chat(
            [{"role": "system", "content": system}] + history,
            temperature=0.2, max_tokens=4000)
    except Exception:
        history.pop()
        return final_text, 0
    final2, actions = parse_actions(reply)
    tg_sends = 0
    outs = []
    for kind, arg, tmo in actions[:6]:
        if kind == "cmd":
            rc, dt, outp = run_bash(arg, min(tmo, 600))
            outs.append(f"$ {arg[:400]}\n(exit {rc}, {dt} c)\n{outp or '(пустой вывод)'}")
            if re.search(r'(\$TG|tg\.js)', arg) and re.search(r'\bsend(file)?\b', arg) \
                    and RE_TG_SEND_OK.search(outp or ""):
                tg_sends += 1
        elif kind == "search":
            try:
                outs.append(f"[поиск: {arg}]\n{zai_client.web_search(arg)}")
            except Exception as e:
                outs.append(f"[поиск: {arg}] ошибка: {str(e)[:120]}")
        elif kind == "read":
            try:
                outs.append(f"[страница: {arg}]\n{zai_client.read_page(arg)}")
            except Exception as e:
                outs.append(f"[страница: {arg}] ошибка: {str(e)[:120]}")
        elif kind == "send":
            report, _ok, _n = do_send(*arg)
            outs.append(report)
        elif kind == "answer":
            report, _ok, _n = do_send("owner", "", arg, mirror=True)
            outs.append("[ответ → пользователь] " + report)
    if outs:
        history.append({"role": "assistant", "content": reply})
        history.append({"role": "user", "content":
            "=== вывод проверки отказа ===\n" + "\n\n".join(outs) +
            "\n\n[СИСТЕМА] Теперь дай новый <final> — выполни задание по прочитанной переписке "
            "или честно процитируй ошибку инструмента, если она реально была."})
        try:
            reply2, _ = zai_client.chat(
                [{"role": "system", "content": system}] + history,
                temperature=0.2, max_tokens=3000)
            final3, actions3 = parse_actions(reply2)
            # a bare <end>recap</end> close: the recap BODY is the visible line
            end_body = next((arg for kind, arg, _t in actions3 if kind == "end"), None)
            final2 = final3 or final2 or (end_body or "").strip() \
                or strip_protocol_tags(reply2) or reply2[:3000]
        except Exception:
            pass
    if not final2:
        end_body = next((arg for kind, arg, _t in actions if kind == "end"), None)
        final2 = (end_body or "").strip() or strip_protocol_tags(reply) or reply[:3000]
    return final2, tg_sends

def list_new_files(since_ts: float) -> list:
    """files created/modified in WS since the task started (for the final note)."""
    out = []
    for root, _, names in os.walk(WS):
        for n in names:
            p = os.path.join(root, n)
            try:
                st = os.stat(p)
                if st.st_mtime >= since_ts and st.st_size > 0:
                    out.append((os.path.relpath(p, WS), st.st_size))
            except OSError:
                continue
    return sorted(out, key=lambda x: -x[1])[:10]


def load_memory() -> str:
    try:
        with open(MEMORY, encoding="utf-8") as f:
            data = f.read().strip()
        return data[-1500:]
    except OSError:
        return "(память пуста — это первая задача в смене)"


def save_memory(task: str, final: str) -> None:
    try:
        prev = ""
        try:
            with open(MEMORY, encoding="utf-8") as f:
                prev = f.read()
        except OSError:
            pass
        line = f"- {time.strftime('%d.%m %H:%M')}: {task.strip()[:90]} → {final.strip()[:200]}\n"
        with open(MEMORY, "w", encoding="utf-8") as f:
            f.write((prev + line)[-4000:])
    except OSError:
        pass


def run_agent(task, budget_min=None) -> str:
    """run one agent task end-to-end; returns the final answer text."""
    global _last_progress, WS, MEMORY
    _last_progress = 0.0
    # per-run workspace/memory (multi-user: guests get their own dirs,
    # set by terminal_executor from the claim's guestChat)
    WS = os.environ.get("AGENT_WS") or "/tmp/ws"
    MEMORY = os.environ.get("AGENT_MEMORY") or "/tmp/agent_memory.md"
    os.makedirs(WS, exist_ok=True)
    # T33: the Telegram app is on the computer only when the repo checkout
    # actually contains it (guards against stale runner workspaces)
    tg_path = TG_APP if os.path.isfile(TG_APP) else ""
    if tg_path:
        os.environ["TG"] = tg_path  # inherited by every <cmd> subprocess
    started_ts = time.time()

    try:
        with open(AGENT_MD, encoding="utf-8") as f:
            system = f.read()
    except OSError:
        system = "Ты автономный агент на Ubuntu. Отвечай блоками <cmd> или <final>."

    try:
        skills = ", ".join(sorted(os.listdir(SKILLS_DIR))) or "нет"
    except OSError:
        skills = "нет"

    budget = BUDGET_MIN if not budget_min else min(budget_min, BUDGET_MIN)
    deadline = time.time() + budget * 60
    started = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    header = (
        f"# Задача от владельца (поступила {started})\n\n{task.strip()}\n\n"
        "# Окружение прямо сейчас\n"
        f"- cwd: {WS} (все файлы-результаты сюда)\n"
        f"- utcnow: {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())}\n"
        f"- скиллы (плейбуки): {SKILLS_DIR} — там есть: {skills}\n"
        "  перед задачей типа pdf/charts/docx/xlsx/pptx/media/web прочитай нужный плейбук\n"
        + (f"- приложение Telegram: node \"$TG\" help (действует от имени личного аккаунта владельца; как комбинировать с компьютером — см. AGENT.md)\n" if tg_path else "")
        + f"- память смены (итоги прошлых задач):\n{load_memory()}\n"
    )
    shm = shared_memory()
    if shm:
        header += (
            "# Общая память агента (важное из прошлых задач — видна владельцу на странице «Память»;\n"
            "# дополняй её тегом <memory>…</memory>):\n"
            f"{shm}\n"
        )
    if os.environ.get("AGENT_GUEST"):
        header += (
            "- заказчик — гость из Telegram (не владелец): обращайся нейтрально и вежливо;\n"
            "  `<send to=\"owner\">` доставит файл ИМЕННО ему в личку; канал и третьи лица недоступны\n"
        )
    history = [{"role": "user", "content": header}]
    final_text = ""
    last_cmd_sig = ""
    same_cmd_runs = 0
    send_files_ok = 0   # T21a: files actually delivered by successful <send>s
    tg_ok = 0           # T52b: successful "$TG send/sendfile" deliveries in <cmd>s

    # T48: internal apps state — <answer>/<file> deliveries
    delivered_files = set()     # basenames already handed to the user mid-task
    # T49: the agent's own STOP command state
    ended = False               # <end> seen — finish after this reply's actions
    end_note = ""               # optional closing line inside <end>…</end>

    heartbeat()  # initial silent beat (T16: no user-visible "took the task" line)

    # T24: AGENT_MAX_STEPS=0 means unlimited steps - bound only by the deadline
    step_cap = MAX_STEPS if MAX_STEPS > 0 else 10 ** 9
    for step in range(1, step_cap + 1):
        if time.time() > deadline:
            history.append({"role": "user",
                            "content": "[СИСТЕМА] время задачи истекло — больше не запускай команд, дай <final> о том, что сделано."})
            reply, _ = zai_client.chat(
                [{"role": "system", "content": system}] + history,
                temperature=0.2, max_tokens=1500)
            final_text = (RE_FINAL.search(reply).group(1).strip()
                          if RE_FINAL.search(reply) else reply[:3000])
            break

        # ---- ask the model (resilient: one retry, then graceful exit)
        reply = None
        for attempt in range(2):
            try:
                reply, model = zai_client.chat(
                    [{"role": "system", "content": system}] + history,
                    temperature=0.3, max_tokens=4000)
                break
            except Exception as e:
                if attempt == 1:
                    files_note = list_new_files(started_ts)
                    note = ("\n\n⚠️ Связь с моделью потерялась на шаге %d (%s). "
                            "Всё, что успело сделаться, — в файлах." % (step, str(e)[:120]))
                    if files_note:
                        note += "\n📎 Файлы: " + ", ".join(
                            f"{p} ({s // 1024} КБ)" for p, s in files_note)
                    save_memory(task, "ОШИБКА СВЯЗИ на шаге %d" % step)
                    return (final_text or "") + note
                time.sleep(8)  # T49: quicker retry - the loop must not stall
        final, actions = parse_actions(reply)

        if not actions:
            # no directives -> treat the whole reply as the final answer
            final_text = final or reply[:3000].strip()
            break

        # T52: the ONLY non-contact action left is <memory>. A reply that
        # carries nothing but memory notes plus plain text IS the answer —
        # persist the memories and deliver the text (tags are optional).
        if not final and not ended and all(k == "memory" for k, _a, _t in actions):
            body = strip_protocol_tags(reply)
            if body:
                for _k, mtext, _t in actions[:6]:
                    memory_append(mtext, "memory")
                final_text = body
                break
            # memory-only reply with no visible text: fall through to normal
            # execution (the [память] feedback goes back, the loop continues)

        answered_now = any(k == "answer" for k, _a, _t in actions[:6])

        # ---- execute the requested actions in order -------------------------
        outputs = []
        for kind, arg, tmo in actions[:6]:
            if kind == "cmd":
                sig = re.sub(r"\s+", " ", arg)[:200]
                same_cmd_runs = same_cmd_runs + 1 if sig == last_cmd_sig else 1
                last_cmd_sig = sig
                rc, dt, outp = run_bash(arg, tmo)
                track_tg_send(arg, outp)  # T54: remember texts actually delivered
                outputs.append(f"$ {arg[:400]}\n(exit {rc}, {dt} c)\n{outp or '(пустой вывод)'}")
                # T52b: the Telegram app delivering a message/file IS an honest
                # delivery - count it so the truth guard never nags a real DM reply
                if re.search(r'(\$TG|tg\.js)', arg) and re.search(r'\bsend(file)?\b', arg) \
                        and RE_TG_SEND_OK.search(outp or ""):
                    tg_ok += 1
                heartbeat()
                if same_cmd_runs >= 3:
                    outputs.append("[СИСТЕМА] эта команда уже повторяется 3-й раз без успеха — смени подход.")
            elif kind == "search":
                res = zai_client.web_search(arg)
                outputs.append(f"[поиск: {arg}]\n{res}")
                heartbeat()
            elif kind == "read":
                res = zai_client.read_page(arg)
                outputs.append(f"[страница: {arg}]\n{res}")
                heartbeat()
            elif kind == "send":
                to, fpath, body = arg
                outp, ok, n = do_send(to, fpath, body)
                if ok and n:
                    send_files_ok += n
                track_send(to, body, ok)  # T54: remember texts actually delivered
                outputs.append(outp)
                heartbeat()
            elif kind == "answer":
                # T48 app #1: CONTACT the user now (mid-task message)
                report, ok, _n = do_send("owner", "", arg, mirror=True)
                outputs.append("[ответ → пользователь] " + report)
                heartbeat()
            elif kind == "mfile":
                # T48 app #2: ATTACH a file now (mid-task delivery)
                report, ok, n = do_send("owner", arg,
                                        "📎 файл из процесса работы", mirror=True)
                if ok and n:
                    send_files_ok += n
                    delivered_files.add(os.path.basename(arg.replace("\\", "/")).lower())
                outputs.append("[файл → пользователь] " + report)
                heartbeat()
            elif kind == "memory":
                # T52: WRITE to the shared agent memory (site page «Память» +
                # local shift memory). Non-blocking, honest feedback.
                outputs.append("[память] " + ("✅ записано в общую память" if memory_append(arg, "memory")
                                              else "❌ сайт недоступен — сохранил только локально"))
            elif kind == "end":
                # T49 app #4: FINISH the task on the agent's own decision
                # (it already delivered its answers/files and considers the
                # job done). Remaining actions of THIS reply still execute.
                ended = True
                end_note = str(arg or "").strip()
                outputs.append("[режим] команда <end>: завершаю работу" +
                               (" — " + end_note[:200] if end_note else ""))

        if answered_only := (answered_now and all(k == "answer" for k, _a, _t in actions[:6]) and not final):
            outputs.append("[СИСТЕМА] ответ доставлен ✅ — пользователь его получил. Дальше решаешь ты: "
                           "продолжай работу действиями (<cmd>/<search>/<read>/<file>…), дай <final> с итоговым "
                           "отчётом, ИЛИ заверши задачу командой <end>краткий пересказ сделанного</end> — "
                           "внутри тега ОБЯЗАТЕЛЬНО напиши краткий пересказ всего, что сделал в этом запросе "
                           "(человек увидит его сообщением в Telegram), если всё сделано и сказано.")

        history.append({"role": "assistant", "content": reply})
        compact(history)
        history.append({
            "role": "user",
            "content": ("=== вывод шага %d ===\n" % step) + "\n\n".join(outputs)})
        compact(history)
        if ended:
            break  # T49: the agent decided the task is done — stop gracefully
    else:
        # step cap reached (only possible when AGENT_MAX_STEPS > 0): force a final
        try:
            reply, _ = zai_client.chat(
                [{"role": "system", "content": system}] + history +
                [{"role": "user", "content": "[СИСТЕМА] достигнут лимит шагов — дай <final> сейчас."}],
                temperature=0.2, max_tokens=1500)
            m = RE_FINAL.search(reply)
            final_text = m.group(1).strip() if m else reply[:3000]
        except Exception as e:
            final_text = f"Лимит шагов исчерпан, финал не получен: {e}"

    # ---- T16: no automatic file listing here. The agent lists the files it
    # wants to deliver with <file>...</file> tags (AGENT.md protocol);
    # /api/terminal/gh/result parses them and delivers ONLY those. An output
    # without the <answer> protocol keeps the legacy deliver-everything mode.
    # T21a: before anything leaves the runner, the final is checked against
    # reality — the agent either creates the promised file or the user gets
    # an honest system note instead of a phantom "created and sent".
    # T48: files already delivered mid-task (<file>/<send>) are dropped from
    # the final batch so the user never receives the same file twice.
    # T49: an <end> without a co-present <final> still leaves the user a
    # short honest closing line (the <end> body, or a default one).
    # T51 (owner request 2026-10-23): the <end> body MUST be a SHORT RECAP of
    # everything the agent did in THIS request — the user sees exactly that
    # message when opening the Telegram bot chat. An empty <end> gets ONE
    # corrective model turn asking for the recap; if that fails too, the
    # honest default line still closes the task.
    # T52: NO format retries anymore (tags are optional). The <end> recap is
    # also appended to the SHARED agent memory (source 'end').
    if ended and not (final_text or ""):
        if final and final.strip():
            final_text = final.strip()  # <final> + <end> in the same reply
        else:
            close = end_note if end_note else ""
            if not close and len(history) > 1:
                try:
                    r, _ = zai_client.chat(
                        [{"role": "system", "content": system}] + history[-8:] +
                        [{"role": "user", "content":
                          "[СИСТЕМА] ты завершил задачу командой <end>, но не написал пересказ. "
                          "Напиши КРАТКИЙ пересказ (2-5 предложений) всего, что ты сделал в ЭТОЙ задаче: "
                          "что именно сделал, что получилось, какие файлы/сообщения доставил пользователю. "
                          "Ответь ТОЛЬКО текстом пересказа — без тегов, без приветствий."}],
                        temperature=0.2, max_tokens=700)
                    close = RE_THINK.sub("", r or "")
                    close = re.sub(r"<[^>\n]{1,60}>", " ", close)  # strip stray tags
                    close = re.sub(r"\s+", " ", close).strip()
                except Exception:
                    close = ""
            final_text = "<answer>" + ("✅ " + close[:2000] if close
                                       else "✅ Готово — работа завершена.") + "</answer>"
    if delivered_files:
        final_text = dedup_final_files(final_text, delivered_files)
    # T52b: a fake "no access to the correspondence" refusal gets ONE chance to
    # actually use the tools (read the chat via $TG) before it ships; the new
    # final then goes through the file-claims truth guard as usual.
    final_text, guard_tg = refusal_guard(final_text, bool(tg_path), task, system, history)
    tg_ok += guard_tg
    # T54: the owner must see a REPORT (кому/на что/чем ответил), not the raw
    # text the agent sent to the correspondent — one corrective rewrite when
    # the final <answer> duplicates a delivered text.
    final_text = report_guard(final_text, system, history)
    final_text = truth_guard(final_text, system, history, send_files_ok, tg_ok)
    if ended and end_note and end_note.strip():
        memory_append(end_note, "end")
    save_memory(task, final_text)
    return final_text or "(агент закончил без финального ответа)"


if __name__ == "__main__":
    # manual test: AGENT_BUDGET_MIN=1 python3 agent_runner.py "задача"
    print(run_agent(sys.argv[1] if len(sys.argv) > 1 else "тест: выполни uptime"))
