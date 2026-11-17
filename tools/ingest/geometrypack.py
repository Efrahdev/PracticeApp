#!/usr/bin/env python3
"""Deterministic converter for the "Geometry Olympiad Achiever Lab" HTML layout (no AI).

Same engine as htmlpack.py. Layout: sets (section.set) of articles (article.q) with a title, a
level badge, a statement, an SVG figure, answer lines and a hidden worked solution
(details.sol: Final answer + Key insight / Step-by-step reasoning / Calculation / Why the method works /
Common trap).

  python3 -I tools/ingest/geometrypack.py <book.html> <outdir>

Notes
  * Each diagram is an inline SVG styled by classes in the page's CSS. The app shows figures as stand-alone
    images, so the CSS rules a diagram uses are copied into the SVG itself.
  * The book's levels are Achiever < Advanced Achiever < Challenge. The app's three levels are
    Foundation < Challenge < Achiever, so they are mapped by RANK (not by name); the printed level is kept in
    the field "Printed level".
  * A question with one answer line whose final answer is a bare number + unit is typed numeric (the app
    can mark it). Everything else (multi-part, explanations) is "open": the printed final answer is kept.
"""
import os, re, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import htmlpack as H

H.LAYOUT.update({"pack_id": "geometry-olympiad-achiever-lab-2-q101-200", "question": "article.q",
                 "number": "span.qnum", "figure": "figure.fig", "caption": "figcaption", "fraction": "span.nofraction"})
LEVELS = {"lvl-1": ("Foundation", "Achiever"), "lvl-2": ("Challenge", "Advanced Achiever"), "lvl-3": ("Achiever", "Challenge")}
NUM_UNIT = re.compile(r"^(\d+(?:\.\d+)?)\s*(cm²|m²|cm|m|mm|km)$")
FONT = 'svg.geo text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}svg.geo{overflow:visible}'


def figure_css(src):
    """The '/* figure styling */' rules of the page, as {class: rule}."""
    st = re.search(r"<style[^>]*>(.*?)</style>", src, re.S).group(1)
    part = st[st.index("/* figure styling */"):]
    rules = {}
    for m in re.finditer(r"\.geo\s+\.([\w-]+)\s*\{[^}]*\}", part):
        rules[m.group(1)] = m.group(0)
    return rules


def style_svg(raw, rules):
    used = set(re.findall(r'class="([^"]+)"', raw))
    used = {c for u in used for c in u.split()}
    css = "".join(r for k, r in rules.items() if k in used) + FONT
    return re.sub(r"(<svg\b[^>]*>)", lambda m: m.group(1) + "<style>" + css + "</style>", raw, count=1)


def txt(node):
    return H.plain(node).replace("\xa0", " ")


def squeeze(t):
    """Runs of spaces / no-break spaces become one (a single no-break space between a number and its unit stays)."""
    return re.sub(r"[ \xa0]{2,}", " ", t)


def solution_md(sol, ctx):
    """Final answer + the five sections as Markdown, in printed order."""
    out = []
    for c in sol.children:
        if isinstance(c, str) or not hasattr(c, "tag"):
            continue
        cls = c.classes
        if c.tag == "p" and "final" in cls:
            out.append("**Final answer:** " + squeeze(H.tidy_para(H.inline(c, ctx)).removeprefix("**Final answer:**").strip()))
        elif c.tag == "h4":
            out.append("**" + H.plain(c) + "**")
        elif c.tag == "p":
            out.append(H.tidy_para(H.inline(c, ctx)))
        elif c.tag in ("ol", "ul"):
            lis = [x for x in c.children if hasattr(x, "tag") and x.tag == "li"]
            out.append("\n".join((f"{i}. " if c.tag == "ol" else "- ") + H.tidy_para(H.inline(li, ctx)) for i, li in enumerate(lis, 1)))
    return "\n\n".join(x for x in out if x)


