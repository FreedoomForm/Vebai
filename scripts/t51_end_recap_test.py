"""T51: <end> обязан нести краткий пересказ сделанного в этом запросе
(заказ владельца 2026-10-23) — человек видит именно его сообщением бота,
открыв чат в Telegram. Unit smoke без сети: zai_client подменяется скриптом
ответов, SITE-вызовы не нужны (SECRET пуст -> heartbeat no-op).

Сценарии:
 1) <end>пересказ</end>            -> closing = тело тега, corrective НЕ зовётся
 2) <end></end> пустой             -> ОДИН corrective ход приносит пересказ
 3) corrective упал                -> честный дефолт «Готово — работа завершена»
 3b) corrective вернул мусор с тегами -> теги содраны, <final> из него не парсится
 4) <final> + <end> в одном ответе -> финал доставляется как есть
 5) регресс парсера: формы <end/>, <end></end>, <end>note</end>

Запуск: python3 scripts/t51_end_recap_test.py  (stdlib only)"""
import os
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, ".github"))

# изолированное окружение run_agent (до импорта agent_runner)
tmp = tempfile.mkdtemp(prefix="t51ws")
os.environ["AGENT_WS"] = tmp
os.environ["AGENT_MEMORY"] = os.path.join(tmp, "mem.md")
os.environ["AGENT_MAX_STEPS"] = "4"
os.environ.pop("AGENT_GUEST", None)
os.environ.pop("SECRET", None)

import agent_runner  # noqa: E402


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
    return agent_runner.run_agent("тест пересказа"), z


fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  | " + extra))
    if not cond:
        fails.append(name)


# 1: <end> с пересказом — closing из тела тега, corrective не нужен
out, z = run(["думаю <end>Сделал сводку, свёл таблицу и отчитался владельцу</end>"])
check("end с пересказом -> closing из тела",
      "<answer>✅ Сделал сводку, свёл таблицу и отчитался владельцу</answer>" in out, out)
check("corrective не вызван", len(z.calls) == 1, str(len(z.calls)))

# 2: пустой <end> -> один corrective ход за пересказом
out, z = run(["думаю <end></end>", "Пересказ: собрал данные, свёл таблицу и отчитался владельцу"])
check("пустой end -> corrective пересказ",
      "<answer>✅ Пересказ: собрал данные, свёл таблицу и отчитался владельцу</answer>" in out, out)
check("corrective вызван ровно 1 раз", len(z.calls) == 2, str(len(z.calls)))
check("corrective-промпт требует пересказ", "пересказ" in z.calls[-1].lower(), z.calls[-1])

# 3: corrective упал (скрипт пуст) -> честный дефолт
out, z = run(["думаю <end></end>"])
check("fallback дефолт", "<answer>✅ Готово — работа завершена.</answer>" in out, out)

# 3b: <end/> + corrective вернул мусор с тегами -> теги содраны
out, z = run(["думаю <end/>", "<final>игнор</final>конец сделал всё"])
check("мусор с тегами почищен", "<final>" not in out and "конец сделал всё" in out, out)

# 4: <final> + <end> в одном ответе — финал как есть
out, z = run(["<final>итоговый отчёт готов</final><end>заметка</end>"])
check("final+end -> финал как есть", "итоговый отчёт готов" in out, out)

# 5: регресс парсера (T49 формы)
_f, a = agent_runner.parse_actions("раз <end/>два")
check("parse <end/>", ("end", "", 0) in a, str(a))
_f, a = agent_runner.parse_actions("<end></end>")
check("parse <end></end>", ("end", "", 0) in a, str(a))
_f, a = agent_runner.parse_actions("<end>заметка</end>")
check("parse <end>note</end>", bool(a) and a[0][0] == "end" and a[0][1] == "заметка", str(a))

print()
print("ALL PASS" if not fails else "FAILURES: " + "; ".join(fails))
sys.exit(1 if fails else 0)
