// Library = the question bank: every question in one wide, sortable table, with a
// filter bar on top and "Build paper" in the corner (it carries the current filter).
import { useEffect, useMemo, useState } from "preact/hooks";
import { compile, COND_LABELS, defaultCond, emptyFilter, type Cond, type FilterDef, type Group } from "../filter";
import { openBuilder, takePendingFilter, useData } from "../store";
import type { Boot, LibQ } from "../types";
import { conceptPath, ErrorBox, fmtDate, fmtSecs, MultiSelect, pct } from "../ui";
import { BulkEdit } from "./BulkEdit";
import { DataGrid, type GridCol } from "../grid";
import { Badge, Icon } from "../builder/controls";
import { FORMAT_SHORT, RESULT_LABEL } from "../builder/describe";
import { mainConceptPath } from "../builder/engine";
import { ConceptsCell, DiffMark, FieldsCell, HistoryCell, QuestionPeek, rankOf, avgSecs, SolutionCell, SubjectCell } from "../builder/PaperTable";
import { makeCtx, type Ctx } from "../builder/pool";
import { NONE, RESULT_BUCKETS, resultBucket } from "../builder/spec";

interface Quick { text: string; subject: string; importId: string; difficulty: string; result: string }
const noQuick = (): Quick => ({ text: "", subject: "", importId: "", difficulty: "", result: "" });
const VIEW_KEY = "library.view";

function loadView(): { def: FilterDef; quick: Quick } {
  try {
    const s = sessionStorage.getItem(VIEW_KEY);
    if (s) {
      const v = JSON.parse(s);
      if (v?.def?.v === 1) return { def: v.def, quick: { ...noQuick(), ...(v.quick ?? {}) } };
    }
  } catch { /* storage unavailable */ }
  return { def: emptyFilter(), quick: noQuick() };
}

const snippet = (t: string, n = 200) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
};
export const importName = (ctx: Ctx, q: LibQ) => (q.import_id ? ctx.importLabel.get(q.import_id) : undefined) ?? q.file_name;

