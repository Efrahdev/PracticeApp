// Renders canonical question content (Markdown + LaTeX, or raw HTML) to HTML.
// Maths is turned into MathML by Temml, which browsers draw natively — no fonts or
// scripts needed inside the locked question box. Images are referenced as
// asset:sha256:<hex> and inlined as data: URIs, because the box may not call out.
import { Marked } from "marked";
import type { Content, Option, StoredQuestion } from "../shared/qpack/types";
import { escapeHtml } from "../shared/qpack/normalize";

type Temml = { renderToString(tex: string, opts: Record<string, unknown>): string };
let temml: Temml | null = null;
let temmlLoading: Promise<void> | null = null;

/** Loads the maths engine once (kept out of the main bundle). */
export function ensureMath(): Promise<void> {
  if (temml) return Promise.resolve();
  if (!temmlLoading) temmlLoading = import("temml").then((m) => { temml = ((m as any).default ?? m) as Temml; });
  return temmlLoading;
}

const marked = new Marked({ gfm: true, breaks: false, async: false });

export interface RenderReport { mathErrors: string[] }

function renderTex(tex: string, display: boolean, report?: RenderReport): string {
  if (!temml) return `<code class="tex">${escapeHtml(tex)}</code>`;
  try {
    return temml.renderToString(tex, { displayMode: display, throwOnError: true, annotate: false, trust: false });
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^Temml parse error:\s*/i, "");
    report?.mathErrors.push(`${msg} — in: ${tex.slice(0, 60)}`);
    return `<span class="math-error" title="${escapeHtml(msg)}">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</span>`;
  }
}

