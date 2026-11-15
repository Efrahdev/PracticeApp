#!/usr/bin/env python3
"""Deterministic PDF -> Practice App question pack.

No AI anywhere. The PDF's own text layer supplies the words; anything that is not
plain running text (figures, stacked fractions, tables, picture options) is cut
out of the rendered page as an image, so it is reproduced exactly as printed.

  python3 pdfpack.py dump  <pdf> <page>                 # show what the engine sees on one page
  python3 pdfpack.py build <profile.json> <pdf> <out>   # build one pack (+ zip, + review report) per paper

A profile describes one book layout (see profiles/*.json).
"""
from __future__ import annotations

import hashlib
import html
import io
import json
import os
import re
import sys
import zipfile
from dataclasses import dataclass, field

import pymupdf
from PIL import Image, ImageChops

ZOOM = 3.0  # crop resolution: 216 dpi


# --------------------------------------------------------------------------- page atoms

@dataclass
class Line:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    chars: list  # (ch, x0, x1, bold, italic, sup, font)
    size: float
    bold: bool
    font: str
    piece: int = 0

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def h(self):
        return self.y1 - self.y0


@dataclass
class Box:
    x0: float
    y0: float
    x1: float
    y1: float
    kind: str = "draw"  # draw | img
    fill: bool = False

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2


def inter(a, b, pad=0.0):
    return a.x0 - pad < b.x1 and b.x0 - pad < a.x1 and a.y0 - pad < b.y1 and b.y0 - pad < a.y1


def contains(a, b, pad=1.0):
    return a.x0 - pad <= b.x0 and a.y0 - pad <= b.y0 and a.x1 + pad >= b.x1 and a.y1 + pad >= b.y1


def is_white(c):
    return c is not None and all(v >= 0.985 for v in c)


