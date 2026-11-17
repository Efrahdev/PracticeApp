# Question ingestion tools

Deterministic converters that turn source papers into question packs
(`practice-app/question-pack@1`, see `docs/question-format.md`). No AI is used:
words come from the source's own text, and anything that is not plain running
text (figures, picture options, stacked fractions, tables) is cut out of the
rendered page as an image, so it is reproduced exactly as printed.

| Tool | Source | Use |
| --- | --- | --- |
| `pdfpack.py` | Digital PDF (has a text layer) | `python3 pdfpack.py build profiles/<book>.json <book.pdf> <out>` |
| `htmlpack.py` | Structured HTML with inline SVG | `python3 htmlpack.py <page.html> <out>` |
| `tensepack.py` | Text-only PDF with a labelled answer key | `python3 tensepack.py <paper.pdf> <out>` |
| `validate.mjs` | Any pack | `node tools/ingest/validate.mjs <out>/*.zip` (runs the app's own reader) |
| `import.mjs` | Any pack | `node tools/ingest/import.mjs --url <app url> [--dry-run] <out>/*.zip` |

Needs Python 3 with `pip install pymupdf pillow`, and `npm install` in the repo root.

## How `pdfpack.py` works

1. **Profile.** `profiles/<book>.json` describes one book layout: page ranges of
   each paper, how a question number looks, how option labels look, where the
   answers / explanations are. The code is the same for every book.
2. **Segment.** Question numbers, section banners, shared directions and paper
   headings are found from text positions; each question owns the page area up
   to the next marker.
3. **Split.** Inside a question the option labels (A–D) define the option cells.
   Plain text becomes Markdown; figures, picture options and stacked maths are
   cropped from the page at 216 dpi.
4. **Prove or fall back.** If the split cannot be proven clean (an option is
   empty, crops overlap, text belongs to no option) the question is kept as one
   exact picture of the printed question with A–D buttons. Nothing is guessed.
5. **Report.** Every paper gets `report.html`: the original crop beside the
   rebuilt question, the answer highlighted, and a note on every fallback.

`python3 pdfpack.py dump <pdf> <page>` prints what the engine sees on a page
(text lines with position, size and font; figure boxes) — use it to write a
profile for a new layout.

Import through the app's Import page (upload the zip) or with `import.mjs`.
`import.mjs` refuses non-local URLs unless `INGEST_ALLOW_REMOTE=1` is set.

## More converters

| Tool | Source | Use |
| --- | --- | --- |
| `fractions2pack.py` | Problem-set HTML with a final-answer key | `python3 -I tools/ingest/fractions2pack.py <page.html> <out>` |
| `prepositionpack.py` | "Diagnostic Assessment" PDF (numbered questions + "Answer Key and Reasoning") | `python3 -I tools/ingest/prepositionpack.py <paper.pdf> <out>` |
| `workbookpack.py` | Workbook PDF, 1-3 columns, no options, no key | `python3 -I tools/ingest/workbookpack.py profiles/<book>.json <book.pdf> <out>` |

| `geometrypack.py` | "Geometry Olympiad" HTML (articles with SVG figures, answer lines, hidden solution) | `python3 -I tools/ingest/geometrypack.py <book.html> <out>` |

`tensepack.py` takes optional `--id <pack-id> --title <title>` when several papers share one PDF title.

`workbookpack.py`: each question is cut out as an exact picture. A crop holds every printed object whose
top-left lies in the question's cell (so long lines and puzzles are never cut), with cell boundaries placed in
blank strips. Answer-box labels in the right margin and page footers are left out. Group instructions
("PRACTICE | Round each number below ...") are shown as text above every question they govern.

## Profile options added to `pdfpack.py`

| Option | Where | Effect |
| --- | --- | --- |
| `group_any_regex` | question | also accept these direction headings when they are not inside a box |
| `picture_cut` | question | regexes for page furniture where a whole-question picture stops (only if nothing but furniture follows) |
| `extend_last` | paper.question | last question may continue to the paper's last page (its answer is printed there) |
| `band` | paper.question | per-paper content band (pages of a different height) |
| `picture_questions` | paper | reviewed: keep these question numbers as the printed picture |
| `trim_options` | paper | reviewed: `{"18": {"D": "200 litres"}}` drop a stray fragment; must be a prefix of the source text |
| `drop_stem_figures` | paper | reviewed: remove a stray decoration picked up as the stem figure |

Automatic: a question whose stem has small pictures printed inside a line of text is kept as the printed picture,
and answers printed as "Sol. (B)" or on the "Sol:" row are read.

## Audit

`bash tools/ingest/audit/run_all.sh` re-checks every pack in `ingest-out/` against its source with independent parsers.

## geometrypack.py notes

- Diagrams are inline SVGs styled by the page's CSS. The app shows figures as stand-alone images, so the CSS rules each diagram uses are copied into the SVG (checked: every element of all 100 diagrams has the same computed style as on the page).
- The book's levels are Achiever < Advanced Achiever < Challenge. The app's are Foundation < Challenge < Achiever, so they are mapped by rank (Achiever -> Foundation, Advanced Achiever -> Challenge, Challenge -> Achiever); the printed level is kept in the field "Printed level".
- One answer line + a bare number and unit as the final answer -> numeric (the app can mark it). Everything else is "open": the printed final answer is kept (the app shows it at the top of the solution).
