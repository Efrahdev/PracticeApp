#!/usr/bin/env python3 -I
"""UNITARY METHOD.html ("The Bridge of One") -> question pack (140 questions in 8 levels).

Source structure (verified by ingest/profile): 140 <article class="q" data-id="L.N">, each with
  .q-head (level, title, difficulty 1-4) .problem (text, optional lettered <ol class="parts"> ) .nudge (a hint)
  .answer > .solution (sol-answer = Final answer, then understand / structure / reasoning / intuition /
  check / alternative / extension / lesson sections and a "Thinking skills" line).
The page's own JSON (#app-data) lists id / level / title / diff and is cross-checked against the DOM.

Mapping
  * problem with a lettered parts list -> multi_part (stem = text before the list; parts carry their own stems);
    the FULL final answer stays at question level (the source packs several parts' answers into one list item,
    e.g. "<li>30 km. (b) 12.5 cm. (c) ...</li>", so splitting per part would be guesswork)
  * everything else -> open, final answer kept as Markdown
  * fractions / mixed numbers (<span class="fr">) -> LaTeX \\frac; screen-reader-only text is dropped
  * "working" lines (calculation | meaning) -> a block quote, one line each: `calculation — *meaning*`
  * the nudge is imported as the question's hint; "Thinking skills in this problem: ..." -> field "Cognitive skill"
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from bs4 import NavigableString, Tag  # noqa: E402
from common import FORMAT, ROOT, HtmlToMd, soup, tidy, write_pack  # noqa: E402

SRC = ROOT / "UNITARY METHOD.html"
DOC = soup(SRC)
DATA = json.loads(DOC.find("script", id="app-data").string)
LEVELS = {l["n"]: l for l in DATA["levels"]}

DIFF_LABEL = {1: "Foundation", 2: "Foundation", 3: "Challenge", 4: "Achiever"}  # printed: Foundation/Core/Challenge/Olympiad


# ---------------------------------------------------------------- inline handlers
def _frac(n_node, d_node):
    n, d = n_node.get_text(strip=True), d_node.get_text(strip=True)
    ok = r"[0-9]+(\.[0-9]+)?|[a-z]"  # numbers, decimals, or a single algebra letter (1/a, 1/b)
    assert re.fullmatch(ok, n) and re.fullmatch(ok, d), (n, d)
    return f"\\frac{{{n}}}{{{d}}}"


def h_fr(node, conv):
    return f"${_frac(node.select_one('.fr-n'), node.select_one('.fr-d'))}$"


def h_mixed(node, conv):
    whole = "".join(str(c) for c in node.children if isinstance(c, NavigableString)).strip()
    assert re.fullmatch(r"[0-9]+", whole), whole
    fr = node.select_one(".fr")
    return f"${whole}{_frac(fr.select_one('.fr-n'), fr.select_one('.fr-d'))}$"


def h_working(node, conv):
    lines = []
    for wl in node.find_all("p", class_="wl", recursive=False):
        m = conv.inline_children(wl.select_one(".wl-m")).strip()
        n = wl.select_one(".wl-n")
        note = conv.inline_children(n).strip() if n else ""
        lines.append(f"{m} — *{note}*" if note else m)
    assert lines and len(lines) == len(list(node.find_all("p", recursive=False))), "unexpected content inside .working"
    return "> " + "\\\n> ".join(lines)  # backslash = hard line break inside the block quote


def h_tablewrap(node, conv):
    return "\n\n".join(conv.block(c) and conv.block(c)[0] for c in node.children if isinstance(c, Tag))


def converter():
    return HtmlToMd(class_handlers={"fr": h_fr, "mixed": h_mixed, "working": h_working, "table-wrap": h_tablewrap})


# ---------------------------------------------------------------- per question
def blocks_md(conv, parent, skip=()):
    out = []
    for c in parent.children:
        if isinstance(c, NavigableString):
            assert not str(c).strip(), f"stray text {str(c)!r}"
            continue
        if c.name in skip:
            continue
        out.extend(conv.block(c))
    return tidy("\n\n".join(x for x in out if x))


questions = []
arts = DOC.select("article.q")
assert len(arts) == len(DATA["questions"]) == 140
for art, meta in zip(arts, DATA["questions"]):
    qid = art["data-id"]
    assert qid == meta["id"], (qid, meta["id"])
    level = int(art["data-level"])
    assert level == meta["level"]
    title = art.select_one(".q-title").get_text(strip=True)
    assert title == meta["title"]
    dtxt = art.select_one("p.diff").get_text(" ", strip=True)
    m = re.match(r"Difficulty (\d) of 4: (\w+)$", dtxt)
    assert m and int(m.group(1)) == meta["diff"], (qid, dtxt)
    diff_n, diff_name = int(m.group(1)), m.group(2)

    conv = converter()
    prob = art.select_one(".problem")
    kids = [c for c in prob.children if isinstance(c, Tag)]
    parts_ol = [k for k in kids if k.name == "ol" and "parts" in (k.get("class") or [])]
    assert len(parts_ol) <= 1 and (not parts_ol or kids[-1] is parts_ol[0]), f"{qid}: parts list not last"
    stem_md = blocks_md(conv, prob, skip=("ol",)) if not parts_ol else tidy("\n\n".join(x for k in kids[:-1] for x in conv.block(k)))
    q = {"id": f"q{qid}", "number": qid, "title": title}
    if parts_ol:
        lis = parts_ol[0].find_all("li", recursive=False)
        q["type"] = "multi_part"
        if stem_md:
            q["stem"] = stem_md
        q["parts"] = [{"label": chr(97 + i), "stem": conv.inline_children(li).strip()} for i, li in enumerate(lis)]
    else:
        assert stem_md, qid
        q["type"] = "open"
        q["stem"] = stem_md

    # nudge -> hint
    nudge = art.select_one(".nudge-own")
    hint = blocks_md(conv, nudge)
    assert hint
    q["hints"] = [hint]

    # solution
    sol = art.select_one("details.answer .solution")
    sections = [c for c in sol.children if isinstance(c, Tag)]
    final_sec = [s for s in sections if "sol-answer" in (s.get("class") or [])]
    assert len(final_sec) == 1 and final_sec[0] is sections[0], qid
    final_md = blocks_md(conv, final_sec[0], skip=("h3",))
    body, skills = [], None
    for s in sections[1:]:
        if s.name == "p" and "trained" in (s.get("class") or []):
            tm = re.match(r"Thinking skills in this problem: (.+)\.$", s.get_text(" ", strip=True))
            assert tm, f"{qid}: {s.get_text()!r}"
            skills = tm.group(1)
            continue
        assert s.name == "section" and "sol-sec" in (s.get("class") or []), (qid, s.name, s.get("class"))
        title_h = s.find("h3", recursive=False).get_text(strip=True)
        body.append(f"**{title_h}**\n\n" + blocks_md(conv, s, skip=("h3",)))
    assert skills, qid
    q["solution"] = {"answer": final_md, "explanation": tidy("\n\n".join(body))}
    if q["type"] == "open":
        q["answer"] = final_md

    q["topics"] = [f"Unitary Method > {LEVELS[level]['short']}"]
    q["difficulty"] = DIFF_LABEL[diff_n]
    q["fields"] = {"Level": level, "Section": LEVELS[level]["name"], "Difficulty rating": diff_n, "Source difficulty": diff_name, "Cognitive skill": skills}
    q["source"] = {"id": qid, "level": level}
    questions.append(q)

assert Counter(int(q["source"]["level"]) for q in questions) == Counter({l["n"]: l["count"] for l in DATA["levels"]})

pack = {
    "format": FORMAT,
    "pack": {
        "id": "unitary-method-olympiad-course",
        "title": DOC.title.get_text(strip=True),
        "source": SRC.name,
        "subject": "Maths",
        "topics": ["Unitary Method"],
        "solutions_origin": "source",
    },
    "questions": questions,
}
path = write_pack(pack, "unitary-method-olympiad-course.json")
print(f"unitary: {len(questions)} questions -> {path.relative_to(ROOT)}", Counter(q["type"] for q in questions), Counter(q["difficulty"] for q in questions))
