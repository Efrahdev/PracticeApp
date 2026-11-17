"""`ingest` command line (work package W13).

  ingest probe FILE... [--out DIR]            facts about a source, for the profiling AI (read-only)
  ingest brief FILE... [--out FILE]           the paste-ready profiling brief: prompt + schema + probe report
  ingest lint PROFILE [JOB]                   check an AI-written profile (and job) without running it
  ingest try PROFILE [JOB] [--source F]       run S0-S3 in a scratch folder and show the result beside the source
  ingest run PROFILE [JOB] [--source F]       the corridor: S0-S5, always stops at Gate B
                                              (PROFILE may hold the profile, '---', then the job: the AI's reply as one file)
  ingest status RUN_DIR                       what a run did
  ingest approve-check RUN_DIR                validate approval.json against the run (Gate B)
  ingest oracle RUN_DIR OLD_PACK.json         compare a run's pack with an existing pack

Exit codes (R10): 0 PASS, 10 WARN, 20 FAIL, 30 usage or configuration, 40 internal error.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from util import EXIT_FAIL, EXIT_FOR, EXIT_INTERNAL, EXIT_PASS, EXIT_USAGE, EXIT_WARN, StageFail, UsageError  # noqa: E402

INGEST = Path(__file__).resolve().parents[1]


def emit(args, payload: dict, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(text)


def fail_text(e: StageFail) -> str:
    out = [f"FAIL  {e.check or 'stage'}: {e.message}"]
    if e.locator:
        out.append(f"      where: {e.locator}")
    if e.hint:
        out.append(f"      next:  {e.hint}")
    return "\n".join(out)


def print_lint(lint, label: str) -> list[str]:
    lines = []
    for kind, items in (("ERROR", lint.errors), ("warn ", lint.warnings)):
        for it in items:
            where = f"line {it['line']}" if it["line"] else "line ?"
            lines.append(f"{kind} {label}:{where} {it['path']}  [{it['code']}] {it['message']}")
    return lines


def load_checked(args):
    import spec
    profile_path = Path(args.profile)
    job_path = Path(args.job) if getattr(args, "job", None) else None
    for p in (profile_path, job_path):
        if p and not p.exists():
            raise UsageError(f"no such file: {p}")
    profile, plint, job, jlint, psha, jsha = spec.load_pair(profile_path, job_path)
    lines = print_lint(plint, profile_path.name) + (print_lint(jlint, (job_path or profile_path).name) if jlint else [])
    errors = len(plint.errors) + (len(jlint.errors) if jlint else 0)
    return profile, job, psha, jsha, lines, errors, (job_path or profile_path)


def cmd_lint(args) -> int:
    profile, job, psha, jsha, lines, errors, _ = load_checked(args)
    payload = {"errors": errors, "messages": lines, "profile_sha256": psha, "job_sha256": jsha}
    text = "\n".join(lines + ([f"{errors} error(s). Fix every one and lint again."] if errors else
                              [f"profile OK  sha256 {psha}"] + ([f"job OK      sha256 {jsha}"] if jsha else [])))
    emit(args, payload, text)
    return EXIT_FAIL if errors else EXIT_PASS


def resolve_source(job: dict, job_file: Path, override: str | None = None) -> Path:
    """The raw input: --source wins (the usual handover: AI reply + raw file), else the job's own path."""
    if override:
        src = Path(override).resolve()
        if not src.exists():
            raise UsageError(f"--source file not found: {src}")
        return src
    src = (job_file.parent / job["sources"][0]["file"]).resolve()
    if not src.exists():
        raise UsageError(f"job source not found: {src}")
    return src


def cmd_try(args) -> int:
    import runner
    profile, job, psha, jsha, lines, errors, job_file = load_checked(args)
    if errors or job is None:
        print("\n".join(lines + ["lint failed (or no job given): nothing was run."]))
        return EXIT_FAIL if errors else EXIT_USAGE
    return runner.try_profile(args, profile, job, psha, jsha, resolve_source(job, job_file, args.source), lines)


def cmd_run(args) -> int:
    import runner
    profile, job, psha, jsha, lines, errors, job_file = load_checked(args)
    if errors or job is None:
        print("\n".join(lines + ["lint failed (or no job given): nothing was run."]))
        return EXIT_FAIL if errors else EXIT_USAGE
    corrections = Path(args.corrections) if args.corrections else None
    return runner.run(args, profile, job, psha, jsha, resolve_source(job, job_file, args.source), corrections, Path(args.profile), job_file)


def cmd_probe(args) -> int:
    import probe
    return probe.main(args)


def cmd_brief(args) -> int:
    import probe
    return probe.brief(args)


def cmd_status(args) -> int:
    import runner
    return runner.status(args)


def cmd_approve_check(args) -> int:
    import approve
    return approve.main(args)


def cmd_oracle(args) -> int:
    import runner
    return runner.oracle(args)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="ingest", description="AI-free document ingestion: profile + source file -> checked question pack.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--json", action="store_true", help="machine-readable output")
        p.set_defaults(fn=fn)
        return p

    p = add("probe", cmd_probe, "report a source's structure (read-only, deterministic)")
    p.add_argument("files", nargs="+")
    p.add_argument("--out", help="folder for probe.json and probe.md")
    p = add("brief", cmd_brief, "build the paste-ready profiling brief for an AI model")
    p.add_argument("files", nargs="+")
    p.add_argument("--out", help="output file (default: scratch/<name>.brief.md)")
    p = add("lint", cmd_lint, "check a profile (and job)")
    p.add_argument("profile")
    p.add_argument("job", nargs="?")
    p = add("try", cmd_try, "run S0-S3 in a scratch folder (never usable for approval)")
    p.add_argument("profile")
    p.add_argument("job", nargs="?")
    p.add_argument("--out")
    p.add_argument("--source", help="the raw input file (overrides the path in the job)")
    p = add("run", cmd_run, "run the corridor S0-S5 and stop at Gate B")
    p.add_argument("profile")
    p.add_argument("job", nargs="?")
    p.add_argument("--corrections")
    p.add_argument("--source", help="the raw input file (overrides the path in the job)")
    p.add_argument("--runs-dir", default=str(INGEST / "runs"))
    p = add("status", cmd_status, "summarise a run folder")
    p.add_argument("run_dir")
    p = add("approve-check", cmd_approve_check, "validate approval.json for a run")
    p.add_argument("run_dir")
    p = add("oracle", cmd_oracle, "compare a run's pack with an older pack")
    p.add_argument("run_dir")
    p.add_argument("old_pack")
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except StageFail as e:
        emit(args, {"status": "FAIL", **e.as_dict()}, fail_text(e))
        return EXIT_FAIL
    except UsageError as e:
        emit(args, {"status": "USAGE", "message": str(e)}, f"usage error: {e}")
        return EXIT_USAGE
    except Exception:  # noqa: BLE001 - an internal error must never look like a pass (R10)
        traceback.print_exc()
        return EXIT_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
