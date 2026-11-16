import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Boot, LibQ } from "./types";

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

export function Loading(props: { label?: string }) {
  return <div class="loading" role="status"><span class="spinner" aria-hidden="true" />{props.label ?? "Loading…"}</div>;
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

export const RESULT_TEXT: Record<string, string> = { correct: "Correct", partial: "Partly right", incorrect: "Incorrect" };

export function ResultBadge(props: { result: string | null | undefined }) {
  if (!props.result) return <span class="badge muted">Not yet</span>;
  return <span class={`badge r-${props.result}`}><i class="badge-dot" aria-hidden="true" />{RESULT_TEXT[props.result] ?? props.result}</span>;
}

/** A score as a ring: the number in the middle, the arc as the share. */
export function Ring(props: { value: number | null; size?: number; stroke?: number; label?: string; tone?: "auto" | "accent" }) {
  const size = props.size ?? 112, sw = props.stroke ?? 9;
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  const v = props.value === null ? 0 : Math.max(0, Math.min(1, props.value));
  const tone = props.value === null ? "none" : props.tone === "accent" ? "accent" : v >= 0.75 ? "good" : v >= 0.5 ? "warn" : "crit";
  return (
    <div class={`ring t-${tone}`} style={{ width: `${size}px`, height: `${size}px` }} role="img" aria-label={`${props.label ?? "Score"}: ${props.value === null ? "none yet" : Math.round(v * 100) + "%"}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle class="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={sw} />
        {props.value !== null && v > 0 && (
          <circle class="ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={sw} stroke-linecap="round"
            stroke-dasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </svg>
      <div class="ring-text">
        <b style={{ fontSize: `${Math.round(size * 0.25)}px` }}>{props.value === null ? "—" : Math.round(v * 100)}{props.value !== null && <small>%</small>}</b>
        {props.label && <span>{props.label}</span>}
      </div>
    </div>
  );
}

/** A thin horizontal meter (0..1) with the value's tone. */
export function Meter(props: { value: number; tone?: "auto" | "accent" }) {
  const v = Math.max(0, Math.min(1, props.value));
  const tone = props.tone === "accent" ? "accent" : v >= 0.75 ? "good" : v >= 0.5 ? "warn" : "crit";
  return <span class={`meter t-${tone}`} aria-hidden="true"><i style={{ width: `${Math.max(v * 100, 2)}%` }} /></span>;
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

/** Accuracy over time. Series colour follows the subject's slot, so a subject keeps its colour on every screen. */
export function LineChart(props: { series: { label: string; slot?: number; points: { x: string; y: number }[] }[]; height?: number; yMax?: number; yFmt?: (v: number) => string }) {
  const all = props.series.flatMap((s) => s.points);
  const xs = [...new Set(all.map((p) => p.x))].sort();
  const [hover, setHover] = useState<string | null>(null);
  if (xs.length === 0) return <p class="muted">No data yet.</p>;
  const W = 960, H = props.height ?? 230, P = { l: 44, r: 16, t: 14, b: 28 };
  const yMax = props.yMax ?? Math.max(1, ...all.map((p) => p.y));
  const x = (v: string) => P.l + (xs.length === 1 ? (W - P.l - P.r) / 2 : (xs.indexOf(v) / (xs.length - 1)) * (W - P.l - P.r));
  const y = (v: number) => H - P.b - (v / yMax) * (H - P.t - P.b);
  const fmt = props.yFmt ?? ((v: number) => String(Math.round(v)));
  const colour = (s: { slot?: number }, i: number) => `var(--s${s.slot ?? (i % 8) + 1})`;
  const step = Math.max(1, Math.ceil(xs.length / 7));
  const wk = (v: string) => new Date(v + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const band = xs.length > 1 ? (W - P.l - P.r) / (xs.length - 1) : W - P.l - P.r;
  return (
    <figure class="chart">
      <div class="chart-box" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly accuracy by subject">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g>
              <line x1={P.l} x2={W - P.r} y1={y(yMax * f)} y2={y(yMax * f)} class={f === 0 ? "grid base" : "grid"} />
              {f % 0.5 === 0 && <text x={P.l - 8} y={y(yMax * f) + 4} class="axis" text-anchor="end">{fmt(yMax * f)}</text>}
            </g>
          ))}
          {xs.map((v, i) => (i % step === 0 || i === xs.length - 1 ? <text x={x(v)} y={H - 8} class="axis" text-anchor="middle">{wk(v)}</text> : null))}
          {hover && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} class="cross" />}
          {props.series.map((s, i) => (
            <g>
              <polyline fill="none" stroke={colour(s, i)} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points={s.points.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")} />
              {s.points.map((p) => <circle cx={x(p.x)} cy={y(p.y)} r={hover === p.x || xs.length < 3 ? 5 : 3.5} fill={colour(s, i)} class="pt" />)}
            </g>
          ))}
          {xs.map((v) => <rect x={x(v) - band / 2} y={P.t} width={band} height={H - P.t - P.b} fill="transparent" onMouseEnter={() => setHover(v)} />)}
        </svg>
        {hover && (
          <div class={`tip chart-tip${x(hover) > W * 0.7 ? " left" : ""}`} style={{ left: `${(x(hover) / W) * 100}%`, top: "10px" }}>
            <b>Week of {wk(hover)}</b>
            {props.series.map((s, i) => {
              const p = s.points.find((q) => q.x === hover);
              return p ? <span><i style={{ background: colour(s, i) }} />{s.label}<em>{fmt(p.y)}</em></span> : null;
            })}
          </div>
        )}
      </div>
      {props.series.length > 1 && (
        <figcaption class="legend">
          {props.series.map((s, i) => <span><i style={{ background: colour(s, i) }} />{s.label}</span>)}
        </figcaption>
      )}
    </figure>
  );
}
