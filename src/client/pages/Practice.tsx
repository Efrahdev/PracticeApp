// Practice (FR-4). One question at a time; pause and resume; no countdowns or
// time limits anywhere — time is recorded quietly for information only.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, localDate } from "../api";
import { refresh, useData } from "../store";
import type { Boot } from "../types";
import { conceptPath, ErrorBox, fmtDate, fmtSecs, pct, RESULT_TEXT, ResultBadge, Ring, toast, Loading } from "../ui";
import { loadStored, QuestionView, SolutionView, type Choice } from "../views";
import { Icon } from "../builder/controls";
import { parseNumberish } from "../../shared/qpack/numbers";
import type { StoredQuestion } from "../../shared/qpack/types";

export interface GradeIn { result: "correct" | "incorrect" | "partial"; score_permille?: number; error_type_code?: string | null; confidence?: number | null; note?: string | null }

const GRADES = [
  { r: "correct", label: "Correct", icon: "check" },
  { r: "partial", label: "Partly", icon: "half" },
  { r: "incorrect", label: "Incorrect", icon: "x" },
] as const;

export function GradeForm(props: { boot: Boot; onSubmit: (g: GradeIn) => Promise<void>; submitLabel?: string; autoResult?: string | null; title?: string }) {
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
      <div class="grade-title">{props.title ?? "How did it go?"}</div>
      <div class="grade-buttons" role="group" aria-label="Grade">
        {GRADES.map((g) => (
          <button type="button" class={`gbtn g-${g.r} ${result === g.r ? "on" : ""}`} aria-pressed={result === g.r} onClick={() => setResult(g.r)}>
            <span class="gbtn-ic"><Icon name={g.icon} size={16} /></span>{g.label}
          </button>
        ))}
      </div>
      {result === "partial" && (
        <label class="field credit">How much credit? <b>{partial}%</b>
          <input type="range" min="1" max="99" value={partial} onInput={(e) => setPartial(Number((e.target as HTMLInputElement).value))} />
        </label>
      )}
      {result && (
        <details class="grade-more">
          <summary>Add details <span class="muted">— what went wrong, how sure you were, a note (optional)</span></summary>
          <div class="grade-more-body">
            {result !== "correct" && (
              <label class="field">What went wrong?
                <select value={errType} onChange={(e) => setErrType((e.target as HTMLSelectElement).value)}>
                  <option value="">—</option>
                  {props.boot.errorTypes.map((t) => <option value={t.code}>{t.label}</option>)}
                </select>
              </label>
            )}
            <div class="field">How sure were you?
              <div class="chips">{[1, 2, 3, 4, 5].map((c) => <button type="button" class={`chip ${conf === c ? "on" : ""}`} aria-pressed={conf === c} onClick={() => setConf(conf === c ? null : c)}>{c}</button>)}</div>
            </div>
            <label class="field wide">Note<input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
          </div>
        </details>
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
  subject_id?: string | null;
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

const isMcq = (f: string) => f === "mcq_single" || f === "mcq_multi";
const optionLabels = (item: Item): string[] => (item.option_labels ? JSON.parse(item.option_labels) : ["A", "B", "C", "D"]);

function AnswerInput(props: { item: Item; value: any; onChange: (v: any) => void; disabled: boolean; inFrame: boolean | null }) {
  const f = props.item.answer_format;
  if (isMcq(f)) {
    const cur: string[] = props.value ?? [];
    if (props.inFrame === null) return <p class="px-prompt muted">&nbsp;</p>;
    if (props.inFrame) {
      return (
        <p class="px-prompt" aria-live="polite">
          {cur.length ? <>Your answer <span class="px-picked">{[...cur].sort().map((l) => <b>{l}</b>)}</span></> : f === "mcq_single" ? "Choose one option above" : "Choose every option that applies"}
        </p>
      );
    }
    // The options are not separate elements in this question (imported HTML): choose by letter.
    return (
      <div class="chips answer" role="group" aria-label="Your answer">
        {optionLabels(props.item).map((l) => (
          <button type="button" disabled={props.disabled} class={`chip big ${cur.includes(l) ? "on" : ""}`} aria-pressed={cur.includes(l)}
            onClick={() => props.onChange(f === "mcq_single" ? [l] : cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l])}>{l}</button>
        ))}
      </div>
    );
  }
  if (f === "numeric") {
    const parsed = typeof props.value === "string" && props.value.trim() ? parseNumberish(props.value) : null;
    return (
      <label class="answer answer-num">
        <span class="answer-label">Your answer</span>
        <input type="text" inputMode="decimal" autocomplete="off" placeholder="0.625, 5/8 or 1 1/2" disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />
        {typeof props.value === "string" && props.value.trim() && !parsed && <span class="small warn-text">That isn't a number yet.</span>}
      </label>
    );
  }
  if (f === "text") {
    return (
      <label class="answer answer-text">
        <span class="answer-label">Your answer</span>
        <textarea rows={3} placeholder="Write your answer here" disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onChange((e.target as HTMLTextAreaElement).value)} />
      </label>
    );
  }
  return <p class="px-prompt">Work it out — on paper is fine — then mark yourself.</p>;
}

function responseOf(item: Item, v: any) {
  const f = item.answer_format;
  if ((f === "mcq_single" || f === "mcq_multi") && Array.isArray(v) && v.length) return { kind: "mcq", options: v };
  if (f === "numeric" && typeof v === "string" && parseNumberish(v)) return { kind: "numeric", numeric: parseNumberish(v)!.value };
  if (f === "text" && typeof v === "string" && v.trim()) return { kind: "text", text: v };
  return { kind: "none" };
}

const FORMAT_HINT: Record<string, string> = {
  mcq_single: "Choose one", mcq_multi: "Choose all that apply", numeric: "Number answer", text: "Written answer", none: "Work it out",
};
const VERDICT: Record<string, string> = { correct: "Correct", partial: "Partly right", incorrect: "Not quite" };

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
  const [selfMark, setSelfMark] = useState(false);
  const [inFrame, setInFrame] = useState<boolean | null>(null);
  const [results, setResults] = useState<Record<number, string>>({});
  const [stored, setStored] = useState<StoredQuestion | null>(null);
  const watch = useStopwatch(0, !saved && !finished && !!items);
  const current = items ? items.find((i) => i.position === pos) ?? items[0] : null;
  useEffect(() => {
    setStored(null);
    setInFrame(null);
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
          const done: Record<number, string> = {};
          for (const a of d.attempts) if (a.session_id === s.id && a.paper_position) done[a.paper_position] = a.result ?? "ungraded";
          setResults(done);
          watch.reset(s.current_elapsed_seconds);
        } else if (props.questionId) {
          const d = await api("GET", `/api/questions/${props.questionId}`);
          const q = d.question;
          setItems([{
            position: 1, question_id: q.id, question_version_id: q.version_id, html_blob_sha256: q.html_blob_sha256, content_format: q.content_format,
            css_sha256: d.stylesheets.find((s: any) => s.question_version_id === q.version_id)?.blob_sha256 ?? null,
            qno: q.source_question_number, answer_format: q.answer_format, option_labels: q.option_labels, marks: q.marks, subject_id: q.subject_id,
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

  // Keyboard: letters (or 1–9) choose an option, Enter checks the answer or moves on.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const f = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  if (err && !items) return <div class="page"><ErrorBox error={err} /><a href="#/papers">← Papers</a></div>;
  if (!items || !boot) return <div class="px"><div class="sheet px-sheet"><div class="frame-loading" style={{ height: "280px" }}><span class="skel w70" /><span class="skel w90" /><span class="skel w50" /></div></div></div>;
  if (session?.completed_at || finished) return <Summary paperId={props.paperId} questionId={props.questionId} />;

  const item = current!;
  const f = item.answer_format;
  const resp = responseOf(item, answer);
  // Questions with a verified key and a typed/tapped answer are marked by the app.
  const autoable = !!item.has_key && (isMcq(f) || f === "numeric");
  const canAuto = autoable && resp.kind !== "none";
  // FR: a paper can include or leave out solutions; single questions always have them.
  const solutionsAllowed = !paper || paper.solutions_mode !== "hidden";
  const parts = stored?.parts ?? [];
  const subject = item.subject_id ? boot.subjects.find((x) => x.id === item.subject_id) : null;
  const subjectSlot = item.subject_id ? (boot.subjects.filter((x) => !x.archived_at).findIndex((x) => x.id === item.subject_id) % 8) + 1 : 0;

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
      setResults((x) => ({ ...x, [item.position]: r.grade.result }));
      refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const next = () => {
    setSaved(null);
    setAnswer(undefined);
    setFixing(false);
    setSolOpen(false);
    setSelfMark(false);
    if (!session || pos >= items.length) { setFinished(true); return; }
    setPos(pos + 1);
    watch.reset(0);
    window.scrollTo(0, 0);
  };

  const mcq = isMcq(f);
  const keyShown = saved?.answer_key && (saved.grade.method === "auto" || solutionsAllowed) ? saved.answer_key : null;
  const choice: Choice | undefined = mcq ? {
    mode: f === "mcq_single" ? "single" : "multi",
    value: Array.isArray(answer) ? answer : [],
    onChange: setAnswer,
    disabled: busy,
    reveal: saved ? { correct: keyShown?.mcq_correct ? JSON.parse(keyShown.mcq_correct) : null, result: saved.grade.result } : null,
  } : undefined;

  keys.current = (e) => {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(t.tagName) && !(t.tagName === "INPUT" && e.key === "Enter" && f === "numeric"))) return;
    if (e.key === "Enter") {
      if (saved && !fixing) { e.preventDefault(); next(); }
      else if (!saved && canAuto && !selfMark && !busy) { e.preventDefault(); submit(); }
      return;
    }
    if (!mcq || saved || busy || !inFrame) return;
    const labels = optionLabels(item);
    const k = e.key.toUpperCase();
    const label = labels.find((l) => l.toUpperCase() === k) ?? (/^[1-9]$/.test(k) ? labels[Number(k) - 1] : undefined);
    if (!label) return;
    e.preventDefault();
    const cur: string[] = Array.isArray(answer) ? answer : [];
    setAnswer(f === "mcq_single" ? [label] : cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]);
  };

  const answerText = keyShown ? (keyShown.mcq_correct ? (JSON.parse(keyShown.mcq_correct) as string[]).join(", ") : keyShown.numeric_value ?? keyShown.text_value) : null;
  const last = !session || pos >= items.length;

  return (
    <div class="px">
      <header class="px-bar">
        <div class="px-bar-in">
          <button class="px-exit" onClick={() => pause(true)}>
            <Icon name={session ? "pause" : "left"} size={15} /><span>{session ? "Pause & exit" : "Back"}</span>
          </button>
          <div class="px-title">
            {paper && <span class="px-paper">{paper.name}</span>}
            <strong>Question {item.position} of {items.length}</strong>
          </div>
          {session ? <button class="px-finish" onClick={async () => {
            if (!confirm("Finish this paper now? Unanswered questions stay unanswered.")) return;
            await api("PATCH", `/api/sessions/${session.id}`, { complete: true });
            setFinished(true);
          }}>Finish early</button> : <span class="px-finish-sp" />}
        </div>
        {items.length > 1 && (
          <div class="px-progress" role="progressbar" aria-label="Progress through the paper" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={Object.keys(results).length}>
            {items.map((i) => <i class={results[i.position] ? `r-${results[i.position]}` : i.position === pos ? "now" : i.position < pos ? "skipped" : ""} />)}
          </div>
        )}
      </header>

      <article class={`sheet px-sheet${saved ? ` is-${saved.grade.result}` : ""}`}>
        <header class="px-qhead">
          <span class="px-qno" aria-hidden="true">{item.position}</span>
          <div class="px-qmeta">
            {subject && <span class="px-subject"><i class={`sw seg-s${subjectSlot}`} aria-hidden="true" />{subject.name}</span>}
            <span class="px-kind">{parts.length > 1 ? `${parts.length} parts` : FORMAT_HINT[f] ?? ""}</span>
          </div>
          {item.marks !== null && item.marks !== undefined && <span class="px-marks">{item.marks} mark{item.marks === 1 ? "" : "s"}</span>}
        </header>
        <div class="px-body">
          <QuestionView key={item.question_version_id} v={{ content_format: item.content_format, blob_sha256: item.html_blob_sha256, css_sha256: item.css_sha256 }}
            opts={{ showMarks: parts.length > 0, marks: item.marks, showHints: true }} minHeight={60} title={`Question ${item.qno}`}
            choice={choice} onChoiceReady={setInFrame} onKey={(e) => keys.current(e)} />
        </div>

        {!saved ? (
          <footer class="px-dock">
            <ErrorBox error={err} />
            <div class="px-dock-row">
              <div class="px-answer"><AnswerInput item={item} value={answer} onChange={setAnswer} disabled={busy} inFrame={mcq ? inFrame : false} /></div>
              {autoable && !selfMark && (
                <div class="px-go">
                  <button class="btn primary lg" disabled={busy || !canAuto} onClick={() => submit()}>Check answer</button>
                </div>
              )}
            </div>
            {autoable && !selfMark ? (
              <div class="px-dock-foot">
                <button class="link-btn quiet" onClick={() => setSelfMark(true)}>Mark it myself instead</button>
                {solutionsAllowed && item.has_solution ? <button class="link-btn quiet" onClick={() => setSolOpen(!solOpen)}>{solOpen ? "Hide solution" : "Show solution"}</button> : null}
                {mcq && inFrame && <span class="px-keys"><kbd>A</kbd>–<kbd>{optionLabels(item).slice(-1)[0]}</kbd> to choose · <kbd>Enter</kbd> to check</span>}
              </div>
            ) : (
              <>
                {parts.length > 1 ? <PartMarker boot={boot} parts={parts} onSubmit={submit} /> : <GradeForm boot={boot} onSubmit={submit} />}
                <div class="px-dock-foot">
                  {autoable && <button class="link-btn quiet" onClick={() => setSelfMark(false)}>Let the app mark it</button>}
                  {solutionsAllowed && item.has_solution ? <button class="link-btn quiet" onClick={() => setSolOpen(!solOpen)}>{solOpen ? "Hide solution" : "Show solution"}</button> : null}
                </div>
              </>
            )}
          </footer>
        ) : (
          <footer class={`px-dock done r-${saved.grade.result}`}>
            <ErrorBox error={err} />
            <div class="px-dock-row">
              <div class="px-verdict" role="status">
                <span class="px-verdict-ic"><Icon name={saved.grade.result === "correct" ? "check" : saved.grade.result === "partial" ? "half" : "x"} size={20} /></span>
                <div>
                  <b>{VERDICT[saved.grade.result] ?? saved.grade.result}{saved.grade.result === "partial" ? ` · ${pct(saved.grade.score_permille)}` : ""}</b>
                  <span>
                    {saved.grade.method === "auto" ? "Marked automatically" : "Marked by you"}
                    {answerText !== null && <> · {keyShown.origin === "suggestion" ? "AI-suggested answer (unverified)" : "Answer"}: <b class="px-key">{answerText}</b></>}
                  </span>
                </div>
              </div>
              <div class="px-go">
                <button class="btn primary lg" onClick={next}>{last ? "Finish" : <>Next question <Icon name="arrow" size={16} /></>}</button>
              </div>
            </div>
            <div class="px-dock-foot">
              <button class="link-btn quiet" onClick={() => setFixing(!fixing)}>{fixing ? "Cancel" : "Correct grade"}</button>
              {solutionsAllowed && saved.solution ? <button class="link-btn quiet" onClick={() => setSolOpen(!solOpen)}>{solOpen ? "Hide solution" : "Show solution"}</button> : null}
              {!solutionsAllowed ? <span class="small muted">Solutions are not included in this paper. You can open them later from each question's page.</span>
                : !saved.solution ? <span class="small muted">No solution saved for this question.</span> : null}
              <span class="px-keys"><kbd>Enter</kbd> for {last ? "finish" : "next"}</span>
            </div>
            {fixing && (
              <GradeForm boot={boot} title="Change the grade to" submitLabel="Save correction" onSubmit={async (g) => {
                const r = await api("POST", `/api/attempts/${saved.attempt_id}/grades`, g);
                setSaved({ ...saved, grade: { ...saved.grade, result: r.result, score_permille: r.score_permille, method: "manual" } });
                setResults((x) => ({ ...x, [item.position]: r.result }));
                setFixing(false);
                toast("Grade corrected");
                refresh();
              }} />
            )}
          </footer>
        )}
      </article>

      {solutionsAllowed && solOpen && <VersionSolution versionId={item.question_version_id} />}
    </div>
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
  if (!d) return <p class="muted small center">Loading solution…</p>;
  if (!d.solution) return <p class="muted small center">No solution saved for this question.</p>;
  return (
    <section class="sheet px-solution">
      <header class="px-sol-head">
        <span class="px-sol-ic"><Icon name="bulb" size={16} /></span>
        <h3>Solution</h3>
        {d.solution.origin === "suggestion" && <span class="badge r-partial">AI-written · unverified</span>}
      </header>
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
      <div class="grade-title">Mark each part:</div>
      <div class="part-marks">
        {props.parts.map((p) => (
          <div class="row part-mark">
            <strong class="part-mark-label">({p.label})</strong>
            <span class="muted small grow">{p.marks !== null && p.marks !== undefined ? `${p.marks} mark${p.marks === 1 ? "" : "s"}` : ""}</span>
            <div class="part-mark-btns" role="group" aria-label={`Part ${p.label}`}>
              {(["yes", "half", "no"] as const).map((v) => (
                <button type="button" class={`pm pm-${v} ${got[p.label] === v ? "on" : ""}`} aria-pressed={got[p.label] === v} aria-label={v === "yes" ? "✓" : v === "half" ? "½" : "✗"}
                  title={v === "yes" ? "Right" : v === "half" ? "Half right" : "Wrong"}
                  onClick={() => setGot({ ...got, [p.label]: v })}>{v === "half" ? "½" : <Icon name={v === "yes" ? "check" : "x"} size={15} />}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div class="row wrap end">
        <span class="small grow">{all ? <>Score <b>{Math.round(earned * 100) / 100} / {total}</b> ({Math.round(permille / 10)}%)</> : <span class="muted">Mark every part</span>}</span>
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
      <div class="px"><section class="sheet px-saved">
        <span class="px-verdict-ic ok"><Icon name="check" size={22} /></span>
        <h2>Saved</h2>
        <p class="muted">Your answer and grade are in this question's history.</p>
        <div class="row center"><a class="btn" href={`#/q/${props.questionId}`}>Back to question</a><a class="btn primary" href="#/library">Library</a></div>
      </section></div>
    );
  }
  if (!d || !boot) return <Loading />;
  return <PaperSummary d={d} boot={boot} />;
}

export function PaperSummary(props: { d: any; boot: Boot; embedded?: boolean }) {
  const { d, boot } = props;
  const lastSession = d.sessions[d.sessions.length - 1];
  const atts = d.attempts.filter((a: any) => a.session_id === lastSession?.id);
  const total = atts.reduce((s: number, a: any) => s + (a.score_permille ?? 0), 0);
  const time = atts.reduce((s: number, a: any) => s + a.time_taken_seconds, 0);
  const count = (r: string) => atts.filter((a: any) => a.result === r).length;
  const score = atts.length ? total / atts.length / 1000 : null;
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
  const missed = [...byConcept.entries()].filter(([, c]) => c.miss > 0).map(([cid, c]) => ({ cid, path: conceptPath(boot, cid), ...c })).sort((a, b) => b.miss / b.total - a.miss / a.total || b.miss - a.miss);
  const skipped = d.items.length - atts.length;
  const headline = score === null ? "No answers yet" : score >= 0.85 ? "Excellent work" : score >= 0.65 ? "Good going" : score >= 0.4 ? "Getting there" : "A tough one — keep at it";
  const body = (
    <section class={`card sum${props.embedded ? " embedded" : ""}`}>
      <div class="sum-top">
        <Ring value={score} size={132} stroke={11} label="score" />
        <div class="sum-main">
          <div class="overline">{props.embedded ? "Last sitting" : "Paper finished"}{lastSession?.completed_at ? ` · ${fmtDate(lastSession.completed_at)}` : ""}</div>
          <h2 class="sum-headline">{headline}</h2>
          <div class="sum-stats">
            <div><b>{count("correct")}</b><span><i class="dot seg-st-good" />correct</span></div>
            <div><b>{count("partial")}</b><span><i class="dot seg-st-warn" />partly</span></div>
            <div><b>{count("incorrect")}</b><span><i class="dot seg-st-crit" />incorrect</span></div>
            {skipped > 0 && <div><b>{skipped}</b><span><i class="dot seg-st-none" />not answered</span></div>}
            <div><b>{fmtSecs(time)}</b><span>time on questions</span></div>
          </div>
        </div>
      </div>
      <div class="sum-strip" aria-label="Result of each question">
        {d.items.map((i: any) => {
          const a = atts.find((x: any) => x.paper_position === i.position);
          return (
            <a class={`sum-cell r-${a?.result ?? "none"}`} href={`#/q/${i.question_id}`} title={`Question ${i.position}: ${a ? RESULT_TEXT[a.result] ?? "ungraded" : "not answered"}${a ? ` · ${fmtSecs(a.time_taken_seconds)}` : ""}`}>
              <b>{i.position}</b>
              <Icon name={a?.result === "correct" ? "check" : a?.result === "partial" ? "half" : a?.result === "incorrect" ? "x" : "minus"} size={13} />
            </a>
          );
        })}
      </div>
      <div class="sum-cols">
        <div>
          <h3 class="sum-h">Where the marks went</h3>
          {byConcept.size === 0 ? <p class="muted small">No concept tags on these questions.</p>
            : missed.length === 0 ? <p class="muted small">Nothing missed — every tagged concept was answered correctly.</p> : (
              <ul class="bars">
                {missed.slice(0, 8).map((m) => (
                  <li>
                    <span class="bars-label" title={m.path}>{m.path.split(" › ").slice(-1)[0]}<small>{m.path.split(" › ").slice(0, -1).join(" › ")}</small></span>
                    <span class="bars-track"><i class="seg-st-crit" style={{ width: `${(m.miss / m.total) * 100}%` }} /></span>
                    <span class="bars-val num">{m.miss} of {m.total} missed</span>
                  </li>
                ))}
              </ul>
            )}
        </div>
        <div>
          <h3 class="sum-h">Question by question</h3>
          <ol class="sum-list">
            {d.items.map((i: any) => {
              const a = atts.find((x: any) => x.paper_position === i.position);
              return (
                <li>
                  <span class="num sum-n">{i.position}</span>
                  <a href={`#/q/${i.question_id}`} class="sum-q">{(i.plain_text ?? "").replace(/\s+/g, " ").trim().slice(0, 64) || `Q${i.qno}`}</a>
                  <ResultBadge result={a?.result} />
                  <span class="muted small num sum-t">{a ? fmtSecs(a.time_taken_seconds) : "—"}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {!props.embedded && <div class="row end sum-actions"><a class="btn" href={`#/papers/${d.paper.id}`}>Paper details</a><a class="btn primary" href="#/analytics">See progress <Icon name="arrow" size={15} /></a></div>}
    </section>
  );
  if (props.embedded) return body;
  return (
    <div class="page sum-page">
      <div class="page-head"><a class="pb-back" href="#/papers"><Icon name="left" size={13} /> Papers</a><h1 class="lib-h1">{d.paper.name} — summary</h1></div>
      {body}
    </div>
  );
}
