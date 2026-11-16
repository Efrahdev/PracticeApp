import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { openBuilder, useData } from "../store";
import type { LibQ } from "../types";
import { ErrorBox, fmtDate, fmtDateTime, Loading, ResultBadge, Ring, toast } from "../ui";
import { DocFrame } from "../views";
import { describeBlueprint, subjectSlot } from "../builder/describe";
import { DataGrid, type GridCol } from "../grid";
import { Icon, readLocal, Segmented, writeLocal } from "../builder/controls";
import { PaperTable, type TableRow } from "../builder/PaperTable";
import { makeCtx } from "../builder/pool";
import { normaliseBlueprint } from "../builder/spec";
import { PaperSummary } from "./Practice";
import { buildPrintDocument, openPrint, type PrintSolutions } from "../print";

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
  const [layout, setLayoutState] = useState<"cards" | "table">(() => (readLocal<string>("papers.layout", "cards") === "table" ? "table" : "cards"));
  const setLayout = (v: "cards" | "table") => { setLayoutState(v); writeLocal("papers.layout", v); };
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  const load = () => api("GET", "/api/papers").then((r) => setPapers(r.papers)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!papers || !ctx) return <Loading />;

  const statusOf = (p: PaperRow) => (p.open_session_id ? "open" : p.completed_sessions ? "done" : "new");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const subjectsOf = (p: PaperRow): string[] => { try { return (JSON.parse(p.subject_ids ?? "[]") as (string | null)[]).filter((x): x is string => !!x); } catch { return []; } };
  const rows = papers.filter((p) => (!status || statusOf(p) === status) && terms.every((t) => `${p.name} ${subjectsOf(p).map((s) => ctx.subjectName.get(s)).join(" ")}`.toLowerCase().includes(t)));
  const scored = papers.filter((p) => p.last_score !== null);
  const avg = scored.length ? scored.reduce((a, p) => a + (p.last_score ?? 0), 0) / scored.length : null;
  const print = async (p: PaperRow) => {
    try {
      const d = await api("GET", `/api/papers/${p.id}`);
      const names = [...new Set((d.items as any[]).map((i) => i.subject_id).filter(Boolean))].map((id) => ctx.subjectName.get(id as string) ?? "").filter(Boolean);
      await openPrint(d, d.paper.solutions_mode === "hidden" ? "none" : "end", { subjects: names });
    } catch (e) { toast((e as Error).message, "error"); }
  };
  const hide = async (p: PaperRow) => {
    if (!confirm(`Hide “${p.name}”? Its history stays.`)) return;
    await api("DELETE", `/api/papers/${p.id}`);
    toast("Paper hidden");
    load();
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
      id: "actions", label: "", min: 0, fr: 0, px: 208, fixed: true, card: "full",
      render: (p) => (
        <div class="dt-acts paper-acts">
          <a class={`btn small${p.open_session_id ? " primary" : ""}`} href={`#/practice/${p.id}`}>{p.open_session_id ? "Resume" : p.completed_sessions ? "Sit again" : "Start"}</a>
          <button type="button" class="dt-ib" aria-label={`Print ${p.name}`} title="Print / PDF" onClick={() => print(p)}><Icon name="print" /></button>
          <a class="dt-ib" href={`#/papers/${p.id}`} aria-label={`Open ${p.name}`} title="Open"><Icon name="external" /></a>
          <button type="button" class="dt-ib danger" aria-label={`Hide ${p.name}`} title="Hide this paper (history stays)" onClick={() => hide(p)}><Icon name="x" /></button>
        </div>
      ),
    },
  ];

  const sorted = [...rows].sort((x, y) => ({ open: 0, new: 1, done: 2 })[statusOf(x)] - ({ open: 0, new: 1, done: 2 })[statusOf(y)] || y.created_at - x.created_at);
  return (
    <div class="lib">
      <header class="pb-top">
        <div class="pb-top-main">
          <span class="pb-h1">Papers</span>
          <h1 class="lib-h1">Saved papers</h1>
        </div>
        <div class="pb-top-actions">
          <button type="button" class="btn primary" onClick={() => openBuilder()}><Icon name="plus" size={15} /> Build paper</button>
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
          <div class="tiles">
            <div class="tile"><div class="tile-label">Papers</div><div class="tile-value">{papers.length}</div><div class="tile-sub">{papers.reduce((a, p) => a + p.item_count, 0)} questions in all</div></div>
            <div class="tile"><div class="tile-label">In progress</div><div class="tile-value">{papers.filter((p) => p.open_session_id).length}</div><div class="tile-sub">paused, ready to resume</div></div>
            <div class="tile"><div class="tile-label">Not started</div><div class="tile-value">{papers.filter((p) => statusOf(p) === "new").length}</div><div class="tile-sub">never sat</div></div>
            <div class="tile"><div class="tile-label">Sittings done</div><div class="tile-value">{papers.reduce((a, p) => a + p.completed_sessions, 0)}</div><div class="tile-sub">across all papers</div></div>
            <div class="tile"><div class="tile-label">Average score</div><div class="tile-value">{avg === null ? "—" : <>{Math.round(avg / 10)}<small>%</small></>}</div><div class="tile-sub">latest sitting of each paper</div></div>
          </div>
          <section class="lib-bar">
            <label class="search-sm lib-search">
              <Icon name="search" size={16} />
              <input type="search" placeholder="Search papers by name or subject" aria-label="Search papers" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
            <Segmented label="Status" size="sm" value={status} onChange={setStatus} options={[
              { value: "", label: "All" }, { value: "open", label: "In progress" }, { value: "new", label: "Not started" }, { value: "done", label: "Done" },
            ]} />
            <Segmented label="Layout" size="sm" value={layout} onChange={setLayout} options={[
              { value: "cards", label: <><Icon name="grid" size={14} /><span class="sr">Cards</span></>, title: "Cards" },
              { value: "table", label: <><Icon name="list" size={14} /><span class="sr">Table</span></>, title: "Table" },
            ]} />
          </section>
          {layout === "cards" ? (
            rows.length === 0 ? <div class="empty card"><p><b>No papers match.</b></p></div> : (
              <div class="paper-grid">
                {sorted.map((p) => {
                  const st = statusOf(p);
                  const ss = subjectsOf(p);
                  return (
                    <article class={`paper-card st-${st}`}>
                      <a class="paper-card-main" href={`#/papers/${p.id}`} aria-label={`Open ${p.name}`}>
                        <div class="paper-card-top">
                          <span class={`pb-badge ${st === "open" ? "warn" : st === "done" ? "ok" : "muted"}`}>{st === "open" ? `In progress · Q${p.open_position}/${p.item_count}` : st === "done" ? `Done${p.completed_sessions > 1 ? ` ${p.completed_sessions}×` : ""}` : "Not started"}</span>
                          {p.solutions_mode === "hidden" && <span class="pb-badge muted">Test conditions</span>}
                        </div>
                        <h2 class="paper-card-name">{p.name}</h2>
                        <div class="paper-card-facts">
                          <span><b>{p.item_count}</b> questions</span>
                          {p.total_marks !== null && <span><b>{Number.isInteger(p.total_marks) ? p.total_marks : p.total_marks.toFixed(1)}</b> marks</span>}
                        </div>
                        <div class="subj-list">{ss.map((sid) => <span class="dt-subj"><i class={`sw seg-s${subjectSlot(ctx, sid)}`} aria-hidden="true" />{ctx.subjectName.get(sid) ?? "?"}</span>)}</div>
                      </a>
                      <footer class="paper-card-foot">
                        <div class="paper-card-score">
                          {p.last_score !== null ? <><Ring value={p.last_score / 1000} size={44} stroke={5} /><span>last score<small>{p.best_score !== null && p.completed_sessions > 1 ? `best ${scoreText(p.best_score)} · ` : ""}{fmtDate(p.last_completed_at)}</small></span></> : <span class="muted small">Made {fmtDate(p.created_at)}</span>}
                        </div>
                        <div class="paper-card-acts">
                          <button type="button" class="dt-ib" aria-label={`Print ${p.name}`} title="Print / PDF" onClick={() => print(p)}><Icon name="print" /></button>
                          <button type="button" class="dt-ib danger" aria-label={`Hide ${p.name}`} title="Hide this paper (history stays)" onClick={() => hide(p)}><Icon name="x" /></button>
                          <a class={`btn small${st === "done" ? "" : " primary"}`} href={`#/practice/${p.id}`}>{st === "open" ? "Resume" : st === "done" ? "Sit again" : "Start"}</a>
                        </div>
                      </footer>
                    </article>
                  );
                })}
              </div>
            )
          ) : (
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
          )}
        </>
      )}
    </div>
  );
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

