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

const marksBadge = (m: number | null | undefined) => (m === null || m === undefined ? "" : `<span class="marks">${m} mark${m === 1 ? "" : "s"}</span>`);

const plainLen = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, "x").replace(/\s+/g, " ").trim().length;

/** How many columns a set of options can sit in: short answers share a row, long ones stack. */
export function optionColumns(htmls: string[]): 1 | 2 | 3 | 4 {
  if (htmls.some((h) => /<(table|pre|ul|ol|blockquote|details)\b|display="block"|tml-display/.test(h))) return 1;
  if (htmls.some((h) => /<(img|svg)\b/.test(h))) return 2;
  const max = Math.max(0, ...htmls.map(plainLen));
  const n = htmls.length;
  if (max <= 12) return (n <= 4 ? Math.max(2, n) : n === 6 ? 3 : 4) as 2 | 3 | 4;
  if (max <= 36) return 2;
  return 1;
}

function renderOptions(options: Option[], report?: RenderReport): string {
  if (!options.length) return "";
  const htmls = options.map((o) => renderContent(o.content, report));
  return `<ol class="options c${optionColumns(htmls)}">${options
    .map((o, i) => `<li data-label="${escapeHtml(o.label)}"><span class="opt-label">${escapeHtml(o.label)}</span><div class="opt-body">${htmls[i]}</div></li>`)
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
      ? list.map((h, i) => `<details class="hint"><summary>Hint${list.length > 1 ? ` ${i + 1}` : ""}</summary><div class="hint-body">${renderContent(h, report)}</div></details>`).join("")
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

/** The app's typefaces, declared for a document served from `origin` (the app itself, a locked frame or a print window). */
export function fontFaceCss(origin: string): string {
  const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
  const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
  const face = (family: string, file: string, weight: string, style: string, range: string) =>
    `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url("${origin}/fonts/${file}.woff2") format("woff2");unicode-range:${range}}`;
  return [
    face("Geist", "geist-latin", "100 900", "normal", LATIN),
    face("Geist", "geist-latin-ext", "100 900", "normal", LATIN_EXT),
    face("Source Serif 4", "source-serif-latin", "200 900", "normal", LATIN),
    face("Source Serif 4", "source-serif-latin-ext", "200 900", "normal", LATIN_EXT),
    face("Source Serif 4", "source-serif-italic-latin", "200 900", "italic", LATIN),
    face("Source Serif 4", "source-serif-italic-latin-ext", "200 900", "italic", LATIN_EXT),
  ].join("");
}

// The sheet: how every question, solution and printed paper is typeset. One look
// everywhere — reading serif for the words, STIX Two for the maths, the interface
// sans only for labels (option letters, part labels, marks).
const CONTENT_CSS = `
:root{color-scheme:light;--ink:#15171c;--ink2:#3b404b;--muted:#6a6f7d;--line:#e3e1da;--line2:#efede7;--tint:#f7f6f2;
--accent:#2948d4;--accent-soft:#eef1fd;--ok:#157347;--ok-soft:#e5f5ec;--bad:#b3261e;--bad-soft:#fcedeb;--mid:#8f5600;--mid-soft:#fdf2da;
--serif:"Source Serif 4",Georgia,"Times New Roman",serif;--sans:"Geist",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:var(--ink)}
body{font:400 18px/1.62 var(--serif);padding:26px 30px;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-variant-numeric:lining-nums}
p{margin:.55em 0} ul,ol{margin:.5em 0;padding-left:1.5em} li{margin:.2em 0}
strong,b{font-weight:650} h1,h2,h3,h4{font-family:var(--serif);font-weight:650;line-height:1.3;margin:1em 0 .4em} h1{font-size:1.35em} h2{font-size:1.2em} h3,h4{font-size:1.05em}
img,svg{max-width:100%;height:auto}
p>img:only-child{display:block;margin:.9em auto}
table{border-collapse:collapse;margin:.9em 0;max-width:100%;font-size:.95em;font-variant-numeric:tabular-nums lining-nums}
th,td{border:0;border-bottom:1px solid var(--line);padding:.42em 1.1em .42em .2em;text-align:left;vertical-align:top}
th{font:600 .78em/1.4 var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--ink2);border-bottom:1.5px solid var(--ink);padding-bottom:.5em}
tr:last-child>td{border-bottom:1.5px solid var(--ink)}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em;background:var(--tint);padding:.08em .32em;border-radius:4px}
pre{background:var(--tint);padding:.8em 1em;border-radius:8px;overflow:auto;font-size:.9em} pre code{background:none;padding:0}
blockquote{margin:.9em 0;padding:.7em 1.1em;border-left:3px solid var(--accent);background:var(--tint);border-radius:0 8px 8px 0;color:var(--ink)}
blockquote>:first-child{margin-top:0} blockquote>:last-child{margin-bottom:0}
hr{border:0;border-top:1px solid var(--line);margin:1.2em 0}
math{font-family:"STIX Two Math",STIX2,"Cambria Math",math;font-size:1.06em}
math:not([display=block]):not(.tml-display) mfrac>*{font-size:.84em}
math[display=block],math.tml-display{margin:.8em 0;overflow-x:auto;overflow-y:hidden;font-size:1.12em}
.math-error{color:var(--bad);background:var(--bad-soft);border-radius:4px;padding:0 .25em;font-family:ui-monospace,monospace;font-size:.82em}
.q-root>:first-child,.stem>:first-child{margin-top:0} .q-root>:last-child,.stem>:last-child{margin-bottom:0}
.stem{margin-bottom:0}

