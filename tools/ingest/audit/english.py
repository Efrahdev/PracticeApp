import pymupdf, re, json, zipfile, glob, difflib
def unmd(s):
    s=re.sub(r"\\(.)",r"\1",str(s)); s=re.sub(r"\*\*|(?<!\w)\*(?!\s)|(?<=\S)\*(?!\w)","",s)
    return s
def norm(s):
    s=unmd(s); s=re.sub(r"[‘’`]","'",s); s=re.sub(r"[“”]",'"',s); s=s.replace("–","-").replace("—","-")
    return re.sub(r"\s+"," ",s).strip().strip(".").lower()
def text(pdf):
    d=pymupdf.open(pdf); T="\n".join(p.get_text() for p in d)
    return re.sub(r"(?m)^Page \d+\s*$\n?","",T)
def load(pid):
    return {q["number"]:q for q in json.loads(zipfile.ZipFile(glob.glob(f"ingest-out/*/{pid}.zip")[0]).read("pack.json"))["questions"]}
def check(pid, qs_raw, ks_raw):
    P=load(pid); probs=[]
    if set(P)!=set(qs_raw) or set(P)!=set(ks_raw): probs.append(f"number sets differ pack={len(P)} paper={len(qs_raw)} key={len(ks_raw)}")
    stats={"mcq":0,"multi":0,"text":0,"stem_ok":0}
    for n,q in P.items():
        if n not in ks_raw: continue
        ans=ks_raw[n]; t=q["type"]
        # stem fidelity: pack stem must appear in source question text
        src=norm(qs_raw.get(n,"")); st=norm(q["stem"])
        r=difflib.SequenceMatcher(None,st,src[:len(st)+40]).ratio() if st else 0
        if st and (st in src or r>0.93): stats["stem_ok"]+=1
        else: probs.append(f"Q{n} stem differs ({r:.2f}): pack={st[:90]!r} src={src[:90]!r}")
        opts={o["label"]:norm(o["text"]) for o in q.get("options",[])}
        if t=="mcq_single":
            stats["mcq"]+=1
            m=re.match(r"\(([A-F])\)",ans.strip())
            if m:
                if q.get("answer")!=m.group(1): probs.append(f"Q{n} MCQ pack={q.get('answer')} key={m.group(1)}")
            else:
                hit=[l for l,o in opts.items() if o==norm(ans)]
                if hit!=[q.get("answer")]: probs.append(f"Q{n} MCQ pack={q.get('answer')} key-text={ans!r} matches={hit}")
        elif t=="mcq_multi":
            stats["multi"]+=1
            part=re.split(r";|\bare wrong\b|\bis wrong\b",ans)[0]
            letters=sorted(set(re.findall(r"\(([A-Fa-f])\)",part))); letters=[x.upper() for x in letters]
            if sorted(q.get("answer") or [])!=letters: probs.append(f"Q{n} MULTI pack={q.get('answer')} key={letters} ({ans[:80]!r})")
        else:
            stats["text"]+=1
            pa=q.get("answer"); pa=pa if isinstance(pa,list) else [pa]
            ka=norm(ans)
            if not all(p is not None and norm(p) in ka for p in pa) and norm(" / ".join(map(str,pa)))!=ka:
                probs.append(f"Q{n} TEXT pack={pa!r} key={ans[:100]!r}")
    print(f"{pid:40s} q={len(P)} {stats} problems={len(probs)}")
    for p in probs: print("   ",p)

FIELD_END=r"(?=\n(?:Why|Explanation|Distractor analysis|Principle|Intuition hook|Grammar principle|Memory tip|Why the other options are wrong[^:]*|Difficulty):|\nQ\d+\.\s|\Z)"
def tense(pdf, pid):
    T=text(pdf); ki=[m.start() for m in re.finditer(r"(?m)^Answer Key and Reasoning\s*$",T)][-1]
    qp, kp = T[T.index("\nQ1. ["):ki], T[ki:]
    qs={}
    for m in re.finditer(r"(?ms)^Q(\d+)\.\s*\[[^\]]*\]\s*(.*?)(?=^\(A\)\s|^Q\d+\.\s*\[|^Section |\Z)",qp): qs.setdefault(m.group(1),m.group(2))
    ks={}
    for m in re.finditer(r"(?ms)^Q(\d+)\.\s*\(.*?\n?Correct answer:\s*(.*?)"+FIELD_END,kp): ks.setdefault(m.group(1),m.group(2))
    check(pid,qs,ks)
