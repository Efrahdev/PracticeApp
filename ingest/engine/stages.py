"""Corridor stages S0 to S3: intake, extract, segment and map, assemble. Deterministic and offline (R1, R4)."""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import stat
from pathlib import Path

import yaml

from docx_kind import DocxDoc, DocxInterp
from html_adapter import HtmlDoc
from interp import Run
from interp_html import HtmlInterp
from spec import REGISTRY, rx
from util import ENGINE_VERSION, StageFail, atomic_write, canon_bytes, pack_identity, sha256_bytes, sha256_file, sha256_obj, stored_zip, words, write_json

FORMAT = "practice-app/question-pack@1"
MAGIC = {"docx": b"PK\x03\x04", "pdf-text": b"%PDF-"}


def detect_kind(data: bytes) -> str:
    if data.startswith(b"PK\x03\x04"):
        return "docx"
    if data.startswith(b"%PDF-"):
        return "pdf"
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html") or b"<html" in head:
        return "html"
    return "unknown"


def open_doc(kind: str, data: bytes, name: str):
    if kind == "html":
        return HtmlDoc(data, name)
    if kind == "html-json":
        from json_kind import JsonDoc
        return JsonDoc(data, name)
    if kind == "docx":
        return DocxDoc(data, name)
    raise StageFail(f"source kind {kind!r} is not converted by this engine version", check="S1.kind")


