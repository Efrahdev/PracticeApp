import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { openBuilder, useData } from "../store";
import type { LibQ } from "../types";
import { askConfirm, ErrorBox, fmtDate, fmtDateTime, ResultBadge, toast } from "../ui";
import { describeBlueprint, subjectSlot } from "../builder/describe";
import { DataGrid, type GridCol } from "../grid";
import { Icon, Segmented } from "../builder/controls";
import { PaperTable, type TableRow } from "../builder/PaperTable";
import { makeCtx } from "../builder/pool";
import { normaliseBlueprint } from "../builder/spec";
import { PaperSummary } from "./Practice";
import { openPrint, type PrintSolutions } from "../print";

interface PaperRow {
  id: string; name: string; created_at: number; solutions_mode: string; item_count: number; total_marks: number | null;
  subject_ids: string | null; open_session_id: string | null; open_position: number | null; completed_sessions: number;
  last_completed_at: number | null; last_score: number | null; best_score: number | null;
}

const scoreText = (p: number | null) => (p === null || p === undefined ? null : `${Math.round(p / 10)}%`);

export function Papers() {
  const { boot, lib } = useData();
  const [papers, setPapers] = useState<PaperRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "new" | "open" | "done">("");
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  const load = () => api("GET", "/api/papers").then((r) => setPapers(r.papers)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!papers || !ctx) return <p class="muted">Loading…</p>;

  const statusOf = (p: PaperRow) => (p.open_session_id ? "open" : p.completed_sessions ? "done" : "new");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const subjectsOf = (p: PaperRow): string[] => { try { return (JSON.parse(p.subject_ids ?? "[]") as (string | null)[]).filter((x): x is string => !!x); } catch { return []; } };
  const rows = papers.filter((p) => (!status || statusOf(p) === status) && terms.every((t) => `${p.name} ${subjectsOf(p).map((s) => ctx.subjectName.get(s)).join(" ")}`.toLowerCase().includes(t)));
  const scored = papers.filter((p) => p.last_score !== null);
  const avg = scored.length ? scored.reduce((a, p) => a + (p.last_score ?? 0), 0) / scored.length : null;
  const print = async (p: PaperRow) => {
    try {
      const d = await api("GET", `/api/papers/${p.id}`);
      await openPrint(d, d.paper.solutions_mode === "hidden" ? "none" : "end");
    } catch (e) { toast((e as Error).message, "error"); }
  };
  const hide = async (p: PaperRow) => {
    if (!(await askConfirm({ title: `Hide “${p.name}”?`, message: "It leaves this list. Its history stays.", confirmLabel: "Hide" }))) return;
    try {
      await api("DELETE", `/api/papers/${p.id}`);
      toast("Paper hidden");
      load();
    } catch (e) { toast((e as Error).message, "error"); }
  };
  const remove = async (p: PaperRow) => {
    if (await deletePaper(p.id, p.name)) load();
  };

  const cols: GridCol<PaperRow>[] = [
    {
      id: "name", label: "Paper", min: 220, fr: 2.6, fixed: true, sticky: true, card: "main", sortValue: (p) => p.name,
      render: (p) => (
        <div class="dt-q">
          <a class="dt-qno paper-name" href={`#/papers/${p.id}`}>{p.name}</a>
          <span class="sub">Made {fmtDate(p.created_at)}</span>
        </div>
      ),
    },
    { id: "status", label: "Status", min: 120, fr: 1, prio: 1, sortValue: (p) => ({ open: 0, new: 1, done: 2 })[statusOf(p)], render: (p) => {
      const st = statusOf(p);
      return st === "open" ? <span class="res"><i class="dot seg-st-warn" aria-hidden="true" />In progress <span class="sub">· Q{p.open_position}/{p.item_count}</span></span>
        : st === "done" ? <span class="res"><i class="dot seg-st-good" aria-hidden="true" />Done {p.completed_sessions > 1 ? `${p.completed_sessions}×` : ""}</span>
        : <span class="res"><i class="dot seg-st-none" aria-hidden="true" />Not started</span>;
    } },
    { id: "questions", label: "Questions", min: 92, fr: 0.6, prio: 2, align: "end", firstDir: "desc", sortValue: (p) => p.item_count, render: (p) => <span class="num">{p.item_count}</span> },
    { id: "marks", label: "Marks", min: 72, fr: 0.5, prio: 3, align: "end", firstDir: "desc", sortValue: (p) => p.total_marks, render: (p) => (p.total_marks === null ? <span class="muted">—</span> : <span class="num">{Number.isInteger(p.total_marks) ? p.total_marks : p.total_marks.toFixed(1)}</span>) },
    { id: "subjects", label: "Subjects", min: 150, fr: 1.5, prio: 4, card: "full", sortValue: (p) => subjectsOf(p).map((s) => ctx.subjectName.get(s)).sort().join(", ") || null, render: (p) => {
      const ss = subjectsOf(p);
      if (!ss.length) return <span class="muted">—</span>;
      return <div class="subj-list">{ss.map((sid) => <span class="dt-subj"><i class={`sw seg-s${subjectSlot(ctx, sid)}`} aria-hidden="true" />{ctx.subjectName.get(sid) ?? "?"}</span>)}</div>;
    } },
    { id: "last", label: "Last score", min: 96, fr: 0.6, prio: 5, align: "end", firstDir: "desc", sortValue: (p) => p.last_score, render: (p) => scoreText(p.last_score) ? <span class="num strong">{scoreText(p.last_score)}</span> : <span class="muted">—</span> },
    { id: "best", label: "Best", min: 76, fr: 0.5, prio: 6, align: "end", firstDir: "desc", sortValue: (p) => p.best_score, render: (p) => scoreText(p.best_score) ? <span class="num">{scoreText(p.best_score)}</span> : <span class="muted">—</span> },
    { id: "solutions", label: "Solutions", min: 120, fr: 0.9, prio: 7, sortValue: (p) => p.solutions_mode, render: (p) => (p.solutions_mode === "hidden" ? <span class="pb-badge muted">Test conditions</span> : <span class="pb-badge ok">Included</span>) },
    { id: "lastSat", label: "Last sat", min: 104, fr: 0.8, prio: 8, firstDir: "desc", sortValue: (p) => p.last_completed_at, render: (p) => (p.last_completed_at ? <span>{fmtDate(p.last_completed_at)}</span> : <span class="muted">—</span>) },
    { id: "created", label: "Made", min: 104, fr: 0.8, firstDir: "desc", sortValue: (p) => p.created_at, render: (p) => <span>{fmtDate(p.created_at)}</span> },
    {
      id: "actions", label: "", min: 0, fr: 0, px: 242, fixed: true, card: "full",
      render: (p) => (
        <div class="dt-acts paper-acts">
          <a class={`btn small${p.open_session_id ? " primary" : ""}`} href={`#/practice/${p.id}`}>{p.open_session_id ? "Resume" : p.completed_sessions ? "Sit again" : "Start"}</a>
          <button type="button" class="dt-ib" aria-label={`Print ${p.name}`} title="Print / PDF" onClick={() => print(p)}><Icon name="save" /></button>
          <a class="dt-ib" href={`#/papers/${p.id}`} aria-label={`Open ${p.name}`} title="Open"><Icon name="external" /></a>
          <button type="button" class="dt-ib" aria-label={`Hide ${p.name}`} title="Hide this paper (history stays)" onClick={() => hide(p)}><Icon name="eyeOff" /></button>
          <button type="button" class="dt-ib danger" aria-label={`Delete ${p.name}`} title="Delete this paper permanently" onClick={() => remove(p)}><Icon name="trash" /></button>
        </div>
      ),
    },
  ];

  return (
    <div class="lib">
      <header class="pb-top">
        <div class="pb-top-main">
          <span class="pb-h1">Papers</span>
          <h1 class="lib-h1">Saved papers</h1>
        </div>
        <div class="pb-top-actions">
          <button type="button" class="btn primary" onClick={() => openBuilder()}><Icon name="target" size={15} /> Build paper</button>
        </div>
      </header>
      {papers.length === 0 ? (
        <div class="empty card">
          <p><b>No papers yet.</b></p>
          <p class="muted">Build one from the whole library, or filter the Library first and choose “Build paper”.</p>
          <button class="btn primary" onClick={() => openBuilder()}>Build a paper</button>
        </div>
      ) : (
        <>
          <div class="kpis lib-kpis">
            <div class="kpi"><div class="kpi-label">Papers</div><div class="kpi-value">{papers.length}</div><div class="kpi-sub">{papers.reduce((a, p) => a + p.item_count, 0)} questions in all</div></div>
            <div class="kpi"><div class="kpi-label">In progress</div><div class="kpi-value">{papers.filter((p) => p.open_session_id).length}</div><div class="kpi-sub">paused, ready to resume</div></div>
            <div class="kpi"><div class="kpi-label">Not started</div><div class="kpi-value">{papers.filter((p) => statusOf(p) === "new").length}</div><div class="kpi-sub">never sat</div></div>
            <div class="kpi"><div class="kpi-label">Sittings done</div><div class="kpi-value">{papers.reduce((a, p) => a + p.completed_sessions, 0)}</div><div class="kpi-sub">across all papers</div></div>
            <div class="kpi"><div class="kpi-label">Average score</div><div class="kpi-value">{avg === null ? "—" : `${Math.round(avg / 10)}%`}</div><div class="kpi-sub">latest sitting of each paper</div></div>
          </div>
          <section class="lib-bar">
            <label class="search-sm lib-search">
              <Icon name="search" size={16} />
              <input type="search" placeholder="Search papers by name or subject" aria-label="Search papers" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
            <Segmented label="Status" size="sm" value={status} onChange={setStatus} options={[
              { value: "", label: "All" }, { value: "open", label: "In progress" }, { value: "new", label: "Not started" }, { value: "done", label: "Done" },
            ]} />
          </section>
          <DataGrid
            cols={cols}
            rows={rows}
            rowKey={(p) => p.id}
            storageKey="papers.columns"
            label="Saved papers"
            title={<><h2 class="dt-h">Papers</h2><span class="dt-count">{rows.length}{rows.length !== papers.length ? ` of ${papers.length}` : ""}</span></>}
            defaultSort={{ key: "created", dir: "desc" }}
            empty={<div class="dt-empty-inner"><p><b>No papers match.</b></p></div>}
          />
        </>
      )}
    </div>
  );
}

