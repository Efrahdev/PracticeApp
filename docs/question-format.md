# Question pack format (`practice-app/question-pack@1`)

The Practice App imports **one** format: a *question pack*. Every source — HTML problem sets, PDFs, Word files, scans, notes — is first converted into a pack by any AI model, then uploaded. The app never guesses at a source's layout; it only reads packs.

| File | What it is |
| --- | --- |
| [`ai-prompt.md`](ai-prompt.md) | The conversion prompt to give an AI model (the app's **Import → Copy AI prompt** adds your current subjects, topics and difficulty labels to it). |
| [`question-pack.schema.json`](question-pack.schema.json) | The formal JSON Schema (draft 2020-12). Use it with AI tools that accept a schema for structured output. |
| [`examples/fractions-pack.json`](examples/fractions-pack.json) | JSON example: multi-part with a figure, numeric, multiple choice, open "show that". |
| [`examples/mixed-pack.yaml`](examples/mixed-pack.yaml) | YAML example: units and tolerance, short answers, choose-all-that-apply, an AI-written solution. |

## The pipeline

```
source (HTML / PDF / Word / photo)
   │  any AI model + ai-prompt.md
   ▼
question pack (.json / .yaml, or a .zip with image files)
   │  Import screen — runs in your browser
   │   1. read: strip chat text and ``` fences, repair LaTeX backslashes, forgive trailing commas
   │   2. normalise: aliases, loose shapes and missing types → one strict shape; errors and warnings per question
   │   3. resolve images (inline SVG, base64, data: URIs or files in the zip) and fingerprint everything
   │   4. preview: the library says new / changed (new version) / already there
   │   5. review: map subjects and difficulty labels, preview each question and solution, include or skip
   ▼
Worker: upload files by fingerprint → commit in batches (each batch all-or-nothing)
   ▼
R2: the original pack file, each question's content record (JSON), each image
D1: question, version, topics, difficulty, marks, custom fields, answer key, solution
```

## Shape

```json
{
  "format": "practice-app/question-pack@1",
  "pack":   { "id": "olympiad-fractions-2", "title": "…", "source": "…", "subject": "Maths",
              "topics": ["Number > Fractions"], "difficulty": "Challenge", "fields": { "Collection": "…" },
              "solutions_origin": "source", "css": "…" },
  "assets": { "fig1": { "type": "image/svg+xml", "data": "<svg …>" } },
  "questions": [ { "id": "q1", "number": "1", "stem": "…", "answer": …, "solution": …, … } ]
}
```

Only `questions` is required, and each question only needs a `stem` (or `parts`). A bare list of questions, a single question, or pack facts at the top level are also accepted.

### Question fields

| Field | Notes |
| --- | --- |
| `id` | Unique within the pack, stable across conversions (`"q12"`). Together with `pack.id` it forms the question's permanent reference. |
| `number` | As printed. |
| `type` | `mcq_single`, `mcq_multi`, `numeric`, `short_answer`, `open`, `multi_part`. Optional — inferred: parts → multi-part; options → multiple choice (several correct → choose-all); numeric answer → numeric; short one-line answer → short answer; otherwise open. Common synonyms (`multiple_choice`, `checkbox`, `essay`, `proof`, …) are understood. |
| `stem` | Markdown + LaTeX, or `{"html": "…"}`. |
| `options` | `["…", "…"]` (labels A, B, C… added; a leading `A)` / `(A)` is read as the label), `[{"label": "A", "text": "…", "correct": true}]`, or `{"A": "…", "B": "…"}`. |
| `answer` | See below. Aliases: `correct_answer`, `answer_key`, `correct`, `a`. |
| `solution` | Markdown, or `{"answer", "steps": […], "explanation", "origin"}`. Aliases: `worked_solution`, `working`, `workings`, `method`, `mark_scheme`; `explanation` and `steps` may also sit on the question. |
| `parts` | `[{"label": "a", "stem", "type", "options", "answer", "solution", "marks", "hints"}]`. Labels default to a, b, c… (or i, ii, iii… when the first label is roman). |
| `hints` | List of Markdown hints (shown folded in the question box). |
| `subject`, `topics`, `difficulty` | Override the pack defaults. Topics are paths: `"Number > Fractions > Equivalent fractions"` (also `›`, `»`, `→`), or `{"name": "…", "weight": 0.5}`. |
| `marks` | Number. For multi-part questions without `marks`, the parts' marks are added up. |
| `tags` | Stored in the custom field **Tags**. |
| `fields` | `{"Exam board": "AQA", "Year": 2023, "Calculator": false, "Sat": "2024-06-11"}` → custom fields (text / number / yes-no / date), created when missing and filterable. |
| `source`, `notes` | Provenance and notes. |
| anything else | Kept unchanged in the stored record (`extra`), never rejected. |

### Answers

| Type | Accepted forms |
| --- | --- |
| multiple choice | `"C"`, `["A","C"]`, `"A, C"`, `"A and C"`, `"AC"`, the option text itself, `{"options": […]}`, `"correct": true` on options. A 1-based number is read as a position when labels are letters (with a warning). |
| numeric | `28`, `"5/8"`, `"1 1/2"`, `"½"`, `"\frac{5}{8}"`, `"62.5%"`, `"3.2 cm"`, `"£12.50"`, `"1.2 × 10^3"`, `"x = 4"`, `"5 ± 0.1"`, `{"value": 3.2, "unit": "cm", "tolerance": 0.05}` |
| short answer | `"newton"` or `["newton", "N"]` (shown after grading; marked by you) |
| open | Markdown final result (optional) |

Only verified multiple-choice and numeric keys mark you automatically. Numeric answers typed while practising can be decimals, fractions or mixed numbers.

### Solutions

Each question gets **one solution document**, composed from the pack: the final answer (the source's own wording wins, e.g. "28 students"), numbered working steps, then any explanation — part by part for multi-part questions:

```
**(a)** **Answer:** 5/8
**(b)** **Answer:** 3/8

