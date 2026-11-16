#!/usr/bin/env node
// Step-2 review (independent of fidelity.py): character-level comparison of what the APP WILL SHOW vs what the SOURCE SHOWS.
//  * pack side: every piece rendered with the app's real renderer (src/client/render.ts: marked + Temml -> HTML/MathML)
//  * source side: the original pages loaded in Chromium (Word files: raw paragraph text)
//  * both sides go through the SAME in-browser text extractor, which keeps bold as «…» and italics as ‹…›,
//    turns fractions (source spans or MathML <mfrac>) into "n/d", and skips screen-reader-only text, images and controls.
// Only ASCII whitespace runs are collapsed (non-breaking spaces must match exactly). Any difference is reported.
// Usage: node ingest/review_rendered.mjs        (exit 1 on any difference)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(import.meta.url)("playwright");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qreview-"));
fs.writeFileSync(path.join(tmp, "e.ts"), `
export { parsePackText } from ${JSON.stringify(ROOT + "/src/shared/qpack/parse.ts")};
export { normalizePack } from ${JSON.stringify(ROOT + "/src/shared/qpack/normalize.ts")};
export { renderMarkdown, ensureMath } from ${JSON.stringify(ROOT + "/src/client/render.ts")};`);
await build({ entryPoints: [path.join(tmp, "e.ts")], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "r.mjs"), logLevel: "silent", nodePaths: [ROOT + "/node_modules"] });
const R = await import(pathToFileURL(path.join(tmp, "r.mjs")).href);
await R.ensureMath();
const loadPack = (name) => JSON.parse(fs.readFileSync(`${ROOT}/ingest/packs/${name}.json`, "utf8"));
const md = (s) => (s == null ? "" : R.renderMarkdown(s));

// ------------------------------------------------------------------ shared extractor (runs in the browser)
const EXTRACT = `
window.__ext = function (root, opt) {
  opt = opt || {};
  let out = "";
  const BLOCK = new Set(["P","LI","DIV","TD","TH","TR","SECTION","BLOCKQUOTE","H1","H2","H3","H4","H5","H6","UL","OL","TABLE","FIGCAPTION","BR"]);
  const frac = (n, d) => " " + n.textContent.trim() + "/" + d.textContent.trim() + " ";
  function walk(n) {
    if (n.nodeType === 3) {
      let v = n.nodeValue;
      // whitespace that the page itself keeps visible (CSS pre-wrap / pre-line) must survive the comparison
      if (opt.preWrap && n.parentElement.closest(opt.preWrap)) v = v.replace(/ {2,}/g, (m) => " " + "\\u00a0".repeat(m.length - 1));
      if (opt.preLine && n.parentElement.closest(opt.preLine)) v = v.replace(/\\n/g, "⏎");
      out += v; return;
    }
    if (opt.br && n.nodeType === 1 && n.tagName === "BR") { out += opt.br; return; }
    if (n.nodeType !== 1) return;
    const t = n.tagName.toUpperCase(), cl = n.classList;
    if (["SCRIPT","STYLE","SVG","IMG","BUTTON","TEXTAREA","INPUT","ANNOTATION"].includes(t)) return;
    if (cl.contains("sr-only")) return;
    if (opt.skip && n.matches(opt.skip)) return;
    if (cl.contains("fr")) { out += frac(n.querySelector(".fr-n"), n.querySelector(".fr-d")); return; }
    if (t === "MFRAC") { out += frac(n.children[0], n.children[1]); return; }
    const bold = ["STRONG","B"].includes(t) || (opt.boldHeads && ["H3","H4"].includes(t));
    const ital = ["EM","I"].includes(t) || (opt.italic && n.matches(opt.italic));
    const blk = BLOCK.has(t) || (opt.blockSel && n.matches(opt.blockSel));
    if (blk) out += " ";
    if (opt.label && t === "LI" && n.parentElement.matches(opt.label)) out += "«(" + String.fromCharCode(97 + [...n.parentElement.children].indexOf(n)) + ")» ";
    if (opt.dash && cl.contains("wl-n")) out += " — ";
    if (bold) out += "«"; if (ital) out += "‹";
    for (const c of n.childNodes) walk(c);
    if (ital) out += "›"; if (bold) out += "»";
    if (blk) out += " ";
  }
  walk(root);
  return out;
};`;
const norm = (s) => s.replace(/[ \t\n\r]+/g, " ")
  .replace(/([«‹]) /g, " $1").replace(/ ([»›])/g, "$1 ")   // whitespace just inside a marker moves outside
  .replace(/[ \t\n\r]+/g, " ").replace(/«»|‹›/g, "").trim();

