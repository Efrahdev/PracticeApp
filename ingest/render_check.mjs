#!/usr/bin/env node
// Render every piece of every pack through the app's REAL renderer (src/client/render.ts: marked + Temml) and look for
// anything that would show wrongly: LaTeX errors, leftover Markdown/escape characters, stray "$", broken images.
// Read-only. Usage: node ingest/render_check.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qrender-"));
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, `
export { parsePackText } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/parse.ts"))};
export { normalizePack } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/normalize.ts"))};
export { composeSolution, mdOf, allContents } from ${JSON.stringify(path.join(ROOT, "src/shared/qpack/compose.ts"))};
export { renderMarkdown, ensureMath } from ${JSON.stringify(path.join(ROOT, "src/client/render.ts"))};
`);
const out = path.join(tmp, "r.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", nodePaths: [path.join(ROOT, "node_modules")] });
const R = await import(pathToFileURL(out).href);
await R.ensureMath();

const textOf = (html) => html.replace(/<math[\s\S]*?<\/math>/g, " MATH ").replace(/<img[^>]*>/g, " IMG ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const problems = [];
let pieces = 0, maths = 0, imgs = 0, quotes = 0, breaks = 0;
for (const f of fs.readdirSync(path.join(ROOT, "ingest/packs")).filter((x) => x.endsWith(".json")).sort()) {
  const pack = R.normalizePack(R.parsePackText(fs.readFileSync(path.join(ROOT, "ingest/packs", f), "utf8")).value, { fileName: f });
  for (const q of pack.questions) {
    const mds = [];
    for (const c of R.allContents(q)) if (c.md !== undefined) mds.push(["content", c.md]);
    const sol = R.composeSolution(q);
    if (sol) mds.push(["solution", sol.body]);
    for (const [where, md] of mds) {
      const report = { mathErrors: [] };
      const html = R.renderMarkdown(md, report);
      pieces++;
      maths += (html.match(/<math/g) || []).length;
      imgs += (html.match(/<img/g) || []).length;
      quotes += (html.match(/<blockquote/g) || []).length;
      breaks += (html.match(/<br/g) || []).length;
      const t = textOf(html);
      const bad = [];
      if (report.mathErrors.length) bad.push("math error: " + report.mathErrors[0]);
      if (/\*\*|\\[\\`*_\[\]<>|~$&(]/.test(t)) bad.push("leftover markdown/escape characters: " + (t.match(/.{0,25}(\*\*|\\[\\`*_\[\]<>|~$&(]).{0,25}/) || [""])[0]);
      if (/\$/.test(t)) bad.push("stray $: " + (t.match(/.{0,25}\$.{0,25}/) || [""])[0]);
      if (/&amp;(amp|lt|gt|quot|#\d+);/.test(html)) bad.push("double-encoded entity (an escaped & was decoded twice)");
      if (/<img[^>]*src="asset:/.test(html) === false && /!\[/.test(md)) bad.push("image reference was not turned into an <img>");
      if (bad.length) problems.push(`${pack.key} ${q.id} (${where}): ${bad.join(" | ")}`);
    }
  }
}
console.log(`rendered ${pieces} pieces: ${maths} maths expressions, ${imgs} images, ${quotes} block quotes, ${breaks} line breaks`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.slice(0, 25).join("\n") : "no rendering problems found");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
