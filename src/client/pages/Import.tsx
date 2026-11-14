import { useState } from "preact/hooks";
import { commitImport, prepareImport, type Prepared } from "../importer";
import { refresh, useData } from "../store";
import { ErrorBox, Progress, QuestionFrame, toast } from "../ui";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  new_version: "Changed → new version",
  duplicate: "Already in library",
  duplicate_in_file: "Repeated in this file",
};

export function Import() {
  const { boot } = useData();
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ msg: string; frac: number } | null>(null);
  const [subjectChoice, setSubjectChoice] = useState<string>("__new");
  const [subjectName, setSubjectName] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [done, setDone] = useState<any>(null);
  const [, force] = useState(0);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setDone(null);
    setBusy(true);
    try {
      const p = await prepareImport(f);
      if (!p.questions.length) throw new Error("No questions were found in this file. Check that it uses the expected template (div.q with span.qn \"Q1.\").");
      setPrep(p);
      setOpen(new Set());
      const guess = p.parsed.title.split(/[—–-]/)[0].trim();
      const match = boot?.subjects.find((s) => !s.archived_at && s.name.toLowerCase() === guess.toLowerCase());
      if (match) setSubjectChoice(match.id);
      else { setSubjectChoice("__new"); setSubjectName(guess); }
    } catch (e) {
      setErr((e as Error).message);
      setPrep(null);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!prep) return;
    setBusy(true);
    setErr(null);
    try {
      const subject = subjectChoice === "__none" ? null : subjectChoice === "__new" ? (subjectName.trim() ? { name: subjectName.trim() } : null) : { id: subjectChoice };
      const r = await commitImport(prep, subject, (msg, frac) => setProgress({ msg, frac }));
      await refresh();
      setDone(r);
      setPrep(null);
      toast(`Imported ${r.new} new question(s)`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const setAll = (accept: boolean) => {
    prep!.questions.forEach((q) => { if (q.status === "new" || q.status === "new_version") q.accept = accept; });
    force((n) => n + 1);
  };

  const counts = prep
    ? prep.questions.reduce((m, q) => ({ ...m, [q.status ?? "new"]: (m[q.status ?? "new"] ?? 0) + 1 }), {} as Record<string, number>)
    : {};
  const accepted = prep?.questions.filter((q) => q.accept).length ?? 0;
  const issues = prep?.parsed.issues ?? [];
  const cats = new Map(prep?.parsed.categories.map((c) => [c.key, c.name]) ?? []);

  return (
    <div class="page">
      <div class="page-head"><h1>Import questions</h1></div>
      <ErrorBox error={err} />

      {done && (
        <div class="ok-box">
          Imported: <strong>{done.new}</strong> new, <strong>{done.new_versions}</strong> new version(s), {done.duplicates} already in library, {done.rejected} rejected.{" "}
          <a href="#/">Go to library →</a>
        </div>
      )}

      {!prep && (
        <section class="card">
          <p>Upload one HTML question file. It is split into questions here on your device, then you review everything before it is saved. The original file is kept unchanged.</p>
          <label class="drop">
            <input type="file" accept=".html,.htm,text/html" disabled={busy} onChange={(e) => onFile((e.target as HTMLInputElement).files?.[0])} />
            <span>{busy ? "Reading…" : "Choose an HTML file"}</span>
          </label>
        </section>
      )}

      {prep && (
        <>
          <section class="card">
            <h2>{prep.parsed.title || prep.fileName}</h2>
            <p class="muted small">{prep.fileName} · {(prep.bytes.byteLength / 1024).toFixed(0)} KB</p>
            <div class="stats">
              <div><b>{prep.questions.length}</b><span>found</span></div>
              <div><b>{counts.new ?? 0}</b><span>new</span></div>
              <div><b>{counts.new_version ?? 0}</b><span>changed</span></div>
              <div><b>{(counts.duplicate ?? 0) + (counts.duplicate_in_file ?? 0)}</b><span>already have</span></div>
              <div><b>{prep.parsed.categories.length}</b><span>categories</span></div>
            </div>
            {(issues.length > 0 || prep.missingRefs.length > 0) && (
              <details class="issues" open={issues.some((i) => i.level === "error")}>
                <summary>{issues.length + prep.missingRefs.length} note(s) from the check</summary>
                <ul>
                  {issues.map((i) => <li class={i.level}>{i.level === "error" ? "⚠ " : ""}{i.message}</li>)}
                  {prep.missingRefs.map((r) => <li class="warning">Missing image/font: {r}</li>)}
                </ul>
              </details>
            )}
            <div class="grid2">
              <label class="field">Subject for these questions
                <select value={subjectChoice} onChange={(e) => setSubjectChoice((e.target as HTMLSelectElement).value)}>
                  <option value="__new">New subject…</option>
                  <option value="__none">No subject</option>
                  {boot?.subjects.filter((s) => !s.archived_at).map((s) => <option value={s.id}>{s.name}</option>)}
                </select>
              </label>
              {subjectChoice === "__new" && (
                <label class="field">New subject name<input value={subjectName} onInput={(e) => setSubjectName((e.target as HTMLInputElement).value)} /></label>
              )}
            </div>
            {subjectChoice !== "__none" && prep.parsed.categories.length > 0 && (
              <p class="small muted">Each category becomes a concept under this subject: {prep.parsed.categories.map((c) => c.name).join(", ")}. Difficulty bands become difficulty labels.</p>
            )}
          </section>

          <div class="row wrap results-head">
            <strong>{accepted} of {prep.questions.length} will be saved</strong>
            <span class="grow" />
            <button class="btn ghost small" onClick={() => setAll(true)}>Accept all</button>
            <button class="btn ghost small" onClick={() => setAll(false)}>Reject all</button>
            <button class="btn ghost small" onClick={() => setOpen(open.size ? new Set() : new Set(prep.questions.map((q) => q.position)))}>{open.size ? "Hide previews" : "Show all previews"}</button>
          </div>

          <div class="review">
            {prep.questions.map((q) => {
              const isDup = q.status === "duplicate" || q.status === "duplicate_in_file";
              const isOpen = open.has(q.position);
              return (
                <div class={`review-item ${q.accept ? "" : "off"}`}>
                  <div class="row">
                    <label class="row grow">
                      <input type="checkbox" checked={q.accept} disabled={isDup} onChange={(e) => { q.accept = (e.target as HTMLInputElement).checked; force((n) => n + 1); }} />
                      <strong>Q{q.number}</strong>
                      <span class={`badge s-${q.status}`}>{STATUS_LABEL[q.status ?? "new"]}</span>
                      <span class="muted small hide-sm">{q.category_key ? cats.get(q.category_key) : ""}{q.band ? ` · ${q.band}` : ""}{q.solution_html ? "" : " · no solution"}</span>
                    </label>
                    <button class="btn ghost small" onClick={() => { const s = new Set(open); isOpen ? s.delete(q.position) : s.add(q.position); setOpen(s); }}>{isOpen ? "Hide" : "Preview"}</button>
                  </div>
                  {!isOpen && <p class="qtext small">{q.plain_text.slice(0, 160)}</p>}
                  {isOpen && (
                    <div class="preview">
                      <QuestionFrame html={q.html} css={prep.parsed.css} title={`Preview Q${q.number}`} />
                      {q.solution_html && (
                        <details><summary class="small">Solution</summary><QuestionFrame html={q.solution_html} css={prep.parsed.css} title={`Solution Q${q.number}`} /></details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div class="sticky-actions">
            {progress ? <Progress {...progress} /> : (
              <>
                <button class="btn" disabled={busy} onClick={() => setPrep(null)}>Cancel</button>
                <button class="btn primary" disabled={busy || accepted === 0} onClick={commit}>Accept and save {accepted}</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