function diff(a, b) {
  if (a === b) return null;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return `…${a.slice(Math.max(0, i - 40), i)}⟦source: ${JSON.stringify(a.slice(i, a.length - j))} | pack: ${JSON.stringify(b.slice(i, b.length - j))}⟧${a.slice(a.length - j, a.length - j + 30)}…`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
const results = {};
const fail = (pack, id, where, d) => ((results[pack] ??= []).push(`${id} [${where}] ${d}`));
let compared = 0;
async function packText(html, opt = {}) {
  return norm(await page.evaluate(([h, o]) => { const d = document.createElement("div"); d.innerHTML = h; return window.__ext(d, o); }, [html, opt]));
}
function check(pack, id, where, src, got) { compared++; const d = diff(src, got); if (d) fail(pack, id, where, d); }

// ------------------------------------------------------------------ Word worksheets: rendered stem == raw paragraph text exactly
await page.setContent("<body></body>"); await page.evaluate(EXTRACT);
const DOCX = [["class5-calendar-sums", "Class_5_Calendar_Sums.docx"], ["class5-critical-thinking-calendar-sums", "Class_5_Critical_Thinking_Calendar_Sums.docx"],
  ["equally-spaced-objects-word-problems", "Equally_Spaced_Objects_Word_Problems.docx"], ["advanced-critical-thinking-math-worksheet", "advanced_critical_thinking_math_worksheet.docx"]];
function docxParas(file) { // minimal zip reader for word/document.xml (deflate)
  const buf = fs.readFileSync(path.join(ROOT, file)); let off = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(off + 10); let p = buf.readUInt32LE(off + 16);
  for (let k = 0; k < n; k++) {
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), com = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42), csize = buf.readUInt32LE(p + 20), method = buf.readUInt16LE(p + 10);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === "word/document.xml") {
      const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(ds, ds + csize); const xml = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
      const ent = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => ent([...m[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join(""))).filter((t) => t.trim());
    }
    p += 46 + nameLen + extra + com;
  }
}
for (const [name, file] of DOCX) {
  const pk = loadPack(name);
  const qs = docxParas(file).filter((t) => /^\d+\s*[.)]\s/.test(t));
  if (qs.length !== pk.questions.length) fail(name, "-", "count", `${qs.length} vs ${pk.questions.length}`);
  for (let i = 0; i < qs.length; i++) {
    const src = qs[i].replace(/^\d+\s*[.)]\s+/, "");
    const got = (await page.evaluate((h) => { const d = document.createElement("div"); d.innerHTML = h; return d.textContent; }, md(pk.questions[i].stem))).replace(/\n$/, "");
    compared++; if (src !== got) fail(name, pk.questions[i].id, "stem (exact)", diff(src, got));
  }
}

