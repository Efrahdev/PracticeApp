#!/usr/bin/env python3
"""Deterministic HTML problem set -> Practice App question pack (no AI anywhere).

  python3 -I tools/ingest/htmlpack.py <problem-set.html> <outdir>

writes <outdir>/<pack-id>/pack.json and <outdir>/<pack-id>.zip (pack.json at the zip root).

The page layout is described by LAYOUT below; another HTML layout normally only needs a
different map. Only the Python standard library is used. The source is treated as untrusted
data: it is parsed, never executed, and the text is copied word for word.
"""
from __future__ import annotations

import json
import os
import re
import sys
import zipfile
from html.parser import HTMLParser

# --------------------------------------------------------------------------- layout map
# Selectors: "tag.class1.class2#id", optionally chained with spaces (descendant).
LAYOUT = {
    "pack_id": "olympiad-fractions-master-set",
    "subject": "Maths",
    "category": "section.cat",          # wraps one category (title, skill line, bands)
    "category_title": "h2",             # title text inside a category
    "category_title_drop": ".catno",    # numbering span removed from the title text
    "skill": "div.skill",               # "Skill focus: ..." line inside a category
    "skill_label": "b",                 # label element removed from the skill text
    "band": "div.band",                 # difficulty band; its class decides the difficulty
    "question": "div.q",                # one question
    "number": "span.qn",                # "Q12." inside a question or a solution
    "solutions_root": "#solutions",     # solutions are only read inside this element
    "solution": "div.sol",              # one solution (starts with the same number span)
    "figure": "figure.figure",          # wraps an inline <svg>, optional <figcaption>
    "caption": "figcaption",
    "fraction": "span.f",               # "3/7" or "2 3/4"
}
BAND_DIFFICULTY = {"foundation": "Foundation", "challenge": "Challenge", "achiever": "Achiever"}
CATEGORY_TOPIC = "Number > Fractions > {title}"   # category title -> topic path
SKILL_FIELD = "Skill focus"                        # custom field that gets the skill sentence

VOID = {"br", "img", "hr", "input", "meta", "link", "wbr", "col", "area", "base", "embed", "source", "track"}


# --------------------------------------------------------------------------- tiny DOM
class Node:
    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = dict(attrs)
        self.parent = parent
        self.children = []   # Node | str
        self.raw = None      # for <svg>: the exact source text

    @property
    def classes(self):
        return (self.attrs.get("class") or "").split()

    def walk(self):
        for c in self.children:
            if isinstance(c, Node):
                yield c
                yield from c.walk()

    def text(self, skip=None):
        out = []
        for c in self.children:
            if isinstance(c, str):
                out.append(c)
            elif c.tag == "svg" or (skip and matches(c, skip)):
                continue
            else:
                out.append(c.text(skip))
        return "".join(out)


class Builder(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=True)
        self.src = src
        self.starts = [0]
        for m in re.finditer("\n", src):
            self.starts.append(m.end())
        self.root = Node("#root", {}, None)
        self.cur = self.root
        self.svg_depth = 0
        self.svg_node = None
        self.svg_start = 0

    def abs_pos(self):
        line, col = self.getpos()
        return self.starts[line - 1] + col

    def handle_starttag(self, tag, attrs):
        if self.svg_depth:
            if tag == "svg":
                self.svg_depth += 1
            return
        n = Node(tag, [(k, v if v is not None else "") for k, v in attrs], self.cur)
        self.cur.children.append(n)
        if tag == "svg":
            self.svg_depth = 1
            self.svg_node = n
            self.svg_start = self.abs_pos()
        elif tag not in VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        if self.svg_depth:
            return
        if tag == "svg":  # empty <svg/>
            n = Node(tag, [(k, v or "") for k, v in attrs], self.cur)
            n.raw = self.get_starttag_text()
            self.cur.children.append(n)
            return
        n = Node(tag, [(k, v or "") for k, v in attrs], self.cur)
        self.cur.children.append(n)

    def handle_endtag(self, tag):
        if self.svg_depth:
            if tag == "svg":
                self.svg_depth -= 1
                if self.svg_depth == 0:
                    pos = self.abs_pos()
                    end = self.src.index(">", pos) + 1
                    self.svg_node.raw = self.src[self.svg_start:end]
            return
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        if not self.svg_depth:
            self.cur.children.append(data)


