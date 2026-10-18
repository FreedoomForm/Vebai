#!/usr/bin/env python3
"""Agentic loop for vebai's resident GitHub Actions executor (owner request
2026-10-18): instead of one big shell command, the runner becomes a real
agent - it reads AGENT.md, plans with GLM (same official Z.ai API as the
site), executes its own bash commands one by one inside the persistent
/tmp/ws workspace, observes the output, fixes its mistakes and only then
reports the final answer. Progress lines are mirrored to the owner's
Telegram via /api/terminal/gh/progress; produced files are collected by
the executor's post_result (mtime diff of /tmp/ws) as before.

Protocol (see AGENT.md): the model answers with <cmd to="900">...</cmd>,
<search>...</search>, <read>...</read>, <send to="owner" file="...">...</send>
or <final>...</final> blocks. <send> delivers texts/files to a person via the
Telegram bot right now (owner's private chat by default) instead of waiting
for the end-of-task result batch.
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

MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS") or "30")
BUDGET_MIN = float(os.environ.get("AGENT_BUDGET_MIN") or "45")
STEP_TMO_DEFAULT = 180   # seconds per bash command
STEP_TMO_MAX = 900       # hard cap: keeps command-row heartbeat gaps < 25 min
TOOL_OUT_CAP = 6000      # per-step output chars fed back to the model
HISTORY_SOFT_CAP = 60_000

AGENT_MD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "AGENT.md")

RE_CMD = re.compile(r"<cmd(?:\s+to\s*=\s*\"?(\d+)\"?)?\s*>([\s\S]*?)</cmd>", re.I)
RE_SEARCH = re.compile(r"<search>([\s\S]*?)</search>", re.I)
RE_READ = re.compile(r"<read>([\s\S]*?)</read>", re.I)
RE_SEND = re.compile(r"<send\b([^>]*?)/?>([\s\S]*?)</send>", re.I)
RE_ATTR = re.compile(r"(\w+)\s*=\s*[\"']([^\"']*)[\"']")
RE_FINAL = re.compile(r"<final>([\s\S]*?)</final>", re.I)
RE_THINK = re.compile(r"<think>[\s\S]*?</think>|<thought>[\s\S]*?</thought>", re.I)

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


def redact(text: str) -> str:
    """the bot is multi-user now: scrub runner secrets from anything that
    travels to users (a task could run `printenv`)"""
    for v in (SECRET, os.environ.get("ZAI_API_KEY") or ""):
        if v and v in text:
            text = text.replace(v, "***")
    return text


def post_progress(text: str) -> None:
    """mirror a short progress line to the owner's Telegram (best effort)."""
    global _last_progress
    now = time.time()
    if now - _last_progress < 20:  # telegram flood safety
        return
    _last_progress = now
    if not (SECRET and SESSION):
        return
    try:
        api("/api/terminal/gh/progress",
            {"secret": SECRET, "session": SESSION, "text": redact(str(text))[:400]},
            timeout=30)
    except Exception:
        pass  # progress must never break the loop


def do_send(to: str, file_path: str, text: str) -> str:
    """deliver a text/file to a person via the site's /api/terminal/gh/send;
    returns a one-line report the model reads on its next turn."""
    to = (to or "owner").strip() or "owner"
    files = []
    if file_path:
        p = os.path.realpath(
            file_path if os.path.isabs(file_path) else os.path.join(WS, file_path))
        ws_root = os.path.realpath(WS)
        if os.path.commonpath([p, ws_root]) != ws_root:
            return (f"[send → {to}] ❌ файл должен лежать внутри {WS} "
                    f"(получено: {file_path})")
        if not os.path.isfile(p):
            return f"[send → {to}] ❌ файл не найден: {file_path}"
        size = os.path.getsize(p)
        if size == 0:
            return f"[send → {to}] ❌ файл пустой: {file_path}"
        if size > MAX_SEND_BYTES:
            return (f"[send → {to}] ❌ файл {size // 1024} КБ больше лимита 3.3 МБ — "
                    "сожми (zip -9, jpg-качество) или раздели на части")
        import base64
        with open(p, "rb") as f:
            files.append({"name": os.path.basename(p),
                          "b64": base64.b64encode(f.read()).decode()})
    text = (text or "").strip()
    if not text and not files:
        return f"[send → {to}] ❌ пусто: укажи file=\"...\" или напиши текст"
    if not (SECRET and SESSION):
        return "[send] ❌ SECRET/SESSION не заданы — отправка недоступна"
    try:
        res = api("/api/terminal/gh/send",
                  {"secret": SECRET, "session": SESSION, "chat": to,
                   "text": text[:8000], "files": files},
                  timeout=120)
    except Exception as e:
        return f"[send → {to}] ❌ доставка не удалась: {str(e)[:150]}"
    if res.get("ok"):
        done = []
        if res.get("textSent"):
            done.append(f"текст доставлен ({res['textSent']} сообщ.)")
        if res.get("filesSent"):
            done.append(f"файлов доставлено: {res['filesSent']}")
        return f"[send → {res.get('chat') or to}] ✅ " + "; ".join(done)
    errs = "; ".join(res.get("errors") or [res.get("error") or "неизвестная ошибка"])
    return f"[send → {to}] ❌ {errs[:300]}"


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
    """extract (final_text|None, [action tuples]) from a model reply."""
    reply = RE_THINK.sub("", reply)
    final = None
    m = RE_FINAL.search(reply)
    if m:
        final = m.group(1).strip()
    actions = []
    for m in RE_CMD.finditer(reply):
        to = m.group(1)
        actions.append(("cmd", m.group(2).strip(),
                        min(int(to) if to and to.isdigit() else STEP_TMO_DEFAULT,
                            STEP_TMO_MAX)))
    for m in RE_SEARCH.finditer(reply):
        q = m.group(1).strip()
        if q:
            actions.append(("search", q, 30))
    for m in RE_READ.finditer(reply):
        u = m.group(1).strip()
        if u:
            actions.append(("read", u, 40))
    for m in RE_SEND.finditer(reply):
        attrs = {k.lower(): v for k, v in RE_ATTR.findall(m.group(1))}
        body = m.group(2).strip()
        # tolerate file specified inside the body: "file: /tmp/ws/x.pdf"
        fpath = attrs.get("file", "").strip()
        if not fpath:
            fm = re.search(r"^\s*(?:file|файл)\s*[:=]\s*(\S+)", body, re.I | re.M)
            if fm:
                fpath = fm.group(1)
                body = re.sub(r"^\s*(?:file|файл)\s*[:=].*$", "", body, flags=re.I | re.M).strip()
        actions.append(("send", (attrs.get("to", "").strip(), fpath, body), 60))
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


