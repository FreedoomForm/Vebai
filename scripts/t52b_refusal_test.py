"""T52b: a fake "no access to the correspondence" refusal must NOT ship.
The owner's real field case (2026-10-23): task "+998998166010 ответ ей исходя
из контекста того что мы с ней обсуждали" -> the agent answered "у меня нет
доступа к содержанию вашей предыдущей переписки" instead of reading the chat
with its own Telegram app. refusal_guard gives it ONE corrective round:
read the chat (node "$TG" read), do the job on the real transcript, give a
new final. Unit smoke with a fake zai_client; the "$TG" command runs as a
harmless local `echo` (no network, no Telegram).
Запуск: python3 scripts/t52b_refusal_test.py  (stdlib only)"""
import os
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, ".github"))

tmp = tempfile.mkdtemp(prefix="t52bws")
os.environ["AGENT_WS"] = tmp
os.environ["AGENT_MEMORY"] = os.path.join(tmp, "mem.md")
os.environ["AGENT_MAX_STEPS"] = "6"
os.environ.pop("AGENT_GUEST", None)
os.environ.pop("SECRET", None)

import agent_runner  # noqa: E402

agent_runner.SECRET = ""  # heartbeat/memory_append -> local no-op fallback
agent_runner.MEMORY = os.path.join(tmp, "mem.md")
TG_REAL = os.path.join(BASE, ".github", "tg.js")

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
        self.calls.append(str((messages[-1] or {}).get("content") or "")[:400])
        if not self.replies:
            raise RuntimeError("no scripted reply left")
        return self.replies.pop(0), {"tokens": 1}


TASK = "+998998166010 ответ ей исходя из контекста того что мы с ней обсуждали"
REFUSAL = ("Извините, у меня нет доступа к содержанию вашей предыдущей "
           "переписки с этим человеком. Пожалуйста, предоставьте ключевые "
           "моменты или выдержки из ваших сообщений.")


def run(task, replies):
    z = FakeZai(replies)
    agent_runner.zai_client = z
    return agent_runner.run_agent(task), z


# 1: the real field case: refusal -> guard fires -> read+send cmds -> honest final
# (the corrective cmd simulates the TG app: "$TG send" in the command text +
# ok:true on stdout = an honest delivery, exactly what tg.js prints in prod)
out, z = run(TASK, [
    REFUSAL,
    '<cmd to="30">echo \'{"ok": true, "msgId": 42}\' # node "$TG" send "+998998166010"</cmd>',
    '<final><answer>Ответ ей отправлен исходя из реальной переписки.</answer></final>',
])
check("refusal intercepted, new final ships",
      "Ответ ей отправлен" in out and "нет доступа" not in out, out[:200])
check("guard fired: exactly 3 model calls", len(z.calls) == 3, str(len(z.calls)))
check("corrective nudge mentions $TG",
      any("ПРОВЕРКА ОТКАЗА" in c and "$TG" in c for c in z.calls), str(z.calls)[:300])
check("refusal itself was in the corrective history",
      any("нет доступа" in c for c in z.calls[1:]), str(z.calls[1:])[:300])
check("cmd output went back to the model",
      any('"ok": true' in c or '"ok":true' in c for c in z.calls), str(z.calls)[:300])
check("truth guard not fooled by \u00abотправлен\u00bb after a real $TG send (no extra call)",
      len(z.calls) == 3, str(len(z.calls)))

# 2: Telegram app unavailable -> guard stays silent (no corrective turn)
agent_runner.TG_APP = "/nonexistent/tg.js"
out2, z2 = run(TASK, [REFUSAL])
agent_runner.TG_APP = TG_REAL
check("no $TG app -> refusal ships untouched (1 call)",
      len(z2.calls) == 1 and "нет доступа" in out2, str(len(z2.calls)) + " " + out2[:120])

# 3: honest final without refusal phrases -> guard silent
out3, z3 = run("посчитай 2+2", ["Готово: 2 + 2 = 4."])
check("normal final untouched (1 call)",
      len(z3.calls) == 1 and "2 + 2 = 4" in out3, out3[:120])

# 4: refusal unrelated to correspondence + task without a person -> silent
out4, z4 = run("напиши стихотворение про осень",
               ["Извините, у меня нет доступа к базе стихов, уточните тему."])
check("non-TG refusal untouched (1 call)", len(z4.calls) == 1, str(len(z4.calls)))

# 5: refusal inside <end> recap also gets corrected (and ships WITHOUT tags)
out5, z5 = run(TASK, [
    '<end>Проверил: у меня нет доступа к вашей переписке с этим человеком, ничего не отправлял.</end>',
    '<cmd to="30">echo \'{"ok": true, "msgId": 43}\' # node "$TG" send "+998998166010"</cmd>',
    '<end>Прочитал переписку через Telegram, отправил ей ответ по контексту.</end>',
])
check("refusal in <end> corrected",
      "Прочитал переписку" in out5 and "нет доступа" not in out5, out5[:200])
check("end-path guard: 3 model calls", len(z5.calls) == 3, str(len(z5.calls)))
check("end-path final ships without <end> tag", "<end" not in out5 and "<answer" not in out5, out5[:200])

print()
print("T52B REFUSAL:", "ALL PASS" if not fails else "FAILURES: " + "; ".join(fails))
sys.exit(1 if fails else 0)
