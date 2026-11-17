// "Which questions" — the filter studio. Every rule is one calm row that always shows its live summary; open a row to
// change it. Rows are grouped (History · Topic · Performance · Refine · Level) in the order people use them most, with
// the question difficulty label last. The pinned hero above (PoolHero) shows the live sample space and every active
// rule as a removable pill, with how many questions removing it would bring back.
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { emptyFilter, type FilterDef } from "../filter";
import type { Boot, LibQ } from "../types";
import { FilterEditor } from "../pages/Library";
import {
  Check, ChoiceTiles, FilterGroup, FilterRow, Icon, NumBox, OptionRows, RangeBox, RowTools, Segmented, Switch, type OptionItem,
} from "./controls";
import { describeFilter, FORMAT_LABEL, rangeText, recencyText, RESULT_LABEL, subjectSlot, unitWord } from "./describe";
import { DiffMark } from "./PaperTable";
import { treeState, treeToggle, type Ctx, type PoolEval, type TreeNode } from "./pool";
import { anyRange, defaultPool, hasConditions, NONE, RESULT_BUCKETS, rangeOn, UNIT_DAYS, type PoolSpec, type Range, type ResultBucket, type Unit } from "./spec";

type Set_ = (p: Partial<PoolSpec>) => void;
type Props = { pool: PoolSpec; set: Set_; ev: PoolEval; ctx: Ctx; lib: LibQ[]; boot: Boot };