def prep(pdf, pid):
    T=text(pdf); ki=[m.start() for m in re.finditer(r"(?m)^Answer Key and Reasoning\s*$",T)][-1]
    qp=T[T.index("Assessment Questions"):ki]; kp=T[ki:]
    qs={}
    for m in re.finditer(r"(?ms)^(\d+)\.\s{2,}(.*?)(?=^\([a-d]\)\s|^Answer:|^\d+\.\s{2,}|\Z)",qp): qs.setdefault(m.group(1),m.group(2))
    ks={}
    for m in re.finditer(r"(?ms)^Q(\d+)\.\s+\([^\n]*\)[ \t]*\nAnswer:\s*(.*?)"+FIELD_END,kp): ks.setdefault(m.group(1),m.group(2))
    check(pid,qs,ks)
tense("Verb_Tenses_Diagnostic_Assessment.pdf","verb-tenses-diagnostic-assessment")
tense("TENSE PRACTICE 2.pdf","verb-tenses-mixed-mastery-100")
prep("Prepositions_Diagnostic_Assessment.pdf","prepositions-diagnostic-assessment")

print("--- option text fidelity")
def optcheck(pdf,pid,start,kmark,qre,ore):
    T=text(pdf); ki=[m.start() for m in re.finditer(kmark,T)][-1]; qp=T[T.index(start):ki]
    blocks={m.group(1):m.group(2) for m in re.finditer(qre,qp)}
    P=load(pid); bad=0; tot=0
    for n,q in P.items():
        if not q.get("options") or n not in blocks: continue
        src={l.upper():norm(t) for l,t in re.findall(ore,blocks[n])}
        if q["type"]=="mcq_multi" and pid.startswith("prep"): continue  # options rebuilt from the stem; checked by answer test
        for o in q["options"]:
            tot+=1
            if src.get(o["label"])!=norm(o["text"]): bad+=1; print("   ",pid,"Q"+n,o["label"],repr(o["text"][:60]),"src=",repr(src.get(o["label"],"")[:60]))
    print(f"{pid:40s} options checked={tot} mismatched={bad}")
optcheck("Verb_Tenses_Diagnostic_Assessment.pdf","verb-tenses-diagnostic-assessment","\nQ1. [",r"(?m)^Answer Key and Reasoning\s*$",r"(?ms)^Q(\d+)\.\s*\[.*?\](.*?)(?=^Q\d+\.\s*\[|\Z)",r"(?ms)^\(([A-F])\)\s+(.*?)(?=^\([A-F]\)\s|^Q\d|^Section|\Z)")
optcheck("TENSE PRACTICE 2.pdf","verb-tenses-mixed-mastery-100","\nQ1. [",r"(?m)^Answer Key and Reasoning\s*$",r"(?ms)^Q(\d+)\.\s*\[.*?\](.*?)(?=^Q\d+\.\s*\[|\Z)",r"(?ms)^\(([A-F])\)\s+(.*?)(?=^\([A-F]\)\s|^Q\d|^Section|\Z)")
optcheck("Prepositions_Diagnostic_Assessment.pdf","prepositions-diagnostic-assessment","Assessment Questions",r"(?m)^Answer Key and Reasoning\s*$",r"(?ms)^(\d+)\.\s{2,}(.*?)(?=^\d+\.\s{2,}|\Z)",r"(?ms)^\(([a-d])\)\s{2,}(.*?)(?=^\([a-d]\)\s|^Answer:|\Z)")
