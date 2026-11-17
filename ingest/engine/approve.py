"""`ingest approve-check` (W11, spec 9.3): Gate B. Refuses, naming the exact mismatch, unless the approval
is bound to exactly this source, profile, job, corrections and pack content."""
from __future__ import annotations

import datetime
from pathlib import Path

import spec
from util import ENGINE_VERSION, EXIT_FAIL, EXIT_PASS, UsageError, pack_identity, read_json, sha256_file, sha256_obj, write_json

VERDICTS = ("ok", "defect", "unsure")


def check(run_dir: Path) -> tuple[list[str], list[str], dict]:
    problems, notes = [], []
    if not (run_dir / "manifest.json").exists():
        raise UsageError(f"{run_dir} is not a run folder (no manifest.json)")
    manifest = read_json(run_dir / "manifest.json")
    path = run_dir / "approval.json"
    if not path.exists():
        raise UsageError(f"{path} does not exist: copy review/approval.template.json there and fill it in")
    try:
        a = read_json(path)
    except Exception as e:  # noqa: BLE001
        return [f"approval.json is not valid JSON: {e}"], notes, {}
    need = ["decision", "reviewer", "profile_author", "source_sha256", "profile_sha256", "job_sha256", "corrections_sha256", "pack_identity_sha256",
            "engine_version", "reviewed_items", "answers_verified", "waivers", "approved_at"]
    missing = [k for k in need if k not in a]
    if missing:
        return [f"approval.json is missing {missing}"], notes, a
    placeholder = lambda v: not isinstance(v, str) or not v.strip() or v.strip().startswith("<")   # noqa: E731
    # 1. shape, reviewer, answers_verified
    if placeholder(a["reviewer"]):
        problems.append("reviewer is empty")
    if placeholder(a["profile_author"]):
        problems.append("profile_author is empty")
    elif not placeholder(a["reviewer"]) and a["reviewer"].strip().lower() == a["profile_author"].strip().lower():
        problems.append(f"reviewer and profile_author are the same ({a['reviewer']!r}): the reviewer must be a different person or session")
    if read_json(run_dir / "coverage.json").get("transcribed") and a.get("numerals_checked") != "full":
        problems.append("this run has values read off pictures by a person or an AI (transcribed): approval needs numerals_checked: full (every number checked against the page)")
    if a["answers_verified"] not in ("none", "sampled", "full"):
        problems.append("answers_verified must be none, sampled or full")
    if placeholder(a["approved_at"]):
        problems.append("approved_at is empty")
    # 2. decision
    if a["decision"] != "approve":
        problems.append(f"decision is {a['decision']!r}, not 'approve'")
    # 3. hashes, recomputed from the run folder (never read back from the manifest)
    inputs = read_json(run_dir / "inputs" / "inputs.json")
    src = run_dir / "source" / inputs["source"]["name"]
    profile = read_json(run_dir / "inputs" / "profile.json")
    job = read_json(run_dir / "inputs" / "job.json")
    pack_dir = run_dir / "pack"
    entries = {"pack.json": (pack_dir / "pack.json").read_bytes()}
    for f in sorted((pack_dir / "assets").glob("*")) if (pack_dir / "assets").exists() else []:
        entries[f"assets/{f.name}"] = f.read_bytes()
    actual = {"source_sha256": sha256_file(src), "profile_sha256": spec.profile_hash(profile), "job_sha256": spec.job_hash(job),
              "corrections_sha256": inputs["corrections_sha256"], "pack_identity_sha256": pack_identity(entries)}
    for k, v in actual.items():
        if a[k] != v:
            problems.append(f"{k} does not match: approval has {str(a[k])[:16]}…, the run folder has {str(v)[:16]}… (something changed after the packet was built)")
    if actual["pack_identity_sha256"] != manifest["pack"]["identity_sha256"]:
        problems.append("the pack on disk no longer matches the manifest: it was edited after the run")
    # 4-5. gates and waivers
    waived = {(w.get("gate", "").upper(), w.get("check_id")): w for w in a["waivers"] if isinstance(w, dict)}
    seen = set()
    for g in sorted((run_dir / "gates").glob("g?.json")):
        v = read_json(g)
        if (v.get("selftest") or {}).get("status") == "FAIL":
            problems.append(f"{v['gate']} failed its own self-test (unhealthy environment)")
        for c in v["checks"]:
            seen.add((v["gate"], c["id"]))
            if c["status"] == "FAIL":
                problems.append(f"{c['id']} is FAIL: a FAIL can never be waived. Fix the cause and run again")
                if (v["gate"], c["id"]) in waived:
                    problems.append(f"waiver for {c['id']} points at a FAIL")
            elif c["status"] == "WARN":
                w = waived.get((v["gate"], c["id"]))
                if not w or placeholder(w.get("reason")):
                    problems.append(f"{c['id']} is WARN and has no waiver with a written reason")
    for key in waived:
        if key not in seen:
            problems.append(f"waiver names {key[1]!r}, which is not a check in this run")
    if len(seen) < 20 or len(list((run_dir / "gates").glob("g?.json"))) != 6:
        problems.append("the run does not have all six gate files")
    # 6. review items and canaries
    required = {p["key"]: p for p in read_json(run_dir / "review" / "items.json")}
    canaries = {c["item"]: c for c in read_json(run_dir / "sealed" / "canaries.json")["items"]}
    given = {r.get("item"): r for r in a["reviewed_items"] if isinstance(r, dict)}
    answered = 0
    for key, p in required.items():
        r = given.get(key)
        if not r or r.get("verdict") not in VERDICTS:
            problems.append(f"review item {key} ({p['question_id']}) has no verdict")
            continue
        answered += 1
        if r.get("content_sha256") != p["content_sha256"]:
            problems.append(f"review item {key}: content hash differs from the packet (the verdict is for other content)")
        if key in canaries:
            if r["verdict"] == "ok":
                problems.append(f"review item {key} was corrupted on purpose ({canaries[key]['canary']}) and was marked ok: the review missed a planted error")
        elif r["verdict"] == "defect":
            problems.append(f"review item {key} ({p['question_id']}) is marked defect: fix it (profile or corrections overlay) and run again")
        elif r["verdict"] == "unsure":
            problems.append(f"review item {key} ({p['question_id']}) is unresolved (unsure)")
    for key in given:
        if key not in required:
            problems.append(f"approval lists item {key!r}, which is not in the packet")
    # 7. engine version: recorded, a mismatch asks for delta review rather than rejecting (spec 9.4)
    if a["engine_version"] != ENGINE_VERSION:
        notes.append(f"approval was written for engine {a['engine_version']}, this is {ENGINE_VERSION}: the pack identity still matches, so the approval stands")
    notes.append(f"{answered} of {len(required)} review items answered, {len(canaries)} planted errors all caught" if not problems else f"{answered} of {len(required)} review items answered")
    return problems, notes, a


