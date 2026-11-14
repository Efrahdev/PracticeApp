// The detailed question table used by the paper builder (editable) and a saved
// paper's page (read-only). Every cell wraps instead of spilling over; columns can
// be shown or hidden; on a phone each row becomes a labelled card.
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { LibQ } from "../types";
import { fmtDate, fmtSecs, pct } from "../ui";
import { QuestionView, type VersionRef } from "../views";
import { Icon, readLocal, usePopover, writeLocal } from "./controls";
import { ago, difficultyTone, DIM_LABEL, FORMAT_SHORT, RESULT_LABEL, subjectSlot, valueLabel } from "./describe";
import type { Ctx } from "./pool";
import { OTHER, resultBucket, type DimKey } from "./spec";

export interface Why {
  pinned: boolean;
  fills: [DimKey, string][];
  factors: string[];
  over: DimKey[];
  target?: string; // older papers: free text
}

export interface TableRow {
  q: LibQ;
  qno: string;
  text: string;
  versionNo: number;
  why?: Why | null;
  version?: VersionRef; // the exact version to preview (saved papers)
  extra?: ComponentChildren;
  flash?: boolean; // just arrived: highlight briefly
}

type ColId =
  | "pos" | "question" | "subject" | "concepts" | "difficulty" | "marks" | "format" | "solution" | "history"
  | "time" | "personal" | "source" | "added" | "fields" | "why" | "extra" | "actions";

interface ColDef { id: ColId; label: string; fr: number; min: number; px?: number; fixed?: boolean }

// min = the narrowest a column may get before the table scrolls sideways instead.
const COLS: ColDef[] = [
  { id: "pos", label: "#", fr: 0, min: 0, px: 46, fixed: true },
  { id: "question", label: "Question", fr: 3, min: 210, fixed: true },
  { id: "subject", label: "Subject", fr: 1, min: 96 },
  { id: "concepts", label: "Concepts", fr: 2, min: 150 },
  { id: "difficulty", label: "Difficulty", fr: 1, min: 118 },
  { id: "marks", label: "Marks", fr: 0.45, min: 58 },
  { id: "format", label: "Type", fr: 0.8, min: 92 },
  { id: "solution", label: "Solution", fr: 0.9, min: 100 },
  { id: "history", label: "History", fr: 1.15, min: 124 },
  { id: "time", label: "Avg time", fr: 0.7, min: 84 },
  { id: "personal", label: "Your difficulty", fr: 0.8, min: 104 },
  { id: "source", label: "Source file", fr: 1.2, min: 130 },
  { id: "added", label: "Added", fr: 0.8, min: 104 },
  { id: "fields", label: "Custom fields", fr: 1.4, min: 150 },
  { id: "why", label: "Why it’s here", fr: 1.4, min: 136 },
  { id: "extra", label: "", fr: 1, min: 116, fixed: true },
  { id: "actions", label: "Actions", fr: 0, min: 0, px: 108, fixed: true },
];
const OPTIONAL = COLS.filter((c) => !c.fixed);
/** "Auto" shows these, most useful first, as many as fit the width. */
const AUTO_ORDER: ColId[] = ["subject", "concepts", "difficulty", "history", "marks", "why", "solution", "format"];
const colWidth = (c: ColDef) => c.px ?? c.min;
type ColPref = "auto" | ColId[];

const snippet = (t: string, n = 220) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
};
const RESULT_TONE: Record<string, string> = { never: "st-none", incorrect: "st-crit", partial: "st-warn", correct: "st-good", ungraded: "st-muted" };
const tries = (n: number) => `${n} ${n === 1 ? "try" : "tries"}`;
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const versionCache = new Map<string, Promise<VersionRef>>();
function loadVersion(id: string): Promise<VersionRef> {
  let p = versionCache.get(id);
  if (!p) {
    p = api("GET", `/api/questions/${id}`).then((d: any) => ({
      content_format: d.question.content_format,
      blob_sha256: d.question.html_blob_sha256,
      css_sha256: d.stylesheets.find((s: any) => s.question_version_id === d.question.version_id)?.blob_sha256 ?? null,
    }));
    p.catch(() => versionCache.delete(id));
    versionCache.set(id, p);
  }
  return p;
}

