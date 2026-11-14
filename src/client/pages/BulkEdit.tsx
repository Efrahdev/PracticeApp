// R3/R4: change many questions at once. Every field starts at "leave as is".
// "Preview changes" asks the server what would change (nothing is saved); "Apply"
// saves everything in one all-or-nothing step. Delete is separate and permanent.
import { useState } from "preact/hooks";
import { api } from "../api";
import { refresh } from "../store";
import type { Boot } from "../types";
import { conceptPath, ErrorBox, Modal, toast } from "../ui";

type Keep<T> = T | "__keep";
interface TopicRow { concept_id: string; weight: number }
interface FieldEdit { action: "keep" | "set" | "clear"; value: string }

const FORMAT_LABEL: Record<string, string> = {
  none: "None (grade yourself)", mcq_single: "Multiple choice — one answer", mcq_multi: "Multiple choice — several answers", numeric: "Number", text: "Text",
};

const SUMMARY_LABEL: Record<string, string> = {
  subject: "subject changes", answer_format: "answer format changes", notes: "notes change", archive: "archived", unarchive: "brought back from the archive",
  topics_added: "topic tags added", topics_reweighted: "topic weights changed", topics_removed: "topic tags removed",
};

export function BulkEdit(props: { boot: Boot; ids: string[]; onClose: () => void; onDone: () => void }) {
  const { boot } = props;
  const [subject, setSubject] = useState<Keep<string>>("__keep");
  const [topicMode, setTopicMode] = useState<"keep" | "add" | "replace" | "remove">("keep");
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [pick, setPick] = useState("");
  const [format, setFormat] = useState<Keep<string>>("__keep");
  const [fields, setFields] = useState<Record<string, FieldEdit>>({});
  const [notesMode, setNotesMode] = useState<"keep" | "set" | "append" | "clear">("keep");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"keep" | "archive" | "unarchive" | "delete">("keep");
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const del = status === "delete";
  const activeFields = boot.fields.filter((f) => !f.archived_at);

  const spec = () => {
    const s: any = { ids: props.ids };
    if (del) return { ...s, status: "delete" };
    if (subject !== "__keep") s.subject = { id: subject || null };
    if (topicMode !== "keep") s.topics = { mode: topicMode, items: topics };
    if (format !== "__keep") s.answer_format = format;
    const fl = Object.entries(fields).filter(([, f]) => f.action !== "keep").map(([field_id, f]) => ({ field_id, action: f.action, value: f.value }));
    if (fl.length) s.fields = fl;
    if (notesMode !== "keep") s.notes = { mode: notesMode, text: notes };
    if (status !== "keep") s.status = status;
    return s;
  };

  const run = async (dry: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", "/api/questions-bulk", { ...spec(), dry_run: dry });
      if (dry) setPreview(r);
      else {
        await refresh();
        const s = r.summary;
        toast(del ? `Deleted ${s.delete} question(s)${s.archive_instead ? `, archived ${s.archive_instead} that have history` : ""}` : "Changes saved");
        props.onDone();
      }
    } catch (e) {
      setErr((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const changed = () => setPreview(null); // any edit invalidates the preview

  const lines: string[] = [];
  if (preview) {
    const s = preview.summary;
    for (const [k, label] of Object.entries(SUMMARY_LABEL)) if (k in s) lines.push(`${s[k]} ${label}`);
    for (const f of preview.fields) lines.push(`${f.n} “${f.name}” values change`);
    if ("delete" in s) {
      lines.push(`${s.delete} deleted permanently`);
      if (s.kept_with_history) lines.push(`${s.kept_with_history} kept because they have attempts or are in papers${s.archive_instead ? ` — ${s.archive_instead} of them will be archived instead` : ""}`);
    }
  }
  const nothing = preview && !preview.fields.some((f: any) => f.n) && Object.entries(preview.summary).every(([k, v]) => k === "found" || k === "kept_with_history" || v === 0);

  return (
    <Modal title={`Edit ${props.ids.length} question${props.ids.length === 1 ? "" : "s"}`} onClose={props.onClose} wide>
      <ErrorBox error={err} />
      <fieldset class="bulk" disabled={del}>
        <label class="field">Subject
          <select value={subject} onChange={(e) => { setSubject((e.target as HTMLSelectElement).value); changed(); }}>
            <option value="__keep">Leave as is</option>
            <option value="">No subject</option>
            {boot.subjects.filter((s) => !s.archived_at).map((s) => <option value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <div class="field">Topics
          <select value={topicMode} onChange={(e) => { setTopicMode((e.target as HTMLSelectElement).value as any); changed(); }}>
            <option value="keep">Leave as is</option>
            <option value="add">Add these topics (or change their weight)</option>
            <option value="replace">Replace all topics with these</option>
            <option value="remove">Remove these topics</option>
          </select>
          {topicMode !== "keep" && (
            <div class="stack">
              {topics.map((t, i) => (
                <div class="row">
                  <span class="grow small">{conceptPath(boot, t.concept_id)}</span>
                  {topicMode !== "remove" && (
                    <input type="number" step="0.1" min="0.1" max="1" class="w5" aria-label="Weight" value={t.weight}
                      onInput={(e) => { setTopics(topics.map((x, j) => (j === i ? { ...x, weight: Number((e.target as HTMLInputElement).value) } : x))); changed(); }} />
                  )}
                  <button class="icon" aria-label="Remove topic from list" onClick={() => { setTopics(topics.filter((_, j) => j !== i)); changed(); }}>×</button>
                </div>
              ))}
              <div class="row">
                <select class="grow" value={pick} aria-label="Topic to add to the list" onChange={(e) => setPick((e.target as HTMLSelectElement).value)}>
                  <option value="">choose a topic…</option>
                  {boot.concepts.filter((c) => !c.archived_at && !topics.some((t) => t.concept_id === c.id)).map((c) => (
                    <option value={c.id}>{boot.subjects.find((s) => s.id === c.subject_id)?.name}: {conceptPath(boot, c.id)}</option>
                  ))}
                </select>
                <button class="btn small" disabled={!pick} onClick={() => { setTopics([...topics, { concept_id: pick, weight: 1 }]); setPick(""); changed(); }}>Add to list</button>
              </div>
              {topicMode === "replace" && !topics.length && <span class="small warn-text">An empty list removes every topic from these questions.</span>}
              <a class="small" href="#/settings">Create or rename topics in Settings</a>
            </div>
          )}
        </div>

        <label class="field">Answer format
          <select value={format} onChange={(e) => { setFormat((e.target as HTMLSelectElement).value); changed(); }}>
            <option value="__keep">Leave as is</option>
            {Object.entries(FORMAT_LABEL).map(([v, l]) => <option value={v}>{l}</option>)}
          </select>
        </label>

        {activeFields.length > 0 && (
          <div class="field">Custom fields
            {activeFields.map((f) => {
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
          <select value={notesMode} onChange={(e) => { setNotesMode((e.target as HTMLSelectElement).value as any); changed(); }}>
            <option value="keep">Leave as is</option><option value="set">Replace with…</option><option value="append">Add a line…</option><option value="clear">Clear</option>
          </select>
          {(notesMode === "set" || notesMode === "append") && <textarea rows={2} value={notes} onInput={(e) => { setNotes((e.target as HTMLTextAreaElement).value); changed(); }} />}
        </div>
      </fieldset>

      <div class="field">Status
        <select value={status} onChange={(e) => { setStatus((e.target as HTMLSelectElement).value as any); setConfirmText(""); changed(); }}>
          <option value="keep">Leave as is</option>
          <option value="archive">Archive (hide, keep everything)</option>
          <option value="unarchive">Bring back from the archive</option>
          <option value="delete">Delete permanently</option>
        </select>
        {del && (
          <div class="warn-box small">
            Deleting removes the questions, their versions, solutions, answer keys, topics and field values for good (a short record stays in the change log).
            Questions you have already attempted, or that are in a paper, cannot be deleted without breaking your history — they are archived instead.
            Other changes are switched off while Delete is chosen.
          </div>
        )}
      </div>

      {preview && (
        <div class={nothing ? "warn-box" : "ok-box"}>
          <strong>Preview — {preview.summary.found} question{preview.summary.found === 1 ? "" : "s"} selected</strong>
          {nothing ? <p class="small">Nothing would change.</p> : <ul>{lines.map((l) => <li>{l}</li>)}</ul>}
          {del && !nothing && preview.summary.delete > 0 && (
            <label class="field">Type DELETE to confirm
              <input value={confirmText} onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)} />
            </label>
          )}
        </div>
      )}

      <div class="row end">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        {!preview ? (
          <button class="btn primary" disabled={busy} onClick={() => run(true)}>{busy ? "Checking…" : "Preview changes"}</button>
        ) : (
          <button class={`btn primary ${del ? "danger" : ""}`} disabled={busy || nothing || (del && preview.summary.delete > 0 && confirmText.trim() !== "DELETE")} onClick={() => run(false)}>
            {busy ? "Saving…" : del ? "Delete now" : "Apply changes"}
          </button>
        )}
      </div>
    </Modal>
  );
}
