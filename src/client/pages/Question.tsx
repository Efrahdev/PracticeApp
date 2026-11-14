import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { refresh, useData } from "../store";
import type { Boot } from "../types";
import { conceptPath, ErrorBox, fmtDateTime, fmtSecs, names, pct, QuestionFrame, ResultBadge, toast } from "../ui";
import { GradeForm } from "./Practice";

export function Question(props: { id: string }) {
  const { boot } = useData();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    try { setD(await api("GET", `/api/questions/${props.id}`)); setErr(null); } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { setD(null); load(); }, [props.id]);
  if (err) return <ErrorBox error={err} />;
  if (!d || !boot) return <p class="muted">Loading…</p>;
  const q = d.question;
  const css = d.stylesheets.find((s: any) => s.question_version_id === q.version_id)?.blob_sha256 ?? null;
  const reload = async () => { await load(); await refresh(); };

  return (
    <div class="page">
      <div class="page-head">
        <a href="#/" class="back">← Library</a>
        <h1>Q{q.source_question_number} {q.archived_at && <span class="badge muted">archived</span>}</h1>
        <span class="muted small">{d.source?.file_name} · position {q.source_position} · version {q.version_no} of {d.versions.length} · ID {q.id}</span>
      </div>
      <div class="cols">
        <div class="col-main">
          <section class="card flush"><QuestionFrame htmlSha={q.html_blob_sha256} cssSha={css} minHeight={120} /></section>
          <div class="row wrap">
            <a class="btn primary" href={`#/practice-q/${q.id}`}>Practise this question</a>
          </div>
          <SolutionPanel d={d} css={css} onSaved={reload} />
          <History d={d} boot={boot} onChanged={reload} />
        </div>
        <div class="col-side">
          <MetaForm boot={boot} d={d} onSaved={reload} />
          <AnswerKeyForm d={d} onSaved={reload} />
          {d.stat && (
            <section class="card">
              <h3>Your record</h3>
              <dl class="kv">
                <dt>Attempts</dt><dd>{d.stat.attempt_count}</dd>
                <dt>Last result</dt><dd><ResultBadge result={d.stat.last_result} /></dd>
                <dt>Last attempted</dt><dd>{fmtDateTime(d.stat.last_attempted_at)}</dd>
                <dt>Average time</dt><dd>{fmtSecs(d.stat.total_time_seconds / d.stat.attempt_count)}</dd>
                <dt>Last time</dt><dd>{fmtSecs(d.stat.last_time_seconds)}</dd>
                <dt>Personal difficulty</dt><dd>{pct(d.stat.personal_difficulty_permille)}</dd>
              </dl>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaForm(props: { boot: Boot; d: any; onSaved: () => void }) {
  const q = props.d.question;
  const boot = props.boot;
  const [subject, setSubject] = useState<string>(q.subject_id ?? "");
  const [diff, setDiff] = useState<string>(q.difficulty_code ?? "");
  const [format, setFormat] = useState<string>(q.answer_format);
  const [labels, setLabels] = useState<string>(q.option_labels ? JSON.parse(q.option_labels).join(", ") : "A, B, C, D");
  const [notes, setNotes] = useState<string>(q.notes ?? "");
  const [tags, setTags] = useState<{ concept_id: string; weight: number }[]>(props.d.concepts);
  const [add, setAdd] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = boot.concepts.filter((c) => !c.archived_at && (!subject || c.subject_id === subject) && !tags.some((t) => t.concept_id === c.id));

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setErr(null);
    try {
      await api("PATCH", `/api/questions/${q.id}`, {
        subject_id: subject || null,
        difficulty_code: diff || null,
        answer_format: format,
        option_labels: format.startsWith("mcq") ? labels.split(",").map((s) => s.trim()).filter(Boolean) : null,
        notes,
        concepts: tags,
        ...extra,
      });
      toast("Saved");
      props.onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section class="card">
      <h3>Details</h3>
      <ErrorBox error={err} />
      <label class="field">Subject
        <select value={subject} onChange={(e) => setSubject((e.target as HTMLSelectElement).value)}>
          <option value="">(none)</option>
          {boot.subjects.filter((s) => !s.archived_at || s.id === subject).map((s) => <option value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label class="field">Difficulty label
        <select value={diff} onChange={(e) => setDiff((e.target as HTMLSelectElement).value)}>
          <option value="">(none)</option>
          {boot.difficulties.map((d) => <option value={d.code}>{d.label}</option>)}
        </select>
      </label>
      <div class="field">Concepts &amp; weights
        {tags.length === 0 && <span class="muted small">No concepts yet.</span>}
        {tags.map((t, i) => (
          <div class="row">
            <span class="grow small">{conceptPath(boot, t.concept_id)}</span>
            <input type="number" step="0.1" min="0.1" max="1" class="w5" aria-label="Weight" value={t.weight}
              onInput={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, weight: Number((e.target as HTMLInputElement).value) } : x)))} />
            <button class="icon" aria-label="Remove concept" onClick={() => setTags(tags.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div class="row">
          <select class="grow" value={add} onChange={(e) => setAdd((e.target as HTMLSelectElement).value)}>
            <option value="">+ add concept…</option>
            {usable.map((c) => <option value={c.id}>{conceptPath(boot, c.id)}</option>)}
          </select>
          <button class="btn small" disabled={!add} onClick={() => { setTags([...tags, { concept_id: add, weight: 1 }]); setAdd(""); }}>Add</button>
        </div>
        <a class="small" href="#/settings">Manage subjects &amp; concepts</a>
      </div>
      <label class="field">Answer format
        <select value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value)}>
          <option value="none">None (just grade yourself)</option>
          <option value="mcq_single">Multiple choice — one answer</option>
          <option value="mcq_multi">Multiple choice — several answers</option>
          <option value="numeric">Number</option>
          <option value="text">Text</option>
        </select>
      </label>
      {format.startsWith("mcq") && (
        <label class="field">Option labels (comma separated)<input value={labels} onInput={(e) => setLabels((e.target as HTMLInputElement).value)} /></label>
      )}
      <label class="field">Notes<textarea rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} /></label>
      <div class="row end">
        <button class="btn ghost small" disabled={busy} onClick={() => save({ archived: !q.archived_at })}>{q.archived_at ? "Unarchive" : "Archive"}</button>
        <button class="btn primary" disabled={busy} onClick={() => save()}>Save details</button>
      </div>
    </section>
  );
}

function AnswerKeyForm(props: { d: any; onSaved: () => void }) {
  const q = props.d.question;
  const k = props.d.answerKey;
  const labels: string[] = q.option_labels ? JSON.parse(q.option_labels) : ["A", "B", "C", "D"];
  const defaultType = q.answer_format !== "none" ? q.answer_format : "mcq_single";
  const [type, setType] = useState<string>(k?.answer_type ?? defaultType);
  const [mcq, setMcq] = useState<string[]>(k?.mcq_correct ? JSON.parse(k.mcq_correct) : []);
  const [num, setNum] = useState<string>(k?.numeric_value?.toString() ?? "");
  const [tol, setTol] = useState<string>(k?.numeric_tolerance?.toString() ?? "0");
  const [text, setText] = useState<string>(k?.text_value ?? "");
  const [err, setErr] = useState<string | null>(null);
  const save = async (remove = false) => {
    setErr(null);
    try {
      await api("POST", `/api/questions/${q.id}/answer-key`, remove ? { remove: true } : {
        answer_type: type, mcq_correct: mcq, numeric_value: num === "" ? undefined : Number(num), numeric_tolerance: Number(tol || 0), text_value: text,
      });
      toast(remove ? "Answer key removed" : "Answer key saved");
      props.onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <section class="card">
      <h3>Answer key {k && <span class="badge ok">verified · v{k.key_no}</span>}</h3>
      <p class="muted small">With a key, multiple-choice and number answers are marked automatically. Changing it keeps the old key so past grades still point at the key that produced them.</p>
      <ErrorBox error={err} />
      <label class="field">Type
        <select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          <option value="mcq_single">Multiple choice — one answer</option>
          <option value="mcq_multi">Multiple choice — several answers</option>
          <option value="numeric">Number (with tolerance)</option>
          <option value="text">Text (marked by you)</option>
        </select>
      </label>
      {type.startsWith("mcq") && (
        <div class="chips">
          {labels.map((l) => (
            <button type="button" class={`chip ${mcq.includes(l) ? "on" : ""}`} aria-pressed={mcq.includes(l)}
              onClick={() => setMcq(type === "mcq_single" ? [l] : mcq.includes(l) ? mcq.filter((x) => x !== l) : [...mcq, l])}>{l}</button>
          ))}
        </div>
      )}
      {type === "numeric" && (
        <div class="row">
          <label class="field grow">Answer<input type="number" step="any" value={num} onInput={(e) => setNum((e.target as HTMLInputElement).value)} /></label>
          <label class="field grow">± tolerance<input type="number" step="any" min="0" value={tol} onInput={(e) => setTol((e.target as HTMLInputElement).value)} /></label>
        </div>
      )}
      {type === "text" && <label class="field">Answer<input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} /></label>}
      <div class="row end">
        {k && <button class="btn ghost small" onClick={() => save(true)}>Remove key</button>}
        <button class="btn" onClick={() => save()}>Save key</button>
      </div>
    </section>
  );
}

function SolutionPanel(props: { d: any; css: string | null; onSaved: () => void }) {
  const s = props.d.solution;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s?.body_text ?? "");
  const save = async () => {
    try {
      await api("POST", `/api/questions/${props.d.question.id}/solution`, { body_text: text });
      setEditing(false);
      toast("Solution saved");
      props.onSaved();
    } catch (e) { toast((e as Error).message, "error"); }
  };
  return (
    <section class="card">
      <div class="row"><h3 class="grow">Solution {s?.origin === "import" && <span class="muted small">(from file)</span>}</h3>
        <button class="btn ghost small" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : s ? "Replace" : "Write one"}</button></div>
      {editing ? (
        <>
          <textarea rows={6} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder="Worked solution…" />
          <div class="row end"><button class="btn primary" onClick={save}>Save solution</button></div>
        </>
      ) : !s ? <p class="muted">No solution yet.</p>
        : s.body_blob_sha256 ? <details><summary>Show solution</summary><QuestionFrame htmlSha={s.body_blob_sha256} cssSha={props.css} title="Solution" /></details>
        : <details><summary>Show solution</summary><p class="pre">{s.body_text}</p></details>}
    </section>
  );
}

function History(props: { d: any; boot: Boot; onChanged: () => void }) {
  const [fixing, setFixing] = useState<string | null>(null);
  const errLabel = new Map(props.boot.errorTypes.map((e) => [e.code, e.label]));
  const byAttempt = new Map<string, any[]>();
  for (const g of props.d.grades) byAttempt.set(g.attempt_id, [...(byAttempt.get(g.attempt_id) ?? []), g]);
  if (!props.d.attempts.length) return <section class="card"><h3>History</h3><p class="muted">Not attempted yet.</p></section>;
  return (
    <section class="card">
      <h3>History</h3>
      <ul class="history">
        {props.d.attempts.map((a: any) => {
          const gs = byAttempt.get(a.id) ?? [];
          const eff = gs[gs.length - 1];
          const resp = a.response_kind === "mcq" ? JSON.parse(a.response_options ?? "[]").join(", ") : a.response_kind === "numeric" ? a.response_numeric : a.response_text;
          return (
            <li>
              <div class="row wrap">
                <ResultBadge result={eff?.result} />
                {eff?.result === "partial" && <span class="small">{pct(eff.score_permille)}</span>}
                <span class="small">{fmtDateTime(a.attempted_at)} · {fmtSecs(a.time_taken_seconds)}</span>
                {resp !== null && resp !== undefined && resp !== "" && <span class="small muted">answer: {String(resp)}</span>}
                {eff?.method === "auto" && <span class="badge muted">auto</span>}
                {eff?.error_type_code && <span class="small">{errLabel.get(eff.error_type_code)}</span>}
                <span class="grow" />
                <button class="btn ghost small" onClick={() => setFixing(fixing === a.id ? null : a.id)}>Correct grade</button>
              </div>
              {gs.length > 1 && (
                <p class="small muted">Earlier: {gs.slice(0, -1).map((g: any) => `${g.result}${g.result === "partial" ? ` ${pct(g.score_permille)}` : ""}`).join(" → ")}</p>
              )}
              {eff?.note && <p class="small">“{eff.note}”</p>}
              {fixing === a.id && (
                <GradeForm boot={props.boot} submitLabel="Save correction" onSubmit={async (g) => {
                  await api("POST", `/api/attempts/${a.id}/grades`, g);
                  setFixing(null);
                  toast("Grade corrected (the old one is kept)");
                  props.onChanged();
                }} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
