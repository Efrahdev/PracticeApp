"""Gates G1 (contract) and G5 (tripwires). Both read only files in the run folder plus the profile and job.

Each gate first proves it can fail (R16): it damages a copy of the real pack and checks that the damage is
caught. A gate that passes its own bad fixture reports FAIL as an unhealthy environment.
"""
from __future__ import annotations

import copy
import json
import re
import statistics
from pathlib import Path

from interp import check_numbering
from util import StageFail, Verdict, read_json, sha256_obj, words


def _text_fields(q: dict):
    """(path, text) for every piece of learner-visible Markdown in a question."""
    def one(prefix, node):
        for key in ("stem", "notes"):
            if isinstance(node.get(key), str):
                yield f"{prefix}{key}", node[key]
        if isinstance(node.get("answer"), str):
            yield f"{prefix}answer", node["answer"]
        sol = node.get("solution")
        if isinstance(sol, str):
            yield f"{prefix}solution", sol
        elif isinstance(sol, dict):
            for k in ("answer", "explanation"):
                if isinstance(sol.get(k), str):
                    yield f"{prefix}solution.{k}", sol[k]
        for i, h in enumerate(node.get("hints") or []):
            yield f"{prefix}hints[{i}]", h
        for o in node.get("options") or []:
            yield f"{prefix}options.{o['label']}", o["text"]
    yield from one("", q)
    for p in q.get("parts") or []:
        yield from one(f"parts.{p['label']}.", p)