There are $8 - 5 = 3$ unshaded parts, so $\frac{3}{8}$.
```

Solutions (and answer keys) are *metadata*: editable in the app, every change logged, old versions kept. Solutions marked `"origin": "ai"` (or `pack.solutions_origin: "ai"`) are stored as **Unverified (AI)**: shown with a badge, never used for automatic marking, until you press **Verify**.

### Content: Markdown + LaTeX

- CommonMark + GitHub tables. Raw HTML inside Markdown is allowed; for a whole block of HTML use `{"html": "…"}` (blank lines in it are fine there).
- Maths: `$…$` inline, `$$…$$` display; `\(…\)` and `\[…\]` also work. `$5 and $10` stays money (an opening `$` followed by a space, or a closing `$` followed by a digit, is not maths). Write a literal dollar as `\$`.
- Maths is rendered to MathML by Temml, drawn natively by the browser; invalid LaTeX is shown in red and listed as a warning during review.
- Images: `![description](asset:NAME)` → `assets.NAME`; a relative path (`images/q3.png`) → that file in the uploaded zip. Web links never load (the question box makes no outside calls) and are flagged.

### Assets

`assets` maps a name to `{"type", "data"}` (text, e.g. SVG), `{"type", "base64"}`, `{"file": "images/x.png"}` (inside the zip), a `data:` URI, or inline `<svg>…</svg>`. Every image is stored once, under its SHA-256 fingerprint. A referenced image that cannot be found is recorded as missing (the integrity check lists it) and drawn as a placeholder.

## Identity, versions and duplicates

| Situation | What happens |
| --- | --- |
| Same **content** already in the library (any pack, any number) | *Already in library* — nothing is added. If "update solutions" is ticked, a changed solution or answer key from the pack is added as a new version of that metadata; solutions or keys **you edited yourself are never overwritten**. |
| Same **reference** (`pack.id` + `id`), changed content | *New version* of the same question; old attempts stay linked to the version they used. The review shows old and new side by side and lets you import it as a separate question instead. |
| Neither | *New* question with a permanent ID. |

*Content* (the fingerprint) means the question's type, stem, options, parts and hints, plus any pack CSS used by HTML content — whitespace-insensitive. Numbering, source, topics, difficulty, marks, answers and solutions are not part of it, so fixing a solution never creates a duplicate question.

## What the reader forgives (and reports)

- Chat text or ``` fences around the payload.
- **LaTeX damaged by escaping**: `"\frac"` read by JSON as form-feed + `rac`, `"\times"` as tab + `imes`, `"\beta"`, `"\right"`, `"\neq"` in inline maths, and invalid escapes such as `"\sqrt"` — all restored, with a count shown in the review.
- Raw line breaks inside JSON strings, trailing commas, `//` and `/* */` comments.
- YAML: in block scalars (`|`) backslashes need no escaping at all — the most robust choice for maths-heavy packs.
- Duplicate ids within a pack (renamed with a warning), unknown types (inferred), option label clashes (relabelled), topic weights given as percentages.

Errors (the question cannot be imported) are rare: an entry that is not a question, or a question with no text at all. Everything else is a warning, and the question can still be imported.

## Limits

A pack can hold any number of questions. The importer commits in batches of up to 150 questions (each batch all-or-nothing); re-running an interrupted import is safe because finished questions are recognised as already in the library. AI models produce the best packs in batches of about 25 questions.
