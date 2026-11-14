// Practice (FR-4). One question at a time; pause and resume; no countdowns or
// time limits anywhere — time is recorded quietly for information only.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, localDate } from "../api";
import { refresh, useData } from "../store";
import type { Boot } from "../types";
import { ErrorBox, fmtSecs, names, pct, QuestionFrame, ResultBadge, toast } from "../ui";

export interface GradeIn { result: "correct" | "incorrect" | "partial"; score_permille?: number; error_type_code?: string | null; confidence?: number | null; note?: string | null }

export function GradeForm(props: { boot: Boot; onSubmit: (g: GradeIn) => Promise<void>; submitLabel?: string; autoResult?: string | null }) {
  const [result, setResult] = useState<GradeIn["result"] | null>(null);
  const [partial, setPartial] = useState(50);
  const [errType, setErrType] = useState("");
  const [conf, setConf] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!result) return;
    setBusy(true);
    setErr(null);
    try {
      await props.onSubmit({ result, score_permille: result === "partial" ? Math.round(partial * 10) : undefined, error_type_code: errType || null, confidence: conf, note: note || null });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div class="grade-form">
      <ErrorBox error={err} />
      <div class="grade-buttons" role="group" aria-label="Grade">
        {(["correct", "partial", "incorrect"] as const).map((r) => (
          <button type="button" class={`gbtn g-${r} ${result === r ? "on" : ""}`} aria-pressed={result === r} onClick={() => setResult(r)}>
            {r === "correct" ? "✓ Correct" : r === "partial" ? "◐ Partly" : "✗ Incorrect"}
          </button>
        ))}
      </div>
      {result === "partial" && (
        <label class="field">Credit: {partial}%
          <input type="range" min="1" max="99" value={partial} onInput={(e) => setPartial(Number((e.target as HTMLInputElement).value))} />
        </label>
      )}
      {result && result !== "correct" && (
        <label class="field">What went wrong? <span class="muted small">(optional)</span>
          <select value={errType} onChange={(e) => setErrType((e.target as HTMLSelectElement).value)}>
            <option value="">—</option>
            {props.boot.errorTypes.map((t) => <option value={t.code}>{t.label}</option>)}
          </select>
        </label>
      )}
      {result && (
        <>
          <div class="field">How sure were you? <span class="muted small">(optional)</span>
            <div class="chips">{[1, 2, 3, 4, 5].map((c) => <button type="button" class={`chip ${conf === c ? "on" : ""}`} aria-pressed={conf === c} onClick={() => setConf(conf === c ? null : c)}>{c}</button>)}</div>
          </div>
          <label class="field">Note <span class="muted small">(optional)</span><input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
        </>
      )}
      <div class="row end"><button class="btn primary" disabled={!result || busy} onClick={submit}>{props.submitLabel ?? "Save grade"}</button></div>
    </div>
  );
}

interface Item {
  position: number;
  question_id: string;
  question_version_id: string;
  html_blob_sha256: string;
  css_sha256: string | null;
  qno: string;
  answer_format: string;
  option_labels: string | null;
  has_key: number;
  concept_ids?: string;
}

/** Quiet stopwatch that pauses while the tab is hidden. */
function useStopwatch(start: number, running: boolean) {
  const base = useRef(start);
  const since = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => {
      if (running && !document.hidden) { if (since.current === null) since.current = Date.now(); }
      else if (since.current !== null) { base.current += (Date.now() - since.current) / 1000; since.current = null; }
    };
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => { document.removeEventListener("visibilitychange", tick); if (since.current !== null) { base.current += (Date.now() - since.current) / 1000; since.current = null; } };
  }, [running]);
  return {
    seconds: () => Math.round(base.current + (since.current !== null ? (Date.now() - since.current) / 1000 : 0)),
    reset: (s = 0) => { base.current = s; since.current = running && !document.hidden ? Date.now() : null; },
  };
}

function AnswerInput(props: { item: Item; value: any; onChange: (v: any) => void; disabled: boolean }) {
  const f = props.item.answer_format;
  const labels: string[] = props.item.option_labels ? JSON.parse(props.item.option_labels) : ["A", "B", "C", "D"];
  if (f === "mcq_single" || f === "mcq_multi") {
    const cur: string[] = props.value ?? [];
    return (
      <div class="chips answer" role="group" aria-label="Your answer">
        {labels.map((l) => (
          <button type="button" disabled={props.disabled} class={`chip big ${cur.includes(l) ? "on" : ""}`} aria-pressed={cur.includes(l)}
            onClick={() => props.onChange(f === "mcq_single" ? [l] : cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l])}>{l}</button>
        ))}
      </div>
    );
  }
  if (f === "numeric") return <input class="answer" type="number" step="any" inputMode="decimal" placeholder="Your answer" disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />;
  if (f === "text") return <textarea class="answer" rows={3} placeholder="Your answer" disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onChange((e.target as HTMLTextAreaElement).value)} />;
  return <p class="muted small">Work it out (on paper is fine), then grade yourself.</p>;
}

