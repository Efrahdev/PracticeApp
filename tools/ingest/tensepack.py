#!/usr/bin/env python3
"""Deterministic PDF (Verb Tenses Diagnostic Assessment) -> Practice App question pack. No AI.

  python3 -I tools/ingest/tensepack.py <paper.pdf> <outdir>

writes <outdir>/<pack-id>/pack.json and <outdir>/<pack-id>.zip (pack.json at the zip root).
Text, positions and font flags come from PyMuPDF. The PDF is treated as untrusted data.
"""
from __future__ import annotations

import json
import os
import re
import sys
import zipfile

import pymupdf

PACK_ID = "verb-tenses-diagnostic-assessment"
SUBJECT = "English"
TOPIC_ROOT = "Grammar > Verb Tenses"
RIGHT = 541.2          # right text margin (pt); wrapped lines end within a word of it
WRAP_SLACK = 8.0       # a line is a hard-wrap of the next if the next word would not have fitted

TYPE_MAP = {
    "Multiple choice": "mcq_single",
    "Choose ALL correct answers": "mcq_multi",
    "Fill in the blank": "short_answer",
}

RE_Q_PAPER = re.compile(r"^Q(\d+)\.\s*\[(.*?)\]\s*")
RE_Q_KEY = re.compile(r"^Q(\d+)\.\s*\(")
RE_OPT = re.compile(r"^\(([A-F])\)\s*")
RE_FIELD = re.compile(r"^(Correct answer|Why|Distractor analysis|Principle|Intuition hook):\s*")
RE_DIFF = re.compile(r"^Difficulty:\s*(\d+)\s*/\s*10\s*\|\s*Cognitive skill:\s*(.*)$")
RE_SECTION = re.compile(r"^Section\s+([0-9A-Z]+)\s+—\s+(.*)$")
RE_BULLET = re.compile(r"^\s*•\s*")


# --------------------------------------------------------------------------- lines
class Line:
    def __init__(self, page, bbox, chars, size, bold, italic):
        self.page, self.x0, self.y0, self.x1 = page, bbox[0], bbox[1], bbox[2]
        self.chars = chars        # [(ch, bold, italic)]
        self.size, self.bold, self.italic = size, bold, italic

    @property
    def text(self):
        return "".join(c[0] for c in self.chars)


def is_bold(sp):
    return bool(sp["flags"] & 16) or "bold" in sp["font"].lower()


def is_italic(sp):
    f = sp["font"].lower()
    return bool(sp["flags"] & 2) or "oblique" in f or "italic" in f


def extract(doc):
    lines = []
    for pn, page in enumerate(doc, 1):
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                chars, size, bold, ital = [], 0, False, False
                for sp in l["spans"]:
                    bb, ii = is_bold(sp), is_italic(sp)
                    if sp["text"].strip():
                        size = max(size, sp["size"])
                        if not chars or not any(c[0].strip() for c in chars):
                            bold, ital = bb, ii
                    chars.extend((ch, bb, ii) for ch in sp["text"])
                if not "".join(c[0] for c in chars).strip():
                    continue
                ln = Line(pn, l["bbox"], chars, size, bold, ital)
                if re.match(r"^Page \d+$", ln.text.strip()) and ln.y0 > 720:
                    continue  # page furniture
                lines.append(ln)
    return lines


def is_heading(l):
    return l.bold and l.size >= 12.9


def structural(l):
    t = l.text.lstrip()
    return (
        is_heading(l)
        or RE_Q_PAPER.match(t) or RE_Q_KEY.match(t)
        or RE_OPT.match(t) or RE_FIELD.match(t) or RE_DIFF.match(t)
        or RE_BULLET.match(l.text)
        or RE_SECTION.match(t)
    )


def first_word_width(l):
    w = l.text.split()
    return pymupdf.get_text_length((w[0] if w else "") + " ", fontname="helv", fontsize=l.size)


class Block:
    """A structural unit: rows are wrapped paragraphs; rows after the first are real line breaks."""

    def __init__(self, first):
        self.first = first
        self.rows = [list(first.chars)]
        self.last = first

    @property
    def page(self):
        return self.first.page


