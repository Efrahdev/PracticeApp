import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { blobText } from "./api";
import type { Boot, LibQ } from "./types";

// ---------------------------------------------------------------- question renderer (FR-1.5)
// A locked box: no scripts (sandbox without allow-scripts), no network (CSP),
// and the app's own styles cannot leak in (separate document).
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

export function srcdoc(html: string, css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
<style>html,body{margin:0;padding:6px 8px;background:#fff;overflow:hidden}a{pointer-events:none}svg,img{max-width:100%;height:auto}</style>
</head><body>${html}</body></html>`;
}

export function QuestionFrame(props: { html?: string; css?: string; htmlSha?: string; cssSha?: string | null; title?: string; minHeight?: number }) {
  const [doc, setDoc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(props.minHeight ?? 80);

  useEffect(() => {
    let live = true;
    setErr(null);
    (async () => {
      try {
        const html = props.html ?? (props.htmlSha ? await blobText(props.htmlSha) : "");
        const css = props.css ?? (props.cssSha ? await blobText(props.cssSha) : "");
        if (live) setDoc(srcdoc(html, css));
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [props.html, props.css, props.htmlSha, props.cssSha]);

  useEffect(() => {
    const f = ref.current;
    if (!f || !doc) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const d = f.contentDocument;
      if (d?.documentElement) setH(Math.max(props.minHeight ?? 40, d.documentElement.scrollHeight + 2));
    };
    const onLoad = () => {
      measure();
      const body = f.contentDocument?.body;
      if (body && "ResizeObserver" in window) {
        ro = new ResizeObserver(measure);
        ro.observe(body);
      }
    };
    f.addEventListener("load", onLoad);
    return () => { f.removeEventListener("load", onLoad); ro?.disconnect(); };
  }, [doc]);

  if (err) return <div class="frame-error">Could not show this question: {err}</div>;
  if (!doc) return <div class="frame-loading" style={{ height: `${h}px` }}>Loading…</div>;
  return (
    <iframe
      ref={ref}
      class="qframe"
      title={props.title ?? "Question"}
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
      srcDoc={doc}
      style={{ height: `${h}px` }}
    />
  );
}

// ---------------------------------------------------------------- small helpers

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={`modal ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="modal-head">
          <h2>{props.title}</h2>
          <button class="icon" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

let toastSet: ((t: { msg: string; kind: string } | null) => void) | null = null;
export function toast(msg: string, kind: "ok" | "error" = "ok") {
  toastSet?.({ msg, kind });
  setTimeout(() => toastSet?.(null), kind === "error" ? 7000 : 3000);
}
export function Toaster() {
  const [t, setT] = useState<{ msg: string; kind: string } | null>(null);
  toastSet = setT;
  return t ? <div class={`toast ${t.kind}`} role="status">{t.msg}</div> : null;
}

export function ErrorBox(props: { error: string | null }) {
  return props.error ? <div class="error-box" role="alert">{props.error}</div> : null;
}

export function Progress(props: { msg: string; frac: number }) {
  return (
    <div class="progress">
      <div class="bar"><div style={{ width: `${Math.round(props.frac * 100)}%` }} /></div>
      <span>{props.msg}</span>
    </div>
  );
}

export const fmtDate = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
export const fmtDateTime = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export function fmtSecs(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}m ${r}s` : `${r}s`;
}
export const pct = (permille: number | null | undefined) => (permille === null || permille === undefined ? "—" : `${Math.round(permille / 10)}%`);

export function ResultBadge(props: { result: string | null | undefined }) {
  if (!props.result) return <span class="badge muted">not yet</span>;
  return <span class={`badge r-${props.result}`}>{props.result}</span>;
}

export function names(boot: Boot | null) {
  const subject = new Map(boot?.subjects.map((s) => [s.id, s.name]) ?? []);
  const concept = new Map(boot?.concepts.map((c) => [c.id, c.name]) ?? []);
  const difficulty = new Map(boot?.difficulties.map((d) => [d.code, d.label]) ?? []);
  return { subject, concept, difficulty };
}

/** Familiarity shown = stored exposure faded by time since last seen (half-life 30 days). */
export function familiarityNow(q: LibQ, now = Date.now()): number | null {
  if (q.familiarity_permille === null || q.last_attempted_at === null) return null;
  const days = (now - q.last_attempted_at) / 86_400_000;
  return Math.round(q.familiarity_permille * Math.pow(0.5, days / 30));
}

export function conceptPath(boot: Boot, id: string): string {
  const byId = new Map(boot.concepts.map((c) => [c.id, c]));
  const parts: string[] = [];
  let c = byId.get(id);
  let guard = 0;
  while (c && guard++ < 20) {
    parts.unshift(c.name);
    c = c.parent_id ? byId.get(c.parent_id) : undefined;
  }
  return parts.join(" › ");
}

export function MultiSelect(props: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const set = new Set(props.value);
  return (
    <div class="chips">
      {props.options.length === 0 && <span class="muted">{props.placeholder ?? "Nothing to choose yet"}</span>}
      {props.options.map((o) => (
        <button
          type="button"
          class={`chip ${set.has(o.value) ? "on" : ""}`}
          aria-pressed={set.has(o.value)}
          onClick={() => props.onChange(set.has(o.value) ? props.value.filter((v) => v !== o.value) : [...props.value, o.value])}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LineChart(props: { series: { label: string; points: { x: string; y: number }[] }[]; height?: number; yMax?: number; yFmt?: (v: number) => string }) {
  const all = props.series.flatMap((s) => s.points);
  const xs = [...new Set(all.map((p) => p.x))].sort();
  if (xs.length === 0) return <p class="muted">No data yet.</p>;
  const W = 640, H = props.height ?? 180, P = { l: 36, r: 10, t: 10, b: 24 };
  const yMax = props.yMax ?? Math.max(1, ...all.map((p) => p.y));
  const x = (v: string) => P.l + (xs.length === 1 ? (W - P.l - P.r) / 2 : (xs.indexOf(v) / (xs.length - 1)) * (W - P.l - P.r));
  const y = (v: number) => H - P.b - (v / yMax) * (H - P.t - P.b);
  const fmt = props.yFmt ?? ((v: number) => String(Math.round(v)));
  const colours = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];
  const step = Math.max(1, Math.ceil(xs.length / 6));
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trend chart">
        {[0, 0.5, 1].map((f) => (
          <g>
            <line x1={P.l} x2={W - P.r} y1={y(yMax * f)} y2={y(yMax * f)} class="grid" />
            <text x={P.l - 4} y={y(yMax * f) + 4} class="axis" text-anchor="end">{fmt(yMax * f)}</text>
          </g>
        ))}
        {xs.map((v, i) => (i % step === 0 || i === xs.length - 1 ? <text x={x(v)} y={H - 6} class="axis" text-anchor="middle">{v.slice(5)}</text> : null))}
        {props.series.map((s, i) => (
          <g>
            <polyline fill="none" stroke={colours[i % colours.length]} stroke-width="2.5" points={s.points.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")} />
            {s.points.map((p) => <circle cx={x(p.x)} cy={y(p.y)} r="3" fill={colours[i % colours.length]}><title>{`${s.label} ${p.x}: ${fmt(p.y)}`}</title></circle>)}
          </g>
        ))}
      </svg>
      {props.series.length > 1 && (
        <figcaption class="legend">
          {props.series.map((s, i) => <span><i style={{ background: colours[i % colours.length] }} />{s.label}</span>)}
        </figcaption>
      )}
    </figure>
  );
}
