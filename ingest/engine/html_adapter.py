"""HTML adapter (stage S1). Knows the file format and nothing about questions.

The page is parsed inertly: no script is ever run (R13). Every text node of the body becomes a ledger block,
whether or not CSS would show it, so hidden content has to be claimed or ignored like everything else.
"""
from __future__ import annotations

import bisect
import json
import re

from bs4 import BeautifulSoup, CData, Comment, Declaration, Doctype, NavigableString, ProcessingInstruction, Tag

from ledger import Ledger
from util import StageFail

NO_TEXT = {"script", "style", "template", "head", "title", "svg", "math"}
ASSET_TAGS = {"svg": "svg", "img": "image"}
UNSUPPORTED_TAGS = {"math", "canvas", "iframe", "object", "embed", "video", "audio", "picture"}
SVG_TAGS = {"svg", "g", "path", "line", "polygon", "polyline", "rect", "circle", "ellipse", "text", "tspan", "defs", "use",
            "marker", "clippath", "lineargradient", "radialgradient", "stop", "pattern", "mask", "symbol", "title", "desc", "image"}


def locator_of(el: Tag) -> str:
    """A CSS path that finds this element again (R9)."""
    parts = []
    node = el
    while isinstance(node, Tag) and node.name not in ("[document]", "html"):
        if node.get("id"):
            parts.append(f"{node.name}#{node['id']}")
            break
        same = [s for s in node.parent.find_all(node.name, recursive=False)] if node.parent else [node]
        idx = next(i for i, s in enumerate(same, start=1) if s is node)
        parts.append(node.name if len(same) == 1 else f"{node.name}:nth-of-type({idx})")
        node = node.parent
    return " > ".join(reversed(parts))


class HtmlDoc:
    kind = "html"

    def __init__(self, raw_bytes: bytes, name: str):
        try:
            self.raw = raw_bytes.decode("utf-8")
        except UnicodeDecodeError as e:
            raise StageFail(f"{name}: not valid UTF-8 ({e})", check="S0.integrity")
        self.name = name
        self.soup = BeautifulSoup(self.raw, "html.parser")
        self.ledger = Ledger()
        self.text_block: dict[int, int] = {}    # id(text node) -> block id
        self.el_block: dict[int, int] = {}      # id(svg/img/unsupported element) -> block id
        self.elements_seen = 0
        self._line_starts = [0]
        for m in re.finditer("\n", self.raw):
            self._line_starts.append(m.end())
        self._walk(self.soup.body or self.soup)

    # ---- S1: blocks
    def _walk(self, node) -> None:
        for child in node.children:
            if isinstance(child, (Comment, Doctype, CData, ProcessingInstruction, Declaration)):
                continue
            if isinstance(child, NavigableString):
                text = str(child)
                if text.strip():
                    parent = child.parent
                    n = sum(1 for s in parent.children if isinstance(s, NavigableString) and str(s).strip() and s is not child
                            and self._before(parent, s, child))
                    self.text_block[id(child)] = self.ledger.add_block("text", text, f"{locator_of(parent)} :: text[{n}]")
                continue
            if not isinstance(child, Tag):
                continue
            self.elements_seen += 1
            if child.name in ASSET_TAGS:
                self.el_block[id(child)] = self.ledger.add_block(ASSET_TAGS[child.name], "", locator_of(child))
                continue
            if child.name in UNSUPPORTED_TAGS:
                self.el_block[id(child)] = self.ledger.add_block("unsupported", "", locator_of(child), construct=child.name)
                continue
            if child.name in NO_TEXT:
                continue
            self._walk(child)

    @staticmethod
    def _before(parent, a, b) -> bool:
        for s in parent.children:
            if s is a:
                return True
            if s is b:
                return False
        return False

    # ---- helpers used by the interpreter
    def blocks_under(self, el: Tag) -> list[int]:
        out = []
        if id(el) in self.el_block:
            return [self.el_block[id(el)]]
        for d in el.descendants:
            bid = self.text_block.get(id(d)) if isinstance(d, NavigableString) else self.el_block.get(id(d))
            if bid is not None:
                out.append(bid)
        return out

    def raw_element(self, el: Tag) -> str:
        """The element's exact source bytes (the parser lower-cases attribute names such as viewBox)."""
        if el.sourceline is None or el.sourcepos is None:
            raise StageFail("the parser did not record where this element starts", locator=locator_of(el), check="S1.assets")
        start = self._line_starts[el.sourceline - 1] + el.sourcepos
        opener = f"<{el.name}"
        if self.raw[start:start + len(opener)].lower() != opener:
            raise StageFail("element position does not line up with the raw source", locator=locator_of(el), check="S1.assets")
        closer = f"</{el.name}>"
        end = self.raw.lower().find(closer, start)
        if end < 0:
            raise StageFail(f"no closing {closer}", locator=locator_of(el), check="S1.assets")
        chunk = self.raw[start:end + len(closer)]
        if chunk.lower().count(opener) != 1:
            raise StageFail(f"nested <{el.name}> is not supported", locator=locator_of(el), check="S1.assets")
        return chunk

    def json_script(self, selector: str):
        el = self.soup.select_one(selector)
        if el is None or el.name != "script" or "json" not in (el.get("type") or ""):
            raise StageFail(f"{selector!r} is not a <script type=application/json>", check="S2.lookup")
        return json.loads(el.string or "")

    # ---- page stylesheet, for figures (transform svg_inline_page_styles@1)
    def css_rules(self) -> tuple[list[tuple[str, str]], dict[str, str], list[str]]:
        """Top-level (selector, declarations) pairs, :root custom properties, and at-rule blocks we skipped."""
        css = "\n".join(s.string or "" for s in self.soup.find_all("style"))
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        rules, skipped, variables = [], [], {}
        i, n = 0, len(css)
        while i < n:
            brace = css.find("{", i)
            if brace < 0:
                break
            selector = css[i:brace].strip()
            depth, j = 1, brace + 1
            while j < n and depth:
                depth += {"{": 1, "}": -1}.get(css[j], 0)
                j += 1
            body = css[brace + 1:j - 1]
            if selector.startswith("@"):
                skipped.append(selector)
            else:
                rules.append((selector, body.strip()))
                if selector in (":root", "html"):
                    for m in re.finditer(r"(--[\w-]+)\s*:\s*([^;]+)", body):
                        variables[m.group(1)] = m.group(2).strip()
            i = j
        return rules, variables, skipped


