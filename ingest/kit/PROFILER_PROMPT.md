# Document profiling task

You are profiling a source document so that a **deterministic program, with no AI in it**, can turn it into a
question pack for a practice app. You do not convert any questions yourself. You write a *profile* (how this
layout is built) and a *job* (facts about this one paper). The program then does the conversion and proves,
check by check, that nothing was lost, changed or invented.

Source file(s): {{SOURCE_FILES}}

You are given: (1) the profile language reference, (2) worked examples that already pass every check, and
(3) a probe report — facts about the source that a program measured. For PDFs, scans, screenshots and office
documents, **page images are attached**: text lines are drawn in blue, figures in orange and ink bands in green,
each figure and band labelled with its unit id, with a ruler of page-height fractions on the left. Use the
images to see the layout; use the probe report's line listings for exact text and patterns. If the source file
is attached too, use it to confirm what the probe report shows.

**Choose the route the probe report names** (TEXT ROUTE, SCAN ROUTE or MIXED). For a scan, the job's `regions`
must list, for every question, the units of the question and of its solution, read from the images; if you
also read the answer letter off the page, give it as `answer` — it will be marked as transcribed and checked in
full by a person.

## Your output

Reply with **one YAML code block and nothing else inside it**: the profile, a line containing only `---`, then
the job. After the code block, add a short list headed **Assumptions** naming anything you inferred rather than
read in the probe report (for example: "the last paragraph of `.stmt` holds the parts only when it starts with
`(a)`"), and a list headed **Questions for the human** for anything you could not decide. Keep both short.

## Rules you must follow

1. **Never invent content.** Every learner-visible word in the pack must come from the source. If the source has
   no answers, write `answers: {expected: false}` and no answer fields. Do not write answers, hints or solutions.
2. **Account for every piece of text.** Each text block in the source must be claimed by a field or ignored by an
   `ignore` rule with a `reason`. The program stops on any unclaimed block. Page chrome (buttons, menus, cover
   pages, answer-sheet blanks, footers, screen-reader duplicates) is ignored *with a reason*, never silently.
3. **Ignore rules are narrow and limited.** Give each rule `max_blocks` and `max_tokens` (words) a little above
   what it should match — about 10% headroom. An ignore rule that swallows question content is the most dangerous
   mistake you can make: the program checks every rule against these limits. Use `expect:` when an ignored
   element always says the same thing (for example a "Final answer:" label).
4. **Use selectors, patterns and unit ids that the probe report shows exist.** Do not guess class names. Prefer the most
   specific stable selector (`article.q .solbody p.final`, not `p`).
5. **Regular expressions** are linear-time only: no backreferences (`\1`), no lookarounds (`(?=`, `(?<!`), no
   nested repetition such as `(a+)+`. One capture group returns the value.
6. **Stop rather than guess.** If a value cannot be split or classified exactly (for example answers for several
   parts packed into one line with irregular labels), keep it whole at question level. Never write a rule that
   might work most of the time.
7. **Mappings must be total.** Every value the source uses for difficulty (or any mapped field) must appear in the
   job's mapping, and no unused entries. Ask the human which library label each source level should map to if it
   is not obvious; put your best proposal in the job and list it under *Questions for the human*.
8. **Rare shapes matter.** The probe report's shape census marks shapes seen three times or fewer as RARE, and
   lists parts that appear in only some containers (`96/140`). Your profile must handle each one: mark such
   fields `optional: true` or give a `when:` condition. Explain any rare shape you are unsure about.
9. **Exact counts go in the job, not the profile.** The job's `expect` must state the number of questions and
   figures the paper really has (from the probe report or the document's own statement such as "100 problems").
   If you give `parts` or `types`, they must be exact too; leave them out if unsure.
10. **Assertions.** Give at least two hand-checkable assertions in the job (for example question 1's first words
    and question N's answer) taken word for word from the probe report's verbatim samples.
11. **Profile id and version.** Use lowercase-with-dashes ids. Set `author` to the name of your model and session,
    because a different person or session must review the result.
12. Only use keys from the reference. Unknown keys are rejected.

## What happens next (so you know what will be checked)

`ingest lint` rejects malformed profiles with line numbers. `ingest try` runs the conversion and shows every
unclaimed block grouped by page region, so the human can paste that back to you for a fix. `ingest run` then
runs six gates, including an *independent* re-reading of the source with a different parser that compares every
word and number. A human approves the result against planted errors before anything is imported.

---

# Profile language reference

{{PROFILE_REFERENCE}}

---

# Worked examples (these pass every check)

{{WORKED_EXAMPLES}}

---

# Probe report

{{PROBE_REPORT}}
