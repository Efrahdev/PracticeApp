// Change many questions at once. Every field starts at "Leave as is". "Preview changes"
// shows exactly what would change (nothing is saved); "Apply" saves everything in one
// all-or-nothing step. "Delete permanently" is a separate, red section.
import { useState } from "preact/hooks";
import { api } from "../api";
import { refresh } from "../store";
import type { Boot } from "../types";
import { conceptPath, ErrorBox, Modal, toast } from "../ui";

interface TopicRow { concept_id?: string; path?: string[]; subject?: { id: string } | { name: string }; weight: number; label: string }
interface FieldEdit { action: "keep" | "set" | "clear"; value: string }

const FORMAT_LABEL: Record<string, string> = {
  none: "None (grade yourself)", mcq_single: "Multiple choice — one answer", mcq_multi: "Multiple choice — several answers", numeric: "Number", text: "Text",
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BulkEdit(props: {
  boot: Boot; ids: string[]; onClose: () => void; onDone: () => void;
  startWithDelete?: boolean; removeEmptyImports?: boolean; title?: string;
}) {
  const { boot } = props;
  const activeSubjects = boot.subjects.filter((s) => !s.archived_at);
  const [subject, setSubject] = useState<string>("__keep"); // __keep | __clear | __new | subject id
  const [newSubject, setNewSubject] = useState("");
  const [topicMode, setTopicMode] = useState<"keep" | "add" | "replace" | "remove" | "clear">("keep");
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [pick, setPick] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newPathSubject, setNewPathSubject] = useState<string>(activeSubjects[0]?.id ?? "");
  const [format, setFormat] = useState<string>("__keep");
  const [marksMode, setMarksMode] = useState<"keep" | "set" | "clear">("keep");
  const [marks, setMarks] = useState("");
  const [fields, setFields] = useState<Record<string, FieldEdit>>({});
  const [clearAllFields, setClearAllFields] = useState(false);
  const [notesMode, setNotesMode] = useState<"keep" | "set" | "append" | "clear">("keep");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"keep" | "archive" | "unarchive">("keep");
  const [del, setDel] = useState(!!props.startWithDelete);
  const [removeImports, setRemoveImports] = useState(props.removeEmptyImports ?? false);
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeFields = boot.fields.filter((f) => !f.archived_at);
  const changed = () => setPreview(null); // any edit invalidates the preview

  // the subject new topics go under: the subject being set here, else the one picked next to the new topic
  const subjectForNewTopic = (): { id: string } | { name: string } | null =>
    subject === "__new" && newSubject.trim() ? { name: newSubject.trim() } : subject !== "__keep" && subject !== "__clear" && subject !== "__new" ? { id: subject } : newPathSubject ? { id: newPathSubject } : null;

  const spec = () => {
    const s: any = { ids: props.ids };
    if (del) return { ...s, status: "delete", remove_empty_imports: removeImports };
    if (subject === "__clear") s.subject = { id: null };
    else if (subject === "__new") s.subject = { name: newSubject };
    else if (subject !== "__keep") s.subject = { id: subject };
    if (topicMode === "clear") s.topics = { mode: "clear" };
    else if (topicMode !== "keep") s.topics = { mode: topicMode, items: topics.map(({ label, ...t }) => t) };
    if (format !== "__keep") s.answer_format = format;
    if (marksMode === "clear") s.marks = { value: null };
    else if (marksMode === "set") s.marks = { value: Number(marks) };
    if (clearAllFields) s.clear_all_fields = true;
    else {
      const fl = Object.entries(fields).filter(([, f]) => f.action !== "keep").map(([field_id, f]) => ({ field_id, action: f.action, value: f.value }));
      if (fl.length) s.fields = fl;
    }
    if (notesMode !== "keep") s.notes = { mode: notesMode, text: notes };
    if (status !== "keep") s.status = status;
    return s;
  };

  const run = async (dry: boolean) => {
    if (!del && marksMode === "set" && marks.trim() === "") return setErr("Type the marks first, or choose Clear.");
    if (!del && subject === "__new" && !newSubject.trim()) return setErr("Type a name for the new subject.");
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", "/api/questions-bulk", { ...spec(), dry_run: dry });
      if (dry) setPreview(r);
      else {
        await refresh();
        toast(del ? `Deleted ${plural(r.summary.delete, "question")} permanently` : "Changes saved");
        props.onDone();
      }
    } catch (e) {
      setErr((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const lines: string[] = [];
  let nothing = false;
  if (preview) {
    const s = preview.summary;
    if (del) {
      lines.push(`${plural(s.delete, "question")} deleted permanently, with their versions, solutions, answer keys, topics and field values`);
      if (s.attempts_deleted) lines.push(`${plural(s.attempts_deleted, "attempt")} (and their grades) deleted — your statistics are recalculated without them`);
      if (s.paper_slots_removed) lines.push(`${plural(s.paper_slots_removed, "place")} removed from ${plural(s.papers_changed, "paper")}; the remaining questions are renumbered${s.papers_emptied ? `, ${plural(s.papers_emptied, "paper")} left empty ${s.papers_emptied === 1 ? "is" : "are"} archived` : ""}`);
      if (s.imports_removed) lines.push(`${plural(s.imports_removed, "import")} removed from your import history`);
      nothing = s.delete === 0;
    } else {
      const add = (k: string, text: (n: number) => string) => { if (k in s) lines.push(text(s[k])); };
      add("subject", (n) => `${plural(n, "question")}: subject changes`);
      add("topics_added", (n) => `${plural(n, "topic tag")} added`);
      add("topics_reweighted", (n) => `${plural(n, "topic weight")} changed`);
      add("topics_removed", (n) => `${plural(n, "topic tag")} removed`);
      add("answer_format", (n) => `${plural(n, "question")}: answer format changes`);
      add("marks", (n) => `${plural(n, "question")}: marks change`);
      for (const f of preview.fields) lines.push(`${plural(f.n, "question")}: “${f.name}” changes`);
      add("fields_cleared", (n) => `${plural(n, "custom field value")} cleared`);
      add("notes", (n) => `${plural(n, "question")}: notes change`);
      add("archive", (n) => `${plural(n, "question")} archived`);
      add("unarchive", (n) => `${plural(n, "question")} brought back from the archive`);
      if (preview.created?.subjects?.length) lines.push(`New subject created: ${preview.created.subjects.join(", ")}`);
      if (preview.created?.topics?.length) lines.push(`New topics created: ${preview.created.topics.join("; ")}`);
      const counted = Object.entries(s).filter(([k]) => k !== "found").map(([, v]) => v as number);
      nothing = counted.every((v) => v === 0) && !preview.fields.some((f: any) => f.n) && !preview.created?.subjects?.length && !preview.created?.topics?.length;
    }
  }

  const addTopic = (row: TopicRow) => {
    if (topics.some((t) => t.label === row.label)) return;
    setTopics([...topics, row]);
    changed();
  };

  return (
    <Modal title={props.title ?? `Edit ${plural(props.ids.length, "question")}`} onClose={props.onClose} wide>
      <ErrorBox error={err} />
      {!del && (
        <>
          <label class="field">Subject
            <select value={subject} onChange={(e) => { setSubject((e.target as HTMLSelectElement).value); changed(); }}>
              <option value="__keep">Leave as is</option>
              <option value="__clear">Clear — no subject</option>
              {activeSubjects.map((s) => <option value={s.id}>{s.name}</option>)}
              <option value="__new">New subject…</option>
            </select>
            {subject === "__new" && <input placeholder="Name of the new subject" value={newSubject} aria-label="New subject name" onInput={(e) => { setNewSubject((e.target as HTMLInputElement).value); changed(); }} />}
          </label>

          <div class="field">Topics
            <select value={topicMode} aria-label="Topics: action" onChange={(e) => { setTopicMode((e.target as HTMLSelectElement).value as any); changed(); }}>
              <option value="keep">Leave as is</option>
              <option value="add">Add topics (or change their weight)</option>
              <option value="replace">Replace all topics with…</option>
              <option value="remove">Remove chosen topics</option>
              <option value="clear">Clear all topics</option>
            </select>
            {topicMode === "clear" && <span class="small warn-text">Every topic tag is removed from these questions.</span>}
            {(topicMode === "add" || topicMode === "replace" || topicMode === "remove") && (
              <div class="stack topic-box">
                {topics.map((t, i) => (
                  <div class="row">
                    <span class="grow small">{t.label}{t.concept_id ? "" : " (new)"}</span>
                    {topicMode !== "remove" && (
                      <input type="number" step="0.1" min="0.1" max="1" class="w5" aria-label="Weight" value={t.weight}
                        onInput={(e) => { setTopics(topics.map((x, j) => (j === i ? { ...x, weight: Number((e.target as HTMLInputElement).value) } : x))); changed(); }} />
                    )}
                    <button class="icon" aria-label="Take off the list" onClick={() => { setTopics(topics.filter((_, j) => j !== i)); changed(); }}>×</button>
                  </div>
                ))}
                <div class="row">
                  <select class="grow" value={pick} aria-label="Existing topic" onChange={(e) => setPick((e.target as HTMLSelectElement).value)}>
                    <option value="">choose an existing topic…</option>
                    {boot.concepts.filter((c) => !c.archived_at).map((c) => (
                      <option value={c.id}>{boot.subjects.find((s) => s.id === c.subject_id)?.name}: {conceptPath(boot, c.id)}</option>
                    ))}
                  </select>
                  <button class="btn small" disabled={!pick} onClick={() => {
                    const c = boot.concepts.find((x) => x.id === pick)!;
                    addTopic({ concept_id: pick, weight: 1, label: `${boot.subjects.find((s) => s.id === c.subject_id)?.name}: ${conceptPath(boot, pick)}` });
                    setPick("");
                  }}>Add</button>
                </div>
                {topicMode !== "remove" && (
                  <div class="row wrap">
                    <input class="grow" placeholder="or type a new topic, e.g. Number > Fractions" value={newPath} aria-label="New topic path" onInput={(e) => setNewPath((e.target as HTMLInputElement).value)} />
                    {!(subject !== "__keep" && subject !== "__clear") && (
                      <select value={newPathSubject} aria-label="Subject of the new topic" onChange={(e) => setNewPathSubject((e.target as HTMLSelectElement).value)}>
                        {activeSubjects.map((s) => <option value={s.id}>under {s.name}</option>)}
                      </select>
                    )}
                    <button class="btn small" disabled={!newPath.trim() || !subjectForNewTopic()} onClick={() => {
                      const path = newPath.split(/\s*(?:>|›|»|→)\s*/).map((x) => x.trim()).filter(Boolean);
                      const sub = subjectForNewTopic()!;
                      const subName = "name" in sub ? sub.name : boot.subjects.find((s) => s.id === sub.id)?.name;
                      addTopic({ path, subject: sub, weight: 1, label: `${subName}: ${path.join(" › ")}` });
                      setNewPath("");
                    }}>Add new topic</button>
                  </div>
                )}
                {topicMode === "replace" && !topics.length && <span class="small warn-text">An empty list removes every topic.</span>}
              </div>
            )}
          </div>

          <div class="grid2">
            <label class="field">Answer format
              <select value={format} onChange={(e) => { setFormat((e.target as HTMLSelectElement).value); changed(); }}>
                <option value="__keep">Leave as is</option>
                {Object.entries(FORMAT_LABEL).map(([v, l]) => <option value={v}>{l}</option>)}
              </select>
            </label>
            <div class="field">Marks
              <div class="row">
                <select value={marksMode} aria-label="Marks: action" onChange={(e) => { setMarksMode((e.target as HTMLSelectElement).value as any); changed(); }}>
                  <option value="keep">Leave as is</option><option value="set">Set to…</option><option value="clear">Clear</option>
                </select>
                {marksMode === "set" && <input type="number" min="0" step="any" class="w5" aria-label="Marks value" value={marks} onInput={(e) => { setMarks((e.target as HTMLInputElement).value); changed(); }} />}
              </div>
            </div>
          </div>

          {activeFields.length > 0 && (
            <div class="field">Custom fields
              <label class="small"><input type="checkbox" checked={clearAllFields} onChange={(e) => { setClearAllFields((e.target as HTMLInputElement).checked); changed(); }} /> Clear all custom fields (including Tags)</label>
              {!clearAllFields && activeFields.map((f) => {
                const fe = fields[f.id] ?? { action: "keep", value: "" };
                const set = (n: Partial<FieldEdit>) => { setFields({ ...fields, [f.id]: { ...fe, ...n } }); changed(); };
                return (
                  <div class="row wrap field-row">
                    <span class="w8 small">{f.name}</span>
                    <select value={fe.action} aria-label={`${f.name}: action`} onChange={(e) => set({ action: (e.target as HTMLSelectElement).value as any })}>
                      <option value="keep">Leave as is</option><option value="set">Set to…</option><option value="clear">Clear</option>
                    </select>
                    {fe.action === "set" && (f.data_type === "boolean" ? (
                      <select value={fe.value} aria-label={`${f.name}: value`} onChange={(e) => set({ value: (e.target as HTMLSelectElement).value })}>
                        <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
                      </select>
                    ) : (
                      <input type={(f.data_type === "number" ? "number" : f.data_type === "date" ? "date" : "text") as any} value={fe.value} aria-label={`${f.name}: value`}
                        onInput={(e) => set({ value: (e.target as HTMLInputElement).value })} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          <div class="field">Notes
            <select value={notesMode} aria-label="Notes: action" onChange={(e) => { setNotesMode((e.target as HTMLSelectElement).value as any); changed(); }}>
              <option value="keep">Leave as is</option><option value="set">Replace with…</option><option value="append">Add a line…</option><option value="clear">Clear</option>
            </select>
            {(notesMode === "set" || notesMode === "append") && <textarea rows={2} aria-label="Note text" value={notes} onInput={(e) => { setNotes((e.target as HTMLTextAreaElement).value); changed(); }} />}
          </div>

          <label class="field">Archive
            <select value={status} onChange={(e) => { setStatus((e.target as HTMLSelectElement).value as any); changed(); }}>
              <option value="keep">Leave as is</option>
              <option value="archive">Archive (hide, keep everything)</option>
              <option value="unarchive">Bring back from the archive</option>
            </select>
          </label>
        </>
      )}

      <div class={`danger-zone ${del ? "on" : ""}`}>
        {!del ? (
          <div class="row wrap">
            <span class="grow small"><b>Delete permanently</b> — removes these questions and everything attached to them.</span>
            <button class="btn danger small" onClick={() => { setDel(true); setConfirmText(""); changed(); }}>Delete {plural(props.ids.length, "question")}…</button>
          </div>
        ) : (
          <>
            <strong>Delete {plural(props.ids.length, "question")} permanently</strong>
            <p class="small">This removes the questions, all their versions, solutions, answer keys, topic tags and field values, <b>and your attempts and grades on them</b>; they disappear from any paper. It cannot be undone (a short record stays in the change log). Download a backup in Settings first if you may want them back.</p>
            <label class="small"><input type="checkbox" checked={removeImports} onChange={(e) => { setRemoveImports((e.target as HTMLInputElement).checked); changed(); }} /> Also remove imports that are left with no questions from the import history</label>
            {!props.startWithDelete && <div><button class="btn ghost small" onClick={() => { setDel(false); changed(); }}>← Back to editing instead</button></div>}
          </>
        )}
      </div>

      {preview && (
        <div class={nothing ? "warn-box" : del ? "error-box" : "ok-box"}>
          <strong>Preview — {plural(preview.summary.found, "question")} selected</strong>
          {nothing ? <p class="small">Nothing would change.</p> : <ul>{lines.map((l) => <li>{l}</li>)}</ul>}
          {del && !nothing && (
            <label class="field">Type DELETE to confirm
              <input value={confirmText} aria-label="Type DELETE to confirm" onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)} />
            </label>
          )}
        </div>
      )}

      <div class="row end">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        {!preview ? (
          <button class={`btn primary ${del ? "danger" : ""}`} disabled={busy} onClick={() => run(true)}>{busy ? "Checking…" : del ? "Preview what will be deleted" : "Preview changes"}</button>
        ) : (
          <button class={`btn primary ${del ? "danger" : ""}`} disabled={busy || nothing || (del && confirmText.trim() !== "DELETE")} onClick={() => run(false)}>
            {busy ? "Saving…" : del ? "Delete permanently" : "Apply changes"}
          </button>
        )}
      </div>
    </Modal>
  );
}
