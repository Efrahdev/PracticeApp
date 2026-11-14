// "Which questions": every rule that narrows the pool, each with live counts.
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { emptyFilter, type FilterDef } from "../filter";
import type { Boot, LibQ } from "../types";
import { FilterEditor } from "../pages/Library";
import { Badge, Check, ChipToggle, Field, Icon, NumBox, RangeBox, Section, Segmented, Switch } from "./controls";
import { describeFilter, FORMAT_LABEL, RESULT_LABEL } from "./describe";
import { DiffMark } from "./PaperTable";
import { treeState, treeToggle, type Ctx, type PoolEval, type TreeNode } from "./pool";
import { anyRange, defaultPool, hasConditions, NONE, RESULT_BUCKETS, rangeOn, type PoolSpec, type Range, type ResultBucket, type Unit } from "./spec";

type Set_ = (p: Partial<PoolSpec>) => void;

const UNIT_OPTS: { value: Unit; label: string }[] = [
  { value: "days", label: "days" }, { value: "weeks", label: "weeks" }, { value: "months", label: "months" },
];

function UnitSelect(props: { value: Unit; onChange: (u: Unit) => void; label: string }) {
  return (
    <select class="sel-sm" aria-label={props.label} value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value as Unit)}>
      {UNIT_OPTS.map((o) => <option value={o.value}>{o.label}</option>)}
    </select>
  );
}

const fmt = (n: number) => n.toLocaleString();
const same = (a: Range, b: Range) => a.min === b.min && a.max === b.max;

export function PoolPanel(props: { pool: PoolSpec; set: Set_; ev: PoolEval; ctx: Ctx; lib: LibQ[]; boot: Boot }) {
  const { pool, set, ev } = props;
  return (
    <div class="pb-group">
      <div class="pb-group-head">
        <div>
          <span class="pb-step">2</span>
          <h2 class="pb-group-title">Which questions</h2>
        </div>
        {!poolIsDefault(pool) && (
          <button type="button" class="btn ghost small" onClick={() => set({ ...defaultPool() })} title="Remove every rule below">
            <Icon name="reset" size={13} /> Clear all
          </button>
        )}
      </div>
      <div class="pb-meter" aria-live="polite">
        <div class="pb-meter-n"><b>{fmt(ev.pool.length)}</b> of {fmt(ev.libraryCount)} questions match</div>
        <div class="pb-meter-bar" aria-hidden="true"><i style={{ width: `${ev.libraryCount ? Math.max(ev.pool.length ? 1.5 : 0, (ev.pool.length / ev.libraryCount) * 100) : 0}%` }} /></div>
      </div>

      {hasConditions(pool.advanced) && <LibraryFilter {...props} />}
      <HistorySection {...props} />
      <TreeSection {...props} />
      <DifficultySection {...props} />
      <MoreSection {...props} />
      {!hasConditions(pool.advanced) && <AdvancedSection {...props} />}
    </div>
  );
}

// ------------------------------------------------------------------ history

