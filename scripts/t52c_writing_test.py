#!/usr/bin/env python3
"""T52c probe: human-writing quality + clean delivery + model chain
(no network, no model calls — file/module asserts only).

Owner field report 2026-10-23: «Что это за писание 3 летнего малыша?:
GLM-4.5-Flash» — the run (1) fell back to the WEAKEST free model,
(2) posted RAW protocol output (<answer> tags, to:/message: lines) to the
chat, (3) wrote a robotic toddler-grade Telegram message.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".github"))
import zai_client  # noqa: E402

fails = []
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(detail)[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


# --- 1. model chain: 4.7 -> 4.6 -> 4.5 (strongest first), site mirrors runner
names = [m for m, _t, _a in zai_client.MODEL_PLAN]
check("runner chain: primary is glm-4.7-flash", names[0] == "glm-4.7-flash", names)
check("runner chain: glm-4.6-flash is the middle rung", "glm-4.6-flash" in names and names.index("glm-4.6-flash") == 1, names)
check("runner chain: glm-4.5-flash only last", names[-1] == "glm-4.5-flash" and names.count("glm-4.5-flash") == 1, names)

zc = read("src/lib/zai-config.ts")
check("site: MIDDLE_CHAT_MODEL = glm-4.6-flash", "MIDDLE_CHAT_MODEL = 'glm-4.6-flash'" in zc)
zt = read("src/lib/zai.ts")
m = re.search(r"function chatModels\(primaryOverride\?: string\): string\[\] \{([\s\S]*?)\n\}", zt)
check("site: chatModels pushes middle before fallback",
      bool(m) and m.group(1).find("MIDDLE_CHAT_MODEL") < m.group(1).rfind("FALLBACK_CHAT_MODEL"))
st = read("src/app/api/chat/stream/route.ts")
check("site: stream whitelist accepts the middle model", "requested === MIDDLE_CHAT_MODEL" in st)

# --- 2. clean delivery: fenced service blocks never reach the chat
at = read("src/lib/agent/answer.ts")
check("answer.ts: RE_FENCED strips run-*/video-request blocks",
      "run-agent|run-terminal|run-vterm|run-tg-read|run-tg|video-request" in at and "RE_FENCED" in at)
ct = read("src/lib/agent/continue.ts")
check("continueAfterRead: parses before posting (no raw <answer> leak)",
      "const parsed = parseAiAnswer(raw)" in ct and "content: parsed.text" in ct)

# --- 3. human-writing rules present on every surface
pm = read("src/lib/agent/prompt.ts")
check("prompt.ts: human-writing rule", "КАК ПИСАТЬ СООБЩЕНИЯ ЛЮДЯМ" in pm and "ВСЕГДА РУССКИЙ" in pm)
ag = read(".github/AGENT.md")
check("AGENT.md v11: «Как писать ЛЮДЯМ» section", "Как писать ЛЮДЯМ" in ag and "Я помогу вам" in ag)
check("AGENT.md: live field case quoted as the anti-example",
      "Йакшимисан" in ag and "перечитай" in ag.lower())
inc = read("src/app/api/tg/incoming/route.ts")
check("dmTaskPrompt: handwriting rule for $TG replies",
      "Правила обработки входящего (v1" in inc and "ПОЧЕРК" in inc)

# --- 4. zai_client.chat dedupe keeps order (ZAI_MODEL may equal a fallback)
zai_client.API_KEY = "k"  # skip the key guard for the plan check below
seen, order = set(), []
orig_post = zai_client._post_json
plan_seen = []


def fake_post(url, payload, key="", timeout=120):
    plan_seen.append(payload.get("model"))
    raise zai_client.ZaiError("stop")  # fail fast: we only want the attempt order


zai_client._post_json = fake_post
try:
    zai_client.chat([{"role": "user", "content": "x"}])
except zai_client.ZaiError:
    pass
zai_client._post_json = orig_post
# attempts repeat the same model (2 per rung) — compare the UNIQUE order
uniq = [m for i, m in enumerate(plan_seen) if i == 0 or plan_seen[i - 1] != m]
check("chat() walks the plan strongest-first", uniq == ["glm-4.7-flash", "glm-4.6-flash", "glm-4.5-flash"], plan_seen)

print()
print("T52C PROBE:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")
sys.exit(1 if fails else 0)
