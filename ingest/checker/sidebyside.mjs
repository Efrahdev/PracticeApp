#!/usr/bin/env node
// Builds the side-by-side page: the source's own markup on the left, what the app's renderer will show on the right.
// Usage: node ingest/checker/sidebyside.mjs RUN_DIR ITEMS.json OUT.html review|try
// The left side never runs source scripts: it is shown in a sandboxed iframe with scripts removed.
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { loadApp, loadRun, readJson } from "./lib.mjs";
import { regionImages } from "./pagecheck.mjs";

const [, , runDirArg, itemsFile, outFile, mode] = process.argv;
if (!runDirArg || !itemsFile || !outFile) { console.error("usage: sidebyside.mjs RUN_DIR ITEMS.json OUT.html review|try"); process.exit(30); }
const run = loadRun(path.resolve(runDirArg));
const app = await loadApp();
const items = readJson(itemsFile);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kind = run.profile.source.kind;
const containers = run.coverage.containers ?? {};
const assets = run.pack.assets ?? {};

// ---- left: the source
let sourceOf;
const PAGE_KINDS = new Set(["pdf", "image", "office", "html-print"]);
if (PAGE_KINDS.has(kind)) {
  // the question's region, rendered independently (Poppler for PDFs; the original image for scans/screenshots),
  // written once per page next to the page and shown through a window onto it
  const dir = path.join(path.dirname(outFile), "pages");
  fs.mkdirSync(dir, { recursive: true });
  const written = new Set();
  sourceOf = (qid) => {
    const regions = regionImages(run, qid, dir);
    if (!regions.length) return "<p>(no region recorded)</p>";
    return regions.map((r) => {
      const ext = r.type && r.type !== "image/png" ? (r.type.split("/")[1] || "img") : "png";
      const file = `p${r.page}.${ext}`;
      if (!written.has(file)) { fs.writeFileSync(path.join(dir, file), Buffer.from(r.png, "base64")); written.add(file); }
      const pad = 6, x = Math.max(0, r.box[0] - pad) * r.scale, y = Math.max(0, r.box[1] - pad) * r.scale;
      const w = (r.box[2] - r.box[0] + 2 * pad) * r.scale, h = (r.box[3] - r.box[1] + 2 * pad) * r.scale;
      return `<div class="cap">page ${r.page}</div><div class="win" style="width:${Math.round(w)}px;height:${Math.round(h)}px"><img src="pages/${file}" style="left:${-Math.round(x)}px;top:${-Math.round(y)}px;width:${Math.round(r.size[0] * r.scale)}px" alt="page ${r.page}"></div>`;
    }).join("");
  };
} else if (kind === "html") {
  const $ = cheerio.load(new TextDecoder().decode(run.sourceBytes), { scriptingEnabled: false });
  const styles = $("style").toArray().map((s) => $(s).text()).join("\n").replace(/<\/style/gi, "");
  const els = $(run.profile.segment.selector).toArray();
  const byId = new Map(run.pack.questions.map((q, i) => [q.id, els[i]]));
  sourceOf = (qid) => {
    const el = byId.get(qid);
    if (!el) return "<p>(source container not found)</p>";
    const c = $(el).clone();
    c.find("script").remove();
    c.find("details").attr("open", "open");
    c.find("[hidden]").removeAttr("hidden");
    const doc = `<!doctype html><meta charset="utf-8"><style>${styles}</style><style>html,body{margin:0;padding:8px;background:#fff}*{animation:none!important}.js-only{display:revert}</style>${$.html(c)}`;
    return `<iframe sandbox srcdoc="${esc(doc)}" loading="lazy" class="src"></iframe>`;
  };
} else {
  sourceOf = (qid) => {
    const where = containers[qid];
    const mine = run.coverage.blocks.filter((b) => !b.dom && (b.locator === where || b.locator.startsWith(where + ".") || b.locator.startsWith(where + "[") || b.locator.startsWith(where + " ")));
    const shared = run.coverage.blocks.filter((b) => b.status === "claimed" && !mine.includes(b) && b.by.some((c) => c.q === qid));
    const row = (b) => `<tr><td class="loc">${esc(b.locator.replace(where, "") || "(paragraph)")}</td><td class="${b.status}">${esc(b.text)}</td></tr>`;
    return `<table class="raw">${mine.concat(shared).map(row).join("")}</table>`;
  };
}

