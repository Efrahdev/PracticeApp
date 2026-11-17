"""S2 for page sources (PDF, scans, images, screenshots, Office and printed HTML).

Two segmenters:
  lines@1 - pages with a text layer. A question starts at a line matching `segment.start`; it runs until the
            next start. Inside it, an inline solution starts at `answers.inline.start`. After `segment.end`, an
            answer section is read entry by entry and joined to the questions by number.
  units@1 - pages without text (scans, photos, screenshots). The job lists, for each question, the ink bands
            (units) it covers; the probe draws those units with their ids on the page images for the AI.

Every question keeps an exact picture of its region (a crop of the page rendering). The words are used as
text only where they can be trusted (`display`); otherwise the learner sees the picture. Nothing is redrawn.
"""
from __future__ import annotations

import base64
import re

from htmlmd import esc, esc_lines
from interp import Run, apply_map, apply_regex, check_numbering, coerce, render_template, set_path
from spec import rx
from util import StageFail, sha256_bytes

PAD = 4.0   # points of white space kept around a crop


def _y(b):
    return b["box"][1]


class PageInterp:
    def __init__(self, doc, run: Run):
        self.doc, self.run, self.ledger, self.profile = doc, run, doc.ledger, run.profile
        self.reasons: dict[int, str] = {}

    # ------------------------------------------------------------------ ignore rules
    def _ignored_by(self, b: dict) -> int | None:
        w, h = self.doc.size[b["page"]]
        for i, rule in enumerate(self.profile["ignore"]):
            if "pages" in rule and b["page"] in _pages(rule["pages"]):
                return i
            if "band" in rule:
                top, bottom = rule["band"]["top"] * h, rule["band"]["bottom"] * h
                if top <= _y(b) and b["box"][3] <= bottom + 0.5:
                    return i
            if rule.get("rotated") and b["kind"] == "rotated":
                return i
            if "regex" in rule and b["kind"] == "line" and rx(rule["regex"]).search(b["text"].strip()):
                return i
            if "units" in rule and b["locator"] in rule["units"]:
                return i
        return None

    def _intro_rule(self) -> int:
        if not hasattr(self, "_intro_idx"):
            self._intro_idx = len(self.ledger.rules)
            self.ledger.rules.append({"index": self._intro_idx, "rule": {"builtin": "heading_intro"},
                                      "reason": "built-in: the introduction printed under a section heading or an answer-section heading",
                                      "max_blocks": 100000, "max_tokens": 1000000})
        return self._intro_idx

    def _prepare(self) -> list[dict]:
        rules = self.profile["ignore"]
        for i, rule in enumerate(rules):
            self.ledger.rules.append({"index": i, "rule": {k: rule[k] for k in ("pages", "band", "regex", "rotated", "units") if k in rule},
                                      "reason": rule["reason"], "max_blocks": rule["max_blocks"], "max_tokens": rule["max_tokens"]})
        speck_rule = len(rules)
        self.ledger.rules.append({"index": speck_rule, "rule": {"builtin": "speck"}, "reason": "built-in: specks of ink too small to carry content "
                                  "(rules, dots, answer-blank lines); any inside a question region are still in its picture",
                                  "max_blocks": 100000, "max_tokens": 0})
        live = []
        for b in self.ledger.blocks:
            if b["kind"] == "speck":
                self.ledger.ignore(b["id"], speck_rule, self.ledger.rules[speck_rule]["reason"])
                continue
            i = self._ignored_by(b)
            if i is not None:
                self.ledger.ignore(b["id"], i, rules[i]["reason"])
            else:
                live.append(b)
        live.sort(key=lambda b: (b["page"], b["col"], round(_y(b), 1), b["box"][0]))
        return live

    # ------------------------------------------------------------------ geometry
    def _column_bounds(self, page: int, col: int) -> tuple[float, float]:
        xs = [b["box"] for b in self.doc.blocks_on(page) if b.get("col") == col and b["kind"] in ("line", "graphic", "band")]
        if not xs:
            w, _ = self.doc.size[page]
            return 0.0, w
        return min(x[0] for x in xs), max(x[2] for x in xs)

    def _regions(self, units: list[dict]) -> list[tuple[int, list[float]]]:
        """One crop box per (page, column) the units occupy, in reading order."""
        groups: dict[tuple[int, int], list[dict]] = {}
        for u in units:
            groups.setdefault((u["page"], u["col"]), []).append(u)
        out = []
        for (page, col), us in sorted(groups.items()):
            w, h = self.doc.size[page]
            left, right = self._column_bounds(page, col)
            top = min(u["box"][1] for u in us) - PAD
            bottom = max(u["box"][3] for u in us) + PAD
            out.append((page, [max(0.0, left - PAD), max(0.0, top), min(w, right + PAD), min(h, bottom)]))
        return out

    def _crops(self, q: str, field: str, units: list[dict], alt: str) -> list[str]:
        md = []
        for page, box in self._regions(units):
            png, px = self.doc.crop_png(page, box)
            name = "img-" + sha256_bytes(png)[:16]
            self.run.assets[name] = {"type": "image/png", "base64": base64.b64encode(png).decode("ascii")}
            self.run.asset_rows.append({"asset": name, "question": q, "field": field, "page": page, "box": [round(v, 2) for v in box], "pixels": px,
                                        "dpi": self.doc.dpi, "packaged_sha256": sha256_bytes(png), "locator": f"p{page}"})
            md.append(f"![{alt} (page {page})](asset:{name})")
        return md

    # ------------------------------------------------------------------ text helpers
    def _uncertain(self, units: list[dict]) -> list[str]:
        why = set()
        for u in units:
            if u["kind"] in ("graphic", "band"):
                why.add("has a figure or drawing")
            for r in u.get("uncertain", []):
                why.add(r)
        lines = [u for u in units if u["kind"] == "line"]
        if lines:
            by_page: dict[tuple[int, int], list] = {}
            for u in lines:
                by_page.setdefault((u["page"], u["col"]), []).append(u)
            for (page, col), us in by_page.items():
                left, right = self._column_bounds(page, col)
                width = max(1.0, right - left)
                margin = min(u["box"][0] for u in us)
                for u in us:
                    if u["box"][0] - margin > 0.45 * width and len(u["text"]) < 25:
                        why.add("text placed beside the question (figure labels or a stacked layout)")
        return sorted(why)

    BREAK_BEFORE = re.compile(r"^(?:[•●▪◦·\-–—*]\s|\(?[ivx]+\)\s|[A-Z][A-Za-z ]{1,30}:(?:\s|$))")
    LS = "\u2028"   # a line break decided by _join; turned into a Markdown hard break after escaping

    def _join(self, lines: list[dict]) -> str:
        """Wrapped lines become one paragraph. A clear vertical gap starts a new paragraph; a line that starts with
        a bullet or a short label ("Why:", "Principle:") starts a new line. Only spaces and line breaks are
        decided here: every word is kept, in order."""
        brk = rx(self.profile["text"]["break_before"]) if self.profile.get("text", {}).get("break_before") else self.BREAK_BEFORE
        out, prev = "", None
        for u in lines:
            t = u["text"].strip()
            if prev is None:
                out = t
            else:
                height = max(1.0, prev["box"][3] - prev["box"][1])
                gap = u["box"][1] - prev["box"][3]
                if gap > 1.2 * height or u["page"] != prev["page"] and gap > 1.2 * height:
                    out += "\n\n" + t
                elif brk.match(t):
                    out += self.LS + t
                else:
                    out += " " + t
            prev = u
        return out

    def _md(self, text: str) -> str:
        return "\\\n".join(esc_lines(part) for part in text.split(self.LS))

    def _split_options(self, text: str, qid: str, where: str):
        spec = self.profile.get("options")
        if not spec:
            return text, None
        pat = rx(spec["label"])
        hits = list(pat.finditer(text))
        # the options are the LAST run of labels that starts with the first label (A) and continues in order to the
        # end; label-like text earlier in the question ("compare (A) and (B)") stays in the stem
        if hits:
            first = hits[0].group(1)
            for k in range(len(hits) - 1, -1, -1):
                if hits[k].group(1) == first:
                    tail = [m.group(1) for m in hits[k:]]
                    if tail == [chr(ord(first) + i) for i in range(len(tail))]:
                        if k:
                            self.run.decisions.setdefault("labels_kept_in_stem", []).append({"question": qid, "labels": [m.group(1) for m in hits[:k]]})
                        hits = hits[k:]
                        break
        labels = [m.group(1) for m in hits]
        want = [chr(ord(labels[0]) + i) for i in range(len(labels))] if labels else []
        if len(hits) < 2:
            if spec.get("required"):
                raise StageFail(f"{qid}: no option labels found", locator=where, check="S2.options")
            return text, None
        if labels != want:
            raise StageFail(f"{qid}: option labels {labels} are not one sequence in order", locator=where, check="S2.options",
                            hint="the label pattern also matches text inside the question; make it stricter")
        stem = text[:hits[0].start()].rstrip()
        opts = []
        for k, m in enumerate(hits):
            end = hits[k + 1].start() if k + 1 < len(hits) else len(text)
            opts.append((m.group(1), m.group(0), text[m.end():end].strip()))   # empty: the option is a picture
        return stem, opts

    # ------------------------------------------------------------------ fields from templates
    def _meta(self, q: dict, values: dict, first_text: str, where: str) -> None:
        for fname, spec in self.profile["fields"].items():
            if fname == "id":
                continue
            specs = spec if isinstance(spec, list) else [spec]
            got = []
            for one in specs:
                if "template" in one:
                    v = render_template(one["template"], values, where)
                elif "var" in one:
                    v = values.get(one["var"])
                elif "const" in one:
                    v = one["const"]
                elif one.get("from") == "question_text":
                    m = rx(one["regex"]).search(first_text)
                    if not m:
                        if one.get("optional"):
                            continue
                        raise StageFail(f"{fname}: pattern {one['regex']!r} not found in {first_text[:60]!r}", locator=where, check="S2.regex")
                    v = m.group(1) if m.re.groups else m.group(0)
                else:
                    raise StageFail(f"field {fname}: page sources support template / var / const / from: question_text", check="lint.shape")
                if v is None:
                    continue
                if "regex" in one and one.get("from") != "question_text":
                    v = apply_regex(one["regex"], str(v), where, fname)
                if "map" in one:
                    v = apply_map(self.run, one["map"], v, where, fname)
                got.append(coerce(v, one.get("as"), where, fname))
                self.run.decisions["derived_fields"][fname] = self.run.decisions["derived_fields"].get(fname, 0) + 1
            if fname in ("topics", "hints", "tags"):
                if got:
                    set_path(q, fname, got)
            elif got:
                set_path(q, fname, got[0])

    # ------------------------------------------------------------------ build one question
    def _question(self, number: str, units: list[dict], sol_units: list[dict], start_match, position: int, answer_from_section=None,
                  transcribed: dict | None = None, heading=None) -> dict:
        where = units[0]["locator"] if units else f"#{number}"
        values = {"number": number, "position": position}
        if heading is not None:
            values["heading"] = heading.group(0).strip()
            for k, g in enumerate(heading.groups(), start=1):
                values[f"heading_{k}"] = (g or "").strip()
        id_spec = self.profile["fields"].get("id")
        qid = render_template(id_spec["template"], values, where) if id_spec else f"q{number}"
        values["qid"] = qid
        q: dict = {"id": qid, "number": number}
        lines = [u for u in units if u["kind"] == "line"]
        first_text = lines[0]["text"] if lines else ""
        display = self.profile.get("display", "auto")
        if number in {str(x) for x in self.run.job.get("pictures", [])}:
            display = "image"   # the job says this question's text cannot be trusted (for example the PDF libraries disagree)
        why = self._uncertain(units)
        as_image = display == "image" or (display == "auto" and why) or not lines
        if lines and start_match is not None:
            self.ledger.strip_prefix(qid, "stem", start_match.group(0), "printed question number, stored as the question's number")
        # options and stem from the text (also used for the answer letters when the picture is shown)
        text = self._join(lines)
        if start_match is not None and text.startswith(start_match.group(0).strip()):
            text = text[len(start_match.group(0).strip()):].lstrip()
        stem_text, opts = self._split_options(text, qid, where) if lines else (text, None)
        if opts and any(not body for _, _, body in opts) and display != "text":
            why = sorted(set(why) | {"options are pictures"})
            as_image = True
        elif opts and any(not body for _, _, body in opts):
            raise StageFail(f"{qid}: an option has no text (it is probably a picture) but display is text", locator=where, check="S2.options",
                            hint="use display: auto or image")
        if as_image:
            q["stem"] = "\n\n".join(self._crops(qid, "stem", units, f"Question {number}"))
            for u in units:
                self.ledger.claim(u["id"], qid, "stem", "asset")
            if why:
                self.run.decisions.setdefault("shown_as_picture", []).append({"question": qid, "why": why})
            if opts:
                q["options"] = [{"label": lab, "text": lab} for lab, _, _ in opts]
                self.ledger.add_literal(qid, "options", " ".join(lab for lab, _, _ in opts), "option letters for a question shown as a picture")
            if text:
                q.setdefault("source", {})["text"] = text.replace(self.LS, "\n")
            if self.profile.get("keep_text") and text:
                set_path(q, f"fields.{self.profile['keep_text']}", self._md(text))
        else:
            q["stem"] = self._md(stem_text)
            for u in units:
                self.ledger.claim(u["id"], qid, "stem" if u["kind"] == "line" else "stem", "verbatim" if u["kind"] == "line" else "asset")
            if opts:
                q["options"] = [{"label": lab, "text": self._md(body)} for lab, _, body in opts]
                for lab, raw, _ in opts:
                    self.ledger.strip_prefix(qid, f"options.{lab}", raw, "printed option label, stored as the option's label")
                self.ledger.group(qid, "stem", ["stem"] + [f"options.{lab}" for lab, _, _ in opts])
        if transcribed and transcribed.get("options") and not q.get("options"):
            # a scanned multiple-choice question: the options are in the picture; the job names their letters
            m = re.fullmatch(r"([A-Za-z])\s*-\s*([A-Za-z])", str(transcribed["options"]).strip())
            labels = [chr(c) for c in range(ord(m.group(1)), ord(m.group(2)) + 1)] if m else [str(x) for x in transcribed["options"]]
            q["options"] = [{"label": lab, "text": lab} for lab in labels]
            self.ledger.add_literal(qid, "options", " ".join(labels), "option letters for a question shown as a picture (from the job)")
        letters = {o["label"] for o in q.get("options", [])}

        # ---- answer and solution
        ans_cfg = self.profile.get("answers", {})
        if sol_units:
            inline = ans_cfg["inline"]
            sol_lines = [u for u in sol_units if u["kind"] == "line"]
            head = sol_lines[0]["text"] if sol_lines else ""
            m = rx(inline["answer"]).search(head) if "answer" in inline else None
            if "answer" in inline and not m:
                raise StageFail(f"{qid}: the solution line {head[:60]!r} does not match answers.inline.answer", locator=sol_units[0]["locator"], check="S2.answers")
            if m:
                q["answer"] = self._answer_value(m.group(1), letters, qid, sol_units[0]["locator"])
                q.setdefault("solution", {})["answer"] = esc_lines(m.group(1))
            sol_why = self._uncertain(sol_units)
            if display == "image" or (display == "auto" and sol_why):
                q.setdefault("solution", {})["explanation"] = "\n\n".join(self._crops(qid, "solution.explanation", sol_units, f"Solution {number}"))
                for u in sol_units:
                    self.ledger.claim(u["id"], qid, "solution.explanation", "asset")
            else:
                body = self._join(sol_lines)
                q.setdefault("solution", {})["explanation"] = self._md(body)
                for u in sol_units:
                    self.ledger.claim(u["id"], qid, "solution.explanation", "verbatim" if u["kind"] == "line" else "asset")
            if m and sol_lines:
                self.ledger.claim(sol_lines[0]["id"], qid, "solution.answer", "derived")
                self.ledger.claim(sol_lines[0]["id"], qid, "answer", "derived")
        if answer_from_section:
            entry = answer_from_section
            q["answer"] = self._answer_value(entry["answer"], letters, qid, entry["where"])
            q.setdefault("solution", {})["answer"] = esc_lines(entry["answer"])
            if entry.get("explanation"):
                q["solution"]["explanation"] = self._md(entry["explanation"])
            for bid in entry["answer_blocks"]:
                self.ledger.claim(bid, qid, "solution.answer", "verbatim")
                self.ledger.claim(bid, qid, "answer", "derived")
            if entry.get("label"):
                self.ledger.strip_prefix(qid, "solution.answer", entry["label"], "label of the answer line (for example 'Correct answer:')")
            for bid in entry["explanation_blocks"]:
                self.ledger.claim(bid, qid, "solution.explanation")
        if transcribed:
            if transcribed.get("answer") is not None:
                q["answer"] = self._answer_value(str(transcribed["answer"]), letters, qid, where)
                q.setdefault("solution", {})["answer"] = esc(str(transcribed["answer"]))
                for f in ("answer", "solution.answer"):
                    self.ledger.transcribed.append({"q": qid, "field": f, "text": str(transcribed["answer"])})
            if transcribed.get("text"):
                set_path(q, "fields.Transcription (unverified)", esc(transcribed["text"]))
                self.ledger.transcribed.append({"q": qid, "field": "fields.Transcription (unverified)", "text": transcribed["text"]})
            q.setdefault("source", {})["transcribed"] = True
        if q.get("options"):
            q["type"] = "mcq_multi" if isinstance(q.get("answer"), list) else "mcq_single"
        elif isinstance(q.get("answer"), dict):
            q["type"] = "numeric"
        else:
            q["type"] = self.profile.get("defaults", {}).get("type", "open")
        q.setdefault("source", {})["display"] = "picture" if as_image else "text"
        self._meta(q, values, first_text, where)
        self.run.containers[qid] = where
        return q

    def _answer_value(self, raw: str, letters: set, qid: str, where: str):
        """A multiple-choice answer is the option letter(s) the answer starts with: "(B)", "B", "(A) takes",
        "(A) and (C)". Anything that does not name existing options stops the run."""
        raw = raw.strip()
        if letters:
            found = re.match(r"^\s*\(?([A-Z])\)?(?=[\s.,;:]|$)((?:\s*(?:,|and|&)\s*\(?[A-Z]\)?(?=[\s.,;:]|$))*)", raw)
            if not found:
                raise StageFail(f"{qid}: answer {raw[:40]!r} does not start with an option letter", locator=where, check="S2.answers",
                                hint="multiple-choice answers must name an option that exists")
            picked = [found.group(1)] + re.findall(r"\(?([A-Z])\)?", found.group(2) or "")
            bad = [x for x in picked if x not in letters]
            if bad:
                raise StageFail(f"{qid}: answer names option(s) {bad} that do not exist (options {sorted(letters)})", locator=where, check="S2.answers")
            return sorted(set(picked)) if len(picked) > 1 else picked[0]
        return esc_lines(raw)

    # ------------------------------------------------------------------ segmenters
    def questions(self):
        seg = self.profile["segment"]
        live = self._prepare()
        if seg["by"].startswith("units"):
            return self._by_units(live), None
        ignored_pages = {p for r in self.profile["ignore"] if "pages" in r for p in _pages(r["pages"])}
        bad = [p for p in self.doc.page_numbers if p not in self.doc.text_pages and p not in ignored_pages]
        if bad:
            raise StageFail(f"page(s) {bad[:10]} have no text layer (scanned)", locator=f"p{bad[0]}", check="S1.scanned",
                            hint="use the scan route (kind: scan, segment.by: units@1) for those pages in a separate job, or ignore them with a reason")
        start, end = rx(seg["start"]), rx(seg["end"]) if seg.get("end") else None
        heading = rx(seg["heading"]) if seg.get("heading") else None
        current_heading, in_heading = None, False
        inline = self.profile.get("answers", {}).get("inline")
        inline_start = rx(inline["start"]) if inline else None
        groups, section_lines, in_section = [], [], False
        for u in live:
            if u["kind"] == "line" and end and not in_section and end.search(u["text"]):
                in_section = True
                self.ledger.claim(u["id"], None, "answers.heading", "derived")
                continue
            if in_section:
                section_lines.append(u)
                continue
            hm = heading.search(u["text"]) if heading and u["kind"] == "line" else None
            if hm:   # a section heading: its words become vars ({heading_1} ...), its introduction is not question text
                current_heading, in_heading = hm, True
                self.ledger.claim(u["id"], None, "heading", "derived", True)
                continue
            m = start.match(u["text"]) if u["kind"] == "line" else None
            if m:
                groups.append({"number": m.group(1), "match": m, "units": [u], "sol": [], "heading": current_heading})
                in_heading = False
                continue
            if in_heading and u["kind"] == "line":
                self.ledger.ignore(u["id"], self._intro_rule(), "built-in: the introduction printed under a section heading")
                continue
            if not groups:
                continue   # before the first question: left unclaimed unless an ignore rule covers it (coverage FAILs)
            g = groups[-1]
            if u["kind"] == "line" and inline_start and (g["sol"] or inline_start.search(u["text"])):
                g["sol"].append(u)
            elif u["kind"] != "line" and g["sol"]:
                g["sol"].append(u)
            else:
                g["units"].append(u)
        if not groups:
            raise StageFail(f"no line matches segment.start {seg['start']!r}", check="S2.segment", hint="check the pattern against the probe report's numbering patterns")
        # figures sit beside text: give each graphic to the question whose span holds its vertical centre
        self._assign_graphics(groups)
        section = self._answer_section(section_lines) if section_lines else {}
        if section:
            nums = {g["number"] for g in groups}
            orphans = sorted(set(section) - nums, key=_num_key)
            if orphans:
                raise StageFail(f"answer section has entries for questions that do not exist: {orphans[:8]}", check="S2.join",
                                hint="off-by-one or a numbering mismatch between the questions and the answers")
        out = []
        for pos, g in enumerate(groups, start=1):
            out.append(self._question(g["number"], g["units"], g["sol"], g["match"], pos, section.get(g["number"]), heading=g.get("heading")))
        check_numbering([g["number"] for g in groups], seg["numbering"], seg["start"])
        self.run.decisions["answer_section_entries"] = len(section)
        return out, None

    def _assign_graphics(self, groups) -> None:
        spans = []   # (page, col, top, question index, is_solution)
        for gi, g in enumerate(groups):
            for part, us in (("q", g["units"]), ("s", g["sol"])):
                lines = [u for u in us if u["kind"] == "line"]
                if lines:
                    first = min(lines, key=lambda u: (u["page"], _y(u)))
                    spans.append((first["page"], first["col"], _y(first), gi, part))
        spans.sort()
        for g in groups:
            for part in ("units", "sol"):
                floating = [u for u in g[part] if u["kind"] != "line"]
                g[part] = [u for u in g[part] if u["kind"] == "line"]
                for u in floating:
                    self._place(u, spans, groups)
        for g in groups:
            g["units"].sort(key=lambda u: (u["page"], u["col"], _y(u)))
            g["sol"].sort(key=lambda u: (u["page"], u["col"], _y(u)))

    @staticmethod
    def _place(u, spans, groups) -> None:
        centre = (u["box"][1] + u["box"][3]) / 2
        owner = None
        for page, col, top, gi, part in spans:
            if (page, col) < (u["page"], u["col"]) or ((page, col) == (u["page"], u["col"]) and top <= centre + 2):
                owner = (gi, part)
            else:
                break
        if owner is None:
            owner = (spans[0][3], spans[0][4]) if spans else None
        if owner:
            groups[owner[0]]["units" if owner[1] == "q" else "sol"].append(u)

    def _answer_section(self, lines: list[dict]) -> dict:
        spec = self.profile.get("answers", {}).get("section")
        if not spec:
            for u in lines:
                if u["kind"] == "line":
                    raise StageFail(f"text after segment.end but no answers.section rule reads it: {u['text'][:60]!r}", locator=u["locator"], check="S2.coverage")
            return {}
        entry, answer = rx(spec["entry"]), rx(spec["answer"])
        seg = self.profile["segment"]
        heading = rx(seg["heading"]) if seg.get("heading") else None
        cur_heading = False
        stop = rx(spec["explanation_stop"]) if spec.get("explanation_stop") else None
        entries, cur = {}, None
        for u in lines:
            if u["kind"] != "line":
                self.ledger.claim(u["id"], None, "answers.figure", "asset", True)
                continue
            if heading and heading.search(u["text"]):
                self.ledger.claim(u["id"], None, "heading", "derived", True)
                cur_heading = True
                continue
            m = entry.match(u["text"])
            if m:
                cur_heading = False
                if m.group(1) in entries:
                    raise StageFail(f"answer section has two entries for {m.group(1)}", locator=u["locator"], check="S2.join")
                cur = {"number": m.group(1), "lines": [u], "where": u["locator"]}
                entries[m.group(1)] = cur
            elif cur is None or cur_heading:
                self.ledger.ignore(u["id"], self._intro_rule(), "built-in: the introduction printed under a section heading or an answer-section heading")
            else:
                cur["lines"].append(u)
        out = {}
        echo_rule = len(self.ledger.rules)
        self.ledger.rules.append({"index": echo_rule, "rule": {"builtin": "answer_section_echo"}, "reason": "built-in: the question repeated at the start of its answer-section entry",
                                  "max_blocks": 100000, "max_tokens": 1000000})
        for num, e in entries.items():
            idx = next((k for k, u in enumerate(e["lines"]) if answer.search(u["text"])), None)
            if idx is None:
                raise StageFail(f"answer entry {num} has no line matching answers.section.answer", locator=e["where"], check="S2.answers")
            m = answer.search(e["lines"][idx]["text"])
            answer_text, end = m.group(1).strip(), idx + 1
            if spec.get("answer_until"):   # the answer runs on over the next lines until a labelled line
                until = rx(spec["answer_until"])
                while end < len(e["lines"]) and not until.search(e["lines"][end]["text"]):
                    answer_text += " " + e["lines"][end]["text"].strip()
                    end += 1
            answer_blocks = [u["id"] for u in e["lines"][idx:end]]
            expl = [u for u in e["lines"][end:] if not (stop and stop.search(u["text"]))] if spec.get("explanation", True) else []
            for u in e["lines"][:idx]:
                self.ledger.ignore(u["id"], echo_rule, self.ledger.rules[echo_rule]["reason"])
            for u in e["lines"][end:]:
                if u not in expl:
                    self.ledger.ignore(u["id"], echo_rule, self.ledger.rules[echo_rule]["reason"])
            out[num] = {"answer": answer_text, "answer_blocks": answer_blocks, "label": e["lines"][idx]["text"][:m.start(1)].strip(), "explanation": self._join(expl) if expl else None,
                        "explanation_blocks": [u["id"] for u in expl], "where": e["where"]}
        return out

    def _by_units(self, live: list[dict]) -> list[dict]:
        regions = self.run.job.get("regions")
        if not regions:
            raise StageFail("segment.by units@1 needs the job to list regions: [{number, units}]", check="S2.segment",
                            hint="look at the probe's page images, where every unit is drawn with its id")
        by_id = {b["locator"]: b for b in self.ledger.blocks}
        out = []
        for pos, r in enumerate(regions, start=1):
            ids = _unit_ids(r["units"], by_id)
            units = [by_id[i] for i in ids]
            ignored = [i for i in ids if by_id[i]["id"] in self.ledger.ignored]
            if ignored:
                raise StageFail(f"question {r['number']} uses unit(s) {ignored} that an ignore rule removes", check="S2.segment")
            sol = _unit_ids(r["solution_units"], by_id) if r.get("solution_units") else []
            q = self._question(str(r["number"]), units, [], None, pos, transcribed=r)
            if sol:
                q.setdefault("solution", {})["explanation"] = "\n\n".join(self._crops(q["id"], "solution.explanation", [by_id[i] for i in sol], f"Solution {r['number']}"))
                for i in sol:
                    self.ledger.claim(by_id[i]["id"], q["id"], "solution.explanation", "asset")
            out.append(q)
        check_numbering([str(r["number"]) for r in regions], self.profile["segment"]["numbering"], "job.regions")
        self.run.decisions["transcribed_questions"] = sum(1 for r in regions if r.get("answer") is not None or r.get("text"))
        return out


def _num_key(n: str):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", n)]


def _pages(spec) -> set[int]:
    out = set()
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        out.update(range(int(m.group(1)), int(m.group(2)) + 1) if m else [int(part)])
    return out


def _unit_ids(spec, by_id: dict) -> list[str]:
    items = spec if isinstance(spec, list) else [spec]
    out = []
    for it in items:
        m = re.fullmatch(r"p(\d+)\.([ug])(\d+)\s*-\s*(?:p\1\.\2)?(\d+)", str(it).strip())
        if m:
            out.extend(f"p{m.group(1)}.{m.group(2)}{k}" for k in range(int(m.group(3)), int(m.group(4)) + 1))
        else:
            out.append(str(it).strip())
    bad = [i for i in out if i not in by_id]
    if bad:
        raise StageFail(f"unknown unit id(s) {bad[:5]}", check="S2.segment", hint="unit ids are drawn on the probe's page images, e.g. p3.u2")
    return out
