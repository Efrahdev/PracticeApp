import { useState } from "preact/hooks";
import { api } from "../api";
import { exportArchive, restoreArchive, verifyArchive, type VerifyReport } from "../backup";
import { refresh, useData } from "../store";
import type { Boot, Concept } from "../types";
import { ErrorBox, fmtDateTime, Progress, toast } from "../ui";
import { useEffect } from "preact/hooks";

export function Settings() {
  const { boot } = useData();
  if (!boot) return <p class="muted">Loading…</p>;
  return (
    <div class="page">
      <div class="page-head"><h1>Settings</h1><span class="muted small">Schema version {boot.schemaVersion}</span></div>
      <Imports />
      <Taxonomy boot={boot} />
      <Fields boot={boot} />
      <Backup />
      <Health />
    </div>
  );
}

function Taxonomy(props: { boot: Boot }) {
  const { boot } = props;
  const [newSubject, setNewSubject] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); await refresh(); toast(ok); } catch (e) { toast((e as Error).message, "error"); }
  };
  const subjects = boot.subjects.filter((s) => showArchived || !s.archived_at);
  return (
    <section class="card">
      <div class="row wrap"><h2 class="grow">Subjects &amp; concepts</h2>
        <label class="small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived((e.target as HTMLInputElement).checked)} /> show archived</label></div>
      <p class="muted small">Nothing is ever deleted — archiving hides an item but keeps all history. Renaming never breaks past data.</p>
      <div class="row">
        <input class="grow" placeholder="New subject name" value={newSubject} onInput={(e) => setNewSubject((e.target as HTMLInputElement).value)} />
        <button class="btn" disabled={!newSubject.trim()} onClick={() => run(async () => { await api("POST", "/api/subjects", { name: newSubject }); setNewSubject(""); }, "Subject added")}>Add subject</button>
      </div>
      {subjects.map((s) => (
        <details class="subject" open={subjects.length < 4}>
          <summary>
            <strong>{s.name}</strong> {s.archived_at && <span class="badge muted">archived</span>}
            <span class="muted small"> · {boot.concepts.filter((c) => c.subject_id === s.id && !c.archived_at).length} concepts</span>
          </summary>
          <div class="row wrap small">
            <button class="btn ghost small" onClick={() => { const name = prompt("Rename subject:", s.name); if (name) run(() => api("PATCH", `/api/subjects/${s.id}`, { name }), "Renamed"); }}>Rename</button>
            <button class="btn ghost small" onClick={() => run(() => api("PATCH", `/api/subjects/${s.id}`, { archived: !s.archived_at }), s.archived_at ? "Restored" : "Archived")}>{s.archived_at ? "Unarchive" : "Archive"}</button>
            <button class="btn ghost small" onClick={() => { const name = prompt("New top-level concept:"); if (name) run(() => api("POST", "/api/concepts", { subject_id: s.id, name }), "Concept added"); }}>+ Concept</button>
          </div>
          <ConceptTree boot={boot} subjectId={s.id} parentId={null} showArchived={showArchived} run={run} />
        </details>
      ))}
    </section>
  );
}

function ConceptTree(props: { boot: Boot; subjectId: string; parentId: string | null; showArchived: boolean; run: (fn: () => Promise<unknown>, ok: string) => void }) {
  const { boot, run } = props;
  const kids = boot.concepts.filter((c) => c.subject_id === props.subjectId && c.parent_id === props.parentId && (props.showArchived || !c.archived_at));
  if (!kids.length) return null;
  const others = (c: Concept) => boot.concepts.filter((x) => x.subject_id === c.subject_id && x.id !== c.id && !x.archived_at);
  return (
    <ul class="tree">
      {kids.map((c) => (
        <li>
          <div class="row wrap">
            <span class={c.archived_at ? "muted" : ""}>{c.name}</span>
            <span class="grow" />
            <button class="btn ghost small" onClick={() => { const name = prompt("Sub-concept of " + c.name + ":"); if (name) run(() => api("POST", "/api/concepts", { subject_id: c.subject_id, parent_id: c.id, name }), "Added"); }}>+ Sub</button>
            <button class="btn ghost small" onClick={() => { const name = prompt("Rename concept:", c.name); if (name) run(() => api("PATCH", `/api/concepts/${c.id}`, { name }), "Renamed"); }}>Rename</button>
            <select class="small" aria-label="Move under" value={c.parent_id ?? ""} onChange={(e) => run(() => api("PATCH", `/api/concepts/${c.id}`, { parent_id: (e.target as HTMLSelectElement).value || null }), "Moved")}>
              <option value="">(top level)</option>
              {others(c).map((o) => <option value={o.id}>under {o.name}</option>)}
            </select>
            <button class="btn ghost small" onClick={() => run(() => api("PATCH", `/api/concepts/${c.id}`, { archived: !c.archived_at }), c.archived_at ? "Restored" : "Archived")}>{c.archived_at ? "Unarchive" : "Archive"}</button>
          </div>
          <ConceptTree {...props} parentId={c.id} />
        </li>
      ))}
    </ul>
  );
}

