#!/usr/bin/env node
// Prints an HTML page to PDF in a headless browser with every network request blocked (R13), for layouts the
// structured HTML route cannot describe. Hidden answers (<details>) are opened so they are printed too.
// Usage: node ingest/checker/printpdf.mjs IN.html OUT.pdf
import path from "node:path";
import { createRequire } from "node:module";

const [, , input, output] = process.argv;
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ locale: "en-GB" });
  await ctx.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith("file:") || u.startsWith("data:")) r.continue(); else r.abort(); });
  const page = await ctx.newPage();
  await page.goto("file://" + path.resolve(input), { waitUntil: "load" });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
  await page.emulateMedia({ media: "screen" });
  await page.pdf({ path: output, format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
} finally {
  await browser.close();
}