/** Delete a saved paper permanently after the standard confirmation. Returns true when it was deleted. */
async function deletePaper(id: string, name: string): Promise<boolean> {
  const ok = await askConfirm({
    title: `Delete “${name}”?`,
    message: <p>The paper, its question list and its sittings are removed for good. Your answers stay in each question’s history, so your results and analytics do not change.</p>,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return false;
  try {
    await api("POST", `/api/papers/${id}/delete`);
    toast("Paper deleted");
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

/** A paper item as a library row, for questions the library list no longer has. */
function itemAsLibQ(i: any): LibQ {
  return {
    id: i.question_id, subject_id: i.subject_id, difficulty_code: i.difficulty_code, answer_format: i.answer_format, created_at: 0, archived_at: null,
    marks: i.marks, content_format: i.content_format, has_solution: i.has_solution ? 1 : null, fields: {}, batches: [],
    version_id: i.question_version_id, version_no: i.version_no ?? 1, qno: i.qno, plain_text: i.plain_text, file_name: "",
    concepts: (i.concept_ids ? JSON.parse(i.concept_ids) : []).map((c: string) => [c, 1]), has_key: i.has_key ? 1 : 0,
    attempt_count: null, graded_count: null, correct_count: null, score_permille_sum: null, total_time_seconds: null,
    last_attempted_at: null, last_time_seconds: null, last_result: null, personal_difficulty_permille: null, familiarity_permille: null,
  };
}

export function PaperDetail(props: { id: string }) {
  const { boot, lib } = useData();
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [printSol, setPrintSol] = useState<PrintSolutions>("end");
  const [printing, setPrinting] = useState(false);
  useEffect(() => { api("GET", `/api/papers/${props.id}`).then(setD).catch((e) => setErr(e.message)); }, [props.id]);
  if (err) return <ErrorBox error={err} />;
  if (!d || !boot || !lib || !ctx) return <p class="muted">Loading…</p>;
  const open = d.sessions.find((s: any) => !s.completed_at);
  const done = d.sessions.filter((s: any) => s.completed_at);
  const settings = JSON.parse(d.paper.sampling_settings || "{}");
  const rules = settings && settings.v === 2 ? describeBlueprint(normaliseBlueprint(settings), boot, ctx, lib) : null;
  const byId = new Map(lib.map((q) => [q.id, q]));
  const rows: TableRow[] = d.items.map((i: any) => {
    const why = i.pick_reason ? JSON.parse(i.pick_reason) : null;
    const last = [...d.attempts].reverse().find((a: any) => a.paper_position === i.position);
    const live = byId.get(i.question_id);
    return {
      q: live ? { ...live, marks: i.marks ?? live.marks } : itemAsLibQ(i),
      qno: i.qno,
      text: i.plain_text,
      versionNo: i.version_no ?? 1,
      why: why ? { pinned: !!why.pinned, fills: Array.isArray(why.fills) ? why.fills : [], factors: Array.isArray(why.factors) ? why.factors : [], over: Array.isArray(why.over) ? why.over : [], target: why.target } : null,
      version: { content_format: i.content_format, blob_sha256: i.html_blob_sha256, css_sha256: i.css_sha256 },
      extra: last ? <ResultBadge result={last.result} /> : <span class="muted">Not yet</span>,
      resultKey: last ? ({ incorrect: 0, partial: 1, correct: 2 } as Record<string, number>)[last.result] ?? null : null,
    } as TableRow;
  });
  return (
    <div class="lib">
      <header class="pb-top">
        <div class="pb-top-main">
          <a class="pb-back" href="#/papers"><Icon name="right" size={13} class="flip" /> Papers</a>
          <span class="pb-h1">Saved paper</span>
          <h1 class="lib-h1">{d.paper.name}</h1>
          <div class="lib-stats">
            <span class={`pb-badge ${d.paper.solutions_mode === "hidden" ? "muted" : "ok"}`}>{d.paper.solutions_mode === "hidden" ? "Test conditions" : "Solutions included"}</span>
            <span><b>{d.items.length}</b> questions</span>
            <span><b>{d.items.reduce((a: number, i: any) => a + (i.marks ?? 0), 0)}</b> marks</span>
            <span>Frozen {fmtDateTime(d.paper.frozen_at)}</span>
            <span title="Same rules + same seed = same paper">seed {d.paper.seed} · generator v{d.paper.generator_version}</span>
            {done.length > 0 && <span>Sat <b>{done.length}</b>×</span>}
          </div>
        </div>
        <div class="pb-top-actions">
          <button class="btn ghost" onClick={async () => {
            if (!(await askConfirm({ title: `Hide “${d.paper.name}”?`, message: "It leaves the Papers list. Its history stays.", confirmLabel: "Hide" }))) return;
            try {
              await api("DELETE", `/api/papers/${d.paper.id}`);
              toast("Paper hidden");
              location.hash = "#/papers";
            } catch (e) { toast((e as Error).message, "error"); }
          }}>Hide</button>
          <button class="btn ghost danger-text" onClick={async () => {
            if (await deletePaper(d.paper.id, d.paper.name)) location.hash = "#/papers";
          }}><Icon name="trash" size={15} /> Delete</button>
          {d.paper.solutions_mode !== "hidden" && (
            <select class="sel-sm" aria-label="Solutions in the printed copy" value={printSol} onChange={(e) => setPrintSol((e.target as HTMLSelectElement).value as PrintSolutions)}>
              <option value="end">Print: solutions at the end</option>
              <option value="after">Print: solution after each question</option>
              <option value="none">Print: questions only</option>
            </select>
          )}
          <button class="btn" disabled={printing} onClick={async () => {
            setPrinting(true);
            try { await openPrint(d, d.paper.solutions_mode === "hidden" ? "none" : printSol); }
            catch (e) { toast((e as Error).message, "error"); }
            finally { setPrinting(false); }
          }}><Icon name="save" size={15} /> {printing ? "Preparing…" : "Print / PDF"}</button>
          <a class="btn primary" href={`#/practice/${d.paper.id}`}>{open ? `Resume (question ${open.current_position})` : done.length ? "Sit again" : "Start"}</a>
        </div>
      </header>
      {done.length > 0 && <PaperSummary d={{ ...d, sessions: done }} boot={boot} embedded />}
      {rules && (
        <details class="card rules-card">
          <summary><b>How this paper was built</b> <span class="muted small">— the rules saved with it</span></summary>
          <dl class="rules-dl">
            {rules.map((r) => <><dt>{r.label}</dt><dd>{r.value}</dd></>)}
          </dl>
        </details>
      )}
      <PaperTable rows={rows} ctx={ctx} storageKey="paper.columns" extraLabel="In this paper" extraSort={(r) => (r as any).resultKey ?? null}
        title={<><h2 class="dt-h">Questions (fixed list)</h2><span class="dt-count">{rows.length}</span></>} />
    </div>
  );
}
