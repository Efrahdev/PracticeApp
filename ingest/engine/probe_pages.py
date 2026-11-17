"""Probe for page sources: digital PDF, scanned PDF, images/screenshots, and Office/HTML printed to pages.

Facts only, no judgement: text layer per page, line starts that look like numbering, likely headers and
footers, answer markers, columns, figures, and annotated page images on which every unit is drawn with its
id. The AI reads the images (for layout, and for scans to map question numbers to units).
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from PIL import ImageDraw, ImageFont

from pages import PageDoc

PATTERNS = {
    "Q1. / Q.1": r"^Q\.?\s?\d+[.):]?\s", "1. / 1)": r"^\d{1,3}\s*[.)]\s", "(1)": r"^\(\d{1,3}\)\s", "1 (number alone, then text)": r"^\d{1,3}\s+[A-Z]",
    "(A) / (a)": r"^\([A-Ha-h]\)\s", "A. / a.": r"^[A-Ha-h][.)]\s", "Sol / Solution": r"^(Sol|Solution)\b", "Ans / Answer": r"^(Ans|Answer)\b",
    "Correct answer": r"^Correct answer", "Section / Part": r"^(Section|Part|SECTION|PART)\s", "Answer key heading": r"(?i)^answer key|^answers$|^key$",
}
SAMPLE_PAGES = 10
MAX_SCAN_IMAGES = 60


def _norm(t: str) -> str:
    return re.sub(r"\d+", "#", t.strip().lower())


def probe_pages(path: Path, kind: str, out_dir: Path | None, pages: str | None = None, columns=1) -> dict:
    data = path.read_bytes()
    doc = PageDoc(data, path.name, kind, path=path, pages=pages, columns=columns, dpi=110)
    blocks = doc.ledger.blocks
    lines = [b for b in blocks if b["kind"] == "line"]
    no_text = [p for p in doc.page_numbers if p not in doc.text_pages]
    if doc.pdf is not None and no_text and len(no_text) == len(doc.page_numbers):
        # a scan: read it exactly as the scan route will (units@1), so the unit ids drawn here are the ids a job uses
        doc = PageDoc(data, path.name, kind, path=path, pages=pages, columns=columns, dpi=110, mode="units")
    elif doc.pdf is not None and no_text:
        for p in no_text:   # mixed: show the scanned pages' bands; probe that page range alone to get the ids a units@1 job uses
            doc.bands_for_pdf_page(p)
    blocks = doc.ledger.blocks
    per_page = []
    for p in doc.page_numbers:
        bs = [b for b in blocks if b["page"] == p]
        per_page.append({"page": p, "size": [round(v) for v in doc.size[p]], "text_layer": p in doc.text_pages,
                         "lines": sum(1 for b in bs if b["kind"] == "line"), "figures": sum(1 for b in bs if b["kind"] == "graphic"),
                         "ink_bands": sum(1 for b in bs if b["kind"] == "band"), "rotated_text": sum(1 for b in bs if b["kind"] == "rotated"),
                         "uncertain_lines": sum(1 for b in bs if b.get("uncertain"))})
    # numbering and markers at the start of lines
    starts = {}
    for name, pat in PATTERNS.items():
        hits = [b for b in lines if re.match(pat, b["text"].strip())]
        if hits:
            starts[name] = {"count": len(hits), "pages": sorted({b["page"] for b in hits})[:12], "examples": [f"{b['locator']}: {b['text'][:70]}" for b in hits[:4]]}
    # repeating lines (headers, footers): same text (digits ignored) in a similar place on many pages
    rep = Counter()
    where = {}
    for b in lines:
        h = doc.size[b["page"]][1]
        key = (_norm(b["text"]), round(b["box"][1] / h, 2))
        rep[key] += 1
        where.setdefault(key, b)
    n_pages = max(1, len(doc.text_pages))
    repeating = [{"text": where[k]["text"][:60], "y_fraction": k[1], "pages": c, "example": where[k]["locator"]}
                 for k, c in rep.most_common(40) if c >= max(2, 0.3 * n_pages)]
    # columns: many lines starting right of the middle suggests two columns
    right = sum(1 for b in lines if b["box"][0] > 0.45 * doc.size[b["page"]][0])
    col_note = (f"{right} of {len(lines)} lines start right of the page middle: possibly two columns (set pages.columns: 2) — check the images"
                if lines and right > 0.25 * len(lines) else "one column of text (few lines start right of the middle)")
    fonts = Counter(round(b["size"]) for b in lines)
    report = {"kind": kind, "page_route": True, "pages_total": len(doc.pdf) if doc.pdf is not None else len(doc.images), "pages_read": doc.page_numbers,
              "pages_with_text": sorted(doc.text_pages), "pages_without_text": no_text, "converted_from": doc.converted_from,
              "line_starts": starts, "repeating_lines": repeating, "columns": col_note, "font_sizes": dict(fonts.most_common(8)),
              "rotated_text_examples": [b["text"][:50] for b in blocks if b["kind"] == "rotated"][:4],
              "uncertain_examples": [{"line": b["locator"], "text": b["text"][:70], "why": b["uncertain"]} for b in lines if b.get("uncertain")][:8],
              "per_page": per_page}
    # verdict and route
    if not lines:
        report["route"] = ("SCAN ROUTE: no page has a text layer. Use segment.by: units@1 and list, in the job, the ink-band units of each "
                           "question as drawn on the page images (regions). Every question is shown as a picture of its region.")
    elif no_text:
        report["route"] = (f"MIXED: pages {no_text[:20]} have no text layer. Use lines@1 for the text pages and a separate job with units@1 "
                           "for the scanned page range, or ignore those pages with a reason.")
    else:
        report["route"] = "TEXT ROUTE: every page read has a text layer. Use segment.by: lines@1."
    # sample lines with ids, positions as fractions of the page
    first_q = next((b for b in lines if any(re.match(PATTERNS[k], b["text"].strip()) for k in ("Q1. / Q.1", "1. / 1)", "1 (number alone, then text)"))), None)
    sample_pages = []
    if first_q:
        sample_pages.append(first_q["page"])
    for k in ("Sol / Solution", "Ans / Answer", "Correct answer", "Answer key heading"):
        if k in starts:
            sample_pages.append(starts[k]["pages"][0])
    if doc.page_numbers:
        sample_pages += [doc.page_numbers[0], doc.page_numbers[len(doc.page_numbers) // 2], doc.page_numbers[-1]]
    sample_pages = list(dict.fromkeys(sample_pages))[:5]
    report["sample_lines"] = {p: [f"{b['locator']} y={b['box'][1] / doc.size[p][1]:.3f} x={b['box'][0] / doc.size[p][0]:.2f} | {b['text'][:90]}"
                                  for b in blocks if b["page"] == p and b["kind"] in ("line", "rotated")][:45] for p in sample_pages}
    report["sample_units"] = {p: [f"{b['locator']} {b['kind']} y={b['box'][1] / doc.size[p][1]:.3f}-{b['box'][3] / doc.size[p][1]:.3f}"
                                  for b in blocks if b["page"] == p and b["kind"] in ("graphic", "band")][:40] for p in sample_pages}
    # annotated images
    if out_dir is not None:
        img_dir = out_dir / "pages"
        img_dir.mkdir(parents=True, exist_ok=True)
        scan_like = bool(no_text) or doc.pdf is None
        chosen = doc.page_numbers[:MAX_SCAN_IMAGES] if scan_like else list(dict.fromkeys(sample_pages + doc.page_numbers[:2]))[:SAMPLE_PAGES]
        files = []
        for p in chosen:
            files.append(str((img_dir / f"p{p:04d}.png").relative_to(out_dir)))
            _annotate(doc, p, img_dir / f"p{p:04d}.png")
        report["images"] = files
        if scan_like and len(doc.page_numbers) > MAX_SCAN_IMAGES:
            report["images_note"] = f"only the first {MAX_SCAN_IMAGES} pages were drawn: probe a page range (--pages) per job for the rest"
    return report


def _annotate(doc: PageDoc, p: int, out: Path) -> None:
    im = doc.render(p).copy()
    w, h = doc.size[p]
    sx, sy = im.width / w, im.height / h
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.load_default(size=11)
    except TypeError:   # older Pillow
        font = ImageFont.load_default()
    colours = {"line": (40, 110, 220), "graphic": (230, 120, 0), "band": (0, 150, 70), "rotated": (170, 170, 170)}
    for b in doc.blocks_on(p):
        if b["kind"] not in colours:
            continue
        x0, y0, x1, y1 = b["box"]
        box = [x0 * sx - 1, y0 * sy - 1, x1 * sx + 1, y1 * sy + 1]
        d.rectangle(box, outline=colours[b["kind"]], width=1 if b["kind"] == "line" else 2)
        if b["kind"] in ("graphic", "band"):
            label = b["locator"]
            tx, ty = max(0, box[0]), max(0, box[1] - 12)
            d.rectangle([tx, ty, tx + 7 * len(label) + 4, ty + 12], fill=colours[b["kind"]])
            d.text((tx + 2, ty), label, fill=(255, 255, 255), font=font)
    # a ruler of y fractions down the left edge
    for k in range(0, 11):
        y = int(k / 10 * im.height)
        d.line([0, y, 8, y], fill=(200, 0, 0), width=1)
        d.text((10, max(0, y - 6)), f"{k / 10:.1f}", fill=(200, 0, 0), font=font)
    im.save(out, format="PNG", optimize=False)


def md(report: dict) -> list[str]:
    import json
    j = lambda v: json.dumps(v, ensure_ascii=False)   # noqa: E731
    L = [f"- pages read {len(report['pages_read'])} of {report['pages_total']}; with a text layer: {len(report['pages_with_text'])}; without: `{j(report['pages_without_text'][:40])}`"
         + (f"; converted to pages from {report['converted_from']}" if report.get("converted_from") else ""),
         f"- **{report['route']}**", f"- columns: {report['columns']}", f"- font sizes (size: lines): `{j(report['font_sizes'])}`", "",
         "### Line starts (numbering, options, answers, sections)", ""]
    for name, v in report["line_starts"].items():
        L.append(f"- **{name}**: {v['count']} lines, pages {v['pages']} — e.g. " + " · ".join(f"`{e}`" for e in v["examples"]))
    L += ["", "### Lines that repeat on many pages (headers and footers: ignore them with a regex or a band)", ""]
    L += [f"- `{r['text']}` at y≈{r['y_fraction']} on {r['pages']} pages (e.g. {r['example']})" for r in report["repeating_lines"]] or ["- none"]
    if report["rotated_text_examples"]:
        L += ["", f"Rotated text (watermarks): `{j(report['rotated_text_examples'])}` — ignore with `{{rotated: true}}`."]
    if report["uncertain_examples"]:
        L += ["", "Lines whose text is unreliable (symbol fonts, mixed sizes); `display: auto` shows such questions as pictures:", ""]
        L += [f"- `{u['line']}` {u['text']!r} — {', '.join(u['why'])}" for u in report["uncertain_examples"]]
    for p, rows in report["sample_lines"].items():
        L += ["", f"### Page {p}: lines with ids and positions (y and x as fractions of the page)", "", "```", *rows, "```"]
        if report["sample_units"].get(p):
            L += ["", f"Figures and ink bands on page {p}:", "", "```", *report["sample_units"][p], "```"]
    L += ["", "### Per page", "", "```json", json.dumps(report["per_page"][:40], ensure_ascii=False), "```"]
    if report.get("images"):
        L += ["", "### Page images to attach", "", "Blue boxes are text lines, orange boxes figures, green boxes ink bands (scans); figures and bands carry their unit id. "
              "The red ruler on the left gives y as a fraction of the page height (for `band` ignore rules).", ""]
        L += [f"- `{f}`" for f in report["images"]]
        if report.get("images_note"):
            L.append(f"- {report['images_note']}")
    return L
