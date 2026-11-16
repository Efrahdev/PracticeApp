#!/usr/bin/env python3 -I
"""Independent fidelity check: re-extract each source's text by a DIFFERENT code path than the converters
(raw docx XML / plain bs4 text walk / separately-evaluated JS) and token-diff it against the pack, per question.

A question passes when
  * no source token is missing from the pack (nothing dropped or reworded), and
  * every token the pack adds is on a short allow-list of purely structural marks
    (list numbers, "—" separators between a calculation and its meaning, "(a)" part labels, ...).

Exit code 1 if any question fails. Writes ingest/fidelity-report.json.
"""
import difflib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "ingest" / "packs"
ALLOWED_EXTRA = re.compile(r"^(—|-|>|\d+\.|\(?[a-z]\)\.?|\*+|\\|\||-{3,})$")  # list/table/label marks only


# --------------------------------------------------------------------------- pack side
def md_tokens(md: str) -> list[str]:
    if md is None:
        return []
    s = md
    s = re.sub(r"!\[[^\]]*\]\(asset:[^)]*\)", " ", s)
    s = re.sub(r"\$(\d*)\\frac\{([^{}]*)\}\{([^{}]*)\}\$", lambda m: f" {m.group(1)} {m.group(2)}/{m.group(3)} ", s)
    s = re.sub(r"(?<!\\)\*+", "", s)  # emphasis markers (literal asterisks are escaped); no space: "**x**." stays "x."
    s = s.replace("\\\n", "\n")
    s = re.sub(r"(?m)^>\s?", " ", s)
    s = re.sub(r"\\([\\`*_\[\]<>|~$&])", r"\1", s).replace("&#93;", "]")
    return s.split()


def content_tokens(x) -> list[str]:
    if x is None:
        return []
    if isinstance(x, str):
        return md_tokens(x)
    if isinstance(x, dict):  # {value, unit} answers are keys, not content
        return []
    if isinstance(x, list):
        return [t for i in x for t in content_tokens(i)]
    return []


# --------------------------------------------------------------------------- source side (html)
def src_tokens(node, skip_classes=("sr-only",)) -> list[str]:
    out: list[str] = []

    def walk(n):
        if isinstance(n, NavigableString):
            out.append(str(n))
            return
        if not isinstance(n, Tag):
            return
        cls = n.get("class") or []
        if n.name in ("script", "style", "svg", "textarea", "button", "input"):
            return
        if any(c in cls for c in skip_classes) and "fr" not in cls:
            return
        if "mixed" in cls:
            whole = "".join(str(c) for c in n.children if isinstance(c, NavigableString)).strip()
            fr = n.select_one(".fr")
            out.append(f" {whole} {fr.select_one('.fr-n').get_text(strip=True)}/{fr.select_one('.fr-d').get_text(strip=True)} ")
            return
        if "fr" in cls:
            out.append(f" {n.select_one('.fr-n').get_text(strip=True)}/{n.select_one('.fr-d').get_text(strip=True)} ")
            return
        if n.name == "br":
            out.append(" ")
            return
        sep = n.name in ("p", "li", "div", "td", "th", "h3", "h4", "tr", "section") or "wl-m" in cls or "wl-n" in cls
        out.append(" ") if sep else None
        for c in n.children:
            walk(c)
        out.append(" ") if sep else None

    walk(node)
    return "".join(out).split()


