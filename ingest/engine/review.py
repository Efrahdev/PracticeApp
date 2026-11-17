"""Stage S5: the review packet for Gate B (spec section 9.1).

The packet states what the machine checked and, just as plainly, what it did not. The sample is risk-ranked
and reproducible (seeded by the pack identity). Planted errors ("canaries") test the reviewer's attention;
which items are canaries is sealed outside review/ so an AI reviewer never sees it.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from pathlib import Path

from util import ENGINE_VERSION, atomic_write, read_json, sha256_obj, write_json


def _rng(seed: str):
    """Deterministic stream of floats in [0,1) from a seed string (no global random state)."""
    counter = 0
    while True:
        h = hashlib.sha256(f"{seed}:{counter}".encode()).digest()
        counter += 1
        yield int.from_bytes(h[:8], "big") / 2 ** 64


def sample_size(n: int, defect_rate: float = 0.05, confidence: float = 0.95) -> int:
    """Smallest sample that, if it shows no defect, makes us `confidence` sure that fewer than
    `defect_rate` of the pack is defective (hypergeometric: sampling without replacement)."""
    bad = max(1, math.ceil(n * defect_rate))
    for k in range(1, n + 1):
        p_clean = math.comb(n - bad, k) / math.comb(n, k) if k <= n - bad else 0.0
        if p_clean <= 1 - confidence:
            return k
    return n


def choose_sample(pack: dict, decisions: dict, verdicts: dict, coverage: dict, seed: str) -> tuple[list[dict], int]:
    qs = pack["questions"]
    reasons: dict[str, list[str]] = {}

    def add(qid, why):
        reasons.setdefault(qid, [])
        if why not in reasons[qid]:
            reasons[qid].append(why)
    add(qs[0]["id"], "first question")
    add(qs[-1]["id"], "last question")
    for g in verdicts.values():
        for c in g["checks"]:
            if c["status"] in ("WARN", "FAIL") and isinstance(c.get("details"), list):
                for d in c["details"]:
                    qid = str(d).split(":")[0].split(" ")[0]
                    if any(q["id"] == qid for q in qs):
                        add(qid, f"flagged by {c['id']}")
    for c in decisions.get("corrections", []):
        add(c["question_id"].split("/")[-1], "corrected by hand")
    shapes: dict[str, list[str]] = {}
    for q in qs:
        if "(asset:" in json.dumps(q):
            add(q["id"], "has a figure")
        if q.get("parts"):
            add(q["id"], "multi-part")
        shape = "|".join([q["type"], str(len(q.get("parts") or [])), str(len(q.get("options") or [])), "fig" if "(asset:" in json.dumps(q) else "",
                          "table" if "| ---" in json.dumps(q) else "", "math" if "$" in json.dumps(q) else ""])
        shapes.setdefault(shape, []).append(q["id"])
    for shape, ids in shapes.items():
        if len(ids) <= 3:
            for qid in ids:
                add(qid, "rare shape")
    for row in decisions.get("classified", []):
        add(row["question"], "numeric key (auto-marked)")
    need = sample_size(len(qs))
    rng = _rng(seed)
    pool = sorted((q["id"] for q in qs if q["id"] not in reasons), key=lambda _: next(rng))
    forced = [qid for qid in reasons if any(w not in ("has a figure", "multi-part", "numeric key (auto-marked)") for w in reasons[qid])]
    # common risk classes (figure, multi-part, numeric key) can cover most of a pack: take all forced items, then a
    # seeded share of each class, then random fill, until the statistical sample size is met
    chosen = list(dict.fromkeys(forced))
    by_class: dict[str, list[str]] = {}
    for qid, why in reasons.items():
        if qid not in chosen:
            by_class.setdefault(why[0], []).append(qid)
    for why in sorted(by_class):
        ids = sorted(by_class[why], key=lambda _: next(rng))
        chosen += ids[:max(5, math.ceil(len(ids) * 0.4))]
    for qid in pool:
        if len(chosen) >= need:
            break
        chosen.append(qid)
        reasons[qid] = ["random fill"]
    order = {q["id"]: i for i, q in enumerate(qs)}
    chosen.sort(key=lambda qid: (0 if qid in forced else 1, order[qid]))
    by_id = {q["id"]: q for q in qs}
    return [{"question_id": qid, "why": reasons[qid], "question": by_id[qid]} for qid in chosen], need


# ---- attention canaries: deliberately corrupted copies of real questions (spec 9.1, 12.5)
def _mutate(q: dict, kind: str, other: dict) -> dict | None:
    m = copy.deepcopy(q)
    target = m if m.get("stem") else (m.get("parts") or [{}])[0]
    if kind == "digit":
        stem = target.get("stem", "")
        hit = re.search(r"(?<![\\$\w(:])\d(?![\w-]*\))", stem)
        if not hit:
            return None
        target["stem"] = stem[:hit.start()] + str((int(hit.group()) + 3) % 10) + stem[hit.end():]
        return m
    if kind == "swap_answer":
        mine, theirs = m.get("solution"), other.get("solution")
        if not isinstance(mine, dict) or not isinstance(theirs, dict) or not theirs.get("answer") or mine.get("answer") == theirs.get("answer"):
            return None
        mine["answer"] = theirs["answer"]
        if isinstance(m.get("answer"), str) and isinstance(other.get("answer"), str):
            m["answer"] = other["answer"]
        return m
    if kind == "drop_line":
        sol = m.get("solution")
        if not isinstance(sol, dict) or not sol.get("explanation"):
            return None
        paras = sol["explanation"].split("\n\n")
        if len(paras) < 4:
            return None
        del paras[len(paras) // 2]
        sol["explanation"] = "\n\n".join(paras)
        return m
    if kind == "drop_figure":
        stem = target.get("stem", "")
        new = re.sub(r"\n*!\[[^\]]*\]\(asset:[^)]+\)", "", stem, count=1)
        if new == stem:
            return None
        target["stem"] = new
        return m
    if kind == "word":
        stem = target.get("stem", "")
        words = [w for w in re.finditer(r"(?<![\\\w])[a-z]{5,}(?!\w)", stem)]
        if len(words) < 2:
            return None
        a, b = words[0], words[-1]
        if a.group() == b.group():
            return None
        target["stem"] = stem[:a.start()] + b.group() + stem[a.end():b.start()] + a.group() + stem[b.end():]
        return m
    return None


def make_canaries(pack: dict, sample_ids: set[str], seed: str, count: int) -> list[dict]:
    qs = pack["questions"]
    rng = _rng(seed + ":canary")
    outside = [q for q in qs if q["id"] not in sample_ids] or qs
    order = sorted(outside, key=lambda _: next(rng))
    kinds = ["digit", "swap_answer", "drop_line", "drop_figure", "word"]
    out, used = [], set()
    for i in range(count * 6):
        if len(out) >= count:
            break
        kind = kinds[(i + len(out)) % len(kinds)]
        for q in order:
            if q["id"] in used:
                continue
            other = order[(order.index(q) + 1) % len(order)]
            mutated = _mutate(q, kind, other)
            if mutated is not None:
                used.add(q["id"])
                out.append({"question_id": q["id"], "why": ["random fill"], "question": mutated, "canary": kind})
                break
    return out


def _assurance(verdicts: dict, pack: dict, manifest: dict, decisions: dict, n_required: int, need: int) -> str:
    n = len(pack["questions"])
    lines = ["# Assurance statement", "",
             f"Run `{manifest['run_id']}` · engine {ENGINE_VERSION} · {n} questions, {len(pack.get('assets', {}))} figures · pack identity `{manifest['pack']['identity_sha256']}`",
             "", "Generated automatically from the gate files. Read this before the questions.", "", "## What each check examined", "",
             "| Check | Result | Examined | What it found |", "| --- | --- | ---: | --- |"]
    not_run = []
    for g, v in verdicts.items():
        st = v.get("selftest") or {}
        if st.get("fixture") and st.get("fixture") != "none":
            lines.append(f"| {g.upper()} self-test | {st.get('status')} | 1 | proved able to fail on: {st['fixture']} |")
        for c in v["checks"]:
            if c["message"].startswith("NOT RUN"):
                not_run.append(c)
                continue
            lines.append(f"| `{c['id']}` | {c['status']} | {c['examined']} | {c['message'][:300].replace('|', '/')} |")
    lines += ["", "## What was NOT verified", "",
              "- **Whether the source itself is right.** A wrong answer copied perfectly passes every check here. Answers are only compared with the source, never solved.",
              "- **Whether a diagram is mathematically right.** Figures are checked for being the *same picture* as the source, not for being correct.",
              "- **Whether questions are well written or sensible.**"]
    for c in not_run:
        lines.append(f"- **`{c['id']}`** — {c['message'][9:]}")
    derived = decisions.get("derived_fields", {})
    if derived:
        lines.append("- **Derived values are not compared word for word**: " + ", ".join(f"`{k}` ({v})" for k, v in sorted(derived.items())) +
                     ". They are computed from the source (a pattern, a mapping, a lookup). The mappings are listed in decisions-made.md.")
    lines += ["", "## How much to review", "",
              f"To be 95% sure that fewer than 5% of {n} questions are defective after finding no defect, about **{need}** must be checked. "
              f"This packet asks for **{n_required}** ({round(100 * n_required / n)}% of the pack), highest risk first, plus planted errors mixed in.",
              "Some items in the packet were corrupted on purpose. You are not told which. Marking a corrupted item `ok` voids the approval.", ""]
    return "\n".join(lines)


def _decisions_md(decisions: dict, coverage: dict, job: dict) -> str:
    lines = ["# Decisions made by the profile and the engine", "", "Everything here changed, dropped or computed something. Each one is a place a wrong question could hide.", "",
             "## Ignored source text", "", "| Rule | Reason given in the profile | Blocks | Words | Limit |", "| ---: | --- | ---: | ---: | --- |"]
    by_rule: dict[int, list[str]] = {}
    for b in coverage["blocks"]:
        if b["status"] == "ignored":
            by_rule.setdefault(b["by"]["rule"], []).append(b["text"].strip())
    for r in coverage["ignore_rules"]:
        lines.append(f"| {r['index']} | {r['reason']} | {r['match_blocks']} | {r['match_tokens']} | {r['max_blocks']} / {r['max_tokens']} |")
    lines += ["", "### Digest of the ignored text, by rule", ""]
    for idx, texts in sorted(by_rule.items()):
        distinct: dict[str, int] = {}
        for t in texts:
            if t:
                distinct[t[:100]] = distinct.get(t[:100], 0) + 1
        top = sorted(distinct.items(), key=lambda kv: (-kv[1], kv[0]))[:15]
        lines.append(f"**Rule {idx}** — {len(texts)} blocks, {len(distinct)} distinct texts. Most frequent:")
        lines += [f"- ×{n} `{t}`" for t, n in top] + [""]
    lines += ["## Value mappings", ""]
    for name, hist in sorted(decisions.get("mappings", {}).items()):
        table = job.get("mappings", {}).get(name.split(".", 1)[1], {}) if name.startswith("mappings.") else {}
        lines.append(f"**{name}**: " + ", ".join(f"`{k}`" + (f" → `{table[k]}`" if k in table else "") + f" ×{v}" for k, v in sorted(hist.items())))
    lines += ["", "## Answers", "", f"- {len(decisions.get('classified', []))} final answers became numeric keys (auto-marked): the text was exactly number + unit and re-writing the number gives the same characters.",
              f"- {len(decisions.get('kept_open', []))} final answers did not fit that pattern and stay open answers (marked by you).", "",
              "## Text the engine wrote that is not in the source", "",
              f"- {decisions.get('added_literals', 0)} labels, separators or headings declared in the profile (for example generated (a) (b) labels, the dash in working lines, solution headings).",
              "", "## Formatting", ""]
    lines += [f"- {k}: {v} runs" for k, v in sorted(decisions.get("formats", {}).items())] or ["- no underline / strike / highlight in the source"]
    lines += ["", "## Figures", "", f"- {len(decisions.get('figure_styles', []))} notes. Each figure's page styles were copied into the file (see pack/assets.json for original and packaged hashes)."]
    lines += ["", "## Corrections applied (corrections overlay)", ""]
    lines += [f"- `{c['question_id']}` {c['field']}: {c['reason']} — {c['author']}, {c['date']}" for c in decisions.get("corrections", [])] or ["- none"]
    lines += ["", "## Custom code (hooks)", "", "- none (this engine version accepts no hooks)", ""]
    return "\n".join(lines)


BRIEF = """# Review brief (paste to an AI reviewer, or follow it yourself)

