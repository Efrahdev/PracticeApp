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
RE_NUM = re.compile(r"^(\d{1,3})\.(?:\s|$|★)")


def page_lines(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            t = "".join(s["text"] for s in l["spans"]).strip()
            if t:
                out.append((t, l["bbox"]))
    return out


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
        hit = next((i for i, r in enumerate(cand) if r[1] == n and i not in used and r[0] >= (accepted[-1][0] if accepted else 0)), None)
        if hit is None:
            flags.append(f"{ch['title']}: Q{n} - number not found as a printed '{n}.' marker")
            continue
        used.add(hit); accepted.append(cand[hit])
    by_page = {}
    for r in accepted:
        by_page.setdefault(r[0], []).append(r)
    qs, assets, lessons = [], {}, []
    for pn in pages:
        page = doc[pn - 1]; W = page.rect.width
        rs = by_page.get(pn)
        L = info[pn]["lines"]
        if not rs:
            lessons.append(pn)        # no numbered question: lesson / chapter title page, not question content
            continue
        # right limit: answer-label column (numbers printed on the right edge)
        acc = {(round(r[2]), round(r[3])) for r in rs}
        lab = [b[0] for t, b in L if RE_NUM.match(t) and b[0] >= prof["answer_label_x"] and b[1] > top
               and (round(b[0]), round(b[1])) not in acc]
        xr_page = (min(lab) - 3) if lab else W - 20
        for r in rs:
            _, n, x0, y0 = r
            xl = max(prof["margin"], x0 - 5)
            # right edge: next anchor to the right that overlaps this one's rows
            below = [q for q in rs if q is not r and q[3] > y0 + 8 and abs(q[2] - x0) < 40]
            if any(q is not r and abs(q[3] - y0) < 20 and q[2] < x0 - 60 for q in rs):   # last cell of a row
                below = [q for q in rs if q is not r and q[3] > y0 + 8]
            ybot = min([q[3] - 14 for q in below] + [bot])
            right = [q for q in rs if q is not r and q[2] > x0 + 60 and q[3] < ybot and q[3] > y0 - 40]
            xr = min([q[2] - 7 for q in right] + [xr_page if xr_page > x0 + 60 else W - 20])
            ytop = max(y0 - 14, top)
            if xr - xl < 40:
                flags.append(f"{ch['title']}: Q{n} cell too narrow on page {pn}; widened to the full row")
                xr = xr_page
            ybot = max(ybot, ytop + 30)
            if ybot - ytop < 24:
                flags.append(f"{ch['title']}: Q{n} cell is very short ({ybot - ytop:.0f}pt) on page {pn}")
            words = [t for t, b in L if xl - 2 <= b[0] <= xr and ytop <= b[1] <= ybot]
            qs.append({"number": str(n), "page": pn, "rect": (pn, xl, ytop, xr, ybot), "text": " ".join(words),
                       "head": info[pn]["head"], "_extra": []})
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
             "stem": f"![{alt}](asset:{name})",
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
