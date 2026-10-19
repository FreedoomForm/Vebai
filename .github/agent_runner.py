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

Protocol (see AGENT.md): the model answers with <cmd to="900">...</cmd>,
<search>...</search>, <read>...</read>, <send to="owner" file="...">...</send>
or <final>...</final> blocks. <send> delivers texts/files to a person via the
Telegram bot right now (the task sender's private chat by default) instead
of waiting for the end-of-task result batch.
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

RE_CMD = re.compile(r"<cmd(?:\s+to\s*=\s*\"?(\d+)\"?)?\s*>([\s\S]*?)</cmd>", re.I)
RE_SEARCH = re.compile(r"<search>([\s\S]*?)</search>", re.I)
RE_READ = re.compile(r"<read>([\s\S]*?)</read>", re.I)
RE_SEND = re.compile(r"<send\b([^>]*?)/?>([\s\S]*?)</send>", re.I)
RE_ATTR = re.compile(r"(\w+)\s*=\s*[\"']([^\"']*)[\"']")
RE_FINAL = re.compile(r"<final>([\s\S]*?)</final>", re.I)
RE_THINK = re.compile(r"<think>[\s\S]*?</think>|<thought>[\s\S]*?</thought>", re.I)
RE_ANSWER = re.compile(r"<answer>([\s\S]*?)</answer>", re.I)
RE_FTAG = re.compile(r"<file>([\s\S]*?)</file>", re.I)

# T21a truth guard: file names mentioned in the visible answer, and claims
# that something was already sent/attached (the agent must never say it
# created/sent a file that does not exist).
RE_EXT_FILE = re.compile(
    r"[\w\-.]+\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|7z|rar|png|jpe?g|gif|webp|mp4|mp3|wav|txt|json|html?|svg|md)\b",
    re.I)
RE_SEND_CLAIM = re.compile(
    r"отправ(?:лен|ил|лю|ка)|доставл|прикрепл|выслал|вложени", re.I)

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


def heartbeat() -> None:
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
            {"secret": SECRET, "session": SESSION, "text": "работаю"},
            timeout=30)
    except Exception:
        pass  # keepalive must never break the loop


def do_send(to: str, file_path: str, text: str):
    """deliver a text/file to a person via the site's /api/terminal/gh/send;
    returns (one-line report the model reads on its next turn, ok, files_sent)."""
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
                   "text": text[:8000], "files": files},
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


def analyze_final(final_text: str, real: set, send_files_ok: int):
    """returns (answer, missing, claimed):
    answer  — the visible <answer> text ('' if the final is not tagged);
    missing — file names the final promises (via <file> tags or mentions in
              the answer) that do NOT exist in the workspace;
    claimed — the answer says the file was sent/attached, but no <send> of a
              file ever succeeded and none of the promised files exists."""
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
        and send_files_ok == 0
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


def truth_guard(final_text: str, system: str, history: list, send_files_ok: int) -> str:
    """verify the final against reality: ONE corrective round-trip (create
    the missing files / re-send / rewrite the final honestly), then an
    honest note if the agent still fails to deliver."""
    final_text = (final_text or "").strip()
    if not final_text:
        return final_text
    _, missing, claimed = analyze_final(final_text, ws_files_basenames(), send_files_ok)
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
    _, missing2, claimed2 = analyze_final(final2, ws_files_basenames(), send_files_ok)
    if missing2 or claimed2:
        final2 = append_honest_note(final2, missing2, claimed2)
    return final2


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
    send_files_ok = 0   # T21a: files actually delivered by successful <send>s

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
                outputs.append(outp)
                heartbeat()

        history.append({"role": "assistant", "content": reply})
        compact(history)
        history.append({
            "role": "user",
            "content": ("=== вывод шага %d ===\n" % step) + "\n\n".join(outputs)})
        compact(history)
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
    final_text = truth_guard(final_text, system, history, send_files_ok)
    save_memory(task, final_text)
    return final_text or "(агент закончил без финального ответа)"


if __name__ == "__main__":
    # manual test: AGENT_BUDGET_MIN=1 python3 agent_runner.py "задача"
    print(run_agent(sys.argv[1] if len(sys.argv) > 1 else "тест: выполни uptime"))