const DAY = 86_400_000;
const fmt = (n: number) => n.toLocaleString();
const same = (a: Range, b: Range) => a.min === b.min && a.max === b.max;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listText = (xs: string[], max = 2) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} +${xs.length - max}`);

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

const QUICK_AGO: { label: string; long: string; n: number; unit: Unit }[] = [
  { label: "1 wk+", long: "1 week", n: 1, unit: "weeks" }, { label: "3 wk+", long: "3 weeks", n: 3, unit: "weeks" },
  { label: "1 mo+", long: "1 month", n: 1, unit: "months" }, { label: "3 mo+", long: "3 months", n: 3, unit: "months" },
];
const ATTEMPT_PRESETS: { key: string; label: string; r: Range }[] = [
  { key: "any", label: "Any", r: anyRange() }, { key: "0", label: "0", r: { min: 0, max: 0 } },
  { key: "1-2", label: "1–2", r: { min: 1, max: 2 } }, { key: "3+", label: "3+", r: { min: 3, max: null } },
];
const RESULT_TONE: Record<ResultBucket, string> = { never: "st-none", incorrect: "st-crit", partial: "st-warn", correct: "st-good", ungraded: "st-muted" };

// ------------------------------------------------------------------ active rules (pills + summaries)

interface ActiveRule { id: string; facet: string; label: string; clear: Partial<PoolSpec> }

function subjectSummary(pool: PoolSpec, ctx: Ctx): { full: string[]; part: string[]; none: boolean } {
  const sel = pool.tree ? new Set(pool.tree) : null;
  const full: string[] = [], part: string[] = [];
  for (const n of ctx.tree) {
    const st = treeState(sel, n);
    if (st === "on") full.push(n.label);
    else if (st === "some") part.push(n.label);
  }
  return { full, part, none: !!pool.tree && !full.length && !part.length };
}

function presetOf(r: PoolSpec["recency"]) {
  return r.mode === "more_than" ? QUICK_AGO.find((x) => x.n === r.n && x.unit === r.unit) : undefined;
}

export function activeRules(pool: PoolSpec, ctx: Ctx, boot: Boot): ActiveRule[] {
  const out: ActiveRule[] = [];
  if (pool.attempted !== "any") out.push({ id: "attempted", facet: "attempted", label: pool.attempted === "yes" ? "Attempted" : "Never attempted", clear: { attempted: "any" } });
  if (pool.recency.mode !== "any" && pool.recency.mode !== "never") {
    const p = presetOf(pool.recency);
    const label = p ? `Seen ${p.long}+ ago` : `Seen ${recencyText(pool.recency).replace(/, or never$/, "").replace(/^more than /, "over ")}`;
    out.push({ id: "recency", facet: "recency", label, clear: { recency: { ...pool.recency, mode: "any" } } });
  }
  if (pool.tree) {
    const s = subjectSummary(pool, ctx);
    const conceptsOn = pool.tree.filter((k) => !k.startsWith("u:")).length;
    const label = s.none ? "No subject or concept" : s.part.length ? `${listText([...s.full, ...s.part.map((p) => `${p} (part)`)])} · ${conceptsOn} concepts` : listText(s.full);
    out.push({ id: "tree", facet: "tree", label, clear: { tree: null } });
  }
  if (rangeOn(pool.attempts)) out.push({ id: "attempts", facet: "attempts", label: `Attempts ${rangeText(pool.attempts)}`, clear: { attempts: anyRange() } });
  if (pool.results.length) out.push({ id: "results", facet: "results", label: listText(pool.results.map((r) => RESULT_LABEL[r])), clear: { results: [] } });
  if (pool.note !== "any") out.push({ id: "note", facet: "note", label: pool.note === "yes" ? "Has my note" : "No note", clear: { note: "any" } });
  if (pool.text.trim()) out.push({ id: "text", facet: "text", label: `“${pool.text.trim()}”`, clear: { text: "" } });
  if (pool.formats.length) out.push({ id: "formats", facet: "formats", label: listText(pool.formats.map((f) => FORMAT_LABEL[f] ?? f)), clear: { formats: [] } });
  if (rangeOn(pool.marks)) out.push({ id: "marks", facet: "marks", label: `Marks ${rangeText(pool.marks)}`, clear: { marks: anyRange() } });
  if (pool.solution !== "any") out.push({ id: "solution", facet: "solution", label: { has: "Has a solution", verified: "Verified solution", ai: "AI solution", none: "No solution" }[pool.solution], clear: { solution: "any" } });
  if (pool.key !== "any") out.push({ id: "key", facet: "key", label: pool.key === "has" ? "Has answer key" : "No answer key", clear: { key: "any" } });
  if (pool.imports.length) out.push({ id: "imports", facet: "imports", label: pool.imports.length === 1 ? `Import: ${ctx.importLabel.get(pool.imports[0]) ?? "?"}` : `${pool.imports.length} imports`, clear: { imports: [] } });
  if (pool.added.mode !== "any") out.push({ id: "added", facet: "added", label: `Added ${pool.added.mode === "within" ? "within" : "over"} ${pool.added.n} ${unitWord(pool.added.n, pool.added.unit)}${pool.added.mode === "more_than" ? " ago" : ""}`, clear: { added: { ...pool.added, mode: "any" } } });
  if (hasConditions(pool.advanced)) out.push({ id: "advanced", facet: "advanced", label: `${pool.advanced.groups.reduce((a, g) => a + g.conds.length, 0)} advanced conditions`, clear: { advanced: emptyFilter() } });
  if (pool.difficulty) {
    const lbl = (c: string) => (c === NONE ? "No label" : boot.difficulties.find((d) => d.code === c)?.label ?? c);
    out.push({ id: "difficulty", facet: "difficulty", label: pool.difficulty.length ? listText(pool.difficulty.map(lbl)) : "No difficulty", clear: { difficulty: null } });
  }
  if (pool.includeArchived) out.push({ id: "archived", facet: "", label: "Including archived", clear: { includeArchived: false } });
  return out;
}

// ------------------------------------------------------------------ hero: the live sample space, pinned

export function PoolHero(props: { ev: PoolEval; pool: PoolSpec; set: Set_; ctx: Ctx; boot: Boot }) {
  const { ev, pool, set } = props;
  const rules = activeRules(pool, props.ctx, props.boot);
  const share = ev.libraryCount ? ev.pool.length / ev.libraryCount : 0;
  const pct = Math.round(share * 100);
  return (
    <div class={`pb-meter hero${ev.pool.length === 0 ? " zero" : ""}`} aria-live="polite">
      <div class="hero-top">
        <div class="pb-meter-n"><b>{fmt(ev.pool.length)}</b> of {fmt(ev.libraryCount)} questions match</div>
        <span class="hero-pct" title="Share of your library that fits every rule">{ev.pool.length && pct === 0 ? "<1" : pct}%</span>
      </div>
      <div class="pb-meter-bar" aria-hidden="true"><i style={{ width: `${ev.libraryCount ? Math.max(ev.pool.length ? 1.5 : 0, share * 100) : 0}%` }} /></div>
      <div class="hero-pills">
        {rules.length === 0 ? (
          <span class="hero-empty"><Icon name="sparkle" size={13} /> No filters — your whole library is in play</span>
        ) : (
          <>
            <div class="hero-scroll" role="group" aria-label="Active filters">
              {rules.map((r) => {
                const g = r.facet ? ev.gain.get(r.facet) ?? 0 : 0;
                return (
                  <button type="button" class="pill" onClick={() => set(r.clear)}
                    aria-label={`Remove filter: ${r.label}${g ? ` (adds ${g} questions)` : ""}`}
                    title={g ? `Remove — brings back ${fmt(g)} question${g === 1 ? "" : "s"}` : "Remove this filter"}>
                    <span class="pill-l">{r.label}</span>
                    {g > 0 && <span class="pill-g">+{fmt(g)}</span>}
                    <Icon name="x" size={11} class="pill-x" />
                  </button>
                );
              })}
            </div>
            <button type="button" class="hero-clear" onClick={() => set({ ...defaultPool() })} title="Remove every filter">Clear all</button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the panel

export function PoolPanel(props: Props) {
  const { pool, ctx, boot } = props;
  const n = activeRules(pool, ctx, boot).length;
  return (
    <div class="pb-card fs">
      <header class="pb-card-head">
        <span class="pb-step">2</span>
        <div class="pb-card-titles">
          <h2 class="pb-card-title">Which questions</h2>
          <p class="pb-card-sub">{n ? `${n} filter${n === 1 ? "" : "s"} on` : "Every question in your library"}</p>
        </div>
      </header>
      <FilterGroup label="History">
        <AttemptedRow {...props} />
        <AgoRow {...props} />
      </FilterGroup>
      <FilterGroup label="Topic">
        <SubjectRow {...props} />
        <ConceptRow {...props} />
      </FilterGroup>
      <FilterGroup label="Performance">
        <LastAttemptedRow {...props} />
        <AttemptsRow {...props} />
        <ResultRow {...props} />
      </FilterGroup>
      <FilterGroup label="Refine">
        <NotesRow {...props} />
        <MoreRow {...props} />
        <AdvancedRow {...props} />
      </FilterGroup>
      <FilterGroup label="Level">
        <DifficultyRow {...props} />
      </FilterGroup>
    </div>
  );
}

const Muted = (p: { children: string }) => <span class="sum-muted">{p.children}</span>;

// ------------------------------------------------------------------ history

function AttemptedRow({ pool, set, ev }: Props) {
  const yes = ev.counts.attempted.get("yes") ?? 0, no = ev.counts.attempted.get("no") ?? 0;
  return (
    <FilterRow id="attempted" icon="checkCircle" title="Attempted" defaultOpen active={pool.attempted !== "any"} onClear={() => set({ attempted: "any" })}
      summary={pool.attempted === "any" ? <Muted>Any</Muted> : pool.attempted === "yes" ? "Attempted" : "Never attempted"}>
      <ChoiceTiles label="Attempted" value={pool.attempted} onChange={(attempted) => set(attempted === "no" ? { attempted, recency: { ...pool.recency, mode: "any" } } : { attempted })}
        options={[
          { value: "any", label: "Any", count: yes + no },
          { value: "yes", label: "Attempted", count: yes, hint: "Questions you have answered at least once" },
          { value: "no", label: "Never", full: "Never attempted", count: no, hint: "Questions you have not tried yet" },
        ]} />
    </FilterRow>
  );
}

function AgoRow({ pool, set, ev }: Props) {
  const r = pool.recency;
  const now = useMemo(() => Date.now(), [ev]);
  const p = presetOf(r);
  const countFor = (n: number, unit: Unit) => ev.recencyBase.filter((t) => (t === null ? r.includeNever : now - t > n * UNIT_DAYS[unit] * DAY)).length;
  const active = r.mode !== "any" && r.mode !== "never";
  const off = pool.attempted === "no";
  return (
    <FilterRow id="ago" icon="clock" title="How long ago" defaultOpen active={active} onClear={() => set({ recency: { ...r, mode: "any" } })}
      summary={!active ? <Muted>Any time</Muted> : p ? `${p.long}+ ago` : cap(recencyText(r))}>
      <Segmented class="pillbar" label="How long ago it was attempted" value={p ? `${p.n}${p.unit}` : active ? "custom" : "any"}
        onChange={(v) => {
          if (v === "any") return set({ recency: { ...r, mode: "any" } });
          const x = QUICK_AGO.find((q) => `${q.n}${q.unit}` === v);
          if (x) set({ recency: { ...r, mode: "more_than", n: x.n, unit: x.unit }, ...(off ? { attempted: "any" as const } : {}) });
        }}
        options={[
          { value: "any", label: <span class="pb-opt">Any<small>{fmt(ev.recencyBase.length)}</small></span> },
          ...QUICK_AGO.map((x) => ({ value: `${x.n}${x.unit}`, title: `Last attempted more than ${x.long} ago`, label: <span class="pb-opt">{x.label}<small>{fmt(countFor(x.n, x.unit))}</small></span> })),
        ]} />
      {r.mode === "more_than" && (
        <label class="mini-check"><input type="checkbox" class="cb" checked={r.includeNever} onChange={(e) => set({ recency: { ...r, includeNever: (e.target as HTMLInputElement).checked } })} /> Count never-attempted questions as long ago</label>
      )}
      {off ? <p class="row-note">Not used while “Never attempted” is chosen.</p> : active && !p ? <p class="row-note">Custom: {recencyText(r)} — adjust it under Last attempted.</p> : null}
    </FilterRow>
  );
}

// ------------------------------------------------------------------ topic

function SubjectRow({ pool, set, ev, ctx }: Props) {
  const sel = pool.tree ? new Set(pool.tree) : null;
  if (!ctx.tree.length) return null;
  const s = subjectSummary(pool, ctx);
  const items: OptionItem[] = ctx.tree.map((n) => ({
    key: n.key, text: n.label, label: n.label, count: ev.counts.tree.get(n.key) ?? 0, state: treeState(sel, n),
    marker: <i class={`sw seg-s${n.kind === "subject" ? subjectSlot(ctx, n.subjectId) : "x"}`} aria-hidden="true" />,
  }));
  return (
    <FilterRow id="subject" icon="book" title="Subject" defaultOpen active={!!pool.tree} onClear={() => set({ tree: null })}
      summary={!pool.tree ? <Muted>All</Muted> : s.none ? "None" : listText([...s.full, ...s.part.map((x) => `${x} (part)`)])}>
      <RowTools>
        <button type="button" class="link-btn" disabled={!pool.tree} onClick={() => set({ tree: null })}>All</button>
        <button type="button" class="link-btn" disabled={!!pool.tree && !pool.tree.length} onClick={() => set({ tree: [] })}>None</button>
      </RowTools>
      <OptionRows label="Subjects" items={items} onToggle={(k) => set({ tree: treeToggle(ctx, pool.tree, ctx.node.get(k)!) })} />
    </FilterRow>
  );
}

function ConceptRow({ pool, set, ev, ctx }: Props) {
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
  const conceptKeys = ctx.allKeys.filter((k) => !k.startsWith("u:"));
  const picked = pool.tree ? pool.tree.filter((k) => !k.startsWith("u:")) : conceptKeys;
  const pickedNames = picked.length <= 2 ? picked.map((k) => ctx.node.get(k)?.label ?? "?") : [];
  const toggleOpen = (k: string) => { const s = new Set(open); s.has(k) ? s.delete(k) : s.add(k); setOpen(s); };
  const rows: JSX.Element[] = [];
  const walk = (n: TreeNode) => {
    if (matches && !matches.has(n.key)) return;
    const isOpen = matches ? true : open.has(n.key);
    const count = ev.counts.tree.get(n.key) ?? 0;
    rows.push(
      <div class={`tree-row k-${n.kind}${count === 0 ? " zero" : ""}`} style={{ "--depth": n.depth } as any}>
        {n.children.length ? (
          <button type="button" class={`tree-tw${isOpen ? " open" : ""}`} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${n.label}`} onClick={() => toggleOpen(n.key)}>
            <Icon name="right" size={12} />
          </button>
        ) : <span class="tree-tw-sp" />}
        <label class="tree-label">
          <Check state={treeState(sel, n)} label={n.label} onChange={() => set({ tree: treeToggle(ctx, pool.tree, n) })} />
          <span class={`tree-text${n.kind === "untagged" ? " muted" : ""}`}>{n.label}</span>
        </label>
        <span class="tree-n">{fmt(count)}</span>
      </div>,
    );
    if (isOpen) n.children.forEach(walk);
  };
  ctx.tree.forEach(walk);
  return (
    <FilterRow id="concept" icon="tag" title="Concept" active={!!pool.tree && picked.length !== conceptKeys.length} onClear={() => set({ tree: null })}
      summary={!pool.tree || picked.length === conceptKeys.length ? <Muted>All</Muted> : pickedNames.length ? pickedNames.join(", ") : `${picked.length} of ${conceptKeys.length}`}>
      {ctx.tree.length === 0 ? <p class="row-note">No subjects yet. Add them in Settings or with an import.</p> : (
        <>
          <label class="fs-search">
            <Icon name="search" size={14} />
            <input type="search" placeholder="Find a concept" aria-label="Find a subject or concept" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
          <RowTools note={`${fmt(picked.length)} of ${fmt(conceptKeys.length)} ticked`}>
            <button type="button" class="link-btn" onClick={() => set({ tree: null })} disabled={!pool.tree}>All</button>
            <button type="button" class="link-btn" onClick={() => set({ tree: [] })} disabled={!!pool.tree && pool.tree.length === 0}>None</button>
            <button type="button" class="link-btn" onClick={() => setOpen(open.size ? new Set() : new Set([...ctx.node.values()].filter((x) => x.children.length).map((x) => x.key)))}>
              {open.size ? "Collapse" : "Expand"}
            </button>
          </RowTools>
          <div class="tree" role="group" aria-label="Subjects and concepts">
            {rows.length ? rows : <p class="row-note">Nothing called “{q}”.</p>}
          </div>
        </>
      )}
    </FilterRow>
  );
}

