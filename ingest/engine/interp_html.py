"""S2 for HTML pages whose questions are DOM containers (segment css_container@1)."""
from __future__ import annotations

import re

import soupsieve
from bs4 import NavigableString, Tag

from html_adapter import HtmlDoc, locator_of, styled_svg
from htmlmd import Converter, tidy
from interp import Run, apply_map, apply_regex, check_numbering, classify_number_unit, coerce, finish_question, render_template, set_path
from spec import rx
from util import StageFail, sha256_bytes, words


LIST_FIELDS = ("topics", "hints", "tags")


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


class HtmlInterp:
    def __init__(self, doc: HtmlDoc, run: Run):
        self.doc, self.run, self.ledger = doc, run, doc.ledger
        self.profile = run.profile
        self.ignored: dict[int, int] = {}
        self.rules: dict[int, dict] = {}
        self._css_cache: dict = {}
        self._lookups: dict = {}
        self._dry = False

    # ---- ignore rules and content rules are resolved once, against the whole page
    def prepare(self) -> None:
        soup = self.doc.soup
        for i, rule in enumerate(self.profile["ignore"]):
            self.ledger.rules.append({"index": i, "rule": {k: rule[k] for k in ("css", "regex") if k in rule}, "reason": rule["reason"],
                                      "max_blocks": rule["max_blocks"], "max_tokens": rule["max_tokens"], "match_elements": 0})
            if "css" not in rule:
                continue
            for el in soup.select(rule["css"]):
                if "expect" in rule and _collapse(el.get_text()) != rule["expect"]:
                    raise StageFail(f"ignore rule {i} expects the text {rule['expect']!r} but found {_collapse(el.get_text())[:80]!r}",
                                    locator=locator_of(el), check="S2.ignore", hint="the ignored element does not say what the profile assumed")
                self.ledger.rules[i]["match_elements"] += 1
                self.ignored.setdefault(id(el), i)
                for d in el.descendants:
                    if isinstance(d, Tag):
                        self.ignored.setdefault(id(d), i)
                for bid in self.doc.blocks_under(el):
                    self.ledger.ignored.setdefault(bid, {"rule": i, "reason": rule["reason"]})
        for rule in self.profile.get("content", {}).get("rules", []):
            for el in soup.select(rule["match"]):
                self.rules.setdefault(id(el), rule)

    def finish_ignores(self) -> None:
        """Regex ignore rules apply last, to whole blocks nothing claimed."""
        for i, rule in enumerate(self.profile["ignore"]):
            if "regex" in rule:
                pat = rx(rule["regex"])
                for b in self.ledger.blocks:
                    if b["id"] not in self.ledger.claims and b["id"] not in self.ledger.ignored and b["kind"] == "text" and pat.fullmatch(b["text"].strip()):
                        self.ledger.ignore(b["id"], i, rule["reason"])

    # ---- conversion helpers
    def converter(self, q: str | None, field: str, mode="verbatim", shared=False, skip=frozenset()) -> Converter:
        def claim(bid):
            self.ledger.claim(bid, q, field, mode, shared)

        def asset(el):
            return self.asset(el, q, field)

        return Converter(self.doc, rules=self.rules, ignored=self.ignored, formatting=self.profile.get("formatting", {}),
                         claim=claim, asset=asset, skip=skip, note_format=self.run.note_format)

    def asset(self, el: Tag, q: str | None, field: str) -> str:
        cfg = self.profile.get("content", {}).get("svg")
        if el.name != "svg" or not cfg:
            raise StageFail(f"<{el.name}> figure but the profile declares no content.svg handling", locator=locator_of(el), check="S2.unsupported",
                            hint="only inline <svg> figures are packaged by this engine version; anything else must be ignored with a reason")
        data, info = styled_svg(self.doc, el, cfg.get("extra_css", ""), self._css_cache)
        original = self.doc.raw_element(el)
        name = "fig-" + sha256_bytes(data.encode("utf-8"))[:16]
        self.run.assets[name] = {"type": "image/svg+xml", "data": data}
        bid = self.doc.el_block[id(el)]
        self.ledger.claim(bid, q, field, "asset")
        self.ledger.blocks[bid]["asset"] = name
        self.run.asset_rows.append({"asset": name, "question": q, "field": field, "locator": locator_of(el),
                                    "original_sha256": sha256_bytes(original.encode("utf-8")), "packaged_sha256": sha256_bytes(data.encode("utf-8")), **info})
        alt = (el.get(cfg.get("alt_attr", "aria-label")) or "").replace("[", "(").replace("]", ")")
        return f"![{alt}](asset:{name})"

    def text_of(self, el: Tag, q, field, mode, shared) -> str:
        out = []
        for d in el.descendants:
            if isinstance(d, NavigableString) and id(d) in self.doc.text_block and not any(id(p) in self.ignored for p in d.parents):
                if not self._dry:
                    self.ledger.claim(self.doc.text_block[id(d)], q, field, mode, shared)
                out.append(str(d))
        return _collapse("".join(out))

    def select(self, base: Tag, spec: dict, where: str, field: str) -> list[Tag]:
        if "closest" in spec:
            anchor = soupsieve.closest(spec["closest"], base)
            if anchor is None:
                raise StageFail(f"{field}: no ancestor matches {spec['closest']!r}", locator=where, check="S2.select")
            base = anchor
        if "from" not in spec:
            return [base]
        selectors = spec["from"] if isinstance(spec["from"], list) else [spec["from"]]
        found = []
        for sel in selectors:
            hits = [h for h in base.select(sel) if id(h) not in self.ignored]
            if not hits and not spec.get("optional"):
                raise StageFail(f"{field}: nothing matches {sel!r}", locator=where, check="S2.select",
                                hint="mark the field optional only if the source really omits it for some questions")
            if len(hits) > 1 and not spec.get("each"):
                raise StageFail(f"{field}: {sel!r} matches {len(hits)} elements, expected one", locator=where, check="S2.select",
                                hint="make the selector more specific, or set each: true if every match is a separate item")
            found.extend(hits)
        return found

    # ---- one value
    def scalar(self, spec: dict, art: Tag, q: str | None, field: str, values: dict):
        where = locator_of(art)
        derived = any(k in spec for k in ("regex", "map", "lookup")) or spec.get("as") in ("int", "number")
        if "const" in spec:
            value = spec["const"]
        elif "var" in spec:
            value = values.get(spec["var"])
        elif "template" in spec:
            value = render_template(spec["template"], values, where)
        elif "lookup" in spec:
            lk = spec["lookup"]
            data = self._lookups.setdefault(lk["json"], self.doc.json_script(lk["json"]))
            want = {k: render_template(str(v), values, where) for k, v in lk["where"].items()}
            rows = [r for r in data.get(lk["list"], []) if all(str(r.get(k)) == v for k, v in want.items())]
            if len(rows) != 1:
                raise StageFail(f"{field}: lookup {want} found {len(rows)} rows in {lk['json']} {lk['list']}", locator=where, check="S2.lookup")
            value = rows[0][lk["get"]]
        else:
            els = self.select(art, spec, where, field)
            if not els:
                return None
            if "attr" in spec:
                value = els[0].get(spec["attr"])
                if value is None:
                    raise StageFail(f"{field}: attribute {spec['attr']!r} is missing", locator=locator_of(els[0]), check="S2.select")
            else:
                value = self.text_of(els[0], q, field, "derived" if derived else "verbatim", spec.get("shared", False))
        if value is None:
            return None
        if "regex" in spec:
            value = apply_regex(spec["regex"], str(value), where, field)
        if "map" in spec:
            value = apply_map(self.run, spec["map"], value, where, field)
        return coerce(value, spec.get("as"), where, field)

    def markdown(self, spec: dict, art: Tag, q: str, field: str, skip: frozenset) -> list[str]:
        where = locator_of(art)
        skip = set(skip)
        for sel in spec.get("exclude", []):
            for el in art.select(sel):
                skip.add(id(el))
        conv = self.converter(q, field, shared=spec.get("shared", False), skip=frozenset(skip))
        items = []
        for el in self.select(art, spec, where, field):
            md = tidy("\n\n".join(conv.block(el)))
            if md:
                items.append(md)
        for text in conv.added:
            self.ledger.add_literal(q, field, text, "label or separator the page shows but does not store as text")
        return items if spec.get("each") else (["\n\n".join(items)] if items else [])

    # ---- parts
    def parts(self, art: Tag, q: str):
        spec = self.profile.get("parts")
        if not spec:
            return None, frozenset()
        where = locator_of(art)
        hits = [h for h in art.select(spec["from"]) if id(h) not in self.ignored]
        if not hits:
            if spec.get("optional"):
                return None, frozenset()
            raise StageFail(f"parts: nothing matches {spec['from']!r}", locator=where, check="S2.parts")
        parts, taken = [], set()
        if spec["split"] == "br":
            if len(hits) != 1:
                raise StageFail(f"parts: {spec['from']!r} matches {len(hits)} elements, expected one", locator=where, check="S2.parts")
            host = hits[0]
            segments, cur = [], []
            for c in host.children:
                if isinstance(c, Tag) and c.name == "br":
                    segments.append(cur)
                    cur = []
                else:
                    cur.append(c)
            segments.append(cur)
            pat = rx(spec["label"])
            probe = "".join(str(c) if isinstance(c, NavigableString) else c.get_text() for c in segments[0]).strip()
            if not pat.match(probe):
                if spec.get("optional"):
                    return None, frozenset()   # an ordinary last paragraph, not a parts list
                raise StageFail(f"parts: first line {probe[:40]!r} has no label", locator=locator_of(host), check="S2.parts")
            for seg in segments:
                # the label is only known after reading the line, so read once to find it, then claim
                peek = "".join(str(c) if isinstance(c, NavigableString) else c.get_text() for c in seg).strip()
                m = pat.match(peek)
                if not m:
                    raise StageFail(f"parts: line {peek[:40]!r} does not start with a label", locator=locator_of(host), check="S2.parts")
                label = m.group(1)
                conv = self.converter(q, f"parts.{label}.stem")
                md = "".join(conv.inline(c) for c in seg).strip()
                m2 = pat.match(md)
                self.ledger.strip_prefix(q, f"parts.{label}.stem", m2.group(0), "printed part label, stored as the part's label")
                parts.append({"label": label, "stem": md[m2.end():].strip()})
            taken.add(id(host))
        else:   # one element per part; the browser generates the labels
            for i, el in enumerate(hits):
                label = chr(97 + i)
                conv = self.converter(q, f"parts.{label}.stem")
                parts.append({"label": label, "stem": tidy("\n\n".join(conv.block(el)))})
                taken.add(id(el))
            parent = hits[0].parent
            if parent is not None and all(h.parent is parent for h in hits):
                taken.add(id(parent))
        labels = [p["label"] for p in parts]
        if labels != [chr(97 + i) for i in range(len(labels))]:
            raise StageFail(f"parts: labels {labels} are not a, b, c… in order", locator=where, check="S2.parts")
        return parts, frozenset(taken)

    def split_part_answers(self, md: str, fmt: str, parts: list[dict], q: str, where: str) -> None:
        """Cut one printed answer line into the parts' answers by their own labels. Only when it can be proven:
        each label occurs exactly once, in order, starting the line. Otherwise the run stops (R3)."""
        positions, tokens = [], []
        for p in parts:
            token = render_template(fmt, {"label": p["label"]}, where)
            if md.count(token) != 1:
                raise StageFail(f"answer line has {md.count(token)} occurrences of {token!r}: {md[:80]!r}", locator=where, check="S2.answers",
                                hint="the answer cannot be split by labels; keep it whole at question level instead")
            positions.append(md.index(token))
            tokens.append(token)
        if positions != sorted(positions) or positions[0] != 0:
            raise StageFail(f"answer labels are out of order or do not start the line: {md[:80]!r}", locator=where, check="S2.answers")
        positions.append(len(md))
        for i, p in enumerate(parts):
            p["answer"] = md[positions[i] + len(tokens[i]):positions[i + 1]].strip()
            self.ledger.strip_prefix(q, f"parts.{p['label']}.answer", tokens[i], "printed part label")
        self.ledger.group(q, "part_answers", [f"parts.{p['label']}.answer" for p in parts])

    # ---- the whole page
    def questions(self) -> tuple[list[dict], str | None]:
        seg, profile = self.profile["segment"], self.profile
        self.prepare()
        containers = self.doc.soup.select(seg["selector"])
        out, numbers = [], []
        for art in containers:
            where = locator_of(art)
            self._dry = True     # read the number and id first, without claiming, so claims carry the real id
            number = str(self.scalar(seg["number"], art, None, "number", {}))
            id_spec = profile["fields"].get("id")
            qid = str(self.scalar(id_spec, art, None, "id", {"number": number})) if id_spec else f"q{number}"
            self._dry = False
            self.scalar(seg["number"], art, qid, "number", {})
            values = {"number": number, "qid": qid}
            for name, spec in profile.get("vars", {}).items():
                values[name] = self.scalar(spec, art, qid, f"var.{name}", values)
            q: dict = {"id": qid, "number": number}
            parts, taken = self.parts(art, qid)
            has_parts = bool(parts)
            for fname, spec in profile["fields"].items():
                if fname == "id":
                    continue
                specs = spec if isinstance(spec, list) else [spec]
                collected = []
                for one in specs:
                    when = one.get("when", "always")
                    if (when == "no_parts" and has_parts) or (when == "has_parts" and not has_parts):
                        continue
                    if one.get("as") == "markdown":
                        if "split_by_part_labels" in one:
                            items = self.markdown(one, art, qid, "part_answers", taken)
                            if items:
                                self.split_part_answers(items[0], one["split_by_part_labels"], parts, qid, where)
                            continue
                        items = self.markdown(one, art, qid, fname, taken)
                        if "classify" in one and items:
                            key = classify_number_unit(items[0], one.get("units", []))
                            if key is not None:
                                self.run.decisions["classified"].append({"question": qid, "text": items[0], "key": key})
                                items = [key]
                            else:
                                self.run.decisions["kept_open"].append({"question": qid, "text": items[0][:120]})
                        collected.extend(items)
                    else:
                        v = self.scalar(one, art, qid, fname, values)
                        if v is not None:
                            collected.append(v)
                            if any(k in one for k in ("regex", "map", "lookup", "template", "const", "attr", "var")):
                                self.run.decisions["derived_fields"][fname] = self.run.decisions["derived_fields"].get(fname, 0) + 1
                if fname in LIST_FIELDS:
                    if collected:
                        set_path(q, fname, collected)
                elif collected:
                    set_path(q, fname, collected[0])   # a list of specs for a single field means alternatives (see `when`)
                elif not any(o.get("optional") or o.get("when", "always") != "always" for o in specs):
                    raise StageFail(f"required field {fname} is empty", locator=where, check="S2.fields")
            out.append(finish_question(q, parts, profile))
            numbers.append(number)
            self.run.containers[qid] = where
        check_numbering(numbers, seg["numbering"], seg["selector"])
        title = None
        if profile.get("pack", {}).get("title"):
            title = self.scalar(profile["pack"]["title"], self.doc.soup, None, "pack.title", {})
        self.finish_ignores()
        return out, title


def count_tokens(blocks) -> int:
    return sum(words(b["text"]) for b in blocks)
