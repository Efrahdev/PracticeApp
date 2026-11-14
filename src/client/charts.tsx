// Small, dependency-free charts for the dashboard. Each renders at its real pixel
// width (so text never stretches), has a hover/touch tooltip, recessive gridlines,
// thin marks with rounded data ends, and a legend whenever there are 2+ series.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    if (!("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

/** Evenly spaced axis labels; the last one only when it can't collide with the previous. */
const showLabel = (i: number, n: number, every: number) => i % every === 0 ? n - 1 - i >= every / 2 || i === n - 1 || every === 1 : i === n - 1 && (n - 1) % every >= every / 2;

export interface BarPoint { x: string; label: string; y: number; tip?: string }

/** Vertical bars over time (one series). */
export function Bars(props: { points: BarPoint[]; height?: number; yFmt?: (v: number) => string; name: string; empty?: string }) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = props.height ?? 180, P = { l: 34, r: 8, t: 10, b: 24 };
  const pts = props.points;
  if (!pts.length || pts.every((p) => !p.y)) return <div ref={ref} class="chart-empty">{props.empty ?? "No activity in this period."}</div>;
  const peak = Math.max(...pts.map((p) => p.y));
  const max = pts.every((p) => Number.isInteger(p.y)) && peak <= 10 ? Math.max(2, Math.ceil(peak / 2) * 2) : niceMax(peak);
  const fmt = props.yFmt ?? ((v: number) => String(Math.round(v)));
  const pw = Math.max(10, w - P.l - P.r), ph = H - P.t - P.b;
  const step = pw / pts.length;
  const bw = Math.max(2, Math.min(28, step - 2));
  const y = (v: number) => P.t + ph - (v / max) * ph;
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(pw / 64))));
  const onMove = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - P.l) / step);
    setHover(i >= 0 && i < pts.length ? i : null);
  };
  const h = hover !== null ? pts[hover] : null;
  return (
    <div class="chart" ref={ref}>
      <svg width={w} height={H} role="img" aria-label={`${props.name}: ${pts.filter((p) => p.y).length} periods with activity, peak ${fmt(Math.max(...pts.map((p) => p.y)))}`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g>
            <line x1={P.l} x2={w - P.r} y1={y(max * f)} y2={y(max * f)} class={f === 0 ? "c-base" : "c-grid"} />
            <text x={P.l - 6} y={y(max * f) + 4} class="c-axis" text-anchor="end">{fmt(max * f)}</text>
          </g>
        ))}
        {pts.map((p, i) => {
          const x = P.l + i * step + (step - bw) / 2;
          const top = y(p.y);
          const hgt = P.t + ph - top;
          return (
            <g>
              {p.y > 0 && <path d={`M${x},${P.t + ph} V${top + Math.min(4, hgt)} q0,-${Math.min(4, hgt)} ${Math.min(4, bw / 2)},-${Math.min(4, hgt)} H${x + bw - Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, hgt)} V${P.t + ph} Z`}
                class={`c-bar${hover === i ? " on" : ""}`} />}
              {showLabel(i, pts.length, every) && <text x={P.l + i * step + step / 2} y={H - 6} class="c-axis" text-anchor="middle">{p.label}</text>}
            </g>
          );
        })}
      </svg>
      {h && (
        <div class="c-tip" style={{ left: `${Math.min(w - 150, Math.max(0, P.l + hover! * step + step / 2 - 70))}px` }}>
          <b>{h.tip ?? h.x}</b><span>{fmt(h.y)}</span>
        </div>
      )}
    </div>
  );
}

export interface LineSeries { label: string; cls: string; points: (number | null)[] }

