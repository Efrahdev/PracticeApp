"""htmlmd@1: strict HTML -> Markdown for question content.

Every text node it writes is claimed in the ledger. An element it does not know raises, so nothing is ever
silently dropped (R2). Profile `content.rules` add layout-specific handling; `ignore` rules skip elements.
"""
from __future__ import annotations

import re

from bs4 import NavigableString, Tag

from html_adapter import HtmlDoc, locator_of
from util import StageFail

# escape markdown@1 -----------------------------------------------------------------------------------------
# "[" and "]" are not backslash-escaped: the app's renderer reads "\[ ... \]" as display maths. Only a "]"
# that would close a Markdown link is written as an entity. Guarded by the hostile-string test (G4.hostile).
_ESC = re.compile(r"([\\`*_<>|~$])")


def esc(text: str) -> str:
    out = _ESC.sub(r"\\\1", text)
    out = re.sub(r"&(#?[A-Za-z0-9]+;)", r"\\&\1", out)
    return re.sub(r"\](?=\s*[(\[:])", "&#93;", out)


def tidy(md: str) -> str:
    md = re.sub(r"[ \t]+\n", "\n", md)
    return re.sub(r"\n{3,}", "\n\n", md).strip()


CONTAINERS = {"div", "section", "figure", "article", "details", "main"}
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
BLOCKS = CONTAINERS | HEADINGS | {"p", "ul", "ol", "table", "li", "svg", "img"}
BLOCK_RULES = {"bold_line", "italic_line", "list", "quote_lines"}
FORMATS = {"u": ("underline", "u"), "ins": ("underline", "u"), "s": ("strike", "s"), "del": ("strike", "s"), "strike": ("strike", "s"), "mark": ("highlight", "mark")}
_FRAC_PART = re.compile(r"[0-9]+(\.[0-9]+)?|[A-Za-z]")