class Doc:
    def __init__(self, path, prof):
        self.doc = pymupdf.open(path)
        self.prof = prof
        self._pages = {}
        if prof.get("strip_stamp_text"):
            # A personal stamp (buyer's name across the page) is a tiny extra content stream of rotated text.
            # Blank its text in memory only; the file on disk is never changed.
            seen = set()
            for p in self.doc:
                for x in p.get_contents():
                    if x in seen:
                        continue
                    seen.add(x)
                    st = self.doc.xref_stream(x) or b""
                    if len(st) < 4000 and b"BT" in st and re.search(rb"-?[\d.]+ -?0?\.\d+ -?0?\.\d+ -?[\d.]+ -?[\d.]+ -?[\d.]+ cm", st):
                        self.doc.update_stream(x, re.sub(rb"BT.*?ET", b"", st, flags=re.S))
        # Fonts that draw a different glyph from the character they store.
        sym = {0x2b: "+", 0x2d: "−", 0x3d: "=", 0x5c: "∴", 0xae: "→", 0xb4: "×", 0xb8: "÷", 0xb0: "°", 0xb1: "±", 0xa3: "≤", 0xb3: "≥", 0xb9: "≠",
               0xbb: "≈", 0x3c: "<", 0x3e: ">", 0x28: "(", 0x29: ")", 0x20: " ", 0xd0: "∠", 0x44: "Δ", 0x70: "π", 0xd6: "√", 0xb7: "•", 0xde: "⇒", 0x2f: "/", 0x25: "%", 0x2c: ","}
        self.fontmap = {"Rupee": {"`": "₹"}, "Symbol": {chr(0xF000 + k): v for k, v in sym.items()}}
        self.fontmap.update(prof.get("font_charmap", {}))

    def page(self, pno):  # 1-based
        if pno not in self._pages:
            self._pages[pno] = self._load(pno)
        return self._pages[pno]

    def _load(self, pno):
        p = self.doc[pno - 1]
        lines, boxes = [], []
        d = p.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_LIGATURES | pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_IMAGES)
        for b in d["blocks"]:
            if b["type"] == 1:
                x0, y0, x1, y1 = b["bbox"]
                boxes.append(Box(x0, y0, x1, y1, "img"))
                continue
            for l in b["lines"]:
                if abs(l["dir"][0] - 1) > 0.02 or abs(l["dir"][1]) > 0.02:
                    continue  # rotated text = watermark
                chars = []
                for s in l["spans"]:
                    f = s["font"]
                    bold = bool(s["flags"] & 16) or bool(re.search(r"Bold|Black|Heavy|Semibold", f, re.I))
                    ital = bool(s["flags"] & 2) or bool(re.search(r"Italic|Oblique", f, re.I))
                    sup = bool(s["flags"] & 1)
                    cmap = next((m for k, m in self.fontmap.items() if k.lower() in f.lower()), None)
                    for c in s["chars"]:
                        ch = c["c"]
                        if cmap:
                            ch = cmap.get(ch, ch)
                        chars.append((ch, c["bbox"][0], c["bbox"][2], bold, ital, sup, f, s["size"]))
                text = "".join(c[0] for c in chars)
                if not text.strip():
                    continue
                vis = [c for c in chars if c[0].strip()]
                x0, x1 = vis[0][1], vis[-1][2]
                sizes = sorted(c[7] for c in vis)
                nb = sum(1 for c in vis if c[3])
                lines.append(Line(x0, l["bbox"][1], x1, l["bbox"][3], text, chars, sizes[len(sizes) // 2], nb * 2 > len(vis), vis[0][6]))
        page_area = p.rect.width * p.rect.height
        try:
            drs = p.get_drawings()
        except Exception:
            drs = []
        panels, paths = [], []
        pw, ph = p.rect.width, p.rect.height
        for g in drs:
            r = g["rect"]
            if r.is_infinite or (r.width * r.height) > 0.6 * page_area:
                continue
            fill, col = g.get("fill"), g.get("color")
            if col is None and (fill is None or is_white(fill)):
                continue
            if g.get("fill_opacity", 1) == 0 and col is None:
                continue
            filled = fill is not None and not is_white(fill)
            if filled:
                paths.append(Box(r.x0, r.y0, r.x1, r.y1, "path", True))
            if filled and r.width > 0.38 * pw and r.height > 6:
                # a tinted panel behind running text (passage box, instruction strip) is furniture, not a figure
                inside = [l for l in lines if r.x0 - 1.5 <= l.cx <= r.x1 + 1.5 and r.y0 - 1.5 <= l.cy <= r.y1 + 1.5]
                widest = max((sum(m.x1 - m.x0 for m in inside if abs(m.cy - l.cy) < 3) for l in inside), default=0)
                if inside and widest >= 0.6 * r.width:
                    panels.append(Box(r.x0, r.y0, r.x1, r.y1, "panel", True))
                    continue
            hw = (g.get("width") or 0) / 2 if col is not None else 0
            subs = []
            for it in g.get("items") or []:
                k = it[0]
                if k == "l":
                    pts = [it[1], it[2]]
                elif k == "c":
                    pts = [it[1], it[2], it[3], it[4]]
                elif k == "re":
                    pts = [it[1].tl, it[1].br]
                elif k == "qu":
                    pts = [it[1].ul, it[1].ur, it[1].ll, it[1].lr]
                else:
                    continue
                xs, ys = [q.x for q in pts], [q.y for q in pts]
                subs.append((min(xs), min(ys), max(xs), max(ys)))
            if len(subs) < 2 or (r.width < 14 and r.height < 14):
                subs = [(r.x0, r.y0, r.x1, r.y1)]
            for x0, y0, x1, y1 in subs:
                x0, y0, x1, y1 = x0 - hw, y0 - hw, x1 + hw, y1 + hw
                if x1 - x0 < 0.6:
                    x0, x1 = x0 - 0.4, x1 + 0.4
                if y1 - y0 < 0.6:
                    y0, y1 = y0 - 0.4, y1 + 0.4
                if x1 < 0 or y1 < 0 or x0 > pw or y0 > ph:
                    continue
                boxes.append(Box(x0, y0, x1, y1, "draw", fill is not None))
        return {"panels": panels, "paths": paths, "lines": lines, "boxes": boxes, "w": p.rect.width, "h": p.rect.height}

    def render(self, pno, rect):
        p = self.doc[pno - 1]
        clip = pymupdf.Rect(*rect) & p.rect
        if clip.is_empty or clip.width < 1 or clip.height < 1:
            return None
        pm = p.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip, alpha=False)
        return Image.open(io.BytesIO(pm.tobytes("png"))).convert("RGB")


def trim(im, pad=6, thr=22):
    if im is None:
        return None
    bg = Image.new("RGB", im.size, (255, 255, 255))
    diff = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > thr else 0)
    bb = diff.getbbox()
    if not bb:
        return None
    return im.crop((max(0, bb[0] - pad), max(0, bb[1] - pad), min(im.width, bb[2] + pad), min(im.height, bb[3] + pad)))


def stack(ims, gap=10):
    ims = [i for i in ims if i is not None]
    if not ims:
        return None
    if len(ims) == 1:
        return ims[0]
    w = max(i.width for i in ims)
    out = Image.new("RGB", (w, sum(i.height for i in ims) + gap * (len(ims) - 1)), (255, 255, 255))
    y = 0
    for i in ims:
        out.paste(i, (0, y))
        y += i.height + gap
    return out


# --------------------------------------------------------------------------- regions

@dataclass
class Piece:
    pno: int
    x0: float
    y0: float
    x1: float
    y1: float
    voff: float = 0.0


class Region:
    """One or more page rectangles stitched into a single virtual column.
    Virtual coordinates: vx = x - piece.x0, vy = y - piece.y0 + piece.voff."""

    def __init__(self, doc: Doc, pieces: list[Piece], ignore=()):
        self.doc = doc
        self.pieces = pieces
        self.lines: list[Line] = []
        self.boxes: list[Box] = []
        off = 0.0
        for i, pc in enumerate(pieces):
            pc.voff = off
            pg = doc.page(pc.pno)
            for l in pg["lines"]:
                if pc.x0 - 1 <= l.cx <= pc.x1 + 1 and pc.y0 - 0.5 <= l.cy < pc.y1 - 0.5 and not any(r.search(norm(l.text)) for r in ignore):
                    self.lines.append(Line(l.x0 - pc.x0, l.y0 - pc.y0 + off, l.x1 - pc.x0, l.y1 - pc.y0 + off, l.text,
                                           [(c[0], c[1] - pc.x0, c[2] - pc.x0) + c[3:] for c in l.chars], l.size, l.bold, l.font, i))
            for b in pg["boxes"]:
                if b.x1 <= pc.x0 or b.x0 >= pc.x1 or b.cy < pc.y0 - 0.5 or b.cy >= pc.y1:
                    continue
                self.boxes.append(Box(max(b.x0, pc.x0) - pc.x0, max(b.y0, pc.y0) - pc.y0 + off, min(b.x1, pc.x1) - pc.x0,
                                      min(b.y1, pc.y1) - pc.y0 + off, b.kind, b.fill))
            off += pc.y1 - pc.y0 + 4
        self.vh = off
        self.w = max(pc.x1 - pc.x0 for pc in pieces) if pieces else 0

    def crop(self, x0, y0, x1, y1, pad=2.5):
        """Virtual rectangle -> trimmed image (stitched if it spans pieces)."""
        ims = []
        for pc in self.pieces:
            a, b = pc.voff, pc.voff + (pc.y1 - pc.y0)
            ya, yb = max(y0 - pad, a), min(y1 + pad, b)
            if yb - ya < 1:
                continue
            ims.append(trim(self.doc.render(pc.pno, (max(pc.x0, pc.x0 + x0 - pad), pc.y0 + ya - a, min(pc.x1, pc.x0 + x1 + pad), pc.y0 + yb - a))))
        return stack(ims)

    def snapshot(self):
        return stack([trim(self.doc.render(pc.pno, (pc.x0, pc.y0, pc.x1, pc.y1))) for pc in self.pieces])


# --------------------------------------------------------------------------- text -> markdown

MD_SPECIAL = re.compile(r"([\\`*_{}\[\]<>#|$~])")


def esc(t):
    return MD_SPECIAL.sub(r"\\\1", t)


def line_md(l: Line, start=0, styles=True, base_bold=False, base_ital=False):
    """Characters of a line -> markdown, keeping superscripts and (non-dominant) bold / italic."""
    out, run, cur = [], "", (False, False, False)

    def flush():
        nonlocal run
        if not run:
            return
        t = esc(run)
        b, i, s = cur
        lead = t[: len(t) - len(t.lstrip())]
        tail = t[len(t.rstrip()):]
        core = t.strip()
        if core:
            if s:
                core = f"<sup>{core}</sup>"
            if styles and b and i:
                core = f"***{core}***"
            elif styles and b:
                core = f"**{core}**"
            elif styles and i:
                core = f"*{core}*"
        out.append(lead + core + tail)
        run = ""

    for c in l.chars[start:]:
        ch = " " if c[0] in "\t " else c[0]
        st = (c[3] and not base_bold, c[4] and not base_ital, c[5])
        if not ch.strip():
            st = cur
        if st != cur:
            flush()
            cur = st
        run += ch
    flush()
    return re.sub(r"[ ]{2,}", " ", "".join(out)).strip()


def rows_of(lines):
    rows = []
    for l in sorted(lines, key=lambda l: (l.cy, l.x0)):
        for r in rows:
            a = r[0]
            ov = min(a.y1, l.y1) - max(a.y0, l.y0)
            if ov > 0.5 * min(a.h, l.h):
                r.append(l)
                break
        else:
            rows.append([l])
    for r in rows:
        r.sort(key=lambda l: l.x0)
    rows.sort(key=lambda r: min(l.y0 for l in r))
    return rows


BAD_CH = re.compile("[-�\u0000-\u0008\u000b-\u001f]")


def text_trouble(lines, prof):
    """Why this text cannot be trusted as plain running text (None = fine)."""
    if not lines:
        return None
    sus = prof.get("picture_fonts", ["Wingding", "Webding", "Dingbat", "MT-Extra", "MTExtra"])
    for l in lines:
        if BAD_CH.search(l.text):
            return "unmapped characters"
        for c in l.chars:
            if c[0].strip() and any(s.lower() in c[6].lower() for s in sus):
                return f"symbol font {c[6]}"
    hs = sorted(l.h for l in lines)
    body = hs[len(hs) // 2]
    for r in rows_of(lines):
        y0s, y1s = [l.y0 for l in r], [l.y1 for l in r]
        if max(y0s) - min(y0s) > 2.6 or max(y1s) - min(y1s) > 2.6:
            return "stacked text (fraction or sub/superscript layout)"
        if any(l.h > 1.45 * body + 1 for l in r):
            return "tall line (fraction)"
    rs = rows_of(lines)
    for a, b in zip(rs, rs[1:]):
        if min(l.y0 for l in b) < max(l.y1 for l in a) - 0.45 * body:
            return "overlapping rows"
    return None


LIST_START = re.compile(r"^(\(?[ivxIVX]{1,4}\)|\(?[a-hA-HP-Sp-s1-9]\)|[•●▪■–-]\s|\d{1,2}\.\s|Statement|Assertion|Reason|Conclusion|Column|[A-Z][A-Za-z.]{1,14}\s?:\s)")


def paragraphs(lines, base_bold, base_ital):
    """Lines -> list of (y0, markdown paragraph, plain)."""
    rs = rows_of(lines)
    if not rs:
        return []
    hs = sorted(l.h for l in lines)
    body = hs[len(hs) // 2]
    paras, cur, prev = [], [], None
    left = min(l.x0 for l in lines)
    right = max(l.x1 for l in lines)
    for r in rs:
        md = " ".join(x for x in (line_md(l, 0, True, base_bold, base_ital) for l in r) if x)
        plain = re.sub(r"\s+", " ", " ".join(l.text for l in r)).strip()
        y0, y1, x0 = min(l.y0 for l in r), max(l.y1 for l in r), r[0].x0
        new = prev is None or (y0 - prev[1]) > 0.75 * body or abs(x0 - prev[2]) > 14 and x0 > prev[2] or LIST_START.match(plain) or len(r) > 2
        if prev is not None and (len(prev[3]) > 2 or prev[3][-1].x1 < right - 0.14 * (right - left)):
            new = True
        if new and cur:
            paras.append(cur)
            cur = []
        cur.append((y0, md, plain))
        prev = (y0, y1, x0, r)
    if cur:
        paras.append(cur)
    out = []
    for p in paras:
        md = " ".join(x[1] for x in p)
        md = re.sub(r"^(\d{1,3})([.)])(\s)", r"\1\\\2\3", md)  # not a markdown list
        md = re.sub(r"^([+\-])(\s)", r"\\\1\2", md)
        md = re.sub(r"^(=+|-{3,})$", r"\\\1", md)
        out.append((p[0][0], md, " ".join(x[2] for x in p)))
    return out


def _union_pass(boxes, gap):
    n = len(boxes)
    par = list(range(n))

    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i

    cell, grid = 32.0, {}
    for i, b in enumerate(boxes):
        gx0, gx1 = int((b.x0 - gap) // cell), int((b.x1 + gap) // cell)
        gy0, gy1 = int((b.y0 - gap) // cell), int((b.y1 + gap) // cell)
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                grid.setdefault((gx, gy), []).append(i)
    for ids in grid.values():
        if len(ids) < 2:
            continue
        ids.sort(key=lambda i: boxes[i].x0)
        for a in range(len(ids)):
            A = boxes[ids[a]]
            for c in range(a + 1, len(ids)):
                B = boxes[ids[c]]
                if B.x0 - gap >= A.x1:
                    break
                if A.y0 - gap < B.y1 and B.y0 - gap < A.y1:
                    i, j = find(ids[a]), find(ids[c])
                    if i != j:
                        par[j] = i
    groups = {}
    for i, b in enumerate(boxes):
        r = find(i)
        g = groups.get(r)
        if g is None:
            groups[r] = Box(b.x0, b.y0, b.x1, b.y1, b.kind)
        else:
            g.x0, g.y0, g.x1, g.y1 = min(g.x0, b.x0), min(g.y0, b.y0), max(g.x1, b.x1), max(g.y1, b.y1)
    return list(groups.values())


def cluster(boxes, gap=4.0):
    """Connected fragments first, then anything inside / against a figure's bounding box joins it."""
    cl = _union_pass(list(boxes), gap)
    while True:
        nxt = _union_pass(cl, min(gap, 1.0))
        if len(nxt) == len(cl):
            return nxt
        cl = nxt


def clean_boxes(boxes, lines, width, gap=2.5):
    """Group drawing fragments into figures; drop full-width separator rules."""
    cl = cluster(boxes, gap)
    return [c for c in cl if not (c.h < 3.2 and c.w > 0.5 * width)]


def alt_text(lines, limit=400):
    t = re.sub(r"\s+", " ", " ".join(" ".join(l.text for l in r) for r in rows_of(lines))).strip()
    t = re.sub(r"[\[\]()!\\`*_<>|$#\x00-\x1f\ue000-\uf8ff\ufffd]", " ", t)
    return re.sub(r"\s+", " ", t).strip()[:limit]


# --------------------------------------------------------------------------- content builder

class Pack:
    def __init__(self, out_dir):
        self.dir = out_dir
        os.makedirs(os.path.join(out_dir, "images"), exist_ok=True)
        self.assets = {}
        self.by_sha = {}

    def drop(self, prefix):
        for n in [n for n in self.assets if n.startswith(prefix)]:
            try:
                os.remove(os.path.join(self.dir, self.assets[n]["file"]))
            except OSError:
                pass
            del self.assets[n]
        self.by_sha = {k: v for k, v in self.by_sha.items() if v in self.assets}

    def add(self, im, name):
        buf = io.BytesIO()
        if len(im.getcolors(4096) or []) and im.width * im.height > 0:
            im.save(buf, "PNG", optimize=True)
        else:
            im.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        sha = hashlib.sha256(data).hexdigest()
        if sha in self.by_sha:
            return self.by_sha[sha]
        fn = f"images/{name}.png"
        with open(os.path.join(self.dir, fn), "wb") as f:
            f.write(data)
        self.assets[name] = {"file": fn}
        self.by_sha[sha] = name
        return name


def build_content(reg: Region, lines, clusters, margin, pack: Pack, name, prof, flags, whole=False, label="figure"):
    """Lines + figure clusters of one stem / option / solution -> (markdown, plain text, kind)."""
    lines = [l for l in lines if l.text.strip()]
    if not lines and not clusters:
        return "", "", "empty"
    figs = cluster([Box(c.x0, c.y0, c.x1, c.y1) for c in clusters], 4)
    main, free = [], []
    for r in rows_of(lines):
        prev = None
        for l in r:
            ok = margin is None or abs(l.x0 - margin) < 3.5 or (prev is not None and l.x0 - prev.x1 < 25 and abs(l.size - prev.size) < 1.2)
            (main if ok else free).append(l)
            prev = l if ok else None
    # captions and labels join their figure
    changed = True
    while changed and figs:
        changed = False
        for l in list(free):
            for f in figs:
                near = inter(f, l, 3) or (l.x0 < f.x1 + 3 and f.x0 - 3 < l.x1 and (0 <= l.y0 - f.y1 < 14 or 0 <= f.y0 - l.y1 < 14))
                if near:
                    f.x0, f.y0, f.x1, f.y1 = min(f.x0, l.x0), min(f.y0, l.y0), max(f.x1, l.x1), max(f.y1, l.y1)
                    free.remove(l)
                    changed = True
                    break
        figs = cluster(figs, 2)
    # figures standing side by side are one figure
    merged = True
    while merged:
        merged = False
        for i in range(len(figs)):
            for j in range(i + 1, len(figs)):
                a, b = figs[i], figs[j]
                ov = min(a.y1, b.y1) - max(a.y0, b.y0)
                if ov > 0.3 * min(a.h, b.h) and ov > 2:
                    a.x0, a.y0, a.x1, a.y1 = min(a.x0, b.x0), min(a.y0, b.y0), max(a.x1, b.x1), max(a.y1, b.y1)
                    del figs[j]
                    merged = True
                    break
            if merged:
                break
        if merged:
            for l in list(free):
                for f in figs:
                    if contains(f, l, 2):
                        free.remove(l)
                        break
    text_lines = main + free
    inline = [f for f in figs if any(inter(f, l, -0.5) for l in main)]
    reason = "picture" if (whole and figs) else ("picture inside the sentence" if inline else text_trouble(text_lines, prof))
    if reason:
        if whole:
            blk = [Box(l.x0, l.y0, l.x1, l.y1) for l in lines] + list(figs)
            rest = []
        else:
            blk = [Box(l.x0, l.y0, l.x1, l.y1) for l in text_lines] + inline
            rest = [f for f in figs if f not in inline]
            if not blk:
                blk, rest = rest, []
            grew = True
            while grew:  # anything the text block overlaps is cropped with it
                grew = False
                u = Box(min(b.x0 for b in blk), min(b.y0 for b in blk), max(b.x1 for b in blk), max(b.y1 for b in blk))
                for f in list(rest):
                    if inter(u, f, 0):
                        blk.append(f)
                        rest.remove(f)
                        grew = True
        u = Box(min(b.x0 for b in blk), min(b.y0 for b in blk), max(b.x1 for b in blk), max(b.y1 for b in blk))
        im = reg.snapshot() if whole else reg.crop(u.x0, u.y0, u.x1, u.y1)
        if im is None:
            flags.append(f"{name}: nothing to crop")
            return "", "", "empty"
        alt = alt_text(text_lines if not whole else lines) or label
        parts = [(u.y0, f"![{alt}](asset:{pack.add(im, name)})")]
        for k, f in enumerate(sorted(rest, key=lambda f: (f.y0, f.x0))):
            fi = reg.crop(f.x0, f.y0, f.x1, f.y1)
            if fi is not None:
                parts.append((max(f.y0, u.y0 + 0.01), f"![{label}](asset:{pack.add(fi, f'{name}-fig{k + 1}')})"))
        parts.sort(key=lambda t: t[0])
        return "\n\n".join(p[1] for p in parts), alt_text(lines), "image"
    nb = sum(len(l.text.strip()) for l in text_lines if l.bold)
    nt = sum(len(l.text.strip()) for l in text_lines) or 1
    base_bold = nb * 2 > nt
    paras = paragraphs(text_lines, base_bold, False)
    items = [(y, md) for y, md, _ in paras]
    para_rng = []
    rs = rows_of(text_lines)
    for k, f in enumerate(sorted(figs, key=lambda f: (f.y0, f.x0))):
        im = reg.crop(f.x0, f.y0, f.x1, f.y1)
        if im is None:
            continue
        a = pack.add(im, f"{name}-fig{k + 1}" if len(figs) > 1 else f"{name}-fig")
        # a figure beside a paragraph goes after that paragraph
        y = f.y0
        for i, (py, _md, _pl) in enumerate(paras):
            nxt = paras[i + 1][0] if i + 1 < len(paras) else 1e9
            if py <= f.y0 + 3 < nxt or (f.y0 < py < f.y1 and i == 0):
                y = max(y, nxt - 0.01) if nxt < 1e9 and nxt < f.y1 and False else max(f.y0, py + 0.01)
                # keep the whole paragraph together: place after its last row
                last = max((min(l.y0 for l in r) for r in rs if py <= min(l.y0 for l in r) < nxt), default=py)
                y = max(y, last + 0.01) if last < f.y1 else y
                break
        items.append((y, f"![{label}](asset:{a})"))
    items.sort(key=lambda t: t[0])
    md = "\n\n".join(t[1] for t in items if t[1])
    plain = " ".join(p[2] for p in paras)
    return md, plain, ("mixed" if figs else "text")


# --------------------------------------------------------------------------- segmentation

@dataclass
class Marker:
    kind: str  # q | section | group | stop | paper
    pno: int
    col: int
    y: float
    line: Line = None
    m: object = None
    top: float = 0.0


def norm(t):
    return re.sub(r"\s+", " ", t).strip()


def page_slots(doc, pno, cfg):
    """Reading-order slots of a page: zones (split by full-width paper headers) x columns."""
    cols, band = cfg["columns"], cfg["band"]
    pg = doc.page(pno)
    zones = [[band[0], band[1], None]]
    if cfg.get("paper_regex"):
        prx = re.compile(cfg["paper_regex"])
        for l in sorted(pg["lines"], key=lambda l: l.y0):
            m = prx.search(norm(l.text))
            if not m or not (band[0] <= l.cy <= band[1]) or (cfg.get("paper_size") and abs(l.size - cfg["paper_size"]) > 0.8):
                continue
            top, bot = l.y0 - 4, l.y1 + 4
            for b in pg["paths"]:
                if inter(b, l, 1) and b.h < 80 and b.w > 0.25 * pg["w"]:
                    top, bot = min(top, b.y0 - 1), max(bot, b.y1 + 1)
            z = zones[-1]
            if top <= z[0]:
                continue
            zones[-1] = [z[0], top, z[2]]
            zones.append([bot, band[1], (l, m)])
    out = []
    for z in zones:
        for ci, c in enumerate(cols):
            out.append({"pno": pno, "col": ci, "x0": c[0], "x1": c[1], "y0": z[0], "y1": z[1], "paper": z[2] if ci == 0 else None})
    return out


def find_markers(doc: Doc, pages, cfg):
    """Walk pages / zones / columns in reading order and collect anchors."""
    a = cfg["anchor"]
    arx = re.compile(a["regex"])
    stops = [re.compile(s) for s in cfg.get("stop", [])]
    ign = [re.compile(s) for s in cfg.get("ignore", [])]
    secs = cfg.get("section")
    grx = re.compile(cfg["group_regex"], re.I) if cfg.get("group_regex") else None
    slots = [s for p in pages for s in page_slots(doc, p, cfg)]
    out = []
    for si, s in enumerate(slots):
        pg = doc.page(s["pno"])
        if s["paper"]:
            l, m = s["paper"]
            out.append(Marker("paper", s["pno"], si, s["y0"], l, m, s["y0"]))
        ls = sorted([l for l in pg["lines"] if s["x0"] - 1 <= l.cx <= s["x1"] + 1 and s["y0"] <= l.cy <= s["y1"]], key=lambda l: (l.cy, l.x0))
        for l in ls:
            t = l.text.strip()
            tn = norm(t)
            if any(r.search(tn) for r in ign):
                continue
            top = l.y0
            for b in pg["paths"]:
                if contains(b, l, 2) and b.h < 60:
                    top = min(top, b.y0)
            if any(r.search(tn) for r in stops):
                out.append(Marker("stop", s["pno"], si, l.y0, l, None, top))
                break
            if secs and re.search(secs["regex"], tn) and (not secs.get("size") or abs(l.size - secs["size"]) < 0.7) and (not secs.get("font") or secs["font"].lower() in l.font.lower()):
                out.append(Marker("section", s["pno"], si, l.y0, l, None, top))
                continue
            in_panel = [p for p in pg["panels"] if contains(p, l, 2)]
            first_in_panel = bool(in_panel) and not any(o is not l and contains(in_panel[0], o, 2) and o.cy < l.y0 for o in ls)
            if grx and (m := grx.search(tn)) and (not cfg.get("group_panel_only") or first_in_panel) and (not cfg.get("group_x") or cfg["group_x"][0] <= l.x0 - s["x0"] <= cfg["group_x"][1]):
                out.append(Marker("group", s["pno"], si, l.y0, l, m, top))
                continue
            m = arx.match(t)
            if m and a["x"][0] <= l.x0 - s["x0"] <= a["x"][1] and (not a.get("bold") or l.bold) and (not a.get("size") or abs(l.size - a["size"]) < 0.8):
                colw = s["x1"] - s["x0"]
                floor = max([p.y1 for p in ls if p.y1 <= l.y0 + 1 and p.x0 - s["x0"] < 60 and p is not l] + [s["y0"]]) - 0.5
                if "clusters" not in pg:
                    pg["clusters"] = cluster(pg["boxes"], 3)
                for b in pg["clusters"]:
                    if s["x0"] <= b.x0 < s["x1"] and b.x0 >= l.x0 + 6 and b.y0 < top and b.y1 > l.cy and l.y0 - b.y0 < 160 and b.w < 0.8 * colw:
                        top = min(top, max(b.y0, floor))
                out.append(Marker("q", s["pno"], si, l.y0, l, m, top))
    return slots, out


def segments(slots, markers, extend_last=False):
    """Marker i owns everything up to marker i+1 (possibly across columns / pages)."""
    ms = sorted(markers, key=lambda m: (m.col, m.y))
    segs = []
    for i, m in enumerate(ms):
        if m.kind == "stop":
            continue
        nxt = ms[i + 1] if i + 1 < len(ms) else None
        pieces = []
        e = nxt.col if nxt else (len(slots) - 1 if extend_last else m.col)
        for k in range(m.col, e + 1):
            s = slots[k]
            y0 = m.top - 0.5 if k == m.col else s["y0"]
            y1 = (nxt.top - 0.5) if (nxt and k == e) else s["y1"]
            if y1 - y0 > 2:
                pieces.append(Piece(s["pno"], s["x0"], y0, s["x1"], y1))
        segs.append((m, pieces))
    return segs


def numbered(segs, flags, what):
    """Keep only anchors that continue the 1, 2, 3 ... sequence; merge the rest into the previous segment."""
    out, expect = [], 1
    for m, pieces in segs:
        if m.kind != "q":
            out.append([m, pieces, None])
            if m.kind == "paper":
                expect = 1
            continue
        n = int(m.m.group(1))
        if n == expect:
            out.append([m, pieces, n])
            expect += 1
        elif out and out[-1][0].kind in ("q", "group"):
            out[-1][1].extend(pieces)  # a stray number inside the previous item
        else:
            flags.append(f"{what}: unexpected number {n} on page {m.pno} (expected {expect})")
            out.append([m, pieces, None])
    return out


# --------------------------------------------------------------------------- one question

def split_inline_labels(lines, want):
    """'A. Door   B. Fridge   C. Table D. Chair' printed as one line -> one line per option."""
    out = []
    for l in lines:
        t = l.text
        m0 = re.match(r"\s*\(?([A-E])[.)]", t)
        if not m0 or m0.group(1) not in want or len(t) != len(l.chars):
            out.append(l)
            continue
        cuts, nxt = [], want.index(m0.group(1)) + 1
        for m in re.finditer(r"(?<=\s)\(?([A-E])[.)](?=\s|$)", t):
            if nxt < len(want) and m.group(1) == want[nxt]:
                cuts.append(m.start())
                nxt += 1
        if not cuts:
            out.append(l)
            continue
        bounds = [0] + cuts + [len(t)]
        for a, b in zip(bounds, bounds[1:]):
            ch = l.chars[a:b]
            vis = [c for c in ch if c[0].strip()]
            if vis:
                out.append(Line(vis[0][1], l.y0, vis[-1][2], l.y1, "".join(c[0] for c in ch), ch, l.size, l.bold, l.font, l.piece))
    return out


def split_question(reg: Region, anchor_vline, cfg, pack, qname, prof, flags, group_md=None):
    orx = re.compile(cfg["option_regex"])
    lines = [l for l in reg.lines if l is not anchor_vline]
    # stem margin: first text to the right of the number, in its row
    cand = [l for l in lines if anchor_vline is None or l.x0 > anchor_vline.x1 - 1]
    margin = None
    if anchor_vline is not None:
        same = [l for l in cand if abs(l.cy - anchor_vline.cy) < anchor_vline.h]
        first = min(same, key=lambda l: l.x0) if same else (min(cand, key=lambda l: (l.y0, l.x0)) if cand else None)
        margin = first.x0 if first else None
    boxes = [b for b in reg.boxes if anchor_vline is None or not (b.x1 <= (margin or anchor_vline.x1) - 1.5)]
    clusters = clean_boxes(boxes, lines, reg.w)
    if anchor_vline is not None:
        clusters = [c for c in clusters if not (c.x1 <= (margin or 0) - 1)]

    want = cfg.get("option_labels", ["A", "B", "C", "D"])
    lines = split_inline_labels(lines, want)
    # option labels: last complete A, B, C, D run in reading order (rows of aligned labels, left to right)
    body = anchor_vline.size if anchor_vline else None
    loose = re.compile(r"^(%s)[.)]?(?:\s|$)" % "|".join(want))

    def ordered(rx):
        c = [(l, rx.match(l.text.strip())) for l in lines]
        c = [(l, m) for l, m in c if m and (body is None or abs(l.size - body) < 3)]
        lr = []
        for l, m in sorted(c, key=lambda t: t[0].cy):
            for r in lr:
                if abs(r[0][0].cy - l.cy) < 0.6 * l.h:
                    r.append((l, m))
                    break
            else:
                lr.append([(l, m)])
        return [(0, l, m) for r in lr for l, m in sorted(r, key=lambda t: t[0].x0)]

    def best(seq):
        labels = []
        for start in range(len(seq) - 1, -1, -1):
            if seq[start][2].group(1) != want[0]:
                continue
            got, k = [seq[start]], 1
            for t in seq[start + 1:]:
                if k < len(want) and t[2].group(1) == want[k]:
                    got.append(t)
                    k += 1
            if k >= len(want):
                return got
            if len(got) > len(labels):
                labels = got
        return labels

    labels = best(ordered(orx))
    if len(labels) < len(want):  # a label printed without its full stop / bracket
        alt = best(ordered(loose))
        if len(alt) > len(labels):
            labels = alt
            flags.append("an option label is misprinted in the source (read leniently)")
    opts = []
    if len(labels) >= 2:
        lrows = []  # label rows: labels whose centres line up
        for _ri, l, m in labels:
            for r in lrows:
                if abs(r[0][0].cy - l.cy) < 0.6 * l.h:
                    r.append((l, m))
                    break
            else:
                lrows.append([(l, m)])
        lrows.sort(key=lambda r: min(l.y0 for l, _ in r))
        lab_ids = {id(l) for _, l, _ in labels}
        others = [l for l in lines if id(l) not in lab_ids]
        cells = []
        for ri, row in enumerate(lrows):
            row.sort(key=lambda t: t[0].x0)
            for ci, (l, m) in enumerate(row):
                cell = {"l": l, "m": m, "row": ri, "x0": l.x0 - 2, "x1": row[ci + 1][0].x0 - 2 if ci + 1 < len(row) else 1e9, "figs": [], "caps": set()}
                # the option's own words on the label line: an unbroken run starting at the label
                edge = l.x1
                for o in sorted(others, key=lambda o: o.x0):
                    if cell["x0"] <= o.cx < cell["x1"] and o.x0 >= l.x0 and o.y0 < l.y1 + 6 and l.y0 - 6 < o.y1 and o.x0 - edge < 40:
                        edge = max(edge, o.x1)
                cell["edge"] = edge
                cells.append(cell)
        # which pictures are options: they start right after a label (or after that option's own content)
        owned, changed = set(), True
        while changed:
            changed = False
            for k, c in enumerate(clusters):
                if k in owned:
                    continue
                for cell in cells:
                    L = cell["l"]
                    if not (cell["x0"] <= c.cx < cell["x1"]):
                        continue
                    ok = False
                    if c.y0 < L.y1 + 2 and c.y1 > L.y0 - 2 and c.x1 > L.x0:
                        edge = cell["edge"]
                        for f in cell["figs"]:
                            if f.x1 <= c.x0 + 1:
                                edge = max(edge, f.x1)
                        nrows = sum(1 for r in lrows if c.y0 < max(q.y1 for q, _ in r) - 2 and c.y1 > min(q.y0 for q, _ in r) + 2)
                        ok = c.x0 - edge < (40 if nrows < 2 else 12)
                    if not ok and any(inter(f, c, 3) for f in cell["figs"]):
                        ok = True
                    if ok:
                        cell["figs"].append(c)
                        owned.add(k)
                        changed = True
                        break
        stem_figs = cluster([c for k, c in enumerate(clusters) if k not in owned], 6)
        # labels printed on / around an option's picture (measurements, letters) go with that option
        first_top = min(l.y0 for l, _ in lrows[0])
        for cell in cells:
            pics = list(cell["figs"])
            for l in others:
                if not (cell["x0"] <= l.cx < cell["x1"]) or any(id(l) in c2["caps"] for c2 in cells):
                    continue
                if margin is not None and abs(l.x0 - margin) < 3.5 and l.y1 <= first_top + 1:
                    continue  # the question's own sentence
                if any(inter(f, l, 6) for f in pics):
                    cell["caps"].add(id(l))
                    cell["figs"].append(Box(l.x0, l.y0, l.x1, l.y1))
        bands = []
        for ri, row in enumerate(lrows):
            b = [min(l.y0 for l, _ in row), max(l.y1 for l, _ in row)]
            for cell in cells:
                if cell["row"] == ri:
                    for f in cell["figs"]:
                        b[0], b[1] = min(b[0], f.y0), max(b[1], f.y1)
            labs_ = [l for l, _ in row]
            for l in others:  # numerators / denominators hanging above or below the label line
                if any(0 <= l.x0 - q.x1 < 45 or (q.x0 < l.x0 <= q.x1 + 1) for q in labs_) and l.y0 < b[1] and b[0] < l.y1 and (min(l.y1, b[1]) - max(l.y0, b[0])) > 0.25 * l.h and l.h < 40:
                    b[0], b[1] = min(b[0], l.y0), max(b[1], l.y1)
            bands.append(b)
        split_y = bands[0][0] - 0.3
        # captions inside stem figures that sit beside the options
        absorbed = set()
        for f in stem_figs:
            for l in others:
                if l.cy < split_y:
                    continue
                if l.x0 >= f.x0 - 3 and l.x1 <= f.x1 + 3 and (inter(f, l, 3) or 0 <= l.y0 - f.y1 < 14 or 0 <= f.y0 - l.y1 < 14):
                    absorbed.add(id(l))
        stem_lines = [l for l in others if l.cy < split_y or id(l) in absorbed]
        capped = set().union(*[c["caps"] for c in cells])
        stem_lines = [l for l in stem_lines if id(l) not in capped]
        opt_lines = [l for l in others if (l.cy >= split_y and id(l) not in absorbed) or id(l) in capped]
        opt_ids = {id(l) for l in opt_lines}
        placed = []  # (label, rect) of every option, to prove nothing overlaps
        for cell in cells:
            ll, m, bi = cell["l"], cell["m"], cell["row"]
            y_top = bands[bi][0] - 0.5
            y_bot = bands[bi + 1][0] - 0.5 if bi + 1 < len(bands) else reg.vh
            cl = [l for l in others if id(l) in cell["caps"] or (id(l) in opt_ids and y_top <= l.cy < y_bot and cell["x0"] <= l.cx < cell["x1"])]
            rest_start = m.end() + (len(ll.text) - len(ll.text.lstrip()))
            rest = [c for c in ll.chars[rest_start:] if c[0].strip()]
            if rest:
                cl.append(Line(rest[0][1], ll.y0, rest[-1][2], ll.y1, "".join(c[0] for c in ll.chars[rest_start:]), ll.chars[rest_start:], ll.size, ll.bold, ll.font, ll.piece))
            cf = cell["figs"]
            lab = m.group(1)
            kept = []
            for r in rows_of(cl):
                edge = None
                for l in r:
                    left = [f.x1 for f in cf if f.x1 <= l.x0 + 1 and f.y0 < l.y1 and l.y0 < f.y1]
                    e = max([edge if edge is not None else ll.x1] + left)
                    if l.x0 - e > 70 and id(l) not in cell["caps"]:
                        break
                    kept.append(l)
                    edge = l.x1
            cl = kept
            allb = [Box(l.x0, l.y0, l.x1, l.y1) for l in cl] + cf
            if allb:
                placed.append((lab, Box(min(b.x0 for b in allb), min(b.y0 for b in allb), max(b.x1 for b in allb), max(b.y1 for b in allb)), {id(l) for l in cl}, {id(c) for c in cf}))
            if (bool(cf) or text_trouble(cl, prof)) and allb:
                u = placed[-1][1]
                im = reg.crop(u.x0, u.y0, u.x1, u.y1)
                if im is None:
                    md, kind = "", "empty"
                else:
                    md, kind = f"![{alt_text(cl) or 'option ' + lab}](asset:{pack.add(im, f'{qname}-opt{lab}')})", "image"
            else:
                ps = paragraphs(cl, bool(cl) and all(l.bold for l in cl), False) if cl else []
                md, kind = "\n\n".join(p[1] for p in ps), ("text" if ps else "empty")
            if kind == "empty":
                flags.append(f"option {lab} is empty")
            opts.append({"label": lab, "text": md, "_kind": kind})
        # a cropped option must not contain anything that belongs elsewhere
        kinds = {o["label"]: o["_kind"] for o in opts}
        stem_ids = {id(l) for l in stem_lines}
        for lab, u, lids, cids in placed:
            if kinds.get(lab) != "image":
                continue
            if os.environ.get("PDFPACK_DEBUG") == qname:
                print("DBG", lab, [round(v) for v in (u.x0, u.y0, u.x1, u.y1)],
                      "text:", [(l.text.strip()[:12], round(l.x0), round(l.y0)) for l in lines if id(l) not in lids and id(l) not in lab_ids and inter(u, l, -1.5)],
                      "pics:", [[round(v) for v in (c.x0, c.y0, c.x1, c.y1)] for k, c in enumerate(clusters) if k in owned and id(c) not in cids and inter(u, c, -1.5)],
                      "stemfig:", [[round(v) for v in (f.x0, f.y0, f.x1, f.y1)] for f in stem_figs if inter(u, f, -1.5)])
            if any(id(l) not in lids and id(l) not in lab_ids and inter(u, l, -1.5) for l in lines):
                flags.append(f"option {lab} overlaps other text")
            if any(id(c) not in cids and inter(u, c, -1.5) for k, c in enumerate(clusters) if k in owned):
                flags.append(f"option {lab} overlaps another picture")
            if any(inter(u, f, -1.5) for f in stem_figs):
                flags.append(f"option {lab} overlaps the question's figure")
        used = set().union(*[p[2] for p in placed]) if placed else set()
        stray = [l for l in opt_lines if id(l) not in used]
        if stray:
            flags.append("text among the options that belongs to no option: " + alt_text(stray, 60))
        got = [o["label"] for o in opts]
        if sorted(got) != want[: len(got)] or len(got) < cfg.get("min_options", 4):
            flags.append(f"options found: {','.join(sorted(got)) or 'none'}")
        opts.sort(key=lambda o: o["label"])
    else:
        stem_lines, stem_figs = lines, clusters
        flags.append("no options found")
    stem_md, stem_plain, kind = build_content(reg, stem_lines, stem_figs, margin, pack, f"{qname}-stem", prof, flags)
    if not stem_md and not group_md:
        flags.append("stem is empty")
    return stem_md, stem_plain, kind, opts, margin, want


# --------------------------------------------------------------------------- report

def md_html(md):
    out = []
    for para in md.split("\n\n"):
        t = html.escape(para, quote=False)
        t = re.sub(r"!\[([^\]]*)\]\(asset:([^)]+)\)", lambda m: f'<img src="images/{m.group(2)}.png" alt="">', t)
        t = t.replace("&lt;sup&gt;", "<sup>").replace("&lt;/sup&gt;", "</sup>")
        t = re.sub(r"\*\*\*(.+?)\*\*\*", r"<b><i>\1</i></b>", t)
        t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
        t = re.sub(r"(?<![\\*])\*(?!\s)(.+?)(?<![\\\s])\*", r"<i>\1</i>", t)
        t = re.sub(r"\\([\\`*_{}\[\]<>#|$~.)+\-=])", r"\1", t)
        t = t.replace("\\&lt;", "&lt;").replace("\\&gt;", "&gt;")
        out.append(f"<p>{t}</p>")
    return "".join(out)


REPORT_CSS = """body{font:14px/1.45 system-ui,sans-serif;margin:16px;color:#1c2230}h1{font-size:18px}
.q{display:grid;grid-template-columns:1fr 1fr;gap:14px;border:1px solid #d5dae3;border-radius:8px;margin:10px 0;padding:10px;break-inside:avoid}
.q.flag{border-color:#d92d20;background:#fff6f5}.src img{max-width:100%;border:1px solid #eee}.out img{max-width:100%;max-height:260px;vertical-align:middle;zoom:.5}
.out .opt{display:flex;gap:8px;margin:3px 0;padding:3px 6px;border:1px solid #e3e7ef;border-radius:6px}.opt.ok{background:#e8f7ee;border-color:#3aa76d}
.hd{grid-column:1/3;font-weight:700}.nt{color:#175cd3;font-weight:500}.q.note{border-color:#84adff;background:#f5f8ff}.fl{color:#b42318;font-weight:600}.sol{margin-top:6px;padding:6px;background:#f5f7fb;border-radius:6px}p{margin:.25em 0}
.sum{padding:8px 12px;background:#f5f7fb;border-radius:8px}"""


def write_report(out_dir, title, qs, flags_all):
    h = [f"<!doctype html><meta charset=utf-8><title>{html.escape(title)}</title><style>{REPORT_CSS}</style><h1>{html.escape(title)}</h1>"]
    nflag = sum(1 for q in qs if q["_flags"])
    h.append(f'<div class="sum">{len(qs)} questions · {nflag} flagged · {sum(1 for q in qs if q.get("answer"))} with answers · {sum(1 for q in qs if q.get("solution"))} with solutions'
             + "".join(f'<div class="fl">{html.escape(f)}</div>' for f in flags_all) + "</div>")
    for q in qs:
        fl = "".join(f'<div class="fl">⚑ {html.escape(f)}</div>' for f in q["_flags"]) + "".join(f'<div class="nt">ⓘ {html.escape(f)}</div>' for f in q.get("_notes", []))
        opts = "".join(f'<div class="opt {"ok" if q.get("answer") == o["label"] else ""}"><b>{o["label"]}</b><div>{md_html(o["text"])}</div></div>' for o in q.get("options", []))
        sol = f'<div class="sol"><b>Answer {html.escape(str(q.get("answer")))}</b>{md_html(q["solution"]) if q.get("solution") else ""}</div>'
        h.append(f'<div class="q {"flag" if q["_flags"] else ("note" if q.get("_notes") else "")}" id="q{q["number"]}"><div class="hd">Q{q["number"]} · {html.escape(" > ".join(q.get("topics", [])))} · p{q["source"]["page"]}{fl}</div>'
                 f'<div class="src"><img src="snapshots/q{q["number"]}.png"></div><div class="out">{md_html(q["stem"])}{opts}{sol}</div></div>')
    with open(os.path.join(out_dir, "report.html"), "w") as f:
        f.write("".join(h))


# --------------------------------------------------------------------------- build

def title_case(s):
    s = re.sub(r"(?i)^section\s*[-–]?\s*[ivx\d]+\s*[:–-]\s*", "", s).strip()
    return " ".join(w.capitalize() if (w.isupper() or w.islower()) and w.lower() not in ("and", "of", "in") else w for w in s.split())


def parse_solutions(doc: Doc, prof):
    """Back-of-book answers / explanations -> {paper key: {number: (answer, Region, anchor line)}}."""
    cfg = prof.get("solutions")
    if not cfg:
        return {}, []
    flags = []
    pages = list(range(cfg["pages"][0], cfg["pages"][1] + 1))
    if cfg.get("mode") == "key_grid":
        # a bare answer-key table: "1. (A)  2. (D) ..." under one heading per paper
        out, key, k = {}, None, 0
        prx = re.compile(cfg["paper_regex"])
        end = re.compile(cfg["end_regex"]) if cfg.get("end_regex") else None
        for pno in pages:
            ls = sorted(doc.page(pno)["lines"], key=lambda l: (round(l.cy / 4), l.x0))
            toks = []
            for l in ls:
                t = norm(l.text.replace("\u00a0", " "))
                if end and end.search(t):
                    break
                if prx.search(t):
                    toks.append(("paper", None))
                    continue
                for m in re.finditer(r"(\d{1,3})\s*[.:]|\(([A-E])\)|(?<![A-Za-z])([A-E])(?![A-Za-z])", t):
                    toks.append(("n", int(m.group(1))) if m.group(1) else ("a", m.group(2) or m.group(3)))
            cur = None
            for kind, v in toks:
                if kind == "paper":
                    k += 1
                    key = f"#{k}"
                    out[key] = {}
                    cur = None
                elif kind == "n":
                    cur = v
                elif cur is not None and key:
                    out[key].setdefault(cur, v)
                    cur = None
        return out, flags
    slots, ms = find_markers(doc, pages, cfg)
    segs = numbered(segments(slots, ms), flags, "solutions")
    out, key, k = {}, None, 0
    if not cfg.get("paper_regex"):
        key, k = "#1", 1
        out[key] = {}
    for m, pieces, n in segs:
        if m.kind == "paper":
            k += 1
            key = f"#{k}"
            out.setdefault(key, {})
            continue
        if m.kind != "q" or n is None or key is None:
            continue
        out[key][n] = (m, pieces)
    return out, flags


def build_paper(doc: Doc, prof, paper, sols, out_root):
    cfg = dict(prof["question"], **paper.get("question", {}))
    pid = paper["id"]
    out_dir = os.path.join(out_root, pid)
    os.makedirs(os.path.join(out_dir, "snapshots"), exist_ok=True)
    pack = Pack(out_dir)
    flags_all = []
    pages = list(range(paper["pages"][0], paper["pages"][1] + 1))
    slots, ms = find_markers(doc, pages, cfg)
    segs = numbered(segments(slots, ms, bool(cfg.get("extend_last"))), flags_all, "questions")
    section, groups, qs = None, [], []
    sol_cfg = paper.get("solutions") or prof.get("solutions") or {}
    psol = dict(sols.get(str(paper.get("sol_key", "")), {}))
    if paper.get("solutions"):
        one, f1 = parse_solutions(doc, {"solutions": dict(paper["solutions"])})
        psol.update(one.get("#1", {}))
        flags_all += f1
    pkey = {}
    if paper.get("key"):
        kk, _ = parse_solutions(doc, {"solutions": dict(paper["key"], mode="key_grid")})
        pkey = kk.get("#1", {})
    sol_ign = [re.compile(x) for x in sol_cfg.get("ignore", [])]
    inline_sol = re.compile(cfg["inline_solution"]) if cfg.get("inline_solution") else None
    for m, pieces, n in segs:
        if m.kind == "section":
            section = title_case(re.sub(r"\s+", " ", m.line.text.strip()))
            continue
        if m.kind == "group":
            reg = Region(doc, pieces)
            head = re.match(r"[^.:]*", norm(m.line.text)).group(0)
            nums = [int(x) for x in re.findall(r"\d+", head)] if re.search(r"(?i)questions?|directions?", head) else []
            nxt_n = max([int(q["number"]) for q in qs] + [0]) + 1
            lo, hi = (nums[0], nums[-1]) if nums else (nxt_n, nxt_n)
            gflags = []
            cl = clean_boxes(reg.boxes, reg.lines, reg.w)
            mg = min((l.x0 for l in reg.lines), default=None)
            md, plain, _k = build_content(reg, reg.lines, cl, mg, pack, f"g{lo}-{hi}", prof, gflags, label="figure")
            groups.append((lo, hi, md, plain))
            flags_all += [f"directions {lo}-{hi}: {f}" for f in gflags]
            continue
        if m.kind != "q" or n is None:
            continue
        reg = Region(doc, pieces)
        qname = f"q{n}"
        flags = []
        isol = None
        if inline_sol:  # "Sol: (B) ..." printed straight after the question
            sl_ = next((l for l in reg.lines if inline_sol.match(l.text.strip())), None)
            if sl_ is not None:
                cut, qp, sp = sl_.y0 - 0.5, [], []
                for pc in reg.pieces:
                    a, b = pc.voff, pc.voff + (pc.y1 - pc.y0)
                    if cut >= b:
                        qp.append(Piece(pc.pno, pc.x0, pc.y0, pc.x1, pc.y1))
                    elif cut <= a:
                        sp.append(Piece(pc.pno, pc.x0, pc.y0, pc.x1, pc.y1))
                    else:
                        qp.append(Piece(pc.pno, pc.x0, pc.y0, pc.x1, pc.y0 + cut - a))
                        sp.append(Piece(pc.pno, pc.x0, pc.y0 + cut - a, pc.x1, pc.y1))
                reg, isol = Region(doc, qp), Region(doc, sp)
        anchor = next((l for l in reg.lines if l.piece == 0 and abs(l.y0 - reg.pieces[0].voff - (m.line.y0 - pieces[0].y0)) < 0.6 and abs(l.x0 - (m.line.x0 - pieces[0].x0)) < 0.6), None)
        # anchors that also carry the first words of the stem ("12. Find ...")
        if anchor is not None and cfg["anchor"].get("inline"):
            k = m.m.end() + (len(anchor.text) - len(anchor.text.lstrip()))
            rest = [c for c in anchor.chars[k:] if c[0].strip()]
            num = [c for c in anchor.chars[:k] if c[0].strip()]
            if rest:
                reg.lines.append(Line(rest[0][1], anchor.y0, rest[-1][2], anchor.y1, "".join(c[0] for c in anchor.chars[k:]), anchor.chars[k:], anchor.size, anchor.bold, anchor.font, 0))
            if num:
                anchor.x1 = num[-1][2]
        g = next((x for x in reversed(groups) if x[0] <= n <= x[1]), None)
        stem, plain, kind, opts, margin, want = split_question(reg, anchor, cfg, pack, qname, prof, flags, g[2] if g else None)
        notes = []
        if cfg.get("force_picture"):
            flags.append("no options found (whole-paper picture mode: this paper's fonts cannot be read reliably)")
        if any(h in f for f in flags for h in ("options found", "no options", "is empty", "overlaps", "belongs to no option", "nothing to crop")):
            # Layout could not be split with certainty: keep the question exactly as printed.
            pack.drop(f"{qname}-")
            x0 = (margin - 3) if margin is not None else ((anchor.x1 + 1) if anchor is not None else 0)
            im = reg.crop(x0, 0, reg.w, reg.vh, pad=0)
            if im is not None:
                alt = alt_text([l for l in reg.lines if l is not anchor]) or f"question {n}"
                stem = f"![{alt}](asset:{pack.add(im, f'{qname}-full')})"
                opts = [{"label": L, "text": f"Option {L}"} for L in want]
                notes = ["kept as a picture of the whole question: " + "; ".join(flags)]
                flags = []
        if g:
            stem = (g[2] + "\n\n" + stem).strip()
        snap = reg.snapshot()
        if snap:
            snap.save(os.path.join(out_dir, "snapshots", f"q{n}.png"), optimize=True)
        q = {"id": qname, "number": str(n), "type": "mcq_single", "stem": stem,
             "options": [{"label": o["label"], "text": o["text"]} for o in opts]}
        # answer + solution
        if isol is not None:
            sl2 = [l for l in isol.lines if not inline_sol.match(l.text.strip())]
            am = next((re.match(r"\(?([A-E])\)", l.text.strip()) for l in sorted(sl2, key=lambda l: (round(l.cy / 4), l.x0)) if l.text.strip()), None)
            if am:
                q["answer"] = am.group(1)
            else:  # "Sol. (B)" on the marker line, or "Sol:  (C)" with stray symbols sorted first
                mm = re.search(r"\(([A-E])\)", sl_.text)
                if not mm:
                    row = [re.match(r"\(([A-E])\)", l.text.strip()) for l in isol.lines if abs(l.cy - (sl_.h / 2 + 0.5)) < 8 and l.x0 >= sl_.x1 - 1]
                    mm = next((r for r in row if r), None)
                if mm:
                    q["answer"] = mm.group(1)
            sflags = []
            mg = min((l.x0 for l in sl2), default=None)
            smd, _sp, _k = build_content(isol, sl2, clean_boxes(isol.boxes, sl2, isol.w), mg, pack, f"{qname}-sol", prof, sflags, whole=True, label="solution")
            if smd:
                q["solution"] = smd
        elif n in psol and isinstance(psol[n], str):
            q["answer"] = psol[n]
        elif n in psol:
            sm, spieces = psol[n]
            sreg = Region(doc, [Piece(p.pno, p.x0, p.y0, p.x1, p.y1) for p in spieces], sol_ign)
            sflags = []
            ans = sm.m.group(2) if sm.m.re.groups >= 2 else None
            if not ans:
                am = next((re.match(r"\(([A-E])\)", l.text.strip()) for l in sorted(sreg.lines, key=lambda l: (round(l.cy / 4), l.x0)) if l.piece == 0 and l.cy < 16 and re.match(r"\(([A-E])\)", l.text.strip())), None)
                ans = am.group(1) if am else None
            sl = list(sreg.lines)
            sa = next((l for l in sl if l.piece == 0 and abs(l.y0 - (sm.line.y0 - spieces[0].y0)) < 0.6 and abs(l.x0 - (sm.line.x0 - spieces[0].x0)) < 0.6), None)
            mg = None
            if sa is not None:
                k = sm.m.end() + (len(sa.text) - len(sa.text.lstrip()))
                rest = [c for c in sa.chars[k:] if c[0].strip()]
                sl.remove(sa)
                if rest:
                    sl.append(Line(rest[0][1], sa.y0, rest[-1][2], sa.y1, "".join(c[0] for c in sa.chars[k:]), sa.chars[k:], sa.size, sa.bold, sa.font, 0))
                mg = sol_cfg.get("text_x")
            cl = clean_boxes(sreg.boxes, sl, sreg.w)
            smd, _sp, _k = build_content(sreg, sl, cl, mg, pack, f"{qname}-sol", prof, sflags, whole=bool(sol_cfg.get("whole_if_figure", True)), label="solution")
            if ans:
                q["answer"] = ans
            if smd:
                q["solution"] = smd
            flags += sflags
        if n in pkey:
            if q.get("answer") and q["answer"] != pkey[n]:
                flags.append(f"answer key says {pkey[n]} but the explanation says {q['answer']}")
            q["answer"] = pkey[n]
        if "answer" not in q:
            flags.append("no answer found")
        q["topics"] = [section] if section else []
        q["fields"] = dict(prof.get("fields", {}), **paper.get("fields", {}))
        if section:
            q["fields"]["Section"] = section
            mk = (prof.get("section_marks") or {}).get(section.lower())
            if mk:
                q["marks"] = mk
        q["source"] = {"file": prof["source"], "page": m.pno}
        q["_flags"] = flags
        q["_notes"] = notes
        qs.append(q)
    exp = paper.get("count") or prof.get("count")
    if exp and len(qs) != exp:
        flags_all.append(f"expected {exp} questions, found {len(qs)}")
    write_report(out_dir, paper["title"], qs, flags_all)
    doc_out = {
        "format": "practice-app/question-pack@1",
        "pack": {"id": pid, "title": paper["title"], "source": prof["source"], "subject": prof.get("subject")},
        "assets": pack.assets,
        "questions": [{k: v for k, v in q.items() if not k.startswith("_")} for q in qs],
    }
    with open(os.path.join(out_dir, "pack.json"), "w") as f:
        json.dump(doc_out, f, ensure_ascii=False, indent=1)
    with zipfile.ZipFile(os.path.join(out_root, pid + ".zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(out_dir, "pack.json"), "pack.json")
        for a in pack.assets.values():
            z.write(os.path.join(out_dir, a["file"]), a["file"])
    summary = {"id": pid, "questions": len(qs), "flagged": sum(1 for q in qs if q["_flags"]), "answers": sum(1 for q in qs if q.get("answer")),
               "solutions": sum(1 for q in qs if q.get("solution")), "images": len(pack.assets), "paper_flags": flags_all, "pictures": {q["number"]: q["_notes"] for q in qs if q.get("_notes")},
               "flags": {q["number"]: q["_flags"] for q in qs if q["_flags"]}}
    return summary


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "dump":
        doc = Doc(sys.argv[2], {})
        pg = doc.page(int(sys.argv[3]))
        for l in sorted(pg["lines"], key=lambda l: (l.cy, l.x0)):
            print(f"T {l.x0:6.1f} {l.y0:6.1f} {l.x1:6.1f} {l.y1:6.1f} sz{l.size:4.1f} {'B' if l.bold else ' '} {l.font[:22]:22} | {l.text!r}")
        for c in cluster(pg["boxes"]):
            print(f"G {c.x0:6.1f} {c.y0:6.1f} {c.x1:6.1f} {c.y1:6.1f}")
        return
    if len(sys.argv) >= 5 and sys.argv[1] == "build":
        prof = json.load(open(sys.argv[2]))
        doc = Doc(sys.argv[3], prof)
        out = sys.argv[4]
        only = set(sys.argv[5:])
        os.makedirs(out, exist_ok=True)
        sols, sflags = parse_solutions(doc, prof)
        for f in sflags:
            print("  !", f)
        res = []
        for paper in prof["papers"]:
            if only and paper["id"] not in only:
                continue
            s = build_paper(doc, prof, paper, sols, out)
            res.append(s)
            print(f"{s['id']}: {s['questions']} questions, {s['answers']} answers, {s['solutions']} solutions, {s['images']} images, {s['flagged']} flagged {s['paper_flags'] or ''}")
        with open(os.path.join(out, "summary.json"), "w") as f:
            json.dump(res, f, indent=1)
        return
    print(__doc__)


if __name__ == "__main__":
    main()
