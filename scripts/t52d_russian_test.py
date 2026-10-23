#!/usr/bin/env python3
"""T52d probe: the agent writes ONLY in Russian (no network, file asserts only).

Owner order 2026-10-23: «в системном промпте обязательно укажи что он должен
писать только на русском». Supersedes the T52c rule «пиши на языке
собеседника» — every surface must now pin the language to Russian, even when
the correspondent writes in Uzbek. The broken-Uzbek anti-example stays.
"""
import os
import sys

fails = []
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(detail)[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


ag = read(".github/AGENT.md")
pm = read("src/lib/agent/prompt.ts")
inc = read("src/app/api/tg/incoming/route.ts")

# --- 1. runner AGENT.md v12: hard Russian-only rule on every writing surface
check("AGENT.md bumped to v12", "мозг Vebai Agent (v12" in ag)
check("AGENT.md: hard rule «ЯЗЫК — ТОЛЬКО РУССКИЙ»",
      "ЯЗЫК — ТОЛЬКО РУССКИЙ" in ag and "всегда НА РУССКОМ" in ag)
check("AGENT.md: rule covers answers + end recaps + memory + messages to people",
      "`<end>`-пересказы, записи `<memory>`" in ag and "`$TG send`/`<send>`" in ag)
check("AGENT.md: even if the correspondent writes Uzbek — answer in Russian",
      "по-узбекски или на любом другом языке — отвечай по-русски" in ag)
check("AGENT.md: DM rule 1 pins Russian for $TG replies",
      "И ВСЕГДА ПО-РУССКИ, даже если собеседник" in ag)
check("AGENT.md: honest reason (toddler-grade Uzbek) kept",
      "уровня «трёхлетки»" in ag)
check("AGENT.md: style-from-owner kept but language excluded",
      "(краткость,\n   обращения, смайлы, тон)" in ag and "но на русском языке" in ag)
check("AGENT.md: live anti-example still quoted", "Йакшимисан" in ag)

# --- 2. site system prompt: base rule + run-tg handwriting rule
check("prompt.ts: base rule «пиши ТОЛЬКО по-русски»",
      "пиши ТОЛЬКО по-русски" in pm and "даже если он пишет на другом языке" in pm)
check("prompt.ts: run-tg messages always Russian",
      "ЯЗЫК СООБЩЕНИЙ — ВСЕГДА РУССКИЙ" in pm)
check("prompt.ts: handwriting keeps owner style but not language",
      "но по-русски" in pm)
check("prompt.ts: broken-Uzbek anti-example kept", "Йакшимисан? Хаммаси яхшимисан?" in pm)

# --- 3. bot DM task prompt (tg/incoming): v12 + Russian rule
check("incoming: rules bumped to v12", "Правила обработки входящего (v12)" in inc)
check("incoming: ПОЧЕРК pins Russian",
      "ЯЗЫК ОТВЕТА — ВСЕГДА РУССКИЙ" in inc and "даже если собеседник пишет по-узбекски" in inc)
check("incoming: examples no longer copy their language",
      "язык примеров НЕ копируй — твой ответ всегда по-русски" in inc)

# --- 4. the superseded T52c rule must be GONE from every surface
for name, txt in (("AGENT.md", ag), ("prompt.ts", pm), ("incoming", inc)):
    check(f"{name}: old rule «на языке собеседника» removed", "языке собеседника" not in txt)
check("prompt.ts: old «на языке пользователя» base rule removed", "на языке пользователя" not in pm)

print()
print("T52D PROBE:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")
sys.exit(1 if fails else 0)
