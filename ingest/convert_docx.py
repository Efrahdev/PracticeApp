#!/usr/bin/env python3 -I
"""Convert the four Word worksheets into question packs.

All four are plain numbered paragraphs: no tables, images, equations, comments or tracked changes
(verified in ingest/profile). None has an answer key, so no `answer` / `solution` is written.
Text is copied exactly from the paragraph runs (including its non-breaking spaces and its typos).
"""
import re
import sys
from pathlib import Path

import docx

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from common import FORMAT, ROOT, esc, write_pack  # noqa: E402

NUM = re.compile(r"^(\d+)\s*[.)]\s+")

SHEETS = [
    dict(
        file="Class_5_Calendar_Sums.docx",
        out="class5-calendar-sums.json",
        pack=dict(id="class5-calendar-sums", title="Class 5 Calendar Sums", source="Class_5_Calendar_Sums.docx", subject="Maths",
                  topics=["Everyday Mathematics > Calendar and Dates"], fields={"Class": 5}),
        title_style="Heading 1", expect=20, note=None,
    ),
    dict(
        file="Class_5_Critical_Thinking_Calendar_Sums.docx",
        out="class5-critical-thinking-calendar-sums.json",
        pack=dict(id="class5-critical-thinking-calendar-sums", title="Class 5 – Critical‑Thinking Calendar Sums",
                  source="Class_5_Critical_Thinking_Calendar_Sums.docx", subject="Maths",
                  topics=["Critical Thinking > Calendar and Dates"], fields={"Class": 5}),
        title_style="Heading 1", expect=20,
        # the one-line instruction printed under the title; kept as a per-question note, not in the stem
        note_from_normal_before_first=True,
    ),
    dict(
        file="Equally_Spaced_Objects_Word_Problems.docx",
        out="equally-spaced-objects-word-problems.json",
        pack=dict(id="equally-spaced-objects-word-problems", title="Distance Between Equally Spaced Objects - Word Problems",
                  source="Equally_Spaced_Objects_Word_Problems.docx", subject="Maths",
                  topics=["Mathematical Reasoning > Equally Spaced Objects"]),
        title_style="Title", expect=20,
    ),
    dict(
        file="advanced_critical_thinking_math_worksheet.docx",
        out="advanced-critical-thinking-math-worksheet.json",
        pack=dict(id="advanced-critical-thinking-math-worksheet", title="Advanced Critical Thinking Math Worksheet",
                  source="advanced_critical_thinking_math_worksheet.docx", subject="Maths",
                  topics=["Critical Thinking > Multi-step Word Problems"]),
        title_style="Heading 1", expect=20,
    ),
]


def convert(sheet: dict) -> dict:
    d = docx.Document(str(ROOT / sheet["file"]))
    assert not d.tables, "unexpected table"
    paras = [p for p in d.paragraphs if p.text.strip()]
    title = paras[0]
    assert title.style.name == sheet["title_style"], (sheet["file"], title.style.name)
    body = paras[1:]
    note = None
    if sheet.get("note_from_normal_before_first"):
        first = body[0]
        assert first.style.name == "Normal" and not NUM.match(first.text), first.text
        note = "Worksheet instruction: " + first.text.strip()
        body = body[1:]
    questions, seen = [], set()
    for p in body:
        raw = p.text
        m = NUM.match(raw)
        assert m, f"{sheet['file']}: paragraph without a printed number: {raw[:60]!r}"
        n = m.group(1)
        assert n not in seen, f"duplicate number {n}"
        seen.add(n)
        stem = raw[m.end():]
        q = dict(id=f"q{n}", number=n, type="open", stem=esc(stem))
        if note:
            q["notes"] = esc(note).replace("\\ ", " ")
        q["source"] = {"paragraph": len(questions) + 1}
        questions.append(q)
    assert len(questions) == sheet["expect"], (sheet["file"], len(questions))
    assert [q["number"] for q in questions] == [str(i) for i in range(1, sheet["expect"] + 1)], "numbering is not 1..N in order"
    return {"format": FORMAT, "pack": sheet["pack"], "questions": questions}


if __name__ == "__main__":
    for s in SHEETS:
        pack = convert(s)
        path = write_pack(pack, s["out"])
        print(f"{s['file']}: {len(pack['questions'])} questions -> {path.relative_to(ROOT)}")
