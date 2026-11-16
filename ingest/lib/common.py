"""Shared helpers for the question-pack converters.

Design rules (from docs/ai-prompt.md):
  * copy text word for word - never reword, correct, merge, split or reorder;
  * never invent answers or solutions;
  * maths is LaTeX only where the source itself shows a fraction/mixed number;
  * every literal Markdown/LaTeX-significant character in plain text is escaped, so the
    stored text renders exactly like the source.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

FORMAT = "practice-app/question-pack@1"
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "ingest" / "packs"

# --------------------------------------------------------------------------- labels
# Live library labels (read-only query of D1 on 2026-11-16).
DIFFICULTY_LABELS = ("Foundation", "Challenge", "Achiever")

# --------------------------------------------------------------------------- escaping
# NB: "[" and "]" are NOT backslash-escaped: the app's renderer treats "\[ ... \]" as display maths
# (src/client/render.ts). A bracket is literal in Markdown unless it closes into a link ("](", "][", "]:"),
# so only that "]" is written as the entity &#93;.
_ESC = re.compile(r"([\\`*_<>|~$])")


def esc(text: str) -> str:
    """Escape plain text so Markdown / LaTeX treat it literally."""
    out = _ESC.sub(r"\\\1", text)
    out = re.sub(r"&(#?[A-Za-z0-9]+;)", r"\\&\1", out)  # stop &amp; style entities being decoded
    out = re.sub(r"\](?=\s*[(\[:])", "&#93;", out)
    return out


def esc_line_starts(md: str) -> str:
    """Escape characters that would turn a line into a list / heading / rule."""
    lines = []
    for ln in md.split("\n"):
        if re.match(r"^\s{0,3}(#{1,6}\s|[-+]\s|\d+[.)]\s|={3,}|-{3,})", ln):
            ln = re.sub(r"^(\s{0,3})(#{1,6}|[-+]|\d+)([.)]?)(\s|$)", lambda m: f"{m.group(1)}\\{m.group(2)}{m.group(3)}{m.group(4)}" if m.group(2)[0] in "#-+" else f"{m.group(1)}{m.group(2)}\\{m.group(3)}{m.group(4)}", ln, count=1)
        lines.append(ln)
    return "\n".join(lines)


# --------------------------------------------------------------------------- HTML -> Markdown
class HtmlToMd:
    """Small, strict HTML -> Markdown converter for the elements these sources use.

    Raises on any element it does not know, so nothing is ever silently dropped.
    """

    INLINE_DROP_CLASSES = {"sr-only"}

    def __init__(self, *, svg_handler=None, drop_classes=(), class_handlers=None):
        self.svg_handler = svg_handler
        self.drop_classes = set(drop_classes) | self.INLINE_DROP_CLASSES
        self.class_handlers = class_handlers or {}
        self.seen_tags: set[str] = set()

    # ---- inline
    def inline(self, node, math=False) -> str:
        if isinstance(node, NavigableString):
            s = str(node)
            if math:
                return s
            return esc(s)
        if not isinstance(node, Tag):
            return ""
        cls = set(node.get("class") or [])
        if cls & self.drop_classes and "fr" not in cls:
            return ""
        for c, fn in self.class_handlers.items():
            if c in cls:
                return fn(node, self)
        name = node.name
        self.seen_tags.add(name)
        if name == "br":
            return "\\\n"  # CommonMark hard break (survives trailing-space trimming)
        if name in ("strong", "b"):
            inner = self.inline_children(node)
            return f"**{inner.strip()}**" + (" " if inner.endswith(" ") else "") if inner.strip() else inner
        if name in ("em", "i"):
            inner = self.inline_children(node)
            return f"*{inner.strip()}*" + (" " if inner.endswith(" ") else "") if inner.strip() else inner
        if name in ("span", "a", "u", "mark", "small"):
            return self.inline_children(node)
        if name == "sup":
            return f"<sup>{self.inline_children(node)}</sup>"
        if name == "sub":
            return f"<sub>{self.inline_children(node)}</sub>"
        if name == "svg":
            if self.svg_handler:
                return self.svg_handler(node)
            raise ValueError("unexpected <svg>")
        raise ValueError(f"unhandled inline element <{name}> classes={sorted(cls)}")

    def inline_children(self, node) -> str:
        return "".join(self.inline(c) for c in node.children)

    # ---- blocks
    def block_children(self, node, depth=0) -> list[str]:
        out: list[str] = []
        buf = ""
        for c in node.children:
            if isinstance(c, Tag) and c.name in ("p", "div", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "section", "figure", "li"):
                if buf.strip():
                    out.append(buf.strip())
                buf = ""
                out.extend(self.block(c, depth))
            else:
                buf += self.inline(c)
        if buf.strip():
            out.append(buf.strip())
        return out

    def block(self, node: Tag, depth=0) -> list[str]:
        cls = set(node.get("class") or [])
        if cls & self.drop_classes:
            return []
        for c, fn in self.class_handlers.items():
            if c in cls:
                r = fn(node, self)
                return [r] if r else []
        name = node.name
        self.seen_tags.add(name)
        if name == "p":
            return [self.inline_children(node).strip()]
        if name in ("div", "section", "figure"):
            return self.block_children(node, depth)
        if name in ("h1", "h2", "h3", "h4", "h5"):
            return ["#" * min(6, int(name[1]) + 2) + " " + self.inline_children(node).strip()]
        if name in ("ul", "ol"):
            return [self.list_md(node, depth)]
        if name == "table":
            return [self.table_md(node)]
        if name == "li":
            return [self.inline_children(node).strip()]
        raise ValueError(f"unhandled block element <{name}> classes={sorted(cls)}")

    def list_md(self, node: Tag, depth=0) -> str:
        ordered = node.name == "ol"
        typ = node.get("type")
        lines = []
        pad = "   " * depth
        for i, li in enumerate((c for c in node.children if isinstance(c, Tag)), start=1):
            if li.name != "li":
                raise ValueError(f"unexpected <{li.name}> in list")
            self.seen_tags.add("li")
            head = ""
            subs = []
            for c in li.children:
                if isinstance(c, Tag) and c.name in ("ul", "ol"):
                    subs.append(self.list_md(c, depth + 1))
                elif isinstance(c, Tag) and c.name in ("p", "div"):
                    head += (" " if head else "") + self.inline_children(c).strip()
                else:
                    head += self.inline(c)
            if ordered and typ == "a":  # lettered parts: (a), (b), ... as the page shows them
                lines.append(f"{pad}**({chr(96 + i)})** {head.strip()}")
                lines.extend(subs)
                lines.append("")  # separate paragraphs
                continue
            marker = f"{i}." if ordered else "-"
            lines.append(f"{pad}{marker} {head.strip()}")
            lines.extend(subs)
        return "\n".join(lines).strip("\n")

    def table_md(self, node: Tag) -> str:
        rows = []
        for tr in node.find_all("tr"):
            rows.append([self.inline_children(td).strip().replace("\n", " ") for td in tr.find_all(["th", "td"], recursive=False)])
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        out = ["| " + " | ".join(rows[0]) + " |", "|" + "|".join(" --- " for _ in range(width)) + "|"]
        out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n".join(out)


def tidy(md: str) -> str:
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


# --------------------------------------------------------------------------- pack I/O
def write_pack(pack: dict, filename: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / filename
    p.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return p


def soup(path: Path) -> BeautifulSoup:
    return BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
