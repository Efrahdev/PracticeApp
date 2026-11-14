// End-to-end walk through the real UI against `wrangler dev` (local D1 + R2), starting
// from an EMPTY database. Usage: BASE=http://127.0.0.1:8787 node tests/e2e.mjs [screenshotDir]
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const shots = process.argv[2];
const log = (...a) => console.log("✓", ...a);
const fail = (m) => { throw new Error(m); };
const fractions = path.resolve("docs/examples/fractions-pack.json");
const mixed = path.resolve("docs/examples/mixed-pack.yaml");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "x" : undefined));
const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }));
const frameText = async (locator) => (await locator.contentFrame().locator("body").innerText());

// 1. Import page: prompt carries the format and my labels
await page.goto(`${BASE}/#/import`);
await page.getByRole("button", { name: "View prompt" }).click();
const prompt = await page.locator(".modal textarea").inputValue();
if (!prompt.includes("practice-app/question-pack@1") || !prompt.includes("Foundation, Challenge, Achiever")) fail("prompt missing format or labels");
await page.locator(".modal .btn.primary", { hasText: "Close" }).click();
log("AI prompt includes the format and current difficulty labels");

// 2. Upload two packs (JSON + YAML) at once
await page.setInputFiles('input[type=file]', [fractions, mixed]);
await page.getByRole("button", { name: "Check" }).click();
await page.getByText("9 new · 0 changed · 0 already in library").waitFor();
const items = page.locator(".review-item");
await items.nth(0).getByRole("button", { name: "Preview" }).click();
await items.nth(1).getByRole("button", { name: "Preview" }).click();
const q1 = items.nth(0).locator("iframe.qframe").first();
await q1.contentFrame().locator('img[src^="data:image/svg+xml"]').waitFor();
await items.nth(1).locator("iframe.qframe").first().contentFrame().locator("math").first().waitFor();
if ((await q1.getAttribute("sandbox")) !== "allow-same-origin") fail("preview frame is not sandboxed");
log("review: 9 new, previews render LaTeX as MathML and the SVG figure from assets");
await shot("1-import-review");
await page.getByRole("button", { name: "Save 9 questions" }).click();
await page.getByText("Import finished").waitFor();
log("saved 9 questions from 2 packs");

// 3. Paste a re-converted pack (as an AI would send it: chat text, code fence, single backslashes)
const base = JSON.parse(fs.readFileSync(fractions, "utf8"));
base.questions[1].stem = base.questions[1].stem.replace("exactly 12 boys", "exactly 15 boys"); // q2 changed
base.questions[2].solution = "Divide top and bottom by 2 to get $\\frac{3}{4}$, so the answer is B."; // q3 new solution
const pasted = "Here is your pack:\n```json\n" + JSON.stringify(base, null, 1).replace(/\\\\/g, "\\") + "\n```\nLet me know if you need more!";
await page.getByRole("button", { name: "Import more" }).click();
await page.locator("textarea").fill(pasted);
await page.getByRole("button", { name: "Check" }).click();
await page.getByText("0 new · 1 changed · 4 already in library").waitFor();
await page.getByText(/Repaired \d+ LaTeX backslash/).waitFor();
log("pasted AI reply: fence removed, LaTeX backslashes repaired, q2 = new version, rest recognised");
await page.getByRole("button", { name: /^Save 1 question$/ }).click();
await page.getByText("Import finished").waitFor();
const doneRow = await page.locator("table.table tbody tr").first().innerText();
if (!/\t0\t1\t4\t0\t1$/.test(doneRow.replace(/ +/g, ""))) fail("unexpected result row: " + doneRow);
log("re-import: 1 new version, 4 already had, 1 solution refreshed");

// 4. Library + filters
await page.goto(`${BASE}/#/`);
await page.getByText("9 matches").waitFor();
await page.selectOption('select[aria-label="Add condition"]', "field");
await page.locator(".fcond select").first().selectOption({ label: "Collection" });
await page.getByText("5 matches").waitFor();
await page.getByRole("button", { name: "Clear" }).click();
await page.selectOption('select[aria-label="Add condition"]', "has_solution");
await page.locator(".fcond select").first().selectOption("unverified");
await page.getByText("1 match", { exact: true }).waitFor();
log("filters: custom field Collection → 5; AI solution not verified → 1");
await shot("2-library");

