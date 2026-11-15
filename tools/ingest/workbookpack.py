#!/usr/bin/env python3
"""Deterministic converter: practice WORKBOOK PDF (no options, no answer key) -> question pack. No AI.

For page layouts that mix one, two or three columns of numbered questions (Beast Academy style).
Each numbered question is cut out of the rendered page as an exact picture (type "open",
no answer). Numbers must run 1, 2, 3 ... inside each chapter; anything that does not is
written to FLAGGED.md next to the packs, for review.

  python3 -I tools/ingest/workbookpack.py <profile.json> <book.pdf> <outdir>
"""
import io, json, os, re, sys, zipfile
import pymupdf
from PIL import Image

ZOOM = 3.0
def md_esc(t):
    """Escape Markdown specials so instruction text shows literally."""
    return re.sub(r"([\\`*_\[\]<>$])", r"\\\1", t)


RE_NUM = re.compile(r"^(\d{1,3})\.(?:\s|$|★)")


def page_lines(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            t = "".join(s["text"] for s in l["spans"]).strip()
            if t:
                out.append((t, l["bbox"]))
    return out


def page_objects(page):
    """Boxes of everything printed on a page: text lines, vector drawings, images (page frames excluded)."""
    W, H = page.rect.width, page.rect.height
    objs = [tuple(l["bbox"]) for b in page.get_text("dict")["blocks"] for l in b.get("lines", [])]
    objs += [tuple(g["rect"]) for g in page.get_drawings() if g["rect"].width < 0.8 * W and g["rect"].height < 0.5 * H]
    objs += [tuple(i["bbox"]) for i in page.get_image_info() if i["bbox"][2] - i["bbox"][0] < 0.8 * W]
    return objs


def free_y(objs, x0, x1, lo, hi, target):
    """A y in [lo, hi] that no printed object crosses inside [x0, x1], nearest to target (None if there is none)."""
    spans = [(o[1], o[3]) for o in objs if o[2] > x0 + 0.5 and o[0] < x1 - 0.5 and o[3] > lo and o[1] < hi]
    best, y = None, lo
    while y <= hi:
        if not any(a < y < b for a, b in spans) and (best is None or abs(y - target) < abs(best - target)):
            best = y
        y += 0.5
    return best


def build_chapter(doc, prof, ch, flags):
    top, bot, ans_x = prof["band"]
    pages = list(range(ch["pages"][0], ch["pages"][1] + 1))
    cand = []                                      # (page, n, x0, y0)
    info = {}
    for pn in pages:
        L = page_lines(doc[pn - 1])
        head = " ".join(t for t, b in L if b[3] < top and len(t) > 2 and not t.startswith("Beast"))
        info[pn] = {"head": head, "lines": L}
        for t, b in L:
            m = RE_NUM.match(t)
            if m and b[1] > top:
                cand.append((pn, int(m.group(1)), b[0], b[1]))
    # accept 1, 2, 3 ... in reading order (page, then column-major within a row band)
    cand.sort(key=lambda r: (r[0], r[3], r[2]))
    accepted, used = [], set()
    last_pos = -1
    N = ch["count"]
    for n in range(1, N + 1):
        ok = [i for i, r in enumerate(cand) if r[1] == n and i not in used and r[0] >= (accepted[-1][0] if accepted else 0)]
        if ok:
            # the same number printed twice on a page: the right-margin copy is the answer-box label;
            # use it only when the page has no copy in the question area (a genuine third column)
            pg0 = cand[ok[0]][0]
            same = [i for i in ok if cand[i][0] == pg0]
            main = [i for i in same if cand[i][2] < prof["answer_label_x"]]
            ok = main or same
        hit = ok[0] if ok else None
        if hit is None:
            flags.append(f"{ch['title']}: Q{n} - number not found as a printed '{n}.' marker")
            continue
        used.add(hit); accepted.append(cand[hit])
    by_page = {}
    for r in accepted:
        by_page.setdefault(r[0], []).append(r)
    qs, assets, lessons = [], {}, []
    carry = None
    for pn in pages:
        page = doc[pn - 1]; W = page.rect.width
        rs = by_page.get(pn)
        L = info[pn]["lines"]
        objs = page_objects(page)
        H = page.rect.height
        foot = [b[1] for t, b in L if b[1] > 0.8 * H and re.match(r"^(Beast Academy|Guide Pages|Find more practice)", t)]
        bot = (min(foot) - 3) if foot else H - 10
        if not rs:
            lessons.append(pn)        # no numbered question: lesson / chapter title page, not question content
            continue
        acc = {(round(r[2]), round(r[3])) for r in rs}
        # answer-box labels down the right margin (and their blank lines) are not question content
        lab = [b[0] for t, b in L if RE_NUM.match(t) and b[0] >= prof["answer_label_x"] and b[1] > top
               and (round(b[0]), round(b[1])) not in acc]
        lab_x = (min(lab) - 3) if lab else None
        # group instructions: a line that runs across another column's number position
        instr = []
        prac = [b for t, b in L if t.strip().upper() == "PRACTICE"]
        for t, b in L:
            if prac and any(abs(b[1] - pb[1]) < 4 and b[0] > pb[2] for pb in prac) and len(t) >= 6 and b[1] >= top:
                instr.append((t, b))      # "PRACTICE | <instruction>" banner
                continue
            if len(t) < 12 or RE_NUM.match(t) or b[1] < top or b[1] >= bot:
                continue
            row = [a for a in rs if 0 < a[3] - b[3] < 70]          # the row printed just below this line
            if len({round(a[2] / 40) for a in row}) >= 2 and any(b[0] + 60 < a[2] < b[2] - 10 for a in row):
                instr.append((t, b))
        # continuation lines of an instruction: directly below it, same left edge
        grew = True
        while grew:
            grew = False
            for t, b in L:
                if any(b is x[1] for x in instr) or RE_NUM.match(t) or b[1] >= bot:
                    continue
                if any(abs(b[0] - ib[0]) < 3 and 0 <= b[1] - ib[3] < 6 for _, ib in instr):
                    instr.append((t, b)); grew = True
        iblocks = []
        for t, b in sorted(instr, key=lambda x: x[1][1]):
            if iblocks and b[1] - iblocks[-1][2] < 16:
                iblocks[-1] = (iblocks[-1][0] + " " + t, iblocks[-1][1], b[3])
            else:
                iblocks.append((t, b[1], b[3]))
        if iblocks and iblocks[0][1] < min(r[3] for r in rs):
            carry = None
        ibox = [b for t, b in instr] + prac

        # the margin labels themselves and their thin answer lines
        labbox = [b for t, b in L if RE_NUM.match(t) and lab_x is not None and b[0] >= lab_x and (round(b[0]), round(b[1])) not in acc]
        labbox += [o for o in objs if lab_x is not None and o[0] >= lab_x and o[3] - o[1] < 3]

        def excluded(o, ax):
            if o[1] >= bot or o[3] <= top:
                return True
            if ax < (lab_x or 1e9) - 5 and any(abs(o[0] - b[0]) < 0.5 and abs(o[1] - b[1]) < 0.5 for b in labbox):
                return True
            return any(abs(o[0] - b[0]) < 0.5 and abs(o[1] - b[1]) < 0.5 for b in ibox)

        gobjs = [o for o in objs if not any(abs(o[0] - b[0]) < 0.5 and abs(o[1] - b[1]) < 0.5 for b in ibox)]
        for r in rs:
            _, n, x0, y0 = r
            cx0 = prof["margin"] if x0 - 5 < prof["margin"] + 10 else x0 - 5
            below = [q for q in rs if q is not r and q[3] > y0 + 8 and abs(q[2] - x0) < 40]
            if any(q is not r and abs(q[3] - y0) < 20 and q[2] < x0 - 60 for q in rs):   # last cell of a row
                below = [q for q in rs if q is not r and q[3] > y0 + 8]
            nb = min(below, key=lambda q: q[3]) if below else None
            right = [q for q in rs if q is not r and q[2] > x0 + 60 and q[3] < (nb[3] if nb else bot) and q[3] > y0 - 40]
            cx1 = min([q[2] - 5 for q in right] + [W])
            gx1 = lab_x if (lab_x is not None and x0 < lab_x - 5 and lab_x < cx1) else cx1
            # vertical boundaries in real blank strips (instruction lines do not count)
            above = [q for q in rs if q is not r and q[3] < y0 - 8 and abs(q[2] - x0) < 40]
            lo = max([q[3] + 12 for q in above] + [top] + [ib[3] + 1 for ib in ibox if ib[3] < y0 and ib[2] > cx0 and ib[0] < gx1])
            g = free_y(gobjs, cx0, gx1, lo, y0 - 0.5, y0 - 3)
            if g is None:
                flags.append(f"{ch['title']}: Q{n} no blank strip above it on page {pn}")
            cy0 = g if g is not None else y0 - 14
            cy1 = bot
            if nb:
                g = free_y(gobjs, cx0, gx1, y0 + 12, nb[3] - 0.5, nb[3] - 3)
                if g is None:
                    flags.append(f"{ch['title']}: Q{n} no blank strip below it on page {pn}")
                cy1 = g if g is not None else nb[3] - 14
            # a cell ends above the next instruction banner printed below it
            cy1 = min([cy1] + [ib[1] - 1 for ib in ibox if ib[1] > y0 + 8 and ib[2] > cx0 and ib[0] < cx1])
            own = [o for o in objs if cx0 - 1 <= o[0] < cx1 and cy0 <= (o[1] + o[3]) / 2 < cy1 and not excluded(o, x0)]
            if not own:
                flags.append(f"{ch['title']}: Q{n} owns nothing on page {pn}")
                own = [(x0, y0, x0 + 20, y0 + 12)]
            xl = max(0, min(o[0] for o in own) - 3); yt = max(0, min(o[1] for o in own) - 3)
            xr = min(W, max(o[2] for o in own) + 3); yb = min(H, max(o[3] for o in own) + 3)
            words = [t for t, b in L if cx0 - 1 <= b[0] < cx1 and cy0 <= (b[1] + b[3]) / 2 < cy1 and not excluded(b, x0)]
            blk = [ib for ib in iblocks if ib[2] < y0]
            if blk:
                carry = blk[-1][0]
            qs.append({"number": str(n), "page": pn, "rect": (pn, xl, yt, xr, yb), "text": " ".join(words),
                       "head": info[pn]["head"], "_extra": [], "instr": carry})
        if iblocks:
            carry = iblocks[-1][0]
    seq = [int(q["number"]) for q in qs]
    out = []
    for q in qs:
        imgs = []
        for (pn, x0, y0, x1, y1) in [q["rect"]] + q["_extra"]:
            pix = doc[pn - 1].get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=pymupdf.Rect(x0, y0, x1, y1), alpha=False)
            imgs.append(Image.open(io.BytesIO(pix.tobytes("png"))))
        if len(imgs) > 1:
            w = max(i.width for i in imgs); h = sum(i.height for i in imgs)
            im = Image.new("RGB", (w, h), "white"); y = 0
            for i in imgs:
                im.paste(i, (0, y)); y += i.height
        else:
            im = imgs[0]
        buf = io.BytesIO(); im.save(buf, "PNG", optimize=True)
        name = f"{ch['id']}-q{q['number']}"
        assets[name] = {"type": "image/png", "file": f"images/{name}.png", "_bytes": buf.getvalue()}
        alt = re.sub(r"[\[\]\\]", "", re.sub(r"\s+", " ", q["text"])).strip()[:240] or f"question {q['number']}"
        star = "★" in q["text"]
        d = {"id": f"q{q['number']}", "number": q["number"], "type": "open",
             "stem": (f"*{md_esc(q['instr'])}*\n\n" if q.get("instr") else "") + f"![{alt}](asset:{name})",
             "topics": [f"{ch['title'].split('·')[-1].strip()} > {re.sub(r'(?i)^(fractions|decimals)\\s*', '', q['head']).strip().title() or 'Practice'}"],
             "fields": dict(prof.get("fields", {}), **ch.get("fields", {})),
             "source": {"file": prof["source"], "page": q["page"]}}
        if star:
            d["fields"]["Challenge"] = "★"
        out.append(d)
    ch["_lessons"] = lessons
    if len(out) != N:
        flags.append(f"{ch['title']}: expected {N} questions, built {len(out)}")
    return out, assets