// ---- right: the pack question through the app's renderer
const md = (s) => {
  const report = { mathErrors: [] };
  let html = app.renderMarkdown(String(s), report);
  html = html.replace(/src="asset:([^"]+)"/g, (m, name) => !assets[name] ? m : assets[name].base64
    ? `src="data:${assets[name].type};base64,${assets[name].base64}"` : `src="data:image/svg+xml;base64,${Buffer.from(assets[name].data, "utf8").toString("base64")}"`);
  return html + (report.mathErrors.length ? `<p class="err">maths error: ${esc(report.mathErrors[0])}</p>` : "");
};
const answerHtml = (a) => a === undefined || a === null ? "" : typeof a === "string" ? md(a) : Array.isArray(a) ? esc(a.join("  |  ")) : `<code>${esc(a.value)}${a.unit ? " " + esc(a.unit) : ""}</code> (numeric key, auto-marked)`;
function packOf(q) {
  const out = [];
  out.push(`<div class="meta">${esc(q.type)}${q.difficulty ? " · " + esc(q.difficulty) : ""}${q.topics ? " · " + esc(q.topics.map((t) => t.name ?? t).join("; ")) : ""}</div>`);
  if (q.title) out.push(`<h4>${esc(q.title)}</h4>`);
  if (q.stem) out.push(`<div class="f"><b class="k">stem</b>${md(q.stem)}</div>`);
  if (q.options) out.push(`<div class="f"><b class="k">options</b><ol type="A">${q.options.map((o) => `<li>${md(o.text)}</li>`).join("")}</ol></div>`);
  for (const p of q.parts ?? []) out.push(`<div class="f part"><b class="k">part (${esc(p.label)})</b>${md(p.stem ?? "")}${p.answer !== undefined ? `<div class="ans"><b class="k">answer (${esc(p.label)})</b>${answerHtml(p.answer)}</div>` : ""}</div>`);
  if (q.answer !== undefined) out.push(`<div class="f ans"><b class="k">answer</b>${answerHtml(q.answer)}</div>`);
  for (const h of q.hints ?? []) out.push(`<div class="f"><b class="k">hint</b>${md(h)}</div>`);
  if (q.solution && typeof q.solution === "object") {
    if (q.solution.answer) out.push(`<div class="f ans"><b class="k">solution: final answer</b>${md(q.solution.answer)}</div>`);
    if (q.solution.explanation) out.push(`<div class="f"><b class="k">solution</b>${md(q.solution.explanation)}</div>`);
  }
  if (q.notes) out.push(`<div class="f"><b class="k">notes</b>${md(q.notes)}</div>`);
  if (q.fields) out.push(`<div class="meta">${Object.entries(q.fields).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</div>`);
  return out.join("\n");
}

const rows = items.map((it) => `
<section class="item" id="${esc(it.key)}">
  <h3><span class="key">${esc(it.key)}</span> question ${esc(it.question.number ?? "")} <code>${esc(it.question_id)}</code> <span class="why">${esc((it.why ?? []).join(" · "))}</span></h3>
  <div class="cols"><div class="col"><div class="cap">SOURCE (as the paper shows it)</div>${sourceOf(it.question_id)}</div>
  <div class="col"><div class="cap">PACK (as the app will show it)</div><div class="pack">${packOf(it.question)}</div></div></div>
</section>`).join("\n");

const title = mode === "review" ? `Review packet — ${run.job.pack.id}` : `Profile trial — ${run.job.pack.id}`;
const lead = mode === "review"
  ? `<p>${items.length} items. Read <a href="assurance.md">assurance.md</a> first (what was and was not checked), then <a href="decisions-made.md">decisions-made.md</a>. Give one verdict per item in <code>approval.template.json</code>. <b>Some items were corrupted on purpose</b>: marking one of them <code>ok</code> voids the approval.</p>`
  : `<p>A trial of the profile: ${items.length} sample questions. Nothing here can be approved or imported.</p>`;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#17202a;--muted:#5d6b78;--line:#d5dbe1;--accent:#1d4f7c;--ans:#eef6ee}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--card:#1d232a;--ink:#e6eaee;--muted:#9aa7b3;--line:#333c46;--accent:#8fbde6;--ans:#1f2e22}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:1500px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0}h3{font-size:15px;margin:0 0 8px}h4{margin:4px 0}
.item{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:14px 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:900px){.cols{grid-template-columns:1fr}}
.col{min-width:0}.cap{font-size:11px;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
iframe.src{width:100%;height:520px;border:1px solid var(--line);border-radius:6px;background:#fff}
.pack{border:1px solid var(--line);border-radius:6px;padding:8px 12px;max-height:520px;overflow:auto}
.pack img{max-width:100%;background:#fff}.win{position:relative;overflow:hidden;max-width:100%;border:1px solid var(--line);background:#fff}.win img{position:absolute;max-width:none}.f{margin:6px 0;padding-top:4px;border-top:1px dashed var(--line)}
.k{display:block;font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:.05em}
.ans{background:var(--ans)}.part{margin-left:14px}.meta{font-size:12px;color:var(--muted)}.err{color:#c0392b}
.key{background:var(--accent);color:var(--card);border-radius:4px;padding:1px 6px;font-size:12px}.why{font-weight:400;color:var(--muted);font-size:12px}
table.raw{border-collapse:collapse;width:100%;font-size:13px}table.raw td{border:1px solid var(--line);padding:3px 6px;vertical-align:top;white-space:pre-wrap}
td.loc{color:var(--muted);font-size:11px;width:28%;word-break:break-all}td.ignored{opacity:.5;text-decoration:line-through}
table{border-collapse:collapse}.pack td,.pack th{border:1px solid var(--line);padding:2px 6px}blockquote{margin:4px 0;padding-left:10px;border-left:3px solid var(--line)}
</style></head><body><main><h1>${esc(title)}</h1>${lead}${rows}</main></body></html>`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, page);
