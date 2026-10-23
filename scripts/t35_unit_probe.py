#!/usr/bin/env python3
"""T35/T52 local unit probe: parse_actions regression + the T52 protocol
changes in agent_runner.py (no network, no model calls).

T52 (owner request 2026-10-23): <work> is GONE, <memory> writes to the
shared memory, tags are optional (a plain-text reply IS the answer) and the
format auto-repeat machinery (protocol_problems + format_guard) is REMOVED.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".github"))
import agent_runner as ar  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(detail)[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


# --- parse_actions regression ------------------------------------------------
final, actions = ar.parse_actions("<cmd to='60'>echo hi</cmd>")
check("parse_actions cmd", final is None and actions and actions[0][0] == "cmd" and actions[0][2] == 60, actions)

final, actions = ar.parse_actions("<final><answer>Ответ</answer><file>a.pdf</file></final>")
check("parse_actions final", final and "Ответ" in final and actions == [], (final, actions))

# --- T52: <work> is gone, <memory> is parsed ---------------------------------
final, actions = ar.parse_actions("<work>silent 20m — собираю</work>")
check("work tag is NO action now", final is None and actions == [], (final, actions))

final, actions = ar.parse_actions("мысль <memory>Владелец любит краткость</memory>")
check("memory action parsed", final is None and actions and actions[0][0] == "memory"
      and actions[0][1] == "Владелец любит краткость", (final, actions))

final, actions = ar.parse_actions("<memory>первое</memory><memory>второе</memory>")
check("two memory actions", len(actions) == 2 and actions[0][1] == "первое" and actions[1][1] == "второе", actions)

final, actions = ar.parse_actions("<end/>")
check("end self-closed still parses", bool(actions) and actions[0][0] == "end" and actions[0][1] == "", actions)

# --- T52: strip_protocol_tags -------------------------------------------------
body = ar.strip_protocol_tags("Ответ пользователю.\n<memory>заметка</memory><end>пересказ</end>")
check("strip leaves visible text", body == "Ответ пользователю.", repr(body))

body = ar.strip_protocol_tags(
    "Проверка <think>скрытые мысли</think> текста.\n<cmd to='30'>ls</cmd>"
    "<send to='owner'>прив</send><memory>m</memory>")
check("strip removes cmd/send/think", "скрытые" not in body and "ls" not in body
      and "прив" not in body and "Проверка" in body and "текста" in body, repr(body))

# --- T52: format machinery REMOVED --------------------------------------------
check("format_guard removed", not hasattr(ar, "format_guard"))
check("protocol_problems removed", not hasattr(ar, "protocol_problems"))

# --- T52: memory_append writes locally without SECRET -------------------------
ar.SECRET = ""
tmp = tempfile.mkdtemp(prefix="t52mem_")
ar.MEMORY = os.path.join(tmp, "mem.md")
ok = ar.memory_append("Тестовая заметка о владельце", "memory")
check("memory_append local-only without secret", ok is False)
content = open(ar.MEMORY, encoding="utf-8").read() if os.path.exists(ar.MEMORY) else ""
check("memory_append wrote the local file", "Тестовая заметка о владельце" in content, content)

# --- T52: shared_memory() without secret is safe ------------------------------
check("shared_memory no secret -> ''", ar.shared_memory() == "")

print()
print("T35/T52 PY PROBE:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")
sys.exit(1 if fails else 0)
