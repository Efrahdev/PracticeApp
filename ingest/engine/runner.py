"""Orchestration: `ingest run` (S0-S5, stops at Gate B), `ingest try`, `ingest status`, `ingest oracle`."""
from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import gates
import stages
from htmlmd import esc_lines
from util import (ENGINE_VERSION, EXIT_FAIL, EXIT_FOR, EXIT_PASS, EXIT_USAGE, ORDER, StageFail, UsageError, log, log_context, read_json,
                  sha256_file, sha256_obj, write_json)

INGEST = Path(__file__).resolve().parents[1]
ROOT = INGEST.parent

# G4.hostile: escaping is defined by test, not by guess (spec S2). Every string must come back from the app's
# real renderer as the same visible text.
HOSTILE = ["a [b] c", "see [note](x) here", "[1]: not a link", "cost $5 and $10", "2 * 3 * 4", "snake_case_name and __init__", "`code` tick",
           "back\\slash", "a < b > c", "AT&T and &amp; and &#93;", "x | y | z", "~~struck~~ not", "___ fill the blank ___", "50% of *all*",
           "f(x) = [admires Sam]", "{curly} braces", "tag <b>not bold</b>", "a ] ( b", "#hash mid-line", "ends with backslash \\", "1.5 × 2 = 3",
           "1) first event", "2. second item", "# not a heading", "+ not a list", "- not a list", "=== not a rule", "10) ten"]


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _node(script: str, *args: str) -> tuple[int, str]:
    env = dict(os.environ, NODE_PATH=str(ROOT / "node_modules") + os.pathsep + "/opt/node-tools/node_modules")
    p = subprocess.run(["node", str(INGEST / "checker" / script), *args], capture_output=True, text=True, cwd=str(ROOT), env=env, timeout=900)
    return p.returncode, (p.stderr or p.stdout).strip()


def _worst(statuses) -> str:
    worst = "PASS"
    for s in statuses:
        if ORDER[s] > ORDER[worst]:
            worst = s
    return worst


def _write_inputs(run_dir: Path, profile, job, psha, jsha, conv, profile_path: Path | None, job_path: Path | None) -> None:
    d = run_dir / "inputs"
    write_json(d / "profile.json", profile)
    write_json(d / "job.json", job)
    for p in (profile_path, job_path):
        if p:
            shutil.copyfile(p, d / p.name)
    write_json(d / "inputs.json", {"source": {"name": conv["source"]["name"], "sha256": conv["source"]["sha256"], "bytes": conv["source"]["bytes"]},
                                   "profile_sha256": psha, "job_sha256": jsha, "corrections_sha256": conv["corrections_sha256"],
                                   "pack_identity_sha256": conv["packed"]["identity_sha256"], "page_source": conv.get("page_source")})
    write_json(run_dir / "gates" / "hostile.json", [{"raw": s, "escaped": esc_lines(s)} for s in HOSTILE])


def run_gates(run_dir: Path, profile, job, extras) -> dict[str, dict]:
    """S4. Every gate runs even when an earlier one fails, so the reviewer sees all problems at once."""
    out = {}
    v = gates.gate_g1(run_dir, profile, job, extras)
    v.write(run_dir / "gates" / "g1.json")
    out["g1"] = v.as_dict()
    for g in ("g2", "g3", "g4"):
        code, err = _node("gate.mjs", g, str(run_dir))
        path = run_dir / "gates" / f"{g}.json"
        if code in (0, 10, 20) and path.exists():
            out[g] = read_json(path)
        else:   # a gate that cannot run is a FAIL, never a silent pass (R2)
            broken = {"gate": g.upper(), "selftest": None, "status": "FAIL",
                      "checks": [{"id": f"{g.upper()}.ran", "status": "FAIL", "message": f"the gate did not run (exit {code}): {err[-600:]}", "examined": 0, "expected": None}]}
            write_json(path, broken)
            out[g] = broken
    v = gates.gate_g5(run_dir, profile)
    v.write(run_dir / "gates" / "g5.json")
    out["g5"] = v.as_dict()
    v = gates.gate_g6()
    v.write(run_dir / "gates" / "g6.json")
    out["g6"] = v.as_dict()
    return out


