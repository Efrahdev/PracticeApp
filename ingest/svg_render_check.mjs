// Visual check: each figure as drawn in the ORIGINAL page vs the packaged asset shown as an <img> (how the app shows it).
// Usage: node ingest/svg_render_check.mjs <output-dir>   (then ingest/svg_compare.py <output-dir>)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright"); // preinstalled globally (resolves via NODE_PATH)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "ingest/packs/geometry-olympiad-achiever-100.json"), "utf8"));
const names = Object.keys(pack.assets);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
await page.goto("file://" + path.join(ROOT, "Geometry_Olympiad_Achiever_100_Questions.html"));
await page.evaluate(() => document.querySelectorAll("details.sol").forEach((d) => (d.open = true))); // one figure lives inside a solution
const svgs = await page.$$("svg.geo");
if (svgs.length !== names.length) throw new Error(`${svgs.length} svgs on page vs ${names.length} assets`);
const alts = await page.$$eval("svg.geo", (els) => els.map((e) => e.getAttribute("aria-label")));
// assets are named in document order inside each question, so match page figures to assets by alt text, in order
const byAlt = new Map();
for (const n of names) {
  const a = pack.assets[n].data.match(/aria-label="([^"]*)"/)[1];
  if (!byAlt.has(a)) byAlt.set(a, []);
  byAlt.get(a).push(n);
}
const page2 = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
const done = [];
for (let i = 0; i < svgs.length; i++) {
  const el = svgs[i];
  const name = byAlt.get(alts[i].replace(/&/g, "&amp;") in Object.fromEntries(byAlt) ? alts[i].replace(/&/g, "&amp;") : alts[i]).shift();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  // identical clip rectangle for both captures, keeping the figure's sub-pixel offset so anti-aliasing matches
  const x0 = Math.floor(box.x), y0 = Math.floor(box.y);
  const W = Math.ceil(box.x + box.width) - x0, H = Math.ceil(box.y + box.height) - y0;
  await page.screenshot({ path: path.join(OUT, `${name}.orig.png`), clip: { x: x0, y: y0, width: W, height: H } });
  const b64 = Buffer.from(pack.assets[name].data, "utf8").toString("base64");
  await page2.setViewportSize({ width: Math.max(W + 10, 100), height: Math.max(H + 10, 100) });
  await page2.setContent(`<body style="margin:0;background:#fff"><img id="i" src="data:image/svg+xml;base64,${b64}" style="position:absolute;left:${box.x - x0}px;top:${box.y - y0}px;width:${box.width}px;height:${box.height}px"></body>`);
  await page2.waitForFunction(() => document.getElementById("i").complete);
  await page2.screenshot({ path: path.join(OUT, `${name}.asset.png`), clip: { x: 0, y: 0, width: W, height: H } });
  done.push(name);
}
await browser.close();
fs.writeFileSync(path.join(OUT, "names.json"), JSON.stringify(done));
console.log("rendered", done.length, "figures");
