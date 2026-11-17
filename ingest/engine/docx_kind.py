"""Word (.docx) adapter (S1) and numbered-paragraph interpreter (S2).

The archive and its XML are hostile input (R13): size and path checks first, any DTD or entity declaration is
refused, and nothing in the file is ever executed.
"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET

from htmlmd import esc, esc_lines, guard_line_starts, tidy
from interp import Run, apply_map, apply_regex, check_numbering, coerce, finish_question, render_template, set_path
from ledger import Ledger
from spec import rx
from util import StageFail

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
MAX_ENTRIES, MAX_TOTAL, MAX_RATIO = 2000, 200 * 1024 * 1024, 200
SIDE_PARTS = re.compile(r"word/(header|footer|footnotes|endnotes|comments)\d*\.xml$")
CONSTRUCTS = {f"{W}drawing": "image", f"{W}pict": "image", f"{W}object": "embedded object", f"{M}oMath": "equation", f"{M}oMathPara": "equation",
              f"{W}ins": "tracked insertion", f"{W}del": "tracked deletion", f"{W}commentReference": "comment",
              f"{W}footnoteReference": "footnote", f"{W}endnoteReference": "endnote", f"{W}numPr": "automatic numbering",
              f"{W}fldSimple": "field", f"{W}instrText": "field", f"{W}hyperlink": "hyperlink", f"{W}sdt": "content control"}


def open_archive(data: bytes, name: str) -> dict[str, bytes]:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise StageFail(f"{name}: not a readable zip archive ({e})", check="S0.integrity")
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        raise StageFail(f"{name}: {len(infos)} archive entries (limit {MAX_ENTRIES})", check="S0.integrity")
    total = 0
    for i in infos:
        if i.filename.startswith("/") or ".." in i.filename.split("/") or "\\" in i.filename:
            raise StageFail(f"{name}: unsafe archive path {i.filename!r}", check="S0.integrity")
        total += i.file_size
        if i.compress_size and i.file_size / max(1, i.compress_size) > MAX_RATIO and i.file_size > 1 << 20:
            raise StageFail(f"{name}: {i.filename} expands {i.file_size // max(1, i.compress_size)}x (archive bomb guard)", check="S0.integrity")
    if total > MAX_TOTAL:
        raise StageFail(f"{name}: archive expands to {total} bytes (limit {MAX_TOTAL})", check="S0.integrity")
    bad = z.testzip()
    if bad:
        raise StageFail(f"{name}: CRC error in {bad}", check="S0.integrity")
    return {i.filename: z.read(i.filename) for i in infos if not i.is_dir()}


def parse_xml(data: bytes, part: str) -> ET.Element:
    head = data[:4096].lower()
    if b"<!doctype" in data.lower() or b"<!entity" in data.lower():
        raise StageFail(f"{part}: DTD or entity declaration refused (entity-expansion guard)", check="S0.integrity")
    del head
    try:
        return ET.fromstring(data)
    except ET.ParseError as e:
        raise StageFail(f"{part}: not well-formed XML ({e})", check="S0.integrity")


class DocxDoc:
    kind = "docx"

    def __init__(self, raw_bytes: bytes, name: str):
        self.name = name
        self.parts = open_archive(raw_bytes, name)
        if "word/document.xml" not in self.parts:
            raise StageFail(f"{name}: no word/document.xml: not a Word document", check="S0.integrity")
        self.ledger = Ledger()
        self.paragraphs: list[dict] = []      # block id, style, runs, text
        self.elements_seen = 0
        self.style_names = self._style_names()
        root = parse_xml(self.parts["word/document.xml"], "word/document.xml")
        for part in sorted(self.parts):
            if part.endswith(".xml") and part != "word/document.xml":
                parse_xml(self.parts[part], part)   # well-formedness of every part (S0)
        body = root.find(f"{W}body")
        n = 0
        for child in list(body) if body is not None else []:
            self.elements_seen += 1
            if child.tag == f"{W}p":
                n += 1
                self._paragraph(child, f"body/p[{n}]")
            elif child.tag == f"{W}tbl":
                text = " ".join(t.text or "" for t in child.iter(f"{W}t"))
                self.ledger.add_block("unsupported", text, f"body/tbl[{n + 1}]", construct="table")
            elif child.tag != f"{W}sectPr":
                self.ledger.add_block("unsupported", "", f"body/{child.tag.split('}')[-1]}", construct=child.tag.split("}")[-1])
        for part in sorted(self.parts):
            if SIDE_PARTS.match(part):
                side = parse_xml(self.parts[part], part)
                for k, p in enumerate(side.iter(f"{W}p"), start=1):
                    text = "".join(t.text or "" for t in p.iter(f"{W}t"))
                    if text.strip():
                        self.ledger.add_block("text", text, f"{part}/p[{k}]", style=f"({part.split('/')[-1].rstrip('0123456789.xml')})")

    def _style_names(self) -> dict[str, str]:
        if "word/styles.xml" not in self.parts:
            return {}
        out = {}
        for s in parse_xml(self.parts["word/styles.xml"], "word/styles.xml").iter(f"{W}style"):
            name = s.find(f"{W}name")
            out[s.get(f"{W}styleId")] = name.get(f"{W}val") if name is not None else s.get(f"{W}styleId")
        return out

    def _paragraph(self, p: ET.Element, locator: str) -> None:
        ppr = p.find(f"{W}pPr")
        style_el = ppr.find(f"{W}pStyle") if ppr is not None else None
        style = style_el.get(f"{W}val") if style_el is not None else "Normal"
        constructs = sorted({CONSTRUCTS[e.tag] for e in p.iter() if e.tag in CONSTRUCTS})
        runs = []
        for r in p.iter(f"{W}r"):
            text = ""
            for e in r:
                if e.tag == f"{W}t":
                    text += e.text or ""
                elif e.tag == f"{W}tab":
                    text += "\t"
                elif e.tag in (f"{W}br", f"{W}cr"):
                    text += "\n"
            rpr = r.find(f"{W}rPr")
            flags = set()
            if rpr is not None:
                for tag, flag in (("b", "bold"), ("i", "italic"), ("u", "underline"), ("strike", "strike"), ("highlight", "highlight")):
                    e = rpr.find(f"{W}{tag}")
                    if e is not None and e.get(f"{W}val") not in ("0", "false", "none"):
                        flags.add(flag)
                va = rpr.find(f"{W}vertAlign")
                if va is not None and va.get(f"{W}val") in ("superscript", "subscript"):
                    flags.add(va.get(f"{W}val")[:3])
            if text:
                runs.append({"text": text, "flags": sorted(flags)})
        text = "".join(r["text"] for r in runs)
        if not text.strip() and not constructs:
            return
        kind = "unsupported" if constructs else "text"
        extra = {"style": style, "style_name": self.style_names.get(style, style)}
        if constructs:
            extra["construct"] = ", ".join(constructs)
        bid = self.ledger.add_block(kind, text, locator, **extra)
        self.paragraphs.append({"block": bid, "style": style, "runs": runs, "text": text, "locator": locator, "kind": kind})


def runs_markdown(runs: list[dict], start: int, formatting: dict, run: Run, locator: str) -> str:
    """Markdown for the paragraph text from character `start` on, keeping run formatting."""
    out, pos = [], 0
    for r in runs:
        text, begin = r["text"], pos
        pos += len(text)
        if pos <= start:
            continue
        if begin < start:
            text = text[start - begin:]
        md = esc(text)
        for flag in r["flags"]:
            if flag in ("bold", "italic"):
                mark = "**" if flag == "bold" else "*"
                md = f"{mark}{md.strip()}{mark}" + (" " if md.endswith(" ") else "") if md.strip() else md
            elif flag in ("sup", "sub"):
                md = f"<{flag}>{md}</{flag}>"
            else:
                policy = formatting.get(flag)
                if not policy:
                    raise StageFail(f"the source uses {flag} but the profile has no formatting.{flag} policy", locator=locator, check="S2.formatting",
                                    hint=f"add formatting.{flag}: preserve or ignore with a reason")
                run.note_format(flag, policy["policy"])
                if policy["policy"] == "preserve":
                    tag = {"underline": "u", "strike": "s", "highlight": "mark"}[flag]
                    md = f"<{tag}>{md}</{tag}>"
        out.append(md)
    return "".join(out)


class DocxInterp:
    def __init__(self, doc: DocxDoc, run: Run):
        self.doc, self.run, self.ledger, self.profile = doc, run, doc.ledger, run.profile

    def questions(self) -> tuple[list[dict], str | None]:
        profile, seg = self.profile, self.profile["segment"]
        number_rx = rx(seg["number"]["regex"])
        fmt = profile.get("formatting", {})
        for i, rule in enumerate(profile["ignore"]):
            self.ledger.rules.append({"index": i, "rule": {k: rule[k] for k in ("style", "regex") if k in rule}, "reason": rule["reason"],
                                      "max_blocks": rule["max_blocks"], "max_tokens": rule["max_tokens"]})
        unsupported = [b for b in self.ledger.blocks if b["kind"] == "unsupported"]

        def ignorable(b) -> int | None:
            for i, rule in enumerate(profile["ignore"]):
                if "style" in rule and rx(rule["style"]).fullmatch(b.get("style", "")):
                    return i
                if "regex" in rule and rx(rule["regex"]).fullmatch(b["text"].strip()):
                    return i
            return None

        for b in unsupported:
            if ignorable(b) is None:
                raise StageFail(f"paragraph contains {b.get('construct')}, which this engine version does not convert", locator=b["locator"],
                                check="S2.unsupported", hint="ignore it with a reason if it carries no question content; otherwise use the manual pack route")
        # split into preamble and questions
        preamble, groups = [], []
        for p in self.doc.paragraphs:
            m = number_rx.match(p["text"]) if p["kind"] == "text" else None
            if m:
                groups.append({"number": m.group(1), "match": m, "p": p, "extra": []})
            elif not groups:
                preamble.append(p)
            else:
                if ignorable(self.ledger.blocks[p["block"]]) is not None:
                    continue
                if seg.get("continuation", "fail") == "fail":
                    raise StageFail(f"paragraph without a printed number after question {groups[-1]['number']}: {p['text'][:60]!r}", locator=p["locator"],
                                    check="S2.segment", hint="set segment.continuation: append if such paragraphs belong to the question above, or ignore them with a reason")
                groups[-1]["extra"].append(p)
        title, title_spec = None, profile.get("pack", {}).get("title")
        used_preamble = set()
        if title_spec:
            hits = [p for p in preamble if rx(title_spec["style"]).fullmatch(p["style"])]
            if len(hits) != 1:
                raise StageFail(f"pack.title: {len(hits)} paragraphs before the first question have style {title_spec['style']!r}, expected one",
                                locator="body", check="S2.select")
            title = hits[0]["text"].strip()
            self.ledger.claim(hits[0]["block"], None, "pack.title")
            used_preamble.add(hits[0]["block"])
        out, numbers = [], []
        for pos, g in enumerate(groups, start=1):
            p, number = g["p"], g["number"]
            id_spec = profile["fields"].get("id")
            values = {"number": number, "position": pos}
            qid = render_template(id_spec["template"], values, p["locator"]) if id_spec else f"q{number}"
            values["qid"] = qid
            q = {"id": qid, "number": number}
            for fname, spec in profile["fields"].items():
                if fname == "id":
                    continue
                where = p["locator"]
                if spec.get("paragraph") == "self":
                    start = g["match"].end() if spec.get("strip_number") else 0
                    md = runs_markdown(p["runs"], start, fmt, self.run, where)
                    self.ledger.claim(p["block"], qid, fname)
                    if start:
                        self.ledger.strip_prefix(qid, fname, g["match"].group(0), "printed question number, stored as the question's number")
                    for extra in g["extra"]:
                        md += "\n\n" + runs_markdown(extra["runs"], 0, fmt, self.run, extra["locator"])
                        self.ledger.claim(extra["block"], qid, fname)
                    value = guard_line_starts(tidy(md))
                elif "preamble" in spec:
                    cand = [x for x in preamble if x["block"] not in {b for b in used_preamble if b != x["block"]} or True]
                    idx = spec["preamble"]["index"]
                    rest = [x for x in preamble if not (title_spec and rx(title_spec["style"]).fullmatch(x["style"]))]
                    del cand
                    if idx >= len(rest):
                        if spec.get("optional"):
                            continue
                        raise StageFail(f"{fname}: the source has no paragraph {idx} before the first question", locator="body", check="S2.select")
                    src = rest[idx]
                    if "style" in spec["preamble"] and not rx(spec["preamble"]["style"]).fullmatch(src["style"]):
                        raise StageFail(f"{fname}: paragraph before the first question has style {src['style']!r}, profile expects {spec['preamble']['style']!r}",
                                        locator=src["locator"], check="S2.select")
                    self.ledger.claim(src["block"], qid, fname, "verbatim", True)
                    used_preamble.add(src["block"])
                    prefix = spec.get("prefix", "")
                    if prefix:
                        self.ledger.add_literal(qid, fname, prefix, "prefix declared in the profile")
                    value = esc_lines(prefix + src["text"].strip())
                else:
                    if "const" in spec:
                        value = spec["const"]
                    elif "var" in spec:
                        value = values[spec["var"]]
                    elif "template" in spec:
                        value = render_template(spec["template"], values, where)
                    else:
                        raise StageFail(f"field {fname}: this source kind supports paragraph / preamble / template / var / const", check="lint.shape")
                    if "regex" in spec:
                        value = apply_regex(spec["regex"], str(value), where, fname)
                    if "map" in spec:
                        value = apply_map(self.run, spec["map"], value, where, fname)
                    value = coerce(value, spec.get("as"), where, fname)
                    self.run.decisions["derived_fields"][fname] = self.run.decisions["derived_fields"].get(fname, 0) + 1
                if value in (None, ""):
                    if spec.get("optional"):
                        continue
                    raise StageFail(f"required field {fname} is empty", locator=where, check="S2.fields")
                set_path(q, fname, value)
            self.run.containers[qid] = p["locator"]
            out.append(finish_question(q, None, profile))
            numbers.append(number)
        check_numbering(numbers, seg["numbering"], "body")
        # ignore rules take whatever is left and matches
        for b in self.ledger.blocks:
            if b["id"] not in self.ledger.claims:
                i = ignorable(b)
                if i is not None:
                    self.ledger.ignore(b["id"], i, profile["ignore"][i]["reason"])
        return out, title
