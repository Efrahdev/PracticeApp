import pymupdf, re, json, zipfile, glob, collections
SRC={"sof-imo-class4-5yr":"class_4_imo_5_years_e_book_2026.pdf","sof-ieo-class4-5yr":"class_4_ieo_5_year_e_book_2026.pdf",
     "sof-imo-class4-level2":"IMO class 4 paper -- SOF -- MTG -- 437a9215af32d04f799410d53d826c43 -- Anna’s Archive.pdf",
     "uimo-class4-8-papers":"UIMO_CLASS-4_Past-8-Papers_Reduced-Size-elbirm.pdf"}
def W(s): return re.findall(r"[a-z0-9]+", s.lower())
def plain(md):
    md=re.sub(r"</?su[bp]>","",md); md=re.sub(r"!\[[^\]]*\]\([^)]*\)"," ",md); md=re.sub(r"\\frac\{([^}]*)\}\{([^}]*)\}",r" \1 \2 ",md)
    md=re.sub(r"\\[a-zA-Z]+"," ",md); md=re.sub(r"\\(.)",r"\1",md); return md
tot=collections.Counter(); issues=[]
for pf,pdf in SRC.items():
    prof=json.load(open(f"tools/ingest/profiles/{pf}.json")); d=pymupdf.open(pdf)
    pagew={}
    def pw(pn):
        if pn not in pagew:
            pagew[pn]=collections.Counter(W((d[pn-2].get_text() if pn>1 else "")+" "+d[pn-1].get_text()+" "+(d[pn].get_text() if pn<len(d) else "")))  # question may run onto next page
        return pagew[pn]
    pagetext={}
    def pt(pn):
        if pn not in pagetext: pagetext[pn]=" ".join(W(d[pn-1].get_text()+" "+(d[pn].get_text() if pn<len(d) else "")))
        return pagetext[pn]
    for p in prof["papers"]:
        pk=json.loads(zipfile.ZipFile(glob.glob(f"ingest-out/*/{p['id']}.zip")[0]).read("pack.json"))
        a,b=p["pages"]
        for q in pk["questions"]:
            pn=q["source"]["page"]; tag=f"{p['id']} Q{q['number']}"
            if not (a<=pn<=b): issues.append((tag,f"source page {pn} outside paper pages {a}-{b}"))
            st=W(plain(q["stem"])); c=pw(pn)
            miss=[w for w in st if c[w]==0]
            tot["stems"]+=1
            if st: tot["text_stems"]+=1
            if miss: issues.append((tag,f"stem words not on page {pn}: {miss[:6]}"))
            for o in q.get("options",[]):
                ow=W(plain(o["text"]))
                if not ow or o["text"]==f"Option {o['label']}": continue
                tot["text_options"]+=1
                m=[w for w in ow if c[w]==0]
                if m: issues.append((tag,f"option {o['label']} words not on page: {m[:5]}"))
                # label adjacency: "<label> <first words of option>" must appear in page text
                seq=" ".join([o["label"].lower()]+ow[:3])
                if seq not in pt(pn): tot["label_not_adjacent"]+=1; issues.append((tag,f"label-text adjacency not found: '{seq}'"))
print(dict(tot)); print("issues",len(issues))
for i in issues[:60]: print("  ",i)
