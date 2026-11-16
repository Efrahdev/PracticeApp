# Step 1 report — conversion of the 7 new papers

Date: 2026-11-16 · Source commit: `dcd4873` (main) · Output: [`packs/`](packs/) · **Nothing was written to the live database or R2.**

## Result

| Pack file | Source | Questions | Types | Answer key | Solutions | Figures |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| `class5-calendar-sums.json` | `Class_5_Calendar_Sums.docx` | 20 | open ×20 | 0 | 0 | – |
| `class5-critical-thinking-calendar-sums.json` | `Class_5_Critical_Thinking_Calendar_Sums.docx` | 20 | open ×20 | 0 | 0 | – |
| `equally-spaced-objects-word-problems.json` | `Equally_Spaced_Objects_Word_Problems.docx` | 20 | open ×20 | 0 | 0 | – |
| `advanced-critical-thinking-math-worksheet.json` | `advanced_critical_thinking_math_worksheet.docx` | 20 | open ×20 | 0 | 0 | – |
| `geometry-olympiad-achiever-100.json` | `Geometry_Olympiad_Achiever_100_Questions.html` | 100 | multi-part ×69 (151 parts), numeric ×21, open ×10 | 21 | 100 | 102 SVG |
| `unitary-method-olympiad-course.json` | `UNITARY METHOD.html` | 140 | multi-part ×96 (271 parts), open ×44 | 0 | 140 | – |
| `grammar-midterm-mastery-assessment.json` | `grammar_midterm_mastery_assessment.html` | 180 | mcq_single ×101, mcq_multi ×37, short_answer ×29, open ×13 | 167 | 180 | – |
| **Total** | | **500** | | | | |

Question counts match the sources' own totals (20/20/20/20, "100 problems", "140 problems" in 8 levels of 15/15/15/20/20/20/25/10, 180 JSON objects).

## Verification performed (all passing)

