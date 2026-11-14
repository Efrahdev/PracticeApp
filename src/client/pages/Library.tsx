import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { compile, COND_LABELS, defaultCond, emptyFilter, parseDef, type Cond, type FilterDef, type Group } from "../filter";
import { refresh, takePendingFilter, useData } from "../store";
import type { Boot, LibQ } from "../types";
import { conceptPath, ErrorBox, fmtDate, fmtSecs, familiarityNow, Modal, MultiSelect, names, pct, ResultBadge, toast } from "../ui";
import { PaperBuilder } from "./PaperBuilder";
import { BulkEdit } from "./BulkEdit";

const SESSION_KEY = "library.filter";
function loadFilter(): { def: FilterDef; savedId: string | null } {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    if (s) return JSON.parse(s);
  } catch { /* storage unavailable */ }
  return { def: emptyFilter(), savedId: null };
}

export function Library() {
  const { boot, lib, error } = useData();
  const [pending] = useState(() => takePendingFilter());
  const [state, setState] = useState(() => {
    const p = pending;
    if (p && p.def) return { def: p.def as FilterDef, savedId: null };
    return p ? { def: p as FilterDef, savedId: null } : loadFilter();
  });
  const { def, savedId } = state;
  const setDef = (d: FilterDef, id: string | null = savedId) => setState({ def: d, savedId: id });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBuilder, setShowBuilder] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [limit, setLimit] = useState(100);
  const [sort, setSort] = useState<"qno" | "added" | "last" | "attempts">("added");

  useEffect(() => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }, [state]);
  // Arriving from an import's "Edit questions": select everything it matched and open the form.
  const [autoDone, setAutoDone] = useState(false);

  const results = useMemo(() => {
    if (!lib || !boot) return [];
    const t0 = performance.now();
    const f = compile(def, boot.concepts);
    const out = lib.filter(f);
    const cmp: Record<typeof sort, (a: LibQ, b: LibQ) => number> = {
      qno: (a, b) => a.file_name.localeCompare(b.file_name) || Number(a.qno) - Number(b.qno),
      added: (a, b) => b.created_at - a.created_at || Number(a.qno) - Number(b.qno),
      last: (a, b) => (b.last_attempted_at ?? 0) - (a.last_attempted_at ?? 0),
      attempts: (a, b) => (b.attempt_count ?? 0) - (a.attempt_count ?? 0),
    };
    out.sort(cmp[sort]);
    (out as any).ms = performance.now() - t0;
    return out;
  }, [lib, boot, def, sort]);

  useEffect(() => {
    if (autoDone || !pending?.selectAll || !lib || !boot) return;
    setAutoDone(true);
    setSelected(new Set(results.map((q) => q.id)));
    if (pending.openBulk && results.length) setShowBulk(true);
  }, [lib, boot, results]);

  if (error) return <ErrorBox error={error} />;
  if (!boot || !lib) return <p class="muted">Loading library…</p>;
  const n = names(boot);

  const saveFilter = async () => {
    const existing = boot.filters.find((f) => f.id === savedId);
    const name = prompt("Name for this filter:", existing?.name ?? "");
    if (!name) return;
    try {
      const r = existing && existing.name === name
        ? await api("PUT", `/api/filters/${existing.id}`, { name, definition: def })
        : await api("POST", "/api/filters", { name, definition: def });
      await refresh();
      setDef(def, r.id);
      toast("Filter saved");
    } catch (e) { toast((e as Error).message, "error"); }
  };

  const allSelected = results.length > 0 && results.every((q) => selected.has(q.id));

  return (
    <div class="page">
      <div class="page-head">
        <h1>Library</h1>
        <span class="muted">{lib.length} question{lib.length === 1 ? "" : "s"}</span>
      </div>

      {lib.length === 0 ? (
        <div class="empty">
          <p>No questions yet.</p>
          <a class="btn primary" href="#/import">Import your first HTML file</a>
        </div>
      ) : (
        <>
          <section class="card">
            <div class="row wrap">
              <label class="grow">
                <span class="sr">Saved filters</span>
                <select
                  value={savedId ?? ""}
                  onChange={(e) => {
                    const id = (e.target as HTMLSelectElement).value;
                    const f = boot.filters.find((x) => x.id === id);
                    setDef(f ? parseDef(f.definition) : emptyFilter(), f ? f.id : null);
                  }}
                >
                  <option value="">— Saved filters —</option>
                  {boot.filters.map((f) => <option value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <button class="btn" onClick={saveFilter}>Save filter</button>
              {savedId && (
                <button class="btn ghost" onClick={async () => {
                  if (!confirm("Remove this saved filter?")) return;
                  await api("DELETE", `/api/filters/${savedId}`);
                  await refresh();
                  setDef(def, null);
                }}>Delete</button>
              )}
              <button class="btn ghost" onClick={() => setDef(emptyFilter(), null)}>Clear</button>
            </div>
            <FilterEditor boot={boot} lib={lib} def={def} onChange={(d) => setDef(d)} />
          </section>

          <div class="row wrap results-head">
            <strong>{results.length} match{results.length === 1 ? "" : "es"}</strong>
            <span class="muted small">({Math.max(1, Math.round((results as any).ms ?? 0))} ms)</span>
            <span class="grow" />
            <label class="small">Sort{" "}
              <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as any)}>
                <option value="added">Newest first</option>
                <option value="qno">File &amp; number</option>
                <option value="last">Last attempted</option>
                <option value="attempts">Most attempts</option>
              </select>
            </label>
            {selected.size > 0 && <button class="btn" onClick={() => setShowBulk(true)}>Edit {selected.size} selected</button>}
            <button class="btn primary" disabled={!results.length} onClick={() => setShowBuilder(true)}>Build paper</button>
          </div>

          <div class="qlist" role="list">
            <div class="qrow head" role="listitem">
              <input type="checkbox" aria-label="Select all" checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(results.map((q) => q.id)))} />
              <span>Question</span><span class="hide-sm">Subject · concepts</span><span>Label</span><span>Tries</span><span>Last</span>
            </div>
            {results.slice(0, limit).map((q) => (
              <div class={`qrow ${q.archived_at ? "archived" : ""}`} role="listitem">
                <input type="checkbox" aria-label={`Select Q${q.qno}`} checked={selected.has(q.id)}
                  onChange={() => { const s = new Set(selected); s.has(q.id) ? s.delete(q.id) : s.add(q.id); setSelected(s); }} />
                <a href={`#/q/${q.id}`} class="qmain">
                  <span class="qtitle">Q{q.qno} <span class="muted small">· {q.file_name}{q.version_no > 1 ? ` · v${q.version_no}` : ""}{q.marks !== null ? ` · ${q.marks}m` : ""}{q.has_solution === 2 ? " · AI solution" : q.has_solution ? " · solution" : ""}</span></span>
                  <span class="qtext">{q.plain_text.slice(0, 120)}</span>
                </a>
                <span class="hide-sm small">
                  {q.subject_id ? n.subject.get(q.subject_id) : <em class="muted">no subject</em>}
                  {q.concepts.length > 0 && <span class="muted"> · {q.concepts.map(([c]) => n.concept.get(c)).join(", ")}</span>}
                </span>
                <span class="small">{q.difficulty_code ? n.difficulty.get(q.difficulty_code) : "—"}
                  {q.personal_difficulty_permille !== null && <span class="muted" title="Personal difficulty"> · {pct(q.personal_difficulty_permille)}</span>}
                </span>
                <span class="small" title={q.attempt_count ? `Average ${fmtSecs((q.total_time_seconds ?? 0) / q.attempt_count)} · familiarity ${pct(familiarityNow(q))}` : ""}>
                  {q.attempt_count ?? 0}
                </span>
                <span class="small"><ResultBadge result={q.last_result} /> <span class="muted hide-sm">{fmtDate(q.last_attempted_at)}</span></span>
              </div>
            ))}
          </div>
          {results.length > limit && <button class="btn ghost block" onClick={() => setLimit(limit + 200)}>Show more ({results.length - limit} left)</button>}
        </>
      )}

      {showBuilder && <PaperBuilder candidates={results} def={def} savedFilterId={savedId} onClose={() => setShowBuilder(false)} />}
      {showBulk && <BulkEdit boot={boot} ids={[...selected]} onClose={() => setShowBulk(false)} onDone={() => { setShowBulk(false); setSelected(new Set()); }} />}
    </div>
  );
}

function FilterEditor(props: { boot: Boot; lib: LibQ[]; def: FilterDef; onChange: (d: FilterDef) => void }) {
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
