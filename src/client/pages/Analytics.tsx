// Progress dashboard (FR-5). Every number follows the period switch (7 / 30 / 90 days /
// all time) and compares with the period before. Built from the derived metric
// tables plus per-day aggregates; nothing here writes data.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { SortTable } from "../grid";
import { api, localDate } from "../api";
import { descendants } from "../filter";
import { openBuilder, useData } from "../store";
import type { Boot, LibQ } from "../types";
import { conceptPath, ErrorBox, familiarityNow, fmtSecs } from "../ui";
import { Badge, Icon, Segmented } from "../builder/controls";
import { difficultyTone, subjectSlot } from "../builder/describe";
import { makeCtx, type Ctx } from "../builder/pool";
import { Bars, BarRows, Heatmap, Lines } from "../charts";

interface AData {
  concept: { concept_id: string; local_date: string; graded_count: number; weight_sum: number; score_weight_sum: number }[];
  subject: { subject_id: string; local_date: string; graded_count: number; score_permille_sum: number }[];
  daily: { local_date: string; attempt_count: number; time_seconds: number }[];
  days?: { local_date: string; attempts: number; graded: number; score_sum: number; correct: number; secs: number }[];
  byDiff?: { local_date: string; code: string | null; graded: number; score_sum: number; secs: number; attempts: number }[];
  errors?: { local_date: string; code: string; n: number }[];
  confidence?: { local_date: string; level: number; n: number; score_sum: number }[];
}

let cache: AData | null = null;
async function loadAnalytics(force = false): Promise<AData> {
  if (!cache || force) cache = await api<AData>("GET", "/api/analytics");
  return cache;
}

/** Overall accuracy per concept (0..1), used by the sampler's "weak concepts" option. */
export function useConceptAccuracy(): Map<string, number> {
  const [m, setM] = useState(new Map<string, number>());
  useEffect(() => {
    loadAnalytics().then((d) => {
      const agg = new Map<string, { w: number; s: number }>();
      for (const r of d.concept) {
        const a = agg.get(r.concept_id) ?? { w: 0, s: 0 };
        a.w += r.weight_sum; a.s += r.score_weight_sum;
        agg.set(r.concept_id, a);
      }
      setM(new Map([...agg].map(([k, v]) => [k, v.w ? v.s / v.w / 1000 : 0])));
    }).catch(() => {});
  }, []);
  return m;
}

