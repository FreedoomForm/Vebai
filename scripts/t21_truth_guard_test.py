# T21a: unit-check of the truth guard pieces (no network, no model).
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".github"))

import agent_runner  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (" | " + extra if extra else ""))
    if not cond:
        fails.append(name)


# fake workspace: one real file
tmp = tempfile.mkdtemp()
with open(os.path.join(tmp, "real.pdf"), "wb") as f:
    f.write(b"%PDF-1.4 ok")

agent_runner.WS = tmp
real = agent_runner.ws_files_basenames()
check("ws scan", real == {"real.pdf"}, str(real))

# 1) phantom file promised via <file> tag -> missing
final1 = "<final><answer>Готово, отчёт создан и отправлен</answer>\n<file>phantom.pdf</file></final>"
a, missing, claimed = agent_runner.analyze_final(final1, real, 0)
check("tag missing detected", missing == ["phantom.pdf"], str(missing))
check("send claim detected", claimed is True)

# 2) real file via tag -> clean
final2 = "<final><answer>Готово, отчёт создан и отправлен</answer>\n<file>real.pdf</file></final>"
_, missing2, claimed2 = agent_runner.analyze_final(final2, real, 0)
check("real file ok", missing2 == [] and claimed2 is False, f"{missing2}|{claimed2}")

# 3) successful send delivery silences the claim check (file already sent)
_, missing3, claimed3 = agent_runner.analyze_final(final1, set(), 2)
check("send_files_ok silences claim", claimed3 is False and missing3 == ["phantom.pdf"])

# 4) legacy untagged final mentions a file -> missing from answer scan
final4 = "Я создал итоговый отчёт otchet_2026.pdf и отправил его вам."
_, missing4, claimed4 = agent_runner.analyze_final(final4, real, 0)
check("legacy mention detected", missing4 == ["otchet_2026.pdf"], str(missing4))
check("legacy claim detected", claimed4 is True)

# 5) honest note goes INSIDE </answer>
fixed = agent_runner.append_honest_note(final1, ["phantom.pdf"], True)
check("note inside answer", "⚠️" in fixed and fixed.index("⚠️") < fixed.index("</answer>"), fixed[-220:])
check("original text kept", "Готово, отчёт создан и отправлен" in fixed)

# 6) plain answer without files/claims -> untouched
final6 = "<final><answer>Просто текстовый ответ без файлов</answer></final>"
a6, m6, c6 = agent_runner.analyze_final(final6, real, 0)
check("clean final untouched", m6 == [] and c6 is False)
check("guard passes clean", agent_runner.truth_guard(final6, "s", [], 0) == final6)

# 7) do_send early exits still return tuples
rep, ok, n = agent_runner.do_send("owner", os.path.join(tmp, "nope.pdf"), "")
check("do_send missing file", ok is False and n == 0 and "не найден" in rep, rep)

print("\nRESULT:", "ALL PASS" if not fails else f"FAILURES: {fails}")
sys.exit(1 if fails else 0)
