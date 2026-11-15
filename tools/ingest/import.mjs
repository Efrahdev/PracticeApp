#!/usr/bin/env node
// Headless importer: pushes question-pack zips/json/yaml into a RUNNING app instance by
// reusing the app's own client importer (src/client/importer.ts), bundled with esbuild.
//
// Usage: node tools/ingest/import.mjs --url <base-url> [--dry-run] [--label "<name>"] [--update-existing] <pack.zip> [more ...]
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
let baseUrl = null, label = null, dry = false, updateExisting = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--url") baseUrl = args[++i];
  else if (a.startsWith("--url=")) baseUrl = a.slice(6);
  else if (a === "--label") label = args[++i];
  else if (a.startsWith("--label=")) label = a.slice(8);
  else if (a === "--dry-run") dry = true;
  else if (a === "--update-existing") updateExisting = true;
  else if (a === "-h" || a === "--help") { usage(0); }
  else if (a.startsWith("--")) { console.error(`Unknown option ${a}`); usage(2); }
  else files.push(a);
}
function usage(code) {
  console.error('Usage: node tools/ingest/import.mjs --url <base-url> [--dry-run] [--label "<import label>"] [--update-existing] <pack.zip> [more.zip ...]');
  process.exit(code);
}
if (!baseUrl || !files.length) usage(2);
baseUrl = baseUrl.replace(/\/+$/, "");
let u;
try { u = new URL(baseUrl); } catch { console.error(`Bad --url: ${baseUrl}`); process.exit(2); }
if (!/^https?:$/.test(u.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && process.env.INGEST_ALLOW_REMOTE !== "1") {
  console.error(`Refusing ${u.origin}: only http://127.0.0.1:<port> or http://localhost:<port> is allowed (set INGEST_ALLOW_REMOTE=1 to override on purpose).`);
  process.exit(2);
}

// ---------------------------------------------------------------- browser-ish globals
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.location = new URL(baseUrl + "/");
globalThis.fetch = async (input, init = {}) => {
  const target = typeof input === "string" && input.startsWith("/") ? baseUrl + input : input;
  const { credentials, ...rest } = init; // "same-origin" means nothing outside a browser
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * 2 ** attempt);
    try {
      const res = await realFetch(target, rest);
      if (res.status >= 500 || res.status === 429) { lastErr = new Error(`HTTP ${res.status}`); if (attempt < 2) { await res.arrayBuffer().catch(() => {}); continue; } }
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
};

// ---------------------------------------------------------------- bundle the app's importer
const tmp = mkdtempSync(join(tmpdir(), "ingest-"));
const outfile = join(tmp, "importer.mjs");
try {
  await build({
    entryPoints: [join(root, "src/client/importer.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "error",
    target: "node22", sourcemap: false,
    // render.ts lazy-loads temml with import(); keep it in one file
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
} catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
const imp = await import(pathToFileURL(outfile).href);
const { readInputs, preview, commitPacks, fieldTypes, suggestDifficulty } = imp;
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ---------------------------------------------------------------- helpers
const getJson = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
};
const group = (msgs) => {
  const m = new Map();
  for (const x of msgs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m];
};
const table = (rows, cols) => {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(w[i])).join("  ");
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(w.map((x) => "-".repeat(x)).join("  "));
  rows.forEach((r) => console.log(line(r)));
};

// ---------------------------------------------------------------- run
let failed = 0;
const summary = [];
let boot;
try { boot = await getJson("/api/bootstrap"); } catch (e) { console.error(`Cannot reach the app at ${baseUrl}: ${e.message}`); process.exit(1); }
console.log(`Connected to ${baseUrl} (${boot.subjects?.length ?? 0} subjects, ${boot.difficulties?.length ?? 0} difficulty labels, ${boot.fields?.length ?? 0} custom fields)`);

// 1. prepare everything
const prepared = []; // { file, pack }
for (const f of files) {
  let bytes;
  try { bytes = readFileSync(f); } catch (e) { console.error(`${f}: cannot read (${e.message})`); failed++; summary.push({ pack: basename(f), questions: 0, new: 0, "new ver": 0, dup: 0, skipped: 0, status: "UNREADABLE" }); continue; }
  const file = new File([bytes], basename(f), { type: /\.zip$/i.test(f) ? "application/zip" : "application/json" });
  const r = await readInputs([file], null);
  for (const fl of r.failures) { console.error(`${f}: could not read ${fl.name} - ${fl.error}`); failed++; summary.push({ pack: fl.name, questions: 0, new: 0, "new ver": 0, dup: 0, skipped: 0, status: "UNREADABLE" }); }
  for (const p of r.packs) { if (label) p.label = label; prepared.push({ file: f, pack: p }); }
}

// 2. report + preview
for (const { pack: p } of prepared) {
  const errs = group(p.questions.flatMap((q) => q.errors));
  const warns = group([...p.warnings.filter((w) => !p.pack.issues.some((i) => i.message === w)), ...p.pack.issues.map((i) => `${i.level === "error" ? "pack error: " : ""}${i.message}`), ...p.questions.flatMap((q) => q.warnings)]);
  const nImages = p.assetBlobs.size;
  console.log(`\n=== ${p.pack.title ?? p.sourceName}  [${p.sourceName}]`);
  console.log(`questions: ${p.questions.length}   images: ${nImages}   syntax: ${p.syntax}   import label: "${p.label || p.pack.title || p.sourceName}"`);
  console.log(`errors: ${errs.reduce((s, [, n]) => s + n, 0)} (${errs.length} distinct)   warnings: ${warns.reduce((s, [, n]) => s + n, 0)} (${warns.length} distinct)`);
  for (const [m, n] of errs) console.log(`  ERROR x${n}: ${m}`);
  for (const [m, n] of warns) console.log(`  warning x${n}: ${m}`);
  try {
    await preview(p);
    const c = { new: 0, new_version: 0, duplicate: 0, duplicate_in_file: 0 };
    for (const q of p.questions) if (!q.errors.length) c[q.status]++;
    console.log(`preview: ${c.new} new, ${c.new_version} new version, ${c.duplicate} already in library${c.duplicate_in_file ? `, ${c.duplicate_in_file} repeated in file` : ""}`);
  } catch (e) { console.error(`  preview failed: ${e.message}`); }
}

if (dry) { console.log("\n--dry-run: nothing was written."); process.exit(failed ? 1 : 0); }

// 3. commit one pack at a time
for (const { pack: p } of prepared) {
  const name = p.pack.title ?? p.sourceName;
  try {
    boot = await getJson("/api/bootstrap"); // fresh: earlier packs may have created subjects / fields / difficulty labels
    await preview(p);
    const subjects = new Map(), diffs = new Map();
    const active = boot.subjects.filter((x) => !x.archived_at);
    for (const q of p.questions) {
      const s = q.nq.subject ?? "";
      if (!subjects.has(s)) {
        const hit = active.find((x) => x.name.toLowerCase() === s.toLowerCase());
        subjects.set(s, hit ? { id: hit.id } : s ? { name: s } : active.length === 1 ? { id: active[0].id } : { name: "General" });
      }
      if (q.nq.difficulty && !diffs.has(q.nq.difficulty)) diffs.set(q.nq.difficulty, suggestDifficulty(q.nq.difficulty, boot.difficulties ?? []));
    }
    const mapping = { subjects, difficulties: diffs, updateExisting };
    let lastMsg = "";
    const [res] = await commitPacks([p], mapping, fieldTypes(prepared.map((x) => x.pack), boot.fields ?? []), (msg) => {
      if (msg !== lastMsg && /adding to the library|Done/.test(msg)) console.log(`  ${msg}`);
      lastMsg = msg;
    });
    console.log(`\n${name}: new ${res.new}, new versions ${res.new_versions}, duplicates ${res.duplicates}, rejected ${res.rejected}, updated solutions ${res.updated_solutions}, updated keys ${res.updated_keys}`);
    summary.push({ pack: name, questions: p.questions.length, new: res.new, "new ver": res.new_versions, dup: res.duplicates, skipped: res.rejected, status: "ok" });
  } catch (e) {
    failed++;
    console.error(`\n${name}: FAILED - ${e.message}`);
    summary.push({ pack: name, questions: p.questions.length, new: 0, "new ver": 0, dup: 0, skipped: 0, status: "FAILED" });
  }
}

console.log("\nSummary");
table(summary, ["pack", "questions", "new", "new ver", "dup", "skipped", "status"]);
process.exit(failed ? 1 : 0);
