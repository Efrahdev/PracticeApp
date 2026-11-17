// Small, accessible building blocks for the paper builder: icons, collapsible
// sections, segmented controls, switches, tri-state checkboxes, steppers and ranges.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Range } from "./spec";

const PATHS = {
  pin: "M9 3h6 M10 3v6l-3.5 4h11L14 9V3 M12 13v8",
  replace: "M3 12a9 9 0 0 1 15.4-6.4L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.4 6.4L3 16 M3 21v-5h5",
  x: "M6 6l12 12 M18 6L6 18",
  right: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  up: "M12 19V5 M6 11l6-6 6 6",
  dn: "M12 5v14 M6 13l6 6 6-6",
  shuffle: "M16 3h5v5 M4 20L21 3 M21 16v5h-5 M15 15l6 6 M4 4l5 5",
  columns: "M3 4h18v16H3z M9 4v16 M15 4v16",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4.2-4.2",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 7.5v.5",
  alert: "M12 3.5L2.5 20h19z M12 10v4.5 M12 17.2v.3",
  check: "M5 12.5l4.5 4.5L19 7",
  panel: "M3 4h18v16H3z M9 4v16",
  reset: "M3 12a9 9 0 1 0 2.8-6.5L3 8 M3 3v5h5",
  external: "M14 4h6v6 M20 4l-8.5 8.5 M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  filter: "M3 5h18l-7 8.5V19l-4 2v-7.5z",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3.5 2",
  save: "M5 3h11l4 4v14H4V4a1 1 0 0 1 1-1z M8 3v5h7 M8 21v-7h8v7",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  checkCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8.5 12.5l2.5 2.5 4.5-5",
  book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z M5 19.5A1.5 1.5 0 0 0 6.5 21H19 M9 7.5h6",
  tag: "M3 4v7.6L12.4 21 21 12.4 11.6 3H4a1 1 0 0 0-1 1z M7.5 7.5h.01",
  calendar: "M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14H4z M4 10h16 M8 3v4 M16 3v4",
  repeat: "M17 2l3 3-3 3 M4 11V9a4 4 0 0 1 4-4h12 M7 22l-3-3 3-3 M20 13v2a4 4 0 0 1-4 4H4",
  note: "M5 3h10l4 4v14H5z M14 3v5h5 M8.5 12.5h7 M8.5 16.5h5",
  sliders: "M4 6h9 M17 6h3 M15 4v4 M4 12h3 M11 12h9 M9 10v4 M4 18h11 M19 18h1 M17 16v4",
  braces: "M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1 M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1",
  bars: "M5 20v-5 M12 20V10 M19 20V4",
  layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  sort: "M7 4v16 M3 16l4 4 4-4 M17 20V4 M13 8l4-4 4 4",
  hash: "M5 9h14 M4 15h14 M10 3L8 21 M16 3l-2 18",
  sparkle: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6.3 6.3l2.5 2.5 M15.2 15.2l2.5 2.5 M6.3 17.7l2.5-2.5 M15.2 8.8l2.5-2.5",
  eyeOff: "M3 3l18 18 M10.6 5.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1 M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.3-1 M9.9 9.9a3 3 0 0 0 4.2 4.2",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; class?: string }) {
  const s = props.size ?? 16;
  return (
    <svg class={`ic ${props.class ?? ""}`} width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[props.name]} />
    </svg>
  );
}

export function Section(props: {
  title: string;
  badge?: ComponentChildren;
  hint?: ComponentChildren;
  defaultOpen?: boolean;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section class={`pb-sec${open ? " open" : ""}`}>
      <div class="pb-sec-head">
        <button type="button" class="pb-sec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="right" size={14} class="chev" />
          <span class="pb-sec-title">{props.title}</span>
          {props.badge}
        </button>
        {props.action}
      </div>
      {open && (
        <div class="pb-sec-body">
          {props.hint && <p class="pb-hint">{props.hint}</p>}
          {props.children}
        </div>
      )}
    </section>
  );
}

