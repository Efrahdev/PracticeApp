#!/usr/bin/env node
// Validates question packs with the app's own reader: node tools/ingest/validate.mjs <pack.json|pack.zip> ...
// Bundles src/shared/qpack (parse + normalize) with the repo's esbuild into a temp dir, then runs it.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node tools/ingest/validate.mjs <pack.json|pack.zip> ...");
  process.exit(2);
}

const { build } = await import(pathToFileURL(join(root, "node_modules/esbuild/lib/main.js")).href);
const { unzipSync, strFromU8 } = await import(pathToFileURL(join(root, "node_modules/fflate/esm/browser.js")).href);

const tmp = mkdtempSync(join(tmpdir(), "qpack-validate-"));
let code = 0;
try {
  const entry = join(tmp, "entry.ts");
  writeFileSync(entry, `export { parsePackText } from ${JSON.stringify(join(root, "src/shared/qpack/parse.ts"))};\nexport { normalizePack } from ${JSON.stringify(join(root, "src/shared/qpack/normalize.ts"))};\n`);
  const out = join(tmp, "bundle.mjs");
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent", absWorkingDir: root, nodePaths: [join(root, "node_modules")] });
  const { parsePackText, normalizePack } = await import(pathToFileURL(out).href);

  for (const f of files) {
    console.log(`\n=== ${f}`);
    let text, name = basename(f), zipEntries = null;
    const buf = readFileSync(f);
    if (/\.zip$/i.test(f)) {
      zipEntries = unzipSync(new Uint8Array(buf));
      const names = Object.keys(zipEntries).filter((n) => !n.endsWith("/"));
      const cand = names.filter((n) => /(^|\/)[^/]*\.(json|ya?ml)$/i.test(n)).sort((a, b) => a.split("/").length - b.split("/").length);
      const pick = cand.find((n) => /(^|\/)pack\.(json|ya?ml)$/i.test(n)) ?? cand[0];
      if (!pick) { console.log("ERROR: no pack.json/.yaml in the zip"); code = 1; continue; }
      console.log(`zip: ${names.length} files, pack file: ${pick}`);
      text = strFromU8(zipEntries[pick]);
      name = pick;
    } else text = buf.toString("utf8");

    let pack, parsed;
    try {
      parsed = parsePackText(text, name);
      pack = normalizePack(parsed.value, { fileName: name });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      code = 1;
      continue;
    }
    if (parsed.repairs || parsed.fixes.length) console.log(`reader repairs: ${parsed.repairs} LaTeX; fixes: ${parsed.fixes.join(", ") || "none"}`);
    const qs = pack.questions;
    const byType = {};
    for (const q of qs) byType[q.type] = (byType[q.type] ?? 0) + 1;
    const hasAns = (q) => !!q.answer || q.parts.some((p) => p.answer);
    const hasSol = (q) => !!q.solution || q.parts.some((p) => p.solution);
    console.log(`pack: ${pack.id ?? "(no id)"} | ${pack.title ?? ""} | key=${pack.key}`);
    console.log(`questions: ${qs.length}`);
    console.log(`by type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(`with answer: ${qs.filter(hasAns).length}   with solution: ${qs.filter(hasSol).length}   assets: ${Object.keys(pack.assets).length}`);

    const groups = new Map();
    const add = (level, message, where) => {
      const k = `${level}\u0000${message}`;
      if (!groups.has(k)) groups.set(k, { level, message, where: [] });
      groups.get(k).where.push(where);
    };
    for (const i of pack.issues) add(i.level, i.message, "pack");
    for (const q of qs) for (const i of q.issues) add(i.level, i.message, q.number ?? q.id ?? `#${q.index + 1}`);
    let errors = 0, warnings = 0;
    for (const g of [...groups.values()].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))) {
      if (g.level === "error") errors += g.where.length; else warnings += g.where.length;
      const w = g.where.length > 30 ? g.where.slice(0, 30).join(", ") + `, … (${g.where.length} total)` : g.where.join(", ");
      console.log(`${g.level.toUpperCase()}: ${g.message}  [${w}]`);
    }
    console.log(`issues: ${errors} error(s), ${warnings} warning(s)`);

    // asset references
    const refs = new Map();
    const scan = (v, who) => {
      if (typeof v === "string") for (const m of v.matchAll(/asset:([^\s)"'<>\]]+)/g)) (refs.get(m[1]) ?? refs.set(m[1], new Set()).get(m[1])).add(who);
      else if (Array.isArray(v)) v.forEach((x) => scan(x, who));
      else if (v && typeof v === "object") Object.values(v).forEach((x) => scan(x, who));
    };
    for (const q of qs) scan({ ...q, issues: undefined }, q.number ?? q.id ?? `#${q.index + 1}`);
    const missing = [...refs].filter(([n]) => !pack.assets[n]);
    for (const [n, who] of missing) { console.log(`ERROR: asset:${n} has no matching asset  [${[...who].join(", ")}]`); errors++; }
    const unused = Object.keys(pack.assets).filter((n) => !refs.has(n));
    if (unused.length) console.log(`WARNING: assets never referenced: ${unused.join(", ")}`);
    console.log(`asset references: ${refs.size} distinct, ${missing.length} unmatched`);
    for (const a of Object.values(pack.assets)) {
      if (a.file) {
        if (!zipEntries) console.log(`note: asset ${a.name} uses file "${a.file}" (cannot be checked outside a zip)`);
        else {
          const rel = a.file.replace(/^\.?\//, "");
          const ok = Object.keys(zipEntries).some((n) => n === rel || n.endsWith("/" + rel));
          if (!ok) { console.log(`ERROR: asset ${a.name} file "${a.file}" is not in the zip`); errors++; }
        }
      }
    }
    if (errors) code = 1;
    console.log(errors ? "RESULT: FAIL" : "RESULT: OK");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
