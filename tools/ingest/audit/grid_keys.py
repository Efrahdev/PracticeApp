import pymupdf, re, json, zipfile, glob
def pack(pid):
    p=json.loads(zipfile.ZipFile(glob.glob(f"ingest-out/*/{pid}.zip")[0]).read("pack.json"))
    return {int(q["number"]):q.get("answer") for q in p["questions"]}
def report(pid, key, n=None, label=""):
    a=pack(pid); n=n or len(a)
    miss=[i for i in range(1,n+1) if i not in key]
    diff=[(i,a.get(i),key[i]) for i in range(1,n+1) if i in key and a.get(i)!=key[i]]
    print(f"  {pid:32s} {label:12s} found={len(key):2d}/{n} missing={miss} MISMATCH={diff}")
# IMO level 2
d=pymupdf.open("IMO class 4 paper -- SOF -- MTG -- 437a9215af32d04f799410d53d826c43 -- Anna’s Archive.pdf")
t=" ".join(d[34].get_text().split())
blocks=re.split(r"(\d)\s*th\s*IMO",t)[1:]
print("== IMO level 2 (answer-key page 35)")
for (ed,body),pid in zip(zip(blocks[0::2],blocks[1::2]),["sof-imo-class4-level2-2011-12","sof-imo-class4-level2-2012-13","sof-imo-class4-level2-2013-14"]):
    k={int(a):b for a,b in re.findall(r"(\d{1,2})\.\s*\(([A-D])\)",body)}
    report(pid,k,label=f"{ed}th IMO")
# UIMO
u=pymupdf.open("UIMO_CLASS-4_Past-8-Papers_Reduced-Size-elbirm.pdf")
prof=json.load(open("tools/ingest/profiles/uimo-class4-8-papers.json"))
print("== UIMO")
for p in prof["papers"]:
    if p.get("key"):
        a,b=p["key"]["pages"]; t=" ".join(" ".join(u[i-1].get_text().split()) for i in range(a,b+1))
        code=p["fields"]["Paper code"]
        assert code in t, (code,"not on key page")
        kt=t[t.index("KEY EXPLANATION"):]
        k={}
        for x,y in re.findall(r"(?:^|\s)(\d{1,2})\.\s([A-D])(?=\s|$)",kt): k.setdefault(int(x),y)
        report(p["id"],k,label="key grid")
        # second source: explanations "N. (X)" across solution pages
        s1,s2=p["solutions"]["pages"]; st=" ".join(" ".join(u[i-1].get_text().split()) for i in range(s1,s2+1))
        e={}
        for x,y in re.findall(r"(?:^|\s)0?(\d{1,2})\s*[.:]\s*\(([A-D])\)",st): e.setdefault(int(x),y)
        report(p["id"],e,label="explanations")
    else:
        # inline "Sol" after each question: walk pages in reading order
        a,b=p["pages"]; cur=None; k={}; pend=False
        for i in range(a,b+1):
            L=[]
            for bl in u[i-1].get_text("dict")["blocks"]:
                for l in bl.get("lines",[]):
                    tt="".join(s["text"] for s in l["spans"]).strip()
                    if tt: L.append((round(l["bbox"][1]),l["bbox"][0],tt))
            for y,x,tt in sorted(L):
                m=re.match(r"^(\d{1,2})\.$",tt) or re.match(r"^(\d{1,2})\.\s",tt)
                if m and x<70: cur=int(m.group(1)); pend=False; continue
                if re.match(r"^Sol\s*[:.]",tt):
                    mm=re.search(r"\(([A-D])\)",tt)
                    if mm and cur: k.setdefault(cur,mm.group(1))
                    else: pend=True
                    continue
                if pend and cur:
                    mm=re.match(r"^\(([A-D])\)",tt)
                    if mm: k.setdefault(cur,mm.group(1)); pend=False
        report(p["id"],k,label="inline Sol")