def write_pack(outdir, ch, prof, questions, assets):
    d = os.path.join(outdir, ch["id"]); os.makedirs(os.path.join(d, "images"), exist_ok=True)
    pa = {}
    for k, a in assets.items():
        open(os.path.join(d, a["file"]), "wb").write(a["_bytes"])
        pa[k] = {"type": a["type"], "file": a["file"]}
    pack = {"format": "practice-app/question-pack@1",
            "pack": {"id": ch["id"], "title": ch["title"], "source": prof["source"], "subject": prof.get("subject"),
                     "fields": dict(prof.get("fields", {}), **ch.get("fields", {}))},
            "assets": pa, "questions": questions}
    with open(os.path.join(d, "pack.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(pack, f, ensure_ascii=False, indent=1)
    with zipfile.ZipFile(os.path.join(outdir, ch["id"] + ".zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(d, "pack.json"), "pack.json")
        for a in pa.values():
            z.write(os.path.join(d, a["file"]), a["file"])
    rows = "".join(f"<tr><td>Q{q['number']} (p{q['source']['page']})</td><td><img style='max-width:760px' src='{assets[re.search(r'asset:([^)]+)', q['stem']).group(1)]['file']}'></td></tr>" for q in questions)
    open(os.path.join(d, "report.html"), "w").write(f"<meta charset=utf-8><title>{ch['title']}</title><h1>{ch['title']}</h1><table border=1 cellpadding=6>{rows}</table>")


def main(argv):
    if len(argv) != 4:
        print(__doc__); return 2
    prof = json.load(open(argv[1])); doc = pymupdf.open(argv[2]); out = argv[3]
    os.makedirs(out, exist_ok=True)
    allflags = []
    for ch in prof["chapters"]:
        flags = []
        qs, assets = build_chapter(doc, prof, ch, flags)
        write_pack(out, ch, prof, qs, assets)
        print(f"{ch['id']}: {len(qs)} questions, {len(assets)} images, {len(flags)} flags, lesson pages without questions: {ch.get('_lessons')}")
        allflags += flags
    open(os.path.join(out, "FLAGGED.md"), "w").write("# Flagged for review\n\n" + "\n".join(f"- {f}" for f in allflags) + "\n")
    print("flags written to", os.path.join(out, "FLAGGED.md"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