// ------------------------------------------------------------------ performance

function LastAttemptedRow({ pool, set }: Props) {
  const r = pool.recency;
  const setR = (p: Partial<PoolSpec["recency"]>) => set({ recency: { ...r, ...p }, ...(p.mode && p.mode !== "any" && pool.attempted === "no" ? { attempted: "any" as const } : {}) });
  const active = r.mode !== "any" && r.mode !== "never";
  return (
    <FilterRow id="last" icon="calendar" title="Last attempted" active={active} onClear={() => setR({ mode: "any" })}
      summary={active ? (presetOf(r) ? `${presetOf(r)!.long}+ ago` : cap(recencyText(r).replace(/^more than /, "over ").replace(/, or never$/, ""))) : <Muted>Any time</Muted>}>
      <Segmented size="sm" block label="Last attempted" value={r.mode === "never" ? "any" : r.mode} onChange={(mode) => setR({ mode })} options={[
        { value: "any", label: "Any time" }, { value: "more_than", label: "More than" },
        { value: "within", label: "Within" }, { value: "between", label: "Between" },
      ]} />
      {(r.mode === "more_than" || r.mode === "within") && (
        <div class="sentence">
          {r.mode === "within" && <span>the last</span>}
          <NumBox value={r.n} label="Amount" min={0} integer class="w4" onChange={(v) => setR({ n: v ?? 0 })} />
          <UnitSelect value={r.unit} label="Unit" onChange={(unit) => setR({ unit })} />
          {r.mode === "more_than" && <span>ago</span>}
        </div>
      )}
      {r.mode === "between" && (
        <div class="sentence">
          <NumBox value={r.n} label="From" min={0} integer class="w4" onChange={(v) => setR({ n: v ?? 0 })} />
          <span>and</span>
          <NumBox value={r.m} label="To" min={0} integer class="w4" onChange={(v) => setR({ m: v ?? 0 })} />
          <UnitSelect value={r.unit} label="Unit" onChange={(unit) => setR({ unit })} />
          <span>ago</span>
        </div>
      )}
      {r.mode === "more_than" && (
        <label class="mini-check"><input type="checkbox" class="cb" checked={r.includeNever} onChange={(e) => setR({ includeNever: (e.target as HTMLInputElement).checked })} /> Also include questions never attempted</label>
      )}
    </FilterRow>
  );
}