function responseOf(item: Item, v: any) {
  const f = item.answer_format;
  if ((f === "mcq_single" || f === "mcq_multi") && Array.isArray(v) && v.length) return { kind: "mcq", options: v };
  if (f === "numeric" && v !== undefined && v !== "" && Number.isFinite(Number(v))) return { kind: "numeric", numeric: Number(v) };
  if (f === "text" && typeof v === "string" && v.trim()) return { kind: "text", text: v };
  return { kind: "none" };
}

export function Practice(props: { paperId?: string; questionId?: string }) {
  const { boot } = useData();
  const [items, setItems] = useState<Item[] | null>(null);
  const [paper, setPaper] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [pos, setPos] = useState(1);
  const [answer, setAnswer] = useState<any>(undefined);
  const [saved, setSaved] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const watch = useStopwatch(0, !saved && !finished && !!items);

  useEffect(() => {
    (async () => {
      try {
        if (props.paperId) {
          const d = await api("GET", `/api/papers/${props.paperId}`);
          const { session: s } = await api("POST", `/api/papers/${props.paperId}/sessions`);
          setPaper(d.paper);
          setItems(d.items);
          setSession(s);
          setPos(s.current_position);
          watch.reset(s.current_elapsed_seconds);
        } else if (props.questionId) {
          const d = await api("GET", `/api/questions/${props.questionId}`);
          const q = d.question;
          setItems([{
            position: 1, question_id: q.id, question_version_id: q.version_id, html_blob_sha256: q.html_blob_sha256,
            css_sha256: d.stylesheets.find((s: any) => s.question_version_id === q.version_id)?.blob_sha256 ?? null,
            qno: q.source_question_number, answer_format: q.answer_format, option_labels: q.option_labels, has_key: d.answerKey ? 1 : 0,
          }]);
          watch.reset(0);
        }
      } catch (e) { setErr((e as Error).message); }
    })();
  }, [props.paperId, props.questionId]);

  // Save place + elapsed time when leaving (pause).
  const pause = async (leave = true) => {
    if (session && !saved && !finished) {
      try { await api("PATCH", `/api/sessions/${session.id}`, { current_position: pos, current_elapsed_seconds: watch.seconds() }); } catch { /* best effort */ }
    }
    if (leave) location.hash = props.paperId ? `#/papers/${props.paperId}` : `#/q/${props.questionId}`;
  };
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && session && !saved && !finished) {
        fetch(`/api/sessions/${session.id}`, {
          method: "PATCH", keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ current_position: pos, current_elapsed_seconds: watch.seconds() }),
        }).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [session, pos, saved, finished]);

  if (err) return <div class="page"><ErrorBox error={err} /><a href="#/papers">← Papers</a></div>;
  if (!items || !boot) return <p class="muted">Loading…</p>;
  if (session?.completed_at || finished) return <Summary paperId={props.paperId} questionId={props.questionId} />;

  const item = items.find((i) => i.position === pos) ?? items[0];
  const resp = responseOf(item, answer);
  const canAuto = !!item.has_key && resp.kind !== "none" && resp.kind !== "text";

  const submit = async (g?: GradeIn) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", "/api/attempts", {
        question_id: item.question_id,
        question_version_id: item.question_version_id,
        session_id: session?.id ?? null,
        paper_position: session ? item.position : null,
        local_date: localDate(),
        time_taken_seconds: watch.seconds(),
        response: resp,
        grade: g,
      });
      setSaved(r);
      refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const next = () => {
    setSaved(null);
    setAnswer(undefined);
    setFixing(false);
    if (!session || pos >= items.length) { setFinished(true); return; }
    setPos(pos + 1);
    watch.reset(0);
  };

  return (
    <div class="page practice">
      <div class="practice-head">
        <button class="btn ghost" onClick={() => pause(true)}>{session ? "Pause & exit" : "← Back"}</button>
        <div class="grow center">
          {paper && <div class="small muted">{paper.name}</div>}
          <strong>Question {item.position} of {items.length}</strong>
          {items.length > 1 && <div class="dots" aria-hidden="true">{items.map((i) => <i class={i.position < pos ? "done" : i.position === pos ? "now" : ""} />)}</div>}
        </div>
        {session && <button class="btn ghost small" onClick={async () => {
          if (!confirm("Finish this paper now? Unanswered questions stay unanswered.")) return;
          await api("PATCH", `/api/sessions/${session.id}`, { complete: true });
          setFinished(true);
        }}>Finish early</button>}
      </div>

      <section class="card flush"><QuestionFrame key={item.question_version_id} htmlSha={item.html_blob_sha256} cssSha={item.css_sha256} minHeight={140} title={`Question ${item.qno}`} /></section>
      <ErrorBox error={err} />

      {!saved ? (
        <section class="card">
          <AnswerInput item={item} value={answer} onChange={setAnswer} disabled={busy} />
          {canAuto ? (
            <div class="row end"><button class="btn primary" disabled={busy} onClick={() => submit()}>Check answer</button></div>
          ) : (
            <GradeForm boot={boot} onSubmit={submit} />
          )}
        </section>
      ) : (
        <section class="card">
          <div class="row wrap">
            <span class="big-result"><ResultBadge result={saved.grade.result} /></span>
            {saved.grade.result === "partial" && <span>{pct(saved.grade.score_permille)}</span>}
            {saved.grade.method === "auto" && <span class="muted small">marked automatically</span>}
            <span class="grow" />
            <button class="btn ghost small" onClick={() => setFixing(!fixing)}>Correct grade</button>
          </div>
          {saved.answer_key && saved.grade.method === "auto" && (
            <p class="small">Answer: {saved.answer_key.mcq_correct ? JSON.parse(saved.answer_key.mcq_correct).join(", ") : saved.answer_key.numeric_value ?? saved.answer_key.text_value}</p>
          )}
          {fixing && (
            <GradeForm boot={boot} submitLabel="Save correction" onSubmit={async (g) => {
              const r = await api("POST", `/api/attempts/${saved.attempt_id}/grades`, g);
              setSaved({ ...saved, grade: { ...saved.grade, result: r.result, score_permille: r.score_permille, method: "manual" } });
              setFixing(false);
              toast("Grade corrected");
              refresh();
            }} />
          )}
          <h3>Solution</h3>
          {!saved.solution ? <p class="muted">No solution saved for this question.</p>
            : saved.solution.body_blob_sha256 ? <QuestionFrame htmlSha={saved.solution.body_blob_sha256} cssSha={item.css_sha256} title="Solution" />
            : <p class="pre">{saved.solution.body_text}</p>}
          <div class="row end"><button class="btn primary" onClick={next}>{session && pos < items.length ? "Next question →" : "Finish"}</button></div>
        </section>
      )}
    </div>
  );
}