export function Library() {
  const { boot, lib, error } = useData();
  const [pending] = useState(() => takePendingFilter());
  const [view, setView] = useState(() => {
    const p = pending;
    if (p && p.def) return { def: p.def as FilterDef, quick: noQuick() };
    return p ? { def: p as FilterDef, quick: noQuick() } : loadView();
  });
  const { def, quick } = view;
  const setDef = (d: FilterDef) => setView((v) => ({ ...v, def: d }));
  const setQuick = (q: Partial<Quick>) => setView((v) => ({ ...v, quick: { ...v.quick, ...q } }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulk, setShowBulk] = useState(false);
  const [showFilters, setShowFilters] = useState(() => def.groups.some((g) => g.conds.length > 0));
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* ignore */ }
  }, [view]);
  const [autoDone, setAutoDone] = useState(false);
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  const now = useMemo(() => Date.now(), [lib]);

  const results = useMemo(() => {
    if (!lib || !boot || !ctx) return [];
    const f = compile(def, boot.concepts);
    const terms = quick.text.toLowerCase().split(/\s+/).filter(Boolean);
    return lib.filter((q) => {
      if (!f(q)) return false;
      if (terms.length && !terms.every((t) => (ctx.hay.get(q.id) ?? "").includes(t) || importName(ctx, q).toLowerCase().includes(t))) return false;
      if (quick.subject && (q.subject_id ?? NONE) !== quick.subject) return false;
      if (quick.importId && !q.batches.includes(quick.importId)) return false;
      if (quick.difficulty && (q.difficulty_code ?? NONE) !== quick.difficulty) return false;
      if (quick.result && resultBucket(q) !== quick.result) return false;
      return true;
    });
  }, [lib, boot, ctx, def, quick]);

  useEffect(() => {
    if (autoDone || !pending?.selectAll || !lib || !boot) return;
    setAutoDone(true);
    setSelected(new Set(results.map((q) => q.id)));
    if (pending.openBulk && results.length) setShowBulk(true);
  }, [lib, boot, results]);

  if (error) return <ErrorBox error={error} />;
  if (!boot || !lib || !ctx) return <p class="muted">Loading library…</p>;

  const condCount = def.groups.reduce((a, g) => a + g.conds.length, 0);
  const quickCount = Object.values(quick).filter(Boolean).length;
  const allSelected = results.length > 0 && results.every((q) => selected.has(q.id));
  const toggle = (id: string) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); };
  const toggleOpen = (id: string) => { const s = new Set(open); s.has(id) ? s.delete(id) : s.add(id); setOpen(s); };
  const attempted = lib.filter((q) => q.attempt_count && !q.archived_at).length;
  const live = lib.filter((q) => !q.archived_at).length;
  const buildPaper = () => {
    const subj = quick.subject ? ctx.node.get(quick.subject === NONE ? "u:__none" : `s:${quick.subject}`) : undefined;
    openBuilder({
      def,
      pool: {
        text: quick.text.trim(),
        imports: quick.importId ? [quick.importId] : [],
        difficulty: quick.difficulty ? [quick.difficulty] : null,
        results: quick.result ? [quick.result as any] : [],
        tree: subj ? [...subj.keys] : null,
      },
    });
  };

  const cols: GridCol<LibQ>[] = [
    {
      id: "sel", label: "Select", min: 0, fr: 0, px: 44, fixed: true, sticky: true, card: "lead",
      header: <input type="checkbox" class="cb" aria-label="Select all matching questions" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(results.map((q) => q.id)))} />,
      render: (q) => <input type="checkbox" class="cb" aria-label={`Select Q${q.qno}`} checked={selected.has(q.id)} onChange={() => toggle(q.id)} />,
    },
    {
      id: "question", label: "Question", min: 240, fr: 3.2, fixed: true, sticky: true, card: "main", sortValue: (q) => q.qno,
      render: (q) => (
        <div class="dt-q">
          <div class="dt-qhead">
            <a class="dt-qno" href={`#/q/${q.id}`}>Q{q.qno}</a>
            {q.version_no > 1 && <span class="pb-badge muted">v{q.version_no}</span>}
            {q.archived_at && <span class="pb-badge warn">Archived</span>}
          </div>
          <p class="dt-snip">{snippet(q.plain_text) || <em class="muted">No text</em>}</p>
          <button type="button" class="dt-peek-btn" aria-expanded={open.has(q.id)} onClick={() => toggleOpen(q.id)}>
            <Icon name={open.has(q.id) ? "down" : "eye"} size={13} /> {open.has(q.id) ? "Hide question" : "Show question"}
          </button>
        </div>
      ),
    },
    {
      id: "import", label: "Import", min: 130, fr: 1.3, prio: 0, sortValue: (q) => importName(ctx, q),
      render: (q) => {
        const others = q.batches.filter((b) => b !== q.import_id).map((b) => ctx.importLabel.get(b) ?? "?");
        return (
          <div class="stack-tight" title={others.length ? `Also in: ${others.join(", ")}` : undefined}>
            <span class="imp-name">{importName(ctx, q)}</span>
            {others.length > 0 && <span class="sub">+{others.length} other import{others.length === 1 ? "" : "s"}</span>}
          </div>
        );
      },
    },
    { id: "subject", label: "Subject", min: 100, fr: 1, prio: 1, sortValue: (q) => (q.subject_id ? ctx.subjectName.get(q.subject_id) ?? null : null), render: (q) => <SubjectCell q={q} ctx={ctx} /> },
    { id: "concepts", label: "Concepts", min: 160, fr: 2, prio: 2, card: "full", sortValue: (q) => mainConceptPath(q, ctx) || null, render: (q) => <ConceptsCell q={q} ctx={ctx} /> },
    { id: "difficulty", label: "Difficulty", min: 118, fr: 1, prio: 3, sortValue: (q) => rankOf(ctx, q), render: (q) => (
      <div class="stack-tight">
        <DiffMark ctx={ctx} code={q.difficulty_code} />
        {q.personal_difficulty_permille !== null && <span class="sub" title="Personal difficulty">yours {pct(q.personal_difficulty_permille)}</span>}
      </div>
    ) },
    { id: "history", label: "History", min: 124, fr: 1.15, prio: 4, firstDir: "desc", sortValue: (q) => q.last_attempted_at, render: (q) => <HistoryCell q={q} now={now} /> },
    { id: "marks", label: "Marks", min: 64, fr: 0.45, prio: 5, align: "end", firstDir: "desc", sortValue: (q) => q.marks, render: (q) => (q.marks === null ? <span class="muted">—</span> : <span class="num">{q.marks}</span>) },
    { id: "solution", label: "Solution", min: 100, fr: 0.9, prio: 6, sortValue: (q) => q.has_solution ?? 0, render: (q) => <SolutionCell q={q} /> },
    { id: "added", label: "Added", min: 104, fr: 0.8, prio: 7, firstDir: "desc", sortValue: (q) => q.created_at, render: (q) => <span>{fmtDate(q.created_at)}</span> },
    { id: "format", label: "Type", min: 92, fr: 0.8, prio: 8, sortValue: (q) => FORMAT_SHORT[q.answer_format] ?? q.answer_format, render: (q) => <span>{FORMAT_SHORT[q.answer_format] ?? q.answer_format}</span> },
    { id: "time", label: "Avg time", min: 88, fr: 0.7, align: "end", sortValue: avgSecs, render: (q) => (avgSecs(q) === null ? <span class="muted">—</span> : <span class="num">{fmtSecs(avgSecs(q)!)}</span>) },
    { id: "personal", label: "Your difficulty", min: 108, fr: 0.8, align: "end", sortValue: (q) => q.personal_difficulty_permille, render: (q) => (q.personal_difficulty_permille === null ? <span class="muted">—</span> : <span class="num">{pct(q.personal_difficulty_permille)}</span>) },
    { id: "source", label: "Source file", min: 130, fr: 1.2, sortValue: (q) => q.file_name, render: (q) => <span class="dt-wrapall">{q.file_name}</span> },
    { id: "fields", label: "Custom fields", min: 150, fr: 1.4, card: "full", sortValue: (q) => Object.values(q.fields ?? {}).join(" ") || null, render: (q) => <FieldsCell q={q} ctx={ctx} /> },
  ];

  const subjects = ctx.tree.filter((n) => n.kind === "subject");
  const imports = boot.imports ?? [];

  return (
    <div class="lib">
      <header class="pb-top">
        <div class="pb-top-main">
          <span class="pb-h1">Library</span>
          <h1 class="lib-h1">Question bank</h1>
          <div class="lib-stats">
            <span><b>{live.toLocaleString()}</b> questions</span>
            <span><b>{attempted.toLocaleString()}</b> attempted</span>
            <span><b>{subjects.length}</b> subjects</span>
            <span><b>{imports.length}</b> imports</span>
          </div>
        </div>
        <div class="pb-top-actions">
          <a class="btn" href="#/import"><Icon name="plus" size={15} /> Import</a>
          <button type="button" class="btn primary" disabled={!results.length} onClick={buildPaper} title="Open the paper builder with the questions shown here">
            <Icon name="target" size={15} /> Build paper{results.length !== live ? ` (${results.length})` : ""}
          </button>
        </div>
      </header>

      {lib.length === 0 ? (
        <div class="empty card"><p>No questions yet.</p><a class="btn primary" href="#/import">Import your first questions</a></div>
      ) : (
        <>
          <section class="lib-bar">
            <label class="search-sm lib-search">
              <Icon name="search" size={16} />
              <input type="search" placeholder="Search text, Q number, ID or import name" aria-label="Search questions" value={quick.text} onInput={(e) => setQuick({ text: (e.target as HTMLInputElement).value })} />
            </label>
            <select class="sel-sm" aria-label="Subject" value={quick.subject} onChange={(e) => setQuick({ subject: (e.target as HTMLSelectElement).value })}>
              <option value="">All subjects</option>
              {subjects.map((n) => <option value={n.subjectId}>{n.label}</option>)}
              <option value={NONE}>No subject</option>
            </select>
            <select class="sel-sm" aria-label="Import" value={quick.importId} onChange={(e) => setQuick({ importId: (e.target as HTMLSelectElement).value })}>
              <option value="">All imports</option>
              {imports.map((im) => <option value={im.id}>{im.label || im.file_name}</option>)}
            </select>
            <select class="sel-sm" aria-label="Difficulty" value={quick.difficulty} onChange={(e) => setQuick({ difficulty: (e.target as HTMLSelectElement).value })}>
              <option value="">Any difficulty</option>
              {[...boot.difficulties].sort((a, b) => a.sort_rank - b.sort_rank).map((d) => <option value={d.code}>{d.label}</option>)}
              <option value={NONE}>No label</option>
            </select>
            <select class="sel-sm" aria-label="Last result" value={quick.result} onChange={(e) => setQuick({ result: (e.target as HTMLSelectElement).value })}>
              <option value="">Any result</option>
              {RESULT_BUCKETS.map((b) => <option value={b}>{RESULT_LABEL[b]}</option>)}
            </select>
            <button type="button" class={`btn small${showFilters ? " on" : ""}`} aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
              <Icon name="filter" size={14} /> More filters {condCount > 0 && <Badge tone="accent">{condCount}</Badge>}
            </button>
            {(condCount > 0 || quickCount > 0) && <button type="button" class="btn ghost small" onClick={() => setView({ def: emptyFilter(), quick: noQuick() })}>Clear all</button>}
          </section>
          {showFilters && (
            <section class="lib-filters">
              <FilterEditor boot={boot} lib={lib} def={def} onChange={setDef} />
            </section>
          )}

          {selected.size > 0 && (
            <div class="sel-bar" role="status">
              <span><b>{selected.size}</b> selected</span>
              <button type="button" class="btn small primary" onClick={() => setShowBulk(true)}>Edit {selected.size} selected</button>
              <button type="button" class="btn small ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
            </div>
          )}

          <DataGrid
            cols={cols}
            rows={results}
            rowKey={(q) => q.id}
            storageKey="library.columns"
            label="Questions"
            title={<><h2 class="dt-h">Questions</h2><span class="dt-count">{results.length.toLocaleString()}{results.length !== lib.length ? ` of ${lib.length.toLocaleString()}` : ""}</span></>}
            defaultSort={{ key: "added", dir: "desc" }}
            pageSize={100}
            rowClass={(q) => `${selected.has(q.id) ? "selected" : ""}${q.archived_at ? " archived" : ""}`}
            expanded={(q) => (open.has(q.id) ? <QuestionPeek id={q.id} qno={q.qno} marks={q.marks} /> : null)}
            empty={<div class="dt-empty-inner"><Icon name="filter" size={22} /><p><b>No questions match.</b></p><p class="muted">Clear a filter or the search to see more.</p></div>}
          />
        </>
      )}
      {showBulk && <BulkEdit boot={boot} ids={[...selected]} onClose={() => setShowBulk(false)} onDone={() => { setShowBulk(false); setSelected(new Set()); }} />}
    </div>
  );
}

