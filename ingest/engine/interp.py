"""Stage S2: segment the source into questions and fill pack fields, as the profile says.

Shared pieces for every source kind live here; the kind-specific readers are interp_html / interp_docx /
interp_json. Nothing here guesses: a value that cannot be produced exactly as declared stops the run.
"""
from __future__ import annotations

import re

from spec import rx
from util import StageFail

_TPL = re.compile(r"\{([a-z_][a-z0-9_]*)(?::0(\d)d)?\}")


class Run:
    """Everything S2 accumulates besides the questions."""

    def __init__(self, profile: dict, job: dict, ledger):
        self.profile, self.job, self.ledger = profile, job, ledger
        self.assets: dict[str, dict] = {}
        self.asset_rows: list[dict] = []
        self.containers: dict[str, str] = {}
        self.decisions = {"mappings": {}, "formats": {}, "classified": [], "kept_open": [], "derived_fields": {},
                          "figure_styles": [], "relaxations": [], "hooks": []}

    def note_format(self, fmt: str, policy: str) -> None:
        key = f"{fmt}:{policy}"
        self.decisions["formats"][key] = self.decisions["formats"].get(key, 0) + 1


def render_template(template: str, values: dict, where: str) -> str:
    def sub(m):
        name, pad = m.group(1), m.group(2)
        if name not in values or values[name] is None:
            raise StageFail(f"template {template!r} needs {{{name}}}, which has no value here", locator=where, check="S2.template")
        v = values[name]
        if pad:
            if not re.fullmatch(r"\d+", str(v)):
                raise StageFail(f"template {template!r} pads {{{name}}} as a number but it is {v!r}", locator=where, check="S2.template")
            return str(v).zfill(int(pad))
        return str(v)
    return _TPL.sub(sub, template)


def apply_regex(pattern: str, text: str, where: str, what: str) -> str:
    m = rx(pattern).search(text)
    if not m:
        raise StageFail(f"{what}: text {text[:80]!r} does not match {pattern!r}", locator=where, check="S2.regex",
                        hint="the source has a shape the profile did not expect; fix the profile, do not loosen it blindly")
    return m.group(1) if m.re.groups else m.group(0)


def apply_map(run: Run, spec_map, value, where: str, field: str):
    if isinstance(spec_map, str):
        table, name = run.job.get("mappings", {}).get(spec_map), f"mappings.{spec_map}"
    else:
        table, name = spec_map, f"{field}.map"
    key = str(value)
    if table is None or key not in table:
        raise StageFail(f"{field}: value {key!r} is not in {name}", locator=where, check="S2.map",
                        hint="mappings must be total: add this value to the mapping")
    hist = run.decisions["mappings"].setdefault(name, {})
    hist[key] = hist.get(key, 0) + 1
    return table[key]


def coerce(value, as_: str | None, where: str, field: str):
    if as_ == "int":
        if not re.fullmatch(r"-?\d+", str(value).strip()):
            raise StageFail(f"{field}: {value!r} is not a whole number", locator=where, check="S2.type")
        return int(str(value).strip())
    if as_ == "number":
        text = str(value).strip()
        if not re.fullmatch(r"-?\d+(\.\d+)?", text):
            raise StageFail(f"{field}: {value!r} is not a number", locator=where, check="S2.type")
        return float(text) if "." in text else int(text)
    return value


def set_path(q: dict, path: str, value) -> None:
    head, _, rest = path.partition(".")
    if rest and head in ("solution", "fields", "source"):
        q.setdefault(head, {})[rest] = value
    else:
        q[path] = value


def classify_number_unit(md: str, units: list[str]):
    """number_unit_else_open@1: a numeric key only when the text is exactly a number (plus a declared unit) AND
    writing the parsed number back gives the same characters. Anything else stays an open answer (R3)."""
    text = md.replace(" ", " ").strip()
    unit_alt = "|".join(re.escape(u) for u in sorted(units, key=len, reverse=True))
    m = re.fullmatch(rf"(-?\d+(?:\.\d+)?)\s*({unit_alt})" if units else r"(-?\d+(?:\.\d+)?)", text)
    if not m:
        return None
    value = float(m.group(1)) if "." in m.group(1) else int(m.group(1))
    if repr(value) != m.group(1):   # 7.50, 007, 1e3 ... would lose characters
        return None
    return {"value": value, "unit": m.group(2)} if units else {"value": value}


def check_numbering(numbers: list[str], rule: str, where: str) -> None:
    if len(set(numbers)) != len(numbers):
        dup = sorted({n for n in numbers if numbers.count(n) > 1})
        raise StageFail(f"printed numbers repeat: {dup[:5]}", locator=where, check="S2.numbering")
    if rule == "sequential_from_1":
        want = [str(i) for i in range(1, len(numbers) + 1)]
        if numbers != want:
            first = next(i for i, (a, b) in enumerate(zip(numbers + [None], want + [None])) if a != b)
            raise StageFail(f"numbering is not 1..N in order: position {first + 1} is {numbers[first] if first < len(numbers) else 'missing'!r}",
                            locator=where, check="S2.numbering")
    elif rule == "sectioned":
        section, n = 0, 0
        for num in numbers:
            m = re.fullmatch(r"(\d+)\.(\d+)", num)
            if not m:
                raise StageFail(f"sectioned numbering expects 'section.number', got {num!r}", locator=where, check="S2.numbering")
            s, k = int(m.group(1)), int(m.group(2))
            if (s == section and k == n + 1) or (s == section + 1 and k == 1):
                section, n = s, k
            else:
                raise StageFail(f"sectioned numbering jumps from {section}.{n} to {num}", locator=where, check="S2.numbering")


def finish_question(q: dict, parts, profile: dict) -> dict:
    if parts:
        q["type"] = "multi_part"
        q["parts"] = parts
    elif "type" not in q:
        q["type"] = "numeric" if isinstance(q.get("answer"), dict) else profile.get("defaults", {}).get("type", "open")
    return q
