"""HTML pages whose questions live in JavaScript data arrays (source kind html-json, segment json_array@1).

The page's script is never run (R13). Each `const NAME = [ ... ]` is read by a small parser that accepts
literals only: objects, arrays, strings, numbers, true, false, null. An identifier, a call, a template
expression or a spread is a FAIL, never a guess.
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup, NavigableString

from htmlmd import esc, esc_lines
from interp import Run, apply_map, apply_regex, check_numbering, coerce, finish_question, render_template, set_path
from ledger import Ledger
from util import StageFail

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0", "\n": ""}
_NUMBER = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?")
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")


class LiteralParser:
    def __init__(self, text: str, pos: int, name: str):
        self.t, self.i, self.name = text, pos, name

    def fail(self, what: str):
        line = self.t.count("\n", 0, self.i) + 1
        raise StageFail(f"{self.name}: {what} at script line {line}: {self.t[self.i:self.i + 40]!r}", check="S1.literals",
                        hint="only literal data can be read without running the page's code")

    def ws(self) -> None:
        while self.i < len(self.t):
            c = self.t[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif self.t.startswith("//", self.i):
                end = self.t.find("\n", self.i)
                self.i = len(self.t) if end < 0 else end
            elif self.t.startswith("/*", self.i):
                end = self.t.find("*/", self.i)
                if end < 0:
                    self.fail("unterminated comment")
                self.i = end + 2
            else:
                return

    def value(self):
        self.ws()
        c = self.t[self.i] if self.i < len(self.t) else ""
        if c == "[":
            return self.array()
        if c == "{":
            return self.object()
        if c in "\"'`":
            return self.string()
        m = _NUMBER.match(self.t, self.i)
        if m:
            self.i = m.end()
            text = m.group()
            return float(text) if any(ch in text for ch in ".eE") else int(text)
        m = _IDENT.match(self.t, self.i)
        if m and m.group() in ("true", "false", "null"):
            self.i = m.end()
            return {"true": True, "false": False, "null": None}[m.group()]
        self.fail("not a literal (identifier, call or expression)")

    def array(self) -> list:
        self.i += 1
        out = []
        while True:
            self.ws()
            if self.t.startswith("]", self.i):
                self.i += 1
                return out
            if self.t.startswith("...", self.i):
                self.fail("spread is not a literal")
            out.append(self.value())
            self.ws()
            if self.t.startswith(",", self.i):
                self.i += 1
            elif not self.t.startswith("]", self.i):
                self.fail("expected , or ]")

    def object(self) -> dict:
        self.i += 1
        out = {}
        while True:
            self.ws()
            if self.t.startswith("}", self.i):
                self.i += 1
                return out
            c = self.t[self.i]
            if c in "\"'":
                key = self.string()
            else:
                m = _IDENT.match(self.t, self.i)
                if not m:
                    self.fail("expected a property name")
                key, self.i = m.group(), m.end()
            self.ws()
            if not self.t.startswith(":", self.i):
                self.fail("expected ':' (shorthand, methods and computed keys are not literals)")
            self.i += 1
            if key in out:
                self.fail(f"duplicate key {key!r}")
            out[key] = self.value()
            self.ws()
            if self.t.startswith(",", self.i):
                self.i += 1
            elif not self.t.startswith("}", self.i):
                self.fail("expected , or }")

    def string(self) -> str:
        quote = self.t[self.i]
        self.i += 1
        out = []
        while True:
            if self.i >= len(self.t):
                self.fail("unterminated string")
            c = self.t[self.i]
            if c == quote:
                self.i += 1
                break
            if quote == "`" and self.t.startswith("${", self.i):
                self.fail("template expression is not a literal")
            if c == "\n" and quote != "`":
                self.fail("line break inside a string")
            if c == "\\":
                n = self.t[self.i + 1]
                if n == "u":
                    if self.t[self.i + 2] == "{":
                        end = self.t.index("}", self.i)
                        out.append(chr(int(self.t[self.i + 3:end], 16)))
                        self.i = end + 1
                    else:
                        out.append(chr(int(self.t[self.i + 2:self.i + 6], 16)))
                        self.i += 6
                    continue
                if n == "x":
                    out.append(chr(int(self.t[self.i + 2:self.i + 4], 16)))
                    self.i += 4
                    continue
                out.append(_ESCAPES.get(n, n))
                self.i += 2
                continue
            out.append(c)
            self.i += 1
        text = "".join(out)
        # JavaScript strings are UTF-16: join surrogate pairs written as two \u escapes
        return text.encode("utf-16", "surrogatepass").decode("utf-16")


def leaves(value, path: str):
    if isinstance(value, dict):
        for k, v in value.items():
            yield from leaves(v, f"{path}.{k}" if path else k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from leaves(v, f"{path}[{i}]")
    else:
        yield path, value


class JsonDoc:
    kind = "html-json"

    def __init__(self, raw_bytes: bytes, name: str, wanted: list[str]):
        try:
            self.raw = raw_bytes.decode("utf-8")
        except UnicodeDecodeError as e:
            raise StageFail(f"{name}: not valid UTF-8 ({e})", check="S0.integrity")
        self.name, self.soup = name, BeautifulSoup(self.raw, "html.parser")
        self.ledger = Ledger()
        self.arrays: dict[str, list] = {}
        self.leaf_block: dict[str, int] = {}
        self.elements_seen = 0
        scripts = [s.string or "" for s in self.soup.find_all("script") if not s.get("src") and "json" not in (s.get("type") or "")]
        self.declared = []
        for text in scripts:
            for m in re.finditer(r"(?m)^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[", text):
                self.declared.append(m.group(1))
                if m.group(1) in wanted:
                    if m.group(1) in self.arrays:
                        raise StageFail(f"{name}: array {m.group(1)} is declared twice", check="S1.literals")
                    self.arrays[m.group(1)] = LiteralParser(text, m.end() - 1, m.group(1)).value()
        missing = [w for w in wanted if w not in self.arrays]
        if missing:
            raise StageFail(f"{name}: no top-level array literal named {missing}; the page declares {sorted(set(self.declared))}", check="S1.literals")
        n = 0
        for node in (self.soup.body or self.soup).find_all(string=True):
            if type(node) is NavigableString and str(node).strip() and not any(p.name in ("script", "style", "template", "svg") for p in node.parents):
                self.ledger.add_block("text", str(node), f"dom :: text[{n}]", dom=True)   # the page shell around the data
                n += 1
        for arr in wanted:
            for i, item in enumerate(self.arrays[arr]):
                self.elements_seen += 1
                for path, v in leaves(item, f"{arr}[{i}]"):
                    kind = "text" if isinstance(v, str) else "value"
                    self.leaf_block[path] = self.ledger.add_block(kind, v if isinstance(v, str) else repr(v) if v is not None else "null", path,
                                                                  value=None if isinstance(v, str) else v)


META_FIELDS = ("id", "type", "fields", "source", "tags", "topics", "difficulty", "number")


def _norm(path: str) -> str:
    return re.sub(r"\[\d+\]", "[]", path)


class JsonInterp:
    def __init__(self, doc: JsonDoc, run: Run):
        self.doc, self.run, self.ledger, self.profile = doc, run, doc.ledger, run.profile

    def get(self, obj, base: str, key: str):
        """Value at dotted `key` plus the ledger paths of every leaf below it."""
        node, path = obj, base
        for part in key.split("."):
            if not isinstance(node, dict) or part not in node:
                return None, []
            node, path = node[part], f"{path}.{part}"
        return node, [p for p, _ in leaves(node, path)]

    def claim(self, paths, q, field, mode, shared=False):
        for p in paths:
            self.ledger.claim(self.doc.leaf_block[p], q, field, mode, shared)

    def text(self, value, spec, where: str, field: str) -> str:
        if not isinstance(value, str):
            raise StageFail(f"{field}: expected text, found {type(value).__name__}", locator=where, check="S2.type")
        if spec.get("as", "markdown_text") == "raw":
            return value
        md = esc_lines(value)
        if "\n" in value:
            if spec.get("newline") != "hard_break":
                raise StageFail(f"{field}: the text has a line break but the profile does not say how the page shows it", locator=where,
                                check="S2.content", hint="set newline: hard_break if the page shows line breaks (white-space: pre-line)")
            md = md.replace("\n", "\\\n")
        return md

    def value(self, spec: dict, obj: dict, base: str, q: str, field: str, values: dict, qtype: str | None, options=None):
        where = base
        if "by_type" in spec:
            chosen = spec["by_type"].get(qtype, spec["by_type"].get("default"))
            if chosen is None:
                raise StageFail(f"{field}: no rule for question type {qtype!r}", locator=where, check="S2.fields")
            return self.value({**{k: v for k, v in spec.items() if k != "by_type"}, **chosen}, obj, base, q, field, values, qtype, options)
        if "when_key" in spec:
            wk = spec["when_key"]
            actual, _ = self.get(obj, base, wk["key"])
            if ("equals" in wk and actual != wk["equals"]) or ("not_equals" in wk and actual == wk["not_equals"]):
                return None
        if "compose" in spec:
            pieces = []
            for item in spec["compose"]:
                if item.get("when_type") and item["when_type"] != qtype:
                    continue
                v, paths = self.get(obj, base, item["key"])
                if v in (None, ""):
                    if item.get("required"):
                        raise StageFail(f"{field}: {item['key']} is empty", locator=where, check="S2.fields")
                    continue
                self.claim(paths, q, field, "verbatim", True)
                label = item.get("label", "")
                if label:
                    self.ledger.add_literal(q, field, label, "heading declared in the profile")
                pieces.append(label + self.text(v, item, where, field))
            return spec.get("join", "\n\n").join(pieces) or None
        derived = True
        if "const" in spec:
            value = spec["const"]
        elif "var" in spec:
            value = values.get(spec["var"])
        elif "template" in spec:
            value = render_template(spec["template"], values, where)
        else:
            value, paths = self.get(obj, base, spec["key"])
            if value in (None, "", []):
                if spec.get("optional"):
                    return None
                raise StageFail(f"{field}: {spec['key']} is missing or empty", locator=where, check="S2.fields")
            if spec.get("option_letter"):
                self.claim(paths, q, field, "derived")
                wanted = value if isinstance(value, list) else [value]
                if isinstance(value, list) != bool(spec.get("sort")):
                    raise StageFail(f"{field}: answer shape does not fit the question type {qtype}", locator=where, check="S2.answers")
                letters = []
                for w in wanted:
                    hit = [o["label"] for o in options or [] if o["_value"] == w]
                    if len(hit) != 1:
                        raise StageFail(f"{field}: answer {w!r} matches {len(hit)} options", locator=where, check="S2.answers",
                                        hint="multiple-choice letters must lie within the option range")
                    letters.append(hit[0])
                return sorted(letters) if spec.get("sort") else letters[0]
            plain = not any(k in spec for k in ("regex", "map")) and spec.get("as") not in ("int", "number")
            if isinstance(value, list) and field.split(".")[0] not in META_FIELDS:
                if not all(isinstance(v, str) for v in value) or spec.get("as") != "raw":
                    raise StageFail(f"{field}: a list value needs as: raw and text items", locator=where, check="S2.type")
                self.claim(paths, q, field, "verbatim", spec.get("shared", False))
                return list(value)
            if field.split(".")[0] in META_FIELDS or field.startswith("var."):
                # labels and provenance copied into metadata: conserved, but the same value may feed several fields
                self.claim(paths, q, field, "derived")
                if isinstance(value, list):
                    return list(value)
            elif isinstance(value, str) and plain and spec.get("as") in (None, "markdown_text", "raw"):
                self.claim(paths, q, field, "verbatim", spec.get("shared", False))
                value, derived = self.text(value, spec, where, field), False
            else:
                self.claim(paths, q, field, "derived")
        if value is None:
            return None
        if "regex" in spec:
            value = apply_regex(spec["regex"], str(value), where, field)
        if "map" in spec:
            value = apply_map(self.run, spec["map"], value, where, field)
        if derived:
            self.run.decisions["derived_fields"][field] = self.run.decisions["derived_fields"].get(field, 0) + 1
        return coerce(value, spec.get("as"), where, field)

    def questions(self) -> tuple[list[dict], str | None]:
        profile, seg = self.profile, self.profile["segment"]
        items = [(arr, i, obj) for arr in seg["arrays"] for i, obj in enumerate(self.doc.arrays[arr])]
        if "order_by" in seg:   # the page's own display order
            order = seg["order_by"]["values"]
            for arr, i, obj in items:
                if obj.get(seg["order_by"]["key"]) not in order:
                    raise StageFail(f"{seg['order_by']['key']} {obj.get(seg['order_by']['key'])!r} is not in segment.order_by.values", locator=f"{arr}[{i}]", check="S2.segment")
            items.sort(key=lambda t: order.index(t[2][seg["order_by"]["key"]]))
        rules = profile["ignore"]
        for i, rule in enumerate(rules):
            self.ledger.rules.append({"index": i, "rule": {k: rule[k] for k in ("key", "dom") if k in rule}, "reason": rule["reason"],
                                      "max_blocks": rule["max_blocks"], "max_tokens": rule["max_tokens"]})
        out, numbers = [], []
        for pos, (arr, i, obj) in enumerate(items, start=1):
            base = f"{arr}[{i}]"
            if not isinstance(obj, dict):
                raise StageFail("array item is not an object", locator=base, check="S2.segment")
            nspec = seg["number"]
            if nspec.get("position"):
                number = str(pos)
            else:
                raw, npaths = self.get(obj, base, nspec["key"])
                number = apply_regex(nspec["regex"], str(raw), base, "number") if "regex" in nspec else str(raw)
            values = {"number": number, "position": pos, "array": arr}
            fields = profile["fields"]
            qid = str(self.value(fields["id"], obj, base, "?", "id", values, None)) if "id" in fields else f"q{number}"
            for c in [c for cl in self.ledger.claims.values() for c in cl if c["q"] == "?"]:
                c["q"] = qid
            if not nspec.get("position"):
                self.claim(npaths, qid, "number", "derived")
            values["qid"] = qid
            for name, spec in profile.get("vars", {}).items():
                values[name] = self.value(spec, obj, base, qid, f"var.{name}", values, None)
            q: dict = {"id": qid, "number": number}
            qtype = self.value(fields["type"], obj, base, qid, "type", values, None) if "type" in fields else None
            if qtype:
                q["type"] = qtype
            options = None
            if "options" in fields and (qtype or "").startswith("mcq"):
                ospec = fields["options"]
                raw_opts, _ = self.get(obj, base, ospec["key"])
                if not isinstance(raw_opts, list) or not raw_opts:
                    raise StageFail("options are missing", locator=base, check="S2.fields")
                tkey, vkey = ospec["list_of"]
                options = []
                for k, o in enumerate(raw_opts):
                    label = chr(65 + k)
                    obase = f"{base}.{ospec['key']}[{k}]"
                    self.claim([f"{obase}.{tkey}"], qid, f"options.{label}", "verbatim")
                    self.claim([f"{obase}.{vkey}"], qid, f"options.{label}", "derived")
                    options.append({"label": label, "text": self.text(o[tkey], ospec, obase, "options"), "_value": o[vkey]})
                if len({repr(o["_value"]) for o in options}) != len(options):
                    raise StageFail("two options share a value", locator=base, check="S2.answers")
            for fname, spec in fields.items():
                if fname in ("id", "type", "options"):
                    continue
                specs = spec if isinstance(spec, list) else [spec]
                got = [v for v in (self.value(one, obj, base, qid, fname, values, qtype, options) for one in specs) if v is not None]
                if fname in ("topics", "hints", "tags"):
                    if got:
                        set_path(q, fname, got)
                elif got:
                    set_path(q, fname, got[0])
                elif not any(o.get("optional") or "when_key" in o for o in specs):
                    raise StageFail(f"required field {fname} is empty", locator=base, check="S2.fields")
            if options:
                q["options"] = [{"label": o["label"], "text": o["text"]} for o in options]
            self.run.containers[qid] = base
            out.append(finish_question(q, None, profile))
            numbers.append(number)
        check_numbering(numbers, seg["numbering"], ",".join(seg["arrays"]))
        for b in self.ledger.blocks:   # ignore rules take what no field claimed
            if b["id"] in self.ledger.claims:
                continue
            if b.get("dom"):
                for i, rule in enumerate(rules):
                    if rule.get("dom") == "all":
                        self.ledger.ignore(b["id"], i, rule["reason"])
                        break
                continue
            rel = _norm(b["locator"].split(".", 1)[1]) if "." in b["locator"] else ""
            for i, rule in enumerate(rules):
                if "key" in rule and (rel == rule["key"] or rel.startswith(rule["key"] + ".") or rel.startswith(rule["key"] + "[")):
                    self.ledger.ignore(b["id"], i, rule["reason"])
                    break
        return out, None
