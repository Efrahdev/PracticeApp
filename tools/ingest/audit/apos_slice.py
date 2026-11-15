import sys, json, pymupdf
sys.path.insert(0,"tools/ingest"); import workbookpack as W
prof=json.load(open("tools/ingest/profiles/apos-grade4.json")); doc=pymupdf.open("APOS Grade4.pdf"); orig=pymupdf.Page.get_pixmap
for ch in prof["chapters"]:
    calls=[]
    def gp(self,*a,clip=None,**k):
        calls.append((self.number+1,clip)); return orig(self,matrix=pymupdf.Matrix(0.05,0.05),clip=pymupdf.Rect(0,0,20,20),alpha=False)
    pymupdf.Page.get_pixmap=gp; qs,_=W.build_chapter(doc,prof,ch,[]); pymupdf.Page.get_pixmap=orig
    cut=[]
    for (pn,c),q in zip(calls,qs):
        pg=doc[pn-1]
        objs=[("T",pymupdf.Rect(l["bbox"]),"".join(s["text"] for s in l["spans"])[:24]) for b in pg.get_text("dict")["blocks"] for l in b.get("lines",[])]
        objs+=[("G",g["rect"],"") for g in pg.get_drawings() if g["rect"].width<0.8*pg.rect.width and g["rect"].height<0.5*pg.rect.height]
        for k,r,t in objs:
            i=r & c
            if i.is_empty or i.width<1 or i.height<1 or c.contains(r): continue
            frac=(i.width*i.height)/max(1,r.width*r.height)
            if 0.05<frac<0.95 and r.width*r.height>30: cut.append((q["number"],pn,k,t,round(frac,2),[round(v) for v in r],[round(v) for v in c]))
    print(ch["id"],"objects sliced by a crop edge:",len(cut)); [print("   ",x) for x in cut[:30]]