def styled_svg(doc: HtmlDoc, el: Tag, extra_css: str, cache: dict) -> tuple[str, dict]:
    """svg_inline_page_styles@1: copy the figure's exact bytes and add one <style> block holding the page rules
    that target it. The app shows figures as <img>, where the page stylesheet does not apply. Never redraws (R3)."""
    raw = doc.raw_element(el)
    low = raw.lower()
    for bad in ("<script", "<foreignobject", "javascript:", "@import", "url(http", "href=\"http", "href='http"):
        if bad in low:
            raise StageFail(f"figure contains {bad!r}, which a packaged figure may not carry", locator=locator_of(el), check="S3.assets")
    if re.search(r"\son[a-z]+\s*=", low):
        raise StageFail("figure has an event-handler attribute", locator=locator_of(el), check="S3.assets")
    head = raw[:raw.index(">") + 1]
    if "xmlns=" not in head or "viewbox=" not in head.lower():
        raise StageFail("figure lacks xmlns or viewBox on its root", locator=locator_of(el), check="S3.assets")
    if "rules" not in cache:
        cache["rules"] = doc.css_rules()
    rules, variables, _ = cache["rules"]
    classes = {c for grp in re.findall(r'class="([^"]*)"', raw) for c in grp.split()}
    tags = {t.lower() for t in re.findall(r"<([A-Za-z][\w-]*)", raw)}
    kept, unstyled = [], set(classes)
    for selector, body in rules:
        for one in (s.strip() for s in selector.split(",")):
            sel_classes = set(re.findall(r"\.([\w-]+)", one))
            sel_tags = {t.lower() for t in re.findall(r"(?:^|[\s>+~])([A-Za-z][\w-]*)", one)}
            if not sel_classes and not (sel_tags and sel_tags <= SVG_TAGS):
                continue
            if "#" in one or not sel_classes <= classes or not sel_tags <= tags:
                continue
            decl = body
            for var in set(re.findall(r"var\((--[\w-]+)\)", decl)):
                if var not in variables:
                    raise StageFail(f"figure style uses {var}, which is not defined on :root", locator=locator_of(el), check="S3.assets")
                decl = decl.replace(f"var({var})", variables[var])
            kept.append(f"{one}{{{decl}}}")
            unstyled -= sel_classes
    style = f"<style>{extra_css}{''.join(kept)}</style>"
    info = {"rules_inlined": len(kept), "classes_without_rule": sorted(unstyled)}
    return head + style + raw[len(head):], info