function QuestionPeek(props: { row: TableRow }) {
  const [v, setV] = useState<VersionRef | null>(props.row.version ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (props.row.version) return;
    let live = true;
    loadVersion(props.row.q.id).then((x) => live && setV(x)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [props.row.q.id]);
  if (err) return <div class="frame-error">Could not load the question: {err}</div>;
  if (!v) return <div class="frame-loading">Loading question…</div>;
  return <QuestionView v={v} opts={{ showMarks: true, marks: props.row.q.marks, showHints: false }} minHeight={80} title={`Question ${props.row.qno}`} />;
}

export interface TableActions {
  onPin: (id: string) => void;
  onReplace: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (index: number, delta: number) => void;
}

export function PaperTable(props: {
  rows: TableRow[];
  ctx: Ctx;
  storageKey: string;
  title: ComponentChildren;
  actions?: TableActions; // editable when given
  extraLabel?: string;
  toolbar?: ComponentChildren;
  empty?: ComponentChildren;
  now?: number;
}) {
  const { ctx, actions } = props;
  const [pref, setPrefState] = useState<ColPref>(() => {
    const saved = readLocal<unknown>(props.storageKey, "auto");
    return Array.isArray(saved) ? (saved.filter((id) => OPTIONAL.some((c) => c.id === id)) as ColId[]) : "auto";
  });
  const setPref = (p: ColPref) => { setPrefState(p); writeLocal(props.storageKey, p); };
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [scrolled, setScrolled] = useState(false);
  const now = props.now ?? Date.now();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (!("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const base = COLS.filter((c) => (c.id === "actions" ? !!actions : c.id === "extra" ? !!props.extraLabel : !!c.fixed));
  const informative = props.rows.some((r) => r.why && (r.why.pinned || r.why.fills.length || r.why.factors.length || r.why.over.length || (r.why.target && r.why.target !== "any")));
  let shown: ColId[];
  if (pref !== "auto") shown = pref;
  else {
    // Fit to the width: add columns in order of usefulness while they fit (all of them on a phone, where rows become cards).
    const order = AUTO_ORDER.filter((id) => id !== "why" || informative);
    if (!width || width < 720) shown = order;
    else {
      let used = base.reduce((a, c) => a + colWidth(c), 0);
      shown = [];
      for (const id of order) {
        const w = colWidth(COLS.find((c) => c.id === id)!);
        if (used + w > width - 2) break;
        shown.push(id);
        used += w;
      }
    }
  }
  const cols = COLS.filter((c) => base.includes(c) || shown.includes(c.id)).map((c) => (c.id === "extra" ? { ...c, label: props.extraLabel! } : c));
  const showWhy = cols.some((c) => c.id === "why");
  const template = cols.map((c) => (c.px ? `${c.px}px` : `minmax(${c.min}px, ${c.fr}fr)`)).join(" ");
  const minWidth = cols.reduce((a, c) => a + colWidth(c), 0);

  const toggleOpen = (id: string) => {
    const s = new Set(open);
    s.has(id) ? s.delete(id) : s.add(id);
    setOpen(s);
  };

  const cell = (id: ColId, r: TableRow, i: number): ComponentChildren => {
    const q = r.q;
    switch (id) {
      case "pos":
        return (
          <div class="dt-pos">
            <span class="dt-n">{i + 1}</span>
            {actions && (
              <span class="dt-mv">
                <button type="button" class="dt-ib xs" aria-label={`Move Q${r.qno} up`} title="Move up" disabled={i === 0} onClick={() => actions.onMove(i, -1)}><Icon name="up" size={13} /></button>
                <button type="button" class="dt-ib xs" aria-label={`Move Q${r.qno} down`} title="Move down" disabled={i === props.rows.length - 1} onClick={() => actions.onMove(i, 1)}><Icon name="dn" size={13} /></button>
              </span>
            )}
          </div>
        );
      case "question":
        return (
          <div class="dt-q">
            <div class="dt-qhead">
              <a class="dt-qno" href={`#/q/${q.id}`} target="_blank" rel="noopener" title="Open this question in a new tab">Q{r.qno}</a>
              {r.versionNo > 1 && <span class="pb-badge muted">v{r.versionNo}</span>}
              {r.why?.pinned && <span class="pb-badge accent"><Icon name="pin" size={11} /> Pinned</span>}
              {q.archived_at && <span class="pb-badge warn">Archived</span>}
            </div>
            <p class="dt-snip">{snippet(r.text) || <em class="muted">No text</em>}</p>
            {!showWhy && r.why && !r.why.pinned && (r.why.fills.some(([, v]) => v !== OTHER) || r.why.factors.length > 0 || r.why.over.length > 0) && <WhyCell why={r.why} ctx={ctx} />}
            <button type="button" class="dt-peek-btn" aria-expanded={open.has(q.id)} onClick={() => toggleOpen(q.id)}>
              <Icon name={open.has(q.id) ? "down" : "eye"} size={13} /> {open.has(q.id) ? "Hide question" : "Show question"}
            </button>
          </div>
        );
      case "subject":
        return q.subject_id
          ? <span class="dt-subj"><i class={`sw seg-s${subjectSlot(ctx, q.subject_id)}`} aria-hidden="true" />{ctx.subjectName.get(q.subject_id) ?? "Unknown"}</span>
          : <span class="muted">No subject</span>;
      case "concepts": {
        const tags = [...(ctx.tags.get(q.id) ?? [])].sort((a, b) => b[1] - a[1]);
        if (!tags.length) return <span class="muted">Not tagged</span>;
        return (
          <ul class="dt-concepts">
            {tags.map(([c, w]) => {
              const chain = [...(ctx.chain.get(c) ?? [c])].reverse().map((x) => ctx.concept.get(x)?.name ?? "?");
              const leaf = chain.pop();
              return (
                <li title={w < 1 ? `Tag weight ${w}` : undefined}>
                  {chain.length > 0 && <span class="cp-path">{chain.join(" › ")} › </span>}
                  <span class="cp-leaf">{leaf}</span>
                  {w < 1 && <span class="cp-w">{fmtNum(w * 100)}%</span>}
                </li>
              );
            })}
          </ul>
        );
      }
      case "difficulty":
        return (
          <div class="stack-tight">
            <DiffMark ctx={ctx} code={q.difficulty_code} />
            {q.personal_difficulty_permille !== null && <span class="sub" title="Personal difficulty: how hard it has been for you">yours {pct(q.personal_difficulty_permille)}</span>}
          </div>
        );
      case "marks":
        return q.marks === null ? <span class="muted">—</span> : <span class="num">{fmtNum(q.marks)}</span>;
      case "format":
        return <span>{FORMAT_SHORT[q.answer_format] ?? q.answer_format}</span>;
      case "solution":
        return (
          <div class="stack-tight">
            {q.has_solution === 1 ? <span class="st ok"><Icon name="check" size={13} /> Verified</span>
              : q.has_solution === 2 ? <span class="st warn" title="AI-written, not checked yet">AI, unverified</span>
              : <span class="muted">None</span>}
            {!!q.has_key && <span class="sub">Answer key</span>}
          </div>
        );
      case "history": {
        const b = resultBucket(q);
        if (b === "never") return <span class="muted">Not attempted</span>;
        return (
          <div class="stack-tight">
            <span class="res"><i class={`dot seg-${RESULT_TONE[b]}`} aria-hidden="true" />{RESULT_LABEL[b]}</span>
            <span class="sub" title={q.last_attempted_at ? `Last attempted ${new Date(q.last_attempted_at).toLocaleString()}` : undefined}>
              <span class="nowrap">{ago(q.last_attempted_at, now)}</span> · <span class="nowrap">{tries(q.attempt_count ?? 0)}</span>
            </span>
          </div>
        );
      }
      case "time":
        return q.attempt_count ? <span class="num">{fmtSecs((q.total_time_seconds ?? 0) / q.attempt_count)}</span> : <span class="muted">—</span>;
      case "personal":
        return q.personal_difficulty_permille === null ? <span class="muted">—</span> : <span class="num">{pct(q.personal_difficulty_permille)}</span>;
      case "source":
        return <span class="dt-wrapall">{q.file_name}</span>;
      case "added":
        return <span>{fmtDate(q.created_at)}</span>;
      case "fields": {
        const entries = Object.entries(q.fields ?? {}).filter(([, v]) => v !== null && v !== "");
        if (!entries.length) return <span class="muted">—</span>;
        return (
          <ul class="dt-fields">
            {entries.map(([fid, v]) => <li><span class="muted">{ctx.boot.fields.find((f) => f.id === fid)?.name ?? "Field"}:</span> {String(v)}</li>)}
          </ul>
        );
      }
      case "why":
        return <WhyCell why={r.why} ctx={ctx} />;
      case "extra":
        return r.extra ?? <span class="muted">—</span>;
      case "actions": {
        if (!actions) return null;
        const pinned = !!r.why?.pinned;
        return (
          <div class="dt-acts">
            <button type="button" class={`dt-ib${pinned ? " on" : ""}`} aria-pressed={pinned} aria-label={pinned ? `Unpin Q${r.qno}` : `Pin Q${r.qno}`}
              title={pinned ? "Unpin" : "Pin: keep this question whatever you change"} onClick={() => actions.onPin(q.id)}><Icon name="pin" /></button>
            <button type="button" class="dt-ib" aria-label={`Replace Q${r.qno}`} title="Replace with another question that fits the same rules"
              onClick={() => actions.onReplace(q.id)}><Icon name="replace" /></button>
            <button type="button" class="dt-ib danger" aria-label={`Remove Q${r.qno}`} title="Remove: the paper gets one question shorter"
              onClick={() => actions.onRemove(q.id)}><Icon name="x" /></button>
          </div>
        );
      }
    }
  };

  return (
    <div class="dt-card" ref={box}>
      <div class="dt-toolbar">
        <div class="dt-title">{props.title}</div>
        <div class="dt-tools">
          {props.toolbar}
          <ColumnMenu shown={shown} auto={pref === "auto"} setPref={setPref} />
        </div>
      </div>
      {props.rows.length === 0 ? (
        <div class="dt-empty">{props.empty ?? "No questions."}</div>
      ) : (
        <div class={`dt-wrap${scrolled ? " scrolled" : ""}`} onScroll={(e) => setScrolled((e.currentTarget as HTMLDivElement).scrollLeft > 0)}>
          <div class="dt" role="table" aria-label="Questions in this paper" aria-rowcount={props.rows.length + 1} style={`--cols:${template};min-width:${minWidth}px`}>
            <div class="dt-row dt-head" role="row">
              {cols.map((c) => <div class={`dt-th c-${c.id}`} role="columnheader">{c.id === "actions" ? <span class="sr">Actions</span> : c.label}</div>)}
            </div>
            {props.rows.map((r, i) => (
              <Fragment key={r.q.id}>
                <div class={`dt-row${r.why?.pinned ? " pinned" : ""}${r.why?.over.length ? " over" : ""}${r.flash ? " flash" : ""}`} role="row">
                  {cols.map((c) => <div class={`dt-cell c-${c.id}`} role="cell" data-label={c.id === "pos" || c.id === "question" || c.id === "actions" ? undefined : c.label}>{cell(c.id, r, i)}</div>)}
                </div>
                {open.has(r.q.id) && (
                  <div class="dt-peek" role="row">
                    <div role="cell" class="dt-peek-cell"><QuestionPeek row={r} /></div>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Difficulty as a label with "signal bars": position and colour both say how hard. */
export function DiffMark(props: { ctx: Ctx; code: string | null; label?: string }) {
  const { ctx } = props;
  const size = ctx.rank.size;
  const n = Math.min(5, Math.max(1, size));
  const r = props.code ? ctx.rank.get(props.code) : undefined;
  const level = r === undefined ? -1 : Math.round((r / Math.max(1, size - 1)) * (n - 1));
  const label = props.label ?? (props.code && r !== undefined ? valueLabel("difficulty", props.code, ctx) : "No label");
  return (
    <span class={`diff ${difficultyTone(ctx, r === undefined ? null : props.code)}`}>
      <span class="dm" aria-hidden="true">{Array.from({ length: n }, (_, k) => <i class={k <= level ? "on" : ""} style={{ height: `${5 + k * 3}px` }} />)}</span>
      {label}
    </span>
  );
}

function WhyCell(props: { why: Why | null | undefined; ctx: Ctx }) {
  const w = props.why;
  if (!w) return <span class="muted">—</span>;
  if (w.pinned) return <span class="why-pin"><Icon name="pin" size={12} /> Pinned by you</span>;
  const fills = w.fills.filter(([, v]) => v !== OTHER);
  const rest = w.fills.filter(([, v]) => v === OTHER);
  const legacy = !w.fills.length && w.target && w.target !== "any" && w.target !== "fill (mix target short)" ? w.target : null;
  if (!fills.length && !rest.length && !w.factors.length && !legacy) return <span class="muted">Random pick</span>;
  return (
    <div class="stack-tight">
      {(fills.length > 0 || rest.length > 0) && (
        <div class="why-chips">
          {fills.map(([d, v]) => <span class={`why-chip${w.over.includes(d) ? " over" : ""}`} title={`${DIM_LABEL[d]} share`}>{valueLabel(d, v, props.ctx)}</span>)}
          {rest.map(([d]) => <span class={`why-chip rest${w.over.includes(d) ? " over" : ""}`} title={`Counts towards “everything else” in the ${DIM_LABEL[d].toLowerCase()} mix`}>Other {DIM_LABEL[d].toLowerCase()}</span>)}
        </div>
      )}
      {legacy && <span class="sub">{legacy}</span>}
      {w.factors.length > 0 && <span class="sub">Favoured: {w.factors.join(", ")}</span>}
      {w.over.length > 0 && <span class="sub warn-ink">Over the {w.over.map((d) => DIM_LABEL[d].toLowerCase()).join(" and ")} target: nothing better fitted</span>}
    </div>
  );
}

function ColumnMenu(props: { shown: ColId[]; auto: boolean; setPref: (p: ColPref) => void }) {
  const pop = usePopover();
  const set = new Set(props.shown);
  const toggle = (id: ColId) => props.setPref(OPTIONAL.map((o) => o.id).filter((x) => (x === id ? !set.has(id) : set.has(x))));
  return (
    <div class="pop-wrap" ref={pop.ref}>
      <button type="button" class="btn small" aria-expanded={pop.open} aria-haspopup="true" onClick={() => pop.setOpen(!pop.open)}>
        <Icon name="columns" size={14} /> Columns{props.auto ? "" : ` · ${props.shown.length}`}
      </button>
      {pop.open && (
        <div class="pop" role="group" aria-label="Choose columns">
          <label class="pop-item strong">
            <input type="checkbox" role="switch" class="switch" checked={props.auto} onChange={() => props.setPref(props.auto ? props.shown : "auto")} />
            <span><b>Auto</b><span class="pop-sub">Show what fits the width</span></span>
          </label>
          <div class="pop-title">Columns</div>
          {OPTIONAL.map((c) => (
            <label class="pop-item">
              <input type="checkbox" class="cb" checked={set.has(c.id)} onChange={() => toggle(c.id)} />
              {c.label}
            </label>
          ))}
          <div class="pop-foot">
            <button type="button" class="btn ghost small" onClick={() => props.setPref("auto")}>Reset</button>
            <button type="button" class="btn ghost small" onClick={() => props.setPref(OPTIONAL.map((o) => o.id))}>Show all</button>
          </div>
        </div>
      )}
    </div>
  );
}
