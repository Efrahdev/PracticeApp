import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { openBuilder, useData } from "../store";
import type { LibQ } from "../types";
import { ErrorBox, fmtDate, fmtDateTime, ResultBadge, toast } from "../ui";
import { describeBlueprint } from "../builder/describe";
import { PaperTable, type TableRow } from "../builder/PaperTable";
import { makeCtx } from "../builder/pool";
import { normaliseBlueprint } from "../builder/spec";
import { PaperSummary } from "./Practice";
import { openPrint, type PrintSolutions } from "../print";

export function Papers() {
  const [papers, setPapers] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api("GET", "/api/papers").then((r) => setPapers(r.papers)).catch((e) => setErr(e.message)); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!papers) return <p class="muted">Loading…</p>;
  return (
    <div class="page">
      <div class="page-head">
        <h1>Papers</h1>
        <span class="grow" />
        <button class="btn primary" onClick={() => openBuilder()}>New paper</button>
      </div>
      {papers.length === 0 ? (
        <div class="empty"><p>No papers yet. Build one from the whole library, or filter the library first and choose “Build paper”.</p><button class="btn primary" onClick={() => openBuilder()}>Build a paper</button></div>
      ) : (
        <div class="paper-list">
          {papers.map((p) => (
            <div class="card paper-card">
              <div class="grow">
                <a href={`#/papers/${p.id}`}><strong>{p.name}</strong></a>
                <div class="muted small">{p.item_count} questions · made {fmtDate(p.created_at)} · {p.solutions_mode === "hidden" ? "no solutions" : "with solutions"}{p.completed_sessions ? ` · done ${p.completed_sessions}×` : ""}</div>
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

/** A paper item as a library row, for questions the library list no longer has. */
function itemAsLibQ(i: any): LibQ {
  return {
    id: i.question_id, subject_id: i.subject_id, difficulty_code: i.difficulty_code, answer_format: i.answer_format, created_at: 0, archived_at: null,
    marks: i.marks, content_format: i.content_format, has_solution: i.has_solution ? 1 : null, fields: {}, batches: [],
    version_id: i.question_version_id, version_no: i.version_no ?? 1, qno: i.qno, plain_text: i.plain_text, file_name: "",
    concepts: (i.concept_ids ? JSON.parse(i.concept_ids) : []).map((c: string) => [c, 1]), has_key: i.has_key ? 1 : 0,
    attempt_count: null, graded_count: null, correct_count: null, score_permille_sum: null, total_time_seconds: null,
    last_attempted_at: null, last_time_seconds: null, last_result: null, personal_difficulty_permille: null, familiarity_permille: null,
  };
}

export function PaperDetail(props: { id: string }) {
  const { boot, lib } = useData();
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [printSol, setPrintSol] = useState<PrintSolutions>("end");
  const [printing, setPrinting] = useState(false);
  useEffect(() => { api("GET", `/api/papers/${props.id}`).then(setD).catch((e) => setErr(e.message)); }, [props.id]);
  if (err) return <ErrorBox error={err} />;
  if (!d || !boot || !lib || !ctx) return <p class="muted">Loading…</p>;
  const open = d.sessions.find((s: any) => !s.completed_at);
  const done = d.sessions.filter((s: any) => s.completed_at);
  const settings = JSON.parse(d.paper.sampling_settings || "{}");
  const rules = settings && settings.v === 2 ? describeBlueprint(normaliseBlueprint(settings), boot, ctx, lib) : null;
  const byId = new Map(lib.map((q) => [q.id, q]));
  const rows: TableRow[] = d.items.map((i: any) => {
    const why = i.pick_reason ? JSON.parse(i.pick_reason) : null;
    const last = [...d.attempts].reverse().find((a: any) => a.paper_position === i.position);
    const live = byId.get(i.question_id);
    return {
      q: live ? { ...live, marks: i.marks ?? live.marks } : itemAsLibQ(i),
      qno: i.qno,
      text: i.plain_text,
      versionNo: i.version_no ?? 1,
      why: why ? { pinned: !!why.pinned, fills: Array.isArray(why.fills) ? why.fills : [], factors: Array.isArray(why.factors) ? why.factors : [], over: Array.isArray(why.over) ? why.over : [], target: why.target } : null,
      version: { content_format: i.content_format, blob_sha256: i.html_blob_sha256, css_sha256: i.css_sha256 },
      extra: last ? <ResultBadge result={last.result} /> : <span class="muted">Not yet</span>,
    };
  });
  return (
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/papers">← Papers</a>
        <h1>{d.paper.name}</h1>
        <span class={`badge ${d.paper.solutions_mode === "hidden" ? "muted" : "ok"}`}>{d.paper.solutions_mode === "hidden" ? "No solutions" : "Solutions included"}</span>
        <span class="muted small">Frozen {fmtDateTime(d.paper.frozen_at)} · seed {d.paper.seed} · generator v{d.paper.generator_version}
          {settings.favourWrong || settings.favourStale || settings.favourWeak ? " · favoured: " + [settings.favourWrong && "wrong", settings.favourStale && "not recent", settings.favourWeak && "weak concepts"].filter(Boolean).join(", ") : ""}</span>
      </div>
      <div class="row wrap">
        <a class="btn primary" href={`#/practice/${d.paper.id}`}>{open ? `Resume (question ${open.current_position})` : done.length ? "Sit again" : "Start"}</a>
        {d.paper.solutions_mode !== "hidden" && (
          <select aria-label="Solutions in the printed copy" value={printSol} onChange={(e) => setPrintSol((e.target as HTMLSelectElement).value as PrintSolutions)}>
            <option value="end">Print: solutions at the end</option>
            <option value="after">Print: solution after each question</option>
            <option value="none">Print: questions only</option>
          </select>
        )}
        <button class="btn" disabled={printing} onClick={async () => {
          setPrinting(true);
          try { await openPrint(d, d.paper.solutions_mode === "hidden" ? "none" : printSol); }
          catch (e) { toast((e as Error).message, "error"); }
          finally { setPrinting(false); }
        }}>{printing ? "Preparing…" : "Print / PDF"}</button>
        <button class="btn ghost" onClick={async () => {
          if (!confirm("Hide this paper? Its history stays.")) return;
          await api("DELETE", `/api/papers/${d.paper.id}`);
          toast("Paper hidden");
          location.hash = "#/papers";
        }}>Hide paper</button>
      </div>
      {done.length > 0 && <PaperSummary d={{ ...d, sessions: done }} boot={boot} embedded />}
      {rules && (
        <details class="card rules-card">
          <summary><b>How this paper was built</b> <span class="muted small">— the rules saved with it</span></summary>
          <dl class="rules-dl">
            {rules.map((r) => <><dt>{r.label}</dt><dd>{r.value}</dd></>)}
          </dl>
        </details>
      )}
      <PaperTable rows={rows} ctx={ctx} storageKey="paper.columns" extraLabel="In this paper"
        title={<><h2 class="dt-h">Questions (fixed list)</h2><span class="dt-count">{rows.length}</span></>} />
    </div>
  );
}
