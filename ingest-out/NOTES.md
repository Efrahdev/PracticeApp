# Ingestion run notes (for reviewer)

Built with tools/ingest per its README, no code changes. All packs validate (`validate.mjs`).
Not imported to Cloudflare. Each pack folder also has report.html for visual review.

## Built (42 packs, all RESULT: OK)
- Fractions 1 -> html/olympiad-fractions-master-set (Fractions 2 FAILED, see below)
- Verb tenses diagnostic -> tense1/ (200 q); TENSE PRACTICE 2 -> tense2/ (100 q)
- SOF IEO 5yr e-book (12 packs), SOF IMO 5yr e-book (12 packs), IMO Level 2 (3 packs, 0 solutions in source)
- UIMO 8 papers (8 packs)

- Fractions 2 -> html/olympiad-fractions-master-set-2 (240 q; answers only, no worked solutions)
- Prepositions diagnostic -> prep/prepositions-diagnostic-assessment (200 q, all with answers + solutions)
- APOS Grade4 (Beast Academy 4D workbook) -> apos/ (Fractions 163 q, Decimals 180 q; each question is an exact picture, type open, no answer key exists in the source)

## New tool code (needed because the README tools could not read these layouts)
- tools/ingest/fractions2pack.py - Fractions 2 HTML layout (reuses htmlpack engine)
- tools/ingest/prepositionpack.py - Prepositions PDF layout
- tools/ingest/workbookpack.py + profiles/apos-grade4.json - mixed-column workbook PDFs
Existing tools (htmlpack, tensepack, pdfpack) are unchanged.

## Decisions / notes
- TENSE PRACTICE 1.pdf is byte-identical to Verb_Tenses_Diagnostic_Assessment.pdf, so it is the same pack (tense1/).
- TENSE PRACTICE 2 (tense2/) has the SAME pack id as the diagnostic but different content (100 vs 200 q). Importing both overwrites one with the other. Give it a distinct id before import.
- Fractions 2 has its own id (-set-2), so it will not overwrite the existing Fractions pack.
- Numeric answers in Fractions 2 are only typed numeric when they are a bare number/fraction; the rest are short_answer (marked by the learner).

## FLAGGED - review last, after the clean packs are imported
1. APOS Fractions: Q28 and Q31 have no printed number marker (probably inside the picture of the question above). Q149 is glued to Q148 (one picture holds both). Page 28 (Fraction Fill explainer) is attached to Q148 as an extra picture. Pack has 163 of 166.
2. UIMO set-01: 7 flagged questions, 43 of 50 answers, 45 solutions.
3. UIMO um9000, um9009, um9246, um9254, um9257, um9259: log "solutions: unexpected number 6 on page N".
4. IMO 2025-26 set-a: 1 flagged question.
5. IEO older sets and model tests: fewer solutions than questions (the book has none). IMO Level 2: no solutions in the source.
6. APOS is a commercial workbook (Beast Academy / AoPS); confirm you are happy to ingest it.
Per-pack detail: report.html in each pack folder; APOS list also in apos/FLAGGED.md.
