"""Profile and job loading and lint (work package W2, spec sections 5.6 and 6.3).

The profile is written by an AI model and is never trusted: this module decides whether it is well formed.
"""
from __future__ import annotations

import re
from pathlib import Path

import jsonschema
import soupsieve

import yamlstrict
from util import StageFail, read_json, sha256_obj

KIT = Path(__file__).resolve().parents[1] / "kit"

# Everything a profile can name, with its version. A profile's hash covers the versions of what it uses, so
# changing the behaviour of a transform (and bumping its version here) voids approvals that depend on it (R17).
REGISTRY = {
    "segment": {"css_container": 1, "numbered_paragraph": 1, "json_array": 1, "lines": 1, "units": 1},
    "pages": {"text_lines": 2, "ink_bands": 2, "crop_png": 1},   # bump when unit finding changes: unit ids and text may change
    "content": {"htmlmd": 1},
    "svg": {"svg_inline_page_styles": 1},
    "classify": {"number_unit_else_open": 1},
    "rule": {"frac": 1, "mixed": 1, "bold_line": 1, "italic_line": 1, "list": 1, "quote_lines": 1, "unwrap": 1, "text": 1},
    "escape": {"markdown": 1},
}
SEGMENT_FOR_KIND = {"html": {"css_container"}, "html-json": {"json_array"}, "docx": {"numbered_paragraph"},
                    "pdf": {"lines", "units"}, "office": {"lines", "units"}, "html-print": {"lines", "units"}, "image": {"units"}, "scan": {"units"}}


# --------------------------------------------------------------------------- regular expressions (R13)
try:  # RE2 is linear-time by construction. It is used whenever it is installed.
    import re2 as _re2  # type: ignore
except Exception:  # pragma: no cover - depends on the environment
    _re2 = None

_RE_CACHE: dict[str, object] = {}


def regex_problem(pattern: str) -> str | None:
    """Why this pattern is outside the profile language, or None.

    The profile language is the RE2 subset: no backreferences, no lookarounds. Without the RE2 library we
    additionally refuse nested unbounded repetition, the usual cause of runaway matching.
    """
    if len(pattern) > 300:
        return "pattern longer than 300 characters"
    try:
        import re._parser as parser  # type: ignore
        import re._constants as const  # type: ignore
        tree = parser.parse(pattern)
    except re.error as e:
        return f"does not compile: {e}"
    except ImportError:  # very old Python
        return None

    def walk(items, depth):
        for op, arg in items:
            name = str(op)
            if name in ("GROUPREF", "GROUPREF_EXISTS"):
                return "backreferences are not part of the profile language"
            if name in ("ASSERT", "ASSERT_NOT"):
                return "lookarounds are not part of the profile language"
            if name in ("MAX_REPEAT", "MIN_REPEAT", "POSSESSIVE_REPEAT"):
                lo, hi, sub = arg
                unbounded = hi == const.MAXREPEAT or hi > 1000
                if unbounded and depth:
                    return "nested unbounded repetition (for example (a+)+) is not allowed"
                r = walk(sub, depth + (1 if unbounded else 0))
                if r:
                    return r
            elif name == "SUBPATTERN":
                r = walk(arg[3], depth)
                if r:
                    return r
            elif name == "BRANCH":
                for branch in arg[1]:
                    r = walk(branch, depth)
                    if r:
                        return r
            elif name == "ATOMIC_GROUP":
                return "atomic groups are not part of the profile language"
        return None

    problem = walk(tree, 0)
    if problem:
        return problem
    if _re2 is not None:
        try:
            _re2.compile(pattern)
        except Exception as e:  # noqa: BLE001
            return f"not accepted by RE2: {e}"
    return None


def rx(pattern: str):
    """Compile a linted pattern. Raises on anything outside the profile language."""
    if pattern not in _RE_CACHE:
        problem = regex_problem(pattern)
        if problem:
            raise StageFail(f"regex {pattern!r}: {problem}", check="lint.regex")
        _RE_CACHE[pattern] = re.compile(pattern)
    return _RE_CACHE[pattern]


# --------------------------------------------------------------------------- lint
class Lint:
    def __init__(self, name: str, lines: dict[str, int]):
        self.name, self.lines, self.errors, self.warnings = name, lines, [], []

    def err(self, path: str, message: str, code: str = "lint") -> None:
        self.errors.append({"code": code, "path": path or "/", "line": yamlstrict.line_of(self.lines, path), "message": message})

    def warn(self, path: str, message: str, code: str = "lint") -> None:
        self.warnings.append({"code": code, "path": path or "/", "line": yamlstrict.line_of(self.lines, path), "message": message})


def _schema_errors(data, schema_name: str, lint: Lint) -> None:
    schema = read_json(KIT / schema_name)
    validator = jsonschema.Draft202012Validator(schema)
    for e in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        path = "/" + "/".join(str(p) for p in e.absolute_path) if e.absolute_path else ""
        msg = e.message
        if e.validator == "additionalProperties":
            code = "lint.unknown_key"
        elif e.validator == "required":
            code = "lint.missing_key"
        elif e.validator in ("anyOf", "oneOf"):
            code, msg = "lint.shape", "does not match any allowed shape (check for unknown or misspelt keys): " + msg[:160]
        else:
            code = "lint.schema"
        lint.err(path, msg, code)