function AttemptsRow({ pool, set, ev }: Props) {
  const preset = ATTEMPT_PRESETS.find((x) => same(pool.attempts, x.r));
  const [custom, setCustom] = useState(!preset);
  const countIn = (r: Range) => ev.attemptsBase.filter((n) => (r.min === null || n >= r.min) && (r.max === null || n <= r.max)).length;
  return (
    <FilterRow id="attempts" icon="repeat" title="Number of attempts" active={rangeOn(pool.attempts)} onClear={() => set({ attempts: anyRange() })}
      summary={rangeOn(pool.attempts) ? cap(rangeText(pool.attempts)) : <Muted>Any</Muted>}>
      <Segmented class="pillbar" label="Number of attempts" value={preset?.key ?? "custom"} onChange={(k) => { const x = ATTEMPT_PRESETS.find((p) => p.key === k); if (x) { set({ attempts: x.r }); setCustom(false); } }}
        options={ATTEMPT_PRESETS.map((x) => ({ value: x.key, label: <span class="pb-opt">{x.label}<small>{fmt(countIn(x.r))}</small></span> }))} />
      {custom || !preset ? (
        <div class="sentence"><span>Between</span><RangeBox label="Attempts" value={pool.attempts} min={0} integer onChange={(attempts) => set({ attempts })} /></div>
      ) : (
        <button type="button" class="link-btn" onClick={() => setCustom(true)}>Custom range…</button>
      )}
    </FilterRow>
  );
}

