// G4.svg: each figure as the SOURCE page draws it, against the packaged figure shown as an <img>
// (how the app shows figures: no page stylesheet, no external resources).
// The source page's scripts run only here, in a headless browser with every network request blocked (R13).
// Metric (unchanged from ingest/svg_compare.py): mean absolute colour difference over 6x6-pixel blocks.
// Calibrated on the geometry paper: correct figures 0.7-2.6, figures without their styles 100-165. Threshold 10.
import path from "node:path";
import { createRequire } from "node:module";
import { readJson } from "./lib.mjs";

const THRESHOLD = 10;

const SCORE = async ([a, b]) => {
  const load = async (b64) => createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
  const [ia, ib] = [await load(a), await load(b)];
  if (ia.width !== ib.width || ia.height !== ib.height) return 999;
  const px = (img) => { const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
  const da = px(ia), db = px(ib), k = 6, w = Math.floor(ia.width / k), h = Math.floor(ia.height / k);
  if (!w || !h) return 999;
  let total = 0;
  for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) for (let ch = 0; ch < 3; ch++) {
    let sa = 0, sb = 0;
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) { const i = ((by * k + y) * ia.width + bx * k + x) * 4 + ch; sa += da[i]; sb += db[i]; }
    total += Math.abs(sa - sb) / (k * k);
  }
  return total / (w * h * 3);
};

export async function figureCheck(v, run) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const rows = readJson(path.join(run.runDir, "pack", "assets.json"));
  const browser = await chromium.launch();
  const blocked = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1, locale: "en-GB" });
    await ctx.route("**/*", (route) => { const u = route.request().url(); if (u.startsWith("file:") || u.startsWith("data:")) route.continue(); else { blocked.push(u); route.abort(); } });
    const page = await ctx.newPage();
    await page.goto("file://" + path.join(run.runDir, "source", run.inputs.source.name));
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    const page2 = await ctx.newPage();
    const shot = async (svgText, box, W, H, x0, y0) => {
      const b64 = Buffer.from(svgText, "utf8").toString("base64");
      await page2.setViewportSize({ width: Math.max(W + 10, 100), height: Math.max(H + 10, 100) });
      await page2.setContent(`<body style="margin:0;background:#fff"><img id="i" src="data:image/svg+xml;base64,${b64}" style="position:absolute;left:${box.x - x0}px;top:${box.y - y0}px;width:${box.width}px;height:${box.height}px"></body>`);
      await page2.waitForFunction(() => document.getElementById("i").complete);
      return (await page2.screenshot({ clip: { x: 0, y: 0, width: W, height: H } })).toString("base64");
    };
    const scores = [], invisible = [];
    let control = null;
    for (const row of rows) {
      const el = await page.$(row.locator);
      if (!el) { scores.push({ asset: row.asset, question: row.question, score: 999, why: "not found in the rendered page" }); continue; }
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const box = await el.boundingBox();
      if (!box || box.width < 2 || box.height < 2) { invisible.push(row.question); continue; }
      const x0 = Math.floor(box.x), y0 = Math.floor(box.y), W = Math.ceil(box.x + box.width) - x0, H = Math.ceil(box.y + box.height) - y0;
      const orig = (await page.screenshot({ clip: { x: x0, y: y0, width: W, height: H } })).toString("base64");
      const data = run.pack.assets[row.asset].data;
      scores.push({ asset: row.asset, question: row.question, score: await page2.evaluate(SCORE, [orig, await shot(data, box, W, H, x0, y0)]) });
      if (control === null && /<style>[\s\S]*?<\/style>/.test(data)) {   // known-bad fixture: the same figure with its styles stripped
        control = await page2.evaluate(SCORE, [orig, await shot(data.replace(/<style>[\s\S]*?<\/style>/, ""), box, W, H, x0, y0)]);
      }
    }
    const bad = scores.filter((s) => s.score > THRESHOLD);
    const worst = scores.reduce((m, s) => Math.max(m, s.score), 0);
    if (control !== null && control <= THRESHOLD) {
      v.add("G4.svg", "FAIL", `unhealthy environment: a figure with its styles stripped scored ${control.toFixed(2)} (must be above ${THRESHOLD}), so this check cannot tell right from wrong here`, { examined: scores.length });
    } else {
      v.add("G4.svg", bad.length || invisible.length ? "FAIL" : "PASS", bad.length || invisible.length
        ? `${bad.length} figure(s) render differently from the source page, ${invisible.length} could not be seen in the source page; first: ${bad[0]?.question ?? invisible[0]}`
        : `${scores.length} figures render the same as in the source page (worst difference ${worst.toFixed(2)}, threshold ${THRESHOLD}; control with styles stripped: ${control === null ? "n/a" : control.toFixed(1)})`,
      { examined: scores.length + invisible.length, expected: rows.length, details: bad.slice(0, 20) });
    }
    v.add("G4.network", blocked.length ? "FAIL" : "PASS", blocked.length ? `the source page tried to load ${blocked.length} outside resource(s): ${blocked.slice(0, 3).join(", ")}` : "the source page asked for nothing outside itself while rendering (all network requests are blocked)", { examined: 1 });
  } finally {
    await browser.close();
  }
}