function Summary(props: { paperId?: string; questionId?: string }) {
  const { boot } = useData();
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    if (props.paperId) api("GET", `/api/papers/${props.paperId}`).then(setD);
  }, [props.paperId]);
  if (props.questionId) {
    return (
      <div class="page"><section class="card center">
        <h2>Saved</h2>
        <div class="row center"><a class="btn" href={`#/q/${props.questionId}`}>Back to question</a><a class="btn primary" href="#/">Library</a></div>
      </section></div>
    );
  }
  if (!d || !boot) return <p class="muted">Loading…</p>;
  return <PaperSummary d={d} boot={boot} />;
}

export function PaperSummary(props: { d: any; boot: Boot; embedded?: boolean }) {
  const { d, boot } = props;
  const n = names(boot);
  const lastSession = d.sessions[d.sessions.length - 1];
  const atts = d.attempts.filter((a: any) => a.session_id === lastSession?.id);
  const total = atts.reduce((s: number, a: any) => s + (a.score_permille ?? 0), 0);
  const time = atts.reduce((s: number, a: any) => s + a.time_taken_seconds, 0);
  const byConcept = new Map<string, { miss: number; total: number }>();
  for (const a of atts) {
    const item = d.items.find((i: any) => i.position === a.paper_position);
    for (const cid of JSON.parse(item?.concept_ids ?? "[]") as string[]) {
      const c = byConcept.get(cid) ?? { miss: 0, total: 0 };
      c.total++;
      if (a.result !== "correct") c.miss++;
      byConcept.set(cid, c);
    }
  }
  const body = (
      <section class="card">
        {props.embedded && <h3>Last sitting</h3>}
        <div class="stats">
          <div><b>{atts.length ? Math.round(total / atts.length / 10) : 0}%</b><span>score</span></div>
          <div><b>{atts.length}/{d.items.length}</b><span>answered</span></div>
          <div><b>{fmtSecs(time)}</b><span>time</span></div>
          <div><b>{atts.filter((a: any) => a.result === "correct").length}</b><span>correct</span></div>
        </div>
        <h3>Mistakes by concept</h3>
        {byConcept.size === 0 ? <p class="muted small">No concept tags on these questions.</p> : (
          <table class="table">
            <thead><tr><th>Concept</th><th>Missed</th><th>Of</th></tr></thead>
            <tbody>{[...byConcept.entries()].sort((a, b) => b[1].miss - a[1].miss).map(([cid, c]) => (
              <tr><td>{n.concept.get(cid) ?? cid}</td><td>{c.miss}</td><td>{c.total}</td></tr>
            ))}</tbody>
          </table>
        )}
        <h3>Questions</h3>
        <ol class="pick-list">
          {d.items.map((i: any) => {
            const a = atts.find((x: any) => x.paper_position === i.position);
            return <li><a href={`#/q/${i.question_id}`}>Q{i.qno}</a> <ResultBadge result={a?.result} /> <span class="muted small">{a ? fmtSecs(a.time_taken_seconds) : "skipped"}</span></li>;
          })}
        </ol>
        {!props.embedded && <div class="row end"><a class="btn" href={`#/papers/${d.paper.id}`}>Paper details</a><a class="btn primary" href="#/analytics">See analytics</a></div>}
      </section>
  );
  if (props.embedded) return body;
  return (
    <div class="page">
      <div class="page-head"><a class="back" href="#/papers">← Papers</a><h1>{d.paper.name} — summary</h1></div>
      {body}
    </div>
  );
}
