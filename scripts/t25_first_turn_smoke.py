#!/usr/bin/env python3
"""T25 smoke: does the FIRST turn of the new AGENT.md go for sources?
Builds the same header run_agent() builds, asks 'Создай пдф про Марс',
prints the raw first reply. Expect <read>/<search> of an authoritative page."""
import os, sys, time
sys.path.insert(0, "/home/z/my-project/vebai/.github")
import zai_client

with open("/home/z/my-project/vebai/.github/AGENT.md", encoding="utf-8") as f:
    system = f.read()

SKILLS_DIR = "/home/z/my-project/vebai/.github/skills"
skills = ", ".join(sorted(os.listdir(SKILLS_DIR)))
task = "Создай пдф про Марс"
header = (
    f"# Задача от владельца (поступила {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())})\n\n{task}\n\n"
    "# Окружение прямо сейчас\n"
    f"- cwd: /tmp/t25_ws (все файлы-результаты сюда)\n"
    f"- utcnow: {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())}\n"
    f"- скиллы (плейбуки): {SKILLS_DIR} — там есть: {skills}\n"
    "  перед задачей типа pdf/charts/docx/xlsx/pptx/media/web прочитай нужный плейбук\n"
    f"- память смены (итоги прошлых задач):\n(память пуста — это первая задача в смене)\n"
)

reply, model = zai_client.chat(
    [{"role": "system", "content": system}, {"role": "user", "content": header}],
    temperature=0.3, max_tokens=4000)
print("MODEL:", model)
print("----- first reply -----")
print(reply[:2200])
low = reply.lower()
verdict = []
if "<read>" in low: verdict.append("READ ✓")
if "<search>" in low: verdict.append("SEARCH ✓")
if "wikipedia" in low or "википед" in low: verdict.append("WIKI-MENTION ✓")
if "<cmd>" in low: verdict.append("CMD ✓")
print("----- verdict:", ", ".join(verdict) or "NO SOURCE GATHERING ✗", "-----")