type Period = "7" | "30" | "90" | "all";
const PERIOD_LABEL: Record<Period, string> = { "7": "last 7 days", "30": "last 30 days", "90": "last 90 days", all: "all time" };
const DAY = 86_400_000;
const addDays = (date: string, n: number) => { const d = new Date(date + "T00:00:00"); d.setDate(d.getDate() + n); return localDate(d); };
const weekOf = (date: string) => { const d = new Date(date + "T00:00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDate(d); };
const short = (date: string) => new Date(date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
const pctTxt = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);
const hm = (secs: number) => { const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Mastery = "new" | "struggling" | "learning" | "mastered";
export function masteryOf(q: LibQ): Mastery {
  if (!q.attempt_count) return "new";
  if (q.last_result === "incorrect") return "struggling";
  if (q.last_result === "correct" && (q.correct_count ?? 0) >= 2) return "mastered";
  return "learning";
}
const MASTERY: { key: Mastery; label: string; cls: string; hint: string }[] = [
  { key: "mastered", label: "Mastered", cls: "seg-st-good", hint: "right last time, and right at least twice" },
  { key: "learning", label: "Learning", cls: "seg-st-warn", hint: "partly right, or right only once" },
  { key: "struggling", label: "Struggling", cls: "seg-st-crit", hint: "wrong last time" },
  { key: "new", label: "Not started", cls: "seg-st-none", hint: "never attempted" },
];

export function Analytics() {
  const { boot, lib } = useData();
  const [d, setD] = useState<AData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(() => { try { return (localStorage.getItem("dash.period") as Period) || "30"; } catch { return "30"; } });
  useEffect(() => { loadAnalytics(true).then(setD).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { try { localStorage.setItem("dash.period", period); } catch { /* ignore */ } }, [period]);
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  if (err) return <ErrorBox error={err} />;
  if (!d || !boot || !lib || !ctx) return <p class="muted">Loading…</p>;
  return <Dashboard d={d} boot={boot} lib={lib} ctx={ctx} period={period} setPeriod={setPeriod} />;
}

function Dashboard(props: { d: AData; boot: Boot; lib: LibQ[]; ctx: Ctx; period: Period; setPeriod: (p: Period) => void }) {
  const { d, boot, lib, ctx, period } = props;
  const today = localDate();
  const now = Date.now();
  const N = period === "all" ? null : Number(period);
  const firstDate = d.daily[0]?.local_date ?? today;
  const start = N ? addDays(today, -(N - 1)) : firstDate;
  const prevStart = N ? addDays(start, -N) : null;
  const inP = (date: string) => date >= start && date <= today;
  const inPrev = (date: string) => !!prevStart && date >= prevStart && date < start;
  const days = d.days ?? d.daily.map((r) => ({ local_date: r.local_date, attempts: r.attempt_count, graded: 0, score_sum: 0, correct: 0, secs: r.time_seconds }));
  const live = lib.filter((q) => !q.archived_at);

  const sum = (f: (date: string) => boolean) => {
    const o = { attempts: 0, graded: 0, score: 0, correct: 0, secs: 0, active: 0 };
    for (const r of days) if (f(r.local_date)) { o.attempts += r.attempts; o.graded += r.graded; o.score += r.score_sum; o.correct += r.correct; o.secs += r.secs; if (r.attempts) o.active++; }
    return o;
  };
  const cur = sum(inP);
  const prev = N ? sum(inPrev) : null;
  const acc = (o: { graded: number; score: number }) => (o.graded ? o.score / o.graded / 10 : null);
  const accNow = acc(cur), accPrev = prev ? acc(prev) : null;

  // Streaks
  const activeSet = new Set(days.filter((r) => r.attempts).map((r) => r.local_date));
  let streak = 0;
  for (let k = activeSet.has(today) ? today : addDays(today, -1); activeSet.has(k); k = addDays(k, -1)) streak++;
  let best = 0, run = 0, last: string | null = null;
  for (const date of [...activeSet].sort()) { run = last && addDays(last, 1) === date ? run + 1 : 1; best = Math.max(best, run); last = date; }

  // Mastery (all time, current state of each question)
  const mastery = new Map<Mastery, number>(MASTERY.map((m) => [m.key, 0]));
  for (const q of live) mastery.set(masteryOf(q), mastery.get(masteryOf(q))! + 1);
  const tried = live.filter((q) => q.attempt_count).length;

  // Trend buckets: days for ≤ 30-day periods, weeks otherwise
  const byWeek = !N || N > 30;
  const bucketKeys: string[] = [];
  if (byWeek) { for (let k = weekOf(start); k <= today; k = addDays(k, 7)) bucketKeys.push(k); }
  else { for (let k = start; k <= today; k = addDays(k, 1)) bucketKeys.push(k); }
  const bucketOf = (date: string) => (byWeek ? weekOf(date) : date);
  const bAgg = new Map(bucketKeys.map((k) => [k, { attempts: 0, graded: 0, score: 0, secs: 0 }]));
  for (const r of days) if (inP(r.local_date)) { const b = bAgg.get(bucketOf(r.local_date)); if (b) { b.attempts += r.attempts; b.graded += r.graded; b.score += r.score_sum; b.secs += r.secs; } }
  const xs = bucketKeys.map((k) => ({ x: k, label: short(k), tip: byWeek ? `Week of ${short(k)}` : new Date(k + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) }));

  // Subjects in period
  const subjAgg = new Map<string, { n: number; s: number }>();
  const subjBucket = new Map<string, Map<string, { n: number; s: number }>>();
  const subjPrev = new Map<string, { n: number; s: number }>();
  for (const r of d.subject) {
    if (inP(r.local_date)) {
      const a = subjAgg.get(r.subject_id) ?? { n: 0, s: 0 }; a.n += r.graded_count; a.s += r.score_permille_sum; subjAgg.set(r.subject_id, a);
      const m = subjBucket.get(r.subject_id) ?? new Map(); const b = m.get(bucketOf(r.local_date)) ?? { n: 0, s: 0 }; b.n += r.graded_count; b.s += r.score_permille_sum; m.set(bucketOf(r.local_date), b); subjBucket.set(r.subject_id, m);
    } else if (inPrev(r.local_date)) { const a = subjPrev.get(r.subject_id) ?? { n: 0, s: 0 }; a.n += r.graded_count; a.s += r.score_permille_sum; subjPrev.set(r.subject_id, a); }
  }
  const [trendBy, setTrendBy] = useState<"overall" | "subject">("overall");
  const topSubjects = [...subjAgg.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([id]) => id);

  // Concepts in period, and the comparison window for "improving / slipping"
  const cmpStart = N ? start : addDays(today, -29);
  const cAgg = new Map<string, { w: number; s: number; n: number }>();
  const cRecent = new Map<string, { w: number; s: number; n: number }>();
  const cBefore = new Map<string, { w: number; s: number; n: number }>();
  const cWeekly = new Map<string, Map<string, { w: number; s: number }>>();
  const add = (m: Map<string, { w: number; s: number; n: number }>, r: AData["concept"][number]) => { const a = m.get(r.concept_id) ?? { w: 0, s: 0, n: 0 }; a.w += r.weight_sum; a.s += r.score_weight_sum; a.n += r.graded_count; m.set(r.concept_id, a); };
  for (const r of d.concept) {
    if (inP(r.local_date)) {
      add(cAgg, r);
      const m = cWeekly.get(r.concept_id) ?? new Map(); const b = m.get(weekOf(r.local_date)) ?? { w: 0, s: 0 }; b.w += r.weight_sum; b.s += r.score_weight_sum; m.set(weekOf(r.local_date), b); cWeekly.set(r.concept_id, m);
    }
    if (r.local_date >= cmpStart) add(cRecent, r); else if (N ? inPrev(r.local_date) : true) add(cBefore, r);
  }
  const cAcc = (a?: { w: number; s: number }) => (a && a.w ? a.s / a.w / 10 : null);
  const liveConcept = (id: string) => ctx.chain.has(id);
  const concepts = [...cAgg.entries()].filter(([id]) => liveConcept(id)).map(([id, a]) => ({ id, path: conceptPath(boot, id), acc: cAcc(a)!, n: a.n }));
  const weakest = concepts.filter((c) => c.n >= 3).sort((a, b) => a.acc - b.acc).slice(0, 6);
  const movers = [...cRecent.entries()].filter(([id, a]) => liveConcept(id) && a.n >= 3 && (cBefore.get(id)?.n ?? 0) >= 3)
    .map(([id, a]) => ({ id, path: conceptPath(boot, id), now: cAcc(a)!, before: cAcc(cBefore.get(id))!, delta: cAcc(a)! - cAcc(cBefore.get(id))! }));
  const improving = movers.filter((m) => m.delta >= 5).sort((a, b) => b.delta - a.delta).slice(0, 4);
  const slipping = movers.filter((m) => m.delta <= -5).sort((a, b) => a.delta - b.delta).slice(0, 4);

  // Difficulty, mistakes, confidence, weekday rhythm (period)
  const diffAgg = new Map<string, { n: number; s: number; secs: number; att: number }>();
  for (const r of d.byDiff ?? []) if (inP(r.local_date)) { const k = r.code ?? "__none"; const a = diffAgg.get(k) ?? { n: 0, s: 0, secs: 0, att: 0 }; a.n += r.graded; a.s += r.score_sum; a.secs += r.secs; a.att += r.attempts; diffAgg.set(k, a); }
  const errAgg = new Map<string, number>();
  for (const r of d.errors ?? []) if (inP(r.local_date)) errAgg.set(r.code, (errAgg.get(r.code) ?? 0) + r.n);
  const confAgg = new Map<number, { n: number; s: number }>();
  for (const r of d.confidence ?? []) if (inP(r.local_date)) { const a = confAgg.get(r.level) ?? { n: 0, s: 0 }; a.n += r.n; a.s += r.score_sum; confAgg.set(r.level, a); }
  const weekday = WEEKDAYS.map(() => 0);
  for (const r of days) if (inP(r.local_date)) weekday[(new Date(r.local_date + "T00:00:00").getDay() + 6) % 7] += r.attempts;

  // Review queue: wrong or partly right last time and not seen for a week
  const due = live.filter((q) => (q.last_result === "incorrect" || q.last_result === "partial") && q.last_attempted_at !== null && now - q.last_attempted_at >= 7 * DAY);
  const fading = live.filter((q) => { const f = familiarityNow(q, now); return f !== null && f < 350 && q.last_result === "correct"; });

  // Heatmap: last 26 weeks
  const heatStart = weekOf(addDays(today, -7 * 25));
  const heatDays: { date: string; n: number }[] = [];
  const attemptsByDay = new Map(days.map((r) => [r.local_date, r.attempts]));
  for (let k = heatStart; k <= today; k = addDays(k, 1)) heatDays.push({ date: k, n: attemptsByDay.get(k) ?? 0 });

  const buildOn = (ids: string[], name = "Weak concepts") => openBuilder({ tree: [...descendants(boot.concepts, ids)], favourWeak: true, name });
  const buildReview = () => openBuilder({ name: "Review", pool: { results: ["incorrect", "partial"], recency: { mode: "more_than", n: 1, m: 8, unit: "weeks", includeNever: false } }, favourWeak: true });

  // Plain-English insights
  const insights: { icon: "target" | "alert" | "check" | "clock" | "info"; text: ComponentChildren }[] = [];
  if (accNow !== null && accPrev !== null && Math.abs(accNow - accPrev) >= 2) insights.push({ icon: accNow > accPrev ? "check" : "alert", text: <>Accuracy is <b>{accNow > accPrev ? "up" : "down"} {Math.abs(Math.round(accNow - accPrev))} points</b> on the previous {N} days ({pctTxt(accPrev)} → {pctTxt(accNow)}).</> });
  const subjRank = [...subjAgg.entries()].filter(([, a]) => a.n >= 3).map(([id, a]) => ({ id, acc: a.s / a.n / 10 })).sort((a, b) => b.acc - a.acc);
  if (subjRank.length >= 2) insights.push({ icon: "info", text: <>Strongest subject: <b>{ctx.subjectName.get(subjRank[0].id)}</b> ({pctTxt(subjRank[0].acc)}); weakest: <b>{ctx.subjectName.get(subjRank[subjRank.length - 1].id)}</b> ({pctTxt(subjRank[subjRank.length - 1].acc)}).</> });
  if (weakest[0]) insights.push({ icon: "target", text: <>Biggest gap: <b>{weakest[0].path.split(" › ").pop()}</b> at {pctTxt(weakest[0].acc)} over {weakest[0].n} graded answers.</> });
  if (due.length) insights.push({ icon: "clock", text: <><b>{due.length} question{due.length === 1 ? "" : "s"}</b> you got wrong {due.length === 1 ? "hasn't" : "haven't"} been reviewed for a week or more.</> });
  const hiConf = [4, 5].map((l) => confAgg.get(l)).filter(Boolean) as { n: number; s: number }[];
  const hiN = hiConf.reduce((a, c) => a + c.n, 0);
  if (hiN >= 5) { const hiAcc = hiConf.reduce((a, c) => a + c.s, 0) / hiN / 10; insights.push({ icon: hiAcc >= 75 ? "check" : "alert", text: <>When you feel sure (confidence 4–5) you are right <b>{pctTxt(hiAcc)}</b> of the time{hiAcc < 75 ? " — worth slowing down to check" : ""}.</> }); }
  const topErr = [...errAgg.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topErr && topErr[1] >= 3) insights.push({ icon: "alert", text: <>Most common mistake: <b>{boot.errorTypes.find((e) => e.code === topErr[0])?.label ?? topErr[0]}</b> ({topErr[1]}×).</> });
  const busiest = weekday.indexOf(Math.max(...weekday));
  if (cur.attempts >= 10) insights.push({ icon: "info", text: <>You practise most on <b>{["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][busiest]}</b>.</> });

  const delta = (a: number | null, b: number | null, unit: "pts" | "%" = "%", goodUp = true) => {
    if (a === null || b === null || !N) return null;
    const v = unit === "pts" ? a - b : b ? ((a - b) / b) * 100 : a ? 100 : 0;
    if (Math.abs(v) < 0.5) return <span class="delta flat">no change</span>;
    const up = v > 0;
    return <span class={`delta ${up === goodUp ? "good" : "bad"}`}><Icon name={up ? "up" : "dn"} size={11} />{Math.abs(Math.round(v))}{unit === "pts" ? " pts" : "%"}</span>;
  };

  const noData = days.every((r) => !r.attempts);

  return (
    <div class="lib dash">
      <header class="pb-top">
        <div class="pb-top-main">
          <span class="pb-h1">Progress</span>
          <h1 class="lib-h1">Your dashboard</h1>
          <div class="lib-stats"><span>Showing <b>{PERIOD_LABEL[period]}</b>{N ? <> · {short(start)} – {short(today)}, compared with the {N} days before</> : null}</span></div>
        </div>
        <div class="pb-top-actions">
          <Segmented label="Period" value={period} onChange={props.setPeriod} options={[
            { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "all", label: "All time" },
          ]} />
        </div>
      </header>

      <div class="kpis dash-kpis">
        <Kpi label="Questions answered" value={cur.attempts.toLocaleString()} delta={delta(cur.attempts, prev?.attempts ?? null)} sub={N ? `${prev?.attempts ?? 0} in the previous ${N} days` : `${tried} different questions`} />
        <Kpi label="Accuracy" value={pctTxt(accNow)} delta={delta(accNow, accPrev, "pts")} sub={cur.graded ? `${cur.correct} fully right of ${cur.graded} graded` : "no graded answers"} />
        <Kpi label="Study time" value={hm(cur.secs)} delta={delta(cur.secs, prev?.secs ?? null)} sub={cur.attempts ? `${fmtSecs(cur.secs / cur.attempts)} per question` : "—"} />
        <Kpi label="Active days" value={N ? `${cur.active} of ${N}` : String(cur.active)} sub={`streak ${streak} day${streak === 1 ? "" : "s"} · best ${best}`} />
        <Kpi label="Bank covered" value={pctTxt(live.length ? (tried / live.length) * 100 : null)} sub={`${tried.toLocaleString()} of ${live.length.toLocaleString()} questions tried`} meter={live.length ? tried / live.length : 0} />
        <Kpi label="Mastered" value={(mastery.get("mastered") ?? 0).toLocaleString()} sub={`${pctTxt(live.length ? ((mastery.get("mastered") ?? 0) / live.length) * 100 : null)} of the bank`} meter={live.length ? (mastery.get("mastered") ?? 0) / live.length : 0} />
      </div>

      {insights.length > 0 && (
        <section class="dash-card insights">
          <h2 class="dash-h">Insights</h2>
          <ul>{insights.slice(0, 5).map((i) => <li><span class={`ins-ic ins-${i.icon}`}><Icon name={i.icon} size={15} /></span><span>{i.text}</span></li>)}</ul>
        </section>
      )}

      {noData ? (
        <section class="dash-card"><div class="empty"><p><b>No answers yet.</b></p><p class="muted">Practise a paper and your progress appears here.</p><a class="btn primary" href="#/">Go to the library</a></div></section>
      ) : (
        <>
          <div class="dash-grid two">
            <section class="dash-card">
              <div class="dash-card-head">
                <h2 class="dash-h">Accuracy over time <span class="muted small">{trendBy === "overall" ? (byWeek ? "· per week" : "· 7-day rolling average") : `· per ${byWeek ? "week" : "day"}`}</span></h2>
                <Segmented size="sm" label="Accuracy trend" value={trendBy} onChange={setTrendBy} options={[{ value: "overall", label: "Overall" }, { value: "subject", label: "By subject" }]} />
              </div>
              <Lines name="Accuracy over time" xs={xs} yMax={100} yFmt={(v) => `${Math.round(v)}%`}
                series={trendBy === "overall"
                  ? [{ label: byWeek ? "Weekly accuracy" : "7-day average", cls: "ls-s1", points: bucketKeys.map((k) => {
                      if (byWeek) { const b = bAgg.get(k)!; return b.graded ? b.score / b.graded / 10 : null; }
                      // Daily view: a rolling 7-day average, so one or two answers can't swing it from 0 to 100%.
                      let g = 0, sc = 0;
                      for (const r of days) if (r.local_date <= k && r.local_date > addDays(k, -7)) { g += r.graded; sc += r.score_sum; }
                      return g ? sc / g / 10 : null;
                    }) }]
                  : topSubjects.map((id) => ({ label: ctx.subjectName.get(id) ?? "?", cls: `ls-s${subjectSlot(ctx, id)}`, points: bucketKeys.map((k) => { const b = subjBucket.get(id)?.get(k); return b && b.n ? b.s / b.n / 10 : null; }) }))} />
            </section>
            <section class="dash-card">
              <div class="dash-card-head"><h2 class="dash-h">Questions answered</h2><span class="muted small">per {byWeek ? "week" : "day"}</span></div>
              <Bars name="Questions answered" points={bucketKeys.map((k, i) => ({ x: k, label: xs[i].label, tip: xs[i].tip, y: bAgg.get(k)!.attempts }))} />
            </section>
          </div>

          <section class="dash-card">
            <div class="dash-card-head"><h2 class="dash-h">Practice calendar</h2><span class="muted small">last 26 weeks · {activeSet.size} active days in all</span></div>
            <Heatmap name="Practice calendar" days={heatDays} />
          </section>
        </>
      )}

      <div class="dash-grid two">
        <section class="dash-card">
          <div class="dash-card-head"><h2 class="dash-h">Mastery of your question bank</h2><span class="muted small">current state of each question</span></div>
          <div class="segbar tall" role="img" aria-label={MASTERY.map((m) => `${m.label} ${mastery.get(m.key)}`).join(", ")}>
            {MASTERY.map((m) => (mastery.get(m.key) ? <i class={m.cls} style={{ flexGrow: mastery.get(m.key) }} title={`${m.label}: ${mastery.get(m.key)}`} /> : null))}
          </div>
          <ul class="legend-list cols">
            {MASTERY.map((m) => (
              <li title={m.hint}><i class={m.cls} aria-hidden="true" /><span class="lg-name">{m.label}<span class="sub"> · {m.hint}</span></span><span class="lg-n">{(mastery.get(m.key) ?? 0).toLocaleString()}</span></li>
            ))}
          </ul>
          <h3 class="dash-sub">By subject</h3>
          <ul class="msub">
            {ctx.tree.filter((n) => n.kind === "subject").map((n) => {
              const qs = live.filter((q) => q.subject_id === n.subjectId);
              if (!qs.length) return null;
              const c = new Map<Mastery, number>(MASTERY.map((m) => [m.key, 0]));
              for (const q of qs) c.set(masteryOf(q), c.get(masteryOf(q))! + 1);
              return (
                <li>
                  <span class="msub-name"><i class={`sw seg-s${subjectSlot(ctx, n.subjectId)}`} aria-hidden="true" />{n.label}</span>
                  <span class="segbar" role="img" aria-label={`${n.label}: ${MASTERY.map((m) => `${m.label} ${c.get(m.key)}`).join(", ")}`}>
                    {MASTERY.map((m) => (c.get(m.key) ? <i class={m.cls} style={{ flexGrow: c.get(m.key) }} title={`${m.label}: ${c.get(m.key)}`} /> : null))}
                  </span>
                  <span class="msub-n">{Math.round(((c.get("mastered") ?? 0) / qs.length) * 100)}% <span class="sub">of {qs.length}</span></span>
                </li>
              );
            })}
          </ul>
        </section>

        <section class="dash-card">
          <div class="dash-card-head"><h2 class="dash-h">Accuracy by difficulty</h2><span class="muted small">{PERIOD_LABEL[period]}</span></div>
          <BarRows empty="No graded answers in this period."
            rows={[...[...boot.difficulties].sort((a, b) => a.sort_rank - b.sort_rank).map((x) => ({ code: x.code, label: x.label })), { code: "__none", label: "No label" }]
              .filter((x) => diffAgg.get(x.code)?.n)
              .map((x) => { const a = diffAgg.get(x.code)!; return { key: x.code, label: x.label, value: a.s / a.n / 10, max: 100, text: pctTxt(a.s / a.n / 10), sub: `${a.n} graded · ${fmtSecs(a.secs / Math.max(1, a.att))} avg`, cls: `seg-${difficultyTone(ctx, x.code === "__none" ? null : x.code)}` }; })} />
          <h3 class="dash-sub">When you practise</h3>
          <Bars name="Questions answered by weekday" height={130} points={WEEKDAYS.map((w, i) => ({ x: w, label: w, y: weekday[i] }))} empty="No activity in this period." />
        </section>
      </div>

      <div class="dash-grid two">
        <section class="dash-card">
          <div class="dash-card-head">
            <h2 class="dash-h">Focus next</h2>
            {weakest.length > 0 && <button class="btn small primary" onClick={() => buildOn(weakest.map((w) => w.id))}><Icon name="target" size={13} /> Build a paper on these</button>}
          </div>
          {weakest.length === 0 ? <p class="muted small">Needs at least 3 graded answers on a concept in this period.</p> : (
            <BarRows rows={weakest.map((w) => ({ key: w.id, title: w.path, label: <><span class="cp-path">{w.path.split(" › ").slice(0, -1).join(" › ")}{w.path.includes(" › ") ? " › " : ""}</span><b>{w.path.split(" › ").pop()}</b></>, value: w.acc, max: 100, text: pctTxt(w.acc), sub: `${w.n} graded`, cls: w.acc < 50 ? "seg-st-crit" : w.acc < 75 ? "seg-st-warn" : "seg-st-good" }))} />
          )}
          <div class="review">
            <div>
              <b>{due.length}</b> to review <span class="muted small">— wrong or partly right, not seen for 7+ days</span><br />
              <b>{fading.length}</b> fading <span class="muted small">— right before, but not seen for a long time</span>
            </div>
            <button class="btn small" disabled={!due.length} onClick={buildReview}>Build a review paper</button>
          </div>
        </section>

        <section class="dash-card">
          <div class="dash-card-head"><h2 class="dash-h">Moving concepts</h2><span class="muted small">{N ? `${PERIOD_LABEL[period]} vs the ${N} days before` : "last 30 days vs earlier"}</span></div>
          {!improving.length && !slipping.length ? <p class="muted small">Needs at least 3 graded answers on a concept in both windows.</p> : (
            <div class="movers">
              <div>
                <h3 class="dash-sub good-ink">Improving</h3>
                {improving.length ? <ul>{improving.map((m) => <li><span title={m.path}>{m.path.split(" › ").pop()}</span><span class="num">{pctTxt(m.before)} → <b>{pctTxt(m.now)}</b></span><span class="delta good"><Icon name="up" size={11} />{Math.round(m.delta)}</span></li>)}</ul> : <p class="muted small">None yet.</p>}
              </div>
              <div>
                <h3 class="dash-sub bad-ink">Slipping</h3>
                {slipping.length ? <ul>{slipping.map((m) => <li><span title={m.path}>{m.path.split(" › ").pop()}</span><span class="num">{pctTxt(m.before)} → <b>{pctTxt(m.now)}</b></span><span class="delta bad"><Icon name="dn" size={11} />{Math.abs(Math.round(m.delta))}</span><button class="btn ghost small" onClick={() => buildOn([m.id], m.path.split(" › ").pop())}>Practise</button></li>)}</ul> : <p class="muted small">Nothing slipping.</p>}
              </div>
            </div>
          )}
          {(errAgg.size > 0 || confAgg.size > 0) && (
            <div class="dash-split">
              {errAgg.size > 0 && (
                <div>
                  <h3 class="dash-sub">Mistake types</h3>
                  <BarRows rows={[...errAgg.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ key: code, label: boot.errorTypes.find((e) => e.code === code)?.label ?? code, value: n, max: Math.max(...errAgg.values()), text: String(n), cls: "seg-st-crit" }))} />
                </div>
              )}
              {confAgg.size > 0 && (
                <div>
                  <h3 class="dash-sub">Confidence vs accuracy</h3>
                  <BarRows rows={[1, 2, 3, 4, 5].filter((l) => confAgg.get(l)?.n).map((l) => { const a = confAgg.get(l)!; return { key: String(l), label: `Confidence ${l}`, value: a.s / a.n / 10, max: 100, text: pctTxt(a.s / a.n / 10), sub: `${a.n} answers`, cls: "c-fill" }; })} />
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <section class="dash-card">
        <div class="dash-card-head"><h2 class="dash-h">Subjects</h2><span class="muted small">{PERIOD_LABEL[period]}</span></div>
        <SortTable class="dash-table" initial={{ key: "acc", dir: "asc" }}
          rows={ctx.tree.filter((n) => n.kind === "subject").map((n) => {
            const qs = live.filter((q) => q.subject_id === n.subjectId);
            const a = subjAgg.get(n.subjectId), p = subjPrev.get(n.subjectId);
            return { id: n.subjectId, name: n.label, acc: a?.n ? a.s / a.n / 10 : null, prev: p?.n ? p.s / p.n / 10 : null, n: a?.n ?? 0, total: qs.length, tried: qs.filter((q) => q.attempt_count).length, mastered: qs.filter((q) => masteryOf(q) === "mastered").length };
          }).filter((r) => r.total || r.n)}
          cols={[
            { key: "name", label: "Subject", get: (r) => r.name, render: (r) => <span class="dt-subj"><i class={`sw seg-s${subjectSlot(ctx, r.id)}`} aria-hidden="true" />{r.name}</span> },
            { key: "acc", label: "Accuracy", get: (r) => r.acc, render: (r) => <AccCell v={r.acc} prev={N ? r.prev : null} /> },
            { key: "n", label: "Graded", get: (r) => r.n, first: "desc", class: "end", render: (r) => r.n },
            { key: "cov", label: "Covered", get: (r) => (r.total ? r.tried / r.total : null), first: "desc", render: (r) => <MiniMeter v={r.total ? r.tried / r.total : 0} text={`${r.tried}/${r.total}`} /> },
            { key: "mas", label: "Mastered", get: (r) => (r.total ? r.mastered / r.total : null), first: "desc", render: (r) => <MiniMeter v={r.total ? r.mastered / r.total : 0} text={`${r.mastered}`} good /> },
          ]} />
      </section>

      <section class="dash-card">
        <div class="dash-card-head"><h2 class="dash-h">All concepts</h2><span class="muted small">{PERIOD_LABEL[period]} · weighted by tag weight</span></div>
        {concepts.length === 0 ? <p class="muted small">No graded answers on tagged questions in this period.</p> : (
          <SortTable class="dash-table" initial={{ key: "acc", dir: "asc" }} rows={concepts}
            cols={[
              { key: "path", label: "Concept", get: (c) => c.path, render: (c) => <span><span class="cp-path">{c.path.split(" › ").slice(0, -1).join(" › ")}{c.path.includes(" › ") ? " › " : ""}</span><span class="cp-leaf">{c.path.split(" › ").pop()}</span></span> },
              { key: "acc", label: "Accuracy", get: (c) => c.acc, render: (c) => <AccCell v={c.acc} /> },
              { key: "n", label: "Graded", get: (c) => c.n, first: "desc", class: "end", render: (c) => c.n },
              { key: "trend", label: "Weekly trend", class: "hide-sm", render: (c) => <Spark values={[...(cWeekly.get(c.id) ?? new Map()).entries()].sort().map(([, b]) => (b.w ? b.s / b.w / 1000 : 0))} /> },
              { key: "go", label: "", render: (c) => <button class="btn ghost small" onClick={() => buildOn([c.id], c.path.split(" › ").pop())}>Practise</button> },
            ]} />
        )}
      </section>
    </div>
  );
}

function Kpi(props: { label: string; value: string; sub: string; delta?: ComponentChildren | null; meter?: number }) {
  return (
    <div class="kpi">
      <div class="kpi-label">{props.label}</div>
      <div class="kpi-row"><span class="kpi-value">{props.value}</span>{props.delta}</div>
      {props.meter !== undefined && <div class="kpi-meter" aria-hidden="true"><i style={{ width: `${Math.round(props.meter * 100)}%` }} /></div>}
      <div class="kpi-sub">{props.sub}</div>
    </div>
  );
}

function AccCell(props: { v: number | null; prev?: number | null }) {
  if (props.v === null) return <span class="muted">—</span>;
  const tone = props.v < 50 ? "seg-st-crit" : props.v < 75 ? "seg-st-warn" : "seg-st-good";
  const d = props.prev !== null && props.prev !== undefined ? props.v - props.prev : null;
  return (
    <span class="acc-cell">
      <span class="acc-bar"><i class={tone} style={{ width: `${Math.max(2, props.v)}%` }} /></span>
      <span class="num">{Math.round(props.v)}%</span>
      {d !== null && Math.abs(d) >= 1 && <span class={`delta ${d > 0 ? "good" : "bad"}`}><Icon name={d > 0 ? "up" : "dn"} size={10} />{Math.abs(Math.round(d))}</span>}
    </span>
  );
}

function MiniMeter(props: { v: number; text: string; good?: boolean }) {
  return (
    <span class="acc-cell">
      <span class="acc-bar"><i class={props.good ? "seg-st-good" : "c-fill"} style={{ width: `${Math.round(props.v * 100)}%` }} /></span>
      <span class="num">{props.text}</span>
    </span>
  );
}

function Spark(props: { values: number[] }) {
  const v = props.values.slice(-12);
  if (v.length < 2) return <span class="muted small">—</span>;
  const W = 96, H = 24;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * (W - 4) + 2).toFixed(1)},${(H - 3 - y * (H - 6)).toFixed(1)}`);
  const lastPt = pts[pts.length - 1].split(",");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly accuracy, latest ${Math.round(v[v.length - 1] * 100)}%`}>
      <polyline fill="none" class="spark" points={pts.join(" ")} />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="2.5" class="spark-dot" />
    </svg>
  );
}
