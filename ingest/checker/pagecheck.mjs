// Independent checks for page sources (PDF, scans, images, Office and printed HTML).
// R8: the converter reads PDFs with pdfium (pypdfium2); this file reads them with Poppler (pdftotext, pdftoppm),
// a different library, and decodes images in the browser. Nothing here imports the converter.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { bag, bagDiff, numerals, readJson } from "./lib.mjs";

const THRESHOLD = 10;
// words only: letters and digits. Symbols and punctuation are drawn differently by each PDF library's font
// decoding, so they are covered by the picture check, not the text check (stated in the assurance statement).
export const words = (t) => (String(t ?? "").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []);

function pdfPath(run) {
  const ps = run.inputs.page_source;
  return ps.pdf ? path.join(run.runDir, "source", ps.pdf) : null;
}

/** Poppler's words with their boxes (points, top-left origin) for each page read. */
export function popplerWords(run) {
  const file = pdfPath(run);
  const out = new Map();
  if (!file) return out;
  const pages = run.inputs.page_source.pages;
  const first = Math.min(...pages), last = Math.max(...pages);
  let xml;
  try {
    xml = execFileSync("pdftotext", ["-bbox", "-f", String(first), "-l", String(last), file, "-"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`Poppler's pdftotext is needed for the independent text check and did not run: ${e.message}`);
  }
  const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
  let p = first - 1;
  for (const chunk of xml.split(/<page /).slice(1)) {
    p++;
    if (!pages.includes(p)) continue;
    const list = [];
    for (const m of chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
      list.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: dec(m[5]) });
    }
    out.set(p, list);
  }
  return out;
}

const inside = (w, box, pad = 1.5) => {
  const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
  return cx >= box[0] - pad && cx <= box[2] + pad && cy >= box[1] - pad && cy <= box[3] + pad;
};

/** G3 for page sources. */
export function pageTextChecks(v, run, pack, fieldValue, visible) {
  const ps = run.inputs.page_source;
  const cov = run.coverage;
  const textUnits = cov.blocks.filter((b) => b.kind === "line" || b.kind === "rotated");
  if (!ps.pdf || !textUnits.length) {
    v.add("G3.conservation", "INFO", "pages without a text layer: there is no text to conserve; every question is a picture of its region (checked by G4.crops)", { examined: 0, zeroOk: true });
    v.add("G3.local", "INFO", "no text layer", { examined: 0, zeroOk: true });
    return;
  }
  const pw = popplerWords(run);
  // ---- conservation, page by page: Poppler's words against the ledger's lines (claimed or ignored)
  const mismatch = [];
  let total = 0;
  for (const p of ps.pages) {
    const src = bag((pw.get(p) ?? []).flatMap((w) => words(w.text)));
    const led = bag(textUnits.filter((b) => b.page === p).flatMap((b) => words(b.text)));
    total += [...src.values()].reduce((a, b) => a + b, 0);
    const d = bagDiff(src, led);
    if (d.onlyA.length || d.onlyB.length) mismatch.push(`page ${p}: in the PDF but not accounted for: ${d.onlyA.slice(0, 8).join(" ")}; in the ledger but not in the PDF: ${d.onlyB.slice(0, 8).join(" ")}`);
  }
  v.add("G3.conservation", mismatch.length ? "FAIL" : "PASS", mismatch.length
    ? `${mismatch.length} page(s) where the words read by Poppler differ from the words the converter accounted for; first: ${mismatch[0]}`
    : `all ${total} words on ${ps.pages.length} pages, read independently with Poppler, are accounted for (claimed by a question or ignored with a reason)`,
  { examined: total, details: mismatch.slice(0, 20) });
  // ---- local: each text line the converter used holds exactly the words Poppler finds inside its box
  const bad = [];
  let n = 0;
  for (const b of textUnits) {
    if (b.status !== "claimed") continue;
    n++;
    const src = (pw.get(b.page) ?? []).filter((w) => inside(w, b.box)).flatMap((w) => words(w.text));
    const d = bagDiff(bag(src), bag(words(b.text)));
    if (d.onlyA.length || d.onlyB.length) bad.push(`${b.locator}: Poppler finds ${JSON.stringify(src.join(" ").slice(0, 60))}, the converter read ${JSON.stringify(b.text.slice(0, 60))}`);
  }
  v.add("G3.local", bad.length ? "FAIL" : "PASS", bad.length ? `${bad.length} line(s) whose position holds different words in the PDF; first: ${bad[0]}` : `${n} lines used in questions: each holds, at its position on the page, exactly the words Poppler reads there`,
    { examined: n, details: bad.slice(0, 20) });
  // ---- numerals per question: digits in the PDF inside the question's lines against the pack's text
  const byQ = new Map();
  for (const b of textUnits) if (b.status === "claimed") for (const c of b.by) if (c.q && c.mode !== "asset") {
    if (!byQ.has(c.q)) byQ.set(c.q, new Set());
    byQ.get(c.q).add(b);
  }
  const numBad = [];
  let qn = 0;
  for (const q of pack.questions) {
    const units = [...(byQ.get(q.id) ?? [])];
    if (!units.length) continue;
    qn++;
    const src = units.flatMap((b) => (pw.get(b.page) ?? []).filter((w) => inside(w, b.box)).map((w) => w.text)).join(" ");
    if ([...(byQ.get(q.id) ?? [])].length && q.source?.display === "picture") continue;   // the picture is checked by G4.crops
    const fields = ["stem", ...(q.options ?? []).map((o) => `options.${o.label}`), "solution.answer", "solution.explanation"];
    let packText = "";
    for (const f of fields) { const val = fieldValue(pack, q, f); if (val && !String(val.text).includes("(asset:")) packText += " " + visible(val); }
    const stripped = (cov.stripped ?? []).filter((s) => s.q === q.id).map((s) => s.text).join(" ");
    const a = bag(numerals(src).filter((t) => /\d/.test(t))), b = bag(numerals(packText + " " + stripped).filter((t) => /\d/.test(t)));
    const d = bagDiff(a, b);
    if (d.onlyA.length || d.onlyB.length) numBad.push(`${q.id}: PDF has ${d.onlyA.slice(0, 6).join(" ")} not in the pack; pack has ${d.onlyB.slice(0, 6).join(" ")} not in the PDF`);
  }
  v.add("G3.numerals", numBad.length ? "FAIL" : "PASS", numBad.length ? `${numBad.length} question(s) whose numbers differ from the PDF; first: ${numBad[0]}` : `every number in ${qn} text questions matches the numbers Poppler reads in the same lines`,
    { examined: qn, zeroOk: true, details: numBad.slice(0, 20) });
}