def _walk(node, path=""):
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}/{i}")


_SELECTOR_KEYS = {"css", "selector", "closest", "match", "num", "den", "frac", "line", "main", "note"}
_REGEX_KEYS = {"regex", "start", "end", "entry", "answer", "explanation_stop", "heading", "answer_until", "break_before"}
_TEMPLATE_VAR = re.compile(r"\{([a-z_][a-z0-9_]*)(?::[^}]*)?\}")
BUILTIN_VARS = {"number", "label", "qid", "position", "array", "heading", "heading_1", "heading_2", "heading_3"}


def _check_selector(sel: str, path: str, lint: Lint) -> None:
    try:
        soupsieve.compile(sel)
    except Exception as e:  # noqa: BLE001
        lint.err(path, f"selector {sel!r} is not valid CSS: {e}", "lint.selector")


def lint_profile(data: dict, lines: dict[str, int], name: str) -> Lint:
    lint = Lint(name, lines)
    if not isinstance(data, dict):
        lint.err("", "a profile must be a YAML mapping", "lint.shape")
        return lint
    _schema_errors(data, "profile.schema.json", lint)
    if lint.errors:
        return lint  # the deeper checks assume the shape is right

    kind = data["source"]["kind"]
    seg_name, _, seg_ver = data["segment"]["by"].partition("@")
    if seg_name not in SEGMENT_FOR_KIND[kind]:
        lint.err("/segment/by", f"source kind {kind!r} needs segment.by one of {sorted(n + '@1' for n in SEGMENT_FOR_KIND[kind])}", "lint.registry")
    if kind == "html" and "selector" not in data["segment"]:
        lint.err("/segment", "css_container needs segment.selector", "lint.missing_key")
    if kind == "html-json" and "arrays" not in data["segment"]:
        lint.err("/segment", "json_array needs segment.arrays", "lint.missing_key")
    if seg_name == "lines" and "start" not in data["segment"]:
        lint.err("/segment", "lines@1 needs segment.start (the pattern of a line that begins a question)", "lint.missing_key")
    if data.get("answers", {}).get("section") and not data["segment"].get("end"):
        lint.err("/answers/section", "an answer section needs segment.end (the line where questions stop and answers begin)", "lint.missing_key")
    if data.get("answers", {}).get("expected") and seg_name == "lines" and not (data["answers"].get("inline") or data["answers"].get("section")):
        lint.warn("/answers", "answers are expected but neither answers.inline nor answers.section says where they are", "lint.answers")
    declared = set(data.get("vars", {})) | BUILTIN_VARS
    for path, node in _walk(data):
        key = path.rsplit("/", 1)[-1]
        if isinstance(node, str):
            if key in _REGEX_KEYS and not path.startswith("/fields") or key == "regex" or (key == "label" and (path.startswith("/parts") or path.startswith("/options"))):
                problem = regex_problem(node)
                if problem:
                    lint.err(path, f"regex {node!r}: {problem}", "lint.regex")
            elif key in _SELECTOR_KEYS and kind in ("html",):
                _check_selector(node, path, lint)
            elif key == "from" and kind == "html" and node != "question_text":
                _check_selector(node, path, lint)
            elif key in ("template", "split_by_part_labels", "prefix"):
                for var in _TEMPLATE_VAR.findall(node):
                    if var not in declared:
                        lint.err(path, f"template uses {{{var}}} but no var of that name is declared", "lint.template")
            elif key == "var" and node not in declared:
                lint.err(path, f"var {node!r} is not declared under vars", "lint.template")
        if isinstance(node, list) and key == "from" and kind == "html":
            for i, sel in enumerate(node):
                _check_selector(sel, f"{path}/{i}", lint)

    for i, rule in enumerate(data.get("ignore", [])):
        if "regex" in rule:
            pass  # checked above
        if rule["max_blocks"] == 0 and rule["max_tokens"] == 0:
            lint.warn(f"/ignore/{i}", "an ignore rule that may match nothing can be removed", "lint.ignore")
    for name_, pol in data.get("formatting", {}).items():
        if pol["policy"] == "ignore" and not pol.get("reason"):
            lint.err(f"/formatting/{name_}", "ignoring a format relaxes a strict default and needs a reason (R15)", "lint.reason")
    svg = data.get("content", {}).get("svg", {})
    if svg.get("extra_css") and not svg.get("extra_css_reason"):
        lint.err("/content/svg", "extra_css adds styling that is not in the figure and needs extra_css_reason", "lint.reason")
    fields = data["fields"]
    if "stem" not in fields and "parts" not in data and kind not in ("pdf", "image", "office", "html-print", "scan"):
        lint.err("/fields", "a question needs at least a stem (or parts)", "lint.missing_key")
    for fname, spec in fields.items():
        for j, one in enumerate(spec if isinstance(spec, list) else [spec]):
            p = f"/fields/{fname}" + (f"/{j}" if isinstance(spec, list) else "")
            sources = [k for k in ("from", "key", "const", "template", "var", "paragraph", "preamble", "lookup", "compose", "by_type", "attr", "list_of") if k in one]
            if kind in ("pdf", "image", "office", "html-print", "scan") and fname in ("stem", "answer", "options", "solution.answer", "solution.explanation"):
                lint.err(p, f"for page sources the engine fills {fname} itself (see display, options and answers); remove it from fields", "lint.shape")
                continue
            if not sources:
                lint.err(p, "the field does not say where its value comes from (from / key / template / var / const ...)", "lint.missing_key")
            if isinstance(one.get("map"), dict) and not one["map"]:
                lint.err(p + "/map", "an inline map must not be empty", "lint.map")
    if len(data.get("fixtures", [])) < 3:
        lint.warn("/fixtures", "fewer than three conformance fixtures (section 6.5): the profile's behaviour is not pinned by examples", "lint.fixtures")
    return lint


