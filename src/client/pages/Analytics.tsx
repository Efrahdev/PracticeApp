import { useEffect, useMemo, useState } from "preact/hooks";
import { SortTable } from "../grid";
import { api, localDate } from "../api";
import { descendants } from "../filter";
import { openBuilder, useData } from "../store";
import { conceptPath, ErrorBox, fmtSecs, LineChart, Loading, Meter, names, Ring } from "../ui";
import { ActivityHeatmap, Spark } from "../charts";
import { Icon } from "../builder/controls";

export interface AData {
  concept: { concept_id: string; local_date: string; graded_count: number; weight_sum: number; score_weight_sum: number }[];
  subject: { subject_id: string; local_date: string; graded_count: number; score_permille_sum: number }[];
  daily: { local_date: string; attempt_count: number; time_seconds: number }[];
}

let cache: AData | null = null;
export async function loadAnalytics(force = false): Promise<AData> {
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

const weekOf = (date: string) => {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return localDate(d);
};

export function Analytics() {
  const { boot, lib } = useData();
  const [d, setD] = useState<AData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [subjectSel, setSubjectSel] = useState<string>("");
  useEffect(() => { loadAnalytics(true).then(setD).catch((e) => setErr(e.message)); }, []);

  const view = useMemo(() => {
    if (!d || !boot) return null;
    const conceptAgg = new Map<string, { w: number; s: number; n: number }>();
    const conceptWeekly = new Map<string, Map<string, { w: number; s: number }>>();
    for (const r of d.concept) {
      const a = conceptAgg.get(r.concept_id) ?? { w: 0, s: 0, n: 0 };
      a.w += r.weight_sum; a.s += r.score_weight_sum; a.n += r.graded_count;
      conceptAgg.set(r.concept_id, a);
      const wk = weekOf(r.local_date);
      const m = conceptWeekly.get(r.concept_id) ?? new Map();
      const b = m.get(wk) ?? { w: 0, s: 0 };
      b.w += r.weight_sum; b.s += r.score_weight_sum;
      m.set(wk, b);
      conceptWeekly.set(r.concept_id, m);
    }
    const subjAgg = new Map<string, { n: number; s: number }>();
    const subjWeekly = new Map<string, Map<string, { n: number; s: number }>>();
    for (const r of d.subject) {
      const a = subjAgg.get(r.subject_id) ?? { n: 0, s: 0 };
      a.n += r.graded_count; a.s += r.score_permille_sum;
      subjAgg.set(r.subject_id, a);
      const wk = weekOf(r.local_date);
      const m = subjWeekly.get(r.subject_id) ?? new Map();
      const b = m.get(wk) ?? { n: 0, s: 0 };
      b.n += r.graded_count; b.s += r.score_permille_sum;
      m.set(wk, b);
      subjWeekly.set(r.subject_id, m);
    }
    // streak: consecutive days up to today (or yesterday) with at least one attempt
    const days = new Set(d.daily.map((r) => r.local_date));
    let streak = 0;
    const cur = new Date();
    if (!days.has(localDate(cur))) cur.setDate(cur.getDate() - 1);
    while (days.has(localDate(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
    return { conceptAgg, conceptWeekly, subjAgg, subjWeekly, streak };
  }, [d, boot]);

  if (err) return <ErrorBox error={err} />;
  if (!d || !boot || !view || !lib) return <Loading />;
  const n = names(boot);
  const attempted = lib.filter((q) => q.attempt_count).length;
  const totalAttempts = d.daily.reduce((s, r) => s + r.attempt_count, 0);

  const concepts = [...view.conceptAgg.entries()]
    .map(([id, a]) => ({ id, acc: a.w ? a.s / a.w / 1000 : 0, n: a.n }))
    .sort((a, b) => a.acc - b.acc);
  const weakest = concepts.filter((c) => c.n >= 3).slice(0, 5);

  // Straight into the paper builder with these concepts (and their sub-concepts) ticked.
  const buildOn = (ids: string[]) => openBuilder({ tree: [...descendants(boot.concepts, ids)], favourWeak: true, name: "Weak concepts" });

  const subjIds = [...view.subjAgg.keys()];
  const shownSubj = subjectSel ? [subjectSel] : subjIds.slice(0, 5);

  // Last 12 weeks of daily activity
  const today = new Date();
  const cells: { date: string; n: number }[] = [];
  const byDay = new Map(d.daily.map((r) => [r.local_date, r.attempt_count]));
  for (let i = 83; i >= 0; i--) {
    const x = new Date(today);
    x.setDate(today.getDate() - i);
    const k = localDate(x);
    cells.push({ date: k, n: byDay.get(k) ?? 0 });
  }
  const maxDay = Math.max(1, ...cells.map((c) => c.n));

  const graded = lib.reduce((a, q) => a + (q.graded_count ?? 0), 0);
  const accuracy = graded ? lib.reduce((a, q) => a + (q.score_permille_sum ?? 0), 0) / graded / 1000 : null;
  const live = lib.filter((q) => !q.archived_at).length;
  const weekTime = d.daily.filter((r) => cells.slice(-7).some((c) => c.date === r.local_date)).reduce((a, r) => a + r.time_seconds, 0);
  const slotOf = (id: string) => (boot.subjects.filter((x) => !x.archived_at).findIndex((x) => x.id === id) % 8) + 1;

  return (
    <div class="page">
      <header class="pb-top">
        <div class="pb-top-main">
          <span class="pb-h1">Progress</span>
          <h1 class="lib-h1">How practice is going</h1>
        </div>
      </header>

      <div class="tiles">
        <div class="tile tile-ring">
          <Ring value={accuracy} size={76} stroke={8} />
          <div>
            <div class="tile-label">Accuracy</div>
            <div class="tile-sub">{graded ? `across ${graded.toLocaleString()} graded answer${graded === 1 ? "" : "s"}` : "no graded answers yet"}</div>
          </div>
        </div>
        <div class="tile">
          <div class="tile-label">Questions practised</div>
          <div class="tile-value">{attempted.toLocaleString()}<small> of {live.toLocaleString()}</small></div>
          <Meter value={live ? attempted / live : 0} tone="accent" />
        </div>
        <div class="tile">
          <div class="tile-label">Day streak</div>
          <div class="tile-value">{view.streak}<small> day{view.streak === 1 ? "" : "s"}</small></div>
          <div class="tile-sub">{totalAttempts.toLocaleString()} attempts in all</div>
        </div>
        <div class="tile">
          <div class="tile-label">Last 7 days</div>
          <div class="tile-value">{cells.slice(-7).reduce((s, c) => s + c.n, 0)}<small> questions</small></div>
          <div class="tile-sub">{weekTime ? `${fmtSecs(weekTime)} of practice` : "nothing yet this week"}</div>
        </div>
      </div>

      <section class="card">
        <div class="card-head"><h2>Activity</h2><span class="muted small">questions answered per day</span></div>
        <ActivityHeatmap daily={d.daily} weeks={52} />
      </section>

      {totalAttempts === 0 ? <div class="empty card"><p><b>Nothing to chart yet.</b></p><p>Grade some questions and your progress appears here.</p><a class="btn primary" href="#/papers">Go to papers</a></div> : (
        <>
          <section class="card">
            <div class="card-head">
              <h2>Accuracy by subject</h2>
              <select class="sel-sm" aria-label="Subject shown in the chart" value={subjectSel} onChange={(e) => setSubjectSel((e.target as HTMLSelectElement).value)}>
                <option value="">All subjects</option>
                {subjIds.map((id) => <option value={id}>{n.subject.get(id)}</option>)}
              </select>
            </div>
            <LineChart yMax={100} yFmt={(v) => `${Math.round(v)}%`} series={shownSubj.map((id) => ({
              label: n.subject.get(id) ?? id,
              slot: slotOf(id),
              points: [...(view.subjWeekly.get(id) ?? new Map()).entries()].sort().map(([wk, b]) => ({ x: wk, y: b.n ? b.s / b.n / 10 : 0 })),
            }))} />
            <SortTable rows={subjIds.map((id) => ({ id, name: n.subject.get(id) ?? id, acc: view.subjAgg.get(id)!.s / view.subjAgg.get(id)!.n / 10, n: view.subjAgg.get(id)!.n }))}
              cols={[
                { key: "name", label: "Subject", get: (r) => r.name, render: (r) => <span class="dt-subj"><i class={`sw seg-s${slotOf(r.id)}`} aria-hidden="true" />{r.name}</span> },
                { key: "acc", label: "Accuracy", get: (r) => r.acc, first: "desc", render: (r) => <span class="acc-cell"><b class="num">{Math.round(r.acc)}%</b><Meter value={r.acc / 100} /></span> },
                { key: "n", label: "Graded", get: (r) => r.n, first: "desc", render: (r) => <span class="num">{r.n}</span> },
              ]} />
          </section>

          <section class="card">
            <div class="card-head">
              <h2>Weakest concepts</h2>
              {weakest.length > 0 && <button class="btn primary small" onClick={() => buildOn(weakest.map((w) => w.id))}><Icon name="target" size={14} /> Build a paper on these</button>}
            </div>
            {weakest.length === 0 ? <p class="muted small">Needs at least 3 graded answers per concept.</p> : (
              <ul class="focus">
                {weakest.map((w) => {
                  const path = conceptPath(boot, w.id).split(" › ");
                  return (
                    <li>
                      <div class="focus-name"><b>{path[path.length - 1]}</b><small>{path.slice(0, -1).join(" › ")}</small></div>
                      <div class="focus-meter"><Meter value={w.acc} /><span class="num">{Math.round(w.acc * 100)}%<small> · {w.n} graded</small></span></div>
                      <button class="btn ghost small" onClick={() => buildOn([w.id])}>Practise</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section class="card">
            <div class="card-head"><h2>All concepts</h2><span class="muted small">accuracy weighted by each question's concept weight</span></div>
            <SortTable rows={concepts.map((c) => ({ ...c, path: conceptPath(boot, c.id) }))} initial={{ key: "acc", dir: "asc" }}
              cols={[
                { key: "path", label: "Concept", get: (c) => c.path, render: (c) => { const p = c.path.split(" › "); return <span><span class="cp-path">{p.slice(0, -1).join(" › ")}{p.length > 1 ? " › " : ""}</span><span class="cp-leaf">{p[p.length - 1]}</span></span>; } },
                { key: "acc", label: "Accuracy", get: (c) => c.acc, render: (c) => <span class="acc-cell"><b class="num">{Math.round(c.acc * 100)}%</b><Meter value={c.acc} /></span> },
                { key: "n", label: "Graded", get: (c) => c.n, first: "desc", render: (c) => <span class="num">{c.n}</span> },
                { key: "trend", label: "Trend", class: "hide-sm", render: (c) => <Spark values={[...(view.conceptWeekly.get(c.id) ?? new Map()).entries()].sort().map(([, b]) => (b.w ? b.s / b.w / 1000 : 0))} /> },
                { key: "go", label: "", render: (c) => <button class="btn ghost small" onClick={() => buildOn([c.id])}>Practise</button> },
              ]} />
          </section>
        </>
      )}
    </div>
  );
}
