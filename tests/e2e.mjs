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
await page.getByRole("heading", { name: "Build a paper" }).waitFor();
await page.getByRole("textbox", { name: "Paper name" }).fill("Test paper");
await page.getByRole("spinbutton", { name: "Number of questions" }).fill("9");
await page.getByRole("radio", { name: "Test conditions" }).click();
// Builder: two mixes at once, a history rule, pin and replace, the detailed table
const mixRow = (name) => page.locator(".mix-dim", { hasText: name });
await mixRow("By subject").locator("input.switch").check();
await mixRow("By subject").getByLabel("Maths share").fill("50");
await mixRow("By difficulty").locator("input.switch").check();
await page.locator(".dt-row:not(.dt-head)").nth(8).waitFor();
if (await page.locator(".mix-dim", { hasText: "By subject" }).getByText("On target").count() !== 1) fail("subject mix not on target");
await page.getByRole("radio", { name: "Never", exact: true }).click();
await page.locator(".pb-meter-n", { hasText: "9 of 9 questions match" }).waitFor();
await page.getByRole("radio", { name: "More than" }).click();
await page.locator(".pb-meter-n", { hasText: "9 of 9 questions match" }).waitFor(); // never attempted counts as "long ago"
await page.getByRole("radio", { name: "Within" }).click();
await page.locator(".pb-meter-n", { hasText: "0 of 9 questions match" }).waitFor();
await page.getByRole("radio", { name: "Any time" }).click();
const rowsB = page.locator(".dt-row:not(.dt-head)");
const firstPick = await rowsB.nth(0).locator(".dt-qno").innerText();
await rowsB.nth(0).getByRole("button", { name: /^Pin / }).click();
await page.getByRole("button", { name: "Shuffle", exact: true }).click();
if (!(await page.locator(".dt-qno", { hasText: new RegExp(`^${firstPick}$`) }).count())) fail("pinned question lost on shuffle");
await rowsB.nth(1).getByRole("button", { name: /^Replace / }).click();
await page.getByText("Removed from this paper (1)").waitFor();
await page.getByText(/Only 8 questions can be used, but the paper asks for 9/).waitFor(); // only 9 in the library
await shot("4a-builder");
await page.getByText("Removed from this paper (1)").click();
await page.getByRole("button", { name: "Put back" }).click();
log("builder: subject + difficulty mixes on target, history rule, pin survives shuffle, replace");
await page.getByRole("button", { name: /Save paper \(9\)/ }).first().click();
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
await page.goto(`${BASE}/#/papers`);
await page.getByRole("button", { name: "New paper" }).click();
await page.getByRole("heading", { name: "Build a paper" }).waitFor();
await page.getByRole("spinbutton", { name: "Number of questions" }).fill("3");
await page.getByRole("textbox", { name: "Paper name" }).fill("With solutions");
await page.getByRole("button", { name: /Save paper \(3\)/ }).first().click();
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

// 9. Edit questions of one import in bulk (R2–R4)
await page.locator(".import-row", { hasText: "fractions-pack.json" }).getByRole("button", { name: "Edit questions" }).click();
await page.getByRole("heading", { name: "Edit 5 questions" }).waitFor();
const modal = page.locator(".modal");
await modal.locator("label.field", { hasText: "Subject" }).locator("select").selectOption({ label: "Physics" });
await modal.locator(".field", { hasText: "Topics" }).locator("select").first().selectOption("add");
await modal.getByLabel("Topic to add to the list").selectOption({ label: "Physics: Mechanics › Forces" });
await modal.getByRole("button", { name: "Add to list" }).click();
await modal.getByLabel("Weight").fill("0.5");
await modal.getByLabel("Collection: action").selectOption("set");
await modal.getByLabel("Collection: value").fill("Renamed collection");
await modal.locator(".field", { hasText: "Notes" }).locator("select").selectOption("append");
await modal.locator(".field", { hasText: "Notes" }).locator("textarea").fill("Checked in bulk");
await modal.getByRole("button", { name: "Preview changes" }).click();
for (const line of ["5 subject changes", "5 topic tags added", "5 “Collection” values change", "5 notes change"]) await modal.getByText(line).waitFor();
log("bulk preview: 5 subject, 5 topics, 5 field values, 5 notes");
await modal.getByRole("button", { name: "Apply changes" }).click();
await page.getByText("Changes saved").waitFor();
const libNow = await page.evaluate(async () => (await (await fetch("/api/library")).json()).questions);
const boot = await page.evaluate(async () => (await (await fetch("/api/bootstrap")).json()));
const physics = boot.subjects.find((x) => x.name === "Physics").id;
if (libNow.filter((q) => q.subject_id === physics).length !== 9) fail("subject not applied to all 5");
log("bulk changes saved in one step (all 9 questions now Physics)");

// 10. Bulk delete: a throwaway import is removed for good
await page.goto(`${BASE}/#/import`);
await page.locator("textarea").fill(JSON.stringify({ pack: { id: "throwaway", title: "Throwaway" }, questions: [{ stem: "Useless question one?" }, { stem: "Useless question two?" }] }));
await page.getByRole("button", { name: "Check" }).click();
await page.getByRole("button", { name: "Save 2 questions" }).click();
await page.getByText("Import finished").waitFor();
await page.locator(".import-row", { hasText: "Throwaway" }).getByRole("button", { name: "Edit questions" }).click();
await page.getByRole("heading", { name: "Edit 2 questions" }).waitFor();
await modal.locator(".field", { hasText: "Status" }).locator("select").selectOption("delete");
await modal.getByRole("button", { name: "Preview changes" }).click();
await modal.getByText("2 deleted permanently").waitFor();
if (!(await modal.getByRole("button", { name: "Delete now" }).isDisabled())) fail("delete allowed without typing DELETE");
await modal.getByLabel("Type DELETE to confirm").fill("DELETE");
await modal.getByRole("button", { name: "Delete now" }).click();
await page.getByText("Deleted 2 question(s)").waitFor();
const after = await page.evaluate(async () => (await (await fetch("/api/library")).json()).questions.length);
if (after !== 9) fail(`expected 9 questions after delete, got ${after}`);
log("bulk delete: 2 useless questions deleted permanently (typed confirmation)");

// 11. Questions with history are archived instead of deleted, then restored
await page.goto(`${BASE}/#/import`);
await page.locator(".import-row", { hasText: "Physics batch 1" }).getByRole("button", { name: "Edit questions" }).click();
await page.getByRole("heading", { name: "Edit 4 questions" }).waitFor();
await modal.locator(".field", { hasText: "Status" }).locator("select").selectOption("delete");
await modal.getByRole("button", { name: "Preview changes" }).click();
await modal.getByText("0 deleted permanently").waitFor();
await modal.getByText(/4 kept because they have attempts or are in papers — 4 of them will be archived instead/).waitFor();
await modal.getByRole("button", { name: "Delete now" }).click();
await page.getByText(/archived 4 that have history/).waitFor();
await page.goto(`${BASE}/#/import`);
await page.locator(".import-row", { hasText: "Physics batch 1" }).getByRole("button", { name: "Restore" }).click();
await page.getByText("Restored 4 question(s)").waitFor();
log("delete of practised questions archives them instead (history kept); restored from import history");

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
for (const route of ["#/", "#/import", "#/papers", "#/papers/new", "#/settings"]) {
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
