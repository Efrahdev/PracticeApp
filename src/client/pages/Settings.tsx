import { useState } from "preact/hooks";
import { api } from "../api";
import { exportArchive, restoreArchive, verifyArchive, type VerifyReport } from "../backup";
import { refresh, useData } from "../store";
import type { Boot } from "../types";
import { TaxonomyManager } from "./Taxonomy";
import { SortTable } from "../grid";
import { ErrorBox, Progress, ThemeSwitch, toast } from "../ui";

export function Settings() {
  const { boot, lib } = useData();
  if (!boot || !lib) return <p class="muted">Loading…</p>;
  return (
    <div class="page">
      <div class="page-head"><h1>Settings</h1><span class="muted small">Schema version {boot.schemaVersion}</span></div>
      <section class="card">
        <h2>Appearance</h2>
        <p class="small muted">Auto follows this device. Light uses a warm off-white that matches scanned question pages; question boxes and images keep their own colours in Dark.</p>
        <ThemeSwitch class="settings-theme" />
      </section>
      <section class="card">
        <h2>Imports</h2>
        <p class="small">Your import history — search, name, edit or archive whole imports — is on the <a href="#/import">Import</a> screen.</p>
      </section>
      <TaxonomyManager boot={boot} lib={lib} />
      <Fields boot={boot} />
      <Backup />
      <Health />
    </div>
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
        <SortTable rows={fields} initial={{ key: "name", dir: "asc" }} cols={[
          { key: "name", label: "Name", get: (f) => f.name, render: (f) => <span class={f.archived_at ? "muted" : ""}>{f.name}{f.archived_at ? " (archived)" : ""}</span> },
          { key: "type", label: "Type", get: (f) => f.data_type, render: (f) => (f.data_type === "boolean" ? "yes/no" : f.data_type) },
          { key: "filter", label: "Filter", get: (f) => f.is_filterable, first: "desc", render: (f) => <input type="checkbox" aria-label={`Filterable: ${f.name}`} checked={!!f.is_filterable} onChange={(e) => run(() => api("PATCH", `/api/fields/${f.id}`, { is_filterable: (e.target as HTMLInputElement).checked }), "Saved")} /> },
          { key: "act", label: "", class: "nowrap", render: (f) => (
            <>
              <button class="btn ghost small" onClick={() => { const n = prompt("Rename field:", f.name); if (n) run(() => api("PATCH", `/api/fields/${f.id}`, { name: n }), "Renamed"); }}>Rename</button>
              <button class="btn ghost small" onClick={() => run(() => api("PATCH", `/api/fields/${f.id}`, { archived: !f.archived_at }), f.archived_at ? "Restored" : "Archived")}>{f.archived_at ? "Unarchive" : "Archive"}</button>
            </>
          ) },
        ]} />
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
