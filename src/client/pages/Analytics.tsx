import { useEffect, useMemo, useState } from "preact/hooks";
import { SortTable } from "../grid";
import { api, localDate } from "../api";
import { descendants } from "../filter";
import { openBuilder, useData } from "../store";
import { conceptPath, ErrorBox, LineChart, names } from "../ui";
import { noteOf, notesFieldId } from "../notes";
import { resultBucket } from "../builder/spec";

interface AData {
  concept: { concept_id: string; local_date: string; graded_count: number; weight_sum: number; score_weight_sum: number }[];
  subject: { subject_id: string; local_date: string; graded_count: number; score_permille_sum: number }[];
  daily: { local_date: string; attempt_count: number; time_seconds: number }[];
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
  if (!d || !boot || !view || !lib) return <p class="muted">Loading…</p>;
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

  return (
    <div class="page">
      <div class="page-head"><h1>Analytics</h1></div>
      <section class="card">
        <div class="stats">
          <div><b>{totalAttempts}</b><span>attempts</span></div>
          <div><b>{attempted}/{lib.length}</b><span>questions tried</span></div>
          <div><b>{view.streak}</b><span>day streak</span></div>
          <div><b>{cells.slice(-7).reduce((s, c) => s + c.n, 0)}</b><span>this week</span></div>
        </div>
        <h3>Daily activity (12 weeks)</h3>
        <div class="heat" role="img" aria-label="Questions solved per day">
          {cells.map((c) => <i title={`${c.date}: ${c.n}`} style={{ opacity: c.n ? 0.25 + 0.75 * (c.n / maxDay) : 1 }} class={c.n ? "on" : ""} />)}
        </div>
      </section>
      <NotesCard />

      {totalAttempts === 0 ? <div class="empty"><p>Grade some questions and your progress appears here.</p></div> : (
        <>
          <section class="card">
            <div class="row wrap">
              <h3 class="grow">Accuracy by subject (weekly)</h3>
              <select value={subjectSel} onChange={(e) => setSubjectSel((e.target as HTMLSelectElement).value)}>
                <option value="">All subjects</option>
                {subjIds.map((id) => <option value={id}>{n.subject.get(id)}</option>)}
              </select>
            </div>
            <LineChart yMax={100} yFmt={(v) => `${Math.round(v)}%`} series={shownSubj.map((id) => ({
              label: n.subject.get(id) ?? id,
              points: [...(view.subjWeekly.get(id) ?? new Map()).entries()].sort().map(([wk, b]) => ({ x: wk, y: b.n ? b.s / b.n / 10 : 0 })),
            }))} />
            <SortTable rows={subjIds.map((id) => ({ id, name: n.subject.get(id) ?? id, acc: view.subjAgg.get(id)!.s / view.subjAgg.get(id)!.n / 10, n: view.subjAgg.get(id)!.n }))}
              cols={[
                { key: "name", label: "Subject", get: (r) => r.name, render: (r) => r.name },
                { key: "acc", label: "Accuracy", get: (r) => r.acc, first: "desc", render: (r) => `${Math.round(r.acc)}%` },
                { key: "n", label: "Graded", get: (r) => r.n, first: "desc", render: (r) => r.n },
              ]} />
          </section>

          <section class="card">
            <div class="row wrap">
              <h3 class="grow">Weakest concepts</h3>
              {weakest.length > 0 && <button class="btn primary" onClick={() => buildOn(weakest.map((w) => w.id))}>Build a paper on these</button>}
            </div>
            {weakest.length === 0 ? <p class="muted small">Needs at least 3 graded answers per concept.</p> : (
              <ol class="pick-list">{weakest.map((w) => <li>{conceptPath(boot, w.id)} — <strong>{Math.round(w.acc * 100)}%</strong> <span class="muted small">({w.n} graded)</span></li>)}</ol>
            )}
          </section>

          <section class="card">
            <h3>All concepts (weighted by concept weight)</h3>
            <SortTable rows={concepts.map((c) => ({ ...c, path: conceptPath(boot, c.id) }))} initial={{ key: "acc", dir: "asc" }}
              cols={[
                { key: "path", label: "Concept", get: (c) => c.path, render: (c) => c.path },
                { key: "acc", label: "Accuracy", get: (c) => c.acc, render: (c) => `${Math.round(c.acc * 100)}%` },
                { key: "n", label: "Graded", get: (c) => c.n, first: "desc", render: (c) => c.n },
                { key: "trend", label: "Trend", class: "hide-sm", render: (c) => <Spark values={[...(view.conceptWeekly.get(c.id) ?? new Map()).entries()].sort().map(([, b]) => (b.w ? b.s / b.w / 1000 : 0))} /> },
                { key: "go", label: "", render: (c) => <button class="btn ghost small" onClick={() => buildOn([c.id])}>Practise</button> },
              ]} />
          </section>
        </>
      )}
    </div>
  );
}