/** Markdown + LaTeX → HTML. Code spans/blocks are left alone; "\$" is a literal dollar. */
export function renderMarkdown(md: string, report?: RenderReport): string {
  const math: string[] = [];
  const hold = (html: string) => `MATHPH${math.push(html) - 1}XEND`;
  let out = "";
  let i = 0;
  const n = md.length;
  const atLineStart = (k: number) => k === 0 || md[k - 1] === "\n";
  while (i < n) {
    const c = md[i];
    // fenced code
    if ((md.startsWith("```", i) || md.startsWith("~~~", i)) && atLineStart(i)) {
      const fence = md.slice(i, i + 3);
      const end = md.indexOf(`\n${fence}`, i + 3);
      const stop = end < 0 ? n : md.indexOf("\n", end + 4) < 0 ? n : md.indexOf("\n", end + 4);
      out += md.slice(i, stop);
      i = stop;
      continue;
    }
    // inline code
    if (c === "`") {
      let k = i;
      while (md[k] === "`") k++;
      const ticks = md.slice(i, k);
      const end = md.indexOf(ticks, k);
      if (end > 0) {
        out += md.slice(i, end + ticks.length);
        i = end + ticks.length;
        continue;
      }
    }
    if (c === "\\" && (md[i + 1] === "$" || md[i + 1] === "\\")) {
      out += md.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (md.startsWith("\\[", i)) {
      const end = md.indexOf("\\]", i + 2);
      if (end > 0) {
        out += hold(renderTex(md.slice(i + 2, end), true, report));
        i = end + 2;
        continue;
      }
    }
    if (md.startsWith("\\(", i)) {
      const end = md.indexOf("\\)", i + 2);
      if (end > 0) {
        out += hold(renderTex(md.slice(i + 2, end), false, report));
        i = end + 2;
        continue;
      }
    }
    if (md.startsWith("$$", i)) {
      const end = md.indexOf("$$", i + 2);
      if (end > 0) {
        out += hold(renderTex(md.slice(i + 2, end), true, report));
        i = end + 2;
        continue;
      }
    }
    if (c === "$") {
      // inline maths: no space just inside the dollars, closing $ not followed by a digit ($5 and $10 stay money)
      if (md[i + 1] && !/\s/.test(md[i + 1])) {
        let j = i + 1;
        let found = -1;
        while (j < n) {
          if (md[j] === "\\") { j += 2; continue; }
          if (md[j] === "\n" && md[j + 1] === "\n") break;
          if (md[j] === "$") {
            if (!/\s/.test(md[j - 1]) && !/\d/.test(md[j + 1] ?? "")) found = j;
            break;
          }
          j++;
        }
        if (found > i + 1) {
          out += hold(renderTex(md.slice(i + 1, found), false, report));
          i = found + 1;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  const html = marked.parse(out) as string;
  return html.replace(/MATHPH(\d+)XEND/g, (_, k) => math[Number(k)]);
}

export function renderContent(c: Content | null | undefined, report?: RenderReport): string {
  if (!c) return "";
  if (c.html !== undefined) return `<div class="html-content">${c.html}</div>`;
  return renderMarkdown(c.md ?? "", report);
}

const marksBadge = (m: number | null | undefined) => (m === null || m === undefined ? "" : `<span class="marks">[${m} mark${m === 1 ? "" : "s"}]</span>`);

function renderOptions(options: Option[], report?: RenderReport): string {
  if (!options.length) return "";
  return `<ol class="options">${options
    .map((o) => `<li><span class="opt-label">${escapeHtml(o.label)}</span><div class="opt-body">${renderContent(o.content, report)}</div></li>`)
    .join("")}</ol>`;
}

export interface QuestionRenderOptions {
  showMarks?: boolean;
  showHints?: boolean;
  marks?: number | null; // question-level marks from metadata
}

/** A stored question (practice-app/question@1) → HTML body for the locked box. */
export function renderStoredQuestion(q: StoredQuestion, opts: QuestionRenderOptions = {}, report?: RenderReport): string {
  const hints = (list: Content[]) =>
    opts.showHints !== false && list.length
      ? list.map((h, i) => `<details class="hint"><summary>Hint${list.length > 1 ? ` ${i + 1}` : ""}</summary>${renderContent(h, report)}</details>`).join("")
      : "";
  let html = `<div class="q-root">`;
  if (opts.showMarks && opts.marks !== null && opts.marks !== undefined && !q.parts.length) html += marksBadge(opts.marks);
  if (q.stem) html += `<div class="stem">${renderContent(q.stem, report)}</div>`;
  html += renderOptions(q.options, report);
  if (q.parts.length) {
    html += `<div class="parts">${q.parts
      .map(
        (p) =>
          `<div class="part"><div class="part-label">(${escapeHtml(p.label)})</div><div class="part-body">${opts.showMarks ? marksBadge(p.marks) : ""}${renderContent(p.stem, report)}${renderOptions(p.options, report)}${hints(p.hints)}</div></div>`,
      )
      .join("")}</div>`;
  }
  html += hints(q.hints);
  return html + `</div>`;
}

export function renderSolutionBody(format: string | null | undefined, body: string, report?: RenderReport): string {
  if (format === "html") return `<div class="html-content">${body}</div>`;
  if (format === "markdown") return renderMarkdown(body, report);
  return `<div class="plain">${escapeHtml(body)}</div>`;
}

// ---------------------------------------------------------------- assets

export type AssetResolver = (hex: string) => Promise<string | null>; // → data: URI

export function assetHexes(html: string): string[] {
  return [...new Set([...html.matchAll(/asset:sha256:([0-9a-f]{64})/g)].map((m) => m[1]))];
}

const MISSING_IMG =
  "data:image/svg+xml;base64," +
  btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="60"><rect width="218" height="58" x="1" y="1" fill="#fff4e5" stroke="#d39a1c" stroke-dasharray="4"/><text x="110" y="35" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#8a5a00">image missing</text></svg>`);

export async function inlineAssets(html: string, resolve: AssetResolver): Promise<string> {
  const map = new Map<string, string | null>();
  await Promise.all(assetHexes(html).map(async (h) => map.set(h, await resolve(h).catch(() => null))));
  return html
    .replace(/asset:sha256:([0-9a-f]{64})/g, (_, h) => map.get(h) ?? MISSING_IMG)
    .replace(/asset:missing:[^"')\s]*/g, MISSING_IMG);
}

export function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime || "application/octet-stream"};base64,${btoa(bin)}`;
}

const remoteCache = new Map<string, Promise<string | null>>();
/** Resolver for stored files: fetches /api/blobs/<hex> once and caches the data: URI. */
export const blobAssetResolver: AssetResolver = (hex) => {
  let p = remoteCache.get(hex);
  if (!p) {
    p = fetch(`/api/blobs/${hex}`, { credentials: "same-origin" }).then(async (r) => {
      if (!r.ok) return null;
      return bytesToDataUri(new Uint8Array(await r.arrayBuffer()), r.headers.get("content-type") ?? "application/octet-stream");
    });
    remoteCache.set(hex, p);
  }
  return p;
};

// ---------------------------------------------------------------- documents

const CONTENT_CSS = `
:root{color-scheme:light}
html,body{margin:0;padding:0;background:#fbfaf5;color:#1c2230}
body{font:16px/1.55 Georgia,"Times New Roman",serif;padding:10px 12px;overflow-wrap:anywhere}
p{margin:.45em 0} ul,ol{margin:.4em 0;padding-left:1.6em}
img,svg{max-width:100%;height:auto} table{border-collapse:collapse;margin:.5em 0;max-width:100%}
th,td{border:1px solid #c9d0dc;padding:.3em .55em;text-align:left} th{background:#f2f4f8}
code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:#f2f4f8;padding:.05em .25em;border-radius:3px}
pre{background:#f2f4f8;padding:.6em;border-radius:6px;overflow:auto}
blockquote{margin:.5em 0;padding-left:.8em;border-left:3px solid #c9d0dc;color:#444}
math{font-size:1.08em} math[display=block],math.tml-display{margin:.5em 0;overflow-x:auto;overflow-y:hidden}
.math-error{color:#b42335;background:#fbe9eb;border-radius:3px;padding:0 .2em;font-family:ui-monospace,monospace;font-size:.85em}
.options{list-style:none;padding:0;margin:.6em 0;display:grid;gap:.35em}
.options li{display:flex;gap:.6em;align-items:baseline;border:1px solid #e2e6ee;border-radius:8px;padding:.35em .6em}
.opt-label{font-weight:700;color:#2f4a8a;min-width:1.2em} .opt-body>p:first-child{margin-top:0} .opt-body>p:last-child{margin-bottom:0}
.parts{display:grid;gap:.6em;margin-top:.6em} .part{display:flex;gap:.5em} .part-label{font-weight:700;color:#2f4a8a;min-width:2em}
.part-body{flex:1;min-width:0} .part-body>p:first-of-type{margin-top:0}
.marks{float:right;color:#667085;font:13px/1.6 system-ui,sans-serif;margin-left:.6em}
details.hint{margin:.5em 0;border:1px dashed #c9d0dc;border-radius:8px;padding:.3em .6em;font-size:.95em}
details.hint summary{cursor:pointer;color:#2f4a8a;font:600 14px system-ui,sans-serif}
.html-block,.html-content{overflow-x:auto}
.plain{white-space:pre-wrap}
a{pointer-events:none;color:inherit}
`;

let temmlCss = "";
export function setMathCss(css: string) {
  temmlCss = css;
}

/** A complete, locked HTML document for a srcdoc frame or a print window. */
export function documentHtml(body: string, opts: { extraCss?: string | null; title?: string; print?: boolean; fontOrigin?: string } = {}): string {
  const origin = opts.fontOrigin ?? (typeof location !== "undefined" ? location.origin : "");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src ${origin} data:; media-src data:; form-action 'none'`;
  const mathCss = temmlCss.replace(/url\(['"]?Temml\.woff2['"]?\)/g, `url('${origin}/fonts/Temml.woff2')`);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">${opts.title ? `<title>${escapeHtml(opts.title)}</title>` : ""}
<style>${mathCss}</style><style>${CONTENT_CSS}${opts.print ? "" : "html,body{overflow:hidden}"}</style>${opts.extraCss ? `<style>${opts.extraCss}</style>` : ""}
</head><body>${body}</body></html>`;
}
