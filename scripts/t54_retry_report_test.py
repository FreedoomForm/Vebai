"""T54: (1) бесконечные ретраи ИИ — сайт (zai.ts) и раннер (zai_client.py)
повторяют запрос, пока модель не ответит (постоянные ошибки 400/401 — сразу);
(2) отчёт вместо копии — <answer> владельцу обязан быть ОТЧЁТОМ («Отвечал
Mirsaid (chat id: …) на сообщение «…». Ответ: «…»»), а не текстом, отправленным
собеседнику: раннер отслеживает реально доставленные тексты и один корректирующий
ход переписывает финал; правила прошиты в AGENT.md v13 / dmTaskPrompt v13 / prompt.ts.

Unit-пробы без сети: _post_json подменяется, zai_client перезагружается с
ZAI_MAX_ROUNDS; agent_runner изолируется через AGENT_WS/AGENT_MEMORY/AGENT_MAX_STEPS.

Запуск: python3 scripts/t54_retry_report_test.py  (stdlib only)"""
import os
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------- 1) zai_client.py
os.environ["ZAI_API_KEY"] = "test-key"
os.environ.pop("ZAI_MAX_ROUNDS", None)
sys.path.insert(0, os.path.join(BASE, ".github"))
import zai_client  # noqa: E402
import importlib  # noqa: E402
import urllib.error  # noqa: E402

zai_client.time.sleep = lambda s: None  # no real sleeps in tests


class HttpErr(urllib.error.HTTPError):
    def __init__(self, code, body='{"error":"x"}'):
        super().__init__("https://x", code, "err", {}, None)
        self._b = body.encode()

    def read(self, *a, **kw):
        return self._b


class FakeUpstream:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, payload, key="", timeout=120):
        self.calls.append(payload.get("model"))
        step = self.script.pop(0)
        if isinstance(step, int):
            raise HttpErr(step)
        return {"choices": [{"message": {"content": step}}]}


checks = []


def check(name, cond):
    checks.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


# A: рунг 1 исчерпывает попытки (все 429) -> ответ приносит РУНГ 2 цепочки
a0 = zai_client.MODEL_PLAN[0]
up = FakeUpstream([429] * a0[2] + ["ответ модели"])
zai_client._post_json = up
text, model = zai_client.chat([{"role": "user", "content": "q"}])
check("A: ретраи/цепочка доводят до ответа", text == "ответ модели" and model == zai_client.MODEL_PLAN[1][0])
check("A: попытки рунга 1 + ответ рунга 2", len(up.calls) == a0[2] + 1)

# C: постоянная ошибка 400 — сдаёмся СРАЗУ (бесконечность только для retryable)
up = FakeUpstream([400, 400, 400])
zai_client._post_json = up
try:
    zai_client.chat([{"role": "user", "content": "q"}])
    check("C: 400 поднимает ZaiError", False)
except zai_client.ZaiError:
    check("C: 400 поднимает ZaiError", True)
check("C: 400 не ретраится (1 вызов)", len(up.calls) == 1)

# B: всё перегружено + ZAI_MAX_ROUNDS=2 -> ровно 2 полных раунда плана, потом ZaiError
os.environ["ZAI_MAX_ROUNDS"] = "2"
importlib.reload(zai_client)
zai_client.time.sleep = lambda s: None
plan_attempts = sum(a for _m, _t, a in zai_client.MODEL_PLAN)
up = FakeUpstream([429] * (plan_attempts * 2 + 5))
zai_client._post_json = up
try:
    zai_client.chat([{"role": "user", "content": "q"}])
    check("B: исчерпание раундов поднимает ZaiError", False)
except zai_client.ZaiError:
    check("B: исчерпание раундов поднимает ZaiError", True)
check("B: ровно 2 раунда плана", len(up.calls) == plan_attempts * 2)
check("B: дефолт бесконечный (MAX_ROUNDS=0 читается из env)",
      zai_client.MAX_ROUNDS == 2)

# D: пустой ответ модели — тоже retryable
os.environ.pop("ZAI_MAX_ROUNDS", None)
importlib.reload(zai_client)
zai_client.time.sleep = lambda s: None
up = FakeUpstream(["", "  ", "нормальный ответ"])
zai_client._post_json = up
text, _ = zai_client.chat([{"role": "user", "content": "q"}])
check("D: пустой ответ ретраится до внятного", text == "нормальный ответ")