You are reviewing a question pack that a deterministic program made from a source document. You must be a
different person or AI session from the one that wrote the profile.

**What is already checked by machine** is in `assurance.md`. Do not repeat it. **What is not checked**: whether
the source's own answers are right, whether diagrams are mathematically right, and layout (line breaks, bold).

For each item in `index.html` (source on the left, what the app will show on the right):

1. Is every word, number, symbol and figure on the right the same as on the left, attached to the same question and part?
2. Is anything on the left missing on the right (other than page furniture listed in `decisions-made.md`)?
3. Does the layout carry the same meaning (line breaks in calculations, emphasised words, table shape)?

Some items were corrupted on purpose and you are not told which. Judge every item on its own.

Reply with exactly one line per item, in the order shown, as JSON:

```json
{"item": "r001", "verdict": "ok" | "defect" | "unsure", "note": "what is wrong, quoting the differing text"}
```

Rules: `defect` when left and right differ in meaning or content. `unsure` when you cannot tell (say why).
Never mark `ok` to be agreeable: an `ok` on a corrupted item voids the whole approval.
Source correctness is **unverified**: if you also solved a question and confirmed its answer, add `"answer_checked": true`.
"""


def build(run_dir: Path, profile: dict, job: dict, verdicts: dict, manifest: dict) -> None:
    import runner   # late import: runner imports this module
    pack = read_json(run_dir / "pack" / "pack.json")
    decisions = read_json(run_dir / "decisions.json")
    coverage = read_json(run_dir / "coverage.json")
    inputs = read_json(run_dir / "inputs" / "inputs.json")
    seed = manifest["pack"]["identity_sha256"]
    sample, need = choose_sample(pack, decisions, verdicts, coverage, seed)
    canaries = make_canaries(pack, {s["question_id"] for s in sample}, seed, max(3, round(len(sample) * 0.08)))
    rng = _rng(seed + ":mix")
    items = list(sample)
    for c in canaries:   # seeded positions among the sample
        items.insert(int(next(rng) * (len(items) + 1)), c)
    review = run_dir / "review"
    sealed, public = [], []
    for i, it in enumerate(items, start=1):
        key = f"r{i:03d}"
        content = sha256_obj(it["question"])
        public.append({"key": key, "question_id": it["question_id"], "why": it["why"] if "canary" not in it else ["random fill"], "question": it["question"], "content_sha256": content})
        sealed.append({"item": key, "question_id": it["question_id"], "content_sha256": content, "canary": it.get("canary")})
    write_json(review / "items.json", public)
    write_json(run_dir / "sealed" / "canaries.json", {"note": "Keep this file away from the reviewer. It says which review items were corrupted on purpose.",
                                                      "items": [s for s in sealed if s["canary"]]})
    atomic_write(review / "assurance.md", _assurance(verdicts, pack, manifest, decisions, len(sample), need).encode())
    summary = ["# Summary", "", f"- run: `{manifest['run_id']}`", f"- source: `{inputs['source']['name']}` sha256 `{inputs['source']['sha256']}`",
               f"- profile: `{profile['profile']['id']}` v{profile['profile']['version']} sha256 `{inputs['profile_sha256']}`",
               f"- questions: {len(pack['questions'])}; figures: {len(pack.get('assets', {}))}", "", "| Gate | Verdict | Checks | Self-test |", "| --- | --- | ---: | --- |"]
    for g, v in verdicts.items():
        summary.append(f"| {g.upper()} | **{v['status']}** | {len(v['checks'])} | {(v.get('selftest') or {}).get('status', '-')} |")
    warns = [(g, c) for g, v in verdicts.items() for c in v["checks"] if c["status"] == "WARN"]
    summary += ["", "## Warnings that need a waiver at Gate B", ""] + ([f"- `{c['id']}` — {c['message']}" for _, c in warns] or ["- none"]) + [""]
    atomic_write(review / "summary.md", "\n".join(summary).encode())
    atomic_write(review / "decisions-made.md", _decisions_md(decisions, coverage, job).encode())
    atomic_write(review / "review-brief.md", BRIEF.encode())
    template = {"decision": "<approve or reject>", "reviewer": "<name or reviewer session>", "profile_author": profile["profile"].get("author", "<who wrote the profile>"),
                "source_sha256": inputs["source"]["sha256"], "profile_sha256": inputs["profile_sha256"], "job_sha256": inputs["job_sha256"],
                "corrections_sha256": inputs["corrections_sha256"], "pack_identity_sha256": inputs["pack_identity_sha256"], "engine_version": ENGINE_VERSION,
                "reviewed_items": [{"item": p["key"], "question_id": p["question_id"], "content_sha256": p["content_sha256"], "verdict": "<ok | defect | unsure>"} for p in public],
                "answers_verified": "<none | sampled | full>",
                "waivers": [{"gate": g.upper(), "check_id": c["id"], "reason": "<why this is acceptable>"} for g, c in warns],
                "approved_at": "<timestamp>"}
    write_json(review / "approval.template.json", template)
    code, err = runner._node("sidebyside.mjs", str(run_dir), str(review / "items.json"), str(review / "index.html"), "review")
    if code != 0:
        atomic_write(review / "index.html", f"<p>The side-by-side page could not be built: {err[-500:]}</p>".encode())
