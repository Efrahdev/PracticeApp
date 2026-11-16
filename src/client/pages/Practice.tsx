// Practice (FR-4). One question at a time; pause and resume; no countdowns or
// time limits anywhere — time is recorded quietly for information only.
import { useEffect, useRef, useState } from "preact/hooks";
import { SortTable } from "../grid";
import { api, localDate } from "../api";
import { dataSnapshot, refresh, useData } from "../store";
import type { Boot } from "../types";
import { askConfirm, ErrorBox, fmtSecs, names, pct, ResultBadge, toast } from "../ui";
import { loadStored, QuestionView, SolutionView } from "../views";
import { parseNumberish } from "../../shared/qpack/numbers";
import type { StoredQuestion } from "../../shared/qpack/types";

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
  content_format: string | null;
  css_sha256: string | null;
  qno: string;
  answer_format: string;
  option_labels: string | null;
  marks: number | null;
  has_key: number;
  has_solution: number;
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
  if (f === "numeric") {
    const parsed = typeof props.value === "string" && props.value.trim() ? parseNumberish(props.value) : null;
    return (
      <div class="answer">
        <input type="text" inputMode="decimal" placeholder="Your answer — 0.625, 5/8 or 1 1/2" disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />
        {typeof props.value === "string" && props.value.trim() && !parsed && <p class="small warn-text">That isn't a number yet.</p>}
      </div>
    );
  }
  if (f === "text") return <textarea class="answer" rows={3} placeholder="Your answer" disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onChange((e.target as HTMLTextAreaElement).value)} />;
  return <p class="muted small">Work it out (on paper is fine), then grade yourself.</p>;
}

