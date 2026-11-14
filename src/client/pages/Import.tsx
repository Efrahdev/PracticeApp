import { useMemo, useState } from "preact/hooks";
import promptTemplate from "../../../docs/ai-prompt.md";
import schemaJson from "../../../docs/question-pack.schema.json";
import exampleJson from "../../../docs/examples/fractions-pack.json";
import {
  commitPacks, fieldTypes, preview, readInputs, suggestDifficulty, type CommitResult, type DifficultyChoice, type Mapping,
  type PreparedPack, type PreparedQuestion, type ReadFailure, type SubjectChoice,
} from "../importer";
import { bytesToDataUri } from "../render";
import { refresh, useData } from "../store";
import type { Boot } from "../types";
import { conceptPath, ErrorBox, Modal, Progress, toast } from "../ui";
import { QuestionView, SolutionView, StoredView } from "../views";

const STATUS: Record<string, { label: string; cls: string }> = {
  new: { label: "New", cls: "s-new" },
  new_version: { label: "Changed → new version", cls: "s-new_version" },
  duplicate: { label: "Already in library", cls: "s-duplicate" },
  duplicate_in_file: { label: "Repeated in this file", cls: "s-duplicate" },
};
const TYPE_LABEL: Record<string, string> = {
  mcq_single: "multiple choice", mcq_multi: "choose all", numeric: "number", short_answer: "short answer", open: "open", multi_part: "multi-part",
};