/** G4.crops: every question picture equals the same region rendered by a different renderer. */
export async function cropCheck(v, run) {
  const rows = readJson(path.join(run.runDir, "pack", "assets.json")).filter((r) => r.pixels);
  if (!rows.length) { v.add("G4.crops", "INFO", "no question pictures in this pack", { examined: 0, zeroOk: true }); return; }
  const ps = run.inputs.page_source;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-crops-"));
  const pageImage = new Map();
  const getPage = (p) => {
    if (pageImage.has(p)) return pageImage.get(p);
    let file;
    if (ps.pdf) {
      const base = path.join(tmp, `p${p}`);
      execFileSync("pdftoppm", ["-r", String(ps.dpi), "-f", String(p), "-l", String(p), "-png", "-singlefile", pdfPath(run), base]);
      file = { kind: "png", data: fs.readFileSync(base + ".png").toString("base64") };
    } else {
      file = { kind: "image", data: run.sourceBytes.toString("base64"), page: p };
    }
    pageImage.set(p, file);
    return file;
  };
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent("<body></body>");
    const results = [];
    let control = null;
    for (const r of rows) {
      const src = getPage(r.page);
      if (src.kind === "image" && !/^image\//.test(guessType(run.sourceBytes))) {
        results.push({ q: r.question, score: null, why: "zip or multi-page images are compared page by page in a later version" });
        continue;
      }
      const packaged = run.pack.assets[r.asset].base64;
      const [x0, y0, x1, y1] = r.pixels;
      const res = await page.evaluate(async ({ srcB64, srcType, pkgB64, box, shift }) => {
        const load = async (b64, type) => createImageBitmap(await (await fetch(`data:${type};base64,` + b64)).blob());
        const whole = await load(srcB64, srcType), pkg = await load(pkgB64, "image/png");
        const W = box[2] - box[0], H = box[3] - box[1];
        const grab = (img, x, y) => { const c = new OffscreenCanvas(W, H); const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.drawImage(img, x, y, W, H, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
        const score = (a, b) => {
          const k = 6, w = Math.floor(W / k), h = Math.floor(H / k);
          if (!w || !h) return 0;
          let t = 0;
          for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) for (let ch = 0; ch < 3; ch++) {
            let sa = 0, sb = 0;
            for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) { const i = ((by * k + y) * W + bx * k + x) * 4 + ch; sa += a[i]; sb += b[i]; }
            t += Math.abs(sa - sb) / (k * k);
          }
          return t / (w * h * 3);
        };
        if (pkg.width !== W || pkg.height !== H) return { score: 999, dims: [pkg.width, pkg.height, W, H] };
        const p = grab(pkg, 0, 0);
        const out = { score: score(grab(whole, box[0], box[1]), p) };
        if (shift) out.control = score(grab(whole, box[0], box[1] + Math.max(8, Math.round(H / 2))), p);
        return out;
      }, { srcB64: src.data, srcType: src.kind === "png" ? "image/png" : guessType(run.sourceBytes), pkgB64: packaged, box: [x0, y0, x1, y1], shift: control === null && y1 - y0 > 40 });
      if (res.control !== undefined && control === null) control = res.control;
      results.push({ q: r.question, asset: r.asset, page: r.page, score: res.score });
    }
    const scored = results.filter((r) => r.score !== null);
    const bad = scored.filter((r) => r.score > THRESHOLD);
    const worst = scored.reduce((m, r) => Math.max(m, r.score), 0);
    if (control !== null && control <= THRESHOLD) {
      v.add("G4.crops", "FAIL", `unhealthy environment: a deliberately misplaced crop scored ${control.toFixed(2)} (must be above ${THRESHOLD}), so this check cannot tell right from wrong here`, { examined: scored.length });
    } else {
      v.add("G4.crops", bad.length ? "FAIL" : "PASS", bad.length
        ? `${bad.length} question picture(s) differ from the same region rendered independently; first: ${bad[0].q} page ${bad[0].page} (difference ${bad[0].score.toFixed(1)})`
        : `${scored.length} question pictures equal the same page regions rendered by a different renderer${ps.pdf ? " (Poppler)" : " (the browser's image decoder)"}: worst difference ${worst.toFixed(2)}, threshold ${THRESHOLD}; misplaced-crop control ${control === null ? "n/a" : control.toFixed(1)}`,
      { examined: scored.length, expected: rows.length, details: bad.slice(0, 20) });
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function guessType(buf) {
  const b = buf.subarray(0, 12);
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF") return "image/webp";
  if (b.toString("ascii", 0, 2) === "BM") return "image/bmp";
  return "application/octet-stream";
}

/** Left side of the side-by-side page: the question's region rendered independently. */
export function regionImages(run, qid, tmpDir) {
  const ps = run.inputs.page_source;
  const rows = readJson(path.join(run.runDir, "pack", "assets.json")).filter((r) => r.question === qid && r.pixels);
  const units = run.coverage.blocks.filter((b) => b.status === "claimed" && b.by.some((c) => c.q === qid) && b.box);
  const boxes = new Map();
  for (const u of units) {
    const k = u.page;
    const bx = boxes.get(k) ?? [Infinity, Infinity, -Infinity, -Infinity];
    boxes.set(k, [Math.min(bx[0], u.box[0]), Math.min(bx[1], u.box[1]), Math.max(bx[2], u.box[2]), Math.max(bx[3], u.box[3])]);
  }
  for (const r of rows) if (!boxes.has(r.page)) boxes.set(r.page, r.box);
  const out = [];
  for (const [p, b] of [...boxes].sort((a, c) => a[0] - c[0])) {
    if (ps.pdf) {
      const base = path.join(tmpDir, `side-p${p}`);
      if (!fs.existsSync(base + ".png")) execFileSync("pdftoppm", ["-r", "110", "-f", String(p), "-l", String(p), "-png", "-singlefile", pdfPath(run), base]);
      out.push({ page: p, png: fs.readFileSync(base + ".png").toString("base64"), box: b, scale: 110 / 72, size: ps.sizes[String(p)] });
    } else {
      out.push({ page: p, png: run.sourceBytes.toString("base64"), type: guessType(run.sourceBytes), box: b, scale: 1, size: ps.sizes[String(p)] });
    }
  }
  return out;
}
