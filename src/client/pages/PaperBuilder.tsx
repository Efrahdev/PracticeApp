// Paper builder (FR-3), full page at #/papers/new. Left: the blueprint — paper
// settings, which questions (pool), how to pick (mix, priorities, order, seed).
// Right: live summary and the detailed question table, editable row by row.
// Everything runs on the device; saving stores the blueprint with the paper.
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { parseDef } from "../filter";
import { randomSeed } from "../sampler";
import { takePendingBuild, useData, type BuildInit } from "../store";
import type { Boot, LibQ } from "../types";
import { ErrorBox, toast, Loading } from "../ui";
import { useConceptAccuracy } from "./Analytics";
import { Badge, Field, Icon, NumBox, Section, Segmented, Stepper, Switch, usePopover } from "../builder/controls";
import { DIM_LABEL, difficultyTone, ORDER_LABEL, RESULT_LABEL, subjectSlot, valueLabel } from "../builder/describe";
import { activeDims, planPaper, type PlanPick } from "../builder/engine";
import { MixPanel } from "../builder/MixPanel";
import { PaperTable, type TableRow } from "../builder/PaperTable";
import { breakdown, evaluatePool, makeCtx, type Ctx } from "../builder/pool";
import { PoolPanel } from "../builder/PoolPanel";
import {
  defaultBlueprint, GENERATOR_V2, NONE, normaliseBlueprint, OTHER, RESULT_BUCKETS, resultBucket,
  type Blueprint, type DimKey, type Order, type PoolSpec, type ShareDim,
} from "../builder/spec";

const STORE_KEY = "builder.v2";

interface BuilderState {
  name: string;
  solutions: "included" | "hidden";
  seed: number;
  bp: Blueprint;
  savedFilterId: string | null;
}