export function buildPrompt(boot: Boot | null): string {
  const subjects = boot?.subjects.filter((s) => !s.archived_at).map((s) => s.name) ?? [];
  const diffs = boot?.difficulties.filter((d) => !d.archived_at).map((d) => d.label) ?? [];
  const fields = boot?.fields?.filter((f) => !f.archived_at).map((f) => f.name) ?? [];
  const leaves = boot ? boot.concepts.filter((c) => !c.archived_at && !boot.concepts.some((k) => k.parent_id === c.id && !k.archived_at)) : [];
  const subjName = new Map(boot?.subjects.map((s) => [s.id, s.name]) ?? []);
  const topics = leaves.slice(0, 300).map((c) => `  - ${subjName.get(c.subject_id)}: ${conceptPath(boot!, c.id).replace(/ › /g, " > ")}`);
  return promptTemplate
    .replace("{{SUBJECTS}}", subjects.length ? subjects.join(", ") : "(none yet — choose a clear subject name)")
    .replace("{{DIFFICULTY_LABELS}}", diffs.length ? diffs.join(", ") : "(none yet)")
    .replace("{{TOPICS}}", topics.length ? topics.join("\n") : "  (none yet — create sensible topic paths)")
    .replace("{{FIELDS}}", fields.length ? fields.join(", ") : "(none yet)");
}

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function Import() {
  const { boot } = useData();
  const [stage, setStage] = useState<"input" | "review" | "done">("input");
  const [packs, setPacks] = useState<PreparedPack[]>([]);
  const [failures, setFailures] = useState<ReadFailure[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ msg: string; frac: number } | null>(null);
  const [subjects, setSubjects] = useState(new Map<string, SubjectChoice>());
  const [diffs, setDiffs] = useState(new Map<string, DifficultyChoice>());
  const [updateExisting, setUpdateExisting] = useState(true);
  const [results, setResults] = useState<CommitResult[] | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const check = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await readInputs(files, pasted);
      for (const p of r.packs) await preview(p);
      setFailures(r.failures);
      if (!r.packs.length) {
        setErr(r.failures.length ? null : "Choose a file or paste the AI's reply first.");
        return;
      }
      setPacks(r.packs);
      // default mapping: match existing names, otherwise create
      const sm = new Map<string, SubjectChoice>();
      const dm = new Map<string, DifficultyChoice>();
      for (const p of r.packs) {
        for (const q of p.questions) {
          const s = q.nq.subject ?? "";
          if (!sm.has(s)) {
            const hit = boot?.subjects.find((x) => !x.archived_at && x.name.toLowerCase() === s.toLowerCase());
            const active = boot?.subjects.filter((x) => !x.archived_at) ?? [];
            sm.set(s, hit ? { id: hit.id } : s ? { name: s } : active.length === 1 ? { id: active[0].id } : { name: "General" });
          }
          if (q.nq.difficulty && !dm.has(q.nq.difficulty)) dm.set(q.nq.difficulty, suggestDifficulty(q.nq.difficulty, boot?.difficulties ?? []));
        }
      }
      setSubjects(sm);
      setDiffs(dm);
      setStage("review");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const mapping: Mapping = { subjects, difficulties: diffs, updateExisting };
      const res = await commitPacks(packs, mapping, fieldTypes(packs, boot?.fields ?? []), (msg, frac) => setProgress({ msg, frac }));
      await refresh();
      setResults(res);
      setStage("done");
      toast(`Saved ${res.reduce((s, r) => s + r.new + r.new_versions, 0)} question(s)`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const reset = () => {
    setStage("input");
    setPacks([]);
    setFailures([]);
    setFiles([]);
    setPasted("");
    setResults(null);
  };

  return (
    <div class="page">
      <div class="page-head"><h1>Import questions</h1></div>
      <ErrorBox error={err} />

      {stage === "input" && (
        <>
          <section class="card">
            <h2>1 · Convert with any AI</h2>
            <p>The app reads one format: a <strong>question pack</strong> (JSON or YAML). Give any AI model (ChatGPT, Claude, Gemini…) the prompt below together with your source — an HTML file, PDF text, a Word document or a photo. It returns a pack with every question, answer and worked solution. Maths stays as LaTeX.</p>
            <div class="row wrap">
              <button class="btn primary" onClick={async () => {
                try { await navigator.clipboard.writeText(buildPrompt(boot)); toast("AI prompt copied — paste it into your AI, then add your source"); } catch { setShowPrompt(true); }
              }}>Copy AI prompt</button>
              <button class="btn" onClick={() => setShowPrompt(true)}>View prompt</button>
              <button class="btn ghost" onClick={() => download("question-pack.schema.json", JSON.stringify(schemaJson, null, 2), "application/json")}>Download JSON Schema</button>
              <button class="btn ghost" onClick={() => download("example-pack.json", JSON.stringify(exampleJson, null, 2), "application/json")}>Download example</button>
            </div>
            <p class="small muted">Tips: send up to ~25 questions per request and ask for the next batch with the same pack id. Pictures the AI cannot copy: put the image files and the JSON in one .zip.</p>
          </section>

          <section class="card">
            <h2>2 · Upload or paste the result</h2>
            <label class="drop">
              <input type="file" multiple accept=".json,.yaml,.yml,.zip,application/json,application/zip,text/yaml" onChange={(e) => setFiles([...((e.target as HTMLInputElement).files ?? [])])} />
              <span>{files.length ? files.map((f) => f.name).join(", ") : "Choose .json, .yaml or .zip files (several at once is fine)"}</span>
            </label>
            <label class="field">…or paste the AI's reply (code fences and chat text around it are fine)
              <textarea rows={6} value={pasted} placeholder='{"format": "practice-app/question-pack@1", "questions": [ … ]}' onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)} />
            </label>
            <div class="row end">
              <button class="btn primary" disabled={busy || (!files.length && !pasted.trim())} onClick={check}>{busy ? "Checking…" : "Check"}</button>
            </div>
          </section>
          {failures.length > 0 && <Failures failures={failures} />}
        </>
      )}

      {stage === "review" && boot && (
        <Review
          boot={boot} packs={packs} failures={failures} subjects={subjects} setSubjects={setSubjects} diffs={diffs} setDiffs={setDiffs}
          updateExisting={updateExisting} setUpdateExisting={setUpdateExisting} rerender={rerender}
        />
      )}

      {stage === "review" && (
        <div class="sticky-actions">
          {progress ? <Progress {...progress} /> : (
            <>
              <span class="grow small muted">{summaryLine(packs)}</span>
              <button class="btn" disabled={busy} onClick={reset}>Cancel</button>
              <button class="btn primary" disabled={busy || toSave(packs) === 0 && !packs.some((p) => p.questions.some((q) => q.status === "duplicate" && q.include))} onClick={save}>
                Save {toSave(packs)} question{toSave(packs) === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      )}

      {stage === "done" && results && (
        <section class="card">
          <h2>Import finished</h2>
          <table class="table">
            <thead><tr><th>Pack</th><th>New</th><th>New versions</th><th>Already had</th><th>Skipped</th><th>Solutions updated</th></tr></thead>
            <tbody>{results.map((r) => <tr><td>{r.pack}</td><td>{r.new}</td><td>{r.new_versions}</td><td>{r.duplicates}</td><td>{r.rejected}</td><td>{r.updated_solutions + r.updated_keys}</td></tr>)}</tbody>
          </table>
          <div class="row end"><button class="btn" onClick={reset}>Import more</button><a class="btn primary" href="#/">Go to library</a></div>
        </section>
      )}

      {showPrompt && (
        <Modal title="AI conversion prompt" onClose={() => setShowPrompt(false)} wide>
          <p class="small muted">Paste this into your AI, then paste or attach your source questions after it.</p>
          <textarea rows={18} readOnly value={buildPrompt(boot)} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
          <div class="row end"><button class="btn" onClick={() => download("ai-prompt.md", buildPrompt(boot), "text/markdown")}>Download</button>
            <button class="btn primary" onClick={() => setShowPrompt(false)}>Close</button></div>
        </Modal>
      )}
    </div>
  );
}

const counts = (packs: PreparedPack[]) => {
  const c = { total: 0, new: 0, changed: 0, dup: 0, errors: 0, skipped: 0 };
  for (const p of packs) for (const q of p.questions) {
    c.total++;
    if (q.errors.length) c.errors++;
    else if (!q.include) c.skipped++;
    else if (q.status === "new") c.new++;
    else if (q.status === "new_version") c.changed++;
    else c.dup++;
  }
  return c;
};
const toSave = (packs: PreparedPack[]) => { const c = counts(packs); return c.new + c.changed; };
const summaryLine = (packs: PreparedPack[]) => {
  const c = counts(packs);
  return `${c.new} new · ${c.changed} changed · ${c.dup} already in library${c.errors ? ` · ${c.errors} with errors` : ""}${c.skipped ? ` · ${c.skipped} skipped` : ""}`;
};

function Failures(props: { failures: ReadFailure[] }) {
  return (
    <div class="error-box" role="alert">
      <strong>Could not read:</strong>
      <ul>{props.failures.map((f) => <li><b>{f.name}</b> — {f.error}</li>)}</ul>
      <p class="small">Fix it in the AI chat (for example: “Your JSON is invalid at line 12 — please resend the whole pack”) and try again.</p>
    </div>
  );
}

function Review(props: {
  boot: Boot; packs: PreparedPack[]; failures: ReadFailure[];
  subjects: Map<string, SubjectChoice>; setSubjects: (m: Map<string, SubjectChoice>) => void;
  diffs: Map<string, DifficultyChoice>; setDiffs: (m: Map<string, DifficultyChoice>) => void;
  updateExisting: boolean; setUpdateExisting: (b: boolean) => void; rerender: () => void;
}) {
  const { boot, packs } = props;
  const [filter, setFilter] = useState<"all" | "new" | "changed" | "dup" | "problems">("all");
  const ftypes = useMemo(() => fieldTypes(packs, boot.fields ?? []), [packs]);
  const existingFields = new Set((boot.fields ?? []).map((f) => f.name.toLowerCase()));
  const topicPaths = new Set<string>();
  for (const p of packs) for (const q of p.questions) for (const t of q.nq.topics) topicPaths.add(t.path.join(" > "));
  const c = counts(packs);
  const activeSubjects = boot.subjects.filter((s) => !s.archived_at);

  return (
    <>
      {props.failures.length > 0 && <Failures failures={props.failures} />}
      {packs.map((p) => (
        <section class="card">
          <h2>{p.pack.title ?? p.sourceName}</h2>
          <p class="muted small">{p.sourceName}{p.pack.source ? ` · source: ${p.pack.source}` : ""} · pack id <code>{p.pack.key}</code> · {p.syntax.toUpperCase()}</p>
          {p.warnings.length > 0 && <ul class="notes">{p.warnings.map((w) => <li>{w}</li>)}</ul>}
        </section>
      ))}

      <section class="card">
        <div class="stats">
          <div><b>{c.total}</b><span>questions</span></div>
          <div><b>{c.new}</b><span>new</span></div>
          <div><b>{c.changed}</b><span>changed</span></div>
          <div><b>{c.dup}</b><span>already have</span></div>
          <div><b>{c.errors}</b><span>can't import</span></div>
        </div>

        <h3>Where they go</h3>
        <div class="map-grid">
          {[...props.subjects.entries()].map(([name, choice]) => (
            <div class="map-row">
              <span class="small">Subject <b>{name || "(none given)"}</b> →</span>
              <select value={choice === null ? "__none" : "id" in choice ? choice.id : "__new"} onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                const m = new Map(props.subjects);
                m.set(name, v === "__none" ? null : v === "__new" ? { name: name || "General" } : { id: v });
                props.setSubjects(m);
              }}>
                {activeSubjects.map((s) => <option value={s.id}>{s.name}</option>)}
                <option value="__new">New subject…</option>
                <option value="__none">No subject (topics are skipped)</option>
              </select>
              {choice && "name" in choice && (
                <input value={choice.name} aria-label="New subject name" onInput={(e) => {
                  const m = new Map(props.subjects);
                  m.set(name, { name: (e.target as HTMLInputElement).value });
                  props.setSubjects(m);
                }} />
              )}
            </div>
          ))}
          {[...props.diffs.entries()].map(([label, choice]) => (
            <div class="map-row">
              <span class="small">Difficulty <b>{label}</b> →</span>
              <select value={choice === null ? "__none" : "code" in choice ? choice.code : "__new"} onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                const m = new Map(props.diffs);
                m.set(label, v === "__none" ? null : v === "__new" ? { create: label } : { code: v });
                props.setDiffs(m);
              }}>
                {boot.difficulties.filter((d) => !d.archived_at).map((d) => <option value={d.code}>{d.label}</option>)}
                <option value="__new">New label “{label}”</option>
                <option value="__none">No difficulty</option>
              </select>
            </div>
          ))}
        </div>
        {topicPaths.size > 0 && <p class="small muted">{topicPaths.size} topic path{topicPaths.size === 1 ? "" : "s"} — missing ones are created under the subject: {[...topicPaths].slice(0, 6).join("; ")}{topicPaths.size > 6 ? "…" : ""}</p>}
        {ftypes.size > 0 && (
          <p class="small muted">Custom fields: {[...ftypes.entries()].map(([n, t]) => `${n} (${t}${existingFields.has(n.toLowerCase()) ? "" : ", new"})`).join(", ")}</p>
        )}
        {c.dup > 0 && (
          <label class="small"><input type="checkbox" checked={props.updateExisting} onChange={(e) => props.setUpdateExisting((e.target as HTMLInputElement).checked)} />{" "}
            For questions already in the library, update solutions and answers from this file (solutions you edited yourself are never overwritten; old versions are kept)</label>
        )}
      </section>

      <div class="row wrap results-head">
        <div class="chips">
          {([["all", `All ${c.total}`], ["new", `New ${c.new}`], ["changed", `Changed ${c.changed}`], ["dup", `Already have ${c.dup}`], ["problems", "With notes"]] as const).map(([k, l]) => (
            <button class={`chip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <span class="grow" />
        <button class="btn ghost small" onClick={() => { packs.forEach((p) => p.questions.forEach((q) => { if (!q.errors.length) q.include = true; })); props.rerender(); }}>Include all</button>
        <button class="btn ghost small" onClick={() => { packs.forEach((p) => p.questions.forEach((q) => { if (q.status !== "duplicate") q.include = false; })); props.rerender(); }}>Skip all</button>
      </div>

      <div class="review">
        {packs.flatMap((p) =>
          p.questions
            .filter((q) =>
              filter === "all" ? true
                : filter === "new" ? q.status === "new"
                : filter === "changed" ? q.status === "new_version"
                : filter === "dup" ? q.status === "duplicate" || q.status === "duplicate_in_file"
                : q.errors.length > 0 || q.warnings.some((w) => w !== "No solution."),
            )
            .map((q) => <ReviewItem key={`${p.sourceSha}-${q.nq.index}`} p={p} q={q} boot={boot} rerender={props.rerender} />),
        )}
      </div>
    </>
  );
}

function ReviewItem(props: { p: PreparedPack; q: PreparedQuestion; boot: Boot; rerender: () => void }) {
  const { p, q } = props;
  const [open, setOpen] = useState(false);
  const isDup = q.status === "duplicate" || q.status === "duplicate_in_file";
  const resolve = async (hex: string) => {
    const a = p.assetBlobs.get(hex);
    return a ? bytesToDataUri(a.bytes, a.mime) : null;
  };
  const st = STATUS[q.status] ?? STATUS.new;
  return (
    <div class={`review-item ${q.include && !q.errors.length ? "" : "off"}`}>
      <div class="row">
        <label class="row grow">
          <input type="checkbox" checked={q.include && !q.errors.length} disabled={q.errors.length > 0 || isDup} aria-label={`Include question ${q.nq.number ?? q.nq.index + 1}`}
            onChange={(e) => { q.include = (e.target as HTMLInputElement).checked; props.rerender(); }} />
          <strong>Q{q.nq.number ?? q.nq.index + 1}</strong>
          {q.errors.length > 0 ? <span class="badge r-incorrect">Can't import</span> : <span class={`badge ${st.cls}`}>{st.label}</span>}
          <span class="badge muted">{TYPE_LABEL[q.nq.type]}</span>
          {q.solution && <span class={`badge ${q.solution.origin === "suggestion" ? "r-partial" : "ok"}`}>{q.solution.origin === "suggestion" ? "AI solution" : "solution"}</span>}
          <span class="muted small hide-sm">{q.nq.topics.map((t) => t.path[t.path.length - 1]).join(", ")}{q.nq.difficulty ? ` · ${q.nq.difficulty}` : ""}{q.nq.marks !== null ? ` · ${q.nq.marks} mark${q.nq.marks === 1 ? "" : "s"}` : ""}</span>
        </label>
        <button class="btn ghost small" onClick={() => setOpen(!open)}>{open ? "Hide" : "Preview"}</button>
      </div>
      {!open && <p class="qtext small">{q.plain.slice(0, 180)}</p>}
      {(q.errors.length > 0 || q.warnings.length > 0) && (
        <ul class="notes small">
          {q.errors.map((e) => <li class="error">{e}</li>)}
          {q.warnings.filter((w) => open || w !== "No solution.").map((w) => <li class="warning">{w}</li>)}
        </ul>
      )}
      {open && (
        <div class="preview-grid">
          <div>
            <div class="small muted">Question{q.status === "new_version" ? " (new version)" : ""}</div>
            <StoredView stored={q.stored} resolve={resolve} opts={{ showMarks: true, marks: q.nq.marks }} title={`Preview Q${q.nq.number ?? ""}`} />
          </div>
          {q.solution && (
            <div>
              <div class="small muted">Solution{q.solution.origin === "suggestion" ? " — written by AI, stored as Unverified" : ""}</div>
              <SolutionView s={{ body_text: q.solution.body, body_format: q.solution.format }} resolve={resolve} />
            </div>
          )}
          {q.status === "new_version" && q.existingBlob && (
            <div>
              <div class="small muted">Current version in your library</div>
              <QuestionView v={{ content_format: q.existingBlob.format, blob_sha256: q.existingBlob.sha, css_sha256: q.existingBlob.css }} />
              <label class="small"><input type="checkbox" checked={q.asNew} onChange={(e) => { q.asNew = (e.target as HTMLInputElement).checked; props.rerender(); }} /> Not the same question — import it as a separate new question</label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