1. **App's own reader** (`src/shared/qpack` parse + normalise) and the published **JSON Schema**: 7/7 schema-valid, **0 errors, 0 warnings**, 0 LaTeX/JSON repairs needed, 0 duplicate refs, 0 missing/unused assets, 0 duplicate content across the packs. → `validation-report.json`
2. **Independent fidelity diff** (`fidelity.py`): the source text is re-extracted by a *different* code path (raw docx XML; a plain DOM text walk; a separately-evaluated copy of the page's JS data) and token-diffed against each pack per question, in segments (question text, figure caption, final answer, worked solution, hint). A question passes only if **no source token is missing/changed** and every added token is a structural mark (list number, table pipe, `—` separator, `(a)` label). 500/500 pass. Checker was mutation-tested: a changed word, a changed digit, a dropped half-solution and a flipped MCQ key were each detected. → `fidelity-report.json`
3. **Figures**: the 102 SVGs are byte-identical to the source markup apart from one added `<style>` block (the app shows SVG assets as `<img>`, where the page stylesheet does not apply). Rendered side by side with the source page: all 102 match (error ≤ 2.6; the same figures without the style block score 100–165).
4. **Real renderer** (`render_check.mjs`): 2,923 pieces (stems, options, parts, hints, composed solutions) through the app's marked + Temml pipeline: 1,393 maths expressions, 103 images, 744 block quotes — no LaTeX errors, no leftover escape/Markdown characters, no stray `$`.
5. **Live library overlap** (read-only): none of the 500 exist yet (by `pack.id/question id`; by content for the 6 packs without images).

## Step 2 review (Opus) — deltas found and fixed

A second, independent comparison was added: [`review_rendered.mjs`](review_rendered.mjs). Every piece of every pack is rendered with the
app's real renderer and compared **character by character** (bold/italic kept as markers, non-breaking spaces significant) with what the
source page itself shows in Chromium. For grammar, the comparison is with the questions as the page renders them. For Word files, it is with the raw paragraph text. It found three real deltas that the token-level
check could not see. All three are fixed in the converters, and the packs were regenerated:

| # | Where | Delta | Fix |
| --- | --- | --- | --- |
| 1 | Grammar q081 (explanation + correct answer) | `[admires Sam]` / `[trust Maya]` rendered as maths italics with the brackets and space gone: the converter escaped `[` as `\[`, which the app's renderer reads as a display-maths delimiter | `[` `]` no longer backslash-escaped (a `]` that would close a Markdown link is written `&#93;`) — all converters |
| 2 | Grammar q151, q180 (prompt) | the page shows prompts with `white-space: pre-line`; the line break before the quoted passage was collapsed to a space | newlines in prompts become Markdown hard breaks |
| 3 | Geometry, 51 "Calculation" lines | the page shows them with `white-space: pre-wrap`, so double spaces (`48 cm  →  1 side`) are visible; they were collapsed | extra spaces kept as no-break spaces |

Not a delta: on multi-part Geometry "Final answer" lines, the `&nbsp;` gap between "(a) …" and "(b) …" disappears because each part now has its own answer.

After the fixes, the review gives **3,480 comparisons and 0 differences**. Each new check was mutation-tested: undoing fix 2 in q151 or fix 3 in one calculation line is flagged. All the earlier checks still pass.

## Judgement calls — please confirm or overrule before step 3

1. **No answers were invented.** The four Word worksheets have **no answer key at all** (the Critical-Thinking sheet says "No answer key provided"), so they carry no `answer`/`solution`; all 80 are type `open` (manual marking). You will need to add keys later.
2. **Difficulty mapping onto your 3 labels** (printed label always kept in custom field **Source difficulty**, so it is reversible with a bulk edit):
   * Geometry: Achiever→**Achiever** (50), *Advanced Achiever*→**Achiever** (25), Challenge→**Challenge** (25). ⚠ In that page "Achiever" is the *easiest* of its three levels, whereas in your library Achiever is the hardest — I used exact names; say if you would rather map Achiever→Foundation etc.
   * Unitary (printed 1–4): Foundation→**Foundation** (8), Core→**Foundation** (57), Challenge→**Challenge** (58), Olympiad→**Achiever** (17). Core→Foundation was a coin-flip; Core→Challenge is the alternative. Printed number also in **Difficulty rating**.
   * Grammar: FOUNDATION→**Foundation** (31); INTERMEDIATE, CHALLENGE→**Challenge** (87); TRAP, MASTERY→**Achiever** (62).
   * Word worksheets: no printed difficulty → none set.
3. **Topic paths** (new unless noted; existing top-level concepts reused where they fit): `Everyday Mathematics > Calendar and Dates`, `Critical Thinking > Calendar and Dates`, `Mathematical Reasoning > Equally Spaced Objects`, `Critical Thinking > Multi-step Word Problems`, `Geometry > <set title>` (5 sets), `Unitary Method > <level name>` (8 levels), `Grammar > Nouns|Pronouns|Adjectives and Determiners|Final Mixed Challenge > <section> > <source topic>` (under existing English > Grammar; 65 paths). These are my groupings, not printed in the sources (except sets, levels, sections, topics, which are).
4. **Custom fields**: reused `Class` (=5 for the two "Class 5" sheets), `Level`, `Section`, `Set`, `Difficulty rating`, `Cognitive skill`, `Skill focus`, `Task type`. **New:** `Source difficulty` (text) and `Tags` (grammar's two rule/trap tags). Types match your existing fields (numbers for Class/Level/Difficulty rating).
5. **Geometry numeric keys**: 21 single-answer questions whose printed final answer is exactly "number + unit" (e.g. `49 cm²`) are typed `numeric {value, unit}` and will auto-mark; the 10 composite answers ("Length 8 cm, width 6 cm") are `open`. All 69 multi-part questions are split into parts, each part's answer cut from the "Final answer" line by its (a)/(b)/(c) label (label sequence verified equal to the question's).
6. **Unitary answers are not split per part**: the source packs several parts into one list item (e.g. 1.9: `<li>30 km. (b) 12.5 cm. (c) … (d) …</li>`), so the full final answer is kept at question level (`solution.answer`) and the parts carry stems only. All 140 are `open`/`multi_part` with no auto-marking key. The page's "nudge" is imported as a hint; "Thinking skills in this problem" went to **Cognitive skill**.
7. **Grammar**: authored fields only; the page's computed `auditDifficulty`/`cognitiveDemand` were *not* imported. `input` questions → `short_answer` with the accepted answers as given; explanations kept in full under the page's own headings (Core rule, Why it works here, …). The 7 "review sheets", section intros and debriefs are teaching text, not questions — not imported.
8. **Source typos kept word for word** (golden rule 1), e.g. "9 **benchs**" (Equally spaced Q3), "16 **torchs**" (Q11).
9. **Printed numbering**: Word sheets double-numbered ("1. 1. …"): only the number is stripped from the stem. The Critical-Thinking sheet's instruction line is attached to each question as `notes`, not put in the stem.
10. **Text escaping**: plain text characters meaningful to Markdown/LaTeX (`_ * $ \ < > | ~ &`) are backslash-escaped (brackets are not, see review fix 1), e.g. the grammar blank `___` is stored as `\_\_\_` and renders as a blank line. Maths is LaTeX only where the source shows a fraction/mixed number (`$\frac{3}{4}$`, `$2\frac{1}{2}$`).
11. Unitary "working" lines (calculation | meaning) are stored as block-quote lines `calculation — *meaning*`.

## Suggested spot-checks for the reviewer (highest risk first)

| Source | Where to look | Why |
| --- | --- | --- |
| Geometry | Q33 (3 parts + figure), Q39 (two figures + caption), Q78 (figure inside the solution), Q31 (bullet list in stem), Q5 (caption) | structure variants |
| Geometry | Q1, Q21, Q23, Q65 | numeric key vs composite answers |
| Unitary | 1.9, 2.8, 4.18 (answers packed in one list item); 3.10, 4.6, 4.11 (tables); 2.1, 2.4, 6.x (fractions/mixed numbers); 3.10 (8 parts) | answer layout, tables, maths |
| Grammar | q001 (multi-select key), q004/q008 (blanks, accepted answers), q018/q042 (open, model answer), a few from Final Mixed Challenge | key mapping value→letter |
| Word | Equally spaced Q3, Q11 (typos), Critical-Thinking Q1–Q20 (special spaces/hyphens kept as printed) | verbatim text |

Everything is regenerated by the scripts in this folder; if the reviewer finds a systematic issue, fix the converter and re-run rather than editing pack JSON by hand.
