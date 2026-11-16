#!/usr/bin/env node
// Validate every pack in ingest/packs with the app's OWN reader (src/shared/qpack) and the published JSON Schema.
// Read-only: touches no database. Usage: node ingest/validate.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = path.join(ROOT, "ingest", "packs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qpack-"));
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, `
export { parsePackText } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/parse.ts"))};
export { normalizePack } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/normalize.ts"))};
export { answerKeyOf, composeSolution, fingerprintSource, storedQuestionOf, refsInContent, allContents } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/compose.ts"))};
`);
const out = path.join(tmp, "qpack.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const Q = await import(pathToFileURL(out).href);

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSchema = ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, "docs/question-pack.schema.json"), "utf8")));

const report = { packs: [], crossPack: {} };
const fingerprints = new Map(); // fingerprint -> [pack/qid]
let hardFail = false;

for (const file of fs.readdirSync(PACKS).filter((f) => f.endsWith(".json")).sort()) {
  const text = fs.readFileSync(path.join(PACKS, file), "utf8");
  const parsed = Q.parsePackText(text, file);
  const schemaOk = validateSchema(parsed.value);
  const schemaErrors = schemaOk ? [] : validateSchema.errors.slice(0, 10).map((e) => `${e.instancePath} ${e.message}`);
  const pack = Q.normalizePack(parsed.value, { fileName: file });

  const rec = {
    file, key: pack.key, title: pack.title, source: pack.source,
    jsonRepairs: parsed.repairs, schemaOk, schemaErrors,
    questions: pack.questions.length, packIssues: pack.issues,
    types: {}, withAnswerKey: 0, withSolution: 0, withParts: 0, parts: 0,
    errors: [], warnings: [], assets: Object.keys(pack.assets).length, missingAssets: [],
    difficulty: {}, topics: {}, fieldNames: {}, dupRefs: [],
  };
  const seenRef = new Set();
  const used = new Set();
  for (const q of pack.questions) {
    rec.types[q.type] = (rec.types[q.type] || 0) + 1;
    if (Q.answerKeyOf(q)) rec.withAnswerKey++;
    const sol = Q.composeSolution(q);
    if (sol) rec.withSolution++;
    if (q.parts.length) { rec.withParts++; rec.parts += q.parts.length; }
    for (const i of q.issues) (i.level === "error" ? rec.errors : rec.warnings).push(`${q.id}: ${i.message}`);
    if (seenRef.has(q.ref)) rec.dupRefs.push(q.ref);
    seenRef.add(q.ref);
    rec.difficulty[q.difficulty ?? "(none)"] = (rec.difficulty[q.difficulty ?? "(none)"] || 0) + 1;
    for (const t of q.topics) rec.topics[t.path.join(" > ")] = (rec.topics[t.path.join(" > ")] || 0) + 1;
    for (const k of Object.keys(q.fields)) rec.fieldNames[k] = (rec.fieldNames[k] || 0) + 1;
    for (const c of Q.allContents(q)) for (const r of Q.refsInContent(c)) used.add(r.replace(/^asset:/, ""));
    const fp = Q.fingerprintSource(Q.storedQuestionOf(q, pack.css));
    (fingerprints.get(fp) ?? fingerprints.set(fp, []).get(fp)).push(`${pack.key}/${q.id}`);
  }
  rec.missingAssets = [...used].filter((r) => !pack.assets[r]);
  rec.unusedAssets = Object.keys(pack.assets).filter((a) => !used.has(a));
  rec.packIssues.forEach((i) => (i.level === "error" ? rec.errors : rec.warnings).push(`pack: ${i.message}`));
  if (!schemaOk || rec.errors.length || rec.dupRefs.length || rec.missingAssets.length) hardFail = true;
  report.packs.push(rec);
}
report.crossPack.duplicateContent = [...fingerprints.values()].filter((v) => v.length > 1);
report.totalQuestions = report.packs.reduce((n, p) => n + p.questions, 0);
fs.writeFileSync(path.join(ROOT, "ingest", "validation-report.json"), JSON.stringify(report, null, 2) + "\n");

for (const p of report.packs) {
  console.log(`\n${p.file}  (${p.key})`);
  console.log(`  questions ${p.questions} | schema ${p.schemaOk ? "OK" : "FAIL " + p.schemaErrors.join("; ")} | errors ${p.errors.length} | warnings ${p.warnings.length} | json repairs ${p.jsonRepairs}`);
  console.log(`  types ${JSON.stringify(p.types)} | answer keys ${p.withAnswerKey} | solutions ${p.withSolution} | multi-part ${p.withParts} (${p.parts} parts)`);
  console.log(`  assets ${p.assets} (missing ${p.missingAssets.length}, unused ${p.unusedAssets.length}) | difficulty ${JSON.stringify(p.difficulty)}`);
  console.log(`  topics ${Object.keys(p.topics).length} | fields ${JSON.stringify(p.fieldNames)}`);
  [...p.errors.slice(0, 8)].forEach((e) => console.log("  ERROR  " + e));
  [...p.warnings.slice(0, 8)].forEach((e) => console.log("  warn   " + e));
  if (p.warnings.length > 8) console.log(`  … ${p.warnings.length - 8} more warnings (see validation-report.json)`);
}
console.log(`\nTOTAL questions: ${report.totalQuestions}; duplicate-content groups across/within packs: ${report.crossPack.duplicateContent.length}`);
report.crossPack.duplicateContent.slice(0, 10).forEach((g) => console.log("  dup:", g.join(" = ")));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(hardFail ? 1 : 0);