def blocks_of(lines):
    out = []
    for l in lines:
        if not out or structural(l) or is_heading(out[-1].first):
            out.append(Block(l))
            continue
        cur = out[-1]
        slack = RIGHT - cur.last.x1 - first_word_width(l)
        if slack < WRAP_SLACK:
            cur.rows[-1].append((" ", False, False))
            cur.rows[-1].extend(l.chars)
        else:
            cur.rows.append(list(l.chars))
        cur.last = l
    return out


# --------------------------------------------------------------------------- Markdown
SPECIALS = re.compile(r"([\\`*_\[\]<>$])")


def esc(t):
    return re.sub(r"&(?=#?\w+;)", r"\\&", SPECIALS.sub(r"\\\1", t))


def squash(chars):
    """Collapse whitespace; a space is emphasised only when both neighbours are."""
    out = []
    for ch, b, i in chars:
        if ch in " \t\r\n":
            if out and out[-1][0] == " ":
                continue
            ch = " "
        out.append([ch, b, i])
    while out and out[0][0] == " ":
        out.pop(0)
    while out and out[-1][0] == " ":
        out.pop()
    for k, c in enumerate(out):
        if c[0] == " " and 0 < k < len(out) - 1:
            c[1] = out[k - 1][1] and out[k + 1][1]
            c[2] = out[k - 1][2] and out[k + 1][2]
    return out


def md_row(chars, emphasis=True):
    cs = squash(chars)
    parts, k = [], 0
    while k < len(cs):
        j = k
        while j < len(cs) and cs[j][1:] == cs[k][1:]:
            j += 1
        text = esc("".join(c[0] for c in cs[k:j]))
        b, i = cs[k][1], cs[k][2]
        if emphasis and text.strip() and (b or i):
            m = "***" if b and i else "**" if b else "*"
            text = f"{m}{text}{m}"
        parts.append(text)
        k = j
    s = "".join(parts)
    return re.sub(r"^(\s*)([#>+\-]|\d+[.)])(\s)", r"\1\\\2\3", s)


def md_rows(rows, emphasis=True):
    return "\\\n".join(md_row(r, emphasis) for r in rows)


def plain_rows(rows):
    return "\n".join("".join(c[0] for c in squash(r)) for r in rows)


def strip_prefix(rows, regex):
    """Drop a structural prefix (matched on plain text) from the first row."""
    first = rows[0]
    s = "".join(c[0] for c in first)
    m = regex.match(s)
    return [first[m.end():]] + rows[1:] if m else rows


# --------------------------------------------------------------------------- parse
def norm(s):
    return re.sub(r"\s+", "", s)


def parse(doc):
    lines = extract(doc)
    heads = {l.text.strip(): n for n, l in enumerate(lines) if is_heading(l)}
    if "Question Paper" not in heads or "Answer Key and Reasoning" not in heads:
        raise SystemExit("ERROR: cannot find the 'Question Paper' / 'Answer Key and Reasoning' headings")
    qi, ki = heads["Question Paper"], heads["Answer Key and Reasoning"]
    paper = blocks_of(lines[qi + 1:ki])
    key = blocks_of(lines[ki + 1:])

    questions = {}
    order = []
    section = None
    cur = None
    for b in paper:
        t = b.first.text.lstrip()
        ms = RE_SECTION.match(t)
        if is_heading(b.first) and ms:
            section = (ms.group(1), ms.group(2).strip())
            cur = None
            continue
        m = RE_Q_PAPER.match(t)
        if m:
            n = int(m.group(1))
            if n in questions:
                raise SystemExit(f"ERROR: question {n} appears twice in the paper")
            rows = strip_prefix(b.rows, RE_Q_PAPER)
            cur = {"n": n, "label": m.group(2).strip(), "section": section, "page": b.page,
                   "stem_rows": rows, "options": []}
            questions[n] = cur
            order.append(n)
            continue
        mo = RE_OPT.match(t)
        if mo and cur is not None:
            cur["options"].append((mo.group(1), strip_prefix(b.rows, RE_OPT)))
            continue
        if cur is not None and not is_heading(b.first):
            cur["stem_rows"].extend(b.rows)  # stray text after options: kept with the stem
            print(f"warning: Q{cur['n']}: unexpected text block after options appended to the stem", file=sys.stderr)

    answers = {}
    kcur = None
    field = None
    for b in key:
        t = b.first.text.lstrip()
        if is_heading(b.first):
            if RE_SECTION.match(t):
                kcur, field = None, None
                continue
            break  # first non-section heading after the key = end of the key
        m = RE_Q_KEY.match(t)
        if m:
            n = int(m.group(1))
            if n in answers:
                raise SystemExit(f"ERROR: key entry {n} appears twice")
            kcur = {"n": n, "page": b.page, "head": "".join(c[0] for c in b.first.chars), "head_rows": b.rows,
                    "Correct answer": None, "Why": None, "Distractor analysis": [], "Principle": None,
                    "Intuition hook": None, "diff": None}
            answers[n] = kcur
            field = None
            continue
        if kcur is None:
            continue
        md = RE_DIFF.match(t)
        if md:
            kcur["diff"] = (int(md.group(1)), md.group(2).strip())
            field = None
            continue
        mf = RE_FIELD.match(t)
        if mf:
            name = mf.group(1)
            rows = strip_prefix(b.rows, RE_FIELD)
            field = name
            if name == "Distractor analysis":
                if "".join(c[0] for c in rows[0]).strip():
                    kcur[name].append(rows)
            else:
                kcur[name] = rows
            continue
        if RE_BULLET.match(b.first.text) and field == "Distractor analysis":
            kcur[field].append(strip_prefix(b.rows, RE_BULLET))
            continue
        raise SystemExit(f"ERROR: Q{kcur['n']}: unexpected line in the answer key: {t[:80]!r}")
    return questions, order, answers


