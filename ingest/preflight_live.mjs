#!/usr/bin/env node
// READ-ONLY look at the live library before step 3: which of these questions (by content fingerprint or by
// permanent reference "<pack id>/<question id>") are already there? Runs SELECTs only; writes nothing anywhere.
// Needs outbound access to api.cloudflare.com (credentials are injected by the environment's proxy).
// Fingerprints are computed exactly as src/client/importer.ts does for packs WITHOUT images; packs with images
// (geometry) hash image bytes too, so only their references are compared.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qlive-"));
fs.writeFileSync(path.join(tmp, "e.ts"), `
export { parsePackText } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/parse.ts"))};
export { normalizePack } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/normalize.ts"))};
export { fingerprintSource, storedQuestionOf } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/compose.ts"))};`);
await build({ entryPoints: [path.join(tmp, "e.ts")], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "q.mjs"), logLevel: "silent" });
const Q = await import(pathToFileURL(path.join(tmp, "q.mjs")).href);

const wr = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
const DB = wr.match(/"database_id":\s*"([^"]+)"/)[1];
const accounts = await (await fetch("https://api.cloudflare.com/client/v4/accounts")).json();
const ACC = accounts.result[0].id;
const query = async (sql, params = []) => {
  const r = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql, params }) })).json();
  if (!r.success) throw new Error(JSON.stringify(r.errors));
  return r.result[0].results;
};

let totalHash = 0, totalRef = 0;
for (const f of fs.readdirSync(path.join(ROOT, "ingest/packs")).filter((x) => x.endsWith(".json")).sort()) {
  const pack = Q.normalizePack(Q.parsePackText(fs.readFileSync(path.join(ROOT, "ingest/packs", f), "utf8")).value, { fileName: f });
  const hasImages = Object.keys(pack.assets).length > 0;
  const refs = pack.questions.map((q) => q.ref);
  let refHits = 0, hashHits = 0;
  for (let i = 0; i < refs.length; i += 50) {
    const chunk = refs.slice(i, i + 50);
    refHits += (await query(`SELECT external_ref FROM question WHERE external_ref IN (${chunk.map(() => "?").join(",")})`, chunk)).length;
  }
  if (!hasImages) {
    const hashes = pack.questions.map((q) => crypto.createHash("sha256").update(Q.fingerprintSource(Q.storedQuestionOf(q, pack.css))).digest("hex"));
    for (let i = 0; i < hashes.length; i += 50) {
      const chunk = hashes.slice(i, i + 50);
      hashHits += (await query(`SELECT content_sha256 FROM question_version WHERE content_sha256 IN (${chunk.map(() => "?").join(",")})`, chunk)).length;
    }
  }
  totalHash += hashHits; totalRef += refHits;
  console.log(`${f}: ${pack.questions.length} questions | already in library by reference: ${refHits} | by identical content: ${hasImages ? "n/a (has images)" : hashHits}`);
}
console.log(totalHash + totalRef === 0 ? "\nNothing here exists in the library yet: all questions will import as NEW." : `\nOverlap found: ${totalRef} by reference, ${totalHash} by content (the importer will report these as already there / new version).`);
fs.rmSync(tmp, { recursive: true, force: true });