def lint_job(data: dict, lines: dict[str, int], name: str, profile: dict | None = None, profile_sha: str | None = None) -> Lint:
    lint = Lint(name, lines)
    if not isinstance(data, dict):
        lint.err("", "a job must be a YAML mapping", "lint.shape")
        return lint
    _schema_errors(data, "job.schema.json", lint)
    if lint.errors or profile is None:
        return lint
    ref = data["job"]["profile"]
    if ref["id"] != profile["profile"]["id"] or ref["version"] != profile["profile"]["version"]:
        lint.err("/job/profile", f"job is for profile {ref['id']} v{ref['version']} but was given {profile['profile']['id']} v{profile['profile']['version']}", "lint.profile_ref")
    if "sha256" in ref and ref["sha256"] != profile_sha:
        lint.err("/job/profile/sha256", f"job pins profile hash {ref['sha256'][:12]}… but the profile's hash is {profile_sha[:12]}…: the profile changed after it was signed off", "lint.profile_pin")
    if "sha256" not in ref:
        lint.warn("/job/profile", "the job does not pin the profile hash; add sha256 once the profile is signed off (Gate A)", "lint.profile_pin")
    needed = set()
    for _, node in _walk(profile):
        if isinstance(node, dict) and isinstance(node.get("map"), str):
            needed.add(node["map"])
    have = set(data.get("mappings", {}))
    for m in sorted(needed - have):
        lint.err("/mappings", f"the profile maps values through mappings.{m}, which this job does not define", "lint.map")
    for m in sorted(have - needed):
        lint.err(f"/mappings/{m}", f"mappings.{m} is not used by the profile", "lint.map")
    if not profile.get("pack", {}).get("title") and "title" not in data["pack"]:
        lint.err("/pack", "the profile does not extract a pack title, so the job must give pack.title", "lint.missing_key")
    if profile.get("pack", {}).get("title") and "title" in data["pack"]:
        lint.err("/pack/title", "the profile extracts the pack title from the source; remove it from the job", "lint.shape")
    return lint


# --------------------------------------------------------------------------- hashes (section 5.6)
def profile_hash(profile: dict) -> str:
    """Canonical parsed content plus the version of every registry entry: comments never change it,
    a transform whose behaviour changes always does."""
    return sha256_obj({"profile": profile, "registry": REGISTRY, "hooks": []})


def job_hash(job: dict) -> str:
    return sha256_obj({"job": job})


def load_documents(path: Path) -> list[tuple[dict, dict]]:
    """A file may hold one YAML document or several separated by '---' (a profile and a job together)."""
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"(?m)^---[ \t]*$", text)
    docs, offset = [], 0
    for part in parts:
        if part.strip():
            data, lines = yamlstrict.load(part, path.name)
            docs.append((data, {k: v + offset for k, v in lines.items()}))
        offset += part.count("\n") + 1
    return docs


def load_pair(profile_path: Path, job_path: Path | None):
    """Returns (profile, profile_lint, job, job_lint, profile_sha, job_sha). Lint objects carry all errors."""
    docs = load_documents(profile_path)
    if job_path and job_path != profile_path:
        docs += load_documents(job_path)
    prof = [d for d in docs if isinstance(d[0], dict) and "profile" in d[0]]
    jobs = [d for d in docs if isinstance(d[0], dict) and "job" in d[0]]
    if len(prof) != 1:
        raise StageFail(f"expected exactly one profile document (a mapping with a top-level 'profile' key), found {len(prof)}", check="lint.shape")
    if len(jobs) > 1:
        raise StageFail(f"expected at most one job document, found {len(jobs)}", check="lint.shape")
    profile, plines = prof[0]
    plint = lint_profile(profile, plines, profile_path.name)
    psha = profile_hash(profile) if not plint.errors else None
    job = jlint = jsha = None
    if jobs:
        job, jlines = jobs[0]
        jlint = lint_job(job, jlines, (job_path or profile_path).name, profile if not plint.errors else None, psha)
        jsha = job_hash(job) if not jlint.errors else None
    return profile, plint, job, jlint, psha, jsha
