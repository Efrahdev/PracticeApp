## Two documents

A **profile** describes a *layout family* and is approved once (Gate A). A **job** describes *one paper* that
uses that layout: the file, exact counts, pack identity, mappings and hand-checked assertions. A new paper from
the same publisher is a new job with the same profile. Both are YAML; write the profile, `---`, then the job.

The formal schemas are `ingest/kit/profile.schema.json` and `ingest/kit/job.schema.json`. Unknown keys fail.

## Profile: top-level keys

| Key | Required | Meaning |
| --- | --- | --- |
| `profile` | yes | `{id, version, author, notes}`. `id` lowercase-with-dashes; `version` an integer ≥ 1. Any edit is a new version. |
| `source` | yes | `{kind, probes}`. `kind` — structured routes: `html` (questions are DOM elements), `html-json` (questions are JavaScript array literals in the page), `docx` (Word, one numbered paragraph per question, no tables/pictures/equations). Page routes (see **Page sources** below): `pdf` (a PDF with a text layer), `scan` (a scanned PDF, photos or screenshots: no text layer), `image` (images only), `office` (any Word, PowerPoint, Excel, OpenDocument, RTF, .doc or text file, printed to pages by LibreOffice), `html-print` (an HTML page printed to pages by the browser). `probes`: structural facts that must hold before anything runs (below). |
| `segment` | yes | How to cut the source into questions (below). |
| `vars` | no | Named values read once per question and used by templates (`{set_title}`) or `var:`. |
| `pack` | no | `{title: <extractor>}`: read the pack title from the source. Otherwise the job gives `pack.title`. |
| `content` | html only | `{engine: htmlmd@1, rules: [...], svg: {...}}`: how HTML becomes Markdown (below). |
| `formatting` | no | Policy for `underline`, `strike`, `highlight`: `{policy: preserve}` or `{policy: ignore, reason: "..."}`. If the source uses one of these and no policy exists, the run stops. Bold, italic, sub/superscript are always kept. |
| `parts` | no | How multi-part questions split into parts (below). |
| `fields` | yes | Pack field → extractor (below). |
| `defaults` | no | `{type: open | short_answer}` for questions with no parts and no numeric key. Default `open`. |
| `ignore` | yes | List of ignore rules (may be empty, must be present). |
| `passthrough` | no | `[{key, reason}]`: pack keys the app stores but does not use (for example `title`). Undeclared ones fail G2. |
| `answers` | yes | `{expected: true|false}`: does this layout carry answers? |
| `tripwires` | no | `{min_stem_chars, length_outlier_z, near_duplicate_similarity}`: thresholds for warnings only. |
| `hooks` | no | Must be empty: custom code is not accepted by this engine version. |
| `fixtures` | no | `[{source, expect}]` conformance examples (at least three recommended). |

## `source.probes`

Page sources also accept `{pages: true, min}` (pages read) and `{text_pages: true, min}` (pages with a text layer). Each probe is one of `{css: "selector", min, max}` (html), `{style: "regex", min, max}` (docx paragraph style
id), `{array: NAME, min, max}` (html-json), `{regex: "pattern", min, max}` (any text block). A failed probe
means "wrong profile for this file, or the file changed".

## `segment`