def parse_html(src):
    b = Builder(src)
    b.feed(src)
    b.close()
    return b.root


# --------------------------------------------------------------------------- selectors
def _simple(sel):
    m = re.match(r"^([a-zA-Z0-9]*)((?:[.#][\w-]+)*)$", sel)
    if not m:
        raise ValueError(f"unsupported selector {sel!r}")
    tag = m.group(1) or None
    classes, ident = [], None
    for part in re.findall(r"[.#][\w-]+", m.group(2)):
        if part[0] == ".":
            classes.append(part[1:])
        else:
            ident = part[1:]
    return tag, classes, ident


def _match_simple(node, sel):
    tag, classes, ident = _simple(sel)
    return (
        isinstance(node, Node)
        and (tag is None or node.tag == tag)
        and all(c in node.classes for c in classes)
        and (ident is None or node.attrs.get("id") == ident)
    )


def matches(node, selector):
    """True if node matches the last compound of a (descendant-chained) selector."""
    parts = selector.split()
    if not _match_simple(node, parts[-1]):
        return False
    cur = node.parent
    for p in reversed(parts[:-1]):
        while cur is not None and not _match_simple(cur, p):
            cur = cur.parent
        if cur is None:
            return False
        cur = cur.parent
    return True


def select(root, selector):
    return [n for n in root.walk() if matches(n, selector)]


def select_one(root, selector):
    r = select(root, selector)
    return r[0] if r else None


def closest(node, selector):
    n = node.parent
    while n is not None:
        if matches(n, selector):
            return n
        n = n.parent
    return None


# --------------------------------------------------------------------------- text -> Markdown
SPECIALS = re.compile(r"([\\`*_\[\]<>$])")
FRACTION_RE = re.compile(r"^(-|−)?\s*(?:(\d+)\s+)?(\d+)\s*/\s*(\d+)$")
GENERIC_FRACTION_RE = re.compile(r"^([^/\s]+)\s*/\s*([^/\s]+)$")
warnings: list[str] = []


def esc(text):
    text = SPECIALS.sub(r"\\\1", text)
    return re.sub(r"&(?=#?\w+;)", r"\\&", text)


def fraction_md(txt):
    t = re.sub(r"\s+", " ", txt).strip()
    m = FRACTION_RE.match(t)
    if m:
        sign, whole, n, d = m.groups()
        return f"${'-' if sign else ''}{whole or ''}\\frac{{{n}}}{{{d}}}$"
    m = GENERIC_FRACTION_RE.match(t)
    if m:
        return f"$\\frac{{{m.group(1)}}}{{{m.group(2)}}}$"
    warnings.append(f"fraction span not understood, kept as text: {t!r}")
    return esc(t)


def wrap(marker, inner):
    core = inner.strip(" ")
    if not core:
        return inner
    lead = inner[: len(inner) - len(inner.lstrip(" "))]
    trail = inner[len(inner.rstrip(" ")):]
    return f"{lead}{marker}{core}{marker}{trail}"


class Ctx:
    """Collects figures while rendering one question."""

    def __init__(self, qid):
        self.qid = qid
        self.assets = {}


def inline(node, ctx):
    """Render a node's children as inline Markdown (figures handled by block())."""
    out = []
    for c in node.children:
        if isinstance(c, str):
            out.append(esc(re.sub(r"[ \t\r\n\f]+", " ", c)))
            continue
        if matches(c, LAYOUT["number"]) or c.tag == "svg":
            continue
        if matches(c, LAYOUT["fraction"]):
            out.append(fraction_md(c.text()))
        elif c.tag in ("b", "strong"):
            out.append(wrap("**", inline(c, ctx)))
        elif c.tag in ("em", "i"):
            out.append(wrap("*", inline(c, ctx)))
        elif c.tag in ("sup", "sub"):
            out.append(f"<{c.tag}>{inline(c, ctx)}</{c.tag}>")
        elif c.tag == "br":
            out.append("\\\n")
        else:
            out.append(inline(c, ctx))
    return "".join(out)


