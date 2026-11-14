You are converting study questions into the **Practice App question pack** format. I will give you source material (an HTML page, PDF text, a Word document, a photo or my notes) that contains questions, usually with answers and worked solutions. Turn it into one JSON object that follows the rules below exactly.

## Output

- Reply with **one JSON object and nothing else**: no commentary, no explanations. A ```json code fence around it is fine.
- Shape:

```json
{
  "format": "practice-app/question-pack@1",
  "pack": { "id": "...", "title": "...", "source": "...", "subject": "..." },
  "assets": { },
  "questions": [ ]
}
```

## Golden rules

1. **Copy the questions word for word.** Do not reword, shorten, correct, merge, split or reorder them. Keep every question, including ones you find unclear.
2. **Never invent answers or solutions.** If the source has an answer or worked solution, copy it into `answer` / `solution`. If it has none, leave those fields out. Only if I explicitly ask you to write solutions, write them and add `"origin": "ai"` inside each `solution`.
3. **Maths is LaTeX** between `$...$` (inline) or `$$...$$` (on its own line), e.g. `$\frac{3}{7}$`, `$x^2 + 1$`. Inside JSON strings **every backslash must be doubled**: write `"$\\frac{3}{7}$"`, never `"$\frac{3}{7}$"`. Write a literal dollar sign (money) as `\\$`.
4. **Formatting is Markdown**: `**bold**`, `*italic*`, lists, tables, line breaks as `\n`. Use raw HTML only for something Markdown cannot show; then give that text as `{"html": "..."}` instead of a string.
5. **Ids**: `pack.id` is a short lowercase slug for this source (e.g. `"olympiad-fractions-2"`); use the same `pack.id` every time this source is converted. Each question's `id` is `"q"` + its printed number (e.g. `"q12"`, `"q3b"`), unique within the pack.

## Each question

| Field | What to put |
| --- | --- |
| `id` | `"q"` + printed number, unique in the pack |
| `number` | the number as printed, e.g. `"12"` |
| `type` | `mcq_single` (one correct option), `mcq_multi` (choose all that apply), `numeric` (answer is a number), `short_answer` (a word or short phrase), `open` (explain / prove / show), `multi_part` (has parts (a), (b), …) |
| `stem` | the question text (Markdown + LaTeX). For multi-part questions, only the shared introduction |
| `options` | multiple choice only: a list in printed order, e.g. `["$\\frac{1}{2}$", "$\\frac{3}{4}$"]` (labels A, B, C… are added), or `[{"label": "A", "text": "..."}]` when labels are printed differently |
| `answer` | the final answer (see below) |
| `solution` | the worked solution (see below) |
| `parts` | multi-part only: `[{"label": "a", "stem": "...", "answer": ..., "solution": ..., "marks": 2}, ...]` |
| `hints` | optional list of hints given in the source |
| `subject` | only if different from `pack.subject` |
| `topics` | list of topic paths, broad to narrow, joined with `" > "`, e.g. `["Number > Fractions > Equivalent fractions"]`. Add `{"name": "...", "weight": 0.5}` when a question is split between topics |
| `difficulty` | the difficulty label printed in the source, mapped to one of my labels below if possible |
| `marks` | marks or points, if printed |
| `fields` | any other useful facts as name → value, e.g. `{"Year": 2023, "Paper": "1H", "Calculator": false}` |
| `source` | where it is in the source, e.g. `{"page": 4}` |

### Answers

- `mcq_single`: the label, e.g. `"C"`. `mcq_multi`: a list, e.g. `["A", "C"]`.
- `numeric`: a number (`28`), a fraction string (`"5/8"`), or `{"value": 3.2, "unit": "cm", "tolerance": 0.05}`.
- `short_answer`: the expected answer, or a list of acceptable answers, e.g. `["newton", "N"]`.
- `open`: the final result as Markdown, if there is one.
- `multi_part`: put each part's answer inside that part.

### Solutions

- Either Markdown text, e.g. `"Divide top and bottom by 2: $\\frac{6}{8} = \\frac{3}{4}$."`
- Or structured: `{"answer": "28 students", "steps": ["first step", "second step"], "explanation": "..."}`.
- Keep all working from the source. For multi-part questions, put each part's working in that part's `solution`.

### Figures and images

- If the source contains an SVG figure, copy it into `assets` and show it in the text with `![short description](asset:NAME)`:
  `"assets": {"fig1": {"type": "image/svg+xml", "data": "<svg ...>...</svg>"}}`.
- If a figure is a picture you cannot reproduce exactly, keep the reference as `![short description](asset:qNUMBER-fig)` and add `"assets": {"qNUMBER-fig": {"file": "images/qNUMBER-fig.png"}}`. I will put that image file next to the JSON in a zip. Never draw or guess a figure yourself.
- Never use web links (http…) for images.

## My existing labels (reuse them when they fit)

- Subjects: {{SUBJECTS}}
- Difficulty labels: {{DIFFICULTY_LABELS}}
- Topics already in my library:
{{TOPICS}}
- Custom fields already in use: {{FIELDS}}

## Long sources

If there are more than about 25 questions, convert them in batches when I ask (for example "questions 1–25", then "26–50"). Every batch is a complete JSON object with the same `pack` block (same `pack.id`).

## Before you reply, check

- Valid JSON: double quotes, no trailing commas, no comments, every LaTeX backslash doubled.
- Every question from the source is present, in order, word for word.
- No answer or solution was invented.
- Every `![...](asset:NAME)` has a matching entry in `assets`.

## Small example

```json
{
  "format": "practice-app/question-pack@1",
  "pack": { "id": "fractions-set-1", "title": "Fractions Set 1", "source": "Fractions Set 1.html", "subject": "Maths" },
  "questions": [
    {
      "id": "q1",
      "number": "1",
      "type": "numeric",
      "stem": "In a class, $\\frac{3}{7}$ of the students are boys. There are 12 boys. How many students are in the class?",
      "answer": 28,
      "solution": { "steps": ["$\\frac{1}{7}$ of the class is $12 \\div 3 = 4$.", "The class has $7 \\times 4 = 28$ students."] },
      "topics": ["Number > Fractions > Fraction of an amount"],
      "difficulty": "Challenge",
      "marks": 2
    },
    {
      "id": "q2",
      "number": "2",
      "type": "multi_part",
      "stem": "A bar is divided into 8 equal parts and 5 are shaded.",
      "parts": [
        { "label": "a", "stem": "What fraction is shaded?", "answer": "5/8", "marks": 1 },
        { "label": "b", "stem": "What fraction is unshaded?", "answer": "3/8", "solution": "$8 - 5 = 3$ parts, so $\\frac{3}{8}$.", "marks": 1 }
      ],
      "topics": ["Number > Fractions > Part–whole"],
      "difficulty": "Foundation"
    }
  ]
}
```

Now convert the following source:
