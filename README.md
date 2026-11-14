# Practice App

A private question-practice app built only from free Cloudflare services:
one **Worker** (the API and the screens), **D1** (the database), **R2** (the files),
and **Cloudflare Access** (the login wall). Design inputs are in [`Artefacts/`](Artefacts/).

Live address: **https://practice-app.aarhaan22.workers.dev**

## What it does (first release)

| Area | What works |
| --- | --- |
| Import (FR-1.1–1.5) | Upload one HTML file → it is split in your browser using `parse.ts` → review screen (counts, previews, missing files, duplicates, changed questions) → accept or reject per question → saved in one all-or-nothing step. The original file is kept byte-for-byte in R2; every file is stored once, under its SHA-256 fingerprint. Same content is recognised and never duplicated; same file name + same question number with changed content becomes a **new version**. |
| Questions (FR-1.6–1.7, 1.9, 1.11) | Shown in a locked box (sandboxed iframe: no scripts, no internet). Edit subject, concepts with weights, difficulty label, answer format, answer key, solution and notes; every edit goes to `change_log`. Bulk edit many at once. Concept tree with sub-concepts. Search by text, Q number or ID. |
| Filters (FR-2) | Subject, concept (+ sub-concepts, minimum weight), difficulty, never attempted, attempt count, last result, last attempted N days ago, personal difficulty, date added, average time, source file, has key, text — combined with AND / OR groups, saved by name with relative dates. Runs on the device. |
| Papers (FR-3) | Build from any filter, any length, never repeats; warns when the filter is too small; optional difficulty mix; favour wrong / not recent / weak concepts; same filter + settings + seed = same paper; shows why each question was picked; frozen forever once saved. |
| Practice (FR-4) | One at a time, pause and resume, time recorded quietly (no timers shown, no limits). Manual grading (correct / partial / incorrect) with error type, confidence and note; auto-marking for multiple choice and numeric questions that have a verified key; the solution after grading; correct any past grade (the old grade is kept); summary at the end. |
| Analytics (FR-5) | Per question stats, per subject and concept accuracy with weekly trend (weighted by concept weight), personal difficulty, familiarity, weakest concepts with one-tap "build a paper on these", daily activity and streak. Metrics update in the same save as each grade and can be rebuilt from history with identical results. |
| Backup (FR-6.3–6.5, DR-12) | One zip with all tables, all files, CSV copies and a checksum list. Restore checks every checksum first, then rebuilds all analytics and runs the integrity check. |

Not built yet (marked *Should/Could* in the requirements, or not in the schema): custom fields UI (FR-1.8), concept prerequisites (no table in schema v1), AI suggestions (FR-1.10), spreadsheet import of metadata, re-grading old attempts when a key is added (FR-4.8), reordering a paper before starting (FR-3.8).

## Switch on the login wall (one time, in the Cloudflare dashboard)

Until this is done the app shows **"Practice App is locked"** to everyone, including you. That is deliberate: the Worker refuses every request unless it carries a valid Access sign-in.

1. Cloudflare dashboard → **Zero Trust**. If asked, pick a team name (e.g. `aarhaan`) and the **Free** plan.
2. Dashboard → **Workers & Pages → practice-app → Settings → Domains & Routes**. On the `workers.dev` row choose **Enable Cloudflare Access**.
3. Open **Manage Cloudflare Access** (or Zero Trust → Access → Applications → the new app):
   * **Policies**: make sure the only rule is *Allow → Emails → your email address*.
   * **Overview**: copy the **Application Audience (AUD) Tag**.
4. Zero Trust → **Settings** shows your **team domain**, like `aarhaan.cloudflareaccess.com`.
5. Put both values in `wrangler.jsonc` under `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and deploy again. Neither value is secret.

## Working on it (no installs on your PC)

Everything runs in a cloud container (Claude Code on the web, or GitHub Codespaces):

```bash
npm install
npm run build            # bundles the screens into the Worker
npm test                 # unit tests (parser, filters, sampler)
npm run dev              # local Worker with local D1 + R2 (needs .dev.vars: DEV_ALLOW_NO_AUTH=1)
node tests/e2e.mjs       # full browser walk-through against the local Worker
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
src/shared/parse.ts      question-file splitter (from Artefacts/parse.ts, unchanged)
src/worker/index.ts      router, login check, security headers, serves the screens
src/worker/auth.ts       verifies the Cloudflare Access token (fails closed)
src/worker/api.ts        import, metadata, papers, attempts, grades
src/worker/metrics.ts    the SQL behind every metric — the live update and the rebuild share it
src/worker/admin.ts      export, restore, integrity check
src/client/*             the screens (Preact); filtering, sampling, import parsing and backup zips run on the device
migrations/0001_…sql     schema version 1 (from Artefacts/Initial Schema.sql)
```

Heavy work (parsing, filtering, sampling, zipping) runs in the browser so each Worker request stays well inside the free plan's 10 ms CPU limit. Imports send many rows to D1 as one JSON value (`json_each`), so a 100-question import is about ten statements in a single all-or-nothing batch.