def gate_lines(verdicts: dict) -> list[str]:
    lines = []
    for g, v in verdicts.items():
        st = v.get("selftest") or {}
        lines.append(f"  {v['status']:<4} {g.upper()}  ({len(v['checks'])} checks; self-test {st.get('status', '-')})")
        for c in v["checks"]:
            if c["status"] in ("WARN", "FAIL"):
                lines.append(f"         {c['status']} {c['id']}: {c['message'][:230]}")
    return lines


def run(args, profile, job, psha, jsha, source: Path, corrections: Path | None, profile_path: Path, job_path: Path) -> int:
    src_sha = sha256_file(source)
    corr_sha = sha256_file(corrections) if corrections else None
    key = sha256_obj([src_sha, psha, jsha, corr_sha])[:6]
    runs = Path(args.runs_dir)
    existing = sorted(runs.glob(f"*_{job['job']['id']}_{key}")) if runs.exists() else []
    run_dir = existing[0] if existing else runs / f"{datetime.date.today().isoformat()}_{job['job']['id']}_{key}"
    run_id = run_dir.name
    log_context(run_id=run_id, stage="S0")
    if (run_dir / "approval.receipt.json").exists():
        raise UsageError(f"{run_dir} is already approved; its inputs are unchanged, so there is nothing to re-run")
    run_dir.mkdir(parents=True, exist_ok=True)
    lock = run_dir / ".lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except FileExistsError:
        raise UsageError(f"another run holds {lock}; if no run is active, delete the lock file")
    manifest = {"run_id": run_id, "engine": stages.environment(), "profile": {"id": profile["profile"]["id"], "version": profile["profile"]["version"], "sha256": psha},
                "job": {"id": job["job"]["id"], "sha256": jsha}, "corrections": {"sha256": corr_sha} if corr_sha else None,
                "sources": [{"name": source.name, "sha256": src_sha, "bytes": source.stat().st_size}], "stages": {}, "started": _now()}
    try:
        for stale in ("pack", "gates", "review", "ir", "inputs"):
            shutil.rmtree(run_dir / stale, ignore_errors=True)
        try:
            conv = stages.convert(run_dir, source, profile, job, corrections)
        except StageFail as e:
            stage = (e.check or "S?").split(".")[0]
            manifest["stages"][stage] = {"status": "FAIL", "ended": _now(), **e.as_dict()}
            write_json(run_dir / "manifest.json", manifest)
            log("error", "stage_failed", **e.as_dict())
            raise
        packed = conv["packed"]
        for s in ("S0", "S1", "S2", "S3"):
            manifest["stages"][s] = {"status": "PASS"}
        manifest["stages"]["S0"]["probes"] = conv["probes"]
        manifest["stages"]["S1"]["adapter"] = conv["adapter"]
        manifest["pack"] = {k: packed[k] for k in ("identity_sha256", "json_sha256", "zip_sha256", "question_count", "asset_count")}
        _write_inputs(run_dir, profile, job, psha, jsha, conv, profile_path, job_path)
        # G1.determinism: build again somewhere else and compare the identity
        with tempfile.TemporaryDirectory(prefix="ingest-rebuild-") as tmp:
            again = stages.convert(Path(tmp), source, profile, job, corrections)["packed"]["identity_sha256"]
            for p in Path(tmp).rglob("*"):
                if p.is_file():
                    os.chmod(p, 0o600)
        extras = {"identity": packed["identity_sha256"], "rebuild_identity": again,
                  "corrections_expected": len(stages.load_corrections(corrections)[0])}
        log_context(stage="S4")
        verdicts = run_gates(run_dir, profile, job, extras)
        overall = _worst(v["status"] for v in verdicts.values())
        manifest["stages"]["S4"] = {"status": overall, "gates": {g: v["status"] for g, v in verdicts.items()}}
        write_json(run_dir / "manifest.json", manifest)
        log_context(stage="S5")
        import review
        review.build(run_dir, profile, job, verdicts, manifest)
        manifest["stages"]["S5"] = {"status": "PASS"}
        manifest["ended"] = _now()
        write_json(run_dir / "manifest.json", manifest)
    finally:
        lock.unlink(missing_ok=True)
    rel = os.path.relpath(run_dir, Path.cwd())
    lines = [f"run {run_id}", f"  source   {source.name}  sha256 {src_sha[:12]}…", f"  profile  {profile['profile']['id']} v{profile['profile']['version']}  sha256 {psha[:12]}…",
             f"  pack     {packed['question_count']} questions, {packed['asset_count']} figures  identity {packed['identity_sha256'][:12]}…", "gates"] + gate_lines(verdicts)
    if overall == "FAIL":
        lines += ["", "STOPPED: a gate failed. A FAIL cannot be waived: fix the cause (profile, job or source) and run again."]
    else:
        lines += ["", "Stopped at Gate B (review and approval). Nothing has been imported.",
                  f"  1. open  {rel}/review/index.html", f"  2. fill  {rel}/review/approval.template.json  and save it as  {rel}/approval.json",
                  f"  3. run   ingest approve-check {rel}"]
    payload = {"run_id": run_id, "run_dir": str(run_dir), "status": overall, "pack": manifest["pack"], "gates": {g: v["status"] for g, v in verdicts.items()}}
    print(json.dumps(payload, indent=2, sort_keys=True) if args.json else "\n".join(lines))
    return EXIT_FOR[overall]