# --------------------------------------------------------------------------- comparing
def compare(src: list[str], pack: list[str], allow_missing=lambda t: False):
    """Return list of problems (strings). Empty = identical up to allowed structural tokens."""
    problems = []
    sm = difflib.SequenceMatcher(a=src, b=pack, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        a, b = src[i1:i2], pack[j1:j2]
        a_bad = [t for t in a if not allow_missing(t)]
        b_bad = [t for t in b if not ALLOWED_EXTRA.match(t)]
        if a_bad or b_bad:
            ctx = " ".join(src[max(0, i1 - 3):i1])
            problems.append(f"{op}: source {a_bad!r} vs pack {b_bad!r}  (after: …{ctx})")
    return problems


report = {}


def run(name, fn):
    res = fn()
    fails = {k: v for k, v in res.items() if v}
    report[name] = {"questions": len(res), "failed": len(fails), "examples": dict(list(fails.items())[:8])}
    print(f"{name}: {len(res)} questions checked, {len(fails)} with differences")
    for k, v in list(fails.items())[:5]:
        print(f"   {k}: {v[:3]}")
    return len(fails)


def load(name):
    return json.loads((PACKS / f"{name}.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- docx (raw XML path)
def docx_check(name, filename, skip_first_normal=False):
    z = zipfile.ZipFile(ROOT / filename)
    xml = z.read("word/document.xml").decode("utf-8")
    paras = []
    for p in re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S):
        t = "".join(re.findall(r"<w:t(?: [^>]*)?>(.*?)</w:t>", p, flags=re.S))
        t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
        if t.strip():
            paras.append(t)
    numbered = [t for t in paras if re.match(r"^\d+\s*[.)]\s", t)]
    pack = load(name)
    res = {}
    assert len(numbered) == len(pack["questions"]), (name, len(numbered), len(pack["questions"]))
    for raw, q in zip(numbered, pack["questions"]):
        m = re.match(r"^(\d+)\s*[.)]\s+(.*)$", raw, flags=re.S)
        probs = []
        if m.group(1) != q["number"]:
            probs.append(f"number {m.group(1)} != {q['number']}")
        # exact (not token) comparison of the stem after un-escaping
        stem = re.sub(r"\\([\\`*_\[\]<>|~$&])", r"\1", q["stem"]).replace("&#93;", "]")
        if stem != m.group(2):
            probs.append(f"stem differs: {m.group(2)!r} vs {stem!r}")
        if any(k in q for k in ("answer", "solution", "parts", "options")):
            probs.append("pack has an answer/solution/parts/options but the source has none")
        res[q["id"]] = probs
    return res


# --------------------------------------------------------------------------- geometry
def geometry_check():
    doc = BeautifulSoup((ROOT / "Geometry_Olympiad_Achiever_100_Questions.html").read_text(encoding="utf-8"), "html.parser")
    pack = load("geometry-olympiad-achiever-100")
    res = {}
    arts = doc.select("article.q")
    assert len(arts) == len(pack["questions"]) == 100
    for art, q in zip(arts, pack["questions"]):
        probs = []
        assert art["id"] == q["id"]
        has_parts = q["type"] == "multi_part"
        # 1. question text
        stmt = src_tokens(art.select_one(".stmt"))
        cap = art.select_one("figcaption")
        stem_md = q["stem"]
        if cap:
            cap_t = cap.get_text(strip=True)
            stem_wo = stem_md.rsplit("\n\n*", 1)[0]
            probs += ["caption: " + p for p in compare(src_tokens(cap), md_tokens(stem_md.rsplit("\n\n", 1)[1]))]
        else:
            stem_wo = stem_md
        pack_q = md_tokens(stem_wo) + (content_tokens([p["stem"] for p in q["parts"]]) if has_parts else [])
        probs += ["question: " + p for p in compare(stmt, pack_q, allow_missing=lambda t: bool(re.fullmatch(r"\([a-z]\)", t)) and has_parts)]
        # 2. final answer
        final = art.select_one(".solbody p.final")
        fin_src = [t for t in src_tokens(final) if t != "Final"]
        assert fin_src[0] == "answer:", fin_src[:3]
        fin_src = fin_src[1:]
        if has_parts:
            fin_pack = content_tokens([p["answer"] for p in q["parts"]])
        else:
            fin_pack = md_tokens(q["solution"]["answer"])
        probs += ["final: " + p for p in compare(fin_src, fin_pack, allow_missing=lambda t: bool(re.fullmatch(r"\([a-z]\)", t)) and has_parts)]
        # numeric answer key must agree with the final answer text
        if q["type"] == "numeric":
            a = q["answer"]
            if f"{a['value']} {a['unit']}" != " ".join(fin_src).replace("\xa0", " "):
                probs.append(f"numeric key {a} != final {' '.join(fin_src)}")
        # 3. worked solution
        sb = art.select_one(".solbody")
        sol_src = [t for c in sb.children if isinstance(c, Tag) and "final" not in (c.get("class") or []) for t in src_tokens(c)]
        probs += ["solution: " + p for p in compare(sol_src, md_tokens(q["solution"]["explanation"]))]
        # 4. metadata
        if q["title"] != art.select_one(".qtitle").get_text(strip=True):
            probs.append("title differs")
        if q["fields"]["Source difficulty"] != art.select_one(".lvl").get_text(strip=True):
            probs.append("level differs")
        res[q["id"]] = probs
    return res


def svg_check():
    raw = (ROOT / "Geometry_Olympiad_Achiever_100_Questions.html").read_text(encoding="utf-8")
    svgs = re.findall(r"<svg\b.*?</svg>", raw, flags=re.S)
    pack = load("geometry-olympiad-achiever-100")
    assets = list(pack["assets"].items())
    bad = {}
    assert len(svgs) == len(assets) == 102
    # assets were created in document order of conversion; compare as multisets keyed by the stripped markup
    stripped = [re.sub(r"<style>.*?</style>", "", a["data"], count=1, flags=re.S) for _, a in assets]
    if sorted(stripped) != sorted(svgs):
        bad["svg"] = ["asset markup (minus the added <style>) is not byte-identical to the source SVGs"]
    # every asset is referenced exactly once
    text = json.dumps(pack["questions"])
    for name, _ in assets:
        if text.count(f"asset:{name})") != 1:
            bad[name] = [f"referenced {text.count(f'asset:{name})')} times"]
    return {"svg-assets": list(bad.values())[0] if bad else []}


# --------------------------------------------------------------------------- unitary
def unitary_check():
    doc = BeautifulSoup((ROOT / "UNITARY METHOD.html").read_text(encoding="utf-8"), "html.parser")
    pack = load("unitary-method-olympiad-course")
    res = {}
    arts = doc.select("article.q")
    assert len(arts) == len(pack["questions"]) == 140
    for art, q in zip(arts, pack["questions"]):
        probs = []
        assert q["number"] == art["data-id"]
        prob = art.select_one(".problem")
        pack_prob = md_tokens(q.get("stem")) + content_tokens([p["stem"] for p in q.get("parts", [])])
        probs += ["problem: " + p for p in compare(src_tokens(prob), pack_prob)]
        probs += ["nudge: " + p for p in compare(src_tokens(art.select_one(".nudge-own")), content_tokens(q["hints"]))]
        sol = art.select_one("details.answer .solution")
        trained = sol.select_one("p.trained")
        sol_src = []
        for c in sol.children:
            if not isinstance(c, Tag) or c is trained:
                continue
            toks = src_tokens(c)
            if "sol-answer" in (c.get("class") or []):
                assert toks[:2] == ["Final", "answer"], toks[:3]
                toks = toks[2:]  # the "Final answer" heading is not stored (the answer is the solution's answer)
            sol_src += toks
        pack_sol = md_tokens(q["solution"]["answer"]) + md_tokens(q["solution"]["explanation"])
        probs += ["solution: " + p for p in compare(sol_src, pack_sol, allow_missing=lambda t: False)]
        skills = trained.get_text(" ", strip=True)
        if skills != f"Thinking skills in this problem: {q['fields']['Cognitive skill']}.":
            probs.append(f"skills line differs: {skills!r}")
        if q["title"] != art.select_one(".q-title").get_text(strip=True):
            probs.append("title differs")
        res[q["id"]] = probs
    return res


# --------------------------------------------------------------------------- grammar (independent JS evaluation)
def grammar_check():
    scratch = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    dump = ROOT / "ingest" / "lib" / "dump_grammar.mjs"
    out = subprocess.run(["node", str(dump), str(ROOT / "grammar_midterm_mastery_assessment.html")], capture_output=True, text=True, check=True).stdout
    src = json.loads(out)
    pack = load("grammar-midterm-mastery-assessment")
    assert len(src) == len(pack["questions"]) == 180
    unesc = lambda s: re.sub(r"\\([\\`*_\[\]<>|~$&])", r"\1", s.replace("\\\n", "\n")).replace("&#93;", "]")
    res = {}
    for s, q in zip(src, pack["questions"]):
        probs = []
        if s["id"] != q["id"]:
            probs.append("id order")
        if unesc(q["stem"]) != s["prompt"]:
            probs.append("prompt differs")
        letters = "ABCDEFGHIJ"
        if s["type"] in ("single", "multi"):
            if [unesc(o["text"]) for o in q["options"]] != [o["label"] for o in s["options"]]:
                probs.append("options differ")
            want = [s["answer"]] if s["type"] == "single" else list(s["answer"])
            texts = sorted(s["options"][letters.index(L)]["value"] for L in ([q["answer"]] if isinstance(q["answer"], str) else q["answer"]))
            if sorted(want) != texts:
                probs.append(f"answer key differs: {want} vs {texts}")
            if (q["type"] == "mcq_single") != (s["type"] == "single"):
                probs.append("type")
        elif s["type"] == "input":
            if q["answer"] != s["answer"] or q["type"] != "short_answer":
                probs.append("accepted answers differ")
        else:
            if unesc(q["answer"]) != s["answer"] or q["type"] != "open":
                probs.append("model answer differs")
        e = s["explanation"]
        parts = {"Core rule": e["rule"], "Why it works here": e["why"], "Why the tempting answer fails": e["wrong"], "Exam trap": e["trap"],
                 "Nuance / exception": e["nuance"], "Transfer example": e["transfer"], "Remember this": e["remember"]}
        got = {m.group(1): unesc(m.group(2)) for m in re.finditer(r"\*\*([^*]+?):\*\* (.*?)(?=\n\n\*\*|\Z)", q["solution"]["explanation"], flags=re.S)}
        for k, v in parts.items():
            if got.get(k) != v:
                probs.append(f"explanation block {k!r} differs")
        corr = unesc(q["solution"]["answer"])
        if s["type"] == "open":
            if corr != s["answer"] or got.get("Correct answer / model answer") != e["correct"]:
                probs.append("open: model answer / correct block differs")
        elif corr != e["correct"]:
            probs.append("correct answer text differs")
        res[q["id"]] = probs
    return res


total = 0
total += run("class5-calendar-sums", lambda: docx_check("class5-calendar-sums", "Class_5_Calendar_Sums.docx"))
total += run("class5-critical-thinking-calendar-sums", lambda: docx_check("class5-critical-thinking-calendar-sums", "Class_5_Critical_Thinking_Calendar_Sums.docx"))
total += run("equally-spaced-objects-word-problems", lambda: docx_check("equally-spaced-objects-word-problems", "Equally_Spaced_Objects_Word_Problems.docx"))
total += run("advanced-critical-thinking-math-worksheet", lambda: docx_check("advanced-critical-thinking-math-worksheet", "advanced_critical_thinking_math_worksheet.docx"))
total += run("geometry-olympiad-achiever-100 (text)", geometry_check)
total += run("geometry-olympiad-achiever-100 (svg)", svg_check)
total += run("unitary-method-olympiad-course", unitary_check)
total += run("grammar-midterm-mastery-assessment", grammar_check)
(ROOT / "ingest" / "fidelity-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("\nFIDELITY:", "ALL CLEAR" if total == 0 else f"{total} packs/groups with differences")
sys.exit(1 if total else 0)