function responseOf(item: Item, v: any) {
  const f = item.answer_format;
  if ((f === "mcq_single" || f === "mcq_multi") && Array.isArray(v) && v.length) return { kind: "mcq", options: v };
  if (f === "numeric" && typeof v === "string" && parseNumberish(v)) return { kind: "numeric", numeric: parseNumberish(v)!.value };
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
  const [solOpen, setSolOpen] = useState(false);
  const [stored, setStored] = useState<StoredQuestion | null>(null);
  const watch = useStopwatch(0, !saved && !finished && !!items);
  const current = items ? items.find((i) => i.position === pos) ?? items[0] : null;
  useEffect(() => {
    setStored(null);
    if (current?.content_format === "qpack_v1") loadStored(current.html_blob_sha256).then(setStored).catch(() => {});
  }, [current?.question_version_id]);

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
            position: 1, question_id: q.id, question_version_id: q.version_id, html_blob_sha256: q.html_blob_sha256, content_format: q.content_format,
            css_sha256: d.stylesheets.find((s: any) => s.question_version_id === q.version_id)?.blob_sha256 ?? null,
            qno: q.source_question_number, answer_format: q.answer_format, option_labels: q.option_labels, marks: q.marks,
            has_key: d.answerKey && d.answerKey.origin !== "suggestion" ? 1 : 0, has_solution: d.solution ? 1 : 0,
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

  const item = current!;
  const resp = responseOf(item, answer);
  const canAuto = !!item.has_key && resp.kind !== "none" && resp.kind !== "text";
  // FR: a paper can include or leave out solutions; single questions always have them.
  const solutionsAllowed = !paper || paper.solutions_mode !== "hidden";
  const parts = stored?.parts ?? [];

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
    setSolOpen(false);
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
          if (!(await askConfirm({ title: "Finish this paper now?", message: "Unanswered questions stay unanswered.", confirmLabel: "Finish" }))) return;
          await api("PATCH", `/api/sessions/${session.id}`, { complete: true });
          setFinished(true);
        }}>Finish early</button>}
      </div>

      <section class="card flush">
        <QuestionView key={item.question_version_id} v={{ content_format: item.content_format, blob_sha256: item.html_blob_sha256, css_sha256: item.css_sha256 }}
          opts={{ showMarks: true, marks: item.marks, showHints: true }} minHeight={120} title={`Question ${item.qno}`} />
      </section>
      <NoteField key={item.question_id} questionId={item.question_id} />
      <ErrorBox error={err} />
      {solutionsAllowed && item.has_solution ? (
        <div class="row">
          <button class="btn ghost small" onClick={() => setSolOpen(!solOpen)}>{solOpen ? "Hide solution" : "Show solution"}</button>
          {!saved && !solOpen && <span class="small muted">(you can check it any time)</span>}
        </div>
      ) : null}
      {solutionsAllowed && solOpen && <VersionSolution versionId={item.question_version_id} />}

      {!saved ? (
        <section class="card">
          <AnswerInput item={item} value={answer} onChange={setAnswer} disabled={busy} />
          {canAuto ? (
            <div class="row end"><button class="btn primary" disabled={busy} onClick={() => submit()}>Check answer</button></div>
          ) : parts.length > 1 ? (
            <PartMarker boot={boot} parts={parts} onSubmit={submit} />
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
          {saved.answer_key && (saved.grade.method === "auto" || solutionsAllowed) && (
            <p class="small">{saved.answer_key.origin === "suggestion" ? "AI-suggested answer (unverified)" : "Answer"}: {saved.answer_key.mcq_correct ? JSON.parse(saved.answer_key.mcq_correct).join(", ") : saved.answer_key.numeric_value ?? saved.answer_key.text_value}</p>
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
          {!solutionsAllowed ? <p class="small muted">Solutions are not included in this paper. You can open them later from each question's page.</p>
            : !saved.solution ? <p class="small muted">No solution saved for this question.</p>
            : !solOpen ? <button class="btn small" onClick={() => setSolOpen(true)}>Show solution</button> : null}
          <div class="row end"><button class="btn primary" onClick={next}>{session && pos < items.length ? "Next question →" : "Finish"}</button></div>
        </section>
      )}
    </div>
  );
}

/**
 * Free-form note for the question being solved. Always visible; saves by itself (shortly after typing stops, on leaving
 * the box, and when moving to another question). Stored as the question's value of the custom text field "Practice notes", so it
 * can be filtered on under Advanced conditions → Custom field. The field is created the first time a note is saved.
 */
export const NOTES_FIELD = "Practice notes";

function NoteField(props: { questionId: string }) {
  const { boot, lib } = useData();
  const field = boot?.fields.find((f) => f.name.toLowerCase() === NOTES_FIELD.toLowerCase() && f.data_type === "text" && !f.archived_at) ?? null;
  const q = lib?.find((x) => x.id === props.questionId) ?? null;
  const initial = field && q ? String(q.fields?.[field.id] ?? "") : "";
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savedRef = useRef(initial);
  const textRef = useRef(initial);
  const timer = useRef<number | null>(null);
  const fieldRef = useRef(field); fieldRef.current = field; // latest values for saves started by an old render
  const qRef = useRef(q); qRef.current = q;
  // the library may arrive after the question: take its value if the user has not typed yet
  useEffect(() => {
    if (textRef.current === savedRef.current && initial !== savedRef.current) {
      savedRef.current = initial; textRef.current = initial; setText(initial);
    }
  }, [initial]);

  const save = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const value = textRef.current;
    if (value === savedRef.current) return;
    setState("saving");
    try {
      let fid = fieldRef.current?.id ?? null;
      const q = qRef.current;
      let created = false;
      if (!fid) {
        created = true;
        try {
          fid = (await api<{ id: string }>("POST", "/api/fields", { name: NOTES_FIELD, data_type: "text", is_filterable: true })).id;
        } catch {
          await refresh(); // created meanwhile (or exists under another case): look it up again
          const { boot: b } = dataSnapshot();
          fid = b?.fields.find((f) => f.name.toLowerCase() === NOTES_FIELD.toLowerCase() && f.data_type === "text" && !f.archived_at)?.id ?? null;
          if (!fid) throw new Error("Could not create the Practice notes field.");
        }
      }
      await api("PATCH", `/api/questions/${props.questionId}`, { field_values: { [fid]: value.trim() ? value : null } });
      savedRef.current = value;
      if (q) { if (value.trim()) q.fields = { ...q.fields, [fid]: value }; else { const { [fid]: _, ...rest } = q.fields ?? {}; q.fields = rest; } }
      setState(textRef.current === value ? "saved" : "idle");
      if (created) refresh(); // so the new "Practice notes" field (and this note) show up in the filters
    } catch {
      setState("error");
    }
  };
  // flush when leaving this question
  useEffect(() => () => { if (textRef.current !== savedRef.current) void save(); }, []);

  return (
    <section class="card note-card">
      <label class="field note-field">
        <span class="note-head"><b>Note</b>
          <span class={`small ${state === "error" ? "warn-text" : "muted"}`} aria-live="polite">
            {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved — check your connection" : "Saved with this question"}
          </span>
        </span>
        <textarea rows={3} value={text} placeholder="Anything you want to remember about this question"
          onInput={(e) => {
            const v = (e.target as HTMLTextAreaElement).value;
            textRef.current = v; setText(v); setState("idle");
            if (timer.current) clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void save(), 1200);
          }}
          onBlur={() => void save()} />
      </label>
    </section>
  );
}

/** Solution of one exact version, fetched only when asked for. */
function VersionSolution(props: { versionId: string }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api("GET", `/api/versions/${props.versionId}/solution`).then(setD).catch((e) => setErr(e.message));
  }, [props.versionId]);
  if (err) return <ErrorBox error={err} />;
  if (!d) return <p class="muted small">Loading solution…</p>;
  if (!d.solution) return <p class="muted small">No solution saved for this question.</p>;
  return (
    <section class="card">
      <h3>Solution {d.solution.origin === "suggestion" && <span class="badge r-partial">AI-written · unverified</span>}</h3>
      <SolutionView s={d.solution} cssSha={d.css_sha256} />
    </section>
  );
}