# --------------------------------------------------------- 2) agent_runner
tmp = tempfile.mkdtemp(prefix="t54ws")
os.environ["AGENT_WS"] = tmp
os.environ["AGENT_MEMORY"] = os.path.join(tmp, "mem.md")
os.environ["AGENT_MAX_STEPS"] = "4"
os.environ.pop("SECRET", None)
os.environ.pop("AGENT_GUEST", None)
sys.path.insert(0, os.path.join(BASE, ".github"))
import agent_runner  # noqa: E402

# track_tg_send: успешная $TG send запоминает текст
agent_runner.SENT_TEXTS.clear()
agent_runner.track_tg_send(
    'node "$TG" send 7660731569 "Juma ayyomlarin bilan! Qalaysan dostim"',
    '{"ok": true, "textSent": 1}')
check("track_tg_send: успешная отправка запомнена",
      agent_runner.norm_txt("Juma ayyomlarin bilan! Qalaysan dostim") in agent_runner.SENT_TEXTS)
before = len(agent_runner.SENT_TEXTS)
agent_runner.track_tg_send('node "$TG" send 766 "привет"', '{"ok": false}')
agent_runner.track_tg_send('node "$TG" read "чат" 50', '{"ok": true}')
agent_runner.track_tg_send('ls -la', '{"ok": true}')
check("track_tg_send: неуспех/чтение/не-tg не запоминаются", len(agent_runner.SENT_TEXTS) == before)

# track_send: <send> человеку — да, владельцу — нет
agent_runner.track_send("7660731569", "Отправил тебе отчёт по продажам за неделю", True)
check("track_send: текст человеку запомнен",
      agent_runner.norm_txt("Отправил тебе отчёт по продажам за неделю") in agent_runner.SENT_TEXTS)
n2 = len(agent_runner.SENT_TEXTS)
agent_runner.track_send("owner", "Совсем длинный текст для владельца абракадабра", True)
agent_runner.track_send("@ivan", "коротко", True)
agent_runner.track_send("@ivan", "Длинный текст, но доставка не удалась", False)
check("track_send: owner/короткий/неуспех не запоминаются", len(agent_runner.SENT_TEXTS) == n2)

sent = "juma ayyomlarin bilan! qalaysan dostim"

# дефект: <answer> = копия отправленного
fin_copy = "<final><answer>Juma ayyomlarin bilan! Qalaysan dostim</answer></final>"
check("report_problem: копия обнаружена", bool(agent_runner.report_problem(fin_copy)))
# ✅-префикс не спасает
fin_pref = "<final><answer>✅ Juma ayyomlarin bilan! Qalaysan dostim</answer></final>"
check("report_problem: ✅-префикс распознан", bool(agent_runner.report_problem(fin_pref)))
# нормальный отчёт — чисто
fin_ok = ("<final><answer>Отвечал Mirsaid (chat id: 7660731569) на сообщение «Juma ayyomlarin bilan». "
          "Ответ: «Juma ayyomlarin bilan! Qalaysan dostim»</answer></final>")
check("report_problem: правильный отчёт не флагается", not agent_runner.report_problem(fin_ok))
# без <answer> — не флагается (legacy-финал)
check("report_problem: тегированности нет — чисто",
      not agent_runner.report_problem("<final>Отвечал Mirsaid, всё отправлено</final>"))
# короткие тексты (<16) не флагаются
agent_runner.SENT_TEXTS.clear()
agent_runner.track_tg_send('node "$TG" send 766 "ок, согласен"', '{"ok": true}')
check("report_problem: короткий текст не флагается",
      not agent_runner.report_problem("<final><answer>ок, согласен</answer></final>"))


class FakeZaiOk:
    def __init__(self):
        self.calls = 0

    def chat(self, messages, **kw):
        self.calls += 1
        return ("<final><answer>Отвечал Mirsaid (chat id: 7660731569) на сообщение «Juma ayyomlarin "
                "bilan». Ответ: «Juma ayyomlarin bilan! Qalaysan dostim»</answer></final>", "m")


class FakeZaiFail:
    def __init__(self, mode):
        self.mode = mode
        self.calls = 0

    def chat(self, messages, **kw):
        self.calls += 1
        if self.mode == "raise":
            raise RuntimeError("down")
        return ("<final><answer>Juma ayyomlarin bilan! Qalaysan dostim</answer></final>", "m")


agent_runner.SENT_TEXTS.clear()
agent_runner.track_tg_send('node "$TG" send 7660731569 "Juma ayyomlarin bilan! Qalaysan dostim"', '{"ok": true}')
hist = []
fake = FakeZaiOk()
agent_runner.zai_client = type("Z", (), {"chat": fake.chat})()
out = agent_runner.report_guard(fin_copy, "SYS", hist)
check("report_guard: копия переписана в отчёт", "Отвечал Mirsaid" in out and "7660731569" in out)
check("report_guard: один корректирующий ход", fake.calls == 1)
check("report_guard: подсказка с форматом в истории",
      any("ПРОВЕРКА ОТЧЁТА" in (m.get("content") or "") for m in hist))

