// "Mix": how the paper is split. Any number of mixes can be on at once
// (e.g. 60% Maths / 40% Physics AND 20% easy / 50% medium / 30% hard); the
// generator meets them together and says plainly when the pool can't.
import { useState } from "preact/hooks";
import type { Boot } from "../types";
import { Badge, Icon, NumBox, Segmented } from "./controls";
import { DIM_LABEL, FORMAT_LABEL, RESULT_LABEL, valueLabel } from "./describe";
import type { DimReport, Plan } from "./engine";
import type { Breakdown, Ctx } from "./pool";
import { DIMS, NONE, OTHER, RESULT_BUCKETS, type Blueprint, type DimKey, type ShareDim } from "./spec";

interface ValueRow { key: string; label: string; avail: number; depth: number; header?: boolean }

const DIM_HINT: Record<DimKey, string> = {
  subject: "e.g. 60% Maths, 40% Physics",
  concept: "e.g. 50% Algebra, 25% Geometry — each question counts once, for its strongest concept",
  difficulty: "e.g. 20% easy, 50% medium, 30% hard",
  result: "e.g. 40% got wrong, 60% never tried",
  format: "e.g. half multiple choice",
};

function valueRows(dim: DimKey, ctx: Ctx, boot: Boot, br: Breakdown, share: ShareDim): ValueRow[] {
  const keep = (r: ValueRow) => r.header || r.avail > 0 || (share.values[r.key] ?? 0) > 0;
  switch (dim) {
    case "subject": {
      const rows = ctx.tree.filter((n) => n.kind === "subject").map((n) => ({ key: n.subjectId, label: n.label, avail: br.subject.get(n.subjectId) ?? 0, depth: 0 }));
      rows.push({ key: NONE, label: "No subject", avail: br.subject.get(NONE) ?? 0, depth: 0 });
      return rows.filter(keep);
    }
    case "difficulty": {
      const rows = [...boot.difficulties].sort((a, b) => a.sort_rank - b.sort_rank).map((d) => ({ key: d.code, label: d.label, avail: br.difficulty.get(d.code) ?? 0, depth: 0 }));
      rows.push({ key: NONE, label: "No label", avail: br.difficulty.get(NONE) ?? 0, depth: 0 });
      return rows.filter(keep);
    }
    case "result":
      return RESULT_BUCKETS.map((b) => ({ key: b, label: RESULT_LABEL[b], avail: br.result.get(b) ?? 0, depth: 0 })).filter(keep);
    case "format":
      return Object.keys(FORMAT_LABEL).map((f) => ({ key: f, label: FORMAT_LABEL[f], avail: br.format.get(f) ?? 0, depth: 0 })).filter(keep);
    case "concept": {
      const out: ValueRow[] = [];
      for (const s of ctx.tree) {
        if (s.kind !== "subject") continue;
        const rows: ValueRow[] = [];
        const walk = (n: typeof s) => {
          if (n.kind === "concept") rows.push({ key: n.key, label: n.label, avail: br.concept.get(n.key) ?? 0, depth: n.depth });
          n.children.forEach(walk);
        };
        s.children.forEach(walk);
        const kept = rows.filter(keep);
        if (kept.length) out.push({ key: `h:${s.subjectId}`, label: s.label, avail: 0, depth: 0, header: true }, ...kept);
      }
      return out;
    }
  }
}

export function MixPanel(props: { bp: Blueprint; setShare: (d: DimKey, s: ShareDim) => void; ctx: Ctx; boot: Boot; poolBreak: Breakdown; plan: Plan }) {
  const reports = new Map(props.plan.reports.map((r) => [r.dim, r]));
  return (
    <div class="mix">
      {DIMS.map((d) => (
        <DimEditor key={d} dim={d} share={props.bp.shares[d]} setShare={(s) => props.setShare(d, s)} ctx={props.ctx} boot={props.boot}
          br={props.poolBreak} report={reports.get(d)} want={props.plan.want} />
      ))}
    </div>
  );
}