export function FilterEditor(props: { boot: Boot; lib: LibQ[]; def: FilterDef; onChange: (d: FilterDef) => void }) {
  const { def, onChange } = props;
  const setGroup = (i: number, g: Group) => onChange({ ...def, groups: def.groups.map((x, j) => (j === i ? g : x)) });
  return (
    <div class="filter">
      {def.groups.map((g, gi) => (
        <div class="fgroup">
          {gi > 0 && (
            <div class="joiner">
              <select aria-label="Combine groups with" value={def.op} onChange={(e) => onChange({ ...def, op: (e.target as HTMLSelectElement).value as any })}>
                <option value="and">AND</option><option value="or">OR</option>
              </select>
            </div>
          )}
          <div class="fgroup-body">
            {g.conds.length === 0 && <p class="muted small">No conditions — every question matches.</p>}
            {g.conds.map((c, ci) => (
              <div class="fcond">
                {ci > 0 && (
                  <select class="op" aria-label="Combine with" value={g.op} onChange={(e) => setGroup(gi, { ...g, op: (e.target as HTMLSelectElement).value as any })}>
                    <option value="and">and</option><option value="or">or</option>
                  </select>
                )}
                <strong class="small">{COND_LABELS[c.type]}</strong>
                <CondEditor boot={props.boot} lib={props.lib} cond={c} onChange={(nc) => setGroup(gi, { ...g, conds: g.conds.map((x, j) => (j === ci ? nc : x)) })} />
                <button class="icon" aria-label="Remove condition" onClick={() => setGroup(gi, { ...g, conds: g.conds.filter((_, j) => j !== ci) })}>×</button>
              </div>
            ))}
            <div class="row wrap">
              <select aria-label="Add condition" value="" onChange={(e) => {
                const t = (e.target as HTMLSelectElement).value as Cond["type"];
                if (t) setGroup(gi, { ...g, conds: [...g.conds, defaultCond(t)] });
                (e.target as HTMLSelectElement).value = "";
              }}>
                <option value="">+ Add condition…</option>
                {Object.entries(COND_LABELS).map(([k, v]) => <option value={k}>{v}</option>)}
              </select>
              {def.groups.length > 1 && <button class="btn ghost small" onClick={() => onChange({ ...def, groups: def.groups.filter((_, j) => j !== gi) })}>Remove group</button>}
            </div>
          </div>
        </div>
      ))}
      <div class="row wrap">
        <button class="btn ghost small" onClick={() => onChange({ ...def, groups: [...def.groups, { op: "and", conds: [] }] })}>+ Add group (for AND / OR)</button>
        <label class="small"><input type="checkbox" checked={!!def.includeArchived} onChange={(e) => onChange({ ...def, includeArchived: (e.target as HTMLInputElement).checked })} /> Include archived</label>
      </div>
    </div>
  );
}

