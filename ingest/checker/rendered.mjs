#!/usr/bin/env node
// Probe helper: what does the browser SHOW compared with what the file CONTAINS?  (spec 6.2, "static vs rendered")
// Runs the page in an isolated headless browser with every network request blocked. Page scripts run only
// here, only to render (R13). Prints JSON on stdout. Usage: node ingest/checker/rendered.mjs FILE.html
import path from "node:path";
import { createRequire } from "node:module";

const file = path.resolve(process.argv[2] ?? "");
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: "en-GB", javaScriptEnabled: true });
  const blocked = [];
  await ctx.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith("file:") || u.startsWith("data:")) r.continue(); else { blocked.push(u); r.abort(); } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto("file://" + file, { waitUntil: "load" });
  await page.waitForTimeout(500);
  const facts = await page.evaluate(() => {
    const words = (s) => (s.match(/[\p{L}\p{N}]+/gu) ?? []);
    const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
    // 1) generated content: ::before / ::after text and list counters
    const generated = new Map();
    for (const el of document.body.querySelectorAll("*")) {
      for (const pseudo of ["::before", "::after"]) {
        const c = getComputedStyle(el, pseudo).content;
        if (c && c !== "none" && c !== "normal" && c !== '""' && /[\p{L}\p{N}]|counter/u.test(c)) {
          const key = `${el.tagName.toLowerCase()}${el.classList.length ? "." + [...el.classList].join(".") : ""}${pseudo} -> ${c.slice(0, 60)}`;
          generated.set(key, (generated.get(key) ?? 0) + 1);
        }
      }
    }
    const lists = {};
    for (const ol of document.querySelectorAll("ol")) {
      const t = getComputedStyle(ol).listStyleType;
      if (t !== "none") lists[t] = (lists[t] ?? 0) + ol.children.length;
    }
    // 2) text in the DOM that the reader cannot see (hidden, collapsed, screen-reader only)
    const hidden = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, visibleWords = 0, hiddenWords = 0;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.trim() || SKIP.has(n.parentElement.tagName) || n.parentElement.closest("svg")) continue;
      const el = n.parentElement;
      const r = el.getClientRects();
      const st = getComputedStyle(el);
      const tiny = r.length && [...r].every((x) => x.width <= 1 && x.height <= 1);
      const isHidden = !r.length || tiny || st.visibility === "hidden" || st.opacity === "0" || !!el.closest("details:not([open]) > :not(summary)");
      const w = words(n.nodeValue).length;
      if (isHidden) {
        hiddenWords += w;
        const anc = el.closest("[class],[id]");
        const key = anc ? `${anc.tagName.toLowerCase()}${anc.id ? "#" + anc.id.replace(/\d+/g, "N") : ""}${anc.classList.length ? "." + [...anc.classList].join(".") : ""}` : el.tagName.toLowerCase();
        hidden.set(key, (hidden.get(key) ?? 0) + w);
      } else visibleWords += w;
    }
    // 3) white-space handling the reader sees
    const pre = new Map();
    for (const el of document.body.querySelectorAll("*")) {
      const ws = getComputedStyle(el).whiteSpace;
      if (ws.startsWith("pre") && el.textContent.trim()) {
        const key = `${el.tagName.toLowerCase()}${el.classList.length ? "." + [...el.classList].join(".") : ""}: ${ws}`;
        pre.set(key, (pre.get(key) ?? 0) + 1);
      }
    }
    return {
      rendered_words_visible: visibleWords, rendered_words_hidden: hiddenWords,
      hidden_text_by_region: Object.fromEntries([...hidden].sort((a, b) => b[1] - a[1]).slice(0, 25)),
      generated_text: Object.fromEntries([...generated].sort((a, b) => b[1] - a[1]).slice(0, 25)),
      list_markers_generated_by_browser: lists,
      whitespace_preserved: Object.fromEntries([...pre].sort((a, b) => b[1] - a[1]).slice(0, 20)),
      elements_after_scripts: document.body.querySelectorAll("*").length,
    };
  });
  const staticCount = await page.evaluate(async (url) => { const t = await (await fetch(url)).text(); return new DOMParser().parseFromString(t, "text/html").body.querySelectorAll("*").length; }, "file://" + file).catch(() => null);
  facts.elements_in_static_file = staticCount;
  facts.script_injected_elements = staticCount === null ? "unknown" : facts.elements_after_scripts - staticCount;
  facts.blocked_requests = blocked.slice(0, 10);
  facts.script_errors = errors.slice(0, 5);
  facts.note = "Hidden text must be claimed (e.g. a solution behind a button) or ignored with a reason. Generated labels (counters, ::before, <ol type=a>) are not in the file: the profile must account for them.";
  process.stdout.write(JSON.stringify(facts));
} finally {
  await browser.close();
}