/** Multi-part questions: tick the parts you got right; the score follows the marks. */
function PartMarker(props: { boot: Boot; parts: StoredQuestion["parts"]; onSubmit: (g: GradeIn) => Promise<void> }) {
  const [got, setGot] = useState<Record<string, "yes" | "half" | "no">>({});
  const [overall, setOverall] = useState(false);
  const [busy, setBusy] = useState(false);
  if (overall) return <><GradeForm boot={props.boot} onSubmit={props.onSubmit} /><button class="btn ghost small" onClick={() => setOverall(false)}>Mark part by part instead</button></>;
  const weight = (m: number | null) => (m === null || m === undefined ? 1 : m);
  const total = props.parts.reduce((s, p) => s + weight(p.marks), 0) || 1;
  const earned = props.parts.reduce((s, p) => s + (got[p.label] === "yes" ? weight(p.marks) : got[p.label] === "half" ? weight(p.marks) / 2 : 0), 0);
  const all = props.parts.every((p) => got[p.label]);
  const permille = Math.round((earned / total) * 1000);
  const result: GradeIn["result"] = permille >= 1000 ? "correct" : permille <= 0 ? "incorrect" : "partial";
  return (
    <div class="grade-form">
      <p class="small muted">Mark each part:</p>
      {props.parts.map((p) => (
        <div class="row part-mark">
          <strong class="w5">({p.label})</strong>
          <span class="muted small grow">{p.marks !== null && p.marks !== undefined ? `${p.marks} mark${p.marks === 1 ? "" : "s"}` : ""}</span>
          {(["yes", "half", "no"] as const).map((v) => (
            <button type="button" class={`chip ${got[p.label] === v ? "on" : ""}`} aria-pressed={got[p.label] === v}
              onClick={() => setGot({ ...got, [p.label]: v })}>{v === "yes" ? "✓" : v === "half" ? "½" : "✗"}</button>
          ))}
        </div>
      ))}
      <div class="row wrap end">
        <span class="small">{all ? `Score: ${Math.round(earned * 100) / 100} / ${total} (${Math.round(permille / 10)}%)` : "Mark every part"}</span>
        <button class="btn ghost small" onClick={() => setOverall(true)}>Mark overall instead</button>
        <button class="btn primary" disabled={!all || busy} onClick={async () => {
          setBusy(true);
          try { await props.onSubmit({ result, score_permille: result === "partial" ? Math.min(999, Math.max(1, permille)) : undefined }); } finally { setBusy(false); }
        }}>Save grade</button>
      </div>
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
          <SortTable rows={[...byConcept.entries()].map(([cid, c]) => ({ name: n.concept.get(cid) ?? cid, miss: c.miss, total: c.total }))} initial={{ key: "miss", dir: "desc" }}
            cols={[
              { key: "name", label: "Concept", get: (r) => r.name, render: (r) => r.name },
              { key: "miss", label: "Missed", get: (r) => r.miss, first: "desc", render: (r) => r.miss },
              { key: "total", label: "Of", get: (r) => r.total, first: "desc", render: (r) => r.total },
            ]} />
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