function Imports() {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = () => api("GET", "/api/imports").then((r) => setRows(r.imports)).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const archive = async (id: string, archived: boolean, label: string) => {
    if (archived && !confirm(`Archive every question first added by “${label}”? They disappear from the library and papers you build, but nothing is deleted and you can bring them back here.`)) return;
    try {
      const r = await api("POST", `/api/imports/${id}/archive`, { archived });
      toast(`${archived ? "Archived" : "Restored"} ${r.changed} question(s)`);
      await load();
      await refresh();
    } catch (e) { toast((e as Error).message, "error"); }
  };
  return (
    <section class="card">
      <h2>Import history</h2>
      <p class="muted small">Every import is kept. If an import went wrong, archive its questions here (nothing is deleted; attempts stay), then import a corrected pack.</p>
      {!rows ? <p class="muted">Loading…</p> : rows.length === 0 ? <p class="muted">No imports yet.</p> : (
        <table class="table">
          <thead><tr><th>File</th><th class="hide-sm">When</th><th>Added</th><th>Active</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr>
              <td>{r.file_name}<div class="small muted">{r.parser_version === "parse.ts@1" ? "old HTML importer" : "question pack"}{r.duplicate_count ? ` · ${r.duplicate_count} already had` : ""}</div></td>
              <td class="hide-sm small">{fmtDateTime(r.committed_at)}</td>
              <td>{r.new_count}{r.new_version_count ? ` + ${r.new_version_count} v` : ""}</td>
              <td>{r.active_count}{r.archived_count ? <span class="muted small"> ({r.archived_count} archived)</span> : null}</td>
              <td class="nowrap">
                {r.active_count > 0 && <button class="btn ghost small" onClick={() => archive(r.id, true, r.file_name)}>Archive</button>}
                {r.archived_count > 0 && <button class="btn ghost small" onClick={() => archive(r.id, false, r.file_name)}>Restore</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function Fields(props: { boot: Boot }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); await refresh(); toast(ok); } catch (e) { toast((e as Error).message, "error"); }
  };
  const fields = props.boot.fields ?? [];
  return (
    <section class="card">
      <h2>Custom fields</h2>
      <p class="muted small">Extra facts about questions (exam board, year, paper…). Imports create them from a pack's <code>fields</code>. Filterable ones appear in the library filter.</p>
      {fields.length > 0 && (
        <table class="table">
          <thead><tr><th>Name</th><th>Type</th><th>Filter</th><th /></tr></thead>
          <tbody>{fields.map((f) => (
            <tr class={f.archived_at ? "muted" : ""}>
              <td>{f.name}</td><td>{f.data_type === "boolean" ? "yes/no" : f.data_type}</td>
              <td><input type="checkbox" aria-label={`Filterable: ${f.name}`} checked={!!f.is_filterable} onChange={(e) => run(() => api("PATCH", `/api/fields/${f.id}`, { is_filterable: (e.target as HTMLInputElement).checked }), "Saved")} /></td>
              <td class="nowrap">
                <button class="btn ghost small" onClick={() => { const n = prompt("Rename field:", f.name); if (n) run(() => api("PATCH", `/api/fields/${f.id}`, { name: n }), "Renamed"); }}>Rename</button>
                <button class="btn ghost small" onClick={() => run(() => api("PATCH", `/api/fields/${f.id}`, { archived: !f.archived_at }), f.archived_at ? "Restored" : "Archived")}>{f.archived_at ? "Unarchive" : "Archive"}</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div class="row wrap">
        <input class="grow" placeholder="New field name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes/no</option>
        </select>
        <button class="btn" disabled={!name.trim()} onClick={() => run(async () => { await api("POST", "/api/fields", { name, data_type: type }); setName(""); }, "Field added")}>Add field</button>
      </div>
    </section>
  );
}

function Backup() {
  const [progress, setProgress] = useState<{ msg: string; frac: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [restoreResult, setRestoreResult] = useState<any>(null);

  const doExport = async () => {
    setErr(null);
    try {
      const blob = await exportArchive((msg, frac) => setProgress({ msg, frac }));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `practice-app-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast("Backup downloaded — keep a copy off Cloudflare");
    } catch (e) { setErr((e as Error).message); } finally { setProgress(null); }
  };

  const onPick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setRestoreResult(null);
    setProgress({ msg: "Checking archive…", frac: 0.1 });
    try { setVerify(await verifyArchive(await f.arrayBuffer())); } catch (e) { setErr((e as Error).message); } finally { setProgress(null); }
  };

  const doRestore = async () => {
    if (!verify) return;
    setErr(null);
    try {
      const r = await restoreArchive(verify, (msg, frac) => setProgress({ msg, frac }));
      setRestoreResult(r);
      setVerify(null);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setProgress(null); }
  };

  return (
    <section class="card">
      <h2>Backup &amp; restore</h2>
      <p class="muted small">The archive holds every question file, all metadata, filters, papers, attempts and grades, a checksum list, and spreadsheet copies (CSV) of questions and attempts. Make one weekly and keep it off Cloudflare.</p>
      <ErrorBox error={err} />
      {progress && <Progress {...progress} />}
      <div class="row wrap">
        <button class="btn primary" disabled={!!progress} onClick={doExport}>Download backup archive</button>
        <label class="btn">Restore from archive…<input type="file" accept=".zip" hidden onChange={(e) => onPick((e.target as HTMLInputElement).files?.[0])} /></label>
      </div>
      {verify && (
        <div class={verify.ok ? "ok-box" : "error-box"}>
          {verify.ok ? (
            <>
              <p>Archive checked: every file matches its checksum. Exported {verify.manifest?.exported_at_utc}, {verify.manifest?.counts?.question ?? 0} questions, {verify.manifest?.counts?.attempt ?? 0} attempts.</p>
              <p class="small">Restore only works into an empty database (see README → “Restore”).</p>
              <button class="btn primary" disabled={!!progress} onClick={doRestore}>Restore now</button>
            </>
          ) : (
            <><p>This archive failed its checks, so it cannot be restored:</p><ul>{verify.problems.slice(0, 20).map((p) => <li>{p}</li>)}</ul></>
          )}
        </div>
      )}
      {restoreResult && <IntegrityReport r={restoreResult} title="Restore finished" />}
    </section>
  );
}

function Health() {
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string) => {
    setBusy(true);
    try {
      const res = await api("POST", path);
      setR(path.includes("rebuild") ? { rebuild: res } : res);
      await refresh();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  };
  return (
    <section class="card">
      <h2>Data health</h2>
      <p class="muted small">The integrity check looks for missing files, broken links, and live metrics that differ from a rebuild from history.</p>
      <div class="row wrap">
        <button class="btn" disabled={busy} onClick={() => run("/api/admin/integrity")}>Run integrity check</button>
        <button class="btn" disabled={busy} onClick={() => run("/api/admin/rebuild-metrics")}>Rebuild all metrics</button>
      </div>
      {r?.rebuild && (
        <div class="ok-box">Metrics rebuilt. Rows that differed before: {Object.entries(r.rebuild.mismatches_before).map(([k, v]) => `${k} ${v}`).join(", ")}. After: {Object.values(r.rebuild.mismatches_after).every((v) => v === 0) ? "all identical ✓" : JSON.stringify(r.rebuild.mismatches_after)}</div>
      )}
      {r && !r.rebuild && <IntegrityReport r={r} title="Integrity check" />}
    </section>
  );
}

function IntegrityReport(props: { r: any; title: string }) {
  const { r } = props;
  return (
    <div class={r.errors ? "error-box" : "ok-box"}>
      <strong>{props.title}: {r.errors ? `${r.errors} problem(s)` : "no problems found ✓"}</strong> <span class="small">({r.checked_files} files checked)</span>
      {r.issues.length > 0 && <ul>{r.issues.map((i: any) => <li class={i.kind === "warning" ? "warning" : "error"}>{i.detail}</li>)}</ul>}
    </div>
  );
}
