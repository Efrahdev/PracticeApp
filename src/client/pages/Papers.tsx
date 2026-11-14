import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { useData } from "../store";
import { ErrorBox, fmtDate, fmtDateTime, names, ResultBadge, toast } from "../ui";
import { PaperSummary } from "./Practice";

export function Papers() {
  const [papers, setPapers] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api("GET", "/api/papers").then((r) => setPapers(r.papers)).catch((e) => setErr(e.message)); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!papers) return <p class="muted">Loading…</p>;
  return (
    <div class="page">
      <div class="page-head"><h1>Papers</h1></div>
      {papers.length === 0 ? (
        <div class="empty"><p>No papers yet. Filter the library, then choose “Build paper”.</p><a class="btn primary" href="#/">Go to library</a></div>
      ) : (
        <div class="paper-list">
          {papers.map((p) => (
            <div class="card paper-card">
              <div class="grow">
                <a href={`#/papers/${p.id}`}><strong>{p.name}</strong></a>
                <div class="muted small">{p.item_count} questions · made {fmtDate(p.created_at)} · seed {p.seed}{p.completed_sessions ? ` · done ${p.completed_sessions}×` : ""}</div>
              </div>
              {p.open_session_id
                ? <a class="btn primary" href={`#/practice/${p.id}`}>Resume ({p.open_position}/{p.item_count})</a>
                : <a class="btn" href={`#/practice/${p.id}`}>{p.completed_sessions ? "Sit again" : "Start"}</a>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PaperDetail(props: { id: string }) {
  const { boot } = useData();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api("GET", `/api/papers/${props.id}`).then(setD).catch((e) => setErr(e.message)); }, [props.id]);
  if (err) return <ErrorBox error={err} />;
  if (!d || !boot) return <p class="muted">Loading…</p>;
  const n = names(boot);
  const open = d.sessions.find((s: any) => !s.completed_at);
  const done = d.sessions.filter((s: any) => s.completed_at);
  const settings = JSON.parse(d.paper.sampling_settings || "{}");
  return (
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/papers">← Papers</a>
        <h1>{d.paper.name}</h1>
        <span class="muted small">Frozen {fmtDateTime(d.paper.frozen_at)} · seed {d.paper.seed} · generator v{d.paper.generator_version}
          {settings.favourWrong || settings.favourStale || settings.favourWeak ? " · favoured: " + [settings.favourWrong && "wrong", settings.favourStale && "not recent", settings.favourWeak && "weak concepts"].filter(Boolean).join(", ") : ""}</span>
      </div>
      <div class="row wrap">
        <a class="btn primary" href={`#/practice/${d.paper.id}`}>{open ? `Resume (question ${open.current_position})` : done.length ? "Sit again" : "Start"}</a>
        <button class="btn ghost" onClick={async () => {
          if (!confirm("Hide this paper? Its history stays.")) return;
          await api("DELETE", `/api/papers/${d.paper.id}`);
          toast("Paper hidden");
          location.hash = "#/papers";
        }}>Hide paper</button>
      </div>
      {done.length > 0 && <PaperSummary d={{ ...d, sessions: done }} boot={boot} embedded />}
      <section class="card">
        <h3>Questions (fixed list)</h3>
        <ol class="pick-list">
          {d.items.map((i: any) => {
            const why = i.pick_reason ? JSON.parse(i.pick_reason) : null;
            const last = [...d.attempts].reverse().find((a: any) => a.paper_position === i.position);
            return (
              <li>
                <a href={`#/q/${i.question_id}`}>Q{i.qno}</a>{" "}
                <span class="muted small">{i.difficulty_code ? n.difficulty.get(i.difficulty_code) : ""}</span>{" "}
                {last && <ResultBadge result={last.result} />}
                {why && <span class="small why"> — {why.target}{why.factors?.length ? `; ${why.factors.join(", ")}` : ""}</span>}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