// 5. Approve the AI solution; check the refreshed solution of q3
await page.locator(".qrow a").first().click();
await page.getByText("AI-written · unverified").first().waitFor();
await page.getByRole("button", { name: "mark it verified" }).click();
await page.getByText("Solution verified").waitFor();
log("AI solution approved (FR-1.10)");
await page.goto(`${BASE}/#/`);
await page.getByRole("button", { name: "Clear" }).click();
await page.locator('input[type=search]').count();
await page.selectOption('select[aria-label="Add condition"]', "text");
await page.locator('.fcond input[type=search]').fill("equivalent");
await page.getByText("1 match", { exact: true }).waitFor();
await page.locator(".qrow a").first().click();
await page.getByRole("button", { name: "Show solution" }).click();
const solFrame = page.locator("section", { hasText: "Solution" }).locator("iframe.qframe").last();
await solFrame.contentFrame().getByText("Divide top and bottom by 2 to get").waitFor();
await solFrame.contentFrame().locator("math").first().waitFor();
log("solution on demand: refreshed solution shown, with maths");
await shot("3-question");

// 6. Paper WITHOUT solutions: practise everything
await page.goto(`${BASE}/#/`);
await page.getByRole("button", { name: "Clear" }).click();
await page.getByText("9 matches").waitFor();
await page.getByRole("button", { name: "Build paper" }).click();
await page.locator('label.field:has-text("Number of questions") input').fill("9");
await page.locator('label.field:has-text("Name") input').fill("Test paper");
await page.getByLabel(/No solutions/).check();
await page.getByRole("button", { name: /Save paper \(9\)/ }).click();
await page.getByText("No solutions", { exact: true }).waitFor();
log("paper saved with solutions left out");
await page.getByRole("link", { name: "Start" }).click();
for (let i = 1; i <= 9; i++) {
  await page.getByText(`Question ${i} of 9`).waitFor();
  await page.locator("iframe.qframe").first().contentFrame().locator("body").waitFor();
  if (await page.getByRole("button", { name: "Show solution" }).count()) fail("solution button visible in a no-solutions paper");
  if (await page.locator(".chips.answer").count()) {
    await page.locator(".chips.answer .chip").first().click();
    await page.getByRole("button", { name: "Check answer" }).click();
  } else if (await page.locator('.answer input[inputmode="decimal"]').count()) {
    await page.locator('.answer input[inputmode="decimal"]').fill("28");
    if (await page.getByRole("button", { name: "Check answer" }).count()) await page.getByRole("button", { name: "Check answer" }).click();
    else { await page.getByRole("button", { name: "✓ Correct" }).click(); await page.getByRole("button", { name: "Save grade" }).click(); }
  } else if (await page.getByText("Mark each part:").count()) {
    for (const b of await page.locator(".part-mark").all()) await b.getByRole("button", { name: "✓" }).click();
    await page.getByRole("button", { name: "Save grade" }).click();
  } else {
    await page.getByRole("button", { name: "◐ Partly" }).click();
    await page.getByRole("button", { name: "Save grade" }).click();
  }
  await page.getByText("Solutions are not included in this paper").waitFor();
  await page.getByRole("button", { name: i < 9 ? "Next question →" : "Finish", exact: true }).click();
}
await page.getByText(/— summary/).waitFor();
log("practised 9 questions (auto-marked MCQ/number, part-by-part, manual) with no solution access");
await shot("4-summary");

