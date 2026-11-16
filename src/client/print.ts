// Printable copy of a paper (browser Print → paper or PDF). Built as one locked
// document — same rendering as the app, no scripts, no outside calls.
import { api, blobText } from "./api";
import { blobAssetResolver, documentHtml, ensureMath, inlineAssets, renderSolutionBody, renderStoredQuestion } from "./render";
import { escapeHtml } from "../shared/qpack/normalize";
import { loadStored } from "./views";

export type PrintSolutions = "none" | "end" | "after";

// The paper: a typeset exam sheet. On screen it sits on a desk-grey background as a
// page; in the app's preview it fills the frame; on paper it is plain black on white.
const PRINT_CSS = `
@page{size:A4;margin:15mm 16mm 17mm}
html,body{background:#eceae4}
body{max-width:none;margin:0;padding:28px 16px 56px;font-size:17px;line-height:1.55}
.page{max-width:820px;margin:0 auto;background:#fff;padding:56px 64px 48px;border-radius:4px;box-shadow:0 0 0 1px rgba(24,22,15,.06),0 2px 6px rgba(24,22,15,.05),0 24px 60px -24px rgba(24,22,15,.28)}
body.preview{background:#fff;padding:0} body.preview .page{max-width:none;box-shadow:none;border-radius:0;padding:44px 52px 40px}
.print-tip{max-width:820px;margin:0 auto 16px;display:flex;gap:10px;align-items:center;background:#15171c;color:#fff;border-radius:12px;padding:11px 16px;font:500 14px/1.4 var(--sans)}
.print-tip kbd{font:600 12px/1 var(--sans);background:rgba(255,255,255,.16);border-radius:5px;padding:3px 6px}
.masthead{margin-bottom:30px}
.mast-top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;font:600 11px/1.4 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.mast-brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink)}
.mast-brand i{width:9px;height:9px;border-radius:2px;background:var(--accent)}
.masthead h1{font:600 34px/1.12 var(--serif);letter-spacing:-.022em;margin:14px 0 14px;text-wrap:balance}
.mast-rule{height:0;border:0;border-top:2.5px solid var(--ink);margin:0}
.mast-facts{display:flex;flex-wrap:wrap;gap:4px 26px;padding:10px 0;border-bottom:1px solid var(--ink);font:400 13.5px/1.5 var(--sans);color:var(--ink2)}
.mast-facts b{font-weight:650;color:var(--ink)}
.mast-fields{display:grid;grid-template-columns:2fr 1.2fr 1fr;gap:26px;margin-top:22px}
.mast-fields div{display:flex;align-items:flex-end;gap:8px;height:30px;border-bottom:1px solid #9b988f;padding-bottom:5px;font:600 10.5px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.mast-fields div span{margin-left:auto;font:400 15px/1 var(--serif);letter-spacing:0;text-transform:none;color:var(--ink2)}
.mast-note{margin:18px 0 0;font:italic 400 14.5px/1.5 var(--serif);color:var(--ink2)}
.pq{display:grid;grid-template-columns:38px minmax(0,1fr) auto;column-gap:6px;break-inside:avoid;page-break-inside:avoid;padding:20px 0;border-top:1px solid var(--line)}
.pq:first-of-type{border-top:0;padding-top:0}
.pq-n{font:650 17px/1.65 var(--sans);font-variant-numeric:tabular-nums;color:var(--ink)}
.pq-n::after{content:"."}
.pq-c{min-width:0} .pq-c>div>:first-child,.pq-c>:first-child{margin-top:0} .pq-c>:last-child{margin-bottom:0}
.pq-m{font:500 12.5px/2.2 var(--sans);color:var(--muted);white-space:nowrap;padding-left:14px;font-variant-numeric:tabular-nums}
.page .options{gap:9px 28px;margin-top:.85em}
.page .options li{border:0;border-radius:0;padding:0;min-height:0;background:none;align-items:flex-start;gap:.6em}
.page .opt-label{width:24px;height:24px;margin-top:.14em;border:1.2px solid var(--ink2);font-size:12px;color:var(--ink)}
.page .marks{display:none} .page .part .marks{display:inline;float:right}
.page details.hint{display:none}
.sols{break-before:page;page-break-before:always;margin-top:44px;padding-top:30px;border-top:2.5px solid var(--ink)}
.sols h2{font:600 26px/1.2 var(--serif);letter-spacing:-.018em;margin:0 0 4px}
.sols-sub{font:400 13.5px/1.5 var(--sans);color:var(--muted);margin:0 0 20px}
.key{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:0;margin:0 0 26px;border-top:1px solid var(--ink);border-left:1px solid var(--line)}
.key div{display:flex;align-items:baseline;gap:10px;padding:7px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:15px;min-width:0}
.key b{font:650 12px/1.4 var(--sans);color:var(--muted);min-width:1.4em;font-variant-numeric:tabular-nums}
.key span{font-weight:600;overflow-wrap:anywhere}
.key-h{font:650 11px/1.4 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--ink2);margin:0 0 8px}
.psol .pq-c{font-size:.95em}
.sol{break-inside:avoid;margin:14px 0 0;padding:12px 16px;border-left:3px solid var(--ok);background:#f4faf6;border-radius:0 8px 8px 0;font-size:.95em}
.sol-title{font:650 11px/1.4 var(--sans);letter-spacing:.1em;text-transform:uppercase;color:var(--ok);margin-bottom:4px}
.sol>:last-child{margin-bottom:0}
.unv{font:500 12px/1.5 var(--sans);color:var(--mid);margin:0 0 4px}
.paper-end{margin-top:34px;text-align:center;font:600 10.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.paper-end::before,.paper-end::after{content:"";display:inline-block;vertical-align:middle;width:44px;border-top:1px solid var(--line);margin:0 14px}
@media (max-width:640px){
  body{padding:0;font-size:16px} .page,body.preview .page{padding:26px 18px 30px;border-radius:0}
  .print-tip{border-radius:0;margin:0}
  .masthead h1{font-size:26px} .mast-fields{grid-template-columns:1fr 1fr;gap:16px} .mast-fields div:first-child{grid-column:1/-1}
  .pq{grid-template-columns:28px minmax(0,1fr) auto}
  .page .options{gap:8px 16px}
}
@media print{
  html,body{background:#fff} body{padding:0;font-size:11.5pt}
  .page,body.preview .page{max-width:none;padding:0;box-shadow:none;border-radius:0}
  .print-tip{display:none}
  .masthead h1{font-size:24pt}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
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

const cssString = (t: string) => `"${t.replace(/[\\"]/g, "\\$&").replace(/[\n\r]+/g, " ")}"`;

