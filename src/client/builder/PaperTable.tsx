// The detailed question table used by the paper builder (editable) and a saved
// paper's page (read-only). Every cell wraps instead of spilling over; columns can
// be shown or hidden; on a phone each row becomes a labelled card.
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DataGrid, type GridCol } from "../grid";
import { api } from "../api";
import type { LibQ } from "../types";
import { fmtDate, fmtSecs, pct } from "../ui";
import { QuestionView, type VersionRef } from "../views";
import { Icon } from "./controls";
import { mainConceptPath } from "./engine";
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

const RESULT_TONE: Record<string, string> = { never: "st-none", incorrect: "st-crit", partial: "st-warn", correct: "st-good", ungraded: "st-muted" };
const snippet = (t: string, n = 220) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
};
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

/** The question itself, rendered in its locked box (fetched on demand when no exact version is given). */
export function QuestionPeek(props: { id: string; qno: string; marks: number | null; version?: VersionRef }) {
  const [v, setV] = useState<VersionRef | null>(props.version ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (props.version) return;
    let live = true;
    loadVersion(props.id).then((x) => live && setV(x)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [props.id]);
  if (err) return <div class="frame-error">Could not load the question: {err}</div>;
  if (!v) return <div class="frame-loading">Loading question…</div>;
  return <QuestionView v={v} opts={{ showMarks: true, marks: props.marks, showHints: false }} minHeight={80} title={`Question ${props.qno}`} />;
}

export interface TableActions {
  onPin: (id: string) => void;
  onReplace: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (index: number, delta: number) => void;
  onOrder: (ids: string[]) => void; // a column sort, applied to the paper
}

type Row = TableRow & { pos: number };

// ---- cells shared with the Library
export function SubjectCell(props: { q: LibQ; ctx: Ctx }) {
  const { q, ctx } = props;
  return q.subject_id
    ? <span class="dt-subj"><i class={`sw seg-s${subjectSlot(ctx, q.subject_id)}`} aria-hidden="true" />{ctx.subjectName.get(q.subject_id) ?? "Unknown"}</span>
    : <span class="muted">No subject</span>;
}
export function ConceptsCell(props: { q: LibQ; ctx: Ctx }) {
  const { q, ctx } = props;
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
export function SolutionCell(props: { q: LibQ }) {
  const { q } = props;
  return (
    <div class="stack-tight">
      {q.has_solution === 1 ? <span class="st ok"><Icon name="check" size={13} /> Verified</span>
        : q.has_solution === 2 ? <span class="st warn" title="AI-written, not checked yet">AI, unverified</span>
        : <span class="muted">None</span>}
      {!!q.has_key && <span class="sub">Answer key</span>}
    </div>
  );
}
export function HistoryCell(props: { q: LibQ; now: number }) {
  const { q } = props;
  const b = resultBucket(q);
  if (b === "never") return <span class="muted">Not attempted</span>;
  return (
    <div class="stack-tight">
      <span class="res"><i class={`dot seg-${RESULT_TONE[b]}`} aria-hidden="true" />{RESULT_LABEL[b]}</span>
      <span class="sub" title={q.last_attempted_at ? `Last attempted ${new Date(q.last_attempted_at).toLocaleString()}` : undefined}>
        <span class="nowrap">{ago(q.last_attempted_at, props.now)}</span> · <span class="nowrap">{tries(q.attempt_count ?? 0)}</span>
      </span>
    </div>
  );
}
export function FieldsCell(props: { q: LibQ; ctx: Ctx }) {
  const entries = Object.entries(props.q.fields ?? {}).filter(([, v]) => v !== null && v !== "");
  if (!entries.length) return <span class="muted">—</span>;
  return <ul class="dt-fields">{entries.map(([fid, v]) => <li><span class="muted">{props.ctx.boot.fields.find((f) => f.id === fid)?.name ?? "Field"}:</span> {String(v)}</li>)}</ul>;
}
export const avgSecs = (q: LibQ) => (q.attempt_count ? (q.total_time_seconds ?? 0) / q.attempt_count : null);
export const rankOf = (ctx: Ctx, q: LibQ) => (q.difficulty_code ? ctx.rank.get(q.difficulty_code) ?? null : null);

export function PaperTable(props: {
  rows: TableRow[];
  ctx: Ctx;
  storageKey: string;
  title: ComponentChildren;
  actions?: TableActions; // editable when given
  extraLabel?: string;
  extraSort?: (r: TableRow) => string | number | null;
  toolbar?: ComponentChildren;
  empty?: ComponentChildren;
  now?: number;
}) {
  const { ctx, actions } = props;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = props.now ?? Date.now();
  const rows: Row[] = props.rows.map((r, i) => ({ ...r, pos: i }));
  const toggleOpen = (id: string) => {
    const s = new Set(open);
    s.has(id) ? s.delete(id) : s.add(id);
    setOpen(s);
  };
  const informative = rows.some((r) => r.why && (r.why.pinned || r.why.fills.length || r.why.factors.length || r.why.over.length || (r.why.target && r.why.target !== "any")));
  const [whyShown, setWhyShown] = useState(false);

  const cols: GridCol<Row>[] = [
    {
      id: "pos", label: "#", min: 0, fr: 0, px: 46, fixed: true, sticky: true, card: "lead", sortValue: (r) => r.pos,
      render: (r, i) => (
        <div class="dt-pos">
          <span class="dt-n">{r.pos + 1}</span>
          {actions && (
            <span class="dt-mv">
              <button type="button" class="dt-ib xs" aria-label={`Move Q${r.qno} up`} title="Move up" disabled={i === 0} onClick={() => actions.onMove(i, -1)}><Icon name="up" size={13} /></button>
              <button type="button" class="dt-ib xs" aria-label={`Move Q${r.qno} down`} title="Move down" disabled={i === rows.length - 1} onClick={() => actions.onMove(i, 1)}><Icon name="dn" size={13} /></button>
            </span>
          )}
        </div>
      ),
    },
    {
      id: "question", label: "Question", min: 210, fr: 3, fixed: true, sticky: true, card: "main", sortValue: (r) => r.qno,
      render: (r) => {
        const q = r.q;
        return (
          <div class="dt-q">
            <div class="dt-qhead">
              <a class="dt-qno" href={`#/q/${q.id}`} target="_blank" rel="noopener" title="Open this question in a new tab">Q{r.qno}</a>
              {r.versionNo > 1 && <span class="pb-badge muted">v{r.versionNo}</span>}
              {r.why?.pinned && <span class="pb-badge accent"><Icon name="pin" size={11} /> Pinned</span>}
              {q.archived_at && <span class="pb-badge warn">Archived</span>}
            </div>
            <p class="dt-snip">{snippet(r.text) || <em class="muted">No text</em>}</p>
            {!whyShown && r.why && !r.why.pinned && (r.why.fills.some(([, v]) => v !== OTHER) || r.why.factors.length > 0 || r.why.over.length > 0) && <WhyCell why={r.why} ctx={ctx} />}
            <button type="button" class="dt-peek-btn" aria-expanded={open.has(q.id)} onClick={() => toggleOpen(q.id)}>
              <Icon name={open.has(q.id) ? "down" : "eye"} size={13} /> {open.has(q.id) ? "Hide question" : "Show question"}
            </button>
          </div>
        );
      },
    },
    { id: "subject", label: "Subject", min: 96, fr: 1, prio: 1, sortValue: (r) => (r.q.subject_id ? ctx.subjectName.get(r.q.subject_id) ?? null : null), render: (r) => <SubjectCell q={r.q} ctx={ctx} /> },
    { id: "concepts", label: "Concepts", min: 150, fr: 2, prio: 2, card: "full", sortValue: (r) => mainConceptPath(r.q, ctx) || null, render: (r) => <ConceptsCell q={r.q} ctx={ctx} /> },
    { id: "difficulty", label: "Difficulty", min: 118, fr: 1, prio: 3, sortValue: (r) => rankOf(ctx, r.q), render: (r) => (
      <div class="stack-tight">
        <DiffMark ctx={ctx} code={r.q.difficulty_code} />
        {r.q.personal_difficulty_permille !== null && <span class="sub" title="Personal difficulty: how hard it has been for you">yours {pct(r.q.personal_difficulty_permille)}</span>}
      </div>
    ) },
    { id: "history", label: "History", min: 124, fr: 1.15, prio: 4, firstDir: "desc", sortValue: (r) => r.q.last_attempted_at, render: (r) => <HistoryCell q={r.q} now={now} /> },
    { id: "marks", label: "Marks", min: 64, fr: 0.45, prio: 5, align: "end", firstDir: "desc", sortValue: (r) => r.q.marks, render: (r) => (r.q.marks === null ? <span class="muted">—</span> : <span class="num">{fmtNum(r.q.marks)}</span>) },
    ...(informative ? [{ id: "why", label: "Why it’s here", min: 136, fr: 1.4, prio: 6, card: "full" as const, sortValue: (r: Row) => (r.why?.pinned ? "0" : r.why?.fills.map(([d, v]) => valueLabel(d, v, ctx)).join(" ") || null), render: (r: Row) => <WhyCell why={r.why} ctx={ctx} /> }] : []),
    { id: "solution", label: "Solution", min: 100, fr: 0.9, prio: 7, sortValue: (r) => r.q.has_solution ?? 0, render: (r) => <SolutionCell q={r.q} /> },
    { id: "format", label: "Type", min: 92, fr: 0.8, prio: 8, sortValue: (r) => FORMAT_SHORT[r.q.answer_format] ?? r.q.answer_format, render: (r) => <span>{FORMAT_SHORT[r.q.answer_format] ?? r.q.answer_format}</span> },
    { id: "time", label: "Avg time", min: 88, fr: 0.7, align: "end", sortValue: (r) => avgSecs(r.q), render: (r) => (avgSecs(r.q) === null ? <span class="muted">—</span> : <span class="num">{fmtSecs(avgSecs(r.q)!)}</span>) },
    { id: "personal", label: "Your difficulty", min: 108, fr: 0.8, align: "end", sortValue: (r) => r.q.personal_difficulty_permille, render: (r) => (r.q.personal_difficulty_permille === null ? <span class="muted">—</span> : <span class="num">{pct(r.q.personal_difficulty_permille)}</span>) },
    { id: "source", label: "Source file", min: 130, fr: 1.2, sortValue: (r) => r.q.file_name, render: (r) => <span class="dt-wrapall">{r.q.file_name}</span> },
    { id: "added", label: "Added", min: 104, fr: 0.8, firstDir: "desc", sortValue: (r) => r.q.created_at, render: (r) => <span>{fmtDate(r.q.created_at)}</span> },
    { id: "fields", label: "Custom fields", min: 150, fr: 1.4, card: "full", sortValue: (r) => Object.values(r.q.fields ?? {}).join(" ") || null, render: (r) => <FieldsCell q={r.q} ctx={ctx} /> },
    ...(props.extraLabel ? [{ id: "extra", label: props.extraLabel, min: 116, fr: 1, fixed: true, sortValue: props.extraSort as ((r: Row) => string | number | null) | undefined, render: (r: Row) => r.extra ?? <span class="muted">—</span> }] : []),
    ...(actions ? [{
      id: "actions", label: "", min: 0, fr: 0, px: 108, fixed: true, card: "end" as const, render: (r: Row) => {
        const pinned = !!r.why?.pinned;
        return (
          <div class="dt-acts">
            <button type="button" class={`dt-ib${pinned ? " on" : ""}`} aria-pressed={pinned} aria-label={pinned ? `Unpin Q${r.qno}` : `Pin Q${r.qno}`}
              title={pinned ? "Unpin" : "Pin: keep this question whatever you change"} onClick={() => actions.onPin(r.q.id)}><Icon name="pin" /></button>
            <button type="button" class="dt-ib" aria-label={`Replace Q${r.qno}`} title="Replace with another question that fits the same rules"
              onClick={() => actions.onReplace(r.q.id)}><Icon name="replace" /></button>
            <button type="button" class="dt-ib danger" aria-label={`Remove Q${r.qno}`} title="Remove: the paper gets one question shorter"
              onClick={() => actions.onRemove(r.q.id)}><Icon name="x" /></button>
          </div>
        );
      },
    }] : []),
  ];

  return (
    <WhyProbe onChange={setWhyShown} storageKey={props.storageKey} informative={informative}>
      <DataGrid
        cols={cols}
        rows={rows}
        rowKey={(r) => r.q.id}
        storageKey={props.storageKey}
        label="Questions in this paper"
        title={props.title}
        toolbar={props.toolbar}
        empty={props.empty ?? "No questions."}
        sortMode={actions ? "external" : "view"}
        onSort={(sorted) => actions?.onOrder(sorted.map((r) => r.q.id))}
        rowClass={(r) => `${r.why?.pinned ? "pinned" : ""}${r.why?.over.length ? " over" : ""}${r.flash ? " flash" : ""}${r.q.archived_at ? " archived" : ""}`}
        expanded={(r) => (open.has(r.q.id) ? <QuestionPeek id={r.q.id} qno={r.qno} marks={r.q.marks} version={r.version} /> : null)}
      />
    </WhyProbe>
  );
}

/** Tells the table whether the "why" column is on screen, so rows can show the reason inline when it isn't. */
function WhyProbe(props: { onChange: (v: boolean) => void; storageKey: string; informative: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const has = !!ref.current?.querySelector(".dt-th.c-why");
    props.onChange(has);
  });
  return <div ref={ref} class="dt-probe">{props.children}</div>;
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

