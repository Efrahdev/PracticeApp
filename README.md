# Practice App

A private question-practice app built only from free Cloudflare services:
one **Worker** (the API and the screens), **D1** (the database), **R2** (the files),
with an optional Cloudflare Access login wall (currently off — public link). Design inputs are in [`Artefacts/`](Artefacts/).

Live address: **https://practice-app.aarhaan22.workers.dev**

## What it does (first release)

| Area | What works |
| --- | --- |
| Import (FR-1.1–1.5) | One canonical format — the **question pack** ([spec](docs/question-format.md)). Any AI model converts a source into a pack using [the prompt](docs/ai-prompt.md); you upload the .json / .yaml (or a .zip with images) or paste the AI's reply. The importer repairs LaTeX that JSON escaping damaged, validates every question, shows previews of each question and solution, maps subjects and difficulty labels, and says what is new, changed (new version) or already in the library. Each batch is saved all-or-nothing; the original pack file is kept byte-for-byte; every file is stored once under its SHA-256 fingerprint. |
| Solutions | Worked solutions and answers are stored per question (Markdown + LaTeX). Open them whenever you want on the question page and while practising. AI-written solutions/keys are marked **Unverified** until you approve them (FR-1.10). |
| Papers with or without solutions | Each paper is built either **with solutions** (open any solution while practising; the printed copy ends with a solutions section) or **without** (test conditions). Any paper prints / saves as PDF. |
| Questions (FR-1.6–1.7, 1.9, 1.11) | Shown in a locked box (sandboxed iframe: no scripts, no internet). Edit subject, concepts with weights, difficulty label, answer format, answer key, solution and notes; every edit goes to `change_log`. Bulk edit many at once. Concept tree with sub-concepts. Search by text, Q number or ID. |
| Library | The question bank: one widescreen table of every question — **import name**, subject, concepts, difficulty, history, marks, solution, date added, type (more via **Columns**; columns fit the width automatically) — with click-to-sort headers, quick filters (search, subject, import, difficulty, last result), the full AND / OR filter under **More filters**, bulk edit of selected rows, and **Build paper** in the corner (carries the current filters). |
| Subjects & concepts | **Settings → Subjects & concepts**: add, rename (click the name), move, merge, archive and **delete permanently** — one at a time or in bulk, with usage counts, search, an "Unused" view and **Delete all unused**. Deleting asks what happens to affected questions (remove the tag / leave without subject, or re-tag them), and to sub-concepts (delete or move up). Questions and history are never deleted; each change is one all-or-nothing batch, logged, with metrics rebuilt. |
| Filters (FR-2) | Subject, concept (+ sub-concepts, minimum weight), difficulty, never attempted, attempt count, last result, last attempted N days ago, personal difficulty, date added, average time, source file, has key, text — combined with AND / OR groups, with relative dates. Runs on the device. |
| Papers (FR-3) | **Papers** lists every saved paper in a sortable table (status, questions, marks, subjects, last and best score, solutions, last sat) with summary tiles, search, status filter, start / resume / print / hide, and **Build paper** in the corner. **Paper builder** (Build paper on Library or Papers): a full page with the rules on the left and a live preview on the right. **Which questions:** your history (last attempted any time / never / more than / within / between N days, weeks or months ago; number of attempts; last result; average time; personal difficulty), a subject → concept tree with tick boxes at any level, difficulty labels, answer type, marks, solution, answer key, import, date added, archived, text, plus any Library AND / OR condition — every choice shows a live count. **How to pick:** mixes by subject, concept, difficulty, last result and answer type as % or counts, several at once (met together; anything that can't be met is reported, never hidden); favour wrong / not recent / weak concepts; order (random, easiest or hardest first, by subject, your own). **Preview:** summary tiles, split bars, and a detailed table (subject, concepts, difficulty, marks, type, solution, history, why it's here; columns fit the width or are chosen by you; text wraps; cards on a phone) where you can pin, replace, remove, reorder, add a specific question and open the question itself. Same rules + same seed = same paper; the rules are saved with the paper and shown on its page; frozen forever once saved. |
| Practice (FR-4) | One at a time, pause and resume, time recorded quietly (no timers shown, no limits). Manual grading (correct / partial / incorrect) with error type, confidence and note; auto-marking for multiple choice and numeric questions that have a verified key; the solution after grading; correct any past grade (the old grade is kept); summary at the end. |
| Analytics (FR-5) | Per question stats, per subject and concept accuracy with weekly trend (weighted by concept weight), personal difficulty, familiarity, weakest concepts with one-tap "build a paper on these", daily activity and streak. Metrics update in the same save as each grade and can be rebuilt from history with identical results. |
| Backup (FR-6.3–6.5, DR-12) | One zip with all tables, all files, CSV copies and a checksum list. Restore checks every checksum first, then rebuilds all analytics and runs the integrity check. |

| Imports and bulk edit | **Import → Your imports** lists every import by time (newest or oldest first) with a search box, an optional name and note, and **Edit questions**: it opens the Library filtered to exactly the questions that import brought in (several imports can be chosen together; the Library also has an **Import** filter). The bulk form sets subject, topics (add / replace / remove, with weights), answer format, any custom field (set / clear), notes, and archive / unarchive / **delete permanently** — with a preview of what would change, then one all-or-nothing save. Questions you have attempted, or that are in a paper, are archived instead of deleted so your history stays complete. |

Also: custom fields (created from a pack's `fields`, editable and filterable), multi-part questions marked part by part, and questions from the first (HTML-template) importer keep working unchanged.

Not built yet: concept prerequisites (no table in the schema yet), spreadsheet import of metadata, re-grading old attempts when a key is added (FR-4.8).

## Importing questions

1. **Import → Copy AI prompt**, paste it into any AI model (ChatGPT, Claude, Gemini…), then paste or attach your source. Ask for about 25 questions at a time.
2. Upload the reply as a file, or paste it straight into the Import screen — chat text and code fences around it are fine.
3. Review: fix anything flagged in the AI chat ("question 7 has no answer — please resend"), choose where the subjects and difficulty labels go, and save.

Re-converting the same source with the same `pack.id` later is safe: unchanged questions are recognised, changed ones become new versions, and improved solutions replace earlier imported ones (never your own edits).

## Access: public link (no login)

The app is **public**: anyone who has the link can open it, add questions, grade, export and restore. There is no sign-in. Search engines are asked not to index it (`noindex`), but the link itself is the only protection, so don't post it publicly.

To add a login wall later: switch on Cloudflare Access for the `workers.dev` route in the dashboard, then in `wrangler.jsonc` set `PUBLIC_ACCESS` to `""` and fill in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the Worker then checks every request's Access token and refuses anything else). Deploy again.

## Working on it (no installs on your PC)

Everything runs in a cloud container (Claude Code on the web, or GitHub Codespaces):

```bash
npm install
npm run build            # bundles the screens into the Worker
npm test                 # unit tests (parser, filters, sampler, paper builder)
npm run dev              # local Worker with local D1 + R2 (needs .dev.vars: DEV_ALLOW_NO_AUTH=1)
node tests/e2e.mjs       # full browser walk-through against the local Worker (start from an empty local DB: ./scripts/local-reset.sh)
```

Deploying needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment:

```bash
npm run db:migrate:remote   # backup (Time Travel bookmark + SQL dump) THEN apply new migrations
npm run deploy
```

### Database changes (DR-11)

Every change is a new numbered file in `migrations/` (`0002_….sql`, …) that also inserts its row into `schema_migration`. Test it locally with `npm run db:migrate:local`, then run `npm run db:migrate:remote`, which records a restore point and a dump before applying anything and prints the exact undo command.

### Restore

Restore only loads into an **empty** database, so it can never mix two histories. To restore over live data: create a new D1 database (`npx wrangler d1 create practice-app-db-2`), put its id in `wrangler.jsonc`, run the migrations and deploy, then use **Settings → Restore from archive**. For mistakes in the last few days, D1 Time Travel is quicker: `npx wrangler d1 time-travel restore practice-app-db --timestamp=<ISO time>`.

## How it is put together

```
src/shared/qpack/*       question pack: forgiving parser, normaliser, solution composer, fingerprint (shared by browser and tests)
src/worker/imports.ts    import commit (one D1 batch), import history, archive/restore an import
src/worker/index.ts      router, login check, security headers, serves the screens
src/worker/auth.ts       verifies the Cloudflare Access token (fails closed)
src/worker/api.ts        import, metadata, papers, attempts, grades
src/worker/metrics.ts    the SQL behind every metric — the live update and the rebuild share it
src/worker/admin.ts      export, restore, integrity check
src/client/builder/*     paper builder: blueprint (spec), pool rules + live counts, generator v2, table and panels
src/client/*             the screens (Preact); filtering, sampling, import, rendering, printing and backup zips run on the device
src/client/render.ts     Markdown + LaTeX (Temml → MathML) renderer for the locked question box
migrations/0001_…sql     schema version 1 (from Artefacts/Initial Schema.sql)
migrations/0002_…sql     schema version 2: question packs (external reference, marks, content format, solution format, paper solutions mode)
migrations/0003_…sql     schema version 3: name and note for each import
src/worker/taxonomy.ts   subjects & concepts: delete / merge / move in one batch, metrics rebuilt
src/client/grid.tsx      the sortable data grid used by every big table
src/worker/bulk.ts       bulk edit / delete: preview and one-batch apply, set-based SQL, every change logged
docs/                    question pack spec, JSON Schema, AI prompt, examples
```

Heavy work (parsing, filtering, sampling, zipping) runs in the browser so each Worker request stays well inside the free plan's 10 ms CPU limit. Imports send many rows to D1 as one JSON value (`json_each`), so a 100-question import is about ten statements in a single all-or-nothing batch.
