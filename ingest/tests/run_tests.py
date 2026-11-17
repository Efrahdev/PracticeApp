#!/usr/bin/env python3 -I
"""Pipeline self-tests (spec section 12): unit tests, fault injection (Appendix C) and approval tamper cases.

Every fault is injected into a known-good run; the named check must catch it. A fault caught by nothing is a
defect in the pipeline. Usage:  python3 -I ingest/tests/run_tests.py [--quick]
  --quick skips the browser-based gate runs (G2-G4) and the slow full-run cases.
Exit 0 when every case behaves as expected.
"""
from __future__ import annotations

import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

INGEST = Path(__file__).resolve().parents[1]
ROOT = INGEST.parent
sys.path.insert(0, str(INGEST / "engine"))

import approve  # noqa: E402
import gates  # noqa: E402
import spec  # noqa: E402
import stages  # noqa: E402
import yamlstrict  # noqa: E402
from json_kind import LiteralParser  # noqa: E402
from util import StageFail, pack_identity, read_json, sha256_obj, stored_zip, write_json  # noqa: E402

QUICK = "--quick" in sys.argv
RESULTS: list[tuple[str, bool, str]] = []
TMP = Path(tempfile.mkdtemp(prefix="ingest-tests-"))


def case(name):
    def wrap(fn):
        try:
            fn()
            RESULTS.append((name, True, ""))
        except AssertionError as e:
            RESULTS.append((name, False, str(e)[:300]))
        except Exception as e:  # noqa: BLE001
            RESULTS.append((name, False, f"{type(e).__name__}: {e}"[:300]))
        return fn
    return wrap


def expect_fail(fn, check_prefix: str, contains: str = ""):
    try:
        fn()
    except StageFail as e:
        assert (e.check or "").startswith(check_prefix), f"stopped, but by {e.check} ({e.message[:120]}), not {check_prefix}"
        assert contains in e.message, f"message {e.message[:160]!r} lacks {contains!r}"
        return e
    raise AssertionError(f"expected a {check_prefix} stop, but the stage passed")


def load(profile_name, job_name):
    profile, plint, job, jlint, psha, jsha = spec.load_pair(INGEST / "profiles" / f"{profile_name}.yaml", INGEST / "jobs" / f"{job_name}.yaml")
    assert not plint.errors and not jlint.errors, (plint.errors, jlint.errors)
    return profile, job


def source_of(job):
    return (INGEST / "jobs" / job["sources"][0]["file"]).resolve()


def convert(profile, job, source=None, corrections=None, name="x"):
    out = TMP / f"conv-{name}"
    shutil.rmtree(out, ignore_errors=True)
    return stages.convert(out, source or source_of(job), profile, job, corrections), out


def edited(src: Path, fn, name: str) -> Path:
    """A copy of the source with `fn` applied to its text."""
    dst = TMP / "src" / name / src.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(fn(src.read_text(encoding="utf-8")), encoding="utf-8")
    return dst


def edited_docx(src: Path, fn, name: str) -> Path:
    dst = TMP / "src" / name / src.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                data = fn(data.decode("utf-8")).encode("utf-8")
            zout.writestr(item, data)
    return dst


GEO = load("geometry-html", "geometry-olympiad-achiever-100")
DOCX = load("docx-numbered", "class5-calendar-sums")
GRAM = load("grammar-json", "grammar-midterm-mastery-assessment")


# =========================================================================== unit tests
@case("U1 canonical JSON is byte-stable and NFC")
def _():
    from util import canon_bytes
    a = canon_bytes({"b": "é", "a": [1, {"z": 1, "y": 2}]})
    b = canon_bytes({"a": [1, {"y": 2, "z": 1}], "b": "é"})
    assert a == b, (a, b)


@case("U2 stored zip and pack identity do not depend on insertion order")
def _():
    e1 = {"pack.json": b"{}", "assets/a.svg": b"<svg/>"}
    e2 = {"assets/a.svg": b"<svg/>", "pack.json": b"{}"}
    assert stored_zip(e1) == stored_zip(e2) and pack_identity(e1) == pack_identity(e2)
    with zipfile.ZipFile(__import__("io").BytesIO(stored_zip(e1))) as z:
        assert z.testzip() is None and z.namelist() == ["assets/a.svg", "pack.json"]