# --------------------------------------------------------------------------- build
def split_alternatives(s):
    """Split on ' / ' or ' or ' outside parentheses."""
    out, depth, cur, i = [], 0, "", 0
    while i < len(s):
        ch = s[i]
        depth += (ch == "(") - (ch == ")")
        if depth <= 0 and (s.startswith(" / ", i) or s.startswith(" or ", i)):
            out.append(cur.strip())
            cur = ""
            i += 3 if s.startswith(" / ", i) else 4
            continue
        cur += ch
        i += 1
    out.append(cur.strip())
    return [x for x in out if x]


def build(doc, filename):
    questions, order, answers = parse(doc)
    problems = []
    if order != list(range(1, len(order) + 1)):
        problems.append("paper question numbers are not 1..N in order")
    if set(questions) != set(answers):
        problems.append(f"paper/key mismatch: only in paper {sorted(set(questions) - set(answers))}, "
                        f"only in key {sorted(set(answers) - set(questions))}")
    out_q, counts, stats = [], {}, {"head_mismatch": [], "no_answer": [], "no_why": []}
    for n in order:
        q, a = questions[n], answers.get(n)
        if a is None:
            continue
        label = q["label"]
        head = a["head"]
        if not head.startswith(f"Q{n}. ({label})"):
            problems.append(f"Q{n}: task type differs between paper [{label}] and key ({head[:40]})")
        key_stem = norm("".join(c[0] for r in strip_prefix(a["head_rows"], re.compile(r"^Q\d+\.\s*\(" + re.escape(label) + r"\)\s*")) for c in r))
        if key_stem != norm(plain_rows(q["stem_rows"])):
            stats["head_mismatch"].append(n)
        for f in ("Correct answer", "Why", "Principle", "Intuition hook", "diff"):
            if not a[f]:
                problems.append(f"Q{n}: key has no {f}")
        if not a["Distractor analysis"]:
            problems.append(f"Q{n}: key has no Distractor analysis")
        if problems and any(p.startswith(f"Q{n}:") for p in problems):
            continue

        stem = md_rows(q["stem_rows"])
        opts = [(L, md_rows(r)) for L, r in q["options"]]
        ans_plain = " ".join(plain_rows(a["Correct answer"]).split())
        letters_found = re.findall(r"\(([A-F])\)", ans_plain)
        lettered = bool(opts) and re.match(r"^\([A-F]\)", ans_plain) is not None and all(
            L in {o[0] for o in opts} for L in letters_found
        )
        base = TYPE_MAP.get(label, "open")
        if lettered:
            qtype = "mcq_multi" if (label == "Choose ALL correct answers" or len(letters_found) > 1) else "mcq_single"
        elif base in ("mcq_single", "mcq_multi") and opts:
            qtype = base
            problems.append(f"Q{n}: [{label}] has options but the key is not lettered: {ans_plain[:50]!r}")
        elif base in ("mcq_single", "mcq_multi"):
            qtype = "open"
            problems.append(f"Q{n}: [{label}] without options")
        else:
            qtype = base
        rec = {"id": f"q{n}", "number": str(n), "type": qtype, "stem": stem}
        if qtype in ("mcq_single", "mcq_multi"):
            rec["options"] = [{"label": L, "text": t} for L, t in opts]
            rec["answer"] = letters_found[0] if qtype == "mcq_single" else letters_found
        elif qtype == "short_answer":
            alts = split_alternatives(ans_plain)
            rec["answer"] = alts if len(alts) > 1 else ans_plain
        else:
            rec["answer"] = md_rows(a["Correct answer"])
        sol = []
        if a["Why"]:
            sol.append("**Why:** " + md_rows(a["Why"]))
        sol.append("**Distractor analysis:**\n\n" + "\n".join("- " + md_rows(r) for r in a["Distractor analysis"]))
        sol.append("**Principle:** " + md_rows(a["Principle"]))
        sol.append("**Intuition hook:** " + md_rows(a["Intuition hook"]))
        rec["solution"] = "\n\n".join(sol)
        sec = q["section"]
        rec["topics"] = [f"{TOPIC_ROOT} > {sec[1]}"] if sec else [TOPIC_ROOT]
        rec["fields"] = {"Task type": label}
        if sec:
            rec["fields"]["Section"] = sec[0]
        rec["fields"]["Difficulty rating"] = a["diff"][0]
        rec["fields"]["Cognitive skill"] = a["diff"][1]
        rec["source"] = {"file": filename, "page": q["page"], "key_page": a["page"]}
        out_q.append(rec)
        counts[(label, qtype)] = counts.get((label, qtype), 0) + 1

    title = TITLE_OVERRIDE or (doc.metadata or {}).get("title") or os.path.splitext(filename)[0]
    pack = {
        "format": "practice-app/question-pack@1",
        "pack": {"id": PACK_ID, "title": title, "source": filename, "subject": SUBJECT,
                 "fields": {"Collection": title}},
        "questions": out_q,
    }
    return pack, counts, stats, problems, len(questions), len(answers)