function ResultRow({ pool, set, ev }: Props) {
  const buckets = RESULT_BUCKETS.filter((b) => b !== "ungraded" || (ev.counts.results.get(b) ?? 0) > 0 || pool.results.includes(b));
  const items: OptionItem[] = buckets.map((b) => ({
    key: b, text: RESULT_LABEL[b], label: RESULT_LABEL[b], count: ev.counts.results.get(b) ?? 0,
    state: pool.results.includes(b) ? "on" : "off", marker: <i class={`dot seg-${RESULT_TONE[b]}`} aria-hidden="true" />,
  }));
  return (
    <FilterRow id="result" icon="target" title="Last result" active={pool.results.length > 0} onClear={() => set({ results: [] })}
      summary={pool.results.length ? listText(pool.results.map((r) => RESULT_LABEL[r])) : <Muted>Any</Muted>}>
      <OptionRows label="Last result" items={items}
        onToggle={(k) => set({ results: pool.results.includes(k as ResultBucket) ? pool.results.filter((x) => x !== k) : [...pool.results, k as ResultBucket] })} />
      <p class="row-note">Tick none for any result.</p>
    </FilterRow>
  );
}

// ------------------------------------------------------------------ refine

function NotesRow({ pool, set, ev }: Props) {
  const yes = ev.counts.note.get("yes") ?? 0, no = ev.counts.note.get("no") ?? 0;
  return (
    <FilterRow id="notes" icon="note" title="My notes" active={pool.note !== "any"} onClear={() => set({ note: "any" })}
      summary={pool.note === "any" ? <Muted>Any</Muted> : pool.note === "yes" ? "Has my note" : "No note"}>
      <ChoiceTiles label="My notes" value={pool.note} onChange={(note) => set({ note })} options={[
        { value: "any", label: "Any", count: yes + no },
        { value: "yes", label: "With note", full: "Has my note", count: yes, hint: "Questions with a note written while solving" },
        { value: "no", label: "No note", count: no },
      ]} />
    </FilterRow>
  );
}