.options{list-style:none;padding:0;margin:1.15em 0 0;display:grid;gap:10px;grid-template-columns:minmax(0,1fr)}
.options.c2{grid-template-columns:repeat(2,minmax(0,1fr))} .options.c3{grid-template-columns:repeat(3,minmax(0,1fr))} .options.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
.options li{position:relative;display:flex;gap:.75em;align-items:center;margin:0;min-height:54px;border:1px solid var(--line);border-radius:12px;padding:.55em .9em .55em .7em;background:#fff;transition:border-color .12s,background .12s,box-shadow .12s}
.opt-label{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;border:1.5px solid #c9c6bd;background:#fff;color:var(--ink2);font:600 14px/1 var(--sans);transition:background .12s,border-color .12s,color .12s}
.opt-body{flex:1;min-width:0} .opt-body>:first-child{margin-top:0} .opt-body>:last-child{margin-bottom:0}
.opt-body>p>img:only-child{margin:.2em 0}
.pick>.options li{cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
.pick>.options li:not(.sel):hover{border-color:#9aa8e6;background:#fafbff}
.pick>.options li:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.options li.sel{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
.options li.sel .opt-label{background:var(--accent);border-color:var(--accent);color:#fff}
.options li.ok{border-color:var(--ok);background:var(--ok-soft);box-shadow:inset 0 0 0 1px var(--ok)}
.options li.ok .opt-label{background:var(--ok);border-color:var(--ok);color:transparent}
.options li.bad{border-color:var(--bad);background:var(--bad-soft);box-shadow:inset 0 0 0 1px var(--bad)}
.options li.bad .opt-label{background:var(--bad);border-color:var(--bad);color:transparent}
.options li.ok .opt-label::after,.options li.bad .opt-label::after{content:"";position:absolute;width:30px;height:30px;background:center/16px no-repeat}
.options li.ok .opt-label::after{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7'/%3E%3C/svg%3E")}
.options li.bad .opt-label::after{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='3.2' stroke-linecap='round'%3E%3Cpath d='M6.5 6.5l11 11M17.5 6.5l-11 11'/%3E%3C/svg%3E")}
.done>.options li:not(.ok):not(.bad){opacity:.62}
.options li .tag{position:absolute;top:-9px;right:12px;font:650 10px/1 var(--sans);letter-spacing:.07em;text-transform:uppercase;padding:4px 8px;border-radius:999px;color:#fff;white-space:nowrap}
.options li.ok .tag{background:var(--ok)} .options li.bad .tag{background:var(--bad)}
.done>.options{margin-top:1.5em}

.parts{display:grid;gap:1.05em;margin-top:1.15em}
.part{display:grid;grid-template-columns:2.1em minmax(0,1fr);gap:.2em}
.part-label{font:600 .86em/1.9 var(--sans);color:var(--accent)}
.part-body>p:first-of-type{margin-top:0} .part-body>:last-child{margin-bottom:0}
.part .options{margin-top:.7em}
.marks{float:right;margin:.25em 0 .2em 1em;color:var(--muted);font:500 12.5px/1.5 var(--sans);white-space:nowrap}
details.hint{margin:1em 0 0;border:1px solid var(--line);border-radius:10px;background:var(--tint);font-size:.94em}
details.hint summary{cursor:pointer;list-style:none;padding:.55em .9em;color:var(--ink2);font:600 13px/1.4 var(--sans)}
details.hint summary::-webkit-details-marker{display:none}
details.hint summary::before{content:"+";display:inline-block;width:1.1em;color:var(--accent);font-weight:700}
details.hint[open] summary::before{content:"\\2212"}
.hint-body{padding:0 .95em .7em 2em} .hint-body>:first-child{margin-top:0} .hint-body>:last-child{margin-bottom:0}
.html-block,.html-content{overflow-x:auto}
.plain{white-space:pre-wrap}
a{pointer-events:none;color:inherit}
body.compact{font-size:16.5px;padding:16px 18px}
@media (max-width:560px){
  body{font-size:17px;padding:18px 16px}
  .options.c3,.options.c4{grid-template-columns:repeat(2,minmax(0,1fr))}
  .options.c2{grid-template-columns:minmax(0,1fr)}
  th,td{padding-right:.7em}
}
@media (max-width:330px){.options.c3,.options.c4{grid-template-columns:minmax(0,1fr)}}
`;

let temmlCss = "";
export function setMathCss(css: string) {
  temmlCss = css;
}

/** A complete, locked HTML document for a srcdoc frame or a print window. */
export function documentHtml(body: string, opts: { extraCss?: string | null; title?: string; print?: boolean; fontOrigin?: string; bodyClass?: string } = {}): string {
  const origin = opts.fontOrigin ?? (typeof location !== "undefined" ? location.origin : "");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src ${origin} data:; media-src data:; form-action 'none'`;
  const mathCss = temmlCss
    .replace(/font-family:\s*STIX2;/, `font-family:"STIX Two Math";`)
    .replace(/src:\s*local\('STIXTwoMath'\),\s*url\([^)]*\);?/, `src:local("STIX Two Math"),local("STIXTwoMath-Regular"),url("${origin}/fonts/stix-two-math.woff2") format("woff2");font-display:swap;`);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">${opts.title ? `<title>${escapeHtml(opts.title)}</title>` : ""}
<style>${fontFaceCss(origin)}${mathCss}</style><style>${CONTENT_CSS}${opts.print ? "" : "html,body{overflow:hidden}"}</style>${opts.extraCss ? `<style>${opts.extraCss}</style>` : ""}
</head><body${opts.bodyClass ? ` class="${opts.bodyClass}"` : ""}>${body}</body></html>`;
}
