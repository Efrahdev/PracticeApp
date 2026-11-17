# Ingestion pipeline: architecture, review and conformance

This is the build of *Document Ingestion Pipeline: Architecture and Build Specification v2* (16 Nov 2026), with
the changes I made after reviewing it, an honest list of what is not built, and answers to the spec's open
`[CONFIRM]` questions found by reading the app's code. How to *use* the pipeline is in [README.md](README.md).

## 1. The shape in one paragraph

Two human gates frame an automated corridor. **Gate A**: an AI drafts a *profile* (a layout family) and a
*job* (one paper) from a machine-made probe report; `lint` and `try` keep it honest; a person signs it off by
pinning its hash. **Corridor**: S0 intake → S1 extract every piece of source text into ledger blocks → S2
segment and map, claiming each block for a field or ignoring it *with a reason and a limit* → S3 apply
corrections and assemble a byte-deterministic pack → S4 six gates, each proven able to fail first → S5 review
packet. **Gate B**: a different person or AI session reviews a risk-ranked sample mixed with planted errors; the
approval binds to exact hashes. Gates G2–G4 are a separate program in a different language with a different
parser, so a converter mistake cannot be repeated by its own checker.

## 2. Review of the specification: what I changed and why

The spec is sound: the two gates, the coverage ledger, independence, hash-bound approval and "stop rather than
guess" are the right foundations, and I kept all of them. The changes below close gaps I found while building
it against the seven real papers.

| # | Change | Why |
| --- | --- | --- |
| 1 | **A standard profiler, built** (`ingest brief`, [`kit/`](kit/)). One paste-ready file per paper: the profiling prompt, the full profile-language reference, worked examples that pass every check, and the probe report. Model-agnostic. | The spec left the "Gate A kit" as a companion deliverable, yet it is the one place an AI enters. A fixed template is what makes profiles comparable across models and sessions. |
| 2 | **One-file handover.** The AI's reply is one YAML file (profile, `---`, job); `--source FILE` supplies the raw input. | Matches the intended operation: hand over "profile output + raw file", nothing else. |
| 3 | **No hooks in v1.** Profiles are declarative only; `hooks` must be empty. | AI-written code is the largest risk the spec allows in. All seven papers (four layout families) fit the registry, so the safest choice costs nothing today. Add hooks only when a real paper needs one. |
| 4 | **Claim modes** on the ledger: `verbatim`, `derived`, `asset`, plus `shared`. | The spec's ledger cannot tell "this text is the stem" from "a number was read out of this text". Without the distinction, G3 either compares a mapped difficulty label to its source word and fails, or skips it and becomes vacuous. |
| 5 | **Added-text and stripped-text ledgers.** Every character the engine writes that is not in the source (generated `(a)` labels, the `—` in working lines, solution headings) and every prefix it removes (printed numbers, part labels) is recorded. | G3.compare can then allow exactly those tokens and nothing else. "Never invent" becomes checkable to the token. |
| 6 | **New check G3.invented**: every learner-visible pack field must trace back to claimed source blocks. | The spec's G3 compares claimed text to fields. A field with no claims at all (an invented answer) would slip past it. Fault F44 proves it is caught now. |
| 7 | **Self-tests mutate the real pack**, not a separate fixture; G4.svg also renders a control (the same figure with styles stripped) that must fail. | A fixture in a different environment can pass while the real environment is broken (a missing font). Testing the real run in the real browser removes that gap. |
| 8 | **Ignore rules can assert their text** (`expect: "Final answer:"`); keys the app keeps but does not use are declared (`passthrough`). | Makes the most dangerous rule type (ignore) self-checking, and turns G2.fields_consumed into a declared list instead of a judgement call. |
| 9 | **The checker runs in Node**, calling the app's own TypeScript reader and renderer unmodified. | G2 and G4 must use the app's real code (spec), which is TypeScript; this also gives G3 a different language "for free" (the spec lists that as optional). |
| 10 | **Exact sample size** (hypergeometric) instead of the rule of thumb; canaries sealed in `sealed/` outside `review/`. | The packet states precisely what a clean sample proves; an AI reviewer pasted the packet never sees the key. |
| 11 | **Locators are prefix-closed**: every block's locator starts with its question container's locator. | Containment checks (G1.asset_containment, G3.association) become plain string checks that the checker can do without trusting the converter's tree. |
| 12 | **Golden oracle with explained differences** (`ingest oracle`, [`oracle-diffs.yaml`](oracle-diffs.yaml)). | It already found a defect in the old converters: the Critical-Thinking title was typed by hand with a normal space; the document has a no-break space. |