function CondEditor(props: { boot: Boot; lib: LibQ[]; cond: Cond; onChange: (c: Cond) => void }) {
  const { boot, cond: c, onChange } = props;
  const num = (v: string) => Math.max(0, Number(v) || 0);
  switch (c.type) {
    case "subject":
      return <MultiSelect value={c.ids} onChange={(ids) => onChange({ ...c, ids })}
        options={boot.subjects.filter((s) => !s.archived_at).map((s) => ({ value: s.id, label: s.name }))} placeholder="No subjects yet" />;
    case "concept":
      return (
        <div class="stack">
          <MultiSelect value={c.ids} onChange={(ids) => onChange({ ...c, ids })}
            options={boot.concepts.filter((x) => !x.archived_at).map((x) => ({ value: x.id, label: conceptPath(boot, x.id) }))} placeholder="No concepts yet" />
          <div class="row wrap small">
            <label><input type="checkbox" checked={c.includeSub} onChange={(e) => onChange({ ...c, includeSub: (e.target as HTMLInputElement).checked })} /> include sub-concepts</label>
            <label>min weight <input type="number" step="0.1" min="0" max="1" class="w5" value={c.minWeight} onInput={(e) => onChange({ ...c, minWeight: Math.min(1, num((e.target as HTMLInputElement).value)) })} /></label>
          </div>
        </div>
      );
    case "difficulty":
      return <MultiSelect value={c.codes} onChange={(codes) => onChange({ ...c, codes })} options={boot.difficulties.map((d) => ({ value: d.code, label: d.label }))} />;
    case "never_attempted":
    case "has_key":
      return c.type === "has_key" ? (
        <select value={String(c.value)} onChange={(e) => onChange({ ...c, value: (e.target as HTMLSelectElement).value === "true" })}>
          <option value="true">yes</option><option value="false">no</option>
        </select>
      ) : <span class="muted small">questions with no attempts</span>;
    case "attempt_count":
      return (
        <span class="row">
          <select value={c.op} onChange={(e) => onChange({ ...c, op: (e.target as HTMLSelectElement).value as any })}>
            <option value=">=">at least</option><option value="<=">at most</option><option value="=">exactly</option>
          </select>
          <input type="number" min="0" class="w5" value={c.value} onInput={(e) => onChange({ ...c, value: num((e.target as HTMLInputElement).value) })} />
        </span>
      );
    case "last_result":
      return <MultiSelect value={c.results} onChange={(r) => onChange({ ...c, results: r as any })}
        options={[{ value: "correct", label: "correct" }, { value: "incorrect", label: "incorrect" }, { value: "partial", label: "partial" }]} />;
    case "last_attempted":
    case "added":
      return (
        <span class="row">
          <select value={c.op} onChange={(e) => onChange({ ...c, op: (e.target as HTMLSelectElement).value as any })}>
            <option value="more_than">more than</option><option value="within">within the last</option>
          </select>
          <input type="number" min="0" class="w5" value={c.days} onInput={(e) => onChange({ ...c, days: num((e.target as HTMLInputElement).value) })} />
          <span class="small">days {c.op === "more_than" ? "ago" : ""}</span>
        </span>
      );
    case "personal_difficulty":
      return (
        <span class="row small">
          from <input type="number" min="0" max="100" class="w5" value={c.min} onInput={(e) => onChange({ ...c, min: num((e.target as HTMLInputElement).value) })} />
          to <input type="number" min="0" max="100" class="w5" value={c.max} onInput={(e) => onChange({ ...c, max: num((e.target as HTMLInputElement).value) })} /> %
        </span>
      );
    case "avg_time":
      return (
        <span class="row">
          <select value={c.op} onChange={(e) => onChange({ ...c, op: (e.target as HTMLSelectElement).value as any })}>
            <option value=">=">at least</option><option value="<=">at most</option>
          </select>
          <input type="number" min="0" class="w5" value={c.seconds} onInput={(e) => onChange({ ...c, seconds: num((e.target as HTMLInputElement).value) })} />
          <span class="small">seconds</span>
        </span>
      );
    case "text":
      return <input type="search" placeholder="words, Q number or ID" value={c.query} onInput={(e) => onChange({ ...c, query: (e.target as HTMLInputElement).value })} />;
    case "import": {
      const opts = (boot.imports ?? []).map((im) => ({
        value: im.id,
        label: `${im.label || im.file_name} · ${new Date(im.committed_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
      }));
      return <MultiSelect value={c.ids} onChange={(ids) => onChange({ ...c, ids })} options={opts} placeholder="No imports yet" />;
    }
    case "has_solution":
      return (
        <select value={c.value} onChange={(e) => onChange({ ...c, value: (e.target as HTMLSelectElement).value as any })}>
          <option value="any">has a solution</option><option value="none">has no solution</option><option value="unverified">AI-written, not verified</option>
        </select>
      );
    case "field": {
      const fields = boot.fields.filter((f) => !f.archived_at && f.is_filterable);
      const f = fields.find((x) => x.id === c.field_id);
      const ops: [string, string][] = !f ? [] : f.data_type === "number" ? [[">=", "at least"], ["<=", "at most"], ["equals", "equals"]]
        : f.data_type === "boolean" ? [["is_true", "is yes"], ["is_false", "is no"]]
        : f.data_type === "date" ? [["on_or_after", "on or after"], ["on_or_before", "on or before"]]
        : [["contains", "contains"], ["equals", "is exactly"]];
      return (
        <span class="row wrap">
          <select value={c.field_id} onChange={(e) => onChange({ ...c, field_id: (e.target as HTMLSelectElement).value, op: "has_value", value: "" })}>
            <option value="">choose field…</option>
            {fields.map((x) => <option value={x.id}>{x.name}</option>)}
          </select>
          {f && (
            <select value={c.op} onChange={(e) => onChange({ ...c, op: (e.target as HTMLSelectElement).value as any })}>
              <option value="has_value">has a value</option><option value="no_value">has no value</option>
              {ops.map(([v, l]) => <option value={v}>{l}</option>)}
            </select>
          )}
          {f && !["has_value", "no_value", "is_true", "is_false"].includes(c.op) && (
            <input type={(f.data_type === "number" ? "number" : f.data_type === "date" ? "date" : "text") as any} class={f.data_type === "number" ? "w5" : ""}
              value={c.value} onInput={(e) => onChange({ ...c, value: (e.target as HTMLInputElement).value })} />
          )}
          {fields.length === 0 && <span class="muted small">No filterable fields yet.</span>}
        </span>
      );
    }
    case "source_file": {
      const files = [...new Set(props.lib.map((q) => q.file_name))].sort();
      return <MultiSelect value={c.names} onChange={(names) => onChange({ ...c, names })} options={files.map((f) => ({ value: f, label: f }))} />;
    }
  }
}