const defaultName = () => `Paper ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;

function fresh(init: BuildInit = {}): BuilderState {
  const bp = defaultBlueprint(10);
  if (init.def) {
    const def = parseDef(JSON.stringify(init.def));
    bp.pool.advanced = def;
    bp.pool.includeArchived = !!def.includeArchived;
  }
  if (init.tree) bp.pool.tree = [...init.tree];
  if (init.pool) bp.pool = normaliseBlueprint({ pool: { ...bp.pool, ...init.pool } }).pool;
  if (init.favourWeak) bp.favourWeak = true;
  return { name: init.name ?? defaultName(), solutions: "included", seed: randomSeed(), bp, savedFilterId: init.savedFilterId ?? null };
}

function initial(): BuilderState {
  const pending = takePendingBuild();
  if (pending) return fresh(pending);
  try {
    const s = sessionStorage.getItem(STORE_KEY);
    if (s) {
      const r = JSON.parse(s);
      return {
        name: typeof r.name === "string" ? r.name : defaultName(),
        solutions: r.solutions === "hidden" ? "hidden" : "included",
        seed: Number.isFinite(r.seed) ? Math.trunc(r.seed) : randomSeed(),
        bp: normaliseBlueprint(r.bp),
        savedFilterId: typeof r.savedFilterId === "string" ? r.savedFilterId : null,
      };
    }
  } catch { /* storage unavailable or unreadable: start fresh */ }
  return fresh();
}

export function PaperBuilder() {
  const { boot, lib, error } = useData();
  const [st, setSt] = useState<BuilderState>(initial);
  useEffect(() => {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch { /* storage unavailable */ }
  }, [st]);
  if (error) return <ErrorBox error={error} />;
  if (!boot || !lib) return <Loading />;
  if (lib.length === 0) {
    return (
      <div class="page">
        <div class="empty"><p>No questions yet — import some first.</p><a class="btn primary" href="#/import">Import questions</a></div>
      </div>
    );
  }
  return <Builder boot={boot} lib={lib} st={st} setSt={setSt} />;
}

function reasonOf(p: PlanPick, ctx: Ctx) {
  const fills = p.fills.filter(([, v]) => v !== OTHER).map(([d, v]) => `${DIM_LABEL[d]}: ${valueLabel(d, v, ctx)}`);
  return {
    target: p.pinned ? "pinned by you" : fills.length ? fills.join(" · ") : p.fills.length ? "rest of the mix" : "any",
    weight: Math.round(p.weight * 100) / 100,
    factors: p.factors,
    score: Math.round(p.key * 1000) / 1000,
    pinned: p.pinned,
    fills: p.fills,
    over: p.over,
  };
}

function Builder(props: { boot: Boot; lib: LibQ[]; st: BuilderState; setSt: (f: (s: BuilderState) => BuilderState) => void }) {
  const { boot, lib, st, setSt } = props;
  const { bp } = st;
  const accuracy = useConceptAccuracy();
  const now = useMemo(() => Date.now(), [lib]);
  const ctx = useMemo(() => makeCtx(boot, lib), [boot, lib]);
  const ev = useMemo(() => evaluatePool(lib, ctx, bp.pool, now), [lib, ctx, bp.pool, now]);
  const plan = useMemo(() => planPaper({ lib, pool: ev.pool, bp, seed: st.seed, ctx, accuracy, now }), [lib, ev.pool, bp, st.seed, ctx, accuracy, now]);
  const poolBreak = useMemo(() => breakdown(ev.pool, ctx), [ev.pool, ctx]);
  const [view, setView] = useState<"rules" | "preview">("rules");
  const [rulesHidden, setRulesHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (p: Partial<BuilderState>) => setSt((s) => ({ ...s, ...p }));
  const setBp = (f: (b: Blueprint) => Blueprint) => setSt((s) => ({ ...s, bp: f(s.bp) }));
  const setPool = (p: Partial<PoolSpec>) =>
    setSt((s) => ({ ...s, bp: { ...s.bp, pool: { ...s.bp.pool, ...p } }, savedFilterId: "advanced" in p ? null : s.savedFilterId }));
  const setShare = (d: DimKey, sh: ShareDim) => setBp((b) => ({ ...b, shares: { ...b.shares, [d]: sh } }));

  // Rows that just arrived flash briefly, so you can see what a change did.
  const prev = useRef<Set<string> | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  useEffect(() => {
    const cur = new Set(plan.picks.map((p) => p.q.id));
    const before = prev.current;
    prev.current = cur;
    if (!before) return;
    const added = [...cur].filter((id) => !before.has(id));
    if (!added.length || added.length > 6) return;
    setFlash(new Set(added));
    const t = setTimeout(() => setFlash(new Set()), 1800);
    return () => clearTimeout(t);
  }, [plan]);

  const currentIds = () => plan.picks.map((p) => p.q.id);
  const freezeOrder = (b: Blueprint): Partial<Blueprint> => (b.order === "picked" || b.order === "manual" ? { order: "manual", manual: b.order === "manual" ? b.manual : currentIds() } : {});
  const actions = {
    onPin: (id: string) => setBp((b) => (b.pinned.includes(id) ? { ...b, pinned: b.pinned.filter((x) => x !== id) } : { ...b, pinned: [...b.pinned, id], excluded: b.excluded.filter((x) => x !== id) })),
    onReplace: (id: string) => setBp((b) => ({ ...b, ...freezeOrder(b), pinned: b.pinned.filter((x) => x !== id), excluded: [...b.excluded.filter((x) => x !== id), id] })),
    onRemove: (id: string) => setBp((b) => ({
      ...b, ...freezeOrder(b), pinned: b.pinned.filter((x) => x !== id), excluded: [...b.excluded.filter((x) => x !== id), id], count: Math.max(1, Math.min(b.count, plan.want) - 1),
    })),
    onMove: (i: number, delta: number) => {
      const ids = currentIds();
      const j = i + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      setBp((b) => ({ ...b, order: "manual", manual: ids }));
    },
    onOrder: (ids: string[]) => setBp((b) => ({ ...b, order: "manual", manual: ids })),
  };
  const addQuestion = (id: string) => setBp((b) => ({ ...b, pinned: [...b.pinned.filter((x) => x !== id), id], excluded: b.excluded.filter((x) => x !== id), count: Math.max(b.count, plan.want) + 1 }));
  const putBack = (ids: string[]) => setBp((b) => ({ ...b, excluded: b.excluded.filter((x) => !ids.includes(x)) }));

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", "/api/papers", {
        name: st.name.trim() || defaultName(),
        saved_filter_id: st.savedFilterId,
        filter_definition: bp.pool.advanced,
        sampling_settings: { ...bp, count: plan.want },
        seed: st.seed,
        generator_version: GENERATOR_V2,
        requested_count: plan.want,
        solutions_mode: st.solutions,
        items: plan.picks.map((p) => ({ question_id: p.q.id, question_version_id: p.q.version_id, pick_reason: reasonOf(p, ctx) })),
      });
      try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
      toast("Paper saved");
      location.hash = `#/papers/${r.id}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const startOver = () => {
    if (!confirm("Start again with a blank paper? Your current rules will be cleared.")) return;
    setSt(() => fresh());
  };

  const picks = plan.picks.map((p) => p.q);
  const canSave = !busy && plan.picks.length > 0 && plan.shortfall === 0;
  const marks = picks.reduce((a, q) => a + (q.marks ?? 0), 0);
  const rows: TableRow[] = plan.picks.map((p) => ({
    q: p.q, qno: p.q.qno, text: p.q.plain_text, versionNo: p.q.version_no,
    why: { pinned: p.pinned, fills: p.fills, factors: p.factors, over: p.over },
    flash: flash.has(p.q.id),
  }));
  const byId = useMemo(() => new Map(lib.map((q) => [q.id, q])), [lib]);
  const removed = bp.excluded.map((id) => byId.get(id)).filter((q): q is LibQ => !!q);

  return (
    <div class={`pb${rulesHidden ? " rules-hidden" : ""}`} data-view={view}>
      <header class="pb-top">
        <div class="pb-top-main">
          <a class="pb-back" href="#/papers"><Icon name="right" size={13} class="flip" /> Papers</a>
          <h1 class="pb-h1">Build a paper</h1>
          <label class="pb-name">
            <span class="sr">Paper name</span>
            <input type="text" value={st.name} maxLength={120} placeholder="Paper name" onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
        <div class="pb-top-actions">
          <button type="button" class="btn ghost" onClick={startOver} title="Clear every rule and start again"><Icon name="reset" size={15} /> Start over</button>
          <button type="button" class="btn" onClick={() => set({ seed: randomSeed() })} title="Same rules, a different selection (new seed)"><Icon name="shuffle" size={15} /> Shuffle</button>
          <button type="button" class="btn primary top-save" disabled={!canSave} onClick={save}>
            <Icon name="save" size={15} /> {busy ? "Saving…" : `Save paper (${plan.picks.length})`}
          </button>
        </div>
      </header>

      <div class="pb-switch">
        <Segmented label="Show" block value={view} onChange={setView} options={[
          { value: "rules", label: "Rules" }, { value: "preview", label: `Preview · ${plan.picks.length}` },
        ]} />
      </div>

      <ErrorBox error={err} />

      <div class="pb-body">
        <aside class="pb-side" aria-label="Paper rules">
          <div class="pb-group">
            <div class="pb-group-head"><div><span class="pb-step">1</span><h2 class="pb-group-title">Paper</h2></div></div>
            <Field label="Number of questions" action={<span class="pb-field-note">{ev.pool.length.toLocaleString()} available</span>}>
              <div class="pb-inline">
                <Stepper label="Number of questions" value={Math.max(bp.count, bp.pinned.length)} min={Math.max(1, bp.pinned.length)} onChange={(count) => setBp((b) => ({ ...b, count }))} />
                <div class="pb-chips">
                  {[10, 20, 30, 50].map((n) => (
                    <button type="button" class={`pb-chip${bp.count === n ? " on" : ""}`} aria-pressed={bp.count === n} onClick={() => setBp((b) => ({ ...b, count: Math.max(n, b.pinned.length) }))}>{n}</button>
                  ))}
                  <button type="button" class={`pb-chip${bp.count === plan.candidates && plan.candidates > 0 ? " on" : ""}`} disabled={!plan.candidates}
                    onClick={() => setBp((b) => ({ ...b, count: Math.max(1, plan.candidates) }))} title="Every question that matches your rules">All</button>
                </div>
              </div>
            </Field>
            <Field label="Solutions">
              <Segmented label="Solutions" block value={st.solutions} onChange={(solutions) => set({ solutions })} options={[
                { value: "included", label: "Include solutions", title: "Open any worked solution while practising; the printed copy ends with them" },
                { value: "hidden", label: "Test conditions", title: "Solutions stay hidden in this paper and its printed copy" },
              ]} />
              <p class="pb-hint small">{st.solutions === "included" ? "Open any question’s worked solution while practising. The printed copy ends with a solutions section." : "Solutions stay hidden in this paper and in its printed copy."}</p>
            </Field>
          </div>

          <PoolPanel pool={bp.pool} set={setPool} ev={ev} ctx={ctx} lib={lib} boot={boot} />

          <div class="pb-group">
            <div class="pb-group-head"><div><span class="pb-step">3</span><h2 class="pb-group-title">How to pick</h2></div></div>
            <Section title="Mix" badge={activeDims(bp).length ? <Badge tone="accent">{activeDims(bp).length} on</Badge> : undefined}
              hint="Split the paper by share. Turn on as many as you like — they are met together.">
              <MixPanel bp={bp} setShare={setShare} ctx={ctx} boot={boot} poolBreak={poolBreak} plan={plan} />
            </Section>
            <Section title="Priorities" badge={bp.favourWrong || bp.favourStale || bp.favourWeak ? <Badge tone="accent">On</Badge> : undefined}
              hint="Make some questions more likely, without forcing them in.">
              <div class="switch-list">
                <Switch label="Questions I got wrong" hint="Wrong last time counts ×3, partly right ×2" checked={bp.favourWrong} onChange={(v) => setBp((b) => ({ ...b, favourWrong: v }))} />
                <Switch label="Questions I haven’t seen for a while" hint="Never attempted ×2, 30+ days ×2, 14+ days ×1.5" checked={bp.favourStale} onChange={(v) => setBp((b) => ({ ...b, favourStale: v }))} />
                <Switch label="My weak concepts" hint="Concepts under 60% accuracy count up to ×2.8" checked={bp.favourWeak} onChange={(v) => setBp((b) => ({ ...b, favourWeak: v }))} />
              </div>
            </Section>
            <Section title="Order" defaultOpen={false} badge={bp.order !== "picked" ? <Badge tone="accent">{ORDER_LABEL[bp.order]}</Badge> : undefined}>
              <div class="radio-list" role="radiogroup" aria-label="Question order">
                {(Object.keys(ORDER_LABEL) as Order[]).map((o) => (
                  <label class={`radio-row${bp.order === o ? " on" : ""}`}>
                    <input type="radio" name="pb-order" checked={bp.order === o} onChange={() => setBp((b) => ({ ...b, order: o, manual: o === "manual" && !b.manual.length ? currentIds() : b.manual }))} />
                    <span>{ORDER_LABEL[o]}</span>
                  </label>
                ))}
              </div>
              {bp.order === "manual" && <p class="pb-hint small">Move questions with the arrows next to their number in the table.</p>}
            </Section>
            <Section title="Seed" defaultOpen={false}>
              <p class="pb-hint">The seed is this paper’s shuffle number. The same rules with the same seed always give the same paper; <b>Shuffle</b> picks a new seed for a different selection. Saved papers never change.</p>
              <div class="pb-inline">
                <NumBox value={st.seed} label="Seed" min={0} integer placeholder="" class="w8" onChange={(v) => v !== null && set({ seed: v })} />
                <button type="button" class="btn small" onClick={() => set({ seed: randomSeed() })}><Icon name="shuffle" size={14} /> New seed</button>
              </div>
            </Section>
          </div>
        </aside>

        <section class="pb-main" aria-label="Preview">
          <Summary picks={picks} plan={plan} ctx={ctx} marks={marks} poolSize={ev.pool.length} />
          <Alerts plan={plan} bp={bp} ctx={ctx} poolSize={ev.pool.length} onUseAll={() => setBp((b) => ({ ...b, count: Math.max(1, plan.candidates) }))} />
          <PaperTable
            rows={rows}
            ctx={ctx}
            now={now}
            storageKey="pb.columns"
            title={<><h2 class="dt-h">Questions in this paper</h2><span class="dt-count">{plan.picks.length}{plan.shortfall ? ` of ${plan.want}` : ""}</span></>}
            actions={actions}
            toolbar={
              <>
                <AddQuestion lib={lib} inPaper={new Set(picks.map((q) => q.id))} includeArchived={bp.pool.includeArchived} ctx={ctx} onAdd={addQuestion} />
                {bp.pinned.length > 0 && <button type="button" class="btn small ghost" onClick={() => setBp((b) => ({ ...b, pinned: [] }))}>Unpin all ({bp.pinned.length})</button>}
                <button type="button" class="btn small ghost hide-narrow" onClick={() => setRulesHidden(!rulesHidden)} aria-pressed={rulesHidden}>
                  <Icon name="panel" size={14} /> {rulesHidden ? "Show rules" : "Hide rules"}
                </button>
              </>
            }
            empty={
              <div class="dt-empty-inner">
                <Icon name="filter" size={22} />
                <p><b>No questions match your rules.</b></p>
                <p class="muted">Loosen a rule on the left — the numbers beside each choice show what you would get.</p>
              </div>
            }
          />
          {removed.length > 0 && (
            <details class="removed">
              <summary>Removed from this paper ({removed.length})</summary>
              <ul>
                {removed.map((q) => (
                  <li>
                    <span class="removed-q">Q{q.qno}</span>
                    <span class="removed-t">{q.plain_text.replace(/\s+/g, " ").slice(0, 120)}</span>
                    <button type="button" class="btn small ghost" onClick={() => putBack([q.id])}>Put back</button>
                  </li>
                ))}
              </ul>
              {removed.length > 1 && <button type="button" class="btn small" onClick={() => putBack(removed.map((q) => q.id))}>Put all back</button>}
            </details>
          )}
        </section>
      </div>

      <div class="pb-foot">
        <div class="pb-foot-sum">
          <b>{plan.picks.length}</b> question{plan.picks.length === 1 ? "" : "s"}
          <span class="dot-sep" aria-hidden="true">·</span>{fmtMarks(marks)} marks
          {bp.pinned.length > 0 && <><span class="dot-sep" aria-hidden="true">·</span>{bp.pinned.length} pinned</>}
          {plan.offTarget > 0 && <><span class="dot-sep" aria-hidden="true">·</span><span class="warn-ink">{plan.offTarget} off target</span></>}
        </div>
        <button type="button" class="btn primary" disabled={!canSave} onClick={save}>{busy ? "Saving…" : "Save paper"}</button>
      </div>
    </div>
  );
}

