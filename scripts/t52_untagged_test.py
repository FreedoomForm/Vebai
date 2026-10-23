"""T52: tags are OPTIONAL — a plain-text reply (with or without <memory>
notes) IS the answer; <memory> lands in the shared memory (local fallback
here). Unit smoke with a fake zai_client, no network.

Сценарии:
 1) plain-text reply (no tags)      -> returned as the answer, no retries
 2) text + <memory>…</memory>       -> memory persisted (local file), text delivered
 3) memory-only reply, no text      -> loop continues, [память] feedback goes back
 4) legacy tagged final still works
Запуск: python3 scripts/t52_untagged_test.py  (stdlib only)"""
import os
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, ".github"))

tmp = tempfile.mkdtemp(prefix="t52ws")
os.environ["AGENT_WS"] = tmp
os.environ["AGENT_MEMORY"] = os.path.join(tmp, "mem.md")
os.environ["AGENT_MAX_STEPS"] = "6"
os.environ.pop("AGENT_GUEST", None)
os.environ.pop("SECRET", None)

import agent_runner  # noqa: E402

agent_runner.SECRET = ""  # memory_append -> local-file fallback path
agent_runner.MEMORY = os.path.join(tmp, "mem.md")

fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  | " + extra))
    if not cond:
        fails.append(name)


class FakeZai:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def chat(self, messages, **kw):
        self.calls.append(str((messages[-1] or {}).get("content") or "")[:160])
        if not self.replies:
            raise RuntimeError("no scripted reply left")
        return self.replies.pop(0), {"tokens": 1}


def run(replies):
    z = FakeZai(replies)
    agent_runner.zai_client = z
    return agent_runner.run_agent("тест: ответь без тегов"), z


# 1: plain text, no tags at all -> the text IS the answer
out, z = run(["Просто отвечаю без всяких тегов, по-человечески."])
check("plain text = answer", out.strip() == "Просто отвечаю без всяких тегов, по-человечески.", out)
check("one model call, no retries", len(z.calls) == 1, str(len(z.calls)))

# 2: text + memory note -> memory saved locally, text delivered
mem_path = agent_runner.MEMORY
out, z = run(["Вот итог проверки.\n<memory>Владелец любит короткие ответы</memory>"])
check("text+memory -> text delivered", "Вот итог проверки." in out and "memory>" not in out, out)
check("memory written to local store",
      os.path.exists(mem_path) and "Владелец любит короткие ответы" in open(mem_path, encoding="utf-8").read())

# 3: memory-only reply (no visible text) -> loop continues with feedback
out, z = run(["<memory>важный факт про проект</memory>",
              "Готово: всё проверил и отчитываюсь."])
check("memory-only then final", "Готово: всё проверил" in out, out)
check("memory-only feedback went back", any("[память]" in c for c in z.calls), str(z.calls)[:200])
check("memory from step persisted",
      "важный факт про проект" in open(mem_path, encoding="utf-8").read())

# 4: legacy tagged final still works
out, z = run(["<final><answer>Обычный финал по протоколу.</answer></final>"])
check("tagged final works", "Обычный финал по протоколу." in out, out)

print()
print("T52 UNTAGGED:", "ALL PASS" if not fails else "FAILURES: " + "; ".join(fails))
sys.exit(1 if fails else 0)