## 2b. The page route (added after review: "generic" means any file)

The first build covered HTML and Word. A generic pipeline has to take PDFs, scans and screenshots, and those
break the assumptions the structured routes rely on: options share lines, fractions are stacked glyphs that text
extraction scrambles, figures are vector drawings, watermarks cross the text, symbol fonts carry no meaning, and
scans carry no text at all. The page route handles all of them with one model:

1. **Units.** Every page is read as text lines (pdfium), figures (found from the rendered pixels with the text
   masked out, so it works however a figure is drawn), ink bands (pages without text) and rotated text. Every
   unit must be claimed or ignored with a reason — the same coverage ledger as HTML and Word.
2. **Pictures as the safety net.** Every question keeps an exact crop of its region. `display: auto` shows the
   words when they can be trusted and the picture when the question has a figure, picture options, symbol-font
   characters, stacked fractions or text placed beside it. A question's picture stops before its inline solution.
3. **Independent checks.** G3 re-reads every page with **Poppler** (a different PDF library): per-page
   character conservation, per-line agreement at the same position, and per-question numbers. G4.crops
   re-renders every picture with Poppler (or the browser's image decoder for images) and compares pixels, with
   a misplaced-crop control that must fail. When the two PDF libraries disagree about a line (it happens: a
   glyph drawn over another), the run stops and names the question to show as a picture (`pictures:` in the job).
4. **Scans.** No OCR. The probe draws numbered ink bands on each page image; the job (written by the AI from
   the images) maps question numbers to units. Answers read off the page are recorded as *transcribed*; Gate B
   then requires `numerals_checked: full`.
5. **Everything else becomes pages.** Office files are printed by LibreOffice, awkward HTML by the browser, and
   the converted PDF is kept in the run folder so the checker reads exactly the same pages.

Evidence: a 200-question grammar PDF with an answer section (text questions, options, multi-letter answers); a
50-question maths olympiad PDF with figures, picture options and inline solutions (27 questions as pictures, 48
pictures all matching Poppler's rendering, worst difference 5.3 of 10); a scanned PDF and a screenshot (pictures
identical to the source, difference 0.0–2.5); a Word file printed by LibreOffice. The checks caught two real
defects along the way: answers starting "1)" that the app's renderer would have turned into a list (fixed in the
escaping for every route, and added to the hostile-string test), and a PDF line where an overlapping glyph was
read differently by the two libraries.

## 3. Conformance

### Global rules R1–R20

