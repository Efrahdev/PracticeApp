# Independent check of the Geometry pack against the raw HTML (regex parser, not the ingester's code).
import re, json, html, glob, zipfile, collections
SRC = glob.glob("Geometry_Olympiad_Achiever_Lab_2_Q101-200.html")[0]
s = open(SRC, encoding="utf8").read()
def plain(x):
    x = re.sub(r"<svg.*?</svg>", " ", x, flags=re.S); x = re.sub(r"<br\s*/?>", " ", x)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", x)).replace("\xa0", " ")).strip()
def words(t):
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t); t = re.sub(r"</?su[bp]>", "", t); t = re.sub(r"\\(.)", r"\1", t)
    return re.findall(r"[\w²½¼¾.,×÷=+\-–−/()%:]+", t.replace("\xa0", " ").replace("*", " ").lower())
def norm(t): return re.sub(r"\s+", " ", "".join(words(t)))
pack = json.loads(zipfile.ZipFile(glob.glob("ingest-out/geometry/*.zip")[0]).read("pack.json"))
Q = {q["number"]: q for q in pack["questions"]}
sets = {}  # q -> set letter by DOM position
for m in re.finditer(r'<section class="set" id="set(\w)".*?</section>', s, re.S):
    for n in re.findall(r'<article class="q" id="q(\d+)"', m.group(0)): sets[n] = m.group(1)
blocks = {m.group(1): m.group(0) for m in re.finditer(r'<article class="q" id="q(\d+)".*?</article>', s, re.S)}
bad = []
if sorted(blocks, key=int) != [str(i) for i in range(101, 201)]: bad.append("source numbers are not 101..200")
if set(Q) != set(blocks): bad.append("pack/question sets differ")
lv = collections.Counter(); svgs = 0
for n, b in blocks.items():
    q = Q[n]
    stmt = re.search(r'<div class="stmt">(.*?)</div>', b, re.S).group(1)
    if norm(plain(stmt)) not in norm(re.sub(r"\(asset:[^)]*\)", "", q["stem"])) and norm(q["stem"]).replace("![", "") != norm(plain(stmt)):
        if norm(plain(stmt)) != norm(re.sub(r"!\[.*?\]\(asset:[^)]*\)", "", q["stem"])): bad.append(f"Q{n}: stem text differs")
    fin = plain(re.search(r'<p class="final">(.*?)</p>', b, re.S).group(1)).removeprefix("Final answer:").strip()
    ans = q["answer"]; ans_s = ans if isinstance(ans, str) else f'{ans["value"]} {ans["unit"]}'
    if re.sub(r"\s+", "", ans_s) != re.sub(r"\s+", "", fin): bad.append(f"Q{n}: answer {ans_s!r} != final {fin!r}")
    # solution: every sentence of the printed solution body present, in order
    body = re.search(r'<div class="solbody">(.*?)</div>\s*</details>', b, re.S).group(1)
    mine = re.sub(r"(?m)^(\d+\.|-)\s", "", q["solution"].replace("**", ""))   # drop only the list markers the pack adds
    if norm(plain(body)) != norm(mine): bad.append(f"Q{n}: solution text differs")
    # figure: same SVG geometry (the pack adds only a <style>)
    svg_src = re.search(r"<svg.*?</svg>", b, re.S).group(0); svg_pk = Q[n] and pack["assets"][f"q{n}-fig"]["data"]
    strip = lambda x: re.sub(r"<style>.*?</style>", "", x.replace(' xmlns="http://www.w3.org/2000/svg"', ""), flags=re.S)
    if strip(svg_src) != strip(svg_pk): bad.append(f"Q{n}: svg differs")
    svgs += 1
    lc, lt = re.search(r'class="lvl (lvl-\d)">(.*?)<', b).groups(); lv[(sets[n], lt)] += 1
    want = {"lvl-1": "Foundation", "lvl-2": "Challenge", "lvl-3": "Achiever"}[lc]
    if q["difficulty"] != want or q["fields"]["Printed level"] != lt: bad.append(f"Q{n}: level mapping")
    if q["fields"]["Set"][0] != sets[n]: bad.append(f"Q{n}: set")
    nparts = len(re.findall(r'class="aline"', b))
    if q["fields"]["Answer parts"] != str(nparts): bad.append(f"Q{n}: answer parts")
    for u in re.findall(r"asset:([^)]+)", q["stem"]): assert u in pack["assets"]
for st in "FGHIJ":
    c = {k[1]: v for k, v in lv.items() if k[0] == st}
    if c != {"Achiever": 4, "Advanced Achiever": 6, "Challenge": 10}: bad.append(f"set {st} level mix {c} (book says 4+6+10)")
print("questions", len(Q), "figures checked", svgs, "| problems", len(bad)); [print("  ", x) for x in bad[:20]]