const fmtMarks = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ------------------------------------------------------------------ summary

const RESULT_TONE: Record<string, string> = { never: "st-none", incorrect: "st-crit", partial: "st-warn", correct: "st-good", ungraded: "st-muted" };

function Summary(props: { picks: LibQ[]; plan: ReturnType<typeof planPaper>; ctx: Ctx; marks: number; poolSize: number }) {
  const { picks, ctx } = props;
  const unmarked = picks.filter((q) => q.marks === null).length;
  const never = picks.filter((q) => resultBucket(q) === "never").length;
  const wrong = picks.filter((q) => q.last_result === "incorrect" || q.last_result === "partial").length;
  const known = picks.filter((q) => q.attempt_count);
  const knownSecs = known.reduce((a, q) => a + (q.total_time_seconds ?? 0) / q.attempt_count!, 0);
  const est = known.length ? knownSecs + (picks.length - known.length) * (knownSecs / known.length) : null;
  const subjectOrder = ctx.tree.filter((n) => n.kind === "subject").map((n) => n.subjectId);

  const diffSegs = [...ctx.rank.keys()].map((code) => ({ key: code, label: valueLabel("difficulty", code, ctx), n: picks.filter((q) => q.difficulty_code === code).length, cls: `seg-${difficultyTone(ctx, code)}` }));
  diffSegs.push({ key: NONE, label: "No label", n: picks.filter((q) => !q.difficulty_code || !ctx.rank.has(q.difficulty_code)).length, cls: "seg-t-none" });
  const subjCounts = new Map<string, number>();
  for (const q of picks) subjCounts.set(q.subject_id ?? NONE, (subjCounts.get(q.subject_id ?? NONE) ?? 0) + 1);
  const subjSegs = subjectOrder.filter((s) => subjCounts.has(s)).map((s) => ({ key: s, label: ctx.subjectName.get(s) ?? "?", n: subjCounts.get(s)!, cls: `seg-s${subjectSlot(ctx, s)}` }));
  if (subjCounts.has(NONE)) subjSegs.push({ key: NONE, label: "No subject", n: subjCounts.get(NONE)!, cls: "seg-sx" });
  const resSegs = RESULT_BUCKETS.map((b) => ({ key: b, label: RESULT_LABEL[b], n: picks.filter((q) => resultBucket(q) === b).length, cls: `seg-${RESULT_TONE[b]}` }));

  return (
    <div class="pb-summary">
      <div class="kpis">
        <Kpi label="Questions" value={String(picks.length)} sub={props.plan.shortfall ? `${props.plan.shortfall} short of ${props.plan.want}` : `from ${props.poolSize.toLocaleString()} that match`} warn={props.plan.shortfall > 0} />
        <Kpi label="Total marks" value={fmtMarks(props.marks)} sub={unmarked ? `${unmarked} without marks` : "all questions marked"} />
        <Kpi label="Time estimate" value={est === null ? "—" : `${Math.max(1, Math.round(est / 60))} min`} sub={est === null ? "no past times yet" : `from your times on ${known.length} of ${picks.length}`} />
        <Kpi label="New to you" value={String(never)} sub="never attempted" />
        <Kpi label="Got wrong before" value={String(wrong)} sub="wrong or partly right last time" />
      </div>
      {picks.length > 0 && (
        <div class="dists">
          <Dist title="Difficulty" segs={diffSegs} total={picks.length} />
          <Dist title="Subject" segs={subjSegs} total={picks.length} />
          <Dist title="Last result" segs={resSegs} total={picks.length} />
        </div>
      )}
    </div>
  );
}