function DimEditor(props: { dim: DimKey; share: ShareDim; setShare: (s: ShareDim) => void; ctx: Ctx; boot: Boot; br: Breakdown; report?: DimReport; want: number }) {
  const { dim, share, setShare, ctx, want } = props;
  const [find, setFind] = useState("");
  const rows = valueRows(dim, ctx, props.boot, props.br, share);
  const set = Object.entries(share.values).filter(([, v]) => v > 0);
  const total = set.reduce((a, [, v]) => a + v, 0);
  const pctUnit = share.unit === "percent";
  const cap = pctUnit ? 100 : want;
  const byValue = new Map(props.report?.rows.map((r) => [r.value, r]) ?? []);
  const other = byValue.get(OTHER);
  const short = props.report?.rows.filter((r) => r.actual < r.target) ?? [];
  const term = find.trim().toLowerCase();
  const shownRows = term ? rows.filter((r) => !r.header && r.label.toLowerCase().includes(term)) : rows;

  const setValue = (k: string, v: number | null) => {
    const values = { ...share.values };
    if (v && v > 0) values[k] = v;
    else delete values[k];
    setShare({ ...share, values });
  };
  const setUnit = (unit: ShareDim["unit"]) => {
    if (unit === share.unit) return;
    const values: Record<string, number> = {};
    for (const [k, v] of set) {
      const nv = unit === "count" ? Math.round((v / 100) * want) : Math.round((v / Math.max(1, want)) * 100);
      if (nv > 0) values[k] = nv;
    }
    setShare({ ...share, unit, values });
  };
  const splitEvenly = () => {
    const keys = set.length >= 2 ? set.map(([k]) => k) : rows.filter((r) => !r.header && r.avail > 0 && (dim !== "concept" || r.depth === 1)).map((r) => r.key);
    if (!keys.length) return;
    const base = Math.floor(cap / keys.length);
    let extra = cap - base * keys.length;
    const values: Record<string, number> = {};
    for (const k of keys) {
      values[k] = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      if (!values[k]) delete values[k];
    }
    setShare({ ...share, values });
  };
  const summary = set.length
    ? set.map(([k, v]) => `${valueLabel(dim, k, ctx).split(" › ").pop()} ${v}${pctUnit ? "%" : ""}`).join(" · ")
    : "Type a share next to any value below";

  return (
    <div class={`mix-dim${share.on ? " on" : ""}`}>
      <label class="mix-head">
        <input type="checkbox" role="switch" class="switch" checked={share.on} onChange={(e) => setShare({ ...share, on: (e.target as HTMLInputElement).checked })} />
        <span class="mix-name">By {DIM_LABEL[dim].toLowerCase()}</span>
        {share.on && short.length > 0 && <Badge tone="warn">{short.reduce((a, r) => a + r.target - r.actual, 0)} short</Badge>}
        {share.on && set.length > 0 && short.length === 0 && <Badge tone="ok">On target</Badge>}
      </label>
      {!share.on && <p class="mix-off">{DIM_HINT[dim]}</p>}
      {share.on && (
        <div class="mix-body">
          <p class={`mix-summary${set.length ? "" : " muted"}`}>{summary}</p>
          <div class="mix-tools">
            <Segmented size="sm" label={`${DIM_LABEL[dim]} shares in`} value={share.unit} onChange={setUnit}
              options={[{ value: "percent", label: "%" }, { value: "count", label: "Count" }]} />
            <span class="grow" />
            <button type="button" class="btn ghost small" onClick={splitEvenly} title="Give the same share to each value">Split evenly</button>
            <button type="button" class="btn ghost small" disabled={!set.length} onClick={() => setShare({ ...share, values: {} })}>Clear</button>
          </div>
          {dim === "concept" && rows.length > 12 && (
            <label class="search-sm wide">
              <Icon name="search" size={14} />
              <input type="search" placeholder="Find a concept" aria-label="Find a concept" value={find} onInput={(e) => setFind((e.target as HTMLInputElement).value)} />
            </label>
          )}
          <div class={`mix-table${dim === "concept" ? " tall" : ""}`} role="table" aria-label={`${DIM_LABEL[dim]} shares`}>
            <div class="mix-row mix-th" role="row">
              <span role="columnheader">{DIM_LABEL[dim]}</span>
              <span role="columnheader" class="r" title="Questions available with your rules">Pool</span>
              <span role="columnheader" class="r">Share</span>
              <span role="columnheader" class="r" title="Target → in the paper now">In paper</span>
            </div>
            {shownRows.map((r) => {
              if (r.header) return <div class="mix-row mix-group" role="row"><span role="cell">{r.label}</span></div>;
              const rep = byValue.get(r.key);
              const v = share.values[r.key] ?? null;
              return (
                <div class={`mix-row${r.avail === 0 ? " empty" : ""}`} role="row">
                  <span role="cell" class="mix-label" style={{ paddingLeft: `${Math.max(0, r.depth - 1) * 14}px` }} title={dim === "concept" ? valueLabel(dim, r.key, ctx) : undefined}>{r.label}</span>
                  <span role="cell" class="r num muted">{r.avail}</span>
                  <span role="cell" class="r">
                    <span class="share-in">
                      <NumBox value={v} label={`${r.label} share`} min={0} max={pctUnit ? 100 : undefined} integer={!pctUnit} placeholder="—" class="w4"
                        onChange={(nv) => setValue(r.key, nv)} />
                      <span class="share-u">{pctUnit ? "%" : ""}</span>
                    </span>
                  </span>
                  <span role="cell" class="r">{rep ? <TargetCell target={rep.target} actual={rep.actual} /> : <span class="muted">—</span>}</span>
                </div>
              );
            })}
            {set.length > 0 && (
              <div class="mix-row mix-rest" role="row">
                <span role="cell" class="mix-label" title={`Every ${DIM_LABEL[dim].toLowerCase()} without its own share`}>Everything else</span>
                <span role="cell" class="r" />
                <span role="cell" class="r num muted">{Math.max(0, cap - total)}{pctUnit ? "%" : ""}</span>
                <span role="cell" class="r">{other ? <TargetCell target={other.target} actual={other.actual} /> : null}</span>
              </div>
            )}
          </div>
          {total > cap && (
            <p class="mix-warn"><Icon name="info" size={13} /> Shares add up to {total}{pctUnit ? "%" : ` questions, more than the paper’s ${want}`} — they are scaled down to fit.</p>
          )}
          {short.length > 0 && (
            <p class="mix-warn bad"><Icon name="alert" size={13} /> Not enough matching questions for {short.map((r) => `${valueLabel(dim, r.value, ctx).split(" › ").pop()} (${r.actual} of ${r.target}, ${r.available} in pool)`).join(", ")}. Widen your rules or lower the share.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TargetCell(props: { target: number; actual: number }) {
  const ok = props.actual === props.target;
  return (
    <span class={`tgt${ok ? " ok" : props.actual < props.target ? " short" : " over"}`} title={`Target ${props.target}, in paper ${props.actual}`}>
      <b>{props.actual}</b><span class="tgt-of">/{props.target}</span>
    </span>
  );
}
