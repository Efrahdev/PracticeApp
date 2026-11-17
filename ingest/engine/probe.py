"""`ingest probe` and `ingest brief` (W3, spec 6.2): facts about a source, for the AI that drafts the profile.

Read-only and deterministic. It applies no judgement: it counts, clusters and quotes. The brief wraps the
report in the standard profiling prompt so the same instructions go to any AI model.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from collections import Counter
from pathlib import Path

from bs4 import NavigableString, Tag

from util import EXIT_PASS, ENGINE_VERSION, StageFail, UsageError, atomic_write, sha256_bytes, write_json

INGEST = Path(__file__).resolve().parents[1]
NUMBERING = {"1. / 1)": r"^\s*\d+\s*[.)]\s", "(a) / a)": r"^\s*\(?[a-z]\)\s", "Q1": r"^\s*Q\.?\s*\d+", "1.1": r"^\s*\d+\.\d+\s", "(i)": r"^\s*\(?[ivx]+\)\s", "A. / (A)": r"^\s*\(?[A-E][.)]\s"}


def _numbering(texts: list[str]) -> dict:
    return {name: n for name, pat in NUMBERING.items() if (n := sum(1 for t in texts if re.match(pat, t)))}


def _sig(el: Tag) -> str:
    return el.name + "".join("." + c for c in sorted(el.get("class") or []))


STRUCTURAL = {"ol", "ul", "table", "figure", "figcaption", "svg", "img", "details", "summary", "section", "header", "footer", "aside",
              "h1", "h2", "h3", "h4", "h5", "h6", "math", "canvas", "iframe", "video", "audio", "blockquote", "pre", "dl"}


def _skeleton(el: Tag, depth: int = 4) -> str:
    """The structure that a profile has to handle: named parts (elements with a class) and structural
    elements, as an unordered set at each level. Ordinary text markup (p, li, strong ...) and how many times a
    child repeats do not make a new shape."""
    if depth == 0 or el.name == "svg":
        return _sig(el)
    inner = set()
    for k in el.children:
        if isinstance(k, Tag) and (k.get("class") or k.name in STRUCTURAL):
            inner.add(_skeleton(k, depth - 1))
        elif isinstance(k, Tag):
            for d in k.find_all(True):   # look through plain wrappers for named or structural parts
                if d.get("class") or d.name in STRUCTURAL:
                    if not any(p is not k and (p.get("class") or p.name in STRUCTURAL) for p in d.parents if p is not None and p in k.descendants):
                        inner.add(_skeleton(d, depth - 1))
    return _sig(el) + ("(" + ",".join(sorted(inner)) + ")" if inner else "")


def _clip_markup(el: Tag, limit: int = 3500) -> str:
    raw = str(el)
    raw = re.sub(r"(<svg\b[^>]*>).*?(</svg>)", r"\1…svg body omitted…\2", raw, flags=re.S)
    return raw if len(raw) <= limit else raw[:limit] + f"\n…[{len(raw) - limit} more characters omitted]"


# --------------------------------------------------------------------------- HTML
def probe_html(data: bytes, name: str) -> dict:
    from html_adapter import HtmlDoc, locator_of
    from json_kind import LiteralParser
    doc = HtmlDoc(data, name)
    soup = doc.soup
    body = soup.body or soup
    tags, classes, groups = Counter(), Counter(), {}
    for el in body.find_all(True):
        tags[el.name] += 1
        for c in el.get("class") or []:
            classes[c] += 1
        groups.setdefault(_sig(el), []).append(el)
    texts = [b["text"].strip() for b in doc.ledger.blocks if b["kind"] == "text"]
    out = {"kind": "html", "elements": sum(tags.values()), "text_blocks": len(texts), "words": sum(len(t.split()) for t in texts),
           "tags": dict(tags.most_common(40)), "classes": dict(classes.most_common(50)), "numbering_patterns": _numbering(texts)}
    # repeated containers: same tag+classes many times, each holding real text, not nested in one another
    candidates = []
    for sig, els in groups.items():
        if len(els) < 3 or els[0].name in ("li", "span", "p", "td", "tr", "a", "strong", "em", "b", "i", "br", "option", "th", "h1", "h2", "h3", "h4", "label", "button", "input",
                                           "svg", "path", "line", "polygon", "text", "rect", "circle", "g", "summary", "small", "sup", "sub", "u", "code"):
            continue
        avg_words = sum(len(e.get_text(" ").split()) for e in els) / len(els)
        if avg_words < 12:
            continue
        nested = sum(1 for e in els if any(_sig(p) == sig for p in e.parents if isinstance(p, Tag)))
        candidates.append({"selector": sig, "count": len(els), "avg_words": round(avg_words), "nested_in_itself": nested,
                           "has_id": sum(1 for e in els if e.get("id")), "data_attrs": sorted({a for e in els for a in e.attrs if a.startswith("data-")})})
    candidates.sort(key=lambda c: (-c["count"] * min(c["avg_words"], 400), c["selector"]))
    out["repeated_containers"] = candidates[:12]
    census, covered = [], set()
    for cand in candidates:
        if len(census) == 2:
            break
        els = groups[cand["selector"]]
        if any(id(e) in covered for e in els):   # nested inside an earlier candidate: already described there
            continue
        covered.update(id(d) for e in els for d in e.descendants)
        clusters: dict[str, list[Tag]] = {}
        for e in els:
            clusters.setdefault(hashlib.sha256(_skeleton(e).encode()).hexdigest()[:10], []).append(e)
        rows = [{"shape": h, "count": len(v), "rare": len(v) <= 3, "example": locator_of(v[0]), "skeleton": _skeleton(v[0])[:600]}
                for h, v in sorted(clusters.items(), key=lambda kv: (-len(kv[1]), kv[0]))]
        inner = Counter()   # in how many containers each named part appears: "96/140" means optional
        for e in els:
            for sig_ in {_sig(d) for d in e.find_all(True) if d.get("class") or d.name in STRUCTURAL}:
                inner[sig_] += 1
        samples = {"first": els[0], "middle": els[len(els) // 2], "last": els[-1]}
        rare = [v[0] for v in clusters.values() if len(v) <= 3][:3]
        census.append({"container": cand["selector"], "instances": len(els), "shapes": len(rows), "clusters": rows[:25],
                       "inner_elements": {k: f"{v}/{len(els)}" for k, v in inner.most_common(60)},
                       "samples": {k: _clip_markup(v) for k, v in samples.items()},
                       "rare_shape_samples": [{"locator": locator_of(e), "markup": _clip_markup(e, 2500)} for e in rare]})
    out["shape_census"] = census
    scripts = []
    for s in soup.find_all("script"):
        text = s.string or ""
        row = {"type": s.get("type") or "javascript", "id": s.get("id"), "src": s.get("src"), "chars": len(text)}
        if "json" in (s.get("type") or ""):
            try:
                val = json.loads(text)
                row["json_keys"] = {k: (f"list[{len(v)}] of {sorted(v[0]) if v and isinstance(v[0], dict) else type(v[0]).__name__ if v else '-'}" if isinstance(v, list) else type(v).__name__)
                                    for k, v in val.items()} if isinstance(val, dict) else type(val).__name__
            except ValueError:
                row["json_keys"] = "does not parse"
        else:
            arrays = []
            for m in re.finditer(r"(?m)^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[", text):
                entry = {"name": m.group(1)}
                try:
                    val = LiteralParser(text, m.end() - 1, m.group(1)).value()
                    entry["length"] = len(val)
                    entry["literals_only"] = True
                    objs = [v for v in val if isinstance(v, dict)]
                    if objs:
                        keys = Counter(k for o in objs for k in o)
                        entry["keys"] = {k: f"{n}/{len(objs)}" for k, n in keys.items()}
                        low = {}
                        for k in keys:
                            vals = Counter(json.dumps(o.get(k), ensure_ascii=False) for o in objs if not isinstance(o.get(k), (dict, list)))
                            if 1 < len(vals) <= 12 and sum(vals.values()) > len(vals):
                                low[k] = dict(vals.most_common())
                        entry["value_histograms"] = low
                        entry["samples"] = {"first": objs[0], "middle": objs[len(objs) // 2], "last": objs[-1]}
                        entry["nested_keys"] = {k: sorted(objs[0][k]) if isinstance(objs[0].get(k), dict) else
                                                (sorted(objs[0][k][0]) if isinstance(objs[0].get(k), list) and objs[0][k] and isinstance(objs[0][k][0], dict) else None)
                                                for k in objs[0] if isinstance(objs[0].get(k), (dict, list))}
                except StageFail as e:
                    entry["literals_only"] = False
                    entry["why"] = e.message[:160]
                arrays.append(entry)
            row["data_arrays"] = arrays
        scripts.append(row)
    out["scripts"] = scripts
    svgs = soup.find_all("svg")
    css = "\n".join(s.string or "" for s in soup.find_all("style"))
    svg_classes = {c for s in svgs for el in [s, *s.find_all(True)] for c in el.get("class") or []}
    out["figures"] = {"svg": len(svgs), "img": len(soup.find_all("img")), "svg_with_defs": sum(1 for s in svgs if s.find("defs")),
                      "svg_classes_styled_by_page_css": sorted(c for c in svg_classes if re.search(rf"\.{re.escape(c)}\b", css))[:40],
                      "svg_alt_attrs": dict(Counter(a for s in svgs for a in ("aria-label", "title") if s.get(a)))}
    out["css"] = {"style_blocks": len(soup.find_all("style")), "linked_stylesheets": [l.get("href") for l in soup.find_all("link") if "stylesheet" in (l.get("rel") or [])],
                  "white_space_rules": sorted(set(re.findall(r"([^{}]+)\{[^}]*white-space\s*:\s*(pre[\w-]*)", css)))[:20],
                  "generated_content_rules": sorted(set(m.strip() for m in re.findall(r"([^{}]+::?(?:before|after))\s*\{[^}]*content\s*:", css)))[:20],
                  "counters": bool(re.search(r"counter-(reset|increment)", css))}
    fmt = {t: tags[t] for t in ("strong", "b", "em", "i", "u", "ins", "s", "del", "mark", "sup", "sub", "br", "table", "ol", "ul", "details", "input", "textarea", "button") if tags[t]}
    out["formatting_inventory"] = fmt
    out["ol_types"] = dict(Counter(o.get("type") or "1" for o in soup.find_all("ol")))
    out["math_carriers"] = {"mathml": tags["math"], "tex_dollar": len(re.findall(r"\$[^$\n]{1,80}\$", " ".join(texts))), "tex_paren": " ".join(texts).count("\\("),
                            "katex_or_mathjax": sum(n for c, n in classes.items() if re.search(r"katex|mathjax|MathJax", c)),
                            "fraction_like_classes": {c: n for c, n in classes.items() if re.search(r"frac|^fr$|^fr-|mixed|numer|denom", c)}}
    out["hidden_content"] = {"details": tags["details"], "hidden_attr": len(soup.select("[hidden]")), "aria_hidden": len(soup.select("[aria-hidden=true]")),
                             "sr_only_like": {c: n for c, n in classes.items() if re.search(r"sr-only|visually-hidden|screen-reader", c)}}
    outside = Counter()
    if candidates:
        top = groups[candidates[0]["selector"]]
        inside = {id(d) for e in top for d in e.descendants}
        for node, bid in ((n, b) for n, b in ((s, doc.text_block.get(id(s))) for s in body.find_all(string=True)) if b is not None):
            if id(node) not in inside:
                anc = next((p for p in node.parents if isinstance(p, Tag) and (p.get("id") or p.get("class")) and p.name not in ("span", "a", "li", "p", "strong", "em", "td", "th", "tr")), None)
                outside[(_sig(anc) + (f"#{anc['id']}" if anc.get("id") else "")) if anc else "(body)"] += len(str(node).split())
        out["text_outside_top_container"] = {"note": f"words of text that sit outside {candidates[0]['selector']}, by nearest named ancestor: each must be claimed or ignored with a reason",
                                             "words_by_region": dict(outside.most_common(30))}
    return out


# --------------------------------------------------------------------------- DOCX
def probe_docx(data: bytes, name: str) -> dict:
    from docx_kind import DocxDoc
    doc = DocxDoc(data, name)
    paras = doc.paragraphs
    styles = Counter(f"{p['style']} ({doc.style_names.get(p['style'], p['style'])})" for p in paras)
    xml = doc.parts["word/document.xml"].decode("utf-8", "replace")
    flags = Counter(f for p in paras for r in p["runs"] for f in r["flags"])
    def show(p):
        return {"locator": p["locator"], "style": p["style"], "text": p["text"][:400], "formats": sorted({f for r in p["runs"] for f in r["flags"]})}
    picks = paras[:8] + paras[len(paras) // 2:len(paras) // 2 + 3] + paras[-3:]
    return {"kind": "docx", "paragraphs_with_text": len(paras), "words": sum(len(p["text"].split()) for p in paras), "style_histogram": dict(styles.most_common()),
            "numbering_patterns": _numbering([p["text"] for p in paras]),
            "constructs": {"automatic_numbering(numPr)": xml.count("<w:numPr>"), "tables": xml.count("<w:tbl>"), "images": xml.count("<w:drawing") + xml.count("<w:pict"),
                           "equations": xml.count("<m:oMath"), "comments": xml.count("<w:commentReference"), "tracked_insertions": xml.count("<w:ins "),
                           "tracked_deletions": xml.count("<w:del "), "footnotes": xml.count("<w:footnoteReference"), "line_breaks": xml.count("<w:br"),
                           "headers_footers": sorted(p for p in doc.parts if re.search(r"word/(header|footer)\d*\.xml", p))},
            "run_formatting": dict(flags), "unsupported_blocks": [{"locator": b["locator"], "construct": b.get("construct")} for b in doc.ledger.blocks if b["kind"] == "unsupported"][:20],
            "paragraphs_before_first_number": [show(p) for p in paras[:next((i for i, p in enumerate(paras) if re.match(r"^\s*\d+\s*[.)]\s", p["text"])), min(6, len(paras)))]],
            "sample_paragraphs": [show(p) for p in dict.fromkeys(id(p) for p in picks) and picks]}


# --------------------------------------------------------------------------- PDF
def probe_pdf(path: Path) -> dict:
    try:
        import pdfplumber
    except ImportError:
        return {"kind": "pdf", "error": "pdfplumber is not installed, so PDFs cannot be probed here"}
    pages, texts = [], []
    with pdfplumber.open(str(path)) as pdf:
        total = len(pdf.pages)
        for i, page in enumerate(pdf.pages[:400], start=1):
            text = page.extract_text() or ""
            fonts = Counter(c.get("fontname", "?") for c in page.chars)
            scan = len(page.images) > 0 and len(text.strip()) < 40
            pages.append({"page": i, "chars": len(text), "text_layer": len(text.strip()) >= 40, "images": len(page.images), "scan_suspected": scan,
                          "fonts": dict(fonts.most_common(4))})
            texts.extend(text.splitlines())
    scans = [p["page"] for p in pages if p["scan_suspected"] or not p["text_layer"]]
    return {"kind": "pdf", "pages": total, "pages_with_text_layer": sum(1 for p in pages if p["text_layer"]), "pages_without_text_or_scanned": scans[:60],
            "numbering_patterns": _numbering(texts), "first_lines": [t for t in texts if t.strip()][:40],
            "per_page": pages[:12] + ([{"…": f"{len(pages) - 12} more pages"}] if len(pages) > 12 else []),
            "verdict": ("every page is a scan or has no text layer: there is no AI-free way to read it; use the manual pack route (spec section 11.2)" if len(scans) == len(pages)
                        else "digital text is present" + (f", but {len(scans)} page(s) look scanned" if scans else "") +
                        ". NOTE: this engine version probes PDFs but does not convert them yet (see ingest/ARCHITECTURE.md)")}


def rendered_diff(path: Path) -> dict:
    """Static-versus-rendered facts from an isolated headless browser (network blocked). Optional: skipped
    with a note when the browser is not available."""
    env = dict(os.environ, NODE_PATH=str(INGEST.parent / "node_modules") + os.pathsep + "/opt/node-tools/node_modules")
    try:
        p = subprocess.run(["node", str(INGEST / "checker" / "rendered.mjs"), str(path.resolve())], capture_output=True, text=True, timeout=180, env=env, cwd=str(INGEST.parent))
        if p.returncode != 0:
            return {"skipped": (p.stderr or p.stdout).strip()[-300:]}
        return json.loads(p.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        return {"skipped": str(e)[:300]}


def probe_file(path: Path, render: bool = True) -> dict:
    import stages
    data = path.read_bytes()
    kind = stages.detect_kind(data)
    base = {"file": path.name, "bytes": len(data), "sha256": sha256_bytes(data), "detected_format": kind, "probe_version": ENGINE_VERSION}
    if kind == "html":
        base.update(probe_html(data, path.name))
        if render:
            base["static_vs_rendered"] = rendered_diff(path)
    elif kind == "docx":
        base.update(probe_docx(data, path.name))
    elif kind == "pdf":
        base.update(probe_pdf(path))
    else:
        base["error"] = "unknown format: only HTML, Word (.docx) and PDF are recognised"
    return base


# --------------------------------------------------------------------------- Markdown rendering of the report
def _md(report: dict) -> str:
    L = [f"## Probe report: `{report['file']}`", "", f"- format detected from the file's bytes: **{report['detected_format']}** · {report['bytes']} bytes · sha256 `{report['sha256']}`"]
    j = lambda v: json.dumps(v, ensure_ascii=False)   # noqa: E731
    if report.get("error"):
        return "\n".join(L + [f"- **{report['error']}**", ""])
    kind = report["kind"]
    if kind == "html":
        L += [f"- {report['elements']} elements, {report['text_blocks']} text blocks, {report['words']} words", f"- numbering patterns at the start of text blocks: {j(report['numbering_patterns'])}",
              "", "### Repeated containers (candidates for 'one question')", "", "| selector | count | avg words | nested in itself | with id | data- attributes |", "| --- | ---: | ---: | ---: | ---: | --- |"]
        L += [f"| `{c['selector']}` | {c['count']} | {c['avg_words']} | {c['nested_in_itself']} | {c['has_id']} | {', '.join(c['data_attrs']) or '-'} |" for c in report["repeated_containers"]]
        for cen in report["shape_census"]:
            L += ["", f"### Shape census of `{cen['container']}` ({cen['instances']} instances, {cen['shapes']} distinct shapes)", "",
                  "Each shape is a distinct tag-and-class skeleton. **Rare shapes (3 or fewer) are where profiles break: handle each one.**", "", "| shape | count | rare | example | skeleton |", "| --- | ---: | --- | --- | --- |"]
            L += [f"| {r['shape']} | {r['count']} | {'RARE' if r['rare'] else ''} | `{r['example']}` | `{r['skeleton'][:260]}` |" for r in cen["clusters"][:15]]
            if len(cen["clusters"]) > 15:
                L.append(f"| … | {sum(r['count'] for r in cen['clusters'][15:])} | | {len(cen['clusters']) - 15} more shapes | |")
            L += ["", "Named and structural parts found inside these containers, as *in how many containers it appears / total* "
                  "(less than total means the part is optional and the profile must cope when it is missing):", "", f"`{j(cen['inner_elements'])}`"]
            for label, markup in cen["samples"].items():
                L += ["", f"**Verbatim markup, {label} instance:**", "", "```html", markup, "```"]
            for r in cen["rare_shape_samples"]:
                L += ["", f"**Verbatim markup, rare shape at `{r['locator']}`:**", "", "```html", r["markup"], "```"]
        if report.get("text_outside_top_container"):
            L += ["", "### Text outside the top container", "", report["text_outside_top_container"]["note"], "", f"`{j(report['text_outside_top_container']['words_by_region'])}`"]
        L += ["", "### Scripts and embedded data", ""]
        for s in report["scripts"]:
            L.append(f"- `<script type={s['type']}{' id=' + s['id'] if s['id'] else ''}>` {s['chars']} characters" + (f" · JSON keys: `{j(s['json_keys'])}`" if "json_keys" in s else ""))
            for a in s.get("data_arrays", []):
                if not a.get("literals_only"):
                    L.append(f"  - array `{a['name']}`: NOT pure literal data ({a.get('why', '')})")
                    continue
                L.append(f"  - array `{a['name']}`: {a['length']} items, literal data only" + (f" · keys (present in n/total): `{j(a.get('keys'))}`" if a.get("keys") else ""))
                if a.get("value_histograms"):
                    L.append(f"    - values of low-variety keys: `{j(a['value_histograms'])}`")
                if a.get("nested_keys"):
                    L.append(f"    - nested keys: `{j(a['nested_keys'])}`")
                for label, obj in (a.get("samples") or {}).items():
                    L += [f"    - {label} item:", "", "```json", json.dumps(obj, ensure_ascii=False, indent=1)[:2500], "```"]
        L += ["", "### Figures, styles, formatting, maths, hidden content", "", f"- figures: `{j(report['figures'])}`", f"- CSS: `{j(report['css'])}`",
              f"- formatting inventory (element counts): `{j(report['formatting_inventory'])}` · ordered-list types: `{j(report['ol_types'])}`",
              f"- maths carriers: `{j(report['math_carriers'])}`", f"- hidden content: `{j(report['hidden_content'])}`",
              f"- most common classes: `{j(report['classes'])}`", f"- tags: `{j(report['tags'])}`"]
        if "static_vs_rendered" in report:
            L += ["", "### Static file versus rendered page (isolated browser, network blocked)", "", "```json", json.dumps(report["static_vs_rendered"], ensure_ascii=False, indent=1)[:6000], "```"]
    elif kind == "docx":
        L += [f"- {report['paragraphs_with_text']} paragraphs with text, {report['words']} words", f"- paragraph styles (style id (name): count): `{j(report['style_histogram'])}`",
              f"- numbering patterns typed as text: `{j(report['numbering_patterns'])}`", f"- constructs: `{j(report['constructs'])}`", f"- run formatting: `{j(report['run_formatting'])}`",
              f"- unsupported blocks: `{j(report['unsupported_blocks'])}`", "", "### Paragraphs before the first numbered paragraph", "", "```json",
              json.dumps(report["paragraphs_before_first_number"], ensure_ascii=False, indent=1), "```", "", "### Sample paragraphs (first, middle, last)", "", "```json",
              json.dumps(report["sample_paragraphs"], ensure_ascii=False, indent=1), "```"]
    elif kind == "pdf":
        L += [f"- {report.get('pages')} pages, {report.get('pages_with_text_layer')} with a text layer", f"- pages without text or suspected scans: `{j(report.get('pages_without_text_or_scanned'))}`",
              f"- **{report.get('verdict')}**", f"- numbering patterns: `{j(report.get('numbering_patterns'))}`", "", "### First lines of text", "", "```", *report.get("first_lines", []), "```",
              "", "### Per page", "", "```json", json.dumps(report.get("per_page"), ensure_ascii=False, indent=1), "```"]
    return "\n".join(L) + "\n"


def _reports(args) -> list[dict]:
    out = []
    for f in args.files:
        p = Path(f)
        if not p.exists():
            raise UsageError(f"no such file: {p}")
        out.append(probe_file(p))
    return out


def main(args) -> int:
    reports = _reports(args)
    md = "\n".join(_md(r) for r in reports)
    if args.out:
        out = Path(args.out)
        write_json(out / "probe.json", reports)
        atomic_write(out / "probe.md", md.encode("utf-8"))
        print(f"wrote {out / 'probe.json'} and {out / 'probe.md'}")
    else:
        print(json.dumps(reports, ensure_ascii=False, indent=2) if args.json else md)
    return EXIT_PASS


def brief(args) -> int:
    """The standard profiler: one paste-ready file for any AI model = instructions + language reference +
    worked examples + this document's probe report."""
    reports = _reports(args)
    kit = INGEST / "kit"
    template = (kit / "PROFILER_PROMPT.md").read_text(encoding="utf-8")
    kinds = {r.get("kind") for r in reports}
    examples = []
    wanted = {"html": ["geometry-html", "unitary-html", "grammar-json"], "docx": ["docx-numbered"], "pdf": ["docx-numbered"]}
    job_for = {"geometry-html": "geometry-olympiad-achiever-100", "unitary-html": "unitary-method-olympiad-course", "grammar-json": "grammar-midterm-mastery-assessment",
               "docx-numbered": "class5-calendar-sums"}
    for name in dict.fromkeys(n for k in sorted(k for k in kinds if k) for n in wanted.get(k, [])):
        prof, job = INGEST / "profiles" / f"{name}.yaml", INGEST / "jobs" / f"{job_for[name]}.yaml"
        if prof.exists() and job.exists():
            examples.append(f"### Worked example: `{name}`\n\n```yaml\n{prof.read_text(encoding='utf-8').rstrip()}\n---\n{job.read_text(encoding='utf-8').rstrip()}\n```\n")
    text = (template.replace("{{PROFILE_REFERENCE}}", (kit / "PROFILE_REFERENCE.md").read_text(encoding="utf-8").strip())
            .replace("{{WORKED_EXAMPLES}}", "\n".join(examples).strip())
            .replace("{{SOURCE_FILES}}", ", ".join(f"`{r['file']}`" for r in reports))
            .replace("{{PROBE_REPORT}}", "\n".join(_md(r) for r in reports).strip()))
    out = Path(args.out) if args.out else INGEST / "scratch" / (re.sub(r"[^A-Za-z0-9]+", "-", Path(args.files[0]).stem).strip("-").lower() + ".brief.md")
    atomic_write(out, text.encode("utf-8"))
    print(f"wrote {out}  ({len(text):,} characters)\n"
          "Paste the whole file to any AI model (attach the source file too if the model accepts files).\n"
          "Save its reply as one .yaml file (profile, then ---, then job) and run:  ingest lint FILE  then  ingest try FILE")
    return EXIT_PASS