function HistorySection(props: { pool: PoolSpec; set: Set_; ev: PoolEval }) {
  const { pool, set, ev } = props;
  const r = pool.recency;
  const setR = (p: Partial<PoolSpec["recency"]>) => set({ recency: { ...r, ...p } });
  const active = ["recency", "attempts", "results", "time", "personal"].filter((f) => ev.activeFacets.has(f)).length;
  const quick: { label: string; n: number; unit: Unit }[] = [
    { label: "1 week+", n: 1, unit: "weeks" }, { label: "3 weeks+", n: 3, unit: "weeks" },
    { label: "1 month+", n: 1, unit: "months" }, { label: "3 months+", n: 3, unit: "months" },
  ];
  const attemptPresets: { label: string; r: Range }[] = [
    { label: "Any", r: anyRange() }, { label: "0", r: { min: 0, max: 0 } }, { label: "1–2", r: { min: 1, max: 2 } }, { label: "3+", r: { min: 3, max: null } },
  ];
  const results = RESULT_BUCKETS.filter((b) => b !== "ungraded" || (ev.counts.results.get(b) ?? 0) > 0 || pool.results.includes(b));
  return (
    <Section title="Your history" badge={active ? <Badge tone="accent">{active} on</Badge> : undefined}>
      <Field label="Last attempted">
        <Segmented size="sm" block label="Last attempted" value={r.mode} onChange={(mode) => setR({ mode })} options={[
          { value: "any", label: "Any time" }, { value: "never", label: "Never" }, { value: "more_than", label: "More than" },
          { value: "within", label: "Within" }, { value: "between", label: "Between" },
        ]} />
        {(r.mode === "more_than" || r.mode === "within") && (
          <div class="pb-inline">
            {r.mode === "within" && <span>the last</span>}
            <NumBox value={r.n} label="Amount" min={0} integer class="w4" onChange={(v) => setR({ n: v ?? 0 })} />
            <UnitSelect value={r.unit} label="Unit" onChange={(unit) => setR({ unit })} />
            {r.mode === "more_than" && <span>ago</span>}
          </div>
        )}
        {r.mode === "between" && (
          <div class="pb-inline">
            <NumBox value={r.n} label="From" min={0} integer class="w4" onChange={(v) => setR({ n: v ?? 0 })} />
            <span>and</span>
            <NumBox value={r.m} label="To" min={0} integer class="w4" onChange={(v) => setR({ m: v ?? 0 })} />
            <UnitSelect value={r.unit} label="Unit" onChange={(unit) => setR({ unit })} />
            <span>ago</span>
          </div>
        )}
        {r.mode === "more_than" && (
          <label class="pb-check"><input type="checkbox" class="cb" checked={r.includeNever} onChange={(e) => setR({ includeNever: (e.target as HTMLInputElement).checked })} /> Also include questions never attempted</label>
        )}
        <div class="pb-chips" aria-label="Quick choices">
          {quick.map((x) => (
            <ChipToggle on={r.mode === "more_than" && r.n === x.n && r.unit === x.unit} onClick={() => setR({ mode: "more_than", n: x.n, unit: x.unit })}
              title={`Last attempted more than ${x.label.replace("+", "")} ago`}>{x.label}</ChipToggle>
          ))}
        </div>
      </Field>

      <Field label="Number of attempts">
        <div class="pb-chips">
          {attemptPresets.map((x) => <ChipToggle on={same(pool.attempts, x.r)} onClick={() => set({ attempts: x.r })}>{x.label}</ChipToggle>)}
        </div>
        <RangeBox label="Attempts" value={pool.attempts} min={0} integer onChange={(attempts) => set({ attempts })} />
      </Field>

      <Field label="Last result" hint={pool.results.length ? undefined : "None ticked = any result."}>
        <div class="pb-chips">
          {results.map((b) => (
            <ChipToggle on={pool.results.includes(b)} count={ev.counts.results.get(b) ?? 0}
              onClick={() => set({ results: pool.results.includes(b) ? pool.results.filter((x) => x !== b) : [...pool.results, b as ResultBucket] })}>
              {RESULT_LABEL[b]}
            </ChipToggle>
          ))}
        </div>
      </Field>

      <Field label="Average time taken" hint="Only questions you have attempted have a time.">
        <RangeBox label="Average time" unit="min" value={pool.avgMinutes} min={0} step={0.5} onChange={(avgMinutes) => set({ avgMinutes })} />
      </Field>

      <Field label="How hard it has been for you" hint="Personal difficulty, from your grades (0% = always right).">
        <RangeBox label="Personal difficulty" unit="%" value={pool.personal} min={0} max={100} integer onChange={(personal) => set({ personal })} />
      </Field>
    </Section>
  );
}

// ------------------------------------------------------------------ subjects & concepts tree