# ---------------------------------------------------------------------- main

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
        f"- память смены (итоги прошлых задач):\n{load_memory()}\n"
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

    post_progress(f"🏁 взял задачу: {task.strip()[:120]}")

    for step in range(1, MAX_STEPS + 1):
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
                time.sleep(15)
        final, actions = parse_actions(reply)

        if not actions:
            # no directives -> treat the whole reply as the final answer
            final_text = final or reply[:3000].strip()
            break

        # ---- execute the requested actions in order
        outputs = []
        for kind, arg, tmo in actions[:6]:
            if kind == "cmd":
                sig = re.sub(r"\s+", " ", arg)[:200]
                same_cmd_runs = same_cmd_runs + 1 if sig == last_cmd_sig else 1
                last_cmd_sig = sig
                rc, dt, outp = run_bash(arg, tmo)
                outputs.append(f"$ {arg[:400]}\n(exit {rc}, {dt} c)\n{outp or '(пустой вывод)'}")
                post_progress(f"⚙️ шаг {step}/{MAX_STEPS}: {arg.strip()[:130]}")
                if same_cmd_runs >= 3:
                    outputs.append("[СИСТЕМА] эта команда уже повторяется 3-й раз без успеха — смени подход.")
            elif kind == "search":
                res = zai_client.web_search(arg)
                outputs.append(f"[поиск: {arg}]\n{res}")
                post_progress(f"🔍 шаг {step}/{MAX_STEPS}: ищу «{arg[:100]}»")
            elif kind == "read":
                res = zai_client.read_page(arg)
                outputs.append(f"[страница: {arg}]\n{res}")
                post_progress(f"📄 шаг {step}/{MAX_STEPS}: читаю страницу")
            elif kind == "send":
                to, fpath, body = arg
                outp = do_send(to, fpath, body)
                outputs.append(outp)
                post_progress(f"📤 шаг {step}/{MAX_STEPS}: {outp[:130]}")

        history.append({"role": "assistant", "content": reply})
        compact(history)
        history.append({
            "role": "user",
            "content": ("=== вывод шага %d ===\n" % step) + "\n\n".join(outputs)})
        compact(history)
    else:
        # step budget exhausted: force a final summary
        try:
            reply, _ = zai_client.chat(
                [{"role": "system", "content": system}] + history +
                [{"role": "user", "content": "[СИСТЕМА] достигнут лимит шагов — дай <final> сейчас."}],
                temperature=0.2, max_tokens=1500)
            m = RE_FINAL.search(reply)
            final_text = m.group(1).strip() if m else reply[:3000]
        except Exception as e:
            final_text = f"Лимит шагов исчерпан, финал не получен: {e}"

    # ---- self-check: attach the real file list (runner-side verification)
    files = list_new_files(started_ts)
    if files:
        listing = ", ".join(f"{p} ({s // 1024} КБ)" if s >= 1024 else f"{p} ({s} Б)"
                            for p, s in files)
        final_text += f"\n\n📎 Файлы: {listing}"
    save_memory(task, final_text)
    return final_text or "(агент закончил без финального ответа)"


if __name__ == "__main__":
    # manual test: AGENT_BUDGET_MIN=1 python3 agent_runner.py "задача"
    print(run_agent(sys.argv[1] if len(sys.argv) > 1 else "тест: выполни uptime"))