def tidy_para(s):
    s = re.sub(r" {2,}", " ", s)
    s = "\n".join(l.strip(" ") for l in s.split("\n")).strip()
    s = re.sub(r"^(\s*)([#>+\-]|\d+[.)])(\s)", r"\1\\\2\3", s)
    return s


def alt_text(svg_raw):
    m = re.search(r'aria-label="([^"]*)"', svg_raw[: svg_raw.find(">") + 1])
    alt = m.group(1) if m else None
    if not alt:
        m = re.search(r"<title[^>]*>(.*?)</title>", svg_raw, re.S)
        alt = m.group(1) if m else "Figure"
    alt = re.sub(r"\s+", " ", alt).strip()
    from html import unescape
    return re.sub(r"([\[\]\\])", r"\\\1", unescape(alt))


def figure_md(fig, ctx):
    svg = next((n for n in fig.walk() if n.tag == "svg"), None)
    if svg is None or not svg.raw:
        warnings.append(f"{ctx.qid}: figure without svg skipped")
        return None
    name = f"{ctx.qid}-fig" if not ctx.assets else f"{ctx.qid}-fig{len(ctx.assets) + 1}"
    raw = svg.raw
    if "xmlns=" not in raw.split(">", 1)[0]:
        # An inline SVG needs no namespace, but the app shows figures as standalone images, which do.
        raw = raw.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    ctx.assets[name] = {"type": "image/svg+xml", "data": raw}
    block = f"![{alt_text(svg.raw)}](asset:{name})"
    cap = select_one(fig, LAYOUT["caption"])
    if cap is not None:
        ctext = tidy_para(wrap("*", inline(cap, ctx)))
        if ctext:
            block += "\n\n" + ctext
    return block


BLOCK_TAGS = {"p", "div", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "section", "blockquote"}


def block(node, ctx):
    """Render node's children as Markdown blocks separated by blank lines."""
    blocks, buf = [], []

    def flush():
        t = tidy_para("".join(buf))
        buf.clear()
        if t:
            blocks.append(t)

    def visit(parent):
        for c in parent.children:
            if isinstance(c, str):
                buf.append(esc(re.sub(r"[ \t\r\n\f]+", " ", c)))
            elif matches(c, LAYOUT["number"]) or c.tag == "svg":
                continue
            elif matches(c, LAYOUT["figure"]):
                flush()
                f = figure_md(c, ctx)
                if f:
                    blocks.append(f)
            elif c.tag in BLOCK_TAGS:
                flush()
                if c.tag == "li":
                    sub = block(c, ctx)
                    blocks.append("- " + sub.replace("\n", "\n  "))
                else:
                    visit(c)
                    flush()
            else:
                # inline element: render through inline() applied to a one-child wrapper
                w = Node("#w", {}, None)
                w.children = [c]
                buf.append(inline(w, ctx))

    visit(node)
    flush()
    return "\n\n".join(blocks)


def plain(node, skip=None):
    return re.sub(r"\s+", " ", node.text(skip)).strip()


# --------------------------------------------------------------------------- conversion
def qnum(node):
    n = select_one(node, LAYOUT["number"])
    if n is None:
        return None
    m = re.search(r"\d+[A-Za-z]?", plain(n))
    return m.group(0) if m else None


def convert(src, filename):
    root = parse_html(src)
    title_node = select_one(root, "title")
    title = plain(title_node) if title_node else os.path.splitext(filename)[0]

    sol_root = select_one(root, LAYOUT["solutions_root"])
    sol_nodes = select(sol_root, LAYOUT["solution"]) if sol_root else []
    q_nodes = [q for q in select(root, LAYOUT["question"]) if not (sol_root and _inside(q, sol_root))]

    solutions = {}
    dup_sol = []
    for s in sol_nodes:
        n = qnum(s)
        if n in solutions:
            dup_sol.append(n)
        solutions[n] = block(s, Ctx(f"s{n}"))

    assets, questions, q_numbers = {}, [], []
    for qn in q_nodes:
        n = qnum(qn)
        q_numbers.append(n)
        qid = f"q{n}"
        ctx = Ctx(qid)
        stem = block(qn, ctx)
        assets.update(ctx.assets)
        cat = closest(qn, LAYOUT["category"])
        band = closest(qn, LAYOUT["band"])
        cat_title = skill = None
        if cat is not None:
            t = select_one(cat, LAYOUT["category_title"])
            cat_title = plain(t, LAYOUT["category_title_drop"]) if t else None
            sk = select_one(cat, LAYOUT["skill"])
            if sk is not None:
                skill = plain(sk, LAYOUT["skill_label"])
        diff = None
        if band is not None:
            diff = next((BAND_DIFFICULTY[c] for c in band.classes if c in BAND_DIFFICULTY), None)
        q = {"id": qid, "number": n, "type": "open", "stem": stem}
        if n in solutions and solutions[n]:
            q["solution"] = solutions[n]
        if diff:
            q["difficulty"] = diff
        if cat_title:
            q["topics"] = [CATEGORY_TOPIC.format(title=cat_title)]
        if skill:
            q["fields"] = {SKILL_FIELD: skill}
        q["source"] = {"file": filename, "question": f"Q{n}"}
        questions.append(q)

    # ---- pairing check
    problems = []
    if not questions:
        problems.append("no questions found")
    if len(set(q_numbers)) != len(q_numbers):
        problems.append(f"duplicate question numbers: {sorted({x for x in q_numbers if q_numbers.count(x) > 1})}")
    if dup_sol:
        problems.append(f"duplicate solution numbers: {sorted(set(dup_sol))}")
    missing = [n for n in q_numbers if n not in solutions]
    orphan = [n for n in solutions if n not in q_numbers]
    if missing:
        problems.append(f"questions without a solution: {missing}")
    if orphan:
        problems.append(f"solutions without a question: {orphan}")
    n_fig_src = len(select(root, LAYOUT["figure"]))
    if n_fig_src != len(assets):
        problems.append(f"figures in source {n_fig_src} != assets written {len(assets)}")
    refs = set(re.findall(r"\(asset:([^)]+)\)", json.dumps([q["stem"] for q in questions])))
    if refs != set(assets):
        problems.append(f"asset references {sorted(refs ^ set(assets))} do not match assets")

    pack = {
        "format": "practice-app/question-pack@1",
        "pack": {
            "id": LAYOUT["pack_id"],
            "title": title,
            "source": filename,
            "subject": LAYOUT["subject"],
            "fields": {"Collection": title},
        },
        "assets": assets,
        "questions": questions,
    }
    return pack, {
        "questions": len(questions), "solutions": len(solutions), "figures_in_source": n_fig_src,
        "assets": len(assets), "problems": problems,
    }


def _inside(node, ancestor):
    n = node.parent
    while n is not None:
        if n is ancestor:
            return True
        n = n.parent
    return False


def write_outputs(pack, outdir):
    pid = pack["pack"]["id"]
    d = os.path.join(outdir, pid)
    os.makedirs(d, exist_ok=True)
    data = json.dumps(pack, ensure_ascii=False, indent=2) + "\n"
    with open(os.path.join(d, "pack.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(data)
    zpath = os.path.join(outdir, pid + ".zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        zi = zipfile.ZipInfo("pack.json", date_time=(1980, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        z.writestr(zi, data.encode("utf-8"))
    return os.path.join(d, "pack.json"), zpath


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    src_path, outdir = argv[1], argv[2]
    with open(src_path, encoding="utf-8", newline="") as f:
        src = f.read()
    pack, stats = convert(src, os.path.basename(src_path))
    for w in warnings:
        print("warning:", w, file=sys.stderr)
    print(f"questions: {stats['questions']}  solutions: {stats['solutions']}  "
          f"figures in source: {stats['figures_in_source']}  figure assets: {stats['assets']}")
    if stats["problems"]:
        for p in stats["problems"]:
            print("ERROR:", p, file=sys.stderr)
        print("count check FAILED - nothing written", file=sys.stderr)
        return 1
    print("count check OK: every question pairs with exactly one solution")
    jp, zp = write_outputs(pack, outdir)
    print("wrote", jp)
    print("wrote", zp)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