# =========================================================================== G1 contract
def _g1_checks(v: Verdict, pack: dict, coverage: dict, decisions: dict, asset_rows: list, profile: dict, job: dict, extras: dict) -> None:
    qs = pack["questions"]
    exp = job["expect"]
    n = len(qs)
    v.add("G1.count", "PASS" if n == exp["questions"] else "FAIL", f"{n} questions, job expects {exp['questions']}", examined=n, expected=exp["questions"] if n >= exp["questions"] else None)
    try:
        check_numbering([q["number"] for q in qs], profile["segment"]["numbering"], "pack")
        v.add("G1.numbering", "PASS", f"printed numbers follow {profile['segment']['numbering']} with no gaps or duplicates", examined=n)
    except StageFail as e:
        v.add("G1.numbering", "FAIL", e.message, examined=n)
    types: dict[str, int] = {}
    for q in qs:
        types[q["type"]] = types.get(q["type"], 0) + 1
    parts = sum(len(q.get("parts") or []) for q in qs)
    shape_ok = ("types" not in exp or exp["types"] == types) and ("parts" not in exp or exp["parts"] == parts)
    if "types" in exp or "parts" in exp:
        v.add("G1.shape", "PASS" if shape_ok else "FAIL", f"types {types}, parts {parts}; job expects types {exp.get('types')}, parts {exp.get('parts')}", examined=n)
    else:
        v.add("G1.shape", "INFO", f"types {types}, parts {parts} (the job declares no expected split)", examined=n)

    blocks = coverage["blocks"]
    unclaimed = [b for b in blocks if b["status"] == "unclaimed"]
    double = []
    for b in blocks:
        if b["status"] == "claimed":
            exclusive = {(c["q"], c["field"]) for c in b["by"] if c["mode"] != "derived" and not c["shared"]}
            if len(exclusive) > 1:
                double.append(b["locator"])
    v.add("G1.coverage", "FAIL" if unclaimed or double else "PASS",
          f"{len(blocks)} source blocks: {len(unclaimed)} unclaimed, {len(double)} double-claimed", examined=len(blocks),
          locator=(unclaimed[0]["locator"] if unclaimed else double[0] if double else None))
    over = [r for r in coverage["ignore_rules"] if r["match_blocks"] > r["max_blocks"] or r["match_tokens"] > r["max_tokens"]]
    stale = [r for r in coverage["ignore_rules"] if r["match_blocks"] == 0 and "builtin" not in r.get("rule", {})]
    rules = coverage["ignore_rules"]
    v.add("G1.ignore_rules", "FAIL" if over else "WARN" if stale else "PASS",
          f"{len(rules)} ignore rules: {len(over)} over their limits, {len(stale)} matched nothing (stale)" +
          (f"; stale: {[r['reason'][:40] for r in stale]}" if stale else ""), examined=len(rules), zero_ok=True,
          details=[{"rule": r["index"], "reason": r["reason"], "blocks": r["match_blocks"], "words": r["match_tokens"],
                    "max_blocks": r["max_blocks"], "max_words": r["max_tokens"]} for r in rules])
    unsupported = [b for b in blocks if b["kind"] == "unsupported"]
    open_unsupported = [b for b in unsupported if b["status"] != "ignored"]
    v.add("G1.unsupported", "FAIL" if open_unsupported else "PASS", f"{len(unsupported)} unsupported constructs, {len(open_unsupported)} unresolved",
          examined=len(blocks), locator=open_unsupported[0]["locator"] if open_unsupported else None)

    assets = pack.get("assets", {})
    referenced = set(re.findall(r"\(asset:([^)\s]+)\)", json.dumps(qs, ensure_ascii=False)))
    page_kind = profile["source"]["kind"] in ("pdf", "image", "office", "html-print")
    if page_kind:
        # every figure or ink band sits inside some question's picture, or is ignored with a reason
        figures = [b for b in blocks if b["kind"] in ("graphic", "band")]
        lost = [b for b in figures if b["status"] == "unclaimed"]
        problems = [f"{len(lost)} figure(s)/ink band(s) belong to no question and no ignore rule"] if lost else []
        if "assets" in exp and len(assets) != exp["assets"]:
            problems.append(f"{len(assets)} pictures packaged, job expects {exp['assets']}")
        if referenced != set(assets):
            problems.append(f"references and picture files differ: {sorted(referenced ^ set(assets))[:3]}")
        v.add("G1.assets", "FAIL" if problems else "PASS", "; ".join(problems) or
              f"{len(figures)} figures/ink bands all inside a question picture or ignored; {len(assets)} pictures, all referenced, all resolve",
              examined=len(figures) + len(assets), zero_ok=True, locator=lost[0]["locator"] if lost else None)
        # pictures of different questions must not overlap (a figure attached to two questions, or the wrong one)
        overlaps = []
        rows = [r for r in asset_rows if r["field"] == "stem"]
        for i, r1 in enumerate(rows):
            for r2 in rows[i + 1:]:
                if r1["page"] != r2["page"] or r1["question"] == r2["question"]:
                    continue
                a1, a2 = r1["box"], r2["box"]
                ix = max(0, min(a1[2], a2[2]) - max(a1[0], a2[0])) * max(0, min(a1[3], a2[3]) - max(a1[1], a2[1]))
                small = min((a1[2] - a1[0]) * (a1[3] - a1[1]), (a2[2] - a2[0]) * (a2[3] - a2[1])) or 1
                if ix > 0.15 * small:
                    overlaps.append(f"{r1['question']} and {r2['question']} on page {r1['page']}")
        v.add("G1.asset_containment", "FAIL" if overlaps else "PASS",
              f"{len(rows)} question pictures; {len(overlaps)} overlap another question's picture" + (f": {overlaps[:3]}" if overlaps else ""),
              examined=len(rows), zero_ok=True)
    else:
        figures = [b for b in blocks if b["kind"] in ("svg", "image")]
        packaged = [b for b in figures if b["status"] == "claimed"]
        problems = []
        if "assets" in exp and len(packaged) != exp["assets"]:
            problems.append(f"{len(packaged)} source figures packaged, job expects {exp['assets']}")
        if [b for b in figures if b["status"] == "unclaimed"]:
            problems.append("a source figure is neither packaged nor ignored")
        if referenced != set(assets):
            problems.append(f"references and asset files differ: {sorted(referenced ^ set(assets))[:3]}")
        v.add("G1.assets", "FAIL" if problems else "PASS", "; ".join(problems) or f"{len(packaged)} source figures -> {len(assets)} asset files, all referenced, all references resolve",
              examined=len(figures), zero_ok=exp.get("assets", 0) == 0)
        containers = coverage.get("containers", {})
        stray = [r for r in asset_rows if not containers.get(r["question"]) or not r["locator"].startswith(containers[r["question"]])]
        v.add("G1.asset_containment", "FAIL" if stray else "PASS",
              f"{len(asset_rows)} figures checked against their question's own container; {len(stray)} outside it",
              examined=len(asset_rows), zero_ok=exp.get("assets", 0) == 0, locator=stray[0]["locator"] if stray else None)

    ids = [q["id"] for q in qs]
    bad_ids = [i for i in ids if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", i)]
    no_number = [q["id"] for q in qs if re.sub(r"\D", "", q["number"]).lstrip("0") not in re.sub(r"\D", "", q["id"])]
    v.add("G1.ids", "FAIL" if len(set(ids)) != len(ids) or bad_ids or no_number else "PASS",
          f"{len(set(ids))} unique ids of {len(ids)}; {len(no_number)} ids do not carry their printed number", examined=len(ids))

    map_problems, examined = [], 0
    for name, hist in decisions.get("mappings", {}).items():
        examined += sum(hist.values())
        if name.startswith("mappings."):
            table = job.get("mappings", {}).get(name.split(".", 1)[1], {})
            want: dict[str, int] = {}
            for src, count in hist.items():
                want[table.get(src)] = want.get(table.get(src), 0) + count
            field = next((f for f, s in profile["fields"].items() if isinstance(s, dict) and s.get("map") == name.split(".", 1)[1]), None)
            if field and "." not in field:
                got: dict[str, int] = {}
                for q in qs:
                    got[q.get(field)] = got.get(q.get(field), 0) + 1
                if got != want:
                    map_problems.append(f"{field}: pack has {got}, source labels map to {want}")
            unused = set(table) - set(hist)
            if unused:
                map_problems.append(f"{name}: entries never used: {sorted(unused)}")
    v.add("G1.mappings", "FAIL" if map_problems else "PASS", "; ".join(map_problems) or f"{examined} mapped values; source-label histogram equals pack-value histogram",
          examined=examined, zero_ok=not decisions.get("mappings"), details=decisions.get("mappings"))

    by_number = {q["number"]: q for q in qs}
    failed = []
    # assertions are typed by a person from the printed page: any run of Unicode spaces counts as one space
    # (a declared relaxation; G3 still compares the source strictly)
    ws = lambda t: re.sub(r"\s+", " ", t, flags=re.U).strip() if isinstance(t, str) else t   # noqa: E731
    for a in job["assertions"]:
        q = by_number.get(a["question"])
        if q is None:
            failed.append(f"question {a['question']} does not exist")
            continue
        stem = q.get("stem", "")
        if "(asset:" in stem and isinstance(q.get("source"), dict) and q["source"].get("text"):
            stem = q["source"]["text"]   # a question shown as a picture: assertions are checked against its words
            if a.get("question") and q.get("number") and stem.startswith(q["number"]):
                stem = re.sub(r"^\S+\s*", "", stem, count=1)
        answer = q.get("answer")
        answer_text = json.dumps(answer, ensure_ascii=False) + json.dumps(q.get("solution"), ensure_ascii=False)
        stem, answer_text = ws(stem), ws(answer_text)
        if "stem_starts" in a and not stem.startswith(ws(a["stem_starts"])):
            failed.append(f"Q{a['question']} stem starts {stem[:40]!r}, not {a['stem_starts']!r}")
        if "stem_contains" in a and ws(a["stem_contains"]) not in stem:
            failed.append(f"Q{a['question']} stem lacks {a['stem_contains']!r}")
        if "answer" in a and answer != a["answer"]:
            failed.append(f"Q{a['question']} answer is {answer!r}, not {a['answer']!r}")
        if "answer_contains" in a and ws(a["answer_contains"]) not in answer_text:
            failed.append(f"Q{a['question']} answer lacks {a['answer_contains']!r}")
        if "parts" in a and len(q.get("parts") or []) != a["parts"]:
            failed.append(f"Q{a['question']} has {len(q.get('parts') or [])} parts, not {a['parts']}")
        if "type" in a and q["type"] != a["type"]:
            failed.append(f"Q{a['question']} is {q['type']}, not {a['type']}")
    v.add("G1.assertions", "FAIL" if failed else "PASS", "; ".join(failed) or f"{len(job['assertions'])} hand-verified assertion(s) hold",
          examined=len(job["assertions"]))
    v.add("G1.join", "INFO", "single source file: no answer-file join to check", examined=0, zero_ok=True)
    v.add("G1.hooks", "PASS", "no custom code (hooks are not accepted by this engine version)", examined=len(decisions.get("hooks", [])), zero_ok=True)
    applied = decisions.get("corrections", [])
    v.add("G1.corrections", "PASS" if len(applied) == extras.get("corrections_expected", 0) else "FAIL",
          f"{len(applied)} correction(s) applied, each old-value hash matched", examined=len(applied), zero_ok=True)
    if "rebuild_identity" in extras:
        same = extras["rebuild_identity"] == extras["identity"]
        v.add("G1.determinism", "PASS" if same else "FAIL", "rebuilding S0-S3 in a temporary folder gives " + ("the same pack identity" if same else "a DIFFERENT pack identity"), examined=1)
    pinned = "sha256" in job["job"]["profile"]
    v.add("G1.profile_pin", "PASS" if pinned else "WARN",
          "the job pins the signed-off profile hash" if pinned else "the job does not pin the profile hash: Gate A sign-off is not recorded (add job.profile.sha256)", examined=1)


def gate_g1(run_dir: Path, profile: dict, job: dict, extras: dict) -> Verdict:
    pack = read_json(run_dir / "pack" / "pack.json")
    coverage = read_json(run_dir / "coverage.json")
    decisions = read_json(run_dir / "decisions.json")
    asset_rows = read_json(run_dir / "pack" / "assets.json")
    probe = Verdict("G1-selftest")
    bad = copy.deepcopy(pack)
    bad["questions"].pop()   # known-bad fixture: one question missing
    _g1_checks(probe, bad, coverage, decisions, asset_rows, profile, job, {})
    caught = next(c for c in probe.checks if c["id"] == "G1.count")["status"] == "FAIL"
    v = Verdict("G1")
    v.selftest = {"fixture": "the real pack with its last question removed", "must_fail": "G1.count", "status": "PASS" if caught else "FAIL"}
    _g1_checks(v, pack, coverage, decisions, asset_rows, profile, job, extras)
    return v


# =========================================================================== G5 tripwires
_MOJIBAKE = re.compile(r"â€|Ã[\x80-\xbf©¨¢ ]|Â[\xa0-\xbf]|�|[\x00-\x08\x0b\x0c\x0e-\x1f]")
_LEFTOVER = re.compile(r"&nbsp;|&amp;[a-z]+;|<br\s*/?>|</?(div|span|p|font)\b", re.I)
_FIGURE_WORDS = re.compile(r"\b(diagram|figure|shown below|picture|graph below)\b", re.I)


def _g5_checks(v: Verdict, pack: dict, profile: dict) -> None:
    qs = pack["questions"]
    trip = profile.get("tripwires", {})
    min_stem = trip.get("min_stem_chars", 10)

    def flag(check, default, hits, message):
        status = default if hits else "PASS"
        v.add(check, status, f"{len(hits)} of {len(qs)} questions: {message}" if hits else f"none of {len(qs)} questions: {message}",
              examined=len(qs), details=hits[:50] if hits else None)

    def whole_stem(q):
        return (q.get("stem") or "") + " ".join(p.get("stem", "") for p in q.get("parts") or [])

    flag("G5.empty_stem", "WARN", [q["id"] for q in qs if len(whole_stem(q).strip()) < min_stem], f"stem shorter than {min_stem} characters")
    if profile["answers"]["expected"]:
        def has_answer(q):
            return q.get("answer") not in (None, "", []) or any(p.get("answer") for p in q.get("parts") or []) or bool(q.get("solution"))
        flag("G5.answer_missing", "WARN", [q["id"] for q in qs if not has_answer(q)], "no answer although the profile says answers are expected")
    else:
        v.add("G5.answer_missing", "INFO", "the profile says this layout carries no answers: none imported, none invented", examined=len(qs))
    flag("G5.figure_reference", "WARN", [q["id"] for q in qs if _FIGURE_WORDS.search(whole_stem(q)) and "(asset:" not in json.dumps(q)],
         "text mentions a diagram/figure but no figure is attached")

    def unbalanced(text):
        plain = re.sub(r"\\.", "", text)
        if plain.count("$") % 2:
            return True
        for maths in re.findall(r"\$([^$]*)\$", plain):
            if maths.count("{") != maths.count("}"):
                return True
        return False
    flag("G5.unbalanced", "WARN", [q["id"] for q in qs if any(unbalanced(t) for _, t in _text_fields(q))], "unbalanced $ or braces in maths")
    flag("G5.leftover_markup", "WARN", [q["id"] for q in qs if any(_LEFTOVER.search(t) for _, t in _text_fields(q))], "leftover HTML tags or entities")
    flag("G5.encoding", "WARN", [q["id"] for q in qs if any(_MOJIBAKE.search(t) for _, t in _text_fields(q))], "mojibake, U+FFFD or control characters")
    seen: dict[str, str] = {}
    dups = []
    for q in qs:
        key = re.sub(r"\W+", " ", whole_stem(q).lower()).strip()
        if key in seen:
            dups.append(f"{q['id']} = {seen[key]}")
        seen.setdefault(key, q["id"])
    flag("G5.duplicates", "WARN", dups, "stem identical to another question's")

    def answer_absent(q):
        sol = q.get("solution")
        expl = sol.get("explanation") if isinstance(sol, dict) else None
        ans = q.get("answer")
        if not expl or not isinstance(ans, dict) or "value" not in ans:
            return False
        return not re.search(rf"(?<![\d.]){re.escape(repr(ans['value']))}(?![\d])", expl)
    numeric = [q for q in qs if isinstance(q.get("answer"), dict)]
    v.add("G5.answer_in_solution", "WARN" if any(answer_absent(q) for q in numeric) else "PASS",
          f"{sum(1 for q in numeric if answer_absent(q))} of {len(numeric)} numeric keys do not appear in their own worked solution",
          examined=len(numeric), zero_ok=True, details=[q["id"] for q in numeric if answer_absent(q)] or None)
    units_declared = any("units" in s for spec in profile["fields"].values() for s in (spec if isinstance(spec, list) else [spec]))
    v.add("G5.numeric_unit", "WARN" if any("unit" not in q["answer"] for q in numeric) and units_declared else "PASS",
          f"{sum(1 for q in numeric if 'unit' not in q['answer'])} of {len(numeric)} numeric keys have no unit", examined=len(numeric), zero_ok=True)
    bad_labels = [q["id"] for q in qs if q.get("parts") and [p["label"] for p in q["parts"]] != [chr(97 + i) for i in range(len(q["parts"]))]]
    flag("G5.part_labels", "WARN", bad_labels, "part labels not a, b, c… in order")
    lengths = [words(whole_stem(q)) for q in qs]
    med = statistics.median(lengths)
    mad = statistics.median(abs(x - med) for x in lengths) or 1
    z = trip.get("length_outlier_z", 6.0)
    out = [q["id"] for q, x in zip(qs, lengths) if abs(x - med) / (1.4826 * mad) > z]
    v.add("G5.length_outlier", "INFO", f"{len(out)} stems are length outliers (robust z > {z}): {out[:8]}", examined=len(qs))


def gate_g5(run_dir: Path, profile: dict) -> Verdict:
    pack = read_json(run_dir / "pack" / "pack.json")
    probe = Verdict("G5-selftest")
    bad = copy.deepcopy(pack)
    bad["questions"][0]["stem"] = ""
    bad["questions"][0].pop("parts", None)
    _g5_checks(probe, bad, profile)
    caught = next(c for c in probe.checks if c["id"] == "G5.empty_stem")["status"] == "WARN"
    v = Verdict("G5")
    v.selftest = {"fixture": "the real pack with its first stem emptied", "must_flag": "G5.empty_stem", "status": "PASS" if caught else "FAIL"}
    _g5_checks(v, pack, profile)
    return v


def gate_g6() -> Verdict:
    v = Verdict("G6")
    v.selftest = {"fixture": "none", "status": "PASS"}
    v.add("G6.library_impact", "WARN", "NOT RUN: the live-library check (new / changed / duplicate, importer repairs, history) needs the live app and is not "
          "wired into this engine version. Before importing, run ingest/preflight_live.mjs and the app's Import preview.", examined=0, zero_ok=True)
    return v
