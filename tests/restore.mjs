// Restore a backup archive into an EMPTY local database and check it (FR-6.5).
// Usage: BASE=http://127.0.0.1:8787 node tests/restore.mjs path/to/backup.zip
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/#/settings`);
await page.setInputFiles('input[type=file][accept=".zip"]', process.argv[2]);
await page.getByText(/every file matches its checksum/).waitFor();
await page.getByRole("button", { name: "Restore now" }).click();
await page.getByText(/Restore finished: no problems found/).waitFor({ timeout: 60000 });
console.log("✓ restored, integrity check clean");
await page.goto(`${BASE}/#/`);
await page.locator(".results-head strong").waitFor();
console.log("✓ library after restore:", await page.locator(".results-head strong").innerText());
await browser.close();
