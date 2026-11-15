import json, zipfile, glob, re, collections
LEAK=re.compile(r"(?i)\bfor questions?\b|\bdirections?\b|read the passage|answer the questions|questions? \d+\s*(to|and|-)\s*\d+")
rows=[]
for z in sorted(glob.glob("ingest-out/*/*.zip")):
    p=json.loads(zipfile.ZipFile(z).read("pack.json")); pid=p["pack"]["id"]
    if not re.match(r"sof-|uimo-",pid): continue
    for q in p["questions"]:
        for o in q.get("options",[]):
            t=o["text"]; why=[]
            if "\n\n" in t: why.append("multi-paragraph")
            if LEAK.search(t): why.append("directions text")
            if re.search(r"\*\*[^*]{1,6}\*\*\s*$",t) and "\n" in t: why.append("stray bold fragment")
            if why: rows.append((pid,q["number"],o["label"],"+".join(why),t.replace("\n"," | ")[:110]))
        st=q["stem"]
        if re.search(r"(?i)\n\nfor questions|\n\ndirections",st) and not st.lower().startswith(("for question","direction")):
            rows.append((pid,q["number"],"stem","directions inside stem tail",st.replace("\n"," | ")[-110:]))
print("affected entries:",len(rows),"questions:",len({(r[0],r[1]) for r in rows}))
print(collections.Counter(r[3] for r in rows))
for r in rows: print(" ",r)
