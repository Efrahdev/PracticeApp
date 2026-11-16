// Small charts shared by Home and Progress. Colour does one job each: the blue
// ramp is "how much" (activity), the status colours are "how well" (accuracy).
import { useRef, useState } from "preact/hooks";
import { localDate } from "./api";

export interface Day { local_date: string; attempt_count: number; time_seconds: number }

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const longDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** Days practised as a calendar: one column per week (Monday on top), darker = more questions. */
export function ActivityHeatmap(props: { daily: Day[]; weeks?: number }) {
  const weeks = props.weeks ?? 16;
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const byDay = new Map(props.daily.map((r) => [r.local_date, r.attempt_count]));
  const today = new Date();
  const todayKey = localDate(today);
  const start = new Date(today);
  start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7); // Monday of the first week
  const cols: { key: string; n: number; future: boolean; month: string | null }[][] = [];
  let max = 1;
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const x = new Date(start);
      x.setDate(start.getDate() + w * 7 + d);
      const key = localDate(x);
      const n = byDay.get(key) ?? 0;
      max = Math.max(max, n);
      const month = d === 0 && x.getMonth() !== lastMonth ? x.toLocaleDateString(undefined, { month: "short" }) : null;
      if (d === 0) lastMonth = x.getMonth();
      col.push({ key, n, future: key > todayKey, month });
    }
    cols.push(col);
  }
  const step = (n: number) => (n === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((n / max) * 4))));
  const show = (e: MouseEvent | FocusEvent, text: string) => {
    const b = box.current?.getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (b) setTip({ x: r.left - b.left + r.width / 2, y: r.top - b.top, text });
  };
  return (
    <div class="heatmap" ref={box} onMouseLeave={() => setTip(null)}>
      <div class="heatmap-days" aria-hidden="true">{WEEKDAYS.map((d, i) => <span>{i % 2 === 0 ? d : ""}</span>)}</div>
      <div class="heatmap-grid" role="img" aria-label={`Questions answered per day over the last ${weeks} weeks`} style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {cols.map((col) => (
          <div class="heatmap-col">
            <span class="heatmap-month" aria-hidden="true">{col[0].month ?? ""}</span>
            {col.map((c) => (c.future ? <i class="future" /> : (
              <i class={`h${step(c.n)}${c.key === todayKey ? " today" : ""}`}
                onMouseEnter={(e) => show(e, `${longDate(c.key)} — ${c.n} question${c.n === 1 ? "" : "s"}`)} />
            )))}
          </div>
        ))}
      </div>
      <div class="heatmap-legend" aria-hidden="true"><span>Less</span><i class="h0" /><i class="h1" /><i class="h2" /><i class="h3" /><i class="h4" /><span>More</span></div>
      {tip && <div class="tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{tip.text}</div>}
    </div>
  );
}

/** A tiny trend line for table rows (accuracy 0..1 per week). */
export function Spark(props: { values: number[] }) {
  const v = props.values.slice(-12);
  if (v.length < 2) return <span class="muted small">—</span>;
  const W = 96, H = 26, P = 3;
  const xy = v.map((y, i) => [P + (i / (v.length - 1)) * (W - 2 * P), H - P - y * (H - 2 * P)] as const);
  const up = v[v.length - 1] >= v[0];
  return (
    <svg class={`spark ${up ? "up" : "down"}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Trend: ${Math.round(v[0] * 100)}% to ${Math.round(v[v.length - 1] * 100)}%`}>
      <polyline fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points={xy.map((p) => p.join(",")).join(" ")} />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="2.6" />
    </svg>
  );
}