function MoreRow({ pool, set, ev, boot }: Props) {
  const on = ["text", "formats", "marks", "solution", "key", "imports", "added"].filter((f) => ev.activeFacets.has(f)).length + (pool.includeArchived ? 1 : 0);
  const formats = ["none", "mcq_single", "mcq_multi", "numeric", "text"].filter((f) => (ev.counts.formats.get(f) ?? 0) > 0 || pool.formats.includes(f));
  const imports = boot.imports ?? [];
  const [allImports, setAllImports] = useState(false);
  const shownImports = allImports ? imports : imports.slice(0, 6);
  const sc = (k: string) => ev.counts.solution.get(k) ?? 0;
  return (
    <FilterRow id="more" icon="sliders" title="More filters" active={on > 0}
      onClear={() => set({ text: "", formats: [], marks: anyRange(), solution: "any", key: "any", imports: [], added: { ...pool.added, mode: "any" }, includeArchived: false })}
      summary={on ? `${on} on` : <Muted>Text, type, marks…</Muted>}>
      <div class="sub">
        <span class="sub-l">Text</span>
        <label class="fs-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Words, Q number or ID" aria-label="Search question text" value={pool.text} onInput={(e) => set({ text: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      {formats.length > 0 && <div class="sub">
        <span class="sub-l">Answer type</span>
        <OptionRows label="Answer type" items={formats.map((f) => ({ key: f, text: FORMAT_LABEL[f], label: FORMAT_LABEL[f], count: ev.counts.formats.get(f) ?? 0, state: pool.formats.includes(f) ? "on" : "off" }))}
          onToggle={(f) => set({ formats: pool.formats.includes(f) ? pool.formats.filter((x) => x !== f) : [...pool.formats, f] })} />
      </div>}
      <div class="sub two">
        <div>
          <span class="sub-l">Marks</span>
          <RangeBox label="Marks" value={pool.marks} min={0} step={0.5} onChange={(marks) => set({ marks })} />
        </div>
        <div>
          <span class="sub-l">Worked solution</span>
          <select class="sel-full" aria-label="Worked solution" value={pool.solution} onChange={(e) => set({ solution: (e.target as HTMLSelectElement).value as PoolSpec["solution"] })}>
            <option value="any">Any</option>
            <option value="has">Has one ({fmt(sc("has"))})</option>
            <option value="verified">Verified ({fmt(sc("verified"))})</option>
            <option value="ai">AI, not verified ({fmt(sc("ai"))})</option>
            <option value="none">None ({fmt(sc("none"))})</option>
          </select>
        </div>
      </div>
      <div class="sub">
        <span class="sub-l">Answer key (auto-marking)</span>
        <Segmented size="sm" block label="Answer key" value={pool.key} onChange={(key) => set({ key })} options={[
          { value: "any", label: "Any" },
          { value: "has", label: `Has key · ${fmt(ev.counts.key.get("has") ?? 0)}` },
          { value: "none", label: `No key · ${fmt(ev.counts.key.get("none") ?? 0)}` },
        ]} />
      </div>
      {imports.length > 0 && (
        <div class="sub">
          <span class="sub-l">Import {imports.length > 6 && <button type="button" class="link-btn" onClick={() => setAllImports(!allImports)}>{allImports ? "Fewer" : `All ${imports.length}`}</button>}</span>
          <OptionRows label="Import" items={shownImports.map((im) => ({ key: im.id, text: im.label || im.file_name, label: im.label || im.file_name, count: ev.counts.imports.get(im.id) ?? 0, state: pool.imports.includes(im.id) ? "on" : "off" }))}
            onToggle={(id) => set({ imports: pool.imports.includes(id) ? pool.imports.filter((x) => x !== id) : [...pool.imports, id] })} />
        </div>
      )}
      <div class="sub">
        <span class="sub-l">Date added</span>
        <Segmented size="sm" block label="Date added" value={pool.added.mode} onChange={(mode) => set({ added: { ...pool.added, mode } })} options={[
          { value: "any", label: "Any time" }, { value: "within", label: "Within" }, { value: "more_than", label: "More than" },
        ]} />
        {pool.added.mode !== "any" && (
          <div class="sentence">
            {pool.added.mode === "within" && <span>the last</span>}
            <NumBox value={pool.added.n} label="Amount" min={0} integer class="w4" onChange={(v) => set({ added: { ...pool.added, n: v ?? 0 } })} />
            <UnitSelect value={pool.added.unit} label="Unit" onChange={(unit) => set({ added: { ...pool.added, unit } })} />
            {pool.added.mode === "more_than" && <span>ago</span>}
          </div>
        )}
      </div>
      <Switch label="Include archived questions" checked={pool.includeArchived} onChange={(includeArchived) => set({ includeArchived })} />
    </FilterRow>
  );
}

function AdvancedRow({ pool, set, ctx, lib, boot }: Props) {
  const has = hasConditions(pool.advanced);
  const [edit, setEdit] = useState(!has);
  const n = pool.advanced.groups.reduce((a, g) => a + g.conds.length, 0);
  const lines = has ? describeFilter(pool.advanced, boot, ctx) : [];
  return (
    <FilterRow id="advanced" icon="braces" title="Advanced conditions" active={has} onClear={() => set({ advanced: emptyFilter() })}
      summary={has ? `${n} condition${n === 1 ? "" : "s"}` : <Muted>None</Muted>}>
      {has && !edit ? (
        <div class="cond-box">
          <ul class="cond-lines">{lines.map((l) => <li>{l}</li>)}</ul>
          <RowTools>
            <button type="button" class="link-btn" onClick={() => setEdit(true)}>Edit</button>
            <button type="button" class="link-btn" onClick={() => set({ advanced: emptyFilter() })}>Remove</button>
          </RowTools>
        </div>
      ) : (
        <>
          <p class="row-note">Any rule from the Library filter, combined with AND / OR — custom fields, tag weights, source files and more.</p>
          <FilterEditor boot={boot} lib={lib} def={pool.advanced} onChange={(advanced) => set(withAdvanced(pool, advanced))} />
          {has && <button type="button" class="link-btn" onClick={() => setEdit(false)}>Done</button>}
        </>
      )}
    </FilterRow>
  );
}

// ------------------------------------------------------------------ level

function DifficultyRow({ pool, set, ev, ctx, boot }: Props) {
  const codes = [...boot.difficulties].filter((d) => !d.archived_at || (ev.counts.difficulty.get(d.code) ?? 0) > 0).sort((a, b) => a.sort_rank - b.sort_rank).map((d) => ({ code: d.code, label: d.label }));
  if ((ev.counts.difficulty.get(NONE) ?? 0) > 0 || pool.difficulty?.includes(NONE)) codes.push({ code: NONE, label: "No label" });
  const all = codes.map((c) => c.code);
  const sel = new Set(pool.difficulty ?? all);
  const toggle = (code: string) => {
    const s = new Set(sel);
    s.has(code) ? s.delete(code) : s.add(code);
    set({ difficulty: all.every((c) => s.has(c)) ? null : all.filter((c) => s.has(c)) });
  };
  const labelOf = (c: string) => codes.find((x) => x.code === c)?.label ?? c;
  return (
    <FilterRow id="difficulty" icon="bars" title="Difficulty level" active={!!pool.difficulty} onClear={() => set({ difficulty: null })}
      summary={pool.difficulty ? (pool.difficulty.length ? listText(pool.difficulty.map(labelOf)) : "None") : <Muted>All</Muted>}>
      <OptionRows label="Difficulty level" onToggle={toggle} items={codes.map((c) => ({
        key: c.code, text: c.label, label: c.label, count: ev.counts.difficulty.get(c.code) ?? 0, state: sel.has(c.code) ? "on" : "off",
        marker: <span class="dm-only"><DiffMark ctx={ctx} code={c.code === NONE ? null : c.code} label="" /></span>,
      }))} />
    </FilterRow>
  );
}

/** New conditions; the editor's own "Include archived" box also drives the builder's switch. */
function withAdvanced(pool: PoolSpec, advanced: FilterDef): Partial<PoolSpec> {
  return !!advanced.includeArchived !== !!pool.advanced.includeArchived ? { advanced, includeArchived: !!advanced.includeArchived } : { advanced };
}

export const poolIsDefault = (p: PoolSpec) =>
  !p.text && !p.tree && !p.difficulty && p.attempted === "any" && p.note === "any" && p.recency.mode === "any" && !rangeOn(p.attempts) && !p.results.length && !rangeOn(p.avgMinutes) &&
  !rangeOn(p.personal) && !p.formats.length && !rangeOn(p.marks) && p.solution === "any" && p.key === "any" && !p.imports.length &&
  p.added.mode === "any" && !p.includeArchived && !hasConditions(p.advanced);