export function Badge(props: { children: ComponentChildren; tone?: "accent" | "muted" | "warn" | "ok" | "bad"; title?: string }) {
  return <span class={`pb-badge ${props.tone ?? "muted"}`} title={props.title}>{props.children}</span>;
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: ComponentChildren; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm";
  block?: boolean;
  class?: string;
}) {
  return (
    <div class={`segctl${props.size ? " sm" : ""}${props.block ? " block" : ""}${props.class ? ` ${props.class}` : ""}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === props.value} class={o.value === props.value ? "on" : ""}
          title={o.title} onClick={() => props.onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: ComponentChildren; disabled?: boolean }) {
  return (
    <label class={`switch-row${props.disabled ? " disabled" : ""}`}>
      <span class="switch-text">
        <span class="switch-label">{props.label}</span>
        {props.hint && <span class="switch-hint">{props.hint}</span>}
      </span>
      <input type="checkbox" role="switch" class="switch" checked={props.checked} disabled={props.disabled}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
    </label>
  );
}

export function Check(props: { state: "on" | "off" | "some"; onChange: () => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.state === "some";
  }, [props.state]);
  return (
    <input ref={ref} type="checkbox" class="cb" checked={props.state === "on"} aria-label={props.label} disabled={props.disabled}
      aria-checked={props.state === "some" ? "mixed" : props.state === "on" ? "true" : "false"} onChange={props.onChange} />
  );
}

/** Number box that lets you clear it while typing; empty = null. */
export function NumBox(props: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  class?: string;
  integer?: boolean;
}) {
  const [text, setText] = useState(props.value === null ? "" : String(props.value));
  useEffect(() => {
    const cur = text.trim() === "" ? null : Number(text);
    if (cur !== props.value) setText(props.value === null ? "" : String(props.value));
  }, [props.value]);
  const commit = (raw: string) => {
    setText(raw);
    if (raw.trim() === "") return props.onChange(null);
    let n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (props.integer) n = Math.trunc(n);
    if (props.min !== undefined) n = Math.max(props.min, n);
    if (props.max !== undefined) n = Math.min(props.max, n);
    props.onChange(n);
  };
  return (
    <input type="number" inputMode={props.integer ? "numeric" : "decimal"} class={`numbox ${props.class ?? ""}`} aria-label={props.label}
      value={text} min={props.min} max={props.max} step={props.step ?? 1} placeholder={props.placeholder ?? "any"}
      onInput={(e) => commit((e.target as HTMLInputElement).value)}
      onBlur={() => setText(props.value === null ? "" : String(props.value))} />
  );
}

export function Stepper(props: { value: number; min: number; max?: number; onChange: (n: number) => void; label: string }) {
  const clamp = (n: number) => Math.max(props.min, props.max !== undefined ? Math.min(props.max, n) : n);
  return (
    <div class="stepper">
      <button type="button" aria-label={`${props.label}: one fewer`} disabled={props.value <= props.min} onClick={() => props.onChange(clamp(props.value - 1))}>
        <Icon name="minus" size={14} />
      </button>
      <NumBox value={props.value} label={props.label} min={props.min} max={props.max} integer placeholder=""
        onChange={(v) => v !== null && props.onChange(clamp(v))} />
      <button type="button" aria-label={`${props.label}: one more`} disabled={props.max !== undefined && props.value >= props.max} onClick={() => props.onChange(clamp(props.value + 1))}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

export function RangeBox(props: { value: Range; onChange: (r: Range) => void; label: string; unit?: string; min?: number; max?: number; step?: number; integer?: boolean }) {
  return (
    <div class="rangebox" role="group" aria-label={props.label}>
      <NumBox value={props.value.min} label={`${props.label}: from`} min={props.min} max={props.max} step={props.step} integer={props.integer}
        onChange={(v) => props.onChange({ ...props.value, min: v })} />
      <span class="to">to</span>
      <NumBox value={props.value.max} label={`${props.label}: to`} min={props.min} max={props.max} step={props.step} integer={props.integer}
        onChange={(v) => props.onChange({ ...props.value, max: v })} />
      {props.unit && <span class="unit">{props.unit}</span>}
    </div>
  );
}

export function ChipToggle(props: { on: boolean; onClick: () => void; children: ComponentChildren; count?: number; title?: string; disabled?: boolean }) {
  return (
    <button type="button" class={`pb-chip${props.on ? " on" : ""}`} aria-pressed={props.on} onClick={props.onClick} title={props.title} disabled={props.disabled}>
      <span>{props.children}</span>
      {props.count !== undefined && <span class="pb-chip-n">{props.count}</span>}
    </button>
  );
}

export function Field(props: { label: ComponentChildren; children: ComponentChildren; hint?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="pb-field">
      <div class="pb-field-head">
        <span class="pb-field-label">{props.label}</span>
        {props.action}
      </div>
      {props.children}
      {props.hint && <p class="pb-hint small">{props.hint}</p>}
    </div>
  );
}

/** Closes when you click elsewhere or press Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}


// ---------------------------------------------------------------- filter studio primitives
// One visual vocabulary for every rule: a collapsible row that always shows its live summary, count tiles for
// either/or choices, and selectable rows with a proportional bar for lists. Open/closed state is remembered.

const OPEN_KEY = "pb.rows.v2";
let openRows: Record<string, boolean> | null = null;
function rowOpen(id: string, dflt: boolean): boolean {
  if (!openRows) openRows = readLocal<Record<string, boolean>>(OPEN_KEY, {});
  return openRows[id] ?? dflt;
}
function setRowOpen(id: string, v: boolean) {
  if (!openRows) openRows = readLocal<Record<string, boolean>>(OPEN_KEY, {});
  openRows[id] = v;
  writeLocal(OPEN_KEY, openRows);
}

export function FilterRow(props: {
  id: string;
  icon: IconName;
  title: string;
  summary: ComponentChildren;
  active?: boolean;
  onClear?: () => void;
  defaultOpen?: boolean;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(() => rowOpen(props.id, props.defaultOpen ?? false));
  const toggle = () => { setOpen(!open); setRowOpen(props.id, !open); };
  return (
    <section class={`fr${open ? " open" : ""}${props.active ? " active" : ""}`} data-row={props.id}>
      <div class="fr-head">
        <button type="button" class="fr-toggle" aria-expanded={open} onClick={toggle}>
          <span class="fr-ic" aria-hidden="true"><Icon name={props.icon} size={15} /></span>
          <span class="fr-title">{props.title}</span>
          <span class="fr-sum">{props.summary}</span>
          <Icon name="down" size={14} class="fr-chev" />
        </button>
        {props.active && props.onClear && (
          <button type="button" class="fr-clear" aria-label={`Clear ${props.title}`} title={`Clear ${props.title.toLowerCase()}`} onClick={props.onClear}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {open && <div class="fr-body">{props.children}</div>}
    </section>
  );
}

/** A labelled cluster of rows, e.g. "History". */
export function FilterGroup(props: { label: string; children: ComponentChildren }) {
  return (
    <div class="fg" role="group" aria-label={props.label}>
      <div class="fg-label">{props.label}</div>
      <div class="fg-rows">{props.children}</div>
    </div>
  );
}

/** Either/or choice as tiles that carry their live count. */
export function ChoiceTiles<T extends string>(props: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; full?: string; count?: number; hint?: string }[];
}) {
  return (
    <div class="tiles" role="radiogroup" aria-label={props.label} style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}>
      {props.options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === props.value} class={`tile${o.value === props.value ? " on" : ""}`} title={o.hint ?? o.full}
          aria-label={`${o.full ?? o.label}${o.count === undefined ? "" : `, ${o.count.toLocaleString()} questions`}`}
          onClick={() => props.onChange(o.value)}>
          <span class="tile-l">{o.label}</span>
          <span class="tile-n">{o.count === undefined ? "\u00a0" : o.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

export interface OptionItem { key: string; label: ComponentChildren; text: string; count: number; marker?: ComponentChildren; state?: "on" | "off" | "some" }

/** Selectable rows (tick boxes) with a count and a bar showing each value's share. */
export function OptionRows(props: { label: string; items: OptionItem[]; onToggle: (key: string) => void; scale?: number }) {
  const max = props.scale ?? Math.max(1, ...props.items.map((i) => i.count));
  return (
    <div class="opts" role="group" aria-label={props.label}>
      {props.items.map((i) => (
        <label class={`opt${i.state === "on" ? " on" : i.state === "some" ? " some" : ""}${i.count === 0 ? " zero" : ""}`}>
          <Check state={i.state ?? "off"} label={i.text} onChange={() => props.onToggle(i.key)} />
          {i.marker}
          <span class="opt-l">{i.label}</span>
          <span class="opt-n">{i.count.toLocaleString()}</span>
          <span class="opt-bar" aria-hidden="true"><i style={{ width: `${max ? Math.max(i.count ? 2 : 0, (i.count / max) * 100) : 0}%` }} /></span>
        </label>
      ))}
    </div>
  );
}

/** Small "All / None"-style text actions shown at the top of a row's body. */
export function RowTools(props: { children: ComponentChildren; note?: ComponentChildren }) {
  return <div class="row-tools">{props.note && <span class="row-note">{props.note}</span>}<span class="grow" />{props.children}</div>;
}
