import json, zipfile, glob, re, pymupdf, collections
SRC={"sof-imo":"class_4_imo_5_years_e_book_2026.pdf","sof-ieo":"class_4_ieo_5_year_e_book_2026.pdf","sof-imo-class4-level2":"IMO class 4 paper -- SOF -- MTG -- 437a9215af32d04f799410d53d826c43 -- Anna’s Archive.pdf","uimo":"UIMO_CLASS-4_Past-8-Papers_Reduced-Size-elbirm.pdf"}
docs={k:pymupdf.open(v) for k,v in SRC.items()}
def doc(pid):
    for k in ("sof-imo-class4-level2","sof-imo","sof-ieo","uimo"):
        if pid.startswith(k): return docs[k]
def W(s): return re.findall(r"[a-z0-9]+",s.lower())
labels=collections.Counter(); odd_end=[]; alt_bad=[]; pics=0
for z in sorted(glob.glob("ingest-out/*/*.zip")):
    p=json.loads(zipfile.ZipFile(z).read("pack.json")); pid=p["pack"]["id"]
    if not re.match(r"sof-|uimo-",pid): continue
    d=doc(pid)
    for q in p["questions"]:
        labels["".join(o["label"] for o in q["options"])]+=1
        st=q["stem"].strip()
        last=re.sub(r"!\[[^\]]*\]\([^)]*\)","",st).strip()
        if last and not re.search(r"[?.:!)\]’'\"”_}*]$|\\_$|\d$|[A-Za-z]$",last): odd_end.append((pid,q["number"],last[-40:]))
        for alt in re.findall(r"!\[([^\]]*)\]\(asset:[^)]*-full\)",st):
            pics+=1; pn=q["source"]["page"]
            win=set(W(" ".join(d[i].get_text() for i in range(max(0,pn-2),min(len(d),pn+1)))))
            miss=[w for w in W(alt) if w not in win]
            if len(miss)>2: alt_bad.append((pid,q["number"],miss[:6]))
print("option label patterns:",dict(labels))
print("whole-question pictures:",pics,"| alt text not from its page:",alt_bad)
print("stems with unusual last character:",len(odd_end))
for x in odd_end[:40]: print("  ",x)
