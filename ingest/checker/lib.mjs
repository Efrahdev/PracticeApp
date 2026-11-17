// Shared plumbing for the independent gates (G2, G3, G4).
// R8: nothing in this folder imports the converter (ingest/engine, Python). The source is re-read here with a
// different parser library (parse5 via cheerio, acorn, fflate) in a different language runtime.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORDER = { PASS: 0, INFO: 1, WARN: 2, FAIL: 3 };

/** The app's own reader and renderer, bundled from src/ unmodified. */
export async function loadApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-app-"));
  const entry = path.join(tmp, "entry.ts");
  const j = (p) => JSON.stringify(path.join(ROOT, p));
  fs.writeFileSync(entry, `
export { parsePackText } from ${j("src/shared/qpack/parse.ts")};
export { normalizePack } from ${j("src/shared/qpack/normalize.ts")};
export { answerKeyOf, composeSolution, fingerprintSource, storedQuestionOf, refsInContent, allContents } from ${j("src/shared/qpack/compose.ts")};
export { renderMarkdown, ensureMath } from ${j("src/client/render.ts")};`);
  const out = path.join(tmp, "app.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", nodePaths: [path.join(ROOT, "node_modules")] });
  const app = await import(pathToFileURL(out).href);
  await app.ensureMath();
  fs.rmSync(tmp, { recursive: true, force: true });
  return app;
}

export class Verdict {
  constructor(gate) { this.gate = gate; this.checks = []; this.selftest = null; }
  add(id, status, message, { examined, expected = null, locator = null, details = null, zeroOk = false } = {}) {
    if (status === "PASS" || status === "INFO") {   // R14: no vacuous passes
      if (expected !== null && examined < expected) { status = "FAIL"; message = `vacuous: examined ${examined} of ${expected} expected. ${message}`; }
      else if (examined === 0 && !zeroOk) { status = "FAIL"; message = `vacuous: examined nothing. ${message}`; }
    }
    const c = { id, status, message, examined, expected };
    if (locator) c.locator = locator;
    if (details !== null) c.details = details;
    this.checks.push(c);
    return status;
  }
  get status() {
    let worst = "PASS";
    for (const c of this.checks) if (ORDER[c.status] > ORDER[worst]) worst = c.status;
    if (this.selftest && this.selftest.status === "FAIL") worst = "FAIL";
    return worst;
  }
  write(file) {
    const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sort({ gate: this.gate, selftest: this.selftest, status: this.status, checks: this.checks }), null, 2) + "\n");
  }
}

/** Words (letters, digits, marks) and single symbols. Whitespace of every kind only separates. */
export const tokens = (text) => String(text ?? "").normalize("NFC").match(/[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu) ?? [];
/** Digits, decimal points inside numbers, and operators: what G3.numerals compares. */
export const numerals = (text) => String(text ?? "").normalize("NFC").match(/\d+(?:[.,]\d+)*|[+\-−×÷=<>%/^]/gu) ?? [];

export function bag(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
export function bagDiff(a, b) {   // what a has that b lacks, and the reverse
  const onlyA = [], onlyB = [];
  for (const [t, n] of a) if ((b.get(t) ?? 0) < n) onlyA.push(`${t}×${n - (b.get(t) ?? 0)}`);
  for (const [t, n] of b) if ((a.get(t) ?? 0) < n) onlyB.push(`${t}×${n - (a.get(t) ?? 0)}`);
  return { onlyA, onlyB };
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

export function loadRun(runDir) {
  const manifestInputs = readJson(path.join(runDir, "inputs", "inputs.json"));
  return {
    runDir,
    profile: readJson(path.join(runDir, "inputs", "profile.json")),
    job: readJson(path.join(runDir, "inputs", "job.json")),
    inputs: manifestInputs,
    packText: fs.readFileSync(path.join(runDir, "pack", "pack.json"), "utf8"),
    pack: readJson(path.join(runDir, "pack", "pack.json")),
    coverage: readJson(path.join(runDir, "coverage.json")),
    sourceBytes: fs.readFileSync(path.join(runDir, "source", manifestInputs.source.name)),
  };
}
