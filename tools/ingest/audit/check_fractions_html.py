import re, json, html
def strip(s):
    s=re.sub(r"<svg.*?</svg>"," ",s,flags=re.S); s=re.sub(r"<[^>]+>"," ",s); s=html.unescape(s)
    return re.sub(r"\s+"," ",s).strip()
def norm_pack(s):
    s=re.sub(r"!\[[^\]]*\]\(asset:[^)]+\)"," ",s)
    s=re.sub(r"\$-?(\d*)\\frac\{([^}]*)\}\{([^}]*)\}\$",lambda m:(m.group(1)+" " if m.group(1) else "")+m.group(2)+"/"+m.group(3),s)
    s=re.sub(r"\\(.)",r"\1",s); s=re.sub(r"\*+","",s); s=re.sub(r"</?su[bp]>","",s)
    return re.sub(r"\s+"," ",s).strip()
def words(s): return re.findall(r"[A-Za-z0-9₹£$%/]+",s.lower())
# ---- Fractions 2: answers vs raw key, stems vs raw question blocks
H=open("Claude Fractions 2 .html",encoding="utf8").read()
key={int(n):strip(a) for n,a in re.findall(r"<li><b>Q(\d+)</b>(.*?)</li>",H,re.S)}
qb={int(n):strip(b) for n,b in re.findall(r'<div class="qn">Q(\d+)</div><div class="qb">(.*?)</div></div>\s*(?=<div class="q |<div class="band|</section|\n)',H,re.S)}
P={int(q["number"]):q for q in json.load(open("ingest-out/html/olympiad-fractions-master-set-2/pack.json"))["questions"]}
bad=[n for n in P if strip(str(P[n]["answer"]))!=key.get(n)]
print("Fractions 2: questions",len(P),"key entries",len(key),"raw blocks",len(qb),"answer mismatches",bad[:10])
sb=[]
for n,q in P.items():
    a,b=words(norm_pack(q["stem"])),words(qb.get(n,""))
    if a!=b: sb.append((n," ".join(a)[:80]," ".join(b)[:80]))
print("  stem word mismatches:",len(sb)); [print("   ",x) for x in sb[:8]]
fig_src=len(re.findall(r'<div class="fig">',H)); print("  figures source",fig_src,"pack",sum(q["stem"].count("asset:") for q in P.values()))
# ---- Fractions 1: stems + solutions
H=open("Claude Fractions 1 .html",encoding="utf8").read()
sol_part=H[H.index('id="solutions"'):]; q_part=H[:H.index('id="solutions"')]
def blocks(part, cls):
    out={}
    for m in re.finditer(rf'<div class="{cls}"[^>]*>(.*?)(?=<div class="{cls}"|</section|<section|\Z)',part,re.S):
        n=re.search(r'<span class="qn">\s*Q?(\d+)',m.group(1))
        if n: out[int(n.group(1))]=strip(re.sub(r'<span class="qn">.*?</span>','',m.group(1),count=1,flags=re.S))
    return out
qs,ss=blocks(q_part,"q"),blocks(sol_part,"sol")
P={int(q["number"]):q for q in json.load(open("ingest-out/html/olympiad-fractions-master-set/pack.json"))["questions"]}
def close(a,b):
    a,b=words(a),words(b); 
    return a==b[:len(a)] or a==b
sm=[n for n in P if not close(norm_pack(P[n]["stem"]),qs.get(n,""))]
so=[n for n in P if not close(norm_pack(P[n].get("solution","")),ss.get(n,""))]
print("Fractions 1: questions",len(P),"raw q",len(qs),"raw sol",len(ss),"stem mismatches",sm[:10],"solution mismatches",so[:10])
for n in (sm+so)[:3]:
    print("   Q",n,"\n     pack:"," ".join(words(norm_pack(P[n]['stem'])))[:150],"\n     src :"," ".join(words(qs.get(n,'')))[:150])
import difflib
print("all solution mismatches:",so)
for n in so[:4]:
    a=words(norm_pack(P[n]["solution"])); b=words(ss[n])
    sm_=difflib.SequenceMatcher(None,a,b)
    print("Q",n,"ratio",round(sm_.ratio(),3),[ (op," ".join(a[i1:i2]), " ".join(b[j1:j2])) for op,i1,i2,j1,j2 in sm_.get_opcodes() if op!="equal"][:4])
real=[n for n in so if "".join(words(norm_pack(P[n]["solution"])))!="".join(words(ss[n]))]
print("Fractions 1 solutions differing beyond spacing:",real)
real2=[n for n in sb if False]
