# Document ingestion pipeline

Turns a source paper (HTML page, Word file) into a **checked question pack** for the practice app, with no AI in
the conversion. An AI model is used once, at the start, to describe the layout (the *profile*); after that a
deterministic program converts the paper and proves, check by check, that nothing was lost, changed or invented.

```
 source file ──► ingest brief ──► any AI model ──► profile + job (one YAML file)
                                                        │
                       ingest lint / ingest try ◄───────┘   (fix and repeat until clean)
                                                        │
 source file + YAML ──► ingest run ──► S0 intake ─ S1 extract ─ S2 segment ─ S3 assemble
                                       S4 gates G1…G6 ─ S5 review packet ──► STOP (Gate B)
                                                        │
                       a different person/AI reviews ──►  approval.json ──► ingest approve-check
                                                        │
                                       pack/pack.zip ──► app Import screen
```

The design follows *Document Ingestion Pipeline: Architecture and Build Specification v2*. What was built, what
was improved and what is not built yet is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## The loop, step by step

Run everything from the repository root after `npm install` once. `ingest/ingest` is the command.

**1. Make the profiling brief** (the standard profiler: one file you paste to any AI model):

```bash
ingest/ingest brief "My Paper.html"            # writes ingest/scratch/my-paper.brief.md
```

The brief contains the instructions ([`kit/PROFILER_PROMPT.md`](kit/PROFILER_PROMPT.md)), the profile language
([`kit/PROFILE_REFERENCE.md`](kit/PROFILE_REFERENCE.md)), worked examples that pass every check, and a *probe
report*: facts the program measured about your file (repeated containers, a shape census with rare shapes,
scripts and data arrays, figures, formatting, hidden and generated text). Edit the two kit files to change the
template for every future paper.

**2. Give the brief to an AI model.** It replies with one YAML block (profile, `---`, job) plus a short list of
assumptions and questions. Save the block as, say, `ingest/scratch/my-paper.yaml`. Answer its questions in the
file (for example how its difficulty levels map to your library's labels).

**3. Check and trial it** (the only human-in-the-loop step at the start):

```bash
ingest/ingest lint ingest/scratch/my-paper.yaml                         # malformed? every error has a line number
ingest/ingest try  ingest/scratch/my-paper.yaml --source "My Paper.html" # convert in a scratch folder
```

`try` prints counts and every unclaimed piece of text grouped by page region, and writes a side-by-side page
(`ingest/scratch/try-<job>/try.html`: source on the left, what the app will show on the right). Paste any error
back to the AI, or fix the YAML yourself, and repeat until `try` is clean. When you are happy, put the profile
hash that `lint` prints into the job as `job.profile.sha256` (this records the Gate A sign-off), and save the
profile under `ingest/profiles/` and the job under `ingest/jobs/` if you want to keep them.

**4. Run the corridor:**

```bash
ingest/ingest run ingest/scratch/my-paper.yaml --source "My Paper.html"
```

It converts, runs six gates, builds the review packet and **always stops at Gate B**. Nothing is imported. A
FAIL can never be waived: fix the cause and run again. Exit codes: 0 pass, 10 warnings, 20 fail, 30 usage, 40 bug.

**5. Review (Gate B).** Open `ingest/runs/<run>/review/index.html`. Read `assurance.md` first (what was and was
not checked) and `decisions-made.md` (everything ignored, mapped or added). Give one verdict per item in
`review/approval.template.json` and save it as `ingest/runs/<run>/approval.json`. `review-brief.md` is a
paste-ready prompt if an AI does the review. **The reviewer must not be the profile's author**, and some items
were corrupted on purpose — marking one `ok` voids the approval.

```bash
ingest/ingest approve-check ingest/runs/<run>
```

On success it writes `approval.receipt.json`. The approved pack is `ingest/runs/<run>/pack/pack.zip`.

**6. Import** the pack with the app's **Import** screen (or `ingest/import_live.mjs`), after the read-only
`ingest/preflight_live.mjs` overlap check. The live stages (S6–S9) are not automated yet; see ARCHITECTURE.md.

**A new paper in a layout you already have** needs only a new job (counts, pack id, mappings, assertions):
the same profile is reused without re-approval. All four Word worksheets here use one profile.

**A human fix to the output** goes in a corrections file, never into the pack:
`ingest/ingest run … --corrections fixes.yaml` (each entry names the question, field, the hash of the old value,
the new value, a reason, author and date; a stale entry stops the run).

## Commands

| Command | What it does |
| --- | --- |
| `ingest probe FILE… [--out DIR]` | Facts about a source (JSON + Markdown). Read-only, deterministic. |
| `ingest brief FILE… [--out FILE]` | The paste-ready profiling brief for an AI model. |
| `ingest lint PROFILE [JOB]` | Validate a profile and job; prints the profile hash. |
| `ingest try PROFILE [JOB] [--source F]` | Trial conversion in `ingest/scratch/`; never approvable. |
| `ingest run PROFILE [JOB] [--source F] [--corrections F]` | The corridor S0–S5; stops at Gate B. |
| `ingest status RUN` | Stages, gate verdicts, approval state. |
| `ingest approve-check RUN` | Gate B: validates `approval.json` against the run. |
| `ingest oracle RUN OLD_PACK` | Compare with a pack made another way; differences must be explained in `oracle-diffs.yaml`. |

Every command accepts `--json`. `PROFILE` may be one file holding the profile, `---`, then the job.

## Folder

| Path | Contents |
| --- | --- |
| `engine/` | The converter and gates G1, G5, G6 (Python, stdlib + BeautifulSoup, PyYAML, jsonschema). |
| `checker/` | The independent gates G2, G3, G4, the figure render check and the side-by-side page (Node: parse5/cheerio, acorn, the app's own reader and renderer). Shares no code or parser with `engine/`. |
| `kit/` | The profiler template: prompt, language reference, profile and job JSON Schemas. |
| `profiles/`, `jobs/` | Approved layouts and the seven papers' jobs (worked examples, used in briefs). |
| `tests/run_tests.py` | Unit tests, fault injection and Gate B tamper cases (`npm run ingest:test`). |
| `oracle-diffs.yaml` | Explained differences against the earlier hand-written converters. |
| `runs/`, `scratch/` | Run folders and trials (not committed: they hold copies of the sources). |
| `packs/`, `convert_*.py`, `fidelity.py`, … | The first, hand-written converters and checks for the seven papers ([history](HISTORY-first-seven-papers.md)). Kept as the golden oracle. |

## Check it yourself

```bash
npm run ingest:test                       # 45 cases: unit tests, fault injection, approval tampering
sh ingest/tests/run_all_papers.sh         # all seven papers through the corridor + golden oracle (~2 minutes)
```