def convert(src, filename):
    root = H.parse_html(src)
    title = H.plain(H.select_one(root, "title"))
    rules = figure_css(src)
    questions, assets, nums, problems = [], {}, [], []
    for sec in H.select(root, "section.set"):
        sh = H.select_one(sec, "h2"); stitle = H.plain(sh)
        m = re.match(r"Set\s+([A-Z])\s*[—–-]\s*(.*)$", stitle)
        set_letter, set_name = (m.group(1), m.group(2)) if m else ("", stitle)
        for art in H.select(sec, "article.q"):
            n = H.qnum(art); nums.append(n); qid = f"q{n}"
            ctx = H.Ctx(qid)
            head = H.select_one(art, "div.qhead")
            qtitle = H.plain(H.select_one(head, "h3.qtitle"))
            lvl = H.select_one(head, "span.lvl"); lcls = next(c for c in lvl.classes if c.startswith("lvl-"))
            diff, printed = LEVELS[lcls]
            if H.plain(lvl) != printed: problems.append(f"Q{n}: badge text {H.plain(lvl)!r} != level class {lcls}")
            stmt = H.select_one(art, "div.stmt")
            stem = H.block(stmt, ctx)
            fig = H.select_one(art, "figure.fig")
            if fig is not None:
                f = H.figure_md(fig, ctx)
                if f: stem = stem + "\n\n" + f
            for k in ctx.assets: ctx.assets[k]["data"] = style_svg(ctx.assets[k]["data"], rules)
            assets.update(ctx.assets)
            sol = H.select_one(art, "details.sol div.solbody")
            final_node = H.select_one(sol, "p.final")
            final = squeeze(txt(final_node).removeprefix("Final answer:").strip())
            lines = H.select(art, "div.aline")
            single = len(lines) == 1 and "with reason" not in txt(lines[0])
            q = {"id": qid, "number": n, "type": "open", "stem": stem}
            m2 = NUM_UNIT.match(final) if single else None
            if m2:
                q["type"] = "numeric"
                q["answer"] = {"value": float(m2.group(1)) if "." in m2.group(1) else int(m2.group(1)), "unit": m2.group(2)}
            else:
                q["answer"] = final
            q["solution"] = solution_md(sol, ctx)
            q["difficulty"] = diff
            q["topics"] = [f"Geometry > Perimeter and Area > {set_name}"]
            q["fields"] = {"Title": qtitle, "Set": f"{set_letter} · {set_name}" if set_letter else set_name, "Printed level": printed,
                           "Answer parts": str(len(lines))}
            q["source"] = {"file": filename, "question": f"Q{n}"}
            questions.append(q)
    # ---- checks
    if not questions: problems.append("no questions found")
    ints = [int(x) for x in nums]
    if ints != list(range(ints[0], ints[0] + len(ints))): problems.append("question numbers are not consecutive")
    nart = len(re.findall(r'<article class="q"', src))
    if nart != len(questions): problems.append(f"articles in source {nart} != questions {len(questions)}")
    nfig = len(H.select(root, "figure.fig"))
    if nfig != len(assets): problems.append(f"figures {nfig} != assets {len(assets)}")
    refs = set(re.findall(r"\(asset:([^)]+)\)", json.dumps([q["stem"] for q in questions])))
    if refs != set(assets): problems.append("asset references do not match assets")
    pack = {"format": "practice-app/question-pack@1",
            "pack": {"id": H.LAYOUT["pack_id"], "title": title, "source": filename, "subject": "Maths", "fields": {"Collection": title}},
            "assets": assets, "questions": questions}
    return pack, problems


def main(argv):
    if len(argv) != 3:
        print(__doc__); return 2
    with open(argv[1], encoding="utf-8", newline="") as f:
        pack, problems = convert(f.read(), os.path.basename(argv[1]))
    for w in H.warnings: print("warning:", w, file=sys.stderr)
    import collections
    print(f"questions: {len(pack['questions'])}  figures: {len(pack['assets'])}  types: {dict(collections.Counter(q['type'] for q in pack['questions']))}")
    if problems:
        for p in problems: print("ERROR:", p, file=sys.stderr)
        print("checks FAILED - nothing written", file=sys.stderr); return 1
    print("checks OK")
    print("wrote", H.write_outputs(pack, argv[2])[1]); return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
