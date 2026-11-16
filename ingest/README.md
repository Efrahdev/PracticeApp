# Ingestion — step 1 (convert) of 3

Pipeline agreed for the 7 papers added in commit `dcd4873`:

| Step | Who | What | Status |
| --- | --- | --- | --- |
| 1. Convert | Sonnet (high) | Turn each source into a **question pack** (`practice-app/question-pack@1`, see [`docs/question-format.md`](../docs/question-format.md)) with deterministic, re-runnable converters; validate with the app's own reader | **done** — packs in [`packs/`](packs/) |
| 2. Review | Opus (high) | Check every pack against the original source for fidelity | **done** — 3 deltas found and fixed, now 0 differences (see [`REPORT.md`](REPORT.md)) |
| 3. Ingest | another model | Import the reviewed packs into the live Cloudflare library | **not started — nothing has been written to D1 or R2** |

## Why converters instead of retyping

The sources are machine-generated (HTML pages with regular markup, a page whose questions are a JS array, Word files with plain numbered
paragraphs), so each pack is produced by a script that reads the source structure. No question text passes through a model's
memory, which removes transcription errors. Each converter asserts the structure it expects (counts, numbering 1..N, matching labels)
and stops with an error rather than guessing.

| Source | Converter | Questions |
| --- | --- | --- |
| `Class_5_Calendar_Sums.docx`, `Class_5_Critical_Thinking_Calendar_Sums.docx`, `Equally_Spaced_Objects_Word_Problems.docx`, `advanced_critical_thinking_math_worksheet.docx` | [`convert_docx.py`](convert_docx.py) | 4 × 20 |
| `Geometry_Olympiad_Achiever_100_Questions.html` | [`convert_geometry.py`](convert_geometry.py) | 100 (+102 SVG figures) |
| `UNITARY METHOD.html` | [`convert_unitary.py`](convert_unitary.py) | 140 |
| `grammar_midterm_mastery_assessment.html` | [`convert_grammar.mjs`](convert_grammar.mjs) | 180 |

Shared Markdown/escaping helpers: [`lib/common.py`](lib/common.py).

## Re-running everything

```bash
npm install                                   # once
python3 -I ingest/convert_docx.py
python3 -I ingest/convert_geometry.py
python3 -I ingest/convert_unitary.py
node ingest/convert_grammar.mjs

node ingest/validate.mjs                      # app's own parser + JSON Schema, per question  -> validation-report.json
python3 -I ingest/fidelity.py                 # independent token diff against the sources     -> fidelity-report.json
node ingest/review_rendered.mjs               # step-2 review: rendered pack vs rendered source, character by character
node ingest/render_check.mjs                  # every piece through the app's real renderer (marked + Temml)
node ingest/svg_render_check.mjs OUT_DIR && python3 -I ingest/svg_compare.py OUT_DIR   # 102 figures: source page vs packaged asset
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node ingest/preflight_live.mjs   # READ-ONLY overlap check with the live library
```

`svg_control.mjs` renders figures *without* their embedded styles, only to calibrate the figure comparison (broken ≈ 100–165, correct ≈ 0.7–2.6).

## For step 3 (ingest)

* Packs are plain files: `ingest/packs/*.json`. Import them with the app's **Import** screen (or the same Worker import endpoints it uses),
  one pack per import; the importer commits each pack all-or-nothing and keeps the original file byte-for-byte.
* `ingest/preflight_live.mjs` found **no** overlap with the 2,536 questions already in the library (by `pack.id/question id` or by content).
* Packs use existing subjects (`Maths`, `English`) and difficulty labels (`Foundation`, `Challenge`, `Achiever`). Topic paths and custom fields that
  do not exist yet are created by the importer — review the list in [`REPORT.md`](REPORT.md) first.
* Do the import only after the step-2 review is signed off and the open decisions in `REPORT.md` are settled — several of them change labels in the stored data.