/** The paper itself, typeset exactly as it prints, shown on the page. */
function PaperPreview(props: { d: any; subjects: string[] }) {
  const [doc, setDoc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    buildPrintDocument(props.d, "none", { preview: true, subjects: props.subjects }).then((h) => live && setDoc(h)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [props.d.paper.id]);
  return <div class="sheet paper-sheet"><DocFrame doc={doc} error={err} title={`${props.d.paper.name} — the paper`} minHeight={420} /></div>;
}

type Tab = "paper" | "results" | "questions" | "rules";

export function PaperDetail(props: { id: string }) {
  const { boot, lib } = useData();
  const ctx = useMemo(() => (boot && lib ? makeCtx(boot, lib) : null), [boot, lib]);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [printSol, setPrintSol] = useState<PrintSolutions>("end");
  const [printing, setPrinting] = useState(false);
  const [tab, setTab] = useState<Tab>("paper");
  useEffect(() => { api("GET", `/api/papers/${props.id}`).then(setD).catch((e) => setErr(e.message)); }, [props.id]);
  if (err) return <ErrorBox error={err} />;
  if (!d || !boot || !lib || !ctx) return <Loading />;
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
  const subjectIds = [...new Set((d.items as any[]).map((i) => i.subject_id).filter(Boolean))] as string[];
  const subjectNames = subjectIds.map((id) => ctx.subjectName.get(id) ?? "").filter(Boolean);
  const marks = d.items.reduce((a: number, i: any) => a + (i.marks ?? 0), 0);
  const hidden = d.paper.solutions_mode === "hidden";
  const tabs: { value: Tab; label: string }[] = [
    { value: "paper", label: "Paper" },
    ...(done.length ? [{ value: "results" as Tab, label: "Results" }] : []),
    { value: "questions", label: `Questions · ${rows.length}` },
    ...(rules ? [{ value: "rules" as Tab, label: "How it was built" }] : []),
  ];
  return (
    <div class="lib paper-page">
      <header class="cover">
        <a class="pb-back" href="#/papers"><Icon name="left" size={13} /> Papers</a>
        <div class="cover-row">
          <div class="cover-main">
            <span class="pb-h1">Saved paper</span>
            <h1 class="cover-title">{d.paper.name}</h1>
            <div class="lib-stats">
              <span class={`pb-badge ${hidden ? "muted" : "ok"}`}>{hidden ? "Test conditions" : "Solutions included"}</span>
              <span><b>{d.items.length}</b> questions</span>
              {marks > 0 && <span><b>{marks}</b> marks</span>}
              {subjectIds.length > 0 && <span class="subj-list">{subjectIds.map((sid) => <span class="dt-subj"><i class={`sw seg-s${subjectSlot(ctx, sid)}`} aria-hidden="true" />{ctx.subjectName.get(sid) ?? "?"}</span>)}</span>}
              {done.length > 0 && <span>Sat <b>{done.length}</b>×</span>}
            </div>
          </div>
          <div class="cover-acts">
            <div class="cover-print">
              {!hidden && (
                <select class="sel-sm" aria-label="Solutions in the printed copy" value={printSol} onChange={(e) => setPrintSol((e.target as HTMLSelectElement).value as PrintSolutions)}>
                  <option value="end">Solutions at the end</option>
                  <option value="after">Solution after each question</option>
                  <option value="none">Questions only</option>
                </select>
              )}
              <button class="btn" disabled={printing} onClick={async () => {
                setPrinting(true);
                try { await openPrint(d, hidden ? "none" : printSol, { subjects: subjectNames }); }
                catch (e) { toast((e as Error).message, "error"); }
                finally { setPrinting(false); }
              }}><Icon name="print" size={15} /> {printing ? "Preparing…" : "Print / PDF"}</button>
            </div>
            <a class="btn primary lg" href={`#/practice/${d.paper.id}`}><Icon name="play" size={14} /> {open ? `Resume (question ${open.current_position})` : done.length ? "Sit again" : "Start"}</a>
          </div>
        </div>
      </header>

      <div class="tabbar">
        <Segmented label="View" value={tab} onChange={setTab} options={tabs} />
        <button class="link-btn quiet" onClick={async () => {
          if (!confirm("Hide this paper? Its history stays.")) return;
          await api("DELETE", `/api/papers/${d.paper.id}`);
          toast("Paper hidden");
          location.hash = "#/papers";
        }}>Hide this paper</button>
      </div>

      {tab === "paper" && <PaperPreview d={d} subjects={subjectNames} />}
      {tab === "results" && done.length > 0 && <PaperSummary d={{ ...d, sessions: done }} boot={boot} embedded />}
      {tab === "questions" && (
        <PaperTable rows={rows} ctx={ctx} storageKey="paper.columns" extraLabel="In this paper" extraSort={(r) => (r as any).resultKey ?? null}
          title={<><h2 class="dt-h">Questions (fixed list)</h2><span class="dt-count">{rows.length}</span></>} />
      )}
      {tab === "rules" && rules && (
        <section class="card rules-card">
          <div class="card-head"><h2>How this paper was built</h2><span class="muted small">the rules saved with it</span></div>
          <dl class="rules-dl">
            {rules.map((r) => <><dt>{r.label}</dt><dd>{r.value}</dd></>)}
            <dt>Frozen</dt><dd>{fmtDateTime(d.paper.frozen_at)}</dd>
            <dt>Reproducible</dt><dd title="Same rules + same seed = same paper">seed {d.paper.seed} · generator v{d.paper.generator_version}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}
