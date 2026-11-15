#!/usr/bin/env python3
"""Deterministic converter: "Prepositions Diagnostic Assessment" PDF -> question pack (no AI).

Layout: "Assessment Questions" (numbered `N.  stem`, preceded by a task-type line,
options `(a)  text`, then `Answer:`) followed by "Answer Key and Reasoning"
(`QN.  (Task type)` + labelled fields). Words come from the PDF text layer.

  python3 -I tools/ingest/prepositionpack.py <paper.pdf> <outdir>
"""
import os, re, sys, json, zipfile
import pymupdf as fitz

RE_PAGE = re.compile(r"^Page \d+$")
RE_SEC = re.compile(r"^Section ([A-Z]) - (.+)$")
RE_Q = re.compile(r"^(\d+)\.\s{2,}(.*)$")
RE_OPT = re.compile(r"^\(([a-d])\)\s{2,}(.*)$")
RE_KEY = re.compile(r"^Q(\d+)\.\s{2,}\((.*)\)\s*$")
RE_FIELD = re.compile(r"^(Answer|Explanation|Why the other options are wrong / common errors|Grammar principle|Memory tip):\s*(.*)$")
RE_DIFF = re.compile(r"^Difficulty:\s*(\d+)\s*/\s*10\s*\|\s*Cognitive skill:\s*(.*)$")
SPECIAL = re.compile(r"([\\`*_\[\]<>$])")
flags = []


def esc(t):
    return SPECIAL.sub(r"\\\1", t)


def lines_of(doc, a, b):
    out = []
    for i in range(a, b):
        for l in doc[i].get_text().split("\n"):
            l = l.rstrip()
            if l and not RE_PAGE.match(l):
                out.append((i + 1, l))
    return out