// 7. Paper WITH solutions: solution available before grading; print
await page.goto(`${BASE}/#/`);
await page.getByRole("button", { name: "Build paper" }).click();
await page.locator('label.field:has-text("Number of questions") input').fill("3");
await page.locator('label.field:has-text("Name") input').fill("With solutions");
await page.getByRole("button", { name: /Save paper \(3\)/ }).click();
await page.getByText("Solutions included", { exact: true }).waitFor();
const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Print / PDF" }).click()]);
await popup.getByRole("heading", { name: "Solutions", exact: true }).waitFor({ timeout: 20000 });
if ((await popup.locator(".pq").count()) < 6) fail("print copy is missing questions or solutions");
if (shots) await popup.screenshot({ path: path.join(shots, "5-print.png"), fullPage: true });
await popup.close();
log("printable paper opens with questions and a solutions section");
await page.getByRole("link", { name: "Start" }).click();
await page.getByText("Question 1 of 3").waitFor();
let opened = false;
for (let i = 1; i <= 3 && !opened; i++) {
  if (await page.getByRole("button", { name: "Show solution" }).count()) {
    await page.getByRole("button", { name: "Show solution" }).click();
    await page.locator("section", { has: page.getByRole("heading", { name: /^Solution/ }) }).locator("iframe.qframe").waitFor();
    opened = true;
  }
}
if (!opened) fail("no Show solution button in a paper with solutions");
log("paper with solutions: worked solution opens on demand before grading");
await shot("6-practice-solution");
await page.getByRole("button", { name: "Pause & exit" }).click();
await page.getByRole("link", { name: /Resume \(question/ }).waitFor();

// 8. Import history (R1): sorted by time, search, name + note
await page.goto(`${BASE}/#/import`);
await page.getByRole("heading", { name: "Your imports" }).waitFor();
const firstRow = await page.locator(".import-row").first().innerText();
if (!firstRow.includes("pasted")) fail("history is not newest first: " + firstRow.slice(0, 60));
const yamlRow = () => page.locator(".import-row", { hasText: "mixed-pack.yaml" });
await yamlRow().getByRole("button", { name: "Name / note" }).click();
await yamlRow().getByLabel("Name").fill("Physics batch 1");
await yamlRow().getByLabel("Note").fill("from the example pack");
await yamlRow().getByRole("button", { name: "Save" }).click();
await page.getByText("Saved", { exact: true }).waitFor();
await page.getByLabel("Search imports").fill("physics batch");
await page.locator(".import-row").first().getByText("Physics batch 1").waitFor();
if ((await page.locator(".import-row").count()) !== 1) fail("search did not narrow the history");
await page.getByLabel("Search imports").fill("");
log("import history: newest first, named an import, search finds it");

// 9. Edit questions of one import in bulk: new subject, new + existing topics, marks, fields, notes
const api = (path, opts) => page.evaluate(async ([p, o]) => (await fetch(p, o)).json(), [path, opts ?? {}]);
await page.locator(".import-row", { hasText: "fractions-pack.json" }).getByRole("button", { name: "Edit questions" }).click();
await page.getByRole("heading", { name: "Edit 5 questions" }).waitFor();
const modal = page.locator(".modal");
await modal.locator("label.field", { hasText: "Subject" }).locator("select").selectOption("__new");
await modal.getByLabel("New subject name").fill("Mathematics");
await modal.getByLabel("Topics: action").selectOption("add");
await modal.getByLabel("Existing topic").selectOption({ label: "Physics: Mechanics › Forces" });
await modal.getByRole("button", { name: "Add", exact: true }).click();
await modal.getByLabel("Weight").first().fill("0.5");
await modal.getByLabel("New topic path").fill("Number > Ratio > Sharing");
await modal.getByRole("button", { name: "Add new topic" }).click();
await modal.getByLabel("Marks: action").selectOption("set");
await modal.getByLabel("Marks value").fill("3");
await modal.getByLabel("Collection: action").selectOption("set");
await modal.getByLabel("Collection: value").fill("Renamed collection");
await modal.getByLabel("Tags: action").selectOption("clear");
await modal.getByLabel("Notes: action").selectOption("append");
await modal.getByLabel("Note text").fill("Checked in bulk");
await modal.getByRole("button", { name: "Preview changes" }).click();
for (const line of ["5 questions: subject changes", "10 topic tags added", "4 questions: marks change", "5 questions: “Collection” changes", "1 question: “Tags” changes", "5 questions: notes change", "New subject created: Mathematics", "New topics created: Number; Number › Ratio; Number › Ratio › Sharing"]) {
  await modal.getByText(line, { exact: true }).waitFor();
}
log("bulk preview: new subject, 10 topic tags (existing + new path), marks, 2 fields, notes");
await modal.getByRole("button", { name: "Apply changes" }).click();
await page.getByText("Changes saved").waitFor();
let boot = await api("/api/bootstrap");
let lib = (await api("/api/library")).questions;
const maths = boot.subjects.find((x) => x.name === "Mathematics");
const fr = lib.filter((q) => q.subject_id === maths?.id);
if (fr.length !== 5 || !fr.every((q) => q.marks === 3 && JSON.parse(q.concepts).length >= 2)) fail("bulk edit not applied precisely");
log("applied in one step: 5 questions → new subject Mathematics, marks 3, new topics created and tagged");

// 9b. Clear all topics and all custom fields
await page.goto(`${BASE}/#/import`);
await page.locator(".import-row", { hasText: "fractions-pack.json" }).getByRole("button", { name: "Edit questions" }).click();
await page.getByRole("heading", { name: "Edit 5 questions" }).waitFor();
await modal.getByLabel("Topics: action").selectOption("clear");
await modal.getByText("Clear all custom fields (including Tags)").click();
await modal.getByRole("button", { name: "Preview changes" }).click();
await modal.getByText(/topic tags removed$/).waitFor();
await modal.getByText(/custom field values? cleared$/).waitFor();
await modal.getByRole("button", { name: "Apply changes" }).click();
await page.getByText("Changes saved").waitFor();
lib = (await api("/api/library")).questions;
const cleared = lib.filter((q) => q.subject_id === maths.id);
if (!cleared.every((q) => JSON.parse(q.concepts).length === 0 && JSON.parse(q.fields) && Object.keys(JSON.parse(q.fields)).length === 0)) fail("topics/fields not cleared");
log("cleared all topics and all custom fields on 5 questions");

// 10. Delete button on an import row: questions deleted permanently, import removed from history
await page.goto(`${BASE}/#/import`);
await page.locator("textarea").fill(JSON.stringify({ pack: { id: "throwaway", title: "Throwaway" }, questions: [{ stem: "Useless question one?" }, { stem: "Useless question two?" }] }));
await page.getByRole("button", { name: "Check" }).click();
await page.getByRole("button", { name: "Save 2 questions" }).click();
await page.getByText("Import finished").waitFor();
await page.locator(".import-row", { hasText: "Throwaway" }).getByRole("button", { name: "Delete" }).click();
await page.getByRole("heading", { name: "Delete import “Throwaway”" }).waitFor();
await modal.getByRole("button", { name: "Preview what will be deleted" }).click();
await modal.getByText(/^2 questions deleted permanently/).waitFor();
await modal.getByText("1 import removed from your import history").waitFor();
if (!(await modal.getByRole("button", { name: "Delete permanently" }).isDisabled())) fail("delete allowed without typing DELETE");
await modal.getByLabel("Type DELETE to confirm").fill("DELETE");
await modal.getByRole("button", { name: "Delete permanently" }).click();
await page.getByText("Deleted 2 questions permanently").waitFor();
await page.waitForTimeout(500);
if (await page.locator(".import-row", { hasText: "Throwaway" }).count()) fail("deleted import still in history");
if ((await api("/api/library")).questions.length !== 9) fail("expected 9 questions after deleting the throwaway import");
log("import row Delete: 2 questions deleted for good, import gone from history");

// 11. Delete questions you have practised (attempts + papers) — really deleted, papers renumbered
const papersBefore = (await api("/api/papers")).papers;
await page.locator(".import-row", { hasText: "Physics batch 1" }).getByRole("button", { name: "Delete" }).click();
await modal.getByRole("button", { name: "Preview what will be deleted" }).click();
await modal.getByText(/^4 questions deleted permanently/).waitFor();
await modal.getByText(/attempts? \(and their grades\) deleted/).waitFor();
await modal.getByText(/removed from \d+ papers?; the remaining questions are renumbered/).waitFor();
await modal.getByLabel("Type DELETE to confirm").fill("DELETE");
await modal.getByRole("button", { name: "Delete permanently" }).click();
await page.getByText("Deleted 4 questions permanently").waitFor();
lib = (await api("/api/library")).questions;
if (lib.length !== 5) fail(`expected 5 questions, got ${lib.length}`);
for (const p of papersBefore) {
  const d = await api(`/api/papers/${p.id}`);
  const pos = d.items.map((i) => i.position);
  if (pos.some((x, i) => x !== i + 1)) fail(`paper ${p.name} not renumbered: ${pos}`);
  if (d.attempts.some((a) => a.paper_position !== null && !pos.includes(a.paper_position))) fail(`attempt points at a missing paper position in ${p.name}`);
}
log("practised questions deleted with their attempts; papers renumbered 1..n, attempts still line up");
await page.goto(`${BASE}/#/`);
await page.locator(".qrow.head input[type=checkbox]").check();
await page.getByRole("button", { name: /^Delete \d+ selected$/ }).waitFor();
await page.locator(".qrow.head input[type=checkbox]").uncheck();
log("library shows Delete N selected next to Edit");

// 12. Integrity + rebuild + backup
await page.goto(`${BASE}/#/settings`);
await page.getByRole("button", { name: "Run integrity check" }).click();
await page.getByText(/no problems found/).waitFor();
await page.getByRole("button", { name: "Rebuild all metrics" }).click();
await page.getByText(/all identical/).waitFor();
log("integrity check clean; metrics rebuilt identical");
const dl = page.waitForEvent("download");
await page.getByRole("button", { name: "Download backup archive" }).click();
const out = path.resolve(shots ?? ".", "backup-test.zip");
await (await dl).saveAs(out);
log("backup archive downloaded:", fs.statSync(out).size, "bytes");

// 13. Phone layout
await page.setViewportSize({ width: 390, height: 844 });
for (const route of ["#/", "#/import", "#/papers", "#/settings"]) {
  await page.goto(`${BASE}/${route}`);
  await page.waitForTimeout(400);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`horizontal scroll on phone width at ${route}`);
}
await page.goto(`${BASE}/#/import`);
await shot("7-phone-import");
log("phone width: no horizontal scroll on library, import, papers, settings");

if (errors.length) fail("browser errors:\n" + errors.join("\n"));
await browser.close();
console.log("\nE2E PASSED");