@case("U3 YAML duplicate keys are rejected (section 6.3 step 1)")
def _():
    expect_fail(lambda: yamlstrict.load("a: 1\nb: 2\na: 3\n"), "lint.duplicate_key")


@case("U4 regexes outside the profile language are rejected (R13)")
def _():
    for bad in [r"(a)\1", r"foo(?=bar)", r"(?<!x)y", r"(a+)+$", r"(x*)*"]:
        assert spec.regex_problem(bad), f"{bad!r} was accepted"
    for good in [r"^(\d+)\s*[.)]\s+", r"^Q(\d+)$", r"^\(([a-z])\)\s+"]:
        assert spec.regex_problem(good) is None, good


@case("U5 the JS literal reader refuses code (R13)")
def _():
    ok = LiteralParser('[{a: "x\\n", "b": [1, -2.5e3, true, null], c: `t`}]', 0, "T").value()
    assert ok == [{"a": "x\n", "b": [1, -2500.0, True, None], "c": "t"}], ok
    for bad in ["[foo()]", "[x]", "[`${x}`]", "[...a]", "[{a}]", "[{[k]: 1}]", "[{a() {}}]"]:
        expect_fail(lambda b=bad: LiteralParser(b, 0, "T").value(), "S1.literals")


@case("U6 numeric classification keeps every character or stays open")
def _():
    from interp import classify_number_unit as c
    assert c("49 cm²", ["cm²", "cm"]) == {"value": 49, "unit": "cm²"}
    assert c("12.5 m", ["m"]) == {"value": 12.5, "unit": "m"}
    for keep_open in ["7.50 cm", "007 cm", "1,000 m", "49 cm² each", "8 cm and 6 cm", "1e3 m"]:
        assert c(keep_open, ["cm", "m", "cm²"]) is None, keep_open


@case("U7 lint catches 15+ broken profiles, each with the right code")
def _():
    good = (INGEST / "profiles" / "geometry-html.yaml").read_text(encoding="utf-8")
    cases = [
        ("unknown top-level key", lambda t: t + "\nsurprise: 1\n", "lint.unknown_key"),
        ("misspelt field key", lambda t: t.replace("title: {from: \".qtitle\"}", "title: {form: \".qtitle\"}"), "lint.shape"),
        ("missing ignore list", lambda t: re.sub(r"(?ms)^ignore:.*?(?=^passthrough:)", "", t), "lint.missing_key"),
        ("missing answers", lambda t: t.replace("answers: {expected: true}", ""), "lint.missing_key"),
        ("backreference", lambda t: t.replace('regex: "^Q(\\\\d+)$"', 'regex: "^Q(\\\\d+)\\\\1$"'), "lint.regex"),
        ("lookahead", lambda t: t.replace('regex: "^Q(\\\\d+)$"', 'regex: "^Q(?=1)(\\\\d+)$"'), "lint.regex"),
        ("nested repetition", lambda t: t.replace('regex: "^Q(\\\\d+)$"', 'regex: "^Q((\\\\d+)+)$"'), "lint.regex"),
        ("bad selector", lambda t: t.replace('selector: "article.q"', 'selector: "article..q"'), "lint.selector"),
        ("unknown segment strategy", lambda t: t.replace("css_container@1", "css_container@9"), "lint.schema"),
        ("wrong segment for kind", lambda t: t.replace("css_container@1", "numbered_paragraph@1"), "lint.registry"),
        ("unknown content rule", lambda t: t.replace("do: bold_line", "do: embolden"), "lint.schema"),
        ("ignore rule without limits", lambda t: t.replace(', max_blocks: 8, max_tokens: 30}', '}'), "lint.missing_key"),
        ("ignore rule without reason", lambda t: t.replace('reason: "end-of-paper footer line", ', ''), "lint.missing_key"),
        ("undeclared template var", lambda t: t.replace("Geometry > {set_title}", "Geometry > {set_name}"), "lint.template"),
        ("unknown var reference", lambda t: t.replace("difficulty: {var: level", "difficulty: {var: lvl"), "lint.template"),
        ("extra css without reason", lambda t: re.sub(r"(?m)^    extra_css_reason:.*\n", "", t), "lint.reason"),
        ("hooks given", lambda t: t + "\nhooks: [x.py]\n", "lint.schema"),
        ("bad profile id", lambda t: t.replace("id: geometry-html", "id: Geometry HTML"), "lint.schema"),
        ("duplicate key", lambda t: t.replace("  title: {from: \".qtitle\"}", "  title: {from: \".qtitle\"}\n  title: {from: \".qtitle\"}"), "lint.duplicate_key"),
    ]
    failures = []
    for name, mutate, code in cases:
        bad = mutate(good)
        assert bad != good, f"mutation '{name}' changed nothing"
        try:
            data, lines = yamlstrict.load(bad)
            lint = spec.lint_profile(data, lines, "t.yaml")
            codes = {e["code"] for e in lint.errors}
            if code not in codes:
                failures.append(f"{name}: got {sorted(codes) or 'no error'}")
            elif any(e["line"] is None for e in lint.errors):
                failures.append(f"{name}: an error has no line number")
        except StageFail as e:
            if e.check != code:
                failures.append(f"{name}: stopped with {e.check}")
    assert len(cases) >= 15 and not failures, failures