class Converter:
    def __init__(self, doc: HtmlDoc, *, rules: dict, ignored: dict, formatting: dict, claim, asset, skip=frozenset(), note_format=None):
        self.doc, self.rules, self.ignored, self.formatting = doc, rules, ignored, formatting
        self.claim, self.asset, self.skip, self.note_format = claim, asset, skip, note_format
        self.added: list[str] = []   # literal text this conversion wrote that the source does not contain

    def _unsupported(self, node: Tag, where: str):
        raise StageFail(f"unsupported {where} element <{node.name}> class={' '.join(node.get('class') or []) or '-'}",
                        locator=locator_of(node), check="S2.unsupported",
                        hint="add a content rule for it, or an ignore rule with a reason")

    # ---- inline
    def inline(self, node) -> str:
        if isinstance(node, NavigableString):
            bid = self.doc.text_block.get(id(node))
            if bid is not None:
                self.claim(bid)
            return esc(str(node)) if bid is not None or not str(node).strip() else ""
        if not isinstance(node, Tag) or id(node) in self.ignored or id(node) in self.skip:
            return ""
        rule = self.rules.get(id(node))
        if rule:
            return self.apply_rule(node, rule)
        name = node.name
        if name == "br":
            return "\\\n"   # CommonMark hard break (survives trailing-space trimming)
        if name in ("strong", "b"):
            return self._wrap(self.inline_children(node), "**")
        if name in ("em", "i"):
            return self._wrap(self.inline_children(node), "*")
        if name in ("span", "a", "small", "label", "summary"):
            return self.inline_children(node)
        if name in FORMATS:
            fmt, tag = FORMATS[name]
            policy = self.formatting.get(fmt)
            if not policy:
                raise StageFail(f"the source uses {fmt} (<{name}>) but the profile has no formatting.{fmt} policy",
                                locator=locator_of(node), check="S2.formatting", hint=f"add formatting.{fmt}: preserve or ignore with a reason")
            if self.note_format:
                self.note_format(fmt, policy["policy"])
            inner = self.inline_children(node)
            return f"<{tag}>{inner}</{tag}>" if policy["policy"] == "preserve" else inner
        if name in ("sup", "sub"):
            return f"<{name}>{self.inline_children(node)}</{name}>"
        if name in ("svg", "img"):
            return self.asset(node)
        self._unsupported(node, "inline")

    @staticmethod
    def _wrap(inner: str, mark: str) -> str:
        if not inner.strip():
            return inner
        return f"{mark}{inner.strip()}{mark}" + (" " if inner.endswith(" ") else "")

    def inline_children(self, node) -> str:
        return "".join(self.inline(c) for c in node.children)

    # ---- blocks
    def is_block(self, c) -> bool:
        if not isinstance(c, Tag):
            return False
        rule = self.rules.get(id(c))
        if rule:
            return rule["do"] in BLOCK_RULES or (rule["do"] == "unwrap" and c.name in BLOCKS)
        return c.name in BLOCKS

    def block_children(self, node, depth=0) -> list[str]:
        out, buf = [], ""
        for c in node.children:
            if self.is_block(c):
                if buf.strip():
                    out.append(buf.strip())
                buf = ""
                out.extend(self.block(c, depth))
            else:
                buf += self.inline(c)
        if buf.strip():
            out.append(buf.strip())
        return [b for b in out if b]

    def block(self, node: Tag, depth=0) -> list[str]:
        if id(node) in self.ignored or id(node) in self.skip:
            return []
        rule = self.rules.get(id(node))
        if rule:
            if rule["do"] == "unwrap":
                return self.block_children(node, depth)
            r = self.apply_rule(node, rule)
            return [r] if r else []
        name = node.name
        if name == "p":
            return [self.inline_children(node).strip()]
        if name in CONTAINERS:
            return self.block_children(node, depth)
        if name in HEADINGS:
            return ["#" * min(6, int(name[1]) + 2) + " " + self.inline_children(node).strip()]
        if name in ("ul", "ol"):
            return [self.list_md(node, depth)]
        if name == "table":
            return [self.table_md(node)]
        if name == "li":
            return [self.inline_children(node).strip()]
        if name in ("svg", "img"):
            return [self.asset(node)]
        if name in ("span", "strong", "b", "em", "i", "a", "small", "sup", "sub", "label", "summary") or name in FORMATS:
            return [self.inline(node).strip()]
        self._unsupported(node, "block")

    def list_md(self, node: Tag, depth=0, keep_spaces=False) -> str:
        ordered = node.name == "ol"
        lettered = ordered and node.get("type") == "a"
        lines, pad = [], "   " * depth
        items = [c for c in node.children if isinstance(c, Tag) and id(c) not in self.ignored]
        for i, li in enumerate(items, start=1):
            if li.name != "li":
                self._unsupported(li, "list")
            head, subs = "", []
            for c in li.children:
                if isinstance(c, Tag) and c.name in ("ul", "ol") and id(c) not in self.rules:
                    subs.append(self.list_md(c, depth + 1))
                elif isinstance(c, Tag) and c.name in ("p", "div") and id(c) not in self.rules:
                    head += (" " if head else "") + self.inline_children(c).strip()
                else:
                    head += self.inline(c)
            head = head.strip()
            if keep_spaces:
                # the page shows these lines with white-space: pre-wrap, so runs of spaces are visible:
                # every extra space becomes a no-break space
                if "\n" in head.replace("\\\n", ""):
                    raise StageFail("line break inside a keep_spaces list item", locator=locator_of(li), check="S2.content")
                head = re.sub(r" {2,}", lambda m: " " + "\u00a0" * (len(m.group()) - 1), head)
            if lettered:   # the browser generates (a), (b), ... for <ol type="a">: write what the learner sees
                label = f"({chr(96 + i)})"
                self.added.append(label)
                lines.append(f"{pad}**{label}** {head}")
                lines.extend(subs)
                lines.append("")
                continue
            lines.append(f"{pad}{f'{i}.' if ordered else '-'} {head}")
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
        return "\n".join(out + ["| " + " | ".join(r) + " |" for r in rows[1:]])

    # ---- profile rules
    def _one(self, node: Tag, selector: str, what: str) -> Tag:
        found = node.select(selector)
        if len(found) != 1:
            raise StageFail(f"rule needs exactly one {what} ({selector!r}) but found {len(found)}", locator=locator_of(node), check="S2.content")
        return found[0]

    def _frac(self, node: Tag, rule: dict) -> str:
        parts = []
        for key in ("num", "den"):
            el = self._one(node, rule[key], key)
            text = "".join(self._plain(el)).strip()
            if not _FRAC_PART.fullmatch(text):
                raise StageFail(f"unrecognised fraction part {text!r}", locator=locator_of(el), check="S2.fraction")
            parts.append(text)
        return f"\\frac{{{parts[0]}}}{{{parts[1]}}}"

    def _plain(self, el: Tag) -> list[str]:
        """Raw text of the element's text nodes (for maths), claiming each."""
        out = []
        for d in el.descendants:
            if isinstance(d, NavigableString) and id(d) in self.doc.text_block and not any(id(p) in self.ignored for p in d.parents):
                self.claim(self.doc.text_block[id(d)])
                out.append(str(d))
        return out

    def apply_rule(self, node: Tag, rule: dict) -> str:
        do = rule["do"]
        if do == "frac":
            return f"${self._frac(node, rule)}$"
        if do == "mixed":
            whole = ""
            for c in node.children:
                if isinstance(c, NavigableString) and id(c) in self.doc.text_block:
                    self.claim(self.doc.text_block[id(c)])
                    whole += str(c)
            whole = whole.strip()
            if not re.fullmatch(r"[0-9]+", whole):
                raise StageFail(f"mixed number has whole part {whole!r}", locator=locator_of(node), check="S2.fraction")
            frac_el = self._one(node, rule["frac"], "fraction")
            frac_rule = self.rules.get(id(frac_el))
            if not frac_rule or frac_rule["do"] != "frac":
                raise StageFail("the fraction inside a mixed number needs its own frac rule", locator=locator_of(frac_el), check="S2.fraction")
            return f"${whole}{self._frac(frac_el, frac_rule)}$"
        if do == "bold_line":
            return f"**{self.inline_children(node).strip()}**"
        if do == "italic_line":
            return f"*{self.inline_children(node).strip()}*"
        if do == "list":
            return self.list_md(node, keep_spaces=rule.get("keep_spaces", False))
        if do == "quote_lines":
            lines = []
            kids = [c for c in node.children if isinstance(c, Tag) and id(c) not in self.ignored]
            for line in node.select(rule["line"]):
                main = self.inline_children(self._one(line, rule["main"], "main part")).strip()
                notes = line.select(rule["note"]) if rule.get("note") else []
                note = self.inline_children(notes[0]).strip() if notes else ""
                sep = rule.get("sep", " — ")
                if note:
                    self.added.append(sep.strip())
                lines.append(f"{main}{sep}*{note}*" if note else main)
            if not lines or len(lines) != len(kids):
                raise StageFail("unexpected content inside a quote_lines element", locator=locator_of(node), check="S2.content")
            return "> " + "\\\n> ".join(lines)
        if do in ("unwrap", "text"):
            return self.inline_children(node)
        raise StageFail(f"unknown rule {do}", check="lint.registry")
