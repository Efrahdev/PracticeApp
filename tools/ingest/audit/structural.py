import json, zipfile, glob, re, sys, io
from PIL import Image
bad = []
tot = 0
for z in sorted(glob.glob("ingest-out/*/*.zip")):
    zf = zipfile.ZipFile(z); names = set(zf.namelist())
    p = json.loads(zf.read("pack.json"))
    pid = p["pack"]["id"]; qs = p["questions"]; A = p.get("assets", {})
    nums = [q["number"] for q in qs]
    if len(set(nums)) != len(nums): bad.append((pid, "duplicate numbers"))
    ints = [int(re.match(r"\d+", n).group()) for n in nums]
    if ints != list(range(1, len(ints) + 1)): bad.append((pid, f"numbers not 1..{len(ints)}"))
    for q in qs:
        tot += 1
        t = q["type"]; tag = f"{pid} Q{q['number']}"
        if not q.get("stem", "").strip(): bad.append((tag, "empty stem"))
        for ref in re.findall(r"asset:([^)\s]+)", json.dumps(q)):
            a = A.get(ref)
            if not a: bad.append((tag, f"missing asset {ref}")); continue
            if "file" in a:
                if a["file"] not in names: bad.append((tag, f"asset file not in zip {a['file']}")); continue
                im = Image.open(io.BytesIO(zf.read(a["file"])))
                if im.width < 20 or im.height < 12: bad.append((tag, f"tiny image {im.size}"))
                ex = im.convert("L").getextrema()
                if ex[0] > 245: bad.append((tag, f"blank image {ref}"))
        if t.startswith("mcq"):
            labs = [o["label"] for o in q.get("options", [])]
            if len(labs) < 2: bad.append((tag, f"mcq with {len(labs)} options"))
            ans = q.get("answer")
            al = ans if isinstance(ans, list) else [ans]
            if ans is None: bad.append((tag, "mcq without answer"))
            elif any(a not in labs for a in al): bad.append((tag, f"answer {ans} not in options {labs}"))
            for o in q.get("options", []):
                if not str(o.get("text", "")).strip(): bad.append((tag, f"empty option {o['label']}"))
        elif t in ("numeric", "short_answer") and not q.get("answer"):
            bad.append((tag, f"{t} without answer"))
    print(f"{pid:42s} q={len(qs):3d} types={dict(__import__('collections').Counter(q['type'] for q in qs))}")
print("TOTAL questions", tot)
print("PROBLEMS", len(bad))
for b in bad: print("  ", b)
