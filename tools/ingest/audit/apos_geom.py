import sys, json, re, pymupdf
sys.path.insert(0,"tools/ingest"); import workbookpack as W
prof=json.load(open("tools/ingest/profiles/apos-grade4.json")); doc=pymupdf.open("APOS Grade4.pdf")
orig=pymupdf.Page.get_pixmap
NUM=re.compile(r"^(\d{1,3})\.(?:\s|$|★)")
for ch in prof["chapters"]:
    calls=[]
    def gp(self,*a,clip=None,**k):
        calls.append((self.number+1,clip)); return orig(self,matrix=pymupdf.Matrix(0.05,0.05),clip=pymupdf.Rect(0,0,20,20),alpha=False)
    pymupdf.Page.get_pixmap=gp
    qs,_=W.build_chapter(doc,prof,ch,[])
    pymupdf.Page.get_pixmap=orig
    bad=[]; per={}
    for (pn,c),q in zip(calls,qs):
        n=q["number"]
        L=[("".join(s["text"] for s in l["spans"]).strip(),pymupdf.Rect(l["bbox"])) for b in doc[pn-1].get_text("dict")["blocks"] for l in b.get("lines",[])]
        inside=[(t,r) for t,r in L if c.contains(r)]
        lab=[NUM.match(t).group(1) for t,r in inside if NUM.match(t) and r.x0 < prof["answer_label_x"]]
        if not lab or lab[0]!=n: bad.append((n,pn,"own number not first",lab[:3]))
        if [x for x in lab if x!=n]: bad.append((n,pn,"other numbers inside",[x for x in lab if x!=n]))
        if c.x0>=prof["answer_label_x"] and any(NUM.match(t) and NUM.match(t).group(1)==n and r.x0<prof["answer_label_x"] for t,r in L): bad.append((n,pn,"crop is the margin label"))
        if len(" ".join(t for t,r in inside))<3: bad.append((n,pn,"empty crop"))
        per.setdefault(pn,[]).append((n,c))
    ov=[(pn,a[0],b[0]) for pn,l in per.items() for i,a in enumerate(l) for b in l[i+1:] if (a[1]&b[1]).width>2 and (a[1]&b[1]).height>2 and not (a[1]&b[1]).is_empty]
    print(ch["id"],"q",len(qs),"seq ok",[int(q["number"]) for q in qs]==list(range(1,len(qs)+1)),"| problems",len(bad),bad[:8],"| overlaps",ov[:8])
