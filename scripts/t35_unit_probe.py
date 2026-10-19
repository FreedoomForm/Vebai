#!/usr/bin/env python3
"""T35 local unit probe: protocol_problems + format-guard plumbing of
agent_runner.py (no network, no model calls)."""
import os
import sys
import time
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".github"))
import agent_runner as ar  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(detail)[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


# --- protocol_problems ------------------------------------------------------
ar.WS = tempfile.mkdtemp(prefix="t35ws_")  # empty workspace
started = time.time() - 5

p = ar.protocol_problems("", started)
check("empty final -> 'empty' problem", len(p) == 1 and "ПУСТ" in p[0], p)

p = ar.protocol_problems("Готово, всё сделал", started)
check("untagged final -> no <answer> problem", len(p) == 1 and "БЕЗ обёртки" in p[0], p)

p = ar.protocol_problems("<final><answer></answer></final>", started)
check("empty <answer> -> no <answer> problem", len(p) == 1 and "БЕЗ обёртки" in p[0], p)

p = ar.protocol_problems("<answer>Готово: отчёт готов.</answer>", started)
check("tagged, no files, empty ws -> OK", p == [], p)

# a new file appears in WS -> tagged final without <file> must be flagged
with open(os.path.join(ar.WS, "otchet.pdf"), "wb") as f:
    f.write(b"%PDF-1.4 test")
p = ar.protocol_problems("<answer>Готово: отчёт готов.</answer>", started)
check("new file + no <file> -> flagged", len(p) == 1 and "<file>" in p[0] and "otchet.pdf" in p[0], p)

p = ar.protocol_problems("<answer>Готово.</answer>\n<file>otchet.pdf</file>", started)
check("new file + <file> tag -> OK", p == [], p)

p = ar.protocol_problems("<answer>Готово.</answer>\n<file>net_takogo.pdf</file>", started)
check("file tag only (listed) -> no format problem (honesty is truth_guard's job)", p == [], p)

# --- parse_actions still fine (regression) ----------------------------------
final, actions = ar.parse_actions("<cmd to='60'>echo hi</cmd>")
check("parse_actions cmd", final is None and actions and actions[0][0] == "cmd" and actions[0][2] == 60, actions)

final, actions = ar.parse_actions("<final><answer>Ответ</answer><file>a.pdf</file></final>")
check("parse_actions final", final and "Ответ" in final and actions == [], (final, actions))

# --- format_guard: broken final + model that fixes it on round 1 ------------
calls = {"n": 0}


class FakeClient:
    @staticmethod
    def chat(messages, temperature=0.3, max_tokens=4000):
        calls["n"] += 1
        last = messages[-1]["content"]
        assert "ПРОВЕРКА ФОРМАТА" in last or "Теперь дай <final>" in last, last[:120]
        return ("<final><answer>Исправленный честный ответ.</answer>"
                "<file>otchet.pdf</file></final>", "glm-test")


orig_chat = ar.zai_client.chat
ar.zai_client.chat = FakeClient.chat
hist = [{"role": "user", "content": "задача"}]
out, sfo = ar.format_guard("<final><answer></answer></final>", "sys", hist, started, 0)
ar.zai_client.chat = orig_chat
check("format_guard retries empty answer", "Исправленный" in out and "otchet.pdf" in out, out)
check("format_guard corrective note in history", any("ПРОВЕРКА ФОРМАТА" in m["content"] for m in hist))

# --- format_guard: already-correct final -> zero model calls ----------------
calls2 = {"n": 0}


class FakeClient2:
    @staticmethod
    def chat(messages, temperature=0.3, max_tokens=4000):
        calls2["n"] += 1
        return ("<final><answer>ок</answer></final>", "glm-test")


ar.zai_client.chat = FakeClient2.chat
ar.WS = tempfile.mkdtemp(prefix="t35ws_clean_")  # fresh empty workspace: no new files -> no <file> duty
out2, _ = ar.format_guard("<answer>Готово.</answer>", "sys", [], started, 0)
ar.zai_client.chat = orig_chat
check("correct final -> no retry call", calls2["n"] == 0 and out2 == "<answer>Готово.</answer>", (calls2["n"], out2))

# --- format_guard: model keeps failing -> 2 rounds then give up with best ---
calls3 = {"n": 0}


class FakeClient3:
    @staticmethod
    def chat(messages, temperature=0.3, max_tokens=4000):
        calls3["n"] += 1
        return ("всё ещё без тегов", "glm-test")


ar.zai_client.chat = FakeClient3.chat
out3, _ = ar.format_guard("", "sys", [], started, 0)
ar.zai_client.chat = orig_chat
check("persistent empty -> 2 rounds max, delivers best effort", calls3["n"] == 2 and out3 == "всё ещё без тегов",
      (calls3["n"], out3))

print()
print("T35 PY PROBE:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")
sys.exit(1 if fails else 0)