// ------------------------------------------------------------------ Geometry
{
  const name = "geometry-olympiad-achiever-100", pk = loadPack(name);
  await page.goto(pathToFileURL(path.join(ROOT, "Geometry_Olympiad_Achiever_100_Questions.html")).href); await page.evaluate(EXTRACT);
  const src = await page.evaluate(() => [...document.querySelectorAll("article.q")].map((a) => {
    const fin = a.querySelector(".solbody p.final").cloneNode(true); fin.querySelector("strong").remove();
    const sol = a.querySelector(".solbody").cloneNode(true); sol.querySelector("p.final").remove();
    const cap = a.querySelector("figcaption");
    return { id: a.id, title: a.querySelector(".qtitle").textContent, level: a.querySelector(".lvl").textContent,
      stmt: window.__ext(a.querySelector(".stmt")), cap: cap ? window.__ext(cap, { italic: "figcaption" }) : null,
      fin: window.__ext(fin), sol: window.__ext(sol, { boldHeads: true, preWrap: "ul.calc li" }), alts: [...a.querySelectorAll("svg")].map((s) => s.getAttribute("aria-label")) };
  }));
  for (let i = 0; i < src.length; i++) {
    const s = src[i], q = pk.questions[i];
    if (s.id !== q.id) { fail(name, q.id, "order", s.id); continue; }
    let chunks = q.stem.split("\n\n"), capMd = null;
    if (s.cap) capMd = chunks.pop();
    const imgs = chunks.filter((c) => /^!\[/.test(c)); chunks = chunks.filter((c) => !/^!\[/.test(c));
    let pq = await packText(md(chunks.join("\n\n")));
    if (q.parts) for (const p of q.parts) pq += " (" + p.label + ") " + (await packText(md(p.stem)));
    check(name, q.id, "question text", norm(s.stmt), norm(pq));
    if (s.cap) check(name, q.id, "caption", norm(s.cap), await packText(md(capMd)));
    // figure references: same count, same order, alt text = source aria-label
    const packAlts = [...q.stem.matchAll(/!\[([^\]]*)\]\(asset:[^)]+\)/g)].map((m) => m[1]);
    compared++; if (JSON.stringify(packAlts) !== JSON.stringify(s.alts.slice(0, packAlts.length).map((a) => a.replace(/\[/g, "(").replace(/\]/g, ")"))) || imgs.length !== packAlts.length) fail(name, q.id, "figures", JSON.stringify([packAlts, s.alts]));
    let pf = "";
    if (q.parts) for (const p of q.parts) pf += " (" + p.label + ") " + (await packText(md(p.answer)));
    else pf = await packText(md(q.solution.answer));
    // multi-part: the source separates "(a) … (b) …" with "&nbsp;" gaps; the pack gives each part its own answer, so only
    // the gap immediately before a part label is ignored
    const finSrc = q.parts ? norm(s.fin).replace(/[  ]+(?=\([a-z]\) )/g, " ") : norm(s.fin);
    check(name, q.id, "final answer", finSrc, norm(pf));
    if (q.type === "numeric") { compared++; if (`${q.answer.value} ${q.answer.unit}` !== norm(s.fin).replace(/ /g, " ")) fail(name, q.id, "numeric key", JSON.stringify(q.answer)); }
    check(name, q.id, "worked solution", norm(s.sol), await packText(md(q.solution.explanation)));
    compared += 2; if (q.title !== s.title) fail(name, q.id, "title", q.title); if (q.fields["Source difficulty"] !== s.level) fail(name, q.id, "level", s.level);
  }
}

// ------------------------------------------------------------------ Unitary
{
  const name = "unitary-method-olympiad-course", pk = loadPack(name);
  await page.goto(pathToFileURL(path.join(ROOT, "UNITARY METHOD.html")).href); await page.evaluate(EXTRACT);
  const src = await page.evaluate(() => [...document.querySelectorAll("article.q")].map((a) => {
    const sol = a.querySelector("details.answer .solution").cloneNode(true);
    sol.querySelector("p.trained").remove();
    sol.querySelector(".sol-answer h3").remove();
    return { id: a.dataset.id, title: a.querySelector(".q-title").textContent,
      diff: a.querySelector("p.diff").textContent.replace(/\s+/g, " ").trim(),
      skills: a.querySelector("p.trained").textContent,
      prob: window.__ext(a.querySelector(".problem")), nudge: window.__ext(a.querySelector(".nudge-own")),
      sol: window.__ext(sol, { boldHeads: true, label: "ol.parts", italic: ".wl-n", dash: true }) };
  }));
  for (let i = 0; i < src.length; i++) {
    const s = src[i], q = pk.questions[i];
    if (s.id !== q.number) { fail(name, q.id, "order", s.id); continue; }
    let pp = await packText(md(q.stem));
    for (const p of q.parts ?? []) pp += " " + (await packText(md(p.stem)));
    check(name, q.id, "problem", norm(s.prob), norm(pp));
    check(name, q.id, "hint", norm(s.nudge), await packText(md(q.hints.join("\n\n"))));
    check(name, q.id, "answer + solution", norm(s.sol), norm((await packText(md(q.solution.answer))) + " " + (await packText(md(q.solution.explanation)))));
    if (q.type === "open") { compared++; if (q.answer !== q.solution.answer) fail(name, q.id, "answer", "answer != solution.answer"); }
    compared += 3;
    if (q.title !== s.title) fail(name, q.id, "title", q.title);
    if (s.skills.trim() !== `Thinking skills in this problem: ${q.fields["Cognitive skill"]}.`) fail(name, q.id, "skills", s.skills);
    if (!s.diff.endsWith(`Difficulty ${q.fields["Difficulty rating"]} of 4: ${q.fields["Source difficulty"]}`)) fail(name, q.id, "difficulty", s.diff);
  }
}

