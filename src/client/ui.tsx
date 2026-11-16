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

// ---------------------------------------------------------------- confirmation (the one two-step pattern used everywhere)
// First click (e.g. Delete) opens this prompt; the second click (Confirm) carries the action out. No typing needed.

export interface ConfirmOpts { title: string; message?: ComponentChildren; confirmLabel?: string; danger?: boolean }
let confirmSet: ((c: (ConfirmOpts & { resolve: (ok: boolean) => void }) | null) => void) | null = null;

/** Ask for confirmation; resolves true only when the user presses the confirm button. */
export function askConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    if (!confirmSet) { resolve(window.confirm(opts.title)); return; }
    confirmSet({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [c, setC] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null);
  confirmSet = setC;
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (c) okRef.current?.focus(); }, [c]);
  if (!c) return null;
  const done = (ok: boolean) => { setC(null); c.resolve(ok); };
  return (
    <Modal title={c.title} onClose={() => done(false)}>
      {c.message && <div class="confirm-msg">{c.message}</div>}
      <div class="row end">
        <button type="button" class="btn" onClick={() => done(false)}>Cancel</button>
        <button type="button" ref={okRef} class={`btn ${c.danger ? "danger" : "primary"}`} onClick={() => done(true)}>{c.confirmLabel ?? "Confirm"}</button>
      </div>
    </Modal>
  );
}

type ToastT = { msg: string; kind: string; action?: { label: string; run: () => void }; id: number };
let toastSet: ((t: ToastT | null) => void) | null = null;
let toastId = 0;
/** Show a short message; with `action` it carries a button (e.g. Undo) and stays up longer. */
export function toast(msg: string, kind: "ok" | "error" = "ok", action?: { label: string; run: () => void }) {
  const id = ++toastId;
  toastSet?.({ msg, kind, action, id });
  setTimeout(() => { if (toastId === id) toastSet?.(null); }, action ? 12000 : kind === "error" ? 7000 : 3000);
}
export function Toaster() {
  const [t, setT] = useState<ToastT | null>(null);
  toastSet = setT;
  if (!t) return null;
  return (
    <div class={`toast ${t.kind}${t.action ? " has-action" : ""}`} role="status">
      <span>{t.msg}</span>
      {t.action && <button type="button" class="toast-btn" onClick={() => { const a = t.action!; setT(null); a.run(); }}>{t.action.label}</button>}
    </div>
  );
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

// ---------------------------------------------------------------- appearance (Auto / Light / Dark)

export type Theme = "auto" | "light" | "dark";
export function currentTheme(): Theme {
  const a = document.documentElement.getAttribute("data-theme");
  return a === "light" || a === "dark" ? a : "auto";
}
export function setTheme(t: Theme) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try { t === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", t); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event("themechange"));
}

export function ThemeSwitch(props: { class?: string }) {
  const [t, setT] = useState<Theme>(currentTheme);
  useEffect(() => {
    const f = () => setT(currentTheme());
    window.addEventListener("themechange", f);
    return () => window.removeEventListener("themechange", f);
  }, []);
  const opts: { v: Theme; label: string; title: string }[] = [
    { v: "auto", label: "Auto", title: "Follow this device" },
    { v: "light", label: "Light", title: "Light (warm off-white)" },
    { v: "dark", label: "Dark", title: "Dark" },
  ];
  return (
    <div class={`theme-switch ${props.class ?? ""}`}>
      <div class="segctl sm" role="radiogroup" aria-label="Appearance">
        {opts.map((o) => (
          <button type="button" role="radio" aria-checked={t === o.v} class={t === o.v ? "on" : ""} title={o.title} onClick={() => setTheme(o.v)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}
