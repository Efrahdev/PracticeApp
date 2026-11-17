"""Page adapter (S1) for every source that is best read as pages: digital PDF, scanned PDF, images and
screenshots, and, converted to PDF first, Office documents (Word, PowerPoint, OpenDocument, RTF, plain text)
and HTML pages printed by the browser.

Units are the atoms of the coverage ledger:
  line  - one line of real text (digital pages), with its box in PDF points
  graphic - an embedded image or a cluster of vector drawing (figures, diagrams)
  band  - a horizontal band of ink on a page without text (scans, screenshots)
  rotated - text drawn at an angle (watermarks)
Every unit must be claimed by a question or ignored with a reason, as for HTML and Word.

Nothing is drawn, guessed or redrawn: pictures of question regions are crops of the page rendering (R3).
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
import zipfile
from pathlib import Path

from ledger import Ledger
from util import StageFail, sha256_bytes

try:
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfc
except Exception:  # pragma: no cover
    pdfium = pdfc = None
from PIL import Image

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
MATH_FONT = re.compile(r"math|symbol|cmmi|cmsy|cmex|mt ?extra|wingding|dingbat|stix|cambria ?math|euclid|mtsy", re.I)
MAX_PAGES = 2000
MAX_PIXELS = 80_000_000


def _pdf_doc(data: bytes, name: str):
    if pdfium is None:
        raise StageFail("pypdfium2 is not installed: PDFs cannot be read", check="S1.environment", hint="pip install pypdfium2")
    try:
        return pdfium.PdfDocument(data)
    except Exception as e:  # noqa: BLE001
        raise StageFail(f"{name}: not a readable PDF ({e})", check="S0.integrity")


def office_to_pdf(data: bytes, name: str) -> bytes:
    """Word, PowerPoint, Excel, OpenDocument, RTF, text: printed to PDF by LibreOffice, offline, in a temp folder."""
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise StageFail("LibreOffice is not installed, so this document type cannot be converted to pages", check="S1.environment",
                        hint="install LibreOffice, or save the document as PDF yourself and use that")
    with tempfile.TemporaryDirectory(prefix="ingest-office-") as tmp:
        src = Path(tmp) / ("input" + Path(name).suffix.lower())
        src.write_bytes(data)
        profile_dir = Path(tmp) / "profile"
        env = dict(os.environ, HOME=tmp)
        try:
            subprocess.run([exe, f"-env:UserInstallation=file://{profile_dir}", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", tmp, str(src)],
                           capture_output=True, timeout=240, env=env, check=False)
        except subprocess.TimeoutExpired:
            raise StageFail("LibreOffice took longer than 4 minutes to convert the document", check="S1.convert")
        out = src.with_suffix(".pdf")
        if not out.exists():
            raise StageFail("LibreOffice could not convert the document to PDF", check="S1.convert")
        return out.read_bytes()


def html_to_pdf(path: Path) -> bytes:
    """An HTML page printed by the headless browser with the network blocked (R13): for layouts that the
    structured HTML route cannot describe."""
    script = Path(__file__).resolve().parents[1] / "checker" / "printpdf.mjs"
    root = Path(__file__).resolve().parents[2]
    env = dict(os.environ, NODE_PATH=str(root / "node_modules") + os.pathsep + "/opt/node-tools/node_modules")
    with tempfile.TemporaryDirectory(prefix="ingest-print-") as tmp:
        out = Path(tmp) / "page.pdf"
        p = subprocess.run(["node", str(script), str(path.resolve()), str(out)], capture_output=True, text=True, timeout=240, env=env, cwd=str(root))
        if p.returncode != 0 or not out.exists():
            raise StageFail(f"the browser could not print the page to PDF: {(p.stderr or p.stdout)[-300:]}", check="S1.convert")
        return out.read_bytes()


def load_images(data: bytes, name: str) -> list[Image.Image]:
    """One image, a multi-page TIFF, or a .zip of images (pages in file-name order)."""
    frames: list[Image.Image] = []

    def add(blob: bytes, label: str):
        try:
            im = Image.open(io.BytesIO(blob))
            im.load()
        except Exception as e:  # noqa: BLE001
            raise StageFail(f"{label}: not a readable image ({e})", check="S0.integrity")
        n = getattr(im, "n_frames", 1)
        for k in range(n):
            im.seek(k)
            fr = im.convert("RGB")
            if fr.width * fr.height > MAX_PIXELS:
                raise StageFail(f"{label}: image is {fr.width}x{fr.height} pixels (limit {MAX_PIXELS})", check="S0.integrity")
            frames.append(fr)
    if data[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = sorted(n for n in z.namelist() if Path(n).suffix.lower() in IMAGE_EXT and not n.startswith("__MACOSX") and ".." not in n)
            if not names:
                raise StageFail(f"{name}: the zip holds no images", check="S0.integrity")
            for n in names:
                add(z.read(n), n)
    else:
        add(data, name)
    if not frames or len(frames) > MAX_PAGES:
        raise StageFail(f"{name}: {len(frames)} pages", check="S0.integrity")
    return frames


class PageDoc:
    """All pages of the source, their units, and pixel renderings for crops."""

    def __init__(self, data: bytes, name: str, kind: str, *, path: Path | None = None, pages: str | None = None, columns=1, dpi: int = 150,
                 mode: str = "lines"):
        self.name, self.kind, self.dpi, self.mode = name, kind, dpi, mode
        self.ledger = Ledger()
        self.elements_seen = 0
        self.columns = columns
        self.converted_from = None
        if kind in ("office",):
            data, self.converted_from = office_to_pdf(data, name), "office"
        elif kind == "html-print":
            data, self.converted_from = html_to_pdf(path), "html"
        self.pdf_bytes = data if kind != "image" else None
        self.pdf_sha256 = sha256_bytes(data) if self.pdf_bytes else None
        self.images = load_images(data, name) if kind == "image" else None
        self.pdf = _pdf_doc(data, name) if self.pdf_bytes else None
        total = len(self.pdf) if self.pdf is not None else len(self.images)
        self.page_numbers = parse_range(pages, total)
        self.size: dict[int, tuple[float, float]] = {}
        self.lines: list[dict] = []       # ledger block ids in reading order are in self.order
        self.order: list[int] = []
        self._render_cache: dict[int, Image.Image] = {}
        self.text_pages: set[int] = set()
        for p in self.page_numbers:
            if self.pdf is None:
                self._read_image_page(p)
            elif mode == "units":   # scan route: the page is read as ink bands, never as text
                w, h = self.pdf[p - 1].get_size()
                self.size[p] = (w, h)
                self.bands_for_pdf_page(p)
            else:
                self._read_pdf_page(p)

    # ---------------------------------------------------------------- reading
    def _col_of(self, x0: float, x1: float, width: float) -> int:
        if self.columns == 1:
            return 0
        split = self.columns if isinstance(self.columns, float) else 0.5
        return 0 if (x0 + x1) / 2 < split * width else 1

    def _read_pdf_page(self, p: int) -> None:
        page = self.pdf[p - 1]
        w, h = page.get_size()
        self.size[p] = (w, h)
        tp = page.get_textpage()
        n = tp.count_chars()
        chars = []
        for i in range(n):
            u = pdfc.FPDFText_GetUnicode(tp.raw, i)
            ch = chr(u) if u else ""
            if ch in ("\r", "\n", ""):
                chars.append(None)
                continue
            l, b, r, t = tp.get_charbox(i)
            angle = pdfc.FPDFText_GetCharAngle(tp.raw, i)
            size = pdfc.FPDFText_GetFontSize(tp.raw, i)
            chars.append({"c": ch, "box": (l, h - t, r, h - b), "angle": angle, "size": size, "i": i, "space": ch.isspace()})
        # raw lines: pdfium separates lines with generated line breaks
        raw, cur = [], []
        for c in chars + [None]:
            if c is None:
                if cur:
                    raw.append(cur)
                cur = []
            else:
                cur.append(c)
        frags = []
        for seg in raw:
            ink = [c for c in seg if not c["space"] and c["box"][2] > c["box"][0]]
            if not ink:
                continue
            rotated = sum(1 for c in ink if abs(c["angle"]) > 0.05 and abs(c["angle"] - 6.2832) > 0.05) > len(ink) / 2
            # split at the column gutter
            by_col: dict[int, list] = {}
            for c in seg:
                col = self._col_of(c["box"][0], c["box"][2], w) if c["box"][2] > c["box"][0] else None
                if col is None:
                    col = by_col and list(by_col)[-1] or 0
                by_col.setdefault(col, []).append(c)
            for col, cs in by_col.items():
                ink2 = [c for c in cs if not c["space"] and c["box"][2] > c["box"][0]]
                if not ink2:
                    continue
                frags.append({"col": col, "chars": cs, "ink": ink2, "rotated": rotated})
        # merge fragments that sit on the same baseline in the same column (pdfium sometimes splits them)
        frags.sort(key=lambda f: (f["col"], min(c["box"][1] for c in f["ink"]), min(c["box"][0] for c in f["ink"])))
        merged = []
        for f in frags:
            top = min(c["box"][1] for c in f["ink"]); bot = max(c["box"][3] for c in f["ink"])
            if merged and not f["rotated"] and not merged[-1]["rotated"] and merged[-1]["col"] == f["col"]:
                m = merged[-1]
                ov = min(bot, m["bot"]) - max(top, m["top"])
                if ov > 0.6 * min(bot - top, m["bot"] - m["top"]):
                    m["frags"].append(f)
                    m["top"], m["bot"] = min(top, m["top"]), max(bot, m["bot"])
                    continue
            merged.append({"col": f["col"], "frags": [f], "top": top, "bot": bot, "rotated": f["rotated"]})
        sizes = sorted(c["size"] for m in merged for f in m["frags"] for c in f["ink"]) or [10]
        median = sizes[len(sizes) // 2]
        for k, m in enumerate(merged, start=1):
            fr = m["frags"]
            # characters in left-to-right order of their boxes. A word break where pdfium's own text order has a
            # space between the two characters, or where the gap is plainly wider than letter spacing.
            ink = sorted((c for f in fr for c in f["ink"]), key=lambda c: (c["box"][0], c["box"][2]))
            spaces = sorted(c["i"] for f in fr for c in f["chars"] if c["space"])
            import bisect
            text, prev = "", None
            for c in ink:
                if prev is not None:
                    lo, hi = sorted((prev["i"], c["i"]))
                    k = bisect.bisect_right(spaces, lo)
                    spaced = hi - lo <= 4 and k < len(spaces) and spaces[k] < hi
                    gap = c["box"][0] - prev["box"][2]
                    if spaced or gap > 0.45 * max(prev["size"] or 1, c["size"] or 1) or (hi - lo > 4 and gap > 0.15 * max(prev["size"] or 1, c["size"] or 1)):
                        text += " "
                text += c["c"]
                prev = c
            text = unicodedata.normalize("NFC", text)
            box = (min(c["box"][0] for c in ink), m["top"], max(c["box"][2] for c in ink), m["bot"])
            small = sum(1 for c in ink if c["size"] and c["size"] < 0.7 * median)
            pua = sum(1 for c in ink if 0xE000 <= ord(c["c"]) <= 0xF8FF or c["c"] == "�")
            uncertain = []
            if small and small < len(ink):
                uncertain.append("mixed font sizes (superscripts, subscripts or stacked fractions)")
            if pua:
                uncertain.append(f"{pua} character(s) with no readable meaning (symbol font)")
            kind = "rotated" if m["rotated"] else "line"
            self.ledger.add_block(kind, text, f"p{p}.l{k}", page=p, col=m["col"], box=[round(v, 2) for v in box],
                                        size=round(max(c["size"] for c in ink), 2), **({"uncertain": uncertain} if uncertain else {}))
            self.elements_seen += 1
        if any(b.get("page") == p and b["kind"] == "line" for b in self.ledger.blocks):
            self.text_pages.add(p)
        self._figure_units(p)

    def _figure_units(self, p: int) -> None:
        """Figures on a text page, found from the pixels: render the page, blank out every text line, drop long
        rules and frames, and keep the bands of ink that remain. Works however a figure is drawn (vector paths,
        embedded images, icon fonts)."""
        import numpy as np
        w, h = self.size[p]
        im = self.render(p)
        sx, sy = im.width / w, im.height / h
        dark = np.asarray(im.convert("L"), dtype=np.uint8) < 200
        for blk in self.blocks_on(p):
            if blk["kind"] in ("line", "rotated"):
                x0, y0, x1, y1 = blk["box"]
                if blk["kind"] == "rotated":
                    continue   # watermarks are faint and diagonal: their pixels are left as they are
                dark[max(0, int(y0 * sy) - 2):int(y1 * sy) + 3, max(0, int(x0 * sx) - 2):int(x1 * sx) + 3] = False
        hp, wp = dark.shape
        dark[:, dark.sum(axis=0) > 0.25 * hp] = False      # page-long vertical rules and frame sides
        dark[dark.sum(axis=1) > 0.6 * wp, :] = False       # full-width horizontal rules
        self._ink_bands(p, dark, sx, sy, kind="graphic", min_ink=int(0.00025 * hp * wp))

    def _read_image_page(self, p: int) -> None:
        im = self.images[p - 1]
        self.size[p] = (float(im.width), float(im.height))
        self._render_cache[p] = im
        self._bands(p, im, scale=1.0)

    def _bands(self, p: int, im: Image.Image, scale: float) -> None:
        """Horizontal bands of ink (pages without text). Pure pixel arithmetic, no recognition."""
        import numpy as np
        dark = np.asarray(im.convert("L"), dtype=np.uint8) < 160
        self._ink_bands(p, dark, scale, scale, kind="band", min_ink=int(0.00015 * dark.shape[0] * dark.shape[1]))

    def _ink_bands(self, p: int, dark, sx: float, sy: float, kind: str, min_ink: int) -> None:
        import numpy as np
        hpx, wpx = dark.shape
        split = self.columns if isinstance(self.columns, float) else 0.5
        cols = [(0, wpx)] if self.columns == 1 else [(0, int(wpx * split)), (int(wpx * split), wpx)]
        k = sum(1 for b in self.blocks_on(p) if b["kind"] in ("graphic", "band", "speck"))
        for ci, (cx0, cx1) in enumerate(cols):
            sub = dark[:, cx0:cx1]
            rows = sub.sum(axis=1) > 0
            gap = max(3, int(0.004 * hpx))   # a blank strip this tall separates two units (about half a text line)
            runs, start, blank = [], None, 0
            for y, ink in enumerate(list(rows) + [False] * (gap + 1)):
                if ink:
                    if start is None:
                        start = y
                    blank = 0
                elif start is not None:
                    blank += 1
                    if blank > gap:
                        runs.append((start, y - blank + 1))
                        start, blank = None, 0
            for y0, y1 in runs:
                xs = np.where(sub[y0:y1].any(axis=0))[0]
                if not len(xs):
                    continue
                x0, x1 = cx0 + int(xs[0]), cx0 + int(xs[-1]) + 1
                ink = int(sub[y0:y1].sum())
                k += 1
                unit = kind if ink >= min_ink and (y1 - y0) >= max(3, 0.004 * hpx) else "speck"
                self.ledger.add_block(unit, "", f"p{p}.{'g' if kind == 'graphic' else 'u'}{k}", page=p, col=ci,
                                      box=[round(x0 / sx, 2), round(y0 / sy, 2), round(x1 / sx, 2), round(y1 / sy, 2)], ink=ink)
                self.elements_seen += 1

    def bands_for_pdf_page(self, p: int) -> None:
        """A PDF page with no text layer (a scan): read it as ink bands from its rendering."""
        w, h = self.size[p]
        im = self.render(p)
        self._bands(p, im, scale=im.width / w)

    # ---------------------------------------------------------------- pixels
    def render(self, p: int) -> Image.Image:
        if p not in self._render_cache:
            if self.pdf is None:
                self._render_cache[p] = self.images[p - 1]
            else:
                self._render_cache[p] = self.pdf[p - 1].render(scale=self.dpi / 72, may_draw_forms=True).to_pil().convert("RGB")
        return self._render_cache[p]

    def crop_png(self, p: int, box) -> tuple[bytes, list[int]]:
        """PNG bytes of a page region (box in page units), and the pixel box used."""
        im = self.render(p)
        w, h = self.size[p]
        sx, sy = im.width / w, im.height / h
        px = [max(0, int(box[0] * sx)), max(0, int(box[1] * sy)), min(im.width, int(round(box[2] * sx + 0.5))), min(im.height, int(round(box[3] * sy + 0.5)))]
        if px[2] - px[0] < 2 or px[3] - px[1] < 2:
            raise StageFail(f"region on page {p} is empty", locator=f"p{p}", check="S3.crop")
        out = io.BytesIO()
        im.crop(px).save(out, format="PNG", optimize=False, compress_level=6)
        return out.getvalue(), px

    def blocks_on(self, p: int) -> list[dict]:
        return [b for b in self.ledger.blocks if b.get("page") == p]


def parse_range(spec: str | None, total: int) -> list[int]:
    if not spec:
        return list(range(1, total + 1))
    pages = []
    for part in str(spec).split(","):
        part = part.strip()
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+|end)", part)
        if m:
            a, b = int(m.group(1)), total if m.group(2) == "end" else int(m.group(2))
        elif part.isdigit():
            a = b = int(part)
        else:
            raise StageFail(f"page range {spec!r} is not like '3-40' or '1,4,7-9'", check="S0.pages")
        if a < 1 or b > total or a > b:
            raise StageFail(f"page range {part!r} is outside 1-{total}", check="S0.pages")
        pages.extend(range(a, b + 1))
    return sorted(set(pages))