// ------------------------------------------------------------------ Grammar: rendered text == the page's own data (evaluated in the page itself)
{
  const name = "grammar-midterm-mastery-assessment", pk = loadPack(name);
  await page.goto(pathToFileURL(path.join(ROOT, "grammar_midterm_mastery_assessment.html")).href); await page.evaluate(EXTRACT);
  // the page renders every question into the DOM; read what a student actually sees there
  await page.waitForSelector(".question-card");
  const src = await page.evaluate(() => [...document.querySelectorAll(".question-card")].map((c) => ({
    id: c.dataset.id, number: c.querySelector(".question-number").textContent.replace("Question ", ""),
    prompt: window.__ext(c.querySelector(".question-prompt"), { preLine: ".question-prompt" }),
    options: [...c.querySelectorAll(".option")].map((o) => ({ letter: o.querySelector(".option-letter").textContent, text: o.querySelector(".option-text").textContent, value: o.querySelector("input").value })),
    blocks: [...c.querySelectorAll(".explain-block")].map((b) => [b.querySelector("h4").textContent, b.querySelector("p").textContent]),
  })));
  const data = await page.evaluate(() => QUESTIONS.map((q) => ({ id: q.id, type: q.type, answer: q.answer })));
  const byId = new Map(data.map((d) => [d.id, d]));
  if (src.length !== pk.questions.length) fail(name, "-", "count", `${src.length} vs ${pk.questions.length}`);
  for (let i = 0; i < src.length; i++) {
    const s = src[i], q = pk.questions[i], d = byId.get(s.id);
    if (s.id !== q.id || s.number !== q.number) { fail(name, q.id, "order/number", `${s.id} ${s.number}`); continue; }
    check(name, q.id, "prompt", norm(s.prompt).replace(/ ?⏎ ?/g, "⏎"), (await packText(md(q.stem), { br: "⏎" })).replace(/ ?⏎ ?/g, "⏎"));
    for (let k = 0; k < s.options.length; k++) {
      const o = q.options?.[k];
      compared++; if (!o || o.label !== s.options[k].letter) { fail(name, q.id, "option label", JSON.stringify(s.options[k])); continue; }
      check(name, q.id, `option ${o.label}`, s.options[k].text, await packText(md(o.text)));
    }
    compared++;
    if (d.type === "single" || d.type === "multi") {
      const want = (Array.isArray(d.answer) ? d.answer : [d.answer]).map((v) => s.options.find((o) => o.value === v).letter).sort().join(",");
      const got = (Array.isArray(q.answer) ? q.answer : [q.answer]).slice().sort().join(",");
      if (want !== got) fail(name, q.id, "answer key", `${want} vs ${got}`);
    } else if (d.type === "input") { if (JSON.stringify(d.answer) !== JSON.stringify(q.answer)) fail(name, q.id, "accepted answers", JSON.stringify([d.answer, q.answer])); }
    else if ((await packText(md(q.answer))) !== norm(d.answer)) fail(name, q.id, "model answer", "differs");
    // explanation: every block the page shows (heading + text), in the page's order
    const shown = s.blocks.map(([h, t]) => `${h}: ${t}`);
    const corr = shown.shift(); // "Correct answer / model answer: ..."
    const expl = await packText(md(q.solution.explanation));
    const expectExpl = norm((d.type === "open" ? ["«" + corr.replace(/^([^:]+): /, "$1:» ")] : []).concat(shown.map((x) => "«" + x.replace(/^([^:]+): /, "$1:» "))).join(" "));
    // page heading "Remember this" etc. match the pack's bold labels
    check(name, q.id, "explanation", expectExpl, expl);
    const solAns = await packText(md(q.solution.answer));
    check(name, q.id, d.type === "open" ? "model answer shown" : "correct answer shown", d.type === "open" ? norm(d.answer) : norm(corr.replace(/^[^:]+: /, "")), solAns);
  }
}

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
const nFail = Object.values(results).reduce((n, v) => n + v.length, 0);
for (const [p, v] of Object.entries(results)) { console.log(`\n${p}: ${v.length} difference(s)`); v.slice(0, 15).forEach((x) => console.log("  " + x)); }
console.log(`\n${compared} comparisons; ${nFail} difference(s)`);
process.exit(nFail ? 1 : 0);