@case("U8 job lint: unmapped mapping, unused mapping, wrong profile pin")
def _():
    profile, job = GEO
    psha = spec.profile_hash(profile)
    j = copy.deepcopy(job)
    del j["mappings"]["difficulty"]
    assert "lint.map" in {e["code"] for e in spec.lint_job(j, {}, "j", profile, psha).errors}
    j = copy.deepcopy(job)
    j["mappings"]["unused"] = {"a": "b"}
    assert "lint.map" in {e["code"] for e in spec.lint_job(j, {}, "j", profile, psha).errors}
    j = copy.deepcopy(job)
    j["job"]["profile"]["sha256"] = "0" * 64
    assert "lint.profile_pin" in {e["code"] for e in spec.lint_job(j, {}, "j", profile, psha).errors}


@case("U9 profile hash ignores comments but not content (section 5.6)")
def _():
    t = (INGEST / "profiles" / "docx-numbered.yaml").read_text(encoding="utf-8")
    h = lambda text: spec.profile_hash(yamlstrict.load(text)[0])   # noqa: E731
    assert h(t) == h("# a new comment\n" + t)
    assert h(t) != h(t.replace("numbering: sequential_from_1", "numbering: unique"))


@case("U10 independence: the checker imports nothing from the converter (R8 import-graph test)")
def _():
    bad = []
    for f in (INGEST / "checker").glob("*.mjs"):
        for m in re.finditer(r"""(?:import\s[^'"]*|import\(|require\()\s*['"]([^'"]+)['"]""", f.read_text(encoding="utf-8")):
            target = m.group(1)
            if "engine" in target or target.endswith(".py") or "/ingest/" in target or target.startswith("../"):
                bad.append(f"{f.name} imports {target}")
    assert not bad, bad
    engine_text = "".join(f.read_text(encoding="utf-8") for f in (INGEST / "engine").glob("*.py"))
    assert "cheerio" not in engine_text and "parse5" not in engine_text and "acorn" not in engine_text


# =========================================================================== fault injection (Appendix C)
@case("F1 a question deleted from the source -> S2 numbering / G1.count")
def _():
    profile, job = DOCX
    src = edited_docx(source_of(job), lambda x: re.sub(r"<w:p>(?:(?!<w:p>).)*?3\. How many days(?:(?!<w:p>).)*?</w:p>", "", x, count=1, flags=re.S), "f1")
    expect_fail(lambda: convert(profile, job, src, name="f1"), "S2.numbering")


@case("F2 the source has a different count than the job declares -> G1.count")
def _():
    profile, job = DOCX
    conv, out = convert(profile, job, name="f2")
    j = copy.deepcopy(job)
    j["expect"]["questions"] = 21
    v = gates.gate_g1(out, profile, j, {})
    assert {c["id"]: c["status"] for c in v.checks}["G1.count"] == "FAIL"