| Kind | Keys |
| --- | --- |
| html | `by: css_container@1`, `selector` (one element per question), `number: {from: "sel", regex: "..."}` or `{attr: data-x}`, `numbering` |
| docx | `by: numbered_paragraph@1`, `number: {regex: "^(\\d+)\\s*[.)]\\s+"}`, `numbering`, `continuation: fail | append` (what to do with an un-numbered paragraph after a question) |
| html-json | `by: json_array@1`, `arrays: [NAME, ...]`, `number: {key: id, regex: "..."}` or `{position: true}`, `numbering`, optional `order_by: {key, values: [...]}` (the page's display order) |

`numbering`: `sequential_from_1` (1..N with no gaps), `sectioned` (`1.1, 1.2, 2.1 ...`), or `unique` (no
duplicates, any order).

## Extractors (used by `fields`, `vars`, `pack.title`)

Where the value comes from — exactly one of:

| Key | Kinds | Meaning |
| --- | --- | --- |
| `from: "sel"` or `from: [sel, sel]` | html | Element(s) inside the question container. Must match exactly one element unless `each: true` or the list form. |
| `closest: "sel"` | html | First go up to this ancestor (for example the section a question sits in), then apply `from`. |
| `attr: name` | html | An attribute of the element (or of the container if no `from`). |
| `lookup: {json: "#script-id", list: key, where: {field: "{var}"}, get: key}` | html | A value from a `<script type="application/json">` block. |
| `key: dotted.path` | html-json | A key of the question object. |
| `paragraph: self` | docx | The question's own paragraph. With `strip_number: true` the printed number is removed. |
| `preamble: {index: 0, style: "Normal"}` | docx | A paragraph before the first question (after the title). Usually with `shared: true`. |
| `template: "Text {var}"` | all | Built from vars. `{number}`, `{qid}`, `{position}` and `{array}` always exist. `{number:03d}` pads. |
| `var: name` | all | A declared var. |
| `const: value` | all | A fixed value (use sparingly; prefer job `pack` defaults). |
| `compose: [{label, key, required, when_type}]` | html-json | Several keys joined into one document, each with a heading `label`. `join` sets the separator. |
| `by_type: {mcq_single: {...}, default: {...}}` | html-json | Choose the extractor by the question's type. |

How it is read:

| Key | Meaning |
| --- | --- |
| `as` | `text` (default for html: plain text, whitespace collapsed), `markdown` (html: full conversion keeping structure, emphasis, lists, tables, figures), `markdown_text` (html-json/docx: escaped text), `raw` (unchanged string or list), `int`, `number`. |
| `regex` | Take capture group 1 (or the whole match). No match stops the run. |
| `map` | Inline table `{From: To}` or the name of a job mapping (`map: difficulty` → `job.mappings.difficulty`). An unmapped value stops the run. |
| `exclude: [sel, ...]` | html: leave these elements out of a `markdown` field (they are claimed elsewhere). |
| `optional: true` | The field may be absent. Otherwise absence stops the run. |
| `shared: true` | The same source text may also feed another field (for example the final answer is both `answer` and `solution.answer`). Without it, a block claimed twice stops the run. |
| `each: true` | html: every match is a separate item (lists such as `hints`). |
| `when: no_parts | has_parts` | Only for questions without / with parts. Give a list of extractors for one field to cover both cases. |
| `when_key: {key, equals | not_equals}` | html-json: only when a key has (not) a value. |
| `newline: hard_break` | html-json: the page shows line breaks in this text (CSS `white-space: pre-line`). |
| `prefix: "Text: "` | docx preamble: text written before the value (it is not in the source; it is listed as added text). |
| `classify: number_unit_else_open@1`, `units: [cm², cm]` | Final answers that are exactly a number (plus a declared unit), and re-write to the same characters, become auto-marked numeric keys. Everything else stays an open answer. |
| `split_by_part_labels: "({label})"` | Cut one printed answer line into the parts' answers, by their labels. Each label must occur exactly once, in order, starting the line; otherwise the run stops. |
| `option_letter: true`, `sort: true` | html-json: an answer given as an option *value* becomes the option's letter (A, B, …); `sort` for several answers. |
| `list_of: [textKey, valueKey]` | html-json `options`: the keys of each option object. |

## Pack fields you can fill

`id` (default `q{number}`), `title`, `type`, `stem`, `options`, `answer`, `solution.answer`,
`solution.explanation`, `hints` (list), `notes`, `topics` (list of paths `"A > B > C"`), `difficulty`, `marks`,
`tags` (list), `fields.<Custom field name>`, `source.<anything>`. `number` comes from `segment`. `type` is set
automatically: `multi_part` when parts exist, `numeric` when the answer was classified numeric, otherwise
`defaults.type`. html-json may map its own `type` field to `mcq_single | mcq_multi | short_answer | open`.

## `content` (html)

`rules` give layout-specific handling to elements, matched by CSS selector:

| `do` | Keys | Result |
| --- | --- | --- |
| `frac` | `num`, `den` | A stacked fraction → `$\frac{n}{d}$`. Only numbers, decimals or one letter are accepted. |
| `mixed` | `frac` | Whole number plus a `frac` element → `$2\frac{1}{2}$`. |
| `bold_line` / `italic_line` | | The element's text as a bold / italic line (headings inside solutions, captions). |
| `list` | `keep_spaces` | A list; `keep_spaces: true` when the page preserves runs of spaces (CSS `pre-wrap`). |
| `quote_lines` | `line`, `main`, `note`, `sep` | Working lines as a block quote: `main — *note*`. |
| `unwrap` | | Ignore the wrapper element, keep its content. |
| `text` | | Inline text only. |

Elements the converter does not know (for example `<canvas>`, `<iframe>`, `<math>`) stop the run unless they are
ignored with a reason. `<ol type="a">` items are written with their (a), (b) labels, because the browser shows them.

`svg: {transform: svg_inline_page_styles@1, alt_attr: aria-label, extra_css, extra_css_reason}` packages each
inline `<svg>` figure byte for byte, adding one `<style>` block with the page rules that target it (the app shows
figures as images, where the page stylesheet does not apply). `extra_css` is for styling the figure inherits from
the page (for example its font) and needs a reason. Figures are never redrawn.

## `parts`

`{from: "sel", split: br | element, labels: from_regex | generated_alpha, label: "regex", optional: true}`.
`split: br` cuts one element at its `<br>` line breaks, each line starting with a label matched by `label`
(capture group 1 is the label). `split: element` takes one element per part (labels a, b, c… generated, as an
`<ol type="a">` shows them). Labels must run a, b, c… in order.

## `ignore` rules

`{css | style | regex | key | dom, reason, max_blocks, max_tokens, expect}`.

- `css`: html elements (and everything inside them). `style`: docx paragraph styles. `regex`: whole text blocks
  that match (applied last, only to blocks nothing claimed). `key`: html-json object keys (`explanation.extra`).
  `dom: all`: html-json only — the page shell around the data arrays.
- `max_blocks`, `max_tokens`: limits. Exceeding either stops the run. A rule that matches nothing is a warning.
- `expect`: the exact text the ignored element must have (whitespace collapsed).

## Page sources (pdf, scan, image, office, html-print)

Every page source is read as **units**: text lines (`p3.l7`), figures (`p3.g2`, found from the page's pixels),
ink bands on pages without text (`p3.u5`), and rotated text such as watermarks. The probe draws figures and bands
with their ids on the page images. Every unit must be claimed by a question or ignored with a reason.

**Every question keeps an exact picture of its region** (a crop of the page rendering). Its words are used as
text only when they can be trusted. G4.crops re-renders every picture with a different renderer and compares
pixels; G3 re-reads every word with a different PDF library (Poppler).

| Key | Meaning |
| --- | --- |
| `pages` | `{columns: 1 | 2 | 0.55, dpi: 150}`. `columns: 2` splits each page at the middle (or at the given fraction of the width) and reads the left column first. |
| `segment` | `by: lines@1` (text layer) with `start` (pattern of the line that begins a question; group 1 = printed number; it may swallow more, e.g. a repeated number), optional `heading` (pattern of a section heading line; groups become vars `heading_1`, `heading_2`; the lines under a heading up to the next question are its introduction and are not question text), optional `end` (pattern of the line after which the answer section starts), `numbering`. Or `by: units@1` (scans) — the job's `regions` list each question's units. |
| `display` | `auto` (default: text, but a picture when the question has a figure, picture options, unreliable characters such as symbol fonts or stacked fractions, or text placed beside it), `text`, or `image` (always pictures). |
| `options` | `{label: "\\(([A-D])\\)"}`: the option labels inside the question's text (several may share a line). The options are the last run of labels starting at the first letter and continuing in order; earlier label-like text stays in the stem. Empty options (pictures) make the question a picture. |
| `answers.inline` | `{start, answer}`: within a question, the solution starts at the first line matching `start`; `answer` (group 1) reads the answer from that line. The question's picture stops before the solution, so the answer is never shown with the question. |
| `answers.section` | `{entry, answer, answer_until, explanation, explanation_stop}`: after `segment.end`, each entry starts at `entry` (group 1 = question number), `answer` (group 1) is the answer, continuing over the next lines until a line matching `answer_until`; the lines after it are the explanation. Lines of the entry before the answer line (the question repeated) are ignored by a built-in rule. Entries are joined to questions by number; an entry for a question that does not exist stops the run. |
| `text.break_before` | Pattern of a line that starts a new line inside a paragraph. Default: bullets, (i)-style labels, and short labels such as `Why:`. Only line breaks are decided this way; every word is kept. |
| `keep_text` | For questions shown as pictures, also keep their words in this custom field (searchable). The words are always kept in `source.text`. |
| `fields` | Only metadata: `template`, `var`, `const`, `from: question_text` with `regex` (read from the question's first line). The engine fills stem, options, answer and solution itself. |
| `ignore` | Also `{pages: "1-3"}`, `{band: {top: 0.0, bottom: 0.08}}` (a unit lying wholly inside that strip of the page height), `{rotated: true}` (watermarks), `{regex}` (whole lines), `{units: [p2.g1]}`. Specks of ink too small to carry content are ignored by a built-in rule. |

Answers for multiple choice must name an existing option ("(B)", "B", "(A) takes", "(A) and (C)"); several letters make the question `mcq_multi`.

**Job keys for page sources**: `sources[0].pages: "4-40"` (the page range of this paper inside a bigger file), `pictures: ["33"]` (questions whose text cannot be trusted: shown as pictures; G3 tells you when), and for `units@1`:
`regions: [{number, units: "p3.u2-p3.u4", solution_units, options: "A-D", answer: "C", text}]`. A region's
`answer` and `text` are read off the page by whoever writes the job: they are marked *transcribed*, and Gate B
then requires `numerals_checked: full`.

## Job keys

| Key | Required | Meaning |
| --- | --- | --- |
| `job` | yes | `{id, profile: {id, version, sha256}}`. Add `sha256` (printed by `ingest lint`) once the profile is signed off. |
| `sources` | yes | `[{file, role: paper, sha256}]`, path relative to the job file. |
| `expect` | yes | `{questions, assets, parts, types}` — exact. Only `questions` is required. |
| `pack` | yes | `{id, title, source, subject, topics, difficulty, fields, solutions_origin}` — pack defaults. `title` only if the profile does not read it. |
| `mappings` | if used | Named value tables the profile refers to by `map: name`. Total: every source value, no extras. |
| `assertions` | yes | `[{question, stem_starts, stem_contains, answer, answer_contains, parts, type}]` hand-checked against the printed paper. `question` is the printed number. |
| `import` | no | `{mapping, expect: {new, new_versions, duplicates, rejected}}` for the live import step. |
| `review` | no | `{answers_verified_target: none | sampled | full}`. |
