# Ingestion run notes (for reviewer)

Built with tools/ingest per its README, no code changes. All packs validate (`validate.mjs`).
Not imported to Cloudflare. Each pack folder also has report.html for visual review.

## Built (38 packs, all RESULT: OK)
- Fractions 1 -> html/olympiad-fractions-master-set (Fractions 2 FAILED, see below)
- Verb tenses diagnostic -> tense1/ (200 q); TENSE PRACTICE 2 -> tense2/ (100 q)
- SOF IEO 5yr e-book (12 packs), SOF IMO 5yr e-book (12 packs), IMO Level 2 (3 packs, 0 solutions in source)
- UIMO 8 papers (8 packs)

## Issues for reviewer
1. Claude Fractions 2.html: htmlpack aborted, 240 questions found but 0 solutions; nothing written. Needs a tool fix.
2. Prepositions_Diagnostic_Assessment.pdf: tensepack cannot find the 'Question Paper' / 'Answer Key and Reasoning' headings; nothing written.
3. TENSE PRACTICE 1.pdf is byte-identical to Verb_Tenses_Diagnostic_Assessment.pdf (same pack). Skipped as duplicate.
4. TENSE PRACTICE 2 produces the SAME pack id/key (verb-tenses-diagnostic-assessment) as the diagnostic but different content (100 vs 200 q). Importing both would make one overwrite the other; needs a distinct id.
5. APOS Grade4.pdf: no profile exists, not processed.
6. UIMO: set-01 has 7 flagged questions and only 43 answers/45 solutions of 50; several packs log "solutions: unexpected number 6 on page N". IMO 2025-26 set-a has 1 flagged. IEO older sets and model tests have fewer solutions than questions (source).
