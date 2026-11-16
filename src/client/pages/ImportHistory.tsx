// R1/R2: every import, by time, searchable, with a name and a note; open exactly the
// questions an import brought in for bulk editing, or archive / restore them all.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { emptyFilter } from "../filter";
import { refresh, setPendingFilter } from "../store";
import { ErrorBox, fmtDateTime, toast } from "../ui";

interface Row {
  id: string; file_name: string; label: string | null; note: string | null; parser_version: string; committed_at: number;
  found_count: number; new_count: number; new_version_count: number; duplicate_count: number; rejected_count: number;
  question_count: number; active_count: number; archived_count: number;
}

export function editImportQuestions(ids: string[]) {
  const def = emptyFilter();
  def.includeArchived = true;
  def.groups[0].conds.push({ type: "import", ids });
  setPendingFilter({ def, selectAll: true, openBulk: true });
  location.hash = "#/library";
}

export function ImportHistory() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [newest, setNewest] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const load = () => api("GET", "/api/imports").then((r) => setRows(r.imports)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = (rows ?? []).filter((r) => {
      const hay = `${r.label ?? ""} ${r.note ?? ""} ${r.file_name} ${fmtDateTime(r.committed_at)} ${new Date(r.committed_at).toISOString().slice(0, 10)}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    return list.sort((a, b) => (newest ? b.committed_at - a.committed_at : a.committed_at - b.committed_at));
  }, [rows, q, newest]);

  const saveMeta = async (id: string) => {
    try {
      await api("PATCH", `/api/imports/${id}`, { label, note });
      setEditing(null);
      await load();
      await refresh();
      toast("Saved");
    } catch (e) { toast((e as Error).message, "error"); }
  };
  const archive = async (r: Row, archived: boolean) => {
    if (archived && !confirm(`Archive every question first added by “${r.label || r.file_name}”? Nothing is deleted; you can bring them back here.`)) return;
    try {
      const res = await api("POST", `/api/imports/${r.id}/archive`, { archived });
      toast(`${archived ? "Archived" : "Restored"} ${res.changed} question(s)`);
      await load();
      await refresh();
    } catch (e) { toast((e as Error).message, "error"); }
  };

  return (
    <section class="card" id="imports">
      <div class="row wrap">
        <h2 class="grow">Your imports</h2>
        <button class="btn ghost small" onClick={() => setNewest(!newest)}>{newest ? "Newest first ↓" : "Oldest first ↑"}</button>
      </div>
      <ErrorBox error={err} />
      <input type="search" class="block-input" placeholder="Search by name, note, file or date (e.g. 2026-11-14)" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search imports" />
      {picked.size > 1 && (
        <div class="row wrap picked-bar">
          <span class="small"><b>{picked.size}</b> imports chosen</span>
          <button class="btn primary small" onClick={() => editImportQuestions([...picked])}>Edit their questions together</button>
          <button class="btn ghost small" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {!rows ? <p class="muted">Loading…</p> : shown.length === 0 ? <p class="muted">{rows.length ? "No import matches." : "No imports yet."}</p> : (
        <ul class="imports">
          {shown.map((r) => (
            <li class="import-row">
              <div class="row wrap">
                <input type="checkbox" aria-label={`Choose import ${r.label || r.file_name}`} checked={picked.has(r.id)}
                  onChange={() => { const s = new Set(picked); s.has(r.id) ? s.delete(r.id) : s.add(r.id); setPicked(s); }} />
                <div class="grow">
                  <strong>{r.label || r.file_name}</strong>
                  <div class="small muted">
                    {fmtDateTime(r.committed_at)} · {r.label ? `${r.file_name} · ` : ""}{r.parser_version === "parse.ts@1" ? "old HTML importer" : "question pack"}
                  </div>
                  <div class="small">
                    {r.question_count} question{r.question_count === 1 ? "" : "s"} ({r.new_count} new{r.new_version_count ? `, ${r.new_version_count} new versions` : ""})
                    {r.duplicate_count ? ` · ${r.duplicate_count} were already in the library` : ""}
                    {r.archived_count ? <span class="muted"> · {r.archived_count} archived</span> : null}
                    {r.new_count + r.new_version_count > r.question_count ? <span class="muted"> · {r.new_count + r.new_version_count - r.question_count} since deleted</span> : null}
                  </div>
                  {r.note && editing !== r.id && <div class="small note">“{r.note}”</div>}
                </div>
                <div class="row wrap actions">
                  {r.question_count > 0 && <button class="btn primary small" onClick={() => editImportQuestions([r.id])}>Edit questions</button>}
                  <button class="btn ghost small" onClick={() => { setEditing(editing === r.id ? null : r.id); setLabel(r.label ?? ""); setNote(r.note ?? ""); }}>{editing === r.id ? "Cancel" : "Name / note"}</button>
                  {r.active_count > 0 && <button class="btn ghost small" onClick={() => archive(r, true)}>Archive</button>}
                  {r.archived_count > 0 && <button class="btn ghost small" onClick={() => archive(r, false)}>Restore</button>}
                </div>
              </div>
              {editing === r.id && (
                <div class="grid2 meta-edit">
                  <label class="field">Name<input value={label} placeholder="e.g. Olympiad set 2, batch 1" onInput={(e) => setLabel((e.target as HTMLInputElement).value)} /></label>
                  <label class="field">Note<input value={note} placeholder="anything to remember" onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
                  <div class="row end"><button class="btn primary small" onClick={() => saveMeta(r.id)}>Save</button></div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