@case("F3 a profile run against a source with a different layout -> S0 probes")
def _():
    profile, job = GEO
    expect_fail(lambda: convert(profile, job, ROOT / "UNITARY METHOD.html", name="f3"), "S0.probes")
    expect_fail(lambda: convert(DOCX[0], DOCX[1], ROOT / "UNITARY METHOD.html", name="f3b"), "S0.format")


@case("F4 an unexpected element added to the source -> S2 coverage")
def _():
    profile, job = GEO
    src = edited(source_of(job), lambda x: x.replace('<div class="stmt">', '<aside class="tip">Remember the units!</aside><div class="stmt">', 1), "f4")
    expect_fail(lambda: convert(profile, job, src, name="f4"), "S2.coverage", "neither claimed nor ignored")


@case("F7 one digit changed in the source -> new pack identity, and a pinned source hash stops the run")
def _():
    profile, job = DOCX
    conv, out = convert(profile, job, name="f7")
    src = edited_docx(source_of(job), lambda x: x.replace("10th January", "11th January", 1), "f7")
    conv2, _ = convert(profile, job, src, name="f7b")
    assert conv["packed"]["identity_sha256"] != conv2["packed"]["identity_sha256"]
    # a different source is caught by the pinned source hash
    j = copy.deepcopy(job)
    j["sources"][0]["sha256"] = conv["source"]["sha256"]
    expect_fail(lambda: convert(profile, j, src, name="f7c"), "S0.tamper")


@case("F10 an over-broad ignore rule swallows question content -> S2 ignore limits / select")
def _():
    profile, job = GEO
    p = copy.deepcopy(profile)
    p["ignore"][1]["css"] = "article.q .answer, article.q .stmt"   # also swallows the question text
    try:
        convert(p, job, name="f10")
        raise AssertionError("the over-broad rule was not caught")
    except StageFail as e:
        assert e.check in ("S2.ignore_limits", "S2.select"), e.check


@case("F11 underline in a Word source with no formatting policy -> S2 formatting")
def _():
    profile, job = DOCX
    src = edited_docx(source_of(job), lambda x: x.replace("<w:r><w:t>2. If", "<w:r><w:rPr><w:u w:val=\"single\"/></w:rPr><w:t>2. If", 1), "f11")
    expect_fail(lambda: convert(profile, job, src, name="f11"), "S2.formatting")


@case("F12 a figure moved into the neighbouring question -> G1.asset_containment")
def _():
    profile, job = GEO
    conv, out = convert(profile, job, name="f12")
    rows = read_json(out / "pack" / "assets.json")
    rows[0]["question"] = "q2"
    write_json(out / "pack" / "assets.json", rows)
    v = gates.gate_g1(out, profile, job, {})
    assert {c["id"]: c["status"] for c in v.checks}["G1.asset_containment"] == "FAIL"


@case("F16 a duplicate question number -> S2 numbering")
def _():
    profile, job = DOCX
    src = edited_docx(source_of(job), lambda x: x.replace("<w:t>4. From", "<w:t>3. From", 1), "f16")
    expect_fail(lambda: convert(profile, job, src, name="f16"), "S2.numbering", "repeat")


@case("F20 a difficulty value left unmapped -> S2 map")
def _():
    profile, job = GEO
    j = copy.deepcopy(job)
    del j["mappings"]["difficulty"]["Challenge"]
    expect_fail(lambda: convert(profile, j, name="f20"), "S2.map", "not in mappings.difficulty")


@case("F24 a check that examines nothing cannot pass (R14)")
def _():
    from util import Verdict
    v = Verdict("T")
    assert v.add("T.empty", "PASS", "nothing", examined=0) == "FAIL"
    assert v.add("T.short", "PASS", "half", examined=5, expected=10) == "FAIL"
    assert v.add("T.zero_ok", "PASS", "fine", examined=0, zero_ok=True) == "PASS"