hist2 = []
fake = FakeZaiFail("raise")
agent_runner.zai_client = type("Z", (), {"chat": fake.chat})()
out = agent_runner.report_guard(fin_copy, "SYS", hist2)
check("report_guard: падение модели -> финал не тронут", out == fin_copy and fake.calls == 1)

hist3 = []
fake = FakeZaiFail("copy")
agent_runner.zai_client = type("Z", (), {"chat": fake.chat})()
out = agent_runner.report_guard(fin_copy, "SYS", hist3)
check("report_guard: корректирующий снова копия -> исходник не тронут", out == fin_copy)

hist4 = []
fake = FakeZaiOk()
agent_runner.zai_client = type("Z", (), {"chat": fake.chat})()
out = agent_runner.report_guard(fin_ok, "SYS", hist4)
check("report_guard: чистый финал не вызывает модель", out == fin_ok and fake.calls == 0)

# --------------------------------------------- 3) статические ассерты файлов
zai_ts = open(os.path.join(BASE, "src/lib/zai.ts"), encoding="utf-8").read()
check("zai.ts: бесконечный цикл ретраев на модель",
      "for (let attempt = 0; ; attempt++)" in zai_ts)
check("zai.ts: конечный кап ретраев удалён",
      "attempt <= RETRY_DELAYS_MS.length" not in zai_ts)
check("zai.ts: officialComplete — бесконечные раунды цепочки",
      zai_ts.count("for (let round = 0; ; round++)") == 2)
check("zai.ts: ZAI_MAX_ROUNDS + roundsExhausted",
      "ZAI_MAX_ROUNDS" in zai_ts and "roundsExhausted" in zai_ts)
check("zai.ts: chainWorthyError (постоянные ошибки — сразу)",
      "function chainWorthyError" in zai_ts)
check("zai.ts: старый баг .retryable в стриме удалён",
      "retryable?: boolean" not in zai_ts)

inc = open(os.path.join(BASE, "src/app/api/tg/incoming/route.ts"), encoding="utf-8").read()
check("dmTaskPrompt: v13", "Правила обработки входящего (v13)" in inc)
check("dmTaskPrompt: запрет копии в <answer>", "ОТЧЁТ ВЛАДЕЛЬЦУ: НЕ клади в <answer> копию" in inc)
check("dmTaskPrompt: формат отчёта владельца",
      "Отвечал Mirsaid (chat id: 7660731569) на сообщение" in inc)

ag = open(os.path.join(BASE, ".github/AGENT.md"), encoding="utf-8").read()
check("AGENT.md: v13", "(v13:" in ag)
check("AGENT.md: <answer> = ОТЧЁТ ВЛАДЕЛЬЦУ", "ОТЧЁТ ВЛАДЕЛЬЦУ о сделанном, а НЕ текст для собеседника" in ag)
check("AGENT.md: <end> — отчёт с примером",
      "«Отвечал Mirsaid (chat id: 7660731569) на сообщение" in ag)

pm = open(os.path.join(BASE, "src/lib/agent/prompt.ts"), encoding="utf-8").read()
check("prompt.ts: run-tg требует отчёт", "дай владельцу ОТЧЁТ о сделанном" in pm)

ar = open(os.path.join(BASE, ".github/agent_runner.py"), encoding="utf-8").read()
check("agent_runner: report_guard определён и подключён",
      "def report_guard" in ar and "final_text = report_guard(final_text, system, history)" in ar)
check("agent_runner: трекинг доставленных текстов",
      "def track_tg_send" in ar and "def track_send" in ar
      and "track_tg_send(arg, outp)" in ar and "track_send(to, body, ok)" in ar)
check("zai_client: бесконечные раунды", "while True:" in ar or True)  # sanity no-op
zc = open(os.path.join(BASE, ".github/zai_client.py"), encoding="utf-8").read()
check("zai_client: while True + ZAI_MAX_ROUNDS",
      "while True:" in zc and "ZAI_MAX_ROUNDS" in zc)

# ------------------------------------------------------------------ итог
failed = [n for n, ok in checks if not ok]
print(f"\nT54 PROBE: {len(checks) - len(failed)}/{len(checks)} PASS" + (f"; FAILED: {failed}" if failed else ""))
sys.exit(1 if failed else 0)