| Rule | Status | Evidence / note |
| --- | --- | --- |
| R1 Determinism | met | canonical JSON (sorted, NFC, LF), hand-written stored zip with fixed time, identity over `(path,size,sha256)`; G1.determinism rebuilds in a temp folder; test F25 on three layouts |
| R2 Fail loud | met | every stop is a `StageFail` with check id, locator and next action; an internal error exits 40, never 0 |
| R3 Never invent | met | answers absent stay absent (`answers: {expected: false}`); part answers split only when labels prove it (F40); figures copied byte for byte; G3.invented |
| R4 No AI, no network | met for S0–S5 | the engine makes no requests; the render browser blocks every request (G4.network). Unit tests are not run under an OS-level network block (not available here) |
| R5 Immutable runs | met | source copied read-only and re-hashed; a changed input gives a new run folder; an approved run cannot be re-run |
| R6 Hash everything | met | manifest, inputs.json, assets.json (original and packaged hashes), content_hashes.json |
| R7 Stage contract | partly | stages record inputs, outputs and status in the manifest and refuse to start after a FAIL; skipping unchanged stages is not implemented (a run is ~20 s) |
| R8 Independence | met | `checker/` (Node, parse5/cheerio, acorn, fflate) imports nothing from `engine/` (Python, html.parser, own literal parser); import-graph test U10 |
| R9 Locators | met | every block, claim, flag and error carries a selector path, paragraph index or array path |
| R10 Exit codes | met | 0/10/20/30/40 throughout |
| R11 Structured logs | met | one JSON line per event on stderr |
| R12 Pinned environment | partly | `package-lock.json` and `requirements.lock` hashed into the manifest; the browser build and fonts are the container's, not pinned |
| R13 Hostile input | mostly | HTML parsed inertly; JS data read by a literal-only parser (F42); DTD/entity refusal (F37), archive-bomb guard (F37b), unsafe figures refused (F41); profile regexes limited to the RE2 subset (U4). Not met: adapters run in-process without time/memory caps; the RE2 library itself could not be installed here (used automatically when present) |
| R14 No vacuous passes | met | every check reports examined/expected; zero examined fails unless declared plausible (F24) |
| R15 Strict by default | met | relaxations are declared in the profile with reasons and shown in `decisions-made.md`; assertion whitespace is the one built-in relaxation (people type assertions) |
| R16 Gates prove themselves | met | G1–G5 mutate the real pack and must catch it; G4.svg control figure |
| R17 Pin what approval depends on | met | source, profile (with registry versions), job, corrections, pack identity (F26, F27) |
| R18 Post-gate transformations | not met | belongs to the live stages (S6–S9), not built |
| R19 Structured review | met | assurance statement, structured verdicts, canaries (F29) |
| R20 Corrections are data | met | `--corrections` overlay with old-value hashes; stale entry stops the run (F39) |

### Work packages

| WP | Status |
| --- | --- |
| W1 foundation | built (`engine/util.py`) |
| W2 profile/job lint | built; 19 broken-profile cases (U7) |
| W3 probe | built: HTML (containers, shape census with rare shapes and optional parts, scripts and data arrays, figures, CSS, formatting, maths carriers, hidden content, static-vs-rendered), DOCX, PDF (text layer and scan detection) |
| W4 S0 intake | built |
| W5 S1 adapters | built: HTML, HTML with embedded JS data, DOCX, and the page adapter for digital PDF, scanned PDF, images and screenshots, Office files (via LibreOffice) and printed HTML |
| W6 S2 | built: three segmenters, transforms, answer rules, coverage ledger |
| W7 S3 | built: corrections overlay, assets, deterministic pack |
| W8 `try` | built, with side-by-side page and grouped unclaimed report |
| W9 gates | G1, G2, G5 complete; G3 complete except G3.formatting; G4: math, markup, hostile-string round trip, svg, network built — rendered text/layout comparison not built; **G6 not built** |
| W10 review packet | built |
| W11 approve-check | built; tamper cases F26–F31 |
| W12 live stages S6–S9 | **not built** (needs the live app; existing `preflight_live.mjs`, `import_live.mjs`, `verify_live.mjs` remain) |
| W13 CLI | built except `live`, `rerun-gates`, `verify-ledger`, `trace` |
| W14 tests/CI | 45 self-test cases (`npm run ingest:test`); the repo has no CI configuration, so nothing runs automatically yet |

Checks that are not built report **WARN "NOT RUN: …"** rather than disappearing, so every approval has to
waive them explicitly with a written reason. Nothing unbuilt can pass silently.

### Evidence: the seven papers

| Paper | Layout profile | Questions | Figures | Source tokens accounted for | Fields compared token by token | Oracle vs earlier packs |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Geometry Olympiad Achiever | `geometry-html` | 100 | 102 | 44,550 | 583 (41,133 tokens) | identical; style-block ordering explained |
| Unitary Method course | `unitary-html` | 140 | 0 | 92,869 | 1,013 (71,200 tokens) | identical |
| Grammar mastery assessment | `grammar-json` | 180 | 0 | 984 + 4,673 data values | 1,161 (30,304 tokens) | identical |
| Class 5 Calendar Sums | `docx-numbered` | 20 | 0 | 408 | 21 | identical |
| Class 5 Critical-Thinking Calendar Sums | `docx-numbered` | 20 | 0 | 557 | 41 | identical except title (finding) |
| Equally Spaced Objects | `docx-numbered` | 20 | 0 | 801 | 21 | identical |
| Advanced Critical Thinking worksheet | `docx-numbered` | 20 | 0 | 853 | 21 | identical |