function TreeSection(props: { pool: PoolSpec; set: Set_; ev: PoolEval; ctx: Ctx }) {
  const { pool, set, ev, ctx } = props;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(ctx.tree.length <= 4 ? ctx.tree.map((n) => n.key) : []));
  const sel = pool.tree ? new Set(pool.tree) : null;
  const term = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term) return null;
    const keep = new Set<string>();
    const walk = (n: TreeNode, up: string[]): void => {
      if (n.label.toLowerCase().includes(term)) [...up, n.key].forEach((k) => keep.add(k));
      n.children.forEach((c) => walk(c, [...up, n.key]));
    };
    ctx.tree.forEach((n) => walk(n, []));
    return keep;
  }, [term, ctx]);
  const conceptCount = ctx.allKeys.filter((k) => !k.startsWith("u:")).length;
  const pickedConcepts = pool.tree ? pool.tree.filter((k) => !k.startsWith("u:")).length : conceptCount;
  const toggleOpen = (k: string) => {
    const s = new Set(open);
    s.has(k) ? s.delete(k) : s.add(k);
    setOpen(s);
  };

  const rows: JSX.Element[] = [];
  const walk = (n: TreeNode) => {
    if (matches && !matches.has(n.key)) return;
    const isOpen = matches ? true : open.has(n.key);
    const st = treeState(sel, n);
    const count = ev.counts.tree.get(n.key) ?? 0;
    rows.push(
      <div class={`tree-row k-${n.kind}${count === 0 ? " empty" : ""}`} style={{ paddingLeft: `${n.depth * 16 + 4}px` }}>
        {n.children.length ? (
          <button type="button" class={`tree-tw${isOpen ? " open" : ""}`} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${n.label}`} onClick={() => toggleOpen(n.key)}>
            <Icon name="right" size={13} />
          </button>
        ) : <span class="tree-tw-sp" />}
        <label class="tree-label">
          <Check state={st} label={n.label} onChange={() => set({ tree: treeToggle(ctx, pool.tree, n) })} />
          <span class={`tree-text${n.kind === "untagged" ? " muted" : ""}`}>{n.label}</span>
        </label>
        <span class="tree-n">{fmt(count)}</span>
      </div>,
    );
    if (isOpen) n.children.forEach(walk);
  };
  ctx.tree.forEach(walk);

  return (
    <Section title="Subjects & concepts" badge={pool.tree ? <Badge tone="accent">{pickedConcepts} of {conceptCount}</Badge> : <Badge>All</Badge>}>
      {ctx.tree.length === 0 ? <p class="pb-hint">No subjects yet. Add them in Settings or with an import.</p> : (
        <>
          <div class="tree-tools">
            <label class="search-sm">
              <Icon name="search" size={14} />
              <input type="search" placeholder="Find a subject or concept" aria-label="Find a subject or concept" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
            <button type="button" class="btn ghost small" onClick={() => set({ tree: null })} disabled={!pool.tree}>All</button>
            <button type="button" class="btn ghost small" onClick={() => set({ tree: [] })} disabled={!!pool.tree && pool.tree.length === 0}>None</button>
            <button type="button" class="btn ghost small" onClick={() => setOpen(open.size ? new Set() : new Set([...ctx.node.values()].filter((n) => n.children.length).map((n) => n.key)))}>
              {open.size ? "Collapse" : "Expand"}
            </button>
          </div>
          <div class="tree" role="group" aria-label="Subjects and concepts">
            {rows.length ? rows : <p class="pb-hint">Nothing called “{q}”.</p>}
          </div>
          <p class="pb-hint small">Numbers show how many questions you would get from each, with your other rules. A question with several concepts counts if any of them is ticked.</p>
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ difficulty

function DifficultySection(props: { pool: PoolSpec; set: Set_; ev: PoolEval; ctx: Ctx; boot: Boot }) {
  const { pool, set, ev, ctx, boot } = props;
  const codes = [...boot.difficulties].filter((d) => !d.archived_at || (ev.counts.difficulty.get(d.code) ?? 0) > 0).sort((a, b) => a.sort_rank - b.sort_rank).map((d) => ({ code: d.code, label: d.label }));
  if ((ev.counts.difficulty.get(NONE) ?? 0) > 0 || pool.difficulty?.includes(NONE)) codes.push({ code: NONE, label: "No label" });
  const all = codes.map((c) => c.code);
  const sel = new Set(pool.difficulty ?? all);
  const toggle = (code: string) => {
    const s = new Set(sel);
    s.has(code) ? s.delete(code) : s.add(code);
    set({ difficulty: all.every((c) => s.has(c)) ? null : all.filter((c) => s.has(c)) });
  };
  return (
    <Section title="Difficulty" badge={pool.difficulty ? <Badge tone="accent">{pool.difficulty.length} of {all.length}</Badge> : <Badge>All</Badge>}>
      <div class="check-list">
        {codes.map((c) => (
          <label class={`check-row${(ev.counts.difficulty.get(c.code) ?? 0) === 0 ? " empty" : ""}`}>
            <input type="checkbox" class="cb" checked={sel.has(c.code)} onChange={() => toggle(c.code)} />
            <DiffMark ctx={ctx} code={c.code === NONE ? null : c.code} label={c.label} />
            <span class="tree-n">{fmt(ev.counts.difficulty.get(c.code) ?? 0)}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ more filters

function MoreSection(props: { pool: PoolSpec; set: Set_; ev: PoolEval; ctx: Ctx; boot: Boot }) {
  const { pool, set, ev, boot } = props;
  const active = ["text", "formats", "marks", "solution", "key", "imports", "added"].filter((f) => ev.activeFacets.has(f)).length + (pool.includeArchived ? 1 : 0);
  const formats = ["none", "mcq_single", "mcq_multi", "numeric", "text"].filter((f) => (ev.counts.formats.get(f) ?? 0) > 0 || pool.formats.includes(f));
  const imports = boot.imports ?? [];
  const [allImports, setAllImports] = useState(false);
  const shownImports = allImports ? imports : imports.slice(0, 8);
  const sc = (k: string) => ev.counts.solution.get(k) ?? 0;
  return (
    <Section title="More filters" defaultOpen={active > 0} badge={active ? <Badge tone="accent">{active} on</Badge> : undefined}>
      <Field label="Text">
        <label class="search-sm wide">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Words, Q number or ID" aria-label="Search question text" value={pool.text} onInput={(e) => set({ text: (e.target as HTMLInputElement).value })} />
        </label>
      </Field>
      <Field label="Answer type">
        <div class="pb-chips">
          {formats.map((f) => (
            <ChipToggle on={pool.formats.includes(f)} count={ev.counts.formats.get(f) ?? 0}
              onClick={() => set({ formats: pool.formats.includes(f) ? pool.formats.filter((x) => x !== f) : [...pool.formats, f] })}>{FORMAT_LABEL[f]}</ChipToggle>
          ))}
        </div>
      </Field>
      <Field label="Marks">
        <RangeBox label="Marks" value={pool.marks} min={0} step={0.5} onChange={(marks) => set({ marks })} />
      </Field>
      <Field label="Worked solution">
        <select class="sel-full" aria-label="Worked solution" value={pool.solution} onChange={(e) => set({ solution: (e.target as HTMLSelectElement).value as PoolSpec["solution"] })}>
          <option value="any">Any</option>
          <option value="has">Has a solution ({fmt(sc("has"))})</option>
          <option value="verified">Verified solution ({fmt(sc("verified"))})</option>
          <option value="ai">AI-written, not verified ({fmt(sc("ai"))})</option>
          <option value="none">No solution ({fmt(sc("none"))})</option>
        </select>
      </Field>
      <Field label="Answer key (for auto-marking)">
        <Segmented size="sm" label="Answer key" value={pool.key} onChange={(key) => set({ key })} options={[
          { value: "any", label: "Any" },
          { value: "has", label: `Has key · ${fmt(ev.counts.key.get("has") ?? 0)}` },
          { value: "none", label: `No key · ${fmt(ev.counts.key.get("none") ?? 0)}` },
        ]} />
      </Field>
      {imports.length > 0 && (
        <Field label="Import" action={imports.length > 8 ? <button type="button" class="link-btn" onClick={() => setAllImports(!allImports)}>{allImports ? "Fewer" : `All ${imports.length}`}</button> : undefined}>
          <div class="pb-chips">
            {shownImports.map((im) => (
              <ChipToggle on={pool.imports.includes(im.id)} count={ev.counts.imports.get(im.id) ?? 0}
                title={`${im.file_name} · ${new Date(im.committed_at).toLocaleString()}`}
                onClick={() => set({ imports: pool.imports.includes(im.id) ? pool.imports.filter((x) => x !== im.id) : [...pool.imports, im.id] })}>
                {im.label || im.file_name}
              </ChipToggle>
            ))}
          </div>
        </Field>
      )}
      <Field label="Date added">
        <Segmented size="sm" label="Date added" value={pool.added.mode} onChange={(mode) => set({ added: { ...pool.added, mode } })} options={[
          { value: "any", label: "Any time" }, { value: "within", label: "Within" }, { value: "more_than", label: "More than" },
        ]} />
        {pool.added.mode !== "any" && (
          <div class="pb-inline">
            {pool.added.mode === "within" && <span>the last</span>}
            <NumBox value={pool.added.n} label="Amount" min={0} integer class="w4" onChange={(v) => set({ added: { ...pool.added, n: v ?? 0 } })} />
            <UnitSelect value={pool.added.unit} label="Unit" onChange={(unit) => set({ added: { ...pool.added, unit } })} />
            {pool.added.mode === "more_than" && <span>ago</span>}
          </div>
        )}
      </Field>
      <Switch label="Include archived questions" checked={pool.includeArchived} onChange={(includeArchived) => set({ includeArchived })} />
    </Section>
  );
}

// ------------------------------------------------------------------ advanced (Library-style AND / OR conditions)

function LibraryFilter(props: { pool: PoolSpec; set: Set_; ctx: Ctx; lib: LibQ[]; boot: Boot }) {
  const { pool, set, boot, ctx } = props;
  const [edit, setEdit] = useState(false);
  const lines = describeFilter(pool.advanced, boot, ctx);
  return (
    <div class="lib-filter">
      <div class="lib-filter-head">
        <Icon name="filter" size={14} />
        <span class="lib-filter-title">Conditions from the Library</span>
        <span class="grow" />
        <button type="button" class="link-btn" onClick={() => setEdit(!edit)}>{edit ? "Done" : "Edit"}</button>
        <button type="button" class="link-btn" onClick={() => set({ advanced: emptyFilter() })}>Remove</button>
      </div>
      {!edit && <ul class="lib-filter-lines">{lines.map((l) => <li>{l}</li>)}</ul>}
      {edit && <FilterEditor boot={boot} lib={props.lib} def={pool.advanced} onChange={(advanced) => set(withAdvanced(pool, advanced))} />}
    </div>
  );
}

function AdvancedSection(props: { pool: PoolSpec; set: Set_; lib: LibQ[]; boot: Boot }) {
  return (
    <Section title="Advanced conditions" defaultOpen={false} hint="Any rule from the Library filter, combined with AND / OR — custom fields, tag weights, source files and more.">
      <FilterEditor boot={props.boot} lib={props.lib} def={props.pool.advanced} onChange={(advanced) => props.set(withAdvanced(props.pool, advanced))} />
    </Section>
  );
}

/** New conditions; the editor's own "Include archived" box also drives the builder's switch. */
function withAdvanced(pool: PoolSpec, advanced: FilterDef): Partial<PoolSpec> {
  return !!advanced.includeArchived !== !!pool.advanced.includeArchived ? { advanced, includeArchived: !!advanced.includeArchived } : { advanced };
}

export const poolIsDefault = (p: PoolSpec) =>
  !p.text && !p.tree && !p.difficulty && p.recency.mode === "any" && !rangeOn(p.attempts) && !p.results.length && !rangeOn(p.avgMinutes) &&
  !rangeOn(p.personal) && !p.formats.length && !rangeOn(p.marks) && p.solution === "any" && p.key === "any" && !p.imports.length &&
  p.added.mode === "any" && !p.includeArchived && !hasConditions(p.advanced);