@case("F25 S0-S3 twice give the same pack identity (R1)")
def _():
    for profile, job in (GEO, DOCX, GRAM):
        a, _ = convert(profile, job, name="f25a")
        b, _ = convert(profile, job, name="f25b")
        assert a["packed"]["identity_sha256"] == b["packed"]["identity_sha256"], job["job"]["id"]


@case("F37 a Word file with an entity-expansion payload -> S0 integrity")
def _():
    profile, job = DOCX
    src = edited_docx(source_of(job), lambda x: '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]>' + x.split("?>", 1)[1], "f37")
    expect_fail(lambda: convert(profile, job, src, name="f37"), "S0.integrity", "DTD")


@case("F37b an archive-bomb style entry -> S0 integrity")
def _():
    profile, job = DOCX
    dst = TMP / "src" / "f37b" / "bomb.docx"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_of(job), dst)
    with zipfile.ZipFile(dst, "a", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/media/bomb.bin", b"\0" * (30 * 1024 * 1024))
    expect_fail(lambda: convert(profile, job, dst, name="f37b"), "S0.integrity", "archive bomb")


@case("F39 a stale correction whose old-value hash no longer matches -> S3 corrections")
def _():
    profile, job = DOCX
    conv, _ = convert(profile, job, name="f39")
    q1 = conv["packed"]["pack"]["questions"][0]
    good = TMP / "corr-good.yaml"
    good.write_text(json.dumps([{"question_id": "class5-calendar-sums/q1", "field": "stem", "old_value_sha256": sha256_obj(q1["stem"]),
                                 "new_value": q1["stem"] + " (corrected)", "reason": "test", "author": "tester", "date": "2026-11-17"}]), encoding="utf-8")
    conv2, _ = convert(profile, job, corrections=good, name="f39b")
    assert conv2["packed"]["pack"]["questions"][0]["stem"].endswith("(corrected)")
    stale = TMP / "corr-stale.yaml"
    stale.write_text(good.read_text().replace(sha256_obj(q1["stem"]), "0" * 64), encoding="utf-8")
    expect_fail(lambda: convert(profile, job, corrections=stale, name="f39c"), "S3.corrections", "stale")


@case("F40 an answer line whose part labels cannot be proven -> S2 answers (never guesses)")
def _():
    profile, job = GEO
    src = edited(source_of(job), lambda x: x.replace("<strong>Final answer:</strong> (a)", "<strong>Final answer:</strong> (b)", 1), "f40")
    expect_fail(lambda: convert(profile, job, src, name="f40"), "S2.answers")


@case("F41 an unsafe figure (script inside the SVG) -> S3 assets")
def _():
    profile, job = GEO
    src = edited(source_of(job), lambda x: x.replace('<svg class="geo"', '<svg onload="alert(1)" class="geo"', 1), "f41")
    expect_fail(lambda: convert(profile, job, src, name="f41"), "S3.assets", "event-handler")


@case("F42 a page whose data array holds code, not data -> S1 literals")
def _():
    profile, job = GRAM
    src = edited(source_of(job), lambda x: x.replace('const NOUN_QUESTIONS = [', 'const NOUN_QUESTIONS = [makeQuestion(),', 1), "f42")
    expect_fail(lambda: convert(profile, job, src, name="f42"), "S1.literals")


# =========================================================================== full runs: gates G2-G4 and Gate B
def full_run(profile_name, job_name):
    runs = TMP / "runs"
    p = subprocess.run([str(INGEST / "ingest"), "run", str(INGEST / "profiles" / f"{profile_name}.yaml"), str(INGEST / "jobs" / f"{job_name}.yaml"),
                        "--runs-dir", str(runs), "--json"], capture_output=True, text=True, timeout=900)
    assert p.returncode in (0, 10), f"run exit {p.returncode}: {p.stdout[-400:]} {p.stderr[-400:]}"
    return Path(json.loads(p.stdout)["run_dir"])


def gate(run_dir: Path, g: str) -> dict:
    p = subprocess.run(["node", str(INGEST / "checker" / "gate.mjs"), g, str(run_dir)], capture_output=True, text=True, timeout=600, cwd=str(ROOT))
    assert p.returncode in (0, 10, 20), p.stderr[-500:]
    return read_json(run_dir / "gates" / f"{g}.json")


if not QUICK:
    RUN = full_run("docx-numbered", "class5-calendar-sums")

    def mutated_run(name: str, fn) -> Path:
        d = TMP / f"mut-{name}"
        shutil.copytree(RUN, d)
        for p in d.rglob("*"):
            os.chmod(p, 0o700 if p.is_dir() else 0o600)
        fn(d)
        return d

    def edit_pack(d: Path, fn):
        pack = read_json(d / "pack" / "pack.json")
        fn(pack)
        (d / "pack" / "pack.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    @case("G-ALL every gate passes its own known-bad fixture on a real run (R16)")
    def _():
        for g in ("g1", "g2", "g3", "g4", "g5"):
            v = read_json(RUN / "gates" / f"{g}.json")
            assert (v.get("selftest") or {}).get("status") == "PASS", f"{g} self-test: {v.get('selftest')}"
            assert v["status"] != "FAIL", f"{g} is FAIL on a good run"

    @case("F7p one digit changed in the pack after conversion -> G3.compare")
    def _():
        d = mutated_run("f7g", lambda d: edit_pack(d, lambda p: p["questions"][4].__setitem__("stem", p["questions"][4]["stem"].replace("18", "19"))))
        st = {c["id"]: c["status"] for c in gate(d, "g3")["checks"]}
        assert st["G3.compare"] == "FAIL", st

    @case("F9 a line dropped from a stem -> G3.compare")
    def _():
        d = mutated_run("f9", lambda d: edit_pack(d, lambda p: p["questions"][2].__setitem__("stem", p["questions"][2]["stem"].split("(")[0])))
        assert {c["id"]: c["status"] for c in gate(d, "g3")["checks"]}["G3.compare"] == "FAIL"

    @case("F8 two answers swapped between questions -> G3.compare (stems swapped)")
    def _():
        def swap(p):
            a, b = p["questions"][0], p["questions"][1]
            a["stem"], b["stem"] = b["stem"], a["stem"]
        d = mutated_run("f8", lambda d: edit_pack(d, swap))
        assert {c["id"]: c["status"] for c in gate(d, "g3")["checks"]}["G3.compare"] == "FAIL"

    @case("F43 invented text added to a question -> G3.compare")
    def _():
        d = mutated_run("f43", lambda d: edit_pack(d, lambda p: p["questions"][7].__setitem__("stem", p["questions"][7]["stem"] + " Hint: it is 61 days.")))
        assert {c["id"]: c["status"] for c in gate(d, "g3")["checks"]}["G3.compare"] == "FAIL"

    @case("F44 an invented answer field -> G3.invented")
    def _():
        d = mutated_run("f44", lambda d: edit_pack(d, lambda p: p["questions"][0].__setitem__("answer", "31st January")))
        assert {c["id"]: c["status"] for c in gate(d, "g3")["checks"]}["G3.invented"] == "FAIL"

    @case("F17 an unbalanced \\frac in a stem -> G4.math")
    def _():
        d = mutated_run("f17", lambda d: edit_pack(d, lambda p: p["questions"][3].__setitem__("stem", p["questions"][3]["stem"] + " $\\frac{1}{2$")))
        assert {c["id"]: c["status"] for c in gate(d, "g4")["checks"]}["G4.math"] == "FAIL"

    @case("F19 an unknown key added to the pack -> G2.fields_consumed")
    def _():
        d = mutated_run("f19", lambda d: edit_pack(d, lambda p: p["questions"][0].__setitem__("difficulty_hint", "x")))
        assert {c["id"]: c["status"] for c in gate(d, "g2")["checks"]}["G2.fields_consumed"] == "FAIL"

    @case("F13 an asset/zip entry out of step with the run folder -> G2.zip")
    def _():
        d = mutated_run("f13", lambda d: (d / "pack" / "pack.json").write_text((d / "pack" / "pack.json").read_text() + " "))
        assert {c["id"]: c["status"] for c in gate(d, "g2")["checks"]}["G2.zip"] == "FAIL"

    # ---------------- Gate B tamper cases (F26-F31)
    def approval_for(d: Path, **over) -> dict:
        t = read_json(d / "review" / "approval.template.json")
        canaries = {c["item"] for c in read_json(d / "sealed" / "canaries.json")["items"]}
        t.update(decision="approve", reviewer="Reviewer Session B", profile_author="Claude (profiled from probe reports)", answers_verified="none",
                 approved_at="2026-11-17T10:00:00Z")
        for r in t["reviewed_items"]:
            r["verdict"] = "defect" if r["item"] in canaries else "ok"
        for w in t["waivers"]:
            w["reason"] = "accepted for the test"
        t.update(over)
        write_json(d / "approval.json", t)
        return t

    def refused(d: Path) -> list[str]:
        problems, _, _ = approve.check(d)
        return problems

    @case("B0 a correct approval is accepted")
    def _():
        d = mutated_run("b0", lambda d: approval_for(d))
        assert refused(d) == [], refused(d)

    @case("F26 the pack edited after approval -> approve-check refuses")
    def _():
        def f(d):
            approval_for(d)
            edit_pack(d, lambda p: p["questions"][0].__setitem__("stem", p["questions"][0]["stem"] + "!"))
        assert any("pack_identity_sha256" in p for p in refused(mutated_run("f26", f)))

    @case("F27 the profile edited after approval -> approve-check refuses")
    def _():
        def f(d):
            approval_for(d)
            prof = read_json(d / "inputs" / "profile.json")
            prof["segment"]["numbering"] = "unique"
            write_json(d / "inputs" / "profile.json", prof)
        assert any("profile_sha256" in p for p in refused(mutated_run("f27", f)))

    @case("F29 the reviewer passes a planted error (canary) -> approve-check refuses")
    def _():
        def f(d):
            t = approval_for(d)
            for r in t["reviewed_items"]:
                r["verdict"] = "ok"
            write_json(d / "approval.json", t)
        assert any("corrupted on purpose" in p for p in refused(mutated_run("f29", f)))

    @case("F30 the profile author approves their own pack -> approve-check refuses")
    def _():
        d = mutated_run("f30", lambda d: approval_for(d, reviewer="Claude (profiled from probe reports)"))
        assert any("must be a different person" in p for p in refused(d))

    @case("F31 a WARN with no waiver, or a waiver aimed at a FAIL -> approve-check refuses")
    def _():
        d = mutated_run("f31", lambda d: approval_for(d, waivers=[]))
        assert any("has no waiver" in p for p in refused(d))
        d2 = mutated_run("f31b", lambda d: approval_for(d, waivers=[{"gate": "G1", "check_id": "G1.nonexistent", "reason": "x"}]))
        assert any("not a check in this run" in p for p in refused(d2))

    @case("F31c a defect verdict blocks approval")
    def _():
        def f(d):
            t = approval_for(d)
            canaries = {c["item"] for c in read_json(d / "sealed" / "canaries.json")["items"]}
            next(r for r in t["reviewed_items"] if r["item"] not in canaries)["verdict"] = "defect"
            write_json(d / "approval.json", t)
        assert any("marked defect" in p for p in refused(mutated_run("f31c", f)))

    @case("F45 canaries are sealed outside review/ (an AI reviewer never sees the key)")
    def _():
        text = "".join(p.read_text(encoding="utf-8", errors="replace") for p in (RUN / "review").rglob("*") if p.is_file())
        assert "canary" not in text.lower().replace("canaries", ""), "the word canary appears in the review packet"
        assert (RUN / "sealed" / "canaries.json").exists()


# =========================================================================== report
shutil.rmtree(TMP, ignore_errors=True)
width = max(len(n) for n, _, _ in RESULTS)
for name, ok, msg in RESULTS:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n      {msg}"))
bad = [r for r in RESULTS if not r[1]]
print(f"\n{len(RESULTS) - len(bad)} of {len(RESULTS)} cases behave as expected" + (" (quick mode: browser gates and Gate B cases skipped)" if QUICK else ""))
sys.exit(1 if bad else 0)
