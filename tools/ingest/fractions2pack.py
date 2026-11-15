#!/usr/bin/env python3
"""Deterministic converter for the "Fractions 2" problem-set layout (no AI).

Same engine as htmlpack.py, different layout: questions are `div.q` with `div.qn`,
there are no worked solutions, and the answers are a final-answer key
(`section#answers li` = `<b>Q12</b> answer`).

  python3 -I tools/ingest/fractions2pack.py <problem-set.html> <outdir>
"""
import os, re, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import htmlpack as H

H.LAYOUT.update({
    "pack_id": "olympiad-fractions-master-set-2",
    "question": "div.q", "number": "div.qn", "fraction": "span.fr",
    "figure": "div.fig", "caption": "div.cap",
})
NUMERIC = re.compile(r"^\d+(?:\.\d+)?(?:\s+\d+/\d+|/\d+)?$")


def convert(src, filename):
    root = H.parse_html(src)
    t = H.select_one(root, "title")
    title = H.plain(t) if t else os.path.splitext(filename)[0]
    title += " (set 2)" if "2" not in title else ""
    key_root = H.select_one(root, "section#answers")
    answers, dup = {}, []
    for li in H.select(key_root, "li"):
        b = H.select_one(li, "b")
        n = re.search(r"\d+", H.plain(b)).group(0)
        a = H.plain(li).replace(H.plain(b), "", 1).strip()
        if n in answers:
            dup.append(n)
        answers[n] = a
    questions, assets, nums = [], {}, []
    for qn in H.select(root, "div.q"):
        n = H.qnum(qn); nums.append(n)
        ctx = H.Ctx(f"q{n}")
        stem = H.block(qn, ctx)
        assets.update(ctx.assets)
        cat = H.closest(qn, "section.cat")
        q = {"id": f"q{n}", "number": n, "stem": stem}
        a = answers.get(n)
        if a:
            q["type"] = "numeric" if NUMERIC.match(a) else "short_answer"
            q["answer"] = a
        else:
            q["type"] = "open"
        d = next((H.BAND_DIFFICULTY[c] for c in qn.classes if c in H.BAND_DIFFICULTY), None)
        if d:
            q["difficulty"] = d
        if cat is not None:
            h = H.select_one(cat, "h2")
            if h is not None:
                q["topics"] = [H.CATEGORY_TOPIC.format(title=H.plain(h))]
            sk = H.select_one(cat, "p.skill")
            if sk is not None:
                q["fields"] = {H.SKILL_FIELD: H.plain(sk, "b")}
        q["source"] = {"file": filename, "question": f"Q{n}"}
        questions.append(q)
    problems = []
    if not questions: problems.append("no questions found")
    if dup: problems.append(f"duplicate answers: {dup}")
    miss = [n for n in nums if n not in answers]; orph = [n for n in answers if n not in nums]
    if miss: problems.append(f"questions without an answer: {miss}")
    if orph: problems.append(f"answers without a question: {orph}")
    if len(set(nums)) != len(nums): problems.append("duplicate question numbers")
    nfig = len(H.select(root, "div.fig"))
    if nfig != len(assets): problems.append(f"figures in source {nfig} != assets {len(assets)}")
    pack = {"format": "practice-app/question-pack@1",
            "pack": {"id": H.LAYOUT["pack_id"], "title": title, "source": filename,
                     "subject": H.LAYOUT["subject"], "fields": {"Collection": title}},
            "assets": assets, "questions": questions}
    return pack, problems


def main(argv):
    if len(argv) != 3:
        print(__doc__); return 2
    with open(argv[1], encoding="utf-8", newline="") as f:
        pack, problems = convert(f.read(), os.path.basename(argv[1]))
    for w in H.warnings: print("warning:", w, file=sys.stderr)
    print(f"questions: {len(pack['questions'])}  figures: {len(pack['assets'])}")
    if problems:
        for p in problems: print("ERROR:", p, file=sys.stderr)
        print("count check FAILED - nothing written", file=sys.stderr); return 1
    print("count check OK: every question pairs with exactly one answer")
    print("wrote", H.write_outputs(pack, argv[2])[1]); return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
