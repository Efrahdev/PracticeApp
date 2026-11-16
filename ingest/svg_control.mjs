// Control for svg_compare: render a handful of assets WITHOUT their <style> block (what would happen if the CSS were not
// carried into the asset) so the pixel metric can be calibrated against a genuinely broken figure.
// Usage: node ingest/svg_control.mjs <dir that holds names.json from svg_render_check.mjs>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = process.argv[2];
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "ingest/packs/geometry-olympiad-achiever-100.json"), "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const name of ["q35-fig1", "q30-fig1", "q90-fig1", "q53-fig1", "q4-fig1"]) {
  const orig = await import("node:fs").then((f) => f.readFileSync(path.join(D, `${name}.orig.png`)));
  const dim = orig.readUInt32BE(16) + "x" + orig.readUInt32BE(20); // PNG IHDR width x height
  const [W, H] = dim.split("x").map(Number);
  const bare = pack.assets[name].data.replace(/<style>.*?<\/style>/s, "");
  const b64 = Buffer.from(bare, "utf8").toString("base64");
  await page.setViewportSize({ width: W + 10, height: H + 10 });
  await page.setContent(`<body style="margin:0;background:#fff"><img id="i" src="data:image/svg+xml;base64,${b64}" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></body>`);
  await page.waitForFunction(() => document.getElementById("i").complete);
  await page.screenshot({ path: path.join(D, `${name}.nostyle.png`), clip: { x: 0, y: 0, width: W, height: H } });
}
await browser.close();
console.log("control images written");