def try_profile(args, profile, job, psha, jsha, source: Path, lint_lines) -> int:
    """`profile try` (W8): S0-S3 in a scratch folder. Output can never be approved: it has no manifest and no gates."""
    out = Path(args.out) if args.out else INGEST / "scratch" / f"try-{job['job']['id']}"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    lines = list(lint_lines)
    try:
        conv = stages.convert(out, source, profile, job, None)
    except StageFail as e:
        cov = out / "coverage.json"
        lines += [f"FAIL  {e.check}: {e.message}"] + ([f"      where: {e.locator}"] if e.locator else []) + ([f"      next:  {e.hint}"] if e.hint else [])
        if cov.exists():   # a failing profile still gets its report: this is the iteration loop
            blocks = read_json(cov)["blocks"]
            unclaimed = [b for b in blocks if b["status"] == "unclaimed"]
            groups: dict[str, list] = {}
            for b in unclaimed:
                k = re.sub(r":nth-of-type\(\d+\)|\[\d+\]|#[\w-]*\d[\w-]*", "", b["locator"].split(" :: ")[0])
                groups.setdefault(k, []).append(b)
            if unclaimed:
                lines.append(f"\n{len(unclaimed)} unclaimed block(s), grouped by where they sit (count, place, first text):")
                for k, bs in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:40]:
                    lines.append(f"  {len(bs):>4}  {k}  |  {bs[0]['text'].strip()[:60]!r}")
            lines.append(f"\nfull ledger: {cov}")
        print("\n".join(lines))
        return EXIT_FAIL
    packed = conv["packed"]
    pack = packed["pack"]
    types: dict[str, int] = {}
    for q in pack["questions"]:
        types[q["type"]] = types.get(q["type"], 0) + 1
    _write_inputs(out, profile, job, psha, jsha, conv, None, None)
    import review
    sample, _ = review.choose_sample(pack, conv["run"].decisions, {}, {}, packed["identity_sha256"])
    write_json(out / "try-items.json", [{"key": f"t{i:03d}", "question_id": s["question_id"], "why": s["why"], "question": s["question"]} for i, s in enumerate(sample[:14], start=1)])
    code, err = _node("sidebyside.mjs", str(out), str(out / "try-items.json"), str(out / "try.html"), "try")
    stats = conv["doc"].ledger.rule_stats()
    lines += [f"S0-S3 OK  {packed['question_count']} questions, {packed['asset_count']} figures, types {types}",
              f"          parts {sum(len(q.get('parts') or []) for q in pack['questions'])}; "
              f"ignored {sum(s['match_blocks'] for s in stats)} blocks / {sum(s['match_tokens'] for s in stats)} words across {len(stats)} rules"]
    for s in stats:
        lines.append(f"            ignore[{s['index']}] {s['match_blocks']:>4} blocks {s['match_tokens']:>5} words (limits {s['max_blocks']}/{s['max_tokens']})  {s['reason'][:70]}")
    lines += [f"side by side: {out / 'try.html'}" if code == 0 else f"side-by-side page not built: {err[-300:]}", f"pack:         {out / 'pack' / 'pack.json'}",
              f"profile sha256 {psha}", "This is a trial: it is never written to runs/ and cannot be approved."]
    print("\n".join(lines))
    return EXIT_PASS