def parse(doc):
    ki = next(i for i, p in enumerate(doc) if p.get_text().lstrip().split("\n")[1:2] == ["Answer Key and Reasoning"])
    qi = next(i for i, p in enumerate(doc) if p.get_text().split("\n")[1:2] == ["Assessment Questions"])
    # ---------- questions
    Q = lines_of(doc, qi, ki)
    qs, sec, cur, pend = {}, None, None, None
    for k, (pg, l) in enumerate(Q):
        if l == "Assessment Questions":
            continue
        m = RE_SEC.match(l)
        if m:
            sec, cur = (m.group(1), m.group(2)), None
            continue
        m = RE_Q.match(l)
        if m:
            cur = {"n": m.group(1), "page": pg, "sec": sec, "stem": [m.group(2)], "opts": [], "ans": False}
            qs[cur["n"]] = cur
            continue
        # a task-type line is directly followed by a numbered line
        nxt = Q[k + 1][1] if k + 1 < len(Q) else ""
        if RE_Q.match(nxt) and not l.startswith("("):
            continue
        if cur is None:
            continue
        m = RE_OPT.match(l)
        if m:
            cur["opts"].append([m.group(1), m.group(2)])
        elif l == "Answer:":
            cur["ans"] = True
        elif cur["opts"] and not cur["ans"]:
            cur["opts"][-1][1] += " " + l.strip()
        else:
            cur["stem"].append(l.strip())
    # ---------- key
    K = lines_of(doc, ki, len(doc))
    ks, cur, field = {}, None, None
    for pg, l in K:
        if l == "Answer Key and Reasoning" or RE_SEC.match(l):
            continue
        m = RE_KEY.match(l)
        if m:
            cur = {"n": m.group(1), "page": pg, "type": m.group(2), "f": {}, "diff": None, "skill": ""}
            ks[cur["n"]] = cur; field = None
            continue
        if cur is None:
            continue
        m = RE_DIFF.match(l)
        if m:
            cur["diff"], cur["skill"] = int(m.group(1)), m.group(2).strip(); field = None
            continue
        m = RE_FIELD.match(l)
        if m:
            field = m.group(1); cur["f"][field] = m.group(2).strip()
        elif field:
            cur["f"][field] += " " + l.strip()
    return qs, ks


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[‘’']", "'", s)).strip().rstrip(".").lower()


def build(doc, filename):
    qs, ks = parse(doc)
    problems, questions = [], []
    nums = sorted(qs, key=int)
    if nums != [str(i) for i in range(1, 201)]:
        problems.append(f"question numbers not 1..200 (found {len(nums)})")
    if set(qs) != set(ks):
        problems.append(f"questions without key {sorted(set(qs)-set(ks), key=int)}; keys without question {sorted(set(ks)-set(qs), key=int)}")
    for n in nums:
        q, k = qs[n], ks.get(n)
        if not k:
            continue
        stem = " ".join(q["stem"]).strip()
        opts = q["opts"]
        ttype = k["type"]
        out = {"id": f"q{n}", "number": n}
        ans = k["f"].get("Answer", "")
        if ttype.startswith("Choose ALL") and len(opts) == 4:
            # options are bare "(a)" copies; the real texts are inside the stem
            parts = re.split(r"\s\(([a-d])\)\s", " " + stem)
            if [parts[i] for i in range(1, len(parts), 2)] == list("abcd"):
                stem = parts[0].strip()
                opts = [[parts[i], parts[i + 1].strip()] for i in range(1, len(parts), 2)]
            else:
                flags.append((n, "Choose-ALL options could not be separated from stem"))
        if opts:
            labels = [o[0].upper() for o in opts]
            out["options"] = [{"label": o[0].upper(), "text": esc(o[1])} for o in opts]
            if ttype.startswith("Choose ALL"):
                letters = sorted(set(re.findall(r"\(([a-d])\)", ans.split(";")[0] if ";" in ans else ans)))
                if letters:
                    out["type"], out["answer"] = "mcq_multi", [x.upper() for x in letters]
                    if ";" not in ans:
                        flags.append((n, f"Choose-ALL answer wording unusual, letters read as {letters}: {ans[:90]}"))
                else:
                    out["type"], out["answer"] = "mcq_multi", None
                    flags.append((n, f"Choose-ALL answer letters unreadable: {ans[:90]}"))
            else:
                hit = [lab for lab, o in zip(labels, opts) if norm(o[1]) == norm(ans)]
                if len(hit) == 1:
                    out["type"], out["answer"] = "mcq_single", hit[0]
                else:
                    out["type"], out["answer"] = "mcq_single", None
                    flags.append((n, f"MCQ key text did not match exactly one option: {ans[:90]}"))
        else:
            out["type"] = "open"
            if q["ans"]:
                flags.append((n, "has 'Answer:' line but no options"))
        if out.get("answer") is None:
            out.pop("answer", None)
            if out["type"] != "open":
                out["type"] = "open"
                out["fields"] = {}
            out["_note"] = ans
        elif out["type"] == "open":
            pass
        out["stem"] = esc(stem)
        if out["type"] == "open":
            out["answer"] = ans
        sol = []
        for lab, name in (("Explanation", "Explanation"), ("Why the other options are wrong / common errors", "Why the other options are wrong"),
                          ("Grammar principle", "Principle"), ("Memory tip", "Memory tip")):
            if k["f"].get(lab):
                sol.append(f"**{name}:** {esc(k['f'][lab])}")
        if "_note" in out:
            note = out.pop("_note")
            sol.insert(0, f"**Answer:** {esc(note)}")
        if sol:
            out["solution"] = "\n\n".join(sol)
        if q["sec"]:
            out["topics"] = [f"Grammar > Prepositions > {q['sec'][1]}"]
        f = {"Task type": ttype}
        if q["sec"]:
            f["Section"] = q["sec"][0]
        if k["diff"] is not None:
            f["Difficulty rating"] = k["diff"]
        if k["skill"]:
            f["Cognitive skill"] = k["skill"]
        out["fields"] = f
        out["source"] = {"file": filename, "page": q["page"], "key_page": k["page"]}
        if "answer" in out and out["answer"] == "":
            out.pop("answer"); flags.append((n, "empty answer"))
        questions.append(out)
    title = "Prepositions Diagnostic Assessment"
    return {"format": "practice-app/question-pack@1",
            "pack": {"id": "prepositions-diagnostic-assessment", "title": title, "source": filename,
                     "subject": "English", "fields": {"Collection": title}},
            "assets": {}, "questions": questions}, problems


def main(argv):
    if len(argv) != 3:
        print(__doc__); return 2
    doc = fitz.open(argv[1])
    pack, problems = build(doc, os.path.basename(argv[1]))
    import collections
    print("questions:", len(pack["questions"]), dict(collections.Counter(q["type"] for q in pack["questions"])))
    for n, w in flags:
        print(f"FLAG Q{n}: {w}")
    if problems:
        for p in problems: print("ERROR:", p, file=sys.stderr)
        return 1
    d = os.path.join(argv[2], pack["pack"]["id"]); os.makedirs(d, exist_ok=True)
    data = json.dumps(pack, ensure_ascii=False, indent=2) + "\n"
    open(os.path.join(d, "pack.json"), "w", encoding="utf-8", newline="\n").write(data)
    zp = d + ".zip"
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
        zi = zipfile.ZipInfo("pack.json", date_time=(1980, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16; z.writestr(zi, data.encode("utf-8"))
    print("wrote", zp); return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