def main(args) -> int:
    run_dir = Path(args.run_dir)
    problems, notes, approval = check(run_dir)
    receipt = run_dir / "approval.receipt.json"
    if problems:
        receipt.unlink(missing_ok=True)
        print("\n".join([f"REFUSED: {len(problems)} problem(s)"] + [f"  - {p}" for p in problems[:40]] + [f"  note: {n}" for n in notes]))
        return EXIT_FAIL
    manifest = read_json(run_dir / "manifest.json")
    rec = {"status": "approved", "checked_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "reviewer": approval["reviewer"],
           "profile_author": approval["profile_author"], "answers_verified": approval["answers_verified"], "approval_sha256": sha256_file(run_dir / "approval.json"),
           "pack_identity_sha256": approval["pack_identity_sha256"], "waivers": approval["waivers"], "engine_version": ENGINE_VERSION,
           "question_content_sha256": sha256_obj(read_json(run_dir / "pack" / "content_hashes.json"))}
    write_json(receipt, rec)
    manifest["approval"] = rec
    write_json(run_dir / "manifest.json", manifest)
    print("\n".join([f"APPROVED: receipt written to {receipt}"] + [f"  note: {n}" for n in notes] +
                    ["The pack is pack/pack.zip (or pack/pack.json). Import it with the app's Import screen; run ingest/preflight_live.mjs first."]))
    return EXIT_PASS