function Spark(props: { values: number[] }) {
  const v = props.values.slice(-12);
  if (v.length < 2) return <span class="muted small">—</span>;
  const W = 90, H = 22;
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * W},${H - 2 - y * (H - 4)}`).join(" ");
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><polyline fill="none" stroke="var(--c1)" stroke-width="2" points={pts} /></svg>;
}

/** "My notes": questions with a practice note, by subject and concept, with the notes themselves. */
function NotesCard() {
  const { boot, lib } = useData();
  const [showAll, setShowAll] = useState(false);
  if (!boot || !lib) return null;
  const fid = notesFieldId(boot);
  const live = lib.filter((q) => !q.archived_at);
  const noted = fid ? live.filter((q) => noteOf(q, fid) !== null) : [];
  const n = names(boot);
  const wrong = live.filter((q) => q.last_result === "incorrect" || q.last_result === "partial");
  const wrongNoted = wrong.filter((q) => noteOf(q, fid) !== null).length;
  const bySubject = new Map<string, number>();
  const byConcept = new Map<string, number>();
  for (const q of noted) {
    bySubject.set(q.subject_id ?? "", (bySubject.get(q.subject_id ?? "") ?? 0) + 1);
    for (const [c] of q.concepts) byConcept.set(c, (byConcept.get(c) ?? 0) + 1);
  }
  const list = [...noted].sort((a, b) => (b.last_attempted_at ?? 0) - (a.last_attempted_at ?? 0));
  const shown = showAll ? list : list.slice(0, 8);
  return (
    <section class="card notes-card">
      <div class="row wrap"><h2 class="grow">My notes</h2>
        {noted.length > 0 && <button class="btn small" onClick={() => openBuilder({ pool: { note: "yes" }, name: "Questions with my notes" })}>Build a paper from these</button>}
        {noted.length > 0 && <a class="btn small ghost" href="#/" onClick={() => { try { const v = JSON.parse(sessionStorage.getItem("library.view") ?? "{}"); sessionStorage.setItem("library.view", JSON.stringify({ def: v?.def?.v === 1 ? v.def : { v: 1, op: "and", groups: [{ op: "and", conds: [] }] }, quick: { ...(v.quick ?? {}), note: "yes" } })); } catch { /* ignore */ } }}>Show in Library</a>}
      </div>
      <div class="stats">
        <div><b>{noted.length}</b><span>questions with a note</span></div>
        <div><b>{live.length ? Math.round((noted.length / live.length) * 100) : 0}%</b><span>of the library</span></div>
        <div><b>{wrongNoted}/{wrong.length}</b><span>wrong last time have a note</span></div>
      </div>
      {noted.length === 0 ? <p class="muted small">No notes yet. Write one under any question while solving a paper.</p> : (
        <>
          <div class="grid2">
            <div>
              <h3>By subject</h3>
              <SortTable rows={[...bySubject.entries()].map(([sid, c]) => ({ name: sid ? n.subject.get(sid) ?? "?" : "No subject", c }))} initial={{ key: "c", dir: "desc" }}
                cols={[{ key: "name", label: "Subject", get: (r) => r.name, render: (r) => r.name }, { key: "c", label: "Notes", get: (r) => r.c, first: "desc", render: (r) => r.c }]} />
            </div>
            <div>
              <h3>By concept</h3>
              <SortTable rows={[...byConcept.entries()].map(([cid, c]) => ({ name: conceptPath(boot, cid) || cid, c }))} initial={{ key: "c", dir: "desc" }}
                cols={[{ key: "name", label: "Concept", get: (r) => r.name, render: (r) => r.name }, { key: "c", label: "Notes", get: (r) => r.c, first: "desc", render: (r) => r.c }]} />
            </div>
          </div>
          <h3>Notes</h3>
          <ul class="note-list">
            {shown.map((q) => (
              <li>
                <a href={`#/q/${q.id}`}><b>Q{q.qno}</b></a>
                <span class="muted small"> · {q.subject_id ? n.subject.get(q.subject_id) : "No subject"} · {resultBucket(q) === "never" ? "not attempted" : `last: ${q.last_result ?? "not graded"}`}</span>
                <p class="note-text">{noteOf(q, fid)}</p>
              </li>
            ))}
          </ul>
          {list.length > 8 && <button class="btn small ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${list.length}`}</button>}
        </>
      )}
    </section>
  );
}