function Kpi(props: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div class={`kpi${props.warn ? " warn" : ""}`}>
      <div class="kpi-label">{props.label}</div>
      <div class="kpi-value">{props.value}</div>
      <div class="kpi-sub">{props.sub}</div>
    </div>
  );
}

function Dist(props: { title: string; segs: { key: string; label: string; n: number; cls: string }[]; total: number }) {
  const segs = props.segs.filter((s) => s.n > 0);
  const name = segs.map((s) => `${s.label} ${s.n}`).join(", ");
  return (
    <div class="dist">
      <div class="dist-title">{props.title}</div>
      <div class="segbar" role="img" aria-label={`${props.title}: ${name}`}>
        {segs.map((s) => <i class={s.cls} style={{ flexGrow: s.n }} title={`${s.label}: ${s.n} of ${props.total} (${Math.round((s.n / props.total) * 100)}%)`} />)}
      </div>
      <ul class="legend-list">
        {segs.map((s) => <li><i class={s.cls} aria-hidden="true" /><span class="lg-name">{s.label}</span><span class="lg-n">{s.n}</span></li>)}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ alerts

function Alerts(props: { plan: ReturnType<typeof planPaper>; bp: Blueprint; ctx: Ctx; poolSize: number; onUseAll: () => void }) {
  const { plan, bp, ctx } = props;
  const out: JSX.Element[] = [];
  if (plan.shortfall > 0 && plan.candidates > 0) {
    out.push(
      <div class="alert bad" role="alert">
        <Icon name="alert" size={16} />
        <div><b>Only {plan.candidates} question{plan.candidates === 1 ? "" : "s"} can be used, but the paper asks for {plan.want}.</b> Widen your rules on the left, or make the paper shorter.</div>
        <button type="button" class="btn small" onClick={props.onUseAll}>Use {plan.candidates}</button>
      </div>,
    );
  }
  const short = plan.reports.flatMap((r) => r.rows.filter((row) => row.actual < row.target).map((row) => ({ dim: r.dim, row })));
  if (short.length && plan.picks.length) {
    out.push(
      <div class="alert warn" role="status">
        <Icon name="target" size={16} />
        <div><b>Some shares can’t be met together with your rules.</b>{" "}
          {short.map(({ dim, row }) => `${DIM_LABEL[dim]} “${valueLabel(dim, row.value, ctx).split(" › ").pop()}”: ${row.actual} of ${row.target}`).join(" · ")}.
          {" "}The closest questions were used instead and are marked in the table.</div>
      </div>,
    );
  }
  if (bp.pinned.length > bp.count) {
    out.push(<div class="alert info"><Icon name="pin" size={16} /><div>You pinned {bp.pinned.length} questions, so the paper has {bp.pinned.length}.</div></div>);
  }
  return out.length ? <div class="alerts">{out}</div> : null;
}

// ------------------------------------------------------------------ add a specific question

function AddQuestion(props: { lib: LibQ[]; inPaper: Set<string>; includeArchived: boolean; ctx: Ctx; onAdd: (id: string) => void }) {
  const pop = usePopover();
  const [q, setQ] = useState("");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length
    ? props.lib.filter((x) => !props.inPaper.has(x.id) && (props.includeArchived || !x.archived_at) && terms.every((t) => (props.ctx.hay.get(x.id) ?? "").includes(t))).slice(0, 8)
    : [];
  return (
    <div class="pop-wrap" ref={pop.ref}>
      <button type="button" class="btn small" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}><Icon name="plus" size={14} /> Add a question</button>
      {pop.open && (
        <div class="pop wide" role="dialog" aria-label="Add a specific question">
          <div class="pop-title">Add a specific question</div>
          <label class="search-sm wide">
            <Icon name="search" size={14} />
            <input type="search" autoFocus placeholder="Words, Q number or ID" aria-label="Find a question" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
          <p class="pb-hint small">Searches the whole library. Added questions are pinned, and the paper grows by one.</p>
          <ul class="add-list">
            {results.map((x) => (
              <li>
                <div class="add-main">
                  <span class="add-q">Q{x.qno}</span>
                  <span class="add-meta">{x.subject_id ? props.ctx.subjectName.get(x.subject_id) : "No subject"} · {x.file_name}</span>
                  <span class="add-t">{x.plain_text.replace(/\s+/g, " ").slice(0, 110)}</span>
                </div>
                <button type="button" class="btn small" onClick={() => { props.onAdd(x.id); toast(`Q${x.qno} added and pinned`); }}>Add</button>
              </li>
            ))}
            {terms.length > 0 && !results.length && <li class="muted">No other question matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
