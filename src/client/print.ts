// Printable copy of a paper (browser Print → paper or PDF). Built as one locked
// document — same rendering as the app, no scripts, no outside calls.
import { api, blobText } from "./api";
import { blobAssetResolver, documentHtml, ensureMath, inlineAssets, renderSolutionBody, renderStoredQuestion } from "./render";
import { escapeHtml } from "../shared/qpack/normalize";
import { loadStored } from "./views";

export type PrintSolutions = "none" | "end" | "after";

const PRINT_CSS = `
@page{margin:16mm 14mm}
body{max-width:760px;margin:0 auto;padding:20px 16px 40px}
.print-tip{background:#eef2fb;border:1px solid #c9d4ee;border-radius:8px;padding:8px 12px;font:14px system-ui,sans-serif;color:#2f4a8a;margin-bottom:16px}
@media print{.print-tip{display:none}}
.paper-head{border-bottom:2px solid #1c2230;padding-bottom:8px;margin-bottom:14px}
.paper-head h1{font:700 22px system-ui,sans-serif;margin:0 0 4px}
.paper-head .meta{font:13px system-ui,sans-serif;color:#555;display:flex;flex-wrap:wrap;gap:4px 18px}
.namebox{font:13px system-ui,sans-serif;margin-top:10px;display:flex;gap:30px}
.namebox span{flex:1;border-bottom:1px solid #999;padding-bottom:14px}
.pq{break-inside:avoid;page-break-inside:avoid;margin:0 0 18px;padding-bottom:10px;border-bottom:1px dashed #ccd}
.pq-head{display:flex;gap:10px;align-items:baseline;font:700 15px system-ui,sans-serif;margin-bottom:2px}
.pq-head .orig{font-weight:400;color:#888;font-size:12px}
.pq-head .m{margin-left:auto;font-weight:400;color:#555;font-size:13px}
.sol{break-inside:avoid;margin:8px 0 0;padding:8px 10px;border-left:3px solid #3a9d5d;background:#f6fbf7}
.sol-title{font:700 13px system-ui,sans-serif;color:#1f7a47;margin-bottom:2px}
.sols{break-before:page;page-break-before:always}
.sols h2{font:700 18px system-ui,sans-serif;border-bottom:2px solid #1c2230;padding-bottom:6px}
.unv{font:12px system-ui,sans-serif;color:#a26300}
.marks{display:none}
`;

/**
 * Scopes a stylesheet to one wrapper class, so the styles of different source files
 * (and of the app) cannot clash in one printed document. :root / html / body rules
 * become rules for the wrapper itself; @media/@supports are scoped recursively.
 */
export function scopeCss(css: string, scope: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(import|charset|namespace)[^;]*;/g, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const brace = src.indexOf("{", i);
    if (brace < 0) break;
    const prelude = src.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < src.length && depth) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(brace + 1, j - 1);
    i = j;
    if (!prelude) continue;
    if (/^@(media|supports|container|layer)\b/i.test(prelude)) out += `${prelude}{${scopeCss(body, scope)}}`;
    else if (/^@page\b/i.test(prelude)) continue; // the paper sets its own page
    else if (prelude.startsWith("@")) out += `${prelude}{${body}}`; // @font-face, @keyframes
    else {
      const sels = prelude.split(",").map((sel) => {
        const t = sel.trim();
        if (/^(:root|html|body)$/i.test(t)) return scope;
        return `${scope} ${t.replace(/^(:root|html|body)\b\s*/i, "")}`;
      });
      out += `${sels.join(",")}{${body}}`;
    }
  }
  return out;
}

const shortHash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  }));
}

export async function buildPrintDocument(d: { paper: any; items: any[] }, solutions: PrintSolutions): Promise<string> {
  await ensureMath();
  const items = d.items;
  const qHtml: string[] = new Array(items.length).fill("");
  const sHtml: string[] = new Array(items.length).fill("");
  const scoped = new Map<string, string>(); // wrapper class → scoped CSS
  const wrap = (html: string, css: string | null) => {
    if (!css) return html;
    const cls = `src-${shortHash(css)}`;
    if (!scoped.has(cls)) scoped.set(cls, scopeCss(css, `.${cls}`));
    return `<div class="${cls}">${html}</div>`;
  };
  await pool(items, 6, async (it, i) => {
    let css: string | null = null;
    if (it.content_format === "qpack_v1") {
      const stored = await loadStored(it.html_blob_sha256);
      css = stored.css;
      qHtml[i] = wrap(renderStoredQuestion(stored, { showMarks: false, showHints: false }), css);
    } else {
      css = it.css_sha256 ? await blobText(it.css_sha256) : null;
      qHtml[i] = wrap(await blobText(it.html_blob_sha256), css);
    }
    if (solutions !== "none") {
      const r = await api("GET", `/api/versions/${it.question_version_id}/solution`);
      const s = r.solution;
      if (!s) sHtml[i] = `<p class="unv">No solution saved.</p>`;
      else {
        const body = s.body_blob_sha256 ? wrap(await blobText(s.body_blob_sha256), css) : renderSolutionBody(s.body_format, s.body_text ?? "");
        sHtml[i] = (s.origin === "suggestion" ? `<div class="unv">AI-written solution — not yet verified</div>` : "") + body;
      }
    }
  });
  const totalMarks = items.reduce((t, it) => t + (typeof it.marks === "number" ? it.marks : 0), 0);
  const marks = (m: unknown) => (typeof m === "number" ? `<span class="m">[${m} mark${m === 1 ? "" : "s"}]</span>` : "");
  let body = `<div class="print-tip">Use your browser's <b>Print</b> (Ctrl/⌘ + P, or Share → Print on a phone) to print or save as PDF.</div>
<div class="paper-head"><h1>${escapeHtml(d.paper.name)}</h1><div class="meta"><span>${items.length} questions</span>${totalMarks ? `<span>${totalMarks} marks</span>` : ""}<span>${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</span>${solutions === "none" ? "" : "<span>with solutions</span>"}</div>
<div class="namebox"><span>Name</span><span>Date</span><span>Score</span></div></div>`;
  items.forEach((it, i) => {
    body += `<div class="pq"><div class="pq-head"><span>${i + 1}.</span><span class="orig">Q${escapeHtml(String(it.qno ?? ""))}</span>${marks(it.marks)}</div>${qHtml[i]}`;
    if (solutions === "after") body += `<div class="sol"><div class="sol-title">Solution</div>${sHtml[i]}</div>`;
    body += `</div>`;
  });
  if (solutions === "end") {
    body += `<section class="sols"><h2>Solutions</h2>`;
    items.forEach((_, i) => (body += `<div class="pq"><div class="pq-head"><span>${i + 1}.</span></div>${sHtml[i]}</div>`));
    body += `</section>`;
  }
  body = await inlineAssets(body, blobAssetResolver);
  return documentHtml(body, { print: true, title: d.paper.name, extraCss: [...scoped.values()].join("\n") + PRINT_CSS });
}

/** Opens the window first (so pop-up blockers allow it), then fills it. */
export async function openPrint(d: { paper: any; items: any[] }, solutions: PrintSolutions): Promise<void> {
  const w = window.open("", "_blank");
  if (!w) throw new Error("Your browser blocked the new tab. Allow pop-ups for this site and try again.");
  w.document.write(`<!doctype html><title>Preparing…</title><p style="font-family:system-ui;padding:2rem;color:#666">Preparing the printable paper…</p>`);
  try {
    const html = await buildPrintDocument(d, solutions);
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) {
    w.document.body.textContent = `Could not prepare the paper: ${(e as Error).message}`;
    throw e;
  }
}
