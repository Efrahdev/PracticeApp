# Ingestion output - notes for reviewer

43 packs, 2,639 questions (42 packs / 2,539 questions are already live on Cloudflare; the Geometry pack below was imported on 2026-11-17 after review: 100 new, live integrity check 0 errors). All pass the app's own validator (`tools/ingest/validate.mjs`). Not yet imported to Cloudflare.
Each PDF pack folder has `report.html` (original crop beside the rebuilt question).

## Independent audit (re-run: `bash tools/ingest/audit/run_all.sh` from the repo root)
Every check re-reads the ORIGINAL source with its own simple parser, not the ingester's code.

| Check | Result |
| --- | --- |
| Answer keys, SOF IMO + IEO (24 papers, 840 q) vs printed solutions | 840/840 match; every solution block matched to its paper by printed year/set |
| Answer keys, IMO Level 2 (105 q) vs printed answer-key page | 105/105 |
| Answer keys, UIMO (400 q) vs printed key grid AND printed explanations | 400/400 on both sources (set-01: inline "Sol" answers) |
| Question page ranges vs printed paper headers | all 35 papers correct |
| English (Tenses x2, Prepositions, 500 q): stems, answers, every option text | 500/500 stems, all answers, 1,070/1,070 options |
| Fractions 1 (108 q): stems + worked solutions vs raw HTML | match (differences are spacing only) |
| Fractions 2 (240 q): answers + figures vs raw HTML | 240/240, 13/13 figures |
| SOF/UIMO text: every stem/option word present on the source page | yes (remaining hits are known false positives: passages starting 2 pages back; italic l in mL) |
| Options | every SOF/UIMO question has exactly A-D; every answer is one of its options |
| Leaked text (directions/passages/footers inside options) | none |
| Whole-question pictures (129) | each viewed; alt text from its own page |
| APOS (346 q) | numbering 1..N complete; every crop holds exactly its own question; no overlaps; all 346 viewed |

## Defects found by the audit and fixed
1. IEO 2021-24 + model tests: "FOR QUESTIONS n TO m" headings printed without a box were missed. Their text leaked into the last option of the previous question AND the following questions lost their instructions / reading passage (e.g. Q21-25 had no passage). Fixed (`group_any_regex`); 21 questions repaired.
2. Questions with small pictures inside a line of text ("If [shape][shape] = 18") came out as fragments. 24 questions now kept as the exact printed picture (automatic rule in pdfpack).
3. Stray fragments in options (page number, neighbour label): IMO 25-26 B Q18, UIMO 9254 Q34, UIMO 9257 Q23 trimmed (trim may only shorten the source text).
4. Scrambled layouts kept as printed picture: IMO 23-24 B Q18, IMO L2 12-13 Q24.
5. UIMO set-01 picture questions showed the top of the solution drawing: cut now above the whole "Sol:" row.
6. UIMO 9009 pages are taller: band extended so Q17 and Q26 are no longer cut off; footers trimmed from pictures.
7. UIMO 9000 Q20: stray page decoration removed.
8. APOS: margin answer-box labels were mistaken for question numbers on pages 1 and 7 (Q3, Q37-41 wrong); crops sliced stacked fractions, puzzles and long lines; group instructions ("Round each number below to the nearest tenth.") were sliced between crops. Rebuilt: crops follow each question's own content, and each group instruction is shown as text above every question it governs.
All answers of affected questions were re-verified (key + own working).

## Source defects (in the original files, not introduced by ingestion) - your decision
- APOS Decimals Q100-Q105 (page 49): the PDF itself says "[UNCLEAR: handwritten answer marks obscure part of the original statement]" - these six have no usable question text.
- APOS Decimals Q25-Q33 (pages 36-37): the PDF contains stray markup such as `over 10">` / `over 1,000">` inside the fraction expressions (29 occurrences). The picture shows exactly what is printed.


## Geometry Olympiad Achiever Lab 2 (Q101-200) - LIVE (imported 2026-11-17)
`ingest-out/geometry/geometry-olympiad-achiever-lab-2-q101-200.zip` (new id, so importing it only adds; nothing existing is touched).
Converter: `tools/ingest/geometrypack.py`. 100 questions, 100 diagrams, 100 full worked solutions; validator OK.
- Checked against the source HTML by an independent parser (`tools/ingest/audit/check_geometry.py`): all 100 question statements, final answers, full solution texts, SVG geometry, set membership and answer-part counts match; every set has 4 Achiever + 6 Advanced Achiever + 10 Challenge as the book says.
- Diagram styling: the page styles diagrams with CSS classes, which a stand-alone image loses, so each SVG carries the rules it uses. Checked in Chromium: all 1,549 elements of the 100 diagrams have the same computed style as on the page.
- Levels are mapped by rank because the book's names run the other way round from the app's (book "Challenge" is its hardest; the app's "Challenge" is the middle level): Achiever -> Foundation, Advanced Achiever -> Challenge, Challenge -> Achiever. The printed name is kept in the field "Printed level". If you prefer different labels, say so before import.
- 9 single-answer questions with a bare "number + unit" answer are numeric (the app can mark them); 91 are written answers (most have parts (a), (b), (c) and reasons), stored as open with the printed final answer at the top of the solution.
- The page's interactive parts (tick boxes, progress bar, print buttons, Name/Date fields) are not part of a question and are not included.

## Decisions
- TENSE PRACTICE 1.pdf is byte-identical to Verb_Tenses_Diagnostic_Assessment.pdf (same pack, tense1/).
- TENSE PRACTICE 2 has its own id `verb-tenses-mixed-mastery-100`; Fractions 2 has its own id (`-set-2`).
- No solution / no lesson is not a defect. APOS lesson and example blocks are not part of the packs (as requested).

## FLAGGED (under 70% confidence)
None.

### Geometry review before import (2026-11-17)
- Fidelity re-checked: 100/100 statements, answers, solutions, diagrams match the source.
- Correctness: every number in 98 final answers appears in its worked solution; Q111 and Q120 (examples, not results) were worked by hand and are correct; all 9 auto-marked numeric keys were solved independently and are correct.
- Live after import: 100 new questions, keys 40/42/44/48/64/96/117/144/150 cm|cm² stored, levels 20/30/50, app integrity check 0 errors.