def write_outputs(pack, outdir):
    d = os.path.join(outdir, PACK_ID)
    os.makedirs(d, exist_ok=True)
    data = json.dumps(pack, ensure_ascii=False, indent=2) + "\n"
    with open(os.path.join(d, "pack.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(data)
    zpath = os.path.join(outdir, PACK_ID + ".zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        zi = zipfile.ZipInfo("pack.json", date_time=(1980, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        z.writestr(zi, data.encode("utf-8"))
    return os.path.join(d, "pack.json"), zpath


TITLE_OVERRIDE = None


def main(argv):
    global PACK_ID, TITLE_OVERRIDE
    # optional: --id <pack-id> --title <title>  (needed when several papers share one PDF title)
    argv = list(argv)
    for flag in ("--id", "--title"):
        if flag in argv:
            i = argv.index(flag)
            val = argv[i + 1]
            del argv[i:i + 2]
            if flag == "--id":
                PACK_ID = val
            else:
                TITLE_OVERRIDE = val
    if len(argv) != 3:
        print(__doc__)
        return 2
    path, outdir = argv[1], argv[2]
    doc = pymupdf.open(path)
    pack, counts, stats, problems, nq, nk = build(doc, os.path.basename(path))
    print(f"questions in paper: {nq}  entries in answer key: {nk}  converted: {len(pack['questions'])}")
    by_type = {}
    for (label, t), c in sorted(counts.items()):
        by_type[t] = by_type.get(t, 0) + c
        print(f"  {label:32s} -> {t:13s} {c}")
    print("  app types:", dict(sorted(by_type.items())))
    if stats["head_mismatch"]:
        print(f"note: key restates a different stem text for {len(stats['head_mismatch'])} questions: {stats['head_mismatch'][:20]}")
    if problems or nq != nk:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        print("count check FAILED - nothing written", file=sys.stderr)
        return 1
    print("count check OK: every question pairs with exactly one answer-key entry")
    jp, zp = write_outputs(pack, outdir)
    print("wrote", jp)
    print("wrote", zp)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