function keyText(k: any): string | null {
  if (!k) return null;
  if (k.mcq_correct) { try { return (JSON.parse(k.mcq_correct) as string[]).join(", "); } catch { return null; } }
  if (k.numeric_value !== null && k.numeric_value !== undefined) return String(k.numeric_value) + (k.unit ? ` ${k.unit}` : "");
  if (k.text_value) { try { const v = JSON.parse(k.text_value); return Array.isArray(v) ? String(v[0]) : String(v); } catch { return String(k.text_value); } }
  return null;
}

export interface PrintOptions {
  /** Shown inside the app (no print tip, fills its frame) instead of in a print window. */
  preview?: boolean;
  /** Subject names for the fact line under the title. */
  subjects?: string[];
}

export async function buildPrintDocument(d: { paper: any; items: any[] }, solutions: PrintSolutions, opts: PrintOptions = {}): Promise<string> {
  await ensureMath();
  const items = d.items;
  const qHtml: string[] = new Array(items.length).fill("");
  const sHtml: string[] = new Array(items.length).fill("");
  const keys: (string | null)[] = new Array(items.length).fill(null);
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
      qHtml[i] = wrap(renderStoredQuestion(stored, { showMarks: true, showHints: false }), css);
    } else {
      css = it.css_sha256 ? await blobText(it.css_sha256) : null;
      qHtml[i] = wrap(await blobText(it.html_blob_sha256), css);
    }
    if (solutions !== "none") {
      const r = await api("GET", `/api/versions/${it.question_version_id}/solution`);
      const s = r.solution;
      const k = keyText(r.answer_key);
      keys[i] = k === null ? null : escapeHtml(k) + (r.answer_key?.origin === "suggestion" ? "&thinsp;*" : "");
      if (!s) sHtml[i] = "";
      else {
        const body = s.body_blob_sha256 ? wrap(await blobText(s.body_blob_sha256), css) : renderSolutionBody(s.body_format, s.body_text ?? "");
        sHtml[i] = (s.origin === "suggestion" ? `<div class="unv">AI-written solution — not yet verified</div>` : "") + body;
      }
    }
  });
  const totalMarks = items.reduce((t, it) => t + (typeof it.marks === "number" ? it.marks : 0), 0);
  const marks = (m: unknown) => `<div class="pq-m">${typeof m === "number" ? `[${m}]` : ""}</div>`;
  const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const name = String(d.paper.name ?? "Paper");
  let body = opts.preview ? "" : `<div class="print-tip"><span>To print or save as a PDF, press <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>P</kbd> — on a phone, use Share → Print.</span></div>`;
  body += `<div class="page"><header class="masthead">
<div class="mast-top"><span class="mast-brand"><i></i>Practice paper</span><span>${escapeHtml(date)}</span></div>
<h1>${escapeHtml(name)}</h1><hr class="mast-rule">
<div class="mast-facts"><span><b>${items.length}</b> question${items.length === 1 ? "" : "s"}</span>${totalMarks ? `<span><b>${totalMarks}</b> mark${totalMarks === 1 ? "" : "s"}</span>` : ""}${opts.subjects?.length ? `<span>${opts.subjects.map(escapeHtml).join(" · ")}</span>` : ""}${solutions === "none" ? "" : `<span>Solutions ${solutions === "end" ? "at the end" : "after each question"}</span>`}</div>
<div class="mast-fields"><div>Name</div><div>Date</div><div>Score${totalMarks ? `<span>/ ${totalMarks}</span>` : ""}</div></div>
<p class="mast-note">Answer every question. Show your working where it helps.${totalMarks ? " The marks for each question are shown in brackets." : ""}</p>
</header><main>`;
  items.forEach((it, i) => {
    body += `<section class="pq"><div class="pq-n">${i + 1}</div><div class="pq-c">${qHtml[i]}`;
    if (solutions === "after") body += `<div class="sol"><div class="sol-title">Solution${keys[i] ? ` · answer ${keys[i]}` : ""}</div>${sHtml[i] || `<p class="unv">No solution saved.</p>`}</div>`;
    body += `</div>${marks(it.marks)}</section>`;
  });
  body += `</main>`;
  if (solutions === "end") {
    const anyKey = keys.some((k) => k !== null);
    body += `<section class="sols"><h2>Answers &amp; solutions</h2><p class="sols-sub">${escapeHtml(name)}</p>`;
    if (anyKey) {
      body += `<h3 class="key-h">Answer key</h3><div class="key">${items.map((_, i) => `<div><b>${i + 1}</b><span>${keys[i] ?? "—"}</span></div>`).join("")}</div>`;
      if (keys.some((k) => k?.endsWith("*"))) body += `<p class="unv">* AI-suggested answer, not yet verified.</p>`;
    }
    body += `<h3 class="key-h">Worked solutions</h3>`;
    items.forEach((_, i) => (body += `<section class="pq psol"><div class="pq-n">${i + 1}</div><div class="pq-c">${sHtml[i] || `<p class="unv">No solution saved.</p>`}</div><div class="pq-m"></div></section>`));
    body += `</section>`;
  }
  body += `<div class="paper-end">End of paper</div></div>`;
  body = await inlineAssets(body, blobAssetResolver);
  const footer = `@page{@bottom-left{content:${cssString(name)};font:500 8pt "Geist",system-ui,sans-serif;color:#6a6f7d}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:500 8pt "Geist",system-ui,sans-serif;color:#6a6f7d}}`;
  return documentHtml(body, { print: !opts.preview, title: name, bodyClass: opts.preview ? "preview" : undefined, extraCss: [...scoped.values()].join("\n") + PRINT_CSS + footer });
}

/** Opens the window first (so pop-up blockers allow it), then fills it. */
export async function openPrint(d: { paper: any; items: any[] }, solutions: PrintSolutions, opts: PrintOptions = {}): Promise<void> {
  const w = window.open("", "_blank");
  if (!w) throw new Error("Your browser blocked the new tab. Allow pop-ups for this site and try again.");
  w.document.write(`<!doctype html><title>Preparing…</title><body style="margin:0;background:#eceae4"><p style="font:500 15px system-ui,sans-serif;padding:3rem;color:#6a6f7d;text-align:center">Preparing the printable paper…</p>`);
  try {
    const html = await buildPrintDocument(d, solutions, opts);
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) {
    w.document.body.textContent = `Could not prepare the paper: ${(e as Error).message}`;
    throw e;
  }
}
