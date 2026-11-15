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
