#!/usr/bin/env python3 -I
"""Geometry_Olympiad_Achiever_100_Questions.html -> question pack (100 questions, 102 SVG figures).

Source structure (verified by ingest/profile): five <section class="set">, each with 20 <article class="q">.
Every article = qhead (number, title, level) + stmt (question text) + one <figure> (1-2 SVGs, optional caption)
+ answer-sheet boilerplate (ignored: blank lines, working box, checkbox) + <details class="sol"> (the worked solution).

Mapping
  * multi-part questions (stem lists "(a) ... (b) ..."; 69) -> multi_part, parts from the <br>-separated lines;
    each part's answer is cut from the "Final answer:" line by the same (a)/(b)/(c) labels (checked for equality).
  * single-answer questions whose final answer is exactly "<number> <unit>" (21) -> numeric {value, unit}
  * other single-answer questions (10) -> open, final answer kept as Markdown
  * figures: the SVG markup is copied byte-for-byte from the raw HTML (html.parser would lower-case viewBox);
    the only addition is a <style> block carrying the page's `.geo ...` rules for the classes that figure uses,
    because the app shows SVG assets as <img>, where the page's stylesheet does not apply.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from bs4 import Tag  # noqa: E402
from common import FORMAT, ROOT, HtmlToMd, esc, soup, tidy, write_pack  # noqa: E402

SRC = ROOT / "Geometry_Olympiad_Achiever_100_Questions.html"
RAW = SRC.read_text(encoding="utf-8")
DOC = soup(SRC)

# ---- the page's figure CSS
CSS_RULES = {}
for m in re.finditer(r"^\.geo \.([A-Za-z0-9]+)\{([^}]*)\}", RAW, flags=re.M):
    CSS_RULES[m.group(1)] = m.group(2)
GEO_FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif'

RAW_SVGS = re.findall(r"<svg\b.*?</svg>", RAW, flags=re.S)
DOC_SVGS = DOC.find_all("svg")
assert len(RAW_SVGS) == len(DOC_SVGS) == 102, (len(RAW_SVGS), len(DOC_SVGS))
SVG_BY_ID = {id(t): RAW_SVGS[i] for i, t in enumerate(DOC_SVGS)}
for t, r in zip(DOC_SVGS, RAW_SVGS):  # alignment check
    assert t.get("aria-label") and (t["aria-label"] in r.replace("&amp;", "&")), "svg order mismatch"

assets: dict[str, dict] = {}


def styled_svg(raw: str) -> str:
    classes = set(re.findall(r'class="([^"]+)"', raw))
    used = sorted({c for grp in classes for c in grp.split()} - {"geo"})
    missing = [c for c in used if c not in CSS_RULES]
    assert not missing, f"no CSS rule for svg classes {missing}"
    css = f".geo{{font-family:{GEO_FONT}}}" + "".join(f".geo .{c}{{{CSS_RULES[c]}}}" for c in used)
    head_end = raw.index(">") + 1
    return raw[:head_end] + f"<style>{css}</style>" + raw[head_end:]


def add_svg(tag: Tag, name: str) -> str:
    raw = SVG_BY_ID[id(tag)]
    assert name not in assets
    assets[name] = {"type": "image/svg+xml", "data": styled_svg(raw)}
    alt = (tag.get("aria-label") or "").replace("[", "(").replace("]", ")")
    return f"![{alt}](asset:{name})"


def md_converter(prefix: str) -> HtmlToMd:
    counter = {"n": 0}

    def handler(tag):
        counter["n"] += 1
        return add_svg(tag, f"{prefix}-fig{counter['n']}")

    return HtmlToMd(svg_handler=handler)


# ---- level / topic mapping
LEVEL_TO_LABEL = {"Achiever": "Achiever", "Advanced Achiever": "Achiever", "Challenge": "Challenge"}
SETS = {}
for sec in DOC.select("section.set"):
    h = sec.select_one(".sethead h2").get_text(strip=True)  # "Set A — Foundations with a twist"
    m = re.match(r"Set ([A-E]) — (.+)$", h)
    assert m, h
    SETS[sec["id"]] = (m.group(1), m.group(2))
assert len(SETS) == 5

NUMERIC = re.compile(r"^(\d+(?:\.\d+)?)\s*(cm²|m²|cm|m)$")


def final_answer_md(art) -> str:
    p = art.select_one(".solbody p.final")
    strong = p.find("strong")
    assert strong and strong.get_text(strip=True) == "Final answer:", p
    strong.extract()
    conv = md_converter("tmp")
    md = conv.inline_children(p).strip()
    assert not any(k.startswith("tmp") for k in assets), "svg inside final answer"
    return md


def solution_md(art, qn: str) -> str:
    sb = art.select_one(".solbody")
    conv = md_converter(f"q{qn}-sol")
    out = []
    for child in sb.children:
        if not isinstance(child, Tag):
            continue
        cls = set(child.get("class") or [])
        if "final" in cls:
            continue
        if child.name == "h4":
            out.append(f"**{child.get_text(strip=True)}**")
        elif child.name == "p":
            out.append(conv.inline_children(child).strip())
        elif child.name == "ol":
            out.append(conv.list_md(child))
        elif child.name == "ul":
            assert "calc" in cls
            out.append("\n".join("- " + conv.inline_children(li).strip() for li in child.find_all("li", recursive=False)))
        else:
            raise ValueError(f"q{qn}: unexpected solution element <{child.name}>")
    return tidy("\n\n".join(out))


def stem_parts(art, qn: str):
    stmt = art.select_one(".stmt")
    conv = md_converter(f"q{qn}-stem")
    blocks = [c for c in stmt.children if isinstance(c, Tag)]
    last = blocks[-1]
    parts = None
    if last.name == "p" and re.match(r"\s*\(a\)", last.get_text()):
        # split the last paragraph at <br>
        segs, cur = [], []
        for c in last.children:
            if isinstance(c, Tag) and c.name == "br":
                segs.append(cur)
                cur = []
            else:
                cur.append(c)
        segs.append(cur)
        parts = []
        for seg in segs:
            txt = "".join(conv.inline(c) for c in seg).strip()
            m = re.match(r"\(([a-z])\)\s+(.*)$", txt, flags=re.S)
            assert m, f"q{qn}: part line does not start with a label: {txt[:50]!r}"
            parts.append((m.group(1), m.group(2).strip()))
        blocks = blocks[:-1]
    intro = []
    for b in blocks:
        if b.name == "p":
            intro.append(conv.inline_children(b).strip())
        elif b.name == "ul":
            intro.append(conv.list_md(b))
        else:
            raise ValueError(f"q{qn}: unexpected stem element <{b.name}>")
    return "\n\n".join(intro), parts


def split_final(final_md: str, labels: list[str]) -> list[str]:
    pos = []
    for lab in labels:
        tok = f"({lab})"
        assert final_md.count(tok) == 1, f"label {tok} appears {final_md.count(tok)}x in {final_md!r}"
        pos.append(final_md.index(tok))
    assert pos == sorted(pos) and pos[0] == 0, (pos, final_md)
    pos.append(len(final_md))
    return [final_md[pos[i] + 3:pos[i + 1]].strip() for i in range(len(labels))]


questions = []
for art in DOC.select("article.q"):
    qid = art["id"]
    qn = qid[1:]
    sec = art.find_parent("section", class_="set")
    set_letter, set_title = SETS[sec["id"]]
    head = art.select_one(".qhead")
    assert head.select_one(".qnum").get_text(strip=True) == f"Q{qn}"
    title = head.select_one(".qtitle").get_text(strip=True)
    level = head.select_one(".lvl").get_text(strip=True)

    intro, parts = stem_parts(art, qn)
    # figure(s) + caption: part of the shared stem (they appear between the question text and the answer sheet)
    fig = art.select_one("figure.fig")
    conv = md_converter(f"q{qn}")
    fig_md = []
    for svg in fig.find_all("svg"):
        fig_md.append(conv.inline(svg))
    cap = fig.select_one("figcaption")
    cap_md = f"*{esc(cap.get_text(strip=True))}*" if cap else None
    # a caption must be the only other thing in the figure
    assert {c.name for c in fig.children if isinstance(c, Tag)} <= {"svg", "figcaption"}, qid
    stem = intro + "\n\n" + "\n\n".join(fig_md) + (f"\n\n{cap_md}" if cap_md else "")

    final = final_answer_md(art)
    sol_md = solution_md(art, qn)
    q = {"id": qid, "number": qn, "title": title}
    if parts:
        labels = [p[0] for p in parts]
        assert labels == [chr(97 + i) for i in range(len(labels))], (qid, labels)
        answers = split_final(final, labels)
        q["type"] = "multi_part"
        q["stem"] = stem
        q["parts"] = [{"label": lab, "stem": text, "answer": ans} for (lab, text), ans in zip(parts, answers)]
        q["solution"] = {"explanation": sol_md}
    else:
        m = NUMERIC.match(final.replace("\xa0", " "))
        q["stem"] = stem
        if m:
            q["type"] = "numeric"
            val = float(m.group(1))
            q["answer"] = {"value": int(val) if val == int(val) else val, "unit": m.group(2)}
        else:
            q["type"] = "open"
            q["answer"] = final
        q["solution"] = {"answer": final, "explanation": sol_md}
    q["topics"] = [f"Geometry > {set_title}"]
    q["difficulty"] = LEVEL_TO_LABEL[level]
    q["fields"] = {"Set": f"Set {set_letter}", "Source difficulty": level}
    q["source"] = {"id": qid, "set": set_letter}
    questions.append(q)

assert [q["number"] for q in questions] == [str(i) for i in range(1, 101)]
assert not any(k.startswith("tmp") for k in assets)

pack = {
    "format": FORMAT,
    "pack": {
        "id": "geometry-olympiad-achiever-100",
        "title": DOC.select_one("header.cover h1").get_text(strip=True),
        "source": SRC.name,
        "subject": "Maths",
        "topics": ["Geometry"],
        "solutions_origin": "source",
    },
    "assets": assets,
    "questions": questions,
}
path = write_pack(pack, "geometry-olympiad-achiever-100.json")
from collections import Counter  # noqa: E402

print(f"geometry: {len(questions)} questions, {len(assets)} assets -> {path.relative_to(ROOT)}")
print(Counter(q["type"] for q in questions), Counter(q["difficulty"] for q in questions))
