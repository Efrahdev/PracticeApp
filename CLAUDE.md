# CLAUDE.md — Practice App

A private question-practice app for one learner. Questions arrive as **question packs** (a JSON/YAML format), are
stored in a library, assembled into papers, practised, graded and analysed. It runs entirely on free Cloudflare
services: one **Worker** (API + serves the UI), **D1** (SQLite database, binding `DB`), **R2** (files, binding
`FILES`). Live at https://practice-app.aarhaan22.workers.dev (public link, no login — `PUBLIC_ACCESS: "1"`).

`README.md` is the user-facing feature list and is accurate; read it for behaviour questions. The original
requirements (FR-x / DR-x numbers used in code comments and commits) are in `Artefacts/`.

## Commands

```bash
npm install
npm run build        # REQUIRED before typecheck/dev: bundles the UI into public/ and generates src/worker/static.gen.ts
npm run typecheck    # tsc (fails with "Cannot find module './static.gen'" if you haven't built)
npm test             # vitest: tests/unit.test.ts, builder.test.ts, qpack.test.ts (~35 tests, <1 s)
npm run dev          # build --dev + wrangler dev with local D1/R2; needs .dev.vars containing DEV_ALLOW_NO_AUTH=1
./scripts/local-reset.sh                          # wipe local D1/R2 and re-apply migrations
BASE=http://127.0.0.1:8787 node tests/e2e.mjs     # Playwright walk-through; needs an EMPTY local DB and `npm run dev` running
```

Deploy (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`): `npm run db:migrate:remote` then `npm run deploy`.
Never deploy or migrate the live database unless the user explicitly asks — it holds their real practice history.

## Layout

| Path | What |
| --- | --- |
| `src/worker/index.ts` | Router (`on(method, path, handler)` table), auth check, security headers, serves embedded static files |
| `src/worker/api.ts` | Most endpoints + the `Env` type; `imports.ts`, `bulk.ts`, `taxonomy.ts`, `admin.ts` (export/restore/integrity), `metrics.ts` (all metric SQL) |
| `src/worker/http.ts` | `HttpError`, `json()`, `readJson()`, `need()` helpers — use these, throw `HttpError` for 4xx |
| `src/worker/auth.ts` | Cloudflare Access JWT check (fails closed); bypassed by `DEV_ALLOW_NO_AUTH=1` or `PUBLIC_ACCESS=1` |
| `src/client/` | Preact UI (`main.tsx`, `pages/*.tsx`, `builder/*` = paper builder, `grid.tsx` = shared sortable table) |
| `src/client/render.ts` | Markdown + LaTeX (Temml → MathML) rendered into a sandboxed iframe |
| `src/shared/qpack/` | Question-pack parser/normaliser/composer/hash — shared by browser and tests |
| `migrations/000N_*.sql` | D1 schema, numbered; each inserts its row into `schema_migration` |
| `docs/` | Pack spec (`question-format.md`), JSON Schema, the AI conversion prompt, examples used by e2e |
| `ingest/` | One-off converters + packs used to import 7 papers into the live library (historical; see `ingest/README.md`) |
| Root `*.pdf/*.docx/*.html` | Source papers the user uploaded. Not code — don't move or delete |

## Architecture rules (why the code looks the way it does)

- **Free plan: 10 ms CPU per Worker request.** Heavy work (parsing packs, filtering, sampling papers, zipping
  backups, rendering) runs in the **browser**. Keep Worker handlers to thin SQL.
- **All-or-nothing writes**: multi-row changes go through one `env.DB.batch([...])`. Bulk rows are sent as one
  JSON value and expanded with `json_each` in SQL instead of many statements.
- **Every edit is logged** to `change_log` (old/new value). Keep that when adding mutations.
- **Metrics** are updated in the same batch as each grade and must be rebuildable from history with identical
  results — the live update and the rebuild share SQL in `metrics.ts`. Change both paths together.
- **History is never destroyed**: questions that were attempted or are in a paper are archived, not deleted.
  Saved papers are frozen. Changed imported questions become new versions; user edits are never overwritten.
- Files are stored once in R2 under their SHA-256; original pack files are kept byte-for-byte.
- Paper generation is deterministic: same rules + same seed = same paper.

## Schema changes (DR-11)

Add a new numbered file in `migrations/` (never edit an applied one) that also inserts its `schema_migration`
row. Test with `npm run db:migrate:local`. `db:migrate:remote` takes a Time Travel bookmark + SQL dump first and
prints the undo command.

## Gotchas

- `src/worker/static.gen.ts`, `public/app.js`, `public/chunks/`, `public/fonts/` are generated (git-ignored). Don't edit.
- `src/shared/qpack/*`, `src/client/render.ts` and `docs/question-format.md` / `docs/question-pack.schema.json` are
  **copied into the `Efrahdev/Ingesf` repo** (its checks run this exact code). If you change them, tell the user
  the Ingesf copy needs updating (`Ingesf/src/README.md` records the source commit).
- Restore only loads into an **empty** database.
- TypeScript is strict; JSX is Preact (`jsxImportSource: "preact"`), not React.

## Style

- Commit messages: a plain-English sentence describing the user-visible change (see `git log`).
- UI copy and docs use plain, friendly British English, no jargon. Keep `README.md`'s feature table current when
  you add or change a feature.
