// End-to-end walk through the real UI against `wrangler dev` (local D1 + R2).
// Usage: BASE=http://127.0.0.1:8787 node tests/e2e.mjs [screenshotDir]
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const shots = process.argv[2];
const fixture = path.resolve("tests/fixtures/fractions-sample.html");
const log = (...a) => console.log("✓", ...a);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("dialog", async (d) => {
  if (d.type() === "prompt") await d.accept(d.message().includes("filter") ? "Wrong ones" : "x");
  else await d.accept();
});
const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }));

// 1. Import
await page.goto(`${BASE}/#/import`);
await page.setInputFiles('input[type=file]', fixture);
await page.getByText("6 of 6 will be saved").waitFor();
await page.getByRole("button", { name: "Show all previews" }).click();
const frame = page.frameLocator("iframe.qframe").first();
await frame.getByText("What fraction of the bar is shaded?").waitFor();
// The question box must not be able to run scripts.
const sandbox = await page.locator("iframe.qframe").first().getAttribute("sandbox");
if (sandbox !== "allow-same-origin") fail("iframe sandbox wrong: " + sandbox);
await shot("1-import-review");
await page.getByRole("button", { name: /Accept and save 6/ }).click();
await page.getByText(/Imported: 6 new/).waitFor();
log("import: 6 new questions");

// Re-import the same file: all duplicates
await page.setInputFiles('input[type=file]', fixture);
await page.getByText("0 of 6 will be saved").waitFor();
log("re-import recognised 6 duplicates");
await page.getByRole("button", { name: "Cancel" }).click();

// 2. Library + filter
await page.goto(`${BASE}/#/`);
await page.getByText("6 matches").waitFor();
await page.selectOption('select[aria-label="Add condition"]', "difficulty");
await page.locator(".fcond .chip", { hasText: "Foundation" }).click();
await page.getByText("3 matches").waitFor();
log("filter by difficulty label: 3 foundation");
await shot("2-library");
await page.getByRole("button", { name: "Clear" }).click();
await page.getByText("6 matches").waitFor();

// 3. Question detail: set MCQ format + answer key on Q1
await page.locator(".qrow a", { hasText: "Q1" }).click();
await page.getByRole("heading", { name: /^Q1/ }).waitFor();
await page.locator("label.field", { hasText: "Answer format" }).locator("select").selectOption("mcq_single");
await page.getByRole("button", { name: "Save details" }).click();
await page.getByText("Saved", { exact: true }).waitFor();
await page.locator("section", { hasText: "Answer key" }).locator(".chip", { hasText: /^C$/ }).click();
await page.getByRole("button", { name: "Save key" }).click();
await page.getByText(/verified · v1/).waitFor();
log("answer key saved on Q1");
await shot("3-question");

// 4. Build a paper of all 6, seed fixed
await page.goto(`${BASE}/#/`);
await page.getByRole("button", { name: "Build paper" }).click();
await page.locator('label.field:has-text("Number of questions") input').fill("6");
await page.locator('label.field:has-text("Seed") input').fill("42");
const order1 = await page.locator(".pick-list li a").allTextContents();
await page.locator('label.field:has-text("Seed") input').fill("7");
await page.locator('label.field:has-text("Seed") input').fill("42");
const order2 = await page.locator(".pick-list li a").allTextContents();
if (order1.join() !== order2.join()) fail("same seed gave a different paper");
log("same seed → same paper:", order1.join(" "));
await page.locator('label.field:has-text("Number of questions") input').fill("9");
await page.getByText(/Only 6 questions match/).waitFor();
await page.getByRole("button", { name: "Use 6" }).click();
await page.getByRole("button", { name: /Save paper \(6\)/ }).click();
await page.getByRole("heading", { name: /^Paper / }).waitFor();
log("paper saved (frozen)");

// 5. Practice: answer 2, pause, resume, finish
await page.getByRole("link", { name: "Start" }).click();
for (let i = 1; i <= 6; i++) {
  await page.getByText(`Question ${i} of 6`).waitFor();
  if (i === 3) {
    await page.getByRole("button", { name: "Pause & exit" }).click();
    await page.getByRole("link", { name: /Resume \(question 3\)/ }).click();
    await page.getByText("Question 3 of 6").waitFor();
    log("pause + resume at question 3");
  }
  const hasMcq = await page.locator(".chips.answer").count();
  if (hasMcq) {
    await page.locator(".chips.answer .chip", { hasText: /^B$/ }).click(); // wrong on purpose
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByText("marked automatically").waitFor();
    log("auto-graded MCQ (wrong answer → incorrect)");
  } else {
    const r = i % 3 === 0 ? "◐ Partly" : i % 2 === 0 ? "✗ Incorrect" : "✓ Correct";
    await page.getByRole("button", { name: r }).click();
    if (r.includes("Incorrect")) await page.locator('label.field:has-text("What went wrong") select').selectOption("concept_gap");
    await page.getByRole("button", { name: "Save grade" }).click();
  }
  await page.getByRole("heading", { name: "Solution" }).waitFor();
  if (i === 2) {
    await page.getByRole("button", { name: "Correct grade" }).click();
    await page.getByRole("button", { name: "✓ Correct" }).last().click();
    await page.getByRole("button", { name: "Save correction" }).click();
    await page.getByText("Grade corrected").waitFor();
    log("grade correction on question 2");
  }
  if (i === 1) await shot("4-practice-solution");
  await page.getByRole("button", { name: i < 6 ? "Next question →" : "Finish", exact: true }).click();
}
await page.getByText(/— summary/).waitFor();
await page.getByText("Mistakes by concept").waitFor();
log("paper summary shown");
await shot("5-summary");

// 6. Analytics
await page.goto(`${BASE}/#/analytics`);
await page.getByText("Accuracy by subject (weekly)").waitFor();
await page.getByText("1", { exact: true }).first().waitFor();
await shot("6-analytics");
log("analytics rendered");

// 7. Library history filter: last result incorrect
await page.goto(`${BASE}/#/`);
await page.selectOption('select[aria-label="Add condition"]', "last_result");
const n = await page.locator(".results-head strong").textContent();
log("filter last result = incorrect →", n);
await page.getByRole("button", { name: "Save filter" }).click();
await page.getByText("Filter saved").waitFor();
log("saved filter");

// 8. Integrity + rebuild
await page.goto(`${BASE}/#/settings`);
await page.getByRole("button", { name: "Run integrity check" }).click();
await page.getByText(/no problems found/).waitFor();
log("integrity check: no problems");
await page.getByRole("button", { name: "Rebuild all metrics" }).click();
await page.getByText(/all identical/).waitFor();
log("rebuild metrics: live = rebuilt");

// 9. Export archive
const dl = page.waitForEvent("download");
await page.getByRole("button", { name: "Download backup archive" }).click();
const file = await dl;
const out = path.resolve(shots ?? ".", "backup-test.zip");
await file.saveAs(out);
log("backup archive downloaded:", fs.statSync(out).size, "bytes →", out);
await shot("7-settings");

// 10. Phone layout
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/#/`);
await page.getByRole("button", { name: "Clear" }).click();
await page.getByText("6 matches").waitFor();
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
if (overflow) fail("horizontal scroll on phone width");
await shot("8-phone");
log("phone width: no horizontal scroll");

if (errors.length) fail("browser errors:\n" + errors.join("\n"));
await browser.close();
console.log("\nE2E PASSED");