def s0_intake(run_dir: Path, source: Path, profile: dict, job: dict) -> dict:
    """Copy the source read-only, hash both copies, check the real format, then the structural probes."""
    dest_dir = run_dir / "source"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / source.name
    if dest.exists():
        os.chmod(dest, stat.S_IRUSR | stat.S_IWUSR)
    shutil.copyfile(source, dest)
    os.chmod(dest, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    sha_a, sha_b = sha256_file(source), sha256_file(dest)
    if sha_a != sha_b:
        raise StageFail("the copied source does not hash like the original", check="S0.copy")
    data = dest.read_bytes()
    kind, real = profile["source"]["kind"], detect_kind(data)
    if {"html": "html", "html-json": "html", "docx": "docx", "pdf-text": "pdf"}[kind] != real:
        raise StageFail(f"profile says the source is {kind} but the file's bytes say {real}", locator=source.name, check="S0.format",
                        hint="wrong profile for this file, or the file has the wrong extension")
    declared = job["sources"][0].get("sha256")
    if declared and declared != sha_a:
        raise StageFail(f"job pins source hash {declared[:12]}… but the file hashes {sha_a[:12]}…: the source changed", locator=source.name, check="S0.tamper")
    return {"name": source.name, "sha256": sha_a, "bytes": len(data), "path": dest, "data": data}


def run_probes(doc, profile: dict) -> list[dict]:
    """Structural predicates that must hold before anything is extracted (S0 step 4)."""
    results = []
    for probe in profile["source"]["probes"]:
        if "css" in probe:
            n, what = len(doc.soup.select(probe["css"])), f"css {probe['css']!r}"
        elif "style" in probe:
            n, what = sum(1 for p in doc.paragraphs if rx(probe["style"]).fullmatch(p["style"])), f"style {probe['style']!r}"
        elif "array" in probe:
            n, what = len(doc.arrays.get(probe["array"], [])), f"array {probe['array']!r}"
        else:
            n, what = sum(1 for b in doc.ledger.blocks if rx(probe["regex"]).search(b["text"])), f"regex {probe['regex']!r}"
        ok = n >= probe["min"] and ("max" not in probe or n <= probe["max"])
        results.append({"probe": what, "found": n, "min": probe["min"], "max": probe.get("max"), "ok": ok})
    bad = [r for r in results if not r["ok"]]
    if bad:
        raise StageFail("structural probes failed: " + "; ".join(f"{r['probe']} found {r['found']} (needs {r['min']}..{r['max'] or '∞'})" for r in bad),
                        check="S0.probes", hint="most likely the wrong profile for this layout; otherwise the source changed")
    return results


def s1_extract(run_dir: Path, doc) -> dict:
    ir = run_dir / "ir"
    lines = "".join(json.dumps(b, ensure_ascii=False, sort_keys=True) + "\n" for b in doc.ledger.blocks)
    atomic_write(ir / "blocks.jsonl", lines.encode("utf-8"))
    kinds: dict[str, int] = {}
    for b in doc.ledger.blocks:
        kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
    report = {"adapter": doc.kind, "elements_seen": doc.elements_seen, "blocks_emitted": len(doc.ledger.blocks), "by_kind": kinds,
              "unsupported": [{"locator": b["locator"], "construct": b.get("construct")} for b in doc.ledger.blocks if b["kind"] == "unsupported"]}
    write_json(ir / "adapter_report.json", report)
    return report


def s2_segment(doc, profile: dict, job: dict):
    run = Run(profile, job, doc.ledger)
    if doc.kind == "html":
        interp = HtmlInterp(doc, run)
    elif doc.kind == "docx":
        interp = DocxInterp(doc, run)
    else:
        from json_kind import JsonInterp
        interp = JsonInterp(doc, run)
    questions, title = interp.questions()
    return run, questions, title


def coverage_failures(ledger) -> list[StageFail]:
    """Unclaimed blocks, double claims, and ignore rules over their declared limits (S2 step 10)."""
    fails = []
    problems = ledger.problems()
    if problems["unclaimed"]:
        first = problems["unclaimed"][0]
        fails.append(StageFail(f"{len(problems['unclaimed'])} source block(s) are neither claimed nor ignored; first: {first['text'][:70]!r}",
                               locator=first["locator"], check="S2.coverage",
                               hint="claim them with a field, or ignore them with a reason and limits (see coverage.json for the full list)"))
    if problems["double"]:
        first = problems["double"][0]
        fails.append(StageFail(f"{len(problems['double'])} block(s) are claimed by two fields; first by {first['claims']}", locator=first["locator"],
                               check="S2.coverage", hint="narrow a selector, or mark the claim shared: true if the duplication is intended"))
    for s in ledger.rule_stats():
        if s["match_blocks"] > s["max_blocks"] or s["match_tokens"] > s["max_tokens"]:
            fails.append(StageFail(f"ignore rule {s['index']} ({s['reason']}) swallowed {s['match_blocks']} blocks / {s['match_tokens']} words, "
                                   f"over its limit of {s['max_blocks']} / {s['max_tokens']}", check="S2.ignore_limits",
                                   hint="an ignore rule matching more than expected usually means it is eating question content"))
    return fails


def load_corrections(path: Path | None) -> tuple[list[dict], str | None]:
    if not path:
        return [], None
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    for c in data:
        missing = {"question_id", "field", "old_value_sha256", "new_value", "reason", "author", "date"} - set(c)
        if missing:
            raise StageFail(f"correction is missing {sorted(missing)}", locator=str(c.get("question_id")), check="S3.corrections")
        c["date"] = str(c["date"])
    return data, sha256_obj(data)


def _get(q: dict, path: str):
    node = q
    for key in path.split("."):
        if isinstance(node, list):
            node = next((p for p in node if p.get("label") == key), None)
        else:
            node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            return None
    return node


def _set(q: dict, path: str, value) -> None:
    keys = path.split(".")
    node = q
    for key in keys[:-1]:
        node = next(p for p in node if p.get("label") == key) if isinstance(node, list) else node[key]
    node[keys[-1]] = value


def s3_assemble(run_dir: Path, run: Run, questions: list[dict], title: str | None, job: dict, source_name: str, corrections: list[dict]) -> dict:
    by_id = {q["id"]: q for q in questions}
    if len(by_id) != len(questions):
        raise StageFail("question ids are not unique", check="S3.ids")
    applied = []
    for c in corrections:   # human fixes are data (R20); a stale one stops the run
        q = by_id.get(c["question_id"].split("/")[-1])
        if q is None:
            raise StageFail(f"correction targets unknown question {c['question_id']}", check="S3.corrections")
        old = _get(q, c["field"])
        old_sha = sha256_obj(old)
        if old_sha != c["old_value_sha256"]:
            raise StageFail(f"stale correction for {c['question_id']} {c['field']}: the engine now extracts a different value "
                            f"(sha {old_sha[:12]}… not {c['old_value_sha256'][:12]}…)", locator=c["question_id"], check="S3.corrections",
                            hint="re-check the correction against the new value and update old_value_sha256")
        _set(q, c["field"], c["new_value"])
        applied.append({**c, "old_value": old})
    for q in questions:
        q.setdefault("source", {})["locator"] = run.containers.get(q["id"])
    used = set()
    for q in questions:
        used.update(re.findall(r"\(asset:([^)\s]+)\)", json.dumps(q, ensure_ascii=False)))
    unreferenced = sorted(set(run.assets) - used)
    unresolved = sorted(used - set(run.assets))
    if unreferenced or unresolved:
        raise StageFail(f"assets out of step: unreferenced {unreferenced[:3]}, unresolved {unresolved[:3]}", check="S3.assets")
    meta = {"id": job["pack"]["id"], "title": title or job["pack"]["title"], "source": job["pack"].get("source", source_name),
            **{k: v for k, v in job["pack"].items() if k not in ("id", "title", "source")}}
    pack = {"format": FORMAT, "pack": meta, "questions": questions}
    if run.assets:
        pack["assets"] = {name: run.assets[name] for name in sorted(run.assets)}
    pack_dir = run_dir / "pack"
    entries = {"pack.json": canon_bytes(pack, pretty=True)}
    for name, asset in sorted(run.assets.items()):
        entries[f"assets/{name}.svg"] = asset["data"].encode("utf-8")
    for name, data in entries.items():
        atomic_write(pack_dir / name, data)
    write_json(pack_dir / "assets.json", run.asset_rows)
    zip_bytes = stored_zip(entries)
    atomic_write(pack_dir / "pack.zip", zip_bytes)
    content_hashes = {q["id"]: sha256_obj(q) for q in questions}
    write_json(pack_dir / "content_hashes.json", content_hashes)
    run.decisions["corrections"] = applied
    return {"identity_sha256": pack_identity(entries), "json_sha256": sha256_bytes(entries["pack.json"]), "zip_sha256": sha256_bytes(zip_bytes),
            "question_count": len(questions), "asset_count": len(run.assets), "pack": pack}


def environment() -> dict:
    lock = Path(__file__).resolve().parents[2] / "package-lock.json"
    req = Path(__file__).resolve().parents[1] / "requirements.lock"
    return {"version": ENGINE_VERSION, "python": platform.python_version(), "registry_sha256": sha256_obj(REGISTRY),
            "lockfile_sha256": sha256_file(lock) if lock.exists() else None, "python_lock_sha256": sha256_file(req) if req.exists() else None}


def convert(run_dir: Path, source: Path, profile: dict, job: dict, corrections_path: Path | None):
    """S0 to S3. Returns everything the gates and the manifest need. Raises StageFail to stop."""
    src = s0_intake(run_dir, source, profile, job)
    doc = open_doc(profile["source"]["kind"], src["data"], src["name"])
    probes = run_probes(doc, profile)
    adapter = s1_extract(run_dir, doc)
    run, questions, title = s2_segment(doc, profile, job)
    coverage = doc.ledger.as_dict()
    coverage["containers"] = run.containers
    write_json(run_dir / "coverage.json", coverage, pretty=False)
    fails = coverage_failures(doc.ledger)
    stale = [s for s in doc.ledger.rule_stats() if s["match_blocks"] == 0]
    run.decisions["ignore_rules"] = doc.ledger.rule_stats()
    run.decisions["stale_ignore_rules"] = [s["index"] for s in stale]
    run.decisions["ignored_words"] = sum(s["match_tokens"] for s in doc.ledger.rule_stats())
    run.decisions["added_literals"] = len(doc.ledger.added)
    if fails:
        write_json(run_dir / "decisions.json", run.decisions)
        raise fails[0]
    corrections, corr_sha = load_corrections(corrections_path)
    packed = s3_assemble(run_dir, run, questions, title, job, src["name"], corrections)
    write_json(run_dir / "decisions.json", run.decisions)
    return {"source": src, "doc": doc, "probes": probes, "adapter": adapter, "run": run, "packed": packed, "corrections_sha256": corr_sha}
