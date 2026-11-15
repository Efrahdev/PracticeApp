import pymupdf, re, json, sys, zipfile, glob
def lines_colwise(page, split=300):
    L=[]
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines",[]):
            t="".join(s["text"] for s in l["spans"]).strip()
            if t: L.append((0 if l["bbox"][0]<split else 1, l["bbox"][1], l["bbox"][0], t))
    return [x[3] for x in sorted(L)]
def zone_lines(page, prx, split=300):
    L=[]
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines",[]):
            t="".join(s["text"] for s in l["spans"]).strip()
            if t: L.append((l["bbox"][0], l["bbox"][1], t))
    cuts=sorted(y for x,y,t in L if prx.search(t))
    def zone(y): return sum(1 for c in cuts if y >= c - 3)
    return [t for x,y,t in sorted(L, key=lambda r: (zone(r[1]), 0 if prx.search(r[2]) else 1, 0 if r[0]<split else 1, r[1], r[0]))]
def keys(pdf, prof):
    d=pymupdf.open(pdf); s=prof["solutions"]; prx=re.compile(s["paper_regex"])
    papers=[]; cur=None
    for pn in range(s["pages"][0], s["pages"][1]+1):
        for t in zone_lines(d[pn-1], prx):
            if prx.search(t):
                cur={}; papers.append(cur); continue
            m=re.match(r"^(\d{1,2})\s*\.\s*\(([A-D])\)", t)
            if m and cur is not None:
                n=int(m.group(1))
                if n not in cur: cur[n]=m.group(2)
    return papers
def pack_answers(pid):
    z=zipfile.ZipFile(glob.glob(f"ingest-out/*/{pid}.zip")[0]); p=json.loads(z.read("pack.json"))
    return {int(q["number"]):q.get("answer") for q in p["questions"]}
for pdf, pf in (("class_4_imo_5_years_e_book_2026.pdf","sof-imo-class4-5yr"),("class_4_ieo_5_year_e_book_2026.pdf","sof-ieo-class4-5yr")):
    prof=json.load(open(f"tools/ingest/profiles/{pf}.json")); ks=keys(pdf,prof)
    print("==",pf,"paper headers found in solutions:",len(ks),"papers in profile:",len(prof["papers"]))
    for p in prof["papers"]:
        k=ks[int(p["sol_key"][1:])-1]; a=pack_answers(p["id"])
        miss=[n for n in range(1,36) if n not in k]
        diff=[(n,a.get(n),k.get(n)) for n in range(1,36) if n in k and a.get(n)!=k[n]]
        print(f"  {p['id']:34s} key-found={len(k):2d} missing-in-raw={miss} MISMATCH={diff}")