All seven runs: G2 PASS; G1/G3/G4 WARN only for "profile hash not yet pinned" and the not-built checks; G5 no
tripwire fired; 102/102 figures render the same as in the source page (worst difference 2.56, threshold 10,
styles-stripped control 94.8).

## 4. Answers to the open [CONFIRM] items (from reading the code)

| ID | Answer | Effect |
| --- | --- | --- |
| O1 | Field names are in `docs/question-pack.schema.json`; unknown question keys are kept in `extra`, not rejected. `source` accepts any object, so the engine writes `source.locator`. | G2.fields_consumed reads `extra`; `passthrough` declares intended ones (`title`). |
| O2 | Content is Markdown + LaTeX rendered by `marked` (GFM) and Temml to MathML (`src/client/render.ts`); raw HTML inside Markdown is allowed and shown in a sandboxed frame. Whether `<u>`, `<s>`, `<mark>` survive the frame unchanged is **not yet verified**. | `formatting: preserve` writes those tags; confirm in the app before relying on underline. |
| O3 | The reader repairs JSON-damaged LaTeX escapes, trailing commas and control characters (`parse.ts`). | G2.repairs reports the count; 0 on all seven papers. |
| O4 | Questions are shown in a sandboxed `srcdoc` frame with a CSP blocking outside calls (`views.tsx`); images are inlined as `data:` URIs. | G4.svg renders packaged figures as `data:` images, the same path. |
| O5 | `attempt.question_version_id` is NOT NULL: attempts point at a version, so changing a question makes a new version and old attempts keep their meaning. | G6.history (not built) should list changed questions with attempts. |
| O6 | The importer commits in batches of at most 150 questions or 850 KB, **each batch** all-or-nothing (`importer.ts`); finished questions are recognised on re-run. | The README's "all-or-nothing" is per batch. S7 recovery = re-run. |
| O7 | Not determined. | — |
| O8 | `fidelity.py` was not reused: the checker is new code, so R8 holds without argument. | — |
| O9 | `import_live.mjs` has a dry-run mode (read + server preview, writes nothing). | G6 can be built on it. |
| O10 | Yes: `src/shared/qpack` bundles and runs in Node. | G2 uses it directly. |
| O11 | The fingerprint covers type, stem, options, parts, hints (and pack CSS); answers, solutions, topics and difficulty are excluded (`docs/question-format.md`). | A correction to question text creates a new version; to an answer or solution it does not. |
| O12 | `common.py` writes `json.dumps(indent=2, ensure_ascii=False)`, unsorted keys, no timestamps. | Replaced by the canonical writer. |
| O13 | `validate.mjs` loops over `ingest/packs/` and exits 1 on any hard failure. | G2 calls the same reader functions on one pack instead of wrapping the script (deviation from "wrap unmodified"). |
| O14 | `verify_live.mjs` reads D1 through the Cloudflare API, not through a browser session; the app itself is currently public. | S8 display verification can open the live app without login while it stays public. |
| O15 | The old grammar converter executed the page's array code in a VM. The engine reads the arrays with a literal-only parser, so a page can no longer run code during conversion. | Grammar fits the profile model (`grammar-json`). |

## 5. Not built yet, in the order I would build it

1. **G6 library impact + live stages S6–S9** (preflight, import with restore point, read-back, ledger, `trace`), built on the existing `*_live.mjs` scripts and the answers above. Until then, import with the Import screen after `preflight_live.mjs`.
2. **G4 rendered comparison** (G4.text, G4.formatting, G4.formula_equiv): generalise `review_rendered.mjs` from the seven papers to any run. Today line breaks and emphasis are checked by the reviewer.
3. **CI**: run `npm run ingest:test` and the seven-paper corridor on every push.
4. **Adapters in a child process** with time and memory caps (R13).
5. Double transcription for scans (two independent transcriptions diffed automatically), and an optional OCR engine as one of the two.
6. Answer-file join (two sources), delta review, mutation harness.