/** One or more lines over shared x labels, with a crosshair tooltip. */
export function Lines(props: { xs: { x: string; label: string; tip?: string }[]; series: LineSeries[]; yMax?: number; yFmt?: (v: number) => string; height?: number; name: string; empty?: string }) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = props.height ?? 200, P = { l: 38, r: 12, t: 12, b: 24 };
  const n = props.xs.length;
  const vals = props.series.flatMap((s) => s.points.filter((v): v is number => v !== null));
  if (!n || !vals.length) return <div ref={ref} class="chart-empty">{props.empty ?? "Not enough graded answers yet."}</div>;
  const max = props.yMax ?? niceMax(Math.max(...vals));
  const fmt = props.yFmt ?? ((v: number) => String(Math.round(v)));
  const pw = Math.max(10, w - P.l - P.r), ph = H - P.t - P.b;
  const x = (i: number) => P.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v: number) => P.t + ph - (v / max) * ph;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 70))));
  const onMove = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = n === 1 ? 0 : Math.round(((e.clientX - r.left - P.l) / pw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const path = (pts: (number | null)[]) => {
    let d = "", pen = false;
    pts.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <div class="chart" ref={ref}>
      <svg width={w} height={H} role="img" aria-label={props.name} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g>
            <line x1={P.l} x2={w - P.r} y1={y(max * f)} y2={y(max * f)} class={f === 0 ? "c-base" : "c-grid"} />
            {(f * 4) % 2 === 0 && <text x={P.l - 6} y={y(max * f) + 4} class="c-axis" text-anchor="end">{fmt(max * f)}</text>}
          </g>
        ))}
        {props.xs.map((p, i) => (showLabel(i, n, every) ? <text x={x(i)} y={H - 6} class="c-axis" text-anchor="middle">{p.label}</text> : null))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={P.t + ph} class="c-cross" />}
        {props.series.map((s) => (
          <g class={s.cls}>
            <path d={path(s.points)} class="c-line" />
            {s.points.map((v, i) => (v === null ? null : (n <= 40 || hover === i) && <circle cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} class="c-dot" />))}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div class="c-tip" style={{ left: `${Math.min(w - 170, Math.max(0, x(hover) - 80))}px` }}>
          <b>{props.xs[hover].tip ?? props.xs[hover].x}</b>
          {props.series.map((s) => <span><i class={`c-key ${s.cls}`} />{s.label}: {s.points[hover] === null ? "—" : fmt(s.points[hover]!)}</span>)}
        </div>
      )}
      {props.series.length > 1 && (
        <div class="legend">{props.series.map((s) => <span><i class={`c-key ${s.cls}`} />{s.label}</span>)}</div>
      )}
    </div>
  );
}

/** Calendar heatmap: one column per week (Mon–Sun), 5 sequential steps. */
export function Heatmap(props: { days: { date: string; n: number }[]; name: string }) {
  const max = Math.max(1, ...props.days.map((d) => d.n));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)));
  const first = props.days[0] ? (new Date(props.days[0].date + "T00:00:00").getDay() + 6) % 7 : 0;
  const cells: ({ date: string; n: number } | null)[] = [...Array(first).fill(null), ...props.days];
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const months: { i: number; label: string }[] = [];
  weeks.forEach((wk, i) => {
    const d = wk.find((c) => c && c.date.endsWith("-01")) ?? (i === 0 ? wk.find((c) => c) : null);
    if (d) months.push({ i, label: new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short" }) });
  });
  return (
    <div class="heatmap" role="img" aria-label={`${props.name}: ${props.days.filter((d) => d.n).length} active days, most in one day ${max}`}>
      <div class="hm-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 18px))` }}>
        {months.map((m) => <span style={{ gridColumn: `${m.i + 1}` }}>{m.label}</span>)}
      </div>
      <div class="hm-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 18px))` }}>
        {weeks.map((wk) => (
          <div class="hm-week">
            {Array.from({ length: 7 }, (_, k) => {
              const c = wk[k];
              return c ? <i class={`hm-${level(c.n)}`} title={`${new Date(c.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}: ${c.n} answered`} /> : <i class="hm-x" />;
            })}
          </div>
        ))}
      </div>
      <div class="hm-legend"><span>Less</span>{[0, 1, 2, 3, 4].map((l) => <i class={`hm-${l}`} />)}<span>More</span></div>
    </div>
  );
}

/** Horizontal bar rows: label, bar, value. */
export function BarRows(props: { rows: { key: string; label: ComponentChildren; value: number; max: number; text: string; sub?: string; cls?: string; title?: string }[]; empty?: string }) {
  if (!props.rows.length) return <div class="chart-empty">{props.empty ?? "No data yet."}</div>;
  return (
    <ul class="barrows">
      {props.rows.map((r) => (
        <li title={r.title}>
          <span class="br-label">{r.label}</span>
          <span class="br-track"><i class={r.cls ?? "c-fill"} style={{ width: `${r.max ? Math.max(r.value > 0 ? 1.5 : 0, (r.value / r.max) * 100) : 0}%` }} /></span>
          <span class="br-val">{r.text}{r.sub && <span class="br-sub">{r.sub}</span>}</span>
        </li>
      ))}
    </ul>
  );
}
