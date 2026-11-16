// Home: what to do next, and how practice is going, at a glance.
import { useEffect, useState } from "preact/hooks";
import { api, localDate } from "../api";
import { ActivityHeatmap } from "../charts";
import { Icon } from "../builder/controls";
import { descendants } from "../filter";
import { openBuilder, useData } from "../store";
import { conceptPath, ErrorBox, fmtDate, fmtSecs, Loading, Meter, Ring } from "../ui";
import { loadAnalytics, type AData } from "./Analytics";

interface PaperRow {
  id: string; name: string; created_at: number; solutions_mode: string; item_count: number; total_marks: number | null;
  open_session_id: string | null; open_position: number | null; completed_sessions: number;
  last_completed_at: number | null; last_score: number | null; best_score: number | null;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

export function Home() {
  const { boot, lib, error } = useData();
  const [d, setD] = useState<AData | null>(null);
  const [papers, setPapers] = useState<PaperRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadAnalytics(true).then(setD).catch((e) => setErr(e.message));
    api("GET", "/api/papers").then((r) => setPapers(r.papers)).catch((e) => setErr(e.message));
  }, []);
  if (error || err) return <ErrorBox error={error ?? err} />;
  if (!boot || !lib || !d || !papers) return <Loading />;

  const live = lib.filter((q) => !q.archived_at);
  const tried = live.filter((q) => q.attempt_count).length;
  const graded = lib.reduce((a, q) => a + (q.graded_count ?? 0), 0);
  const accuracy = graded ? lib.reduce((a, q) => a + (q.score_permille_sum ?? 0), 0) / graded / 1000 : null;

  const days = new Set(d.daily.map((r) => r.local_date));
  let streak = 0;
  const cur = new Date();
  if (!days.has(localDate(cur))) cur.setDate(cur.getDate() - 1);
  while (days.has(localDate(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const week = d.daily.filter((r) => r.local_date >= localDate(weekAgo));
  const weekCount = week.reduce((a, r) => a + r.attempt_count, 0);
  const weekTime = week.reduce((a, r) => a + r.time_seconds, 0);

  const subj = new Map<string, { n: number; s: number }>();
  for (const r of d.subject) {
    const a = subj.get(r.subject_id) ?? { n: 0, s: 0 };
    a.n += r.graded_count; a.s += r.score_permille_sum;
    subj.set(r.subject_id, a);
  }
  const subjects = boot.subjects.filter((s) => !s.archived_at).map((s, i) => {
    const a = subj.get(s.id);
    const total = live.filter((q) => q.subject_id === s.id).length;
    return { id: s.id, name: s.name, slot: (i % 8) + 1, total, graded: a?.n ?? 0, acc: a?.n ? a.s / a.n / 1000 : null };
  }).filter((s) => s.total > 0 || s.graded > 0);

  const conc = new Map<string, { w: number; s: number; n: number }>();
  for (const r of d.concept) {
    const a = conc.get(r.concept_id) ?? { w: 0, s: 0, n: 0 };
    a.w += r.weight_sum; a.s += r.score_weight_sum; a.n += r.graded_count;
    conc.set(r.concept_id, a);
  }
  const weakest = [...conc.entries()].map(([id, a]) => ({ id, acc: a.w ? a.s / a.w / 1000 : 0, n: a.n }))
    .filter((c) => c.acc < 0.8).sort((a, b) => a.acc - b.acc || b.n - a.n).slice(0, 5);
  const buildOn = (ids: string[]) => openBuilder({ tree: [...descendants(boot.concepts, ids)], favourWeak: true, name: "Weak concepts" });

  const open = papers.find((p) => p.open_session_id);
  const fresh = papers.find((p) => !p.open_session_id && !p.completed_sessions);
  const recent = papers.slice(0, 5);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  return (
    <div class="home">
      <header class="home-hero">
        <div>
          <div class="overline">{today}</div>
          <h1 class="home-h1">{greeting()}</h1>
          <p class="home-sub">
            {graded === 0 ? "Sit your first paper and your progress will build up here."
              : streak > 1 ? <>You are on a <b>{streak}-day streak</b>. {weekCount} question{weekCount === 1 ? "" : "s"} answered this week.</>
              : <>{weekCount} question{weekCount === 1 ? "" : "s"} answered in the last 7 days.</>}
          </p>
        </div>
      </header>

      {live.length === 0 ? (
        <section class="next-card">
          <div class="next-main">
            <div class="overline">Start here</div>
            <h2>Import your first questions</h2>
            <p>Convert any worksheet, PDF or past paper with the AI prompt, then upload the result. It takes a couple of minutes.</p>
          </div>
          <a class="btn primary lg" href="#/import"><Icon name="upload" size={17} /> Import questions</a>
        </section>
      ) : open ? (
        <section class="next-card">
          <div class="next-main">
            <div class="overline">Continue where you left off</div>
            <h2>{open.name}</h2>
            <div class="next-progress">
              <span class="meter t-accent"><i style={{ width: `${(((open.open_position ?? 1) - 1) / Math.max(1, open.item_count)) * 100}%` }} /></span>
              <span class="num">Question {open.open_position} of {open.item_count}</span>
            </div>
          </div>
          <a class="btn primary lg" href={`#/practice/${open.id}`}><Icon name="play" size={15} /> Resume</a>
        </section>
      ) : fresh ? (
        <section class="next-card">
          <div class="next-main">
            <div class="overline">Next up</div>
            <h2>{fresh.name}</h2>
            <p>{fresh.item_count} questions{fresh.total_marks ? ` · ${fresh.total_marks} marks` : ""} · {fresh.solutions_mode === "hidden" ? "test conditions" : "solutions included"}</p>
          </div>
          <div class="next-acts">
            <a class="btn lg" href={`#/papers/${fresh.id}`}>View paper</a>
            <a class="btn primary lg" href={`#/practice/${fresh.id}`}><Icon name="play" size={15} /> Start</a>
          </div>
        </section>
      ) : (
        <section class="next-card">
          <div class="next-main">
            <div class="overline">Ready when you are</div>
            <h2>Build a new paper</h2>
            <p>{live.length.toLocaleString()} questions in the library{weakest.length ? ` — or go straight to your ${weakest.length} weakest concepts.` : "."}</p>
          </div>
          <div class="next-acts">
            {weakest.length > 0 && <button class="btn lg" onClick={() => buildOn(weakest.map((w) => w.id))}>Practise weak concepts</button>}
            <button class="btn primary lg" onClick={() => openBuilder()}><Icon name="plus" size={16} /> Build paper</button>
          </div>
        </section>
      )}

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
          <div class="tile-value">{tried.toLocaleString()}<small> of {live.length.toLocaleString()}</small></div>
          <Meter value={live.length ? tried / live.length : 0} tone="accent" />
        </div>
        <div class="tile">
          <div class="tile-label">Day streak</div>
          <div class="tile-value">{streak}<small> day{streak === 1 ? "" : "s"}</small></div>
          <div class="tile-sub">{streak ? "keep it going today" : "answer one question to start"}</div>
        </div>
        <div class="tile">
          <div class="tile-label">Last 7 days</div>
          <div class="tile-value">{weekCount}<small> question{weekCount === 1 ? "" : "s"}</small></div>
          <div class="tile-sub">{weekTime ? `${fmtSecs(weekTime)} of practice` : "nothing yet this week"}</div>
        </div>
      </div>

      <div class="home-grid">
        <section class="card">
          <div class="card-head"><h2>Activity</h2><span class="muted small">questions answered per day</span></div>
          <ActivityHeatmap daily={d.daily} weeks={18} />
        </section>

        <section class="card">
          <div class="card-head"><h2>Subjects</h2><a class="link-btn" href="#/analytics">All progress</a></div>
          {subjects.length === 0 ? <p class="muted small">Subjects appear here once questions are imported.</p> : (
            <ul class="mastery">
              {subjects.map((s) => (
                <li>
                  <span class="mastery-name"><i class={`sw seg-s${s.slot}`} aria-hidden="true" />{s.name}</span>
                  <span class="mastery-meta">{s.graded ? `${s.graded} graded` : `${s.total} question${s.total === 1 ? "" : "s"} · not started`}</span>
                  <span class="mastery-val num">{s.acc === null ? "—" : `${Math.round(s.acc * 100)}%`}</span>
                  <span class="mastery-bar">{s.acc === null ? <span class="meter" /> : <Meter value={s.acc} />}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Focus areas</h2>
            {weakest.length > 0 && <button class="btn small" onClick={() => buildOn(weakest.map((w) => w.id))}><Icon name="target" size={14} /> Build a paper on these</button>}
          </div>
          {weakest.length === 0 ? <p class="muted small">{graded ? "No weak concepts right now — everything practised is at 80% or better." : "Your weakest concepts show up here after some practice."}</p> : (
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
          <div class="card-head"><h2>Recent papers</h2><a class="link-btn" href="#/papers">All papers</a></div>
          {recent.length === 0 ? <p class="muted small">No papers yet. Build one from the library.</p> : (
            <ul class="recent">
              {recent.map((p) => (
                <li>
                  <a class="recent-main" href={`#/papers/${p.id}`}>
                    <b>{p.name}</b>
                    <small>{p.item_count} questions · {p.open_session_id ? `in progress, question ${p.open_position}` : p.completed_sessions ? `sat ${fmtDate(p.last_completed_at)}` : "not started"}</small>
                  </a>
                  {p.last_score !== null ? <span class="recent-score num">{Math.round(p.last_score / 10)}%</span> : null}
                  <a class={`btn small${p.open_session_id ? " primary" : ""}`} href={`#/practice/${p.id}`}>{p.open_session_id ? "Resume" : p.completed_sessions ? "Sit again" : "Start"}</a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