def status(args) -> int:
    run_dir = Path(args.run_dir)
    if not (run_dir / "manifest.json").exists():
        raise UsageError(f"{run_dir} has no manifest.json")
    m = read_json(run_dir / "manifest.json")
    verdicts = {p.stem: read_json(p) for p in sorted((run_dir / "gates").glob("g?.json"))}
    approved = (run_dir / "approval.receipt.json").exists()
    lines = [f"run {m['run_id']}  engine {m['engine']['version']}", f"  stages  " + "  ".join(f"{s}:{v['status']}" for s, v in m["stages"].items())]
    if "pack" in m:
        lines.append(f"  pack    {m['pack']['question_count']} questions, {m['pack']['asset_count']} figures, identity {m['pack']['identity_sha256'][:12]}…")
    lines += gate_lines(verdicts) + [f"  approval: {'RECEIPT PRESENT' if approved else 'none (stopped at Gate B)'}"]
    print(json.dumps({"manifest": m, "gates": {g: v["status"] for g, v in verdicts.items()}, "approved": approved}, indent=2, sort_keys=True) if args.json else "\n".join(lines))
    return EXIT_PASS


def oracle(args) -> int:
    """Golden oracle (spec 12.2): compare this run's pack with a pack made earlier by another route."""
    new = read_json(Path(args.run_dir) / "pack" / "pack.json")
    old = read_json(Path(args.old_pack))

    def canon(pack):
        # figures are matched by their drawing (the bytes without the added <style> block), not by their names
        assets = {k: sha256_obj(re.sub(r"<style>.*?</style>", "", v["data"], flags=re.S)) for k, v in pack.get("assets", {}).items()}
        text = json.dumps(pack["questions"], ensure_ascii=False, sort_keys=True)
        qs = json.loads(re.sub(r"asset:([^)\s\"\\]+)", lambda m: "asset:" + assets[m.group(1)][:16] if m.group(1) in assets else m.group(0), text))
        for q in qs:
            q.get("source", {}).pop("locator", None)
        return qs
    a, b = canon(new), canon(old)
    diffs = []
    if len(a) != len(b):
        diffs.append(f"question count {len(a)} vs {len(b)}")
    for x, y in zip(a, b):
        for k in sorted(set(x) | set(y)):
            if x.get(k) != y.get(k):
                diffs.append(f"{x.get('id')}.{k}: new {json.dumps(x.get(k), ensure_ascii=False)[:90]} | old {json.dumps(y.get(k), ensure_ascii=False)[:90]}")
    if new["pack"] != old["pack"]:
        diffs.append(f"pack header: new {new['pack']} | old {old['pack']}")
    na, oa = new.get("assets", {}), old.get("assets", {})
    asset_note = ""
    if na or oa:
        strip = lambda s: re.sub(r"<style>.*?</style>", "", s["data"], flags=re.S)   # noqa: E731
        same_drawing = sorted(strip(v) for v in na.values()) == sorted(strip(v) for v in oa.values())
        same_bytes = sorted(v["data"] for v in na.values()) == sorted(v["data"] for v in oa.values())
        asset_note = f"figures: {len(na)} vs {len(oa)}; drawing markup {'identical' if same_drawing else 'DIFFERENT'}; added <style> block {'identical' if same_bytes else 'differs (see oracle-diffs.yaml)'}"
        if not same_drawing or len(na) != len(oa):
            diffs.append(asset_note)
    if asset_note and "differs" in asset_note and asset_note not in diffs:
        diffs.append(asset_note)
    import yaml
    listed = yaml.safe_load((INGEST / "oracle-diffs.yaml").read_text(encoding="utf-8")) or [] if (INGEST / "oracle-diffs.yaml").exists() else []
    pid = new["pack"]["id"]
    explained, unexplained = [], []
    for d in diffs:
        why = next((e["reason"] for e in listed if e["pack"] == pid and e["match"] in d), None)
        (explained if why else unexplained).append({"difference": d, "reason": why} if why else d)
    out = {"questions_compared": min(len(a), len(b)), "explained": explained, "unexplained": unexplained, "figures": asset_note}
    print(json.dumps(out, indent=2, ensure_ascii=False) if args.json else
          "\n".join([f"compared {out['questions_compared']} questions: {len(unexplained)} unexplained difference(s), {len(explained)} explained in oracle-diffs.yaml"]
                    + unexplained[:30] + [f"  explained: {e['difference'][:120]}" for e in explained]))
    return EXIT_FAIL if unexplained else EXIT_PASS
