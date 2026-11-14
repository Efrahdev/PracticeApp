// Settings → Subjects & concepts: one place to clean up the taxonomy. Add, rename,
// move, merge, archive and delete permanently — one at a time or in bulk — with live
// usage counts and a preview of what each change does to your questions. Questions
// and their history are never deleted here; only tags and mappings change.
import { useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { refresh } from "../store";
import type { Boot, Concept, LibQ } from "../types";
import { Modal, toast } from "../ui";
import { Badge, Icon, Segmented } from "../builder/controls";
import type { SortDir } from "../grid";

type Kind = "subject" | "concept";
interface Node {
  key: string; // "s:<id>" | "c:<id>"
  kind: Kind;
  id: string;
  name: string;
  subjectId: string;
  parentId: string | null;
  depth: number;
  archived: boolean;
  children: Node[];
  direct: number; // questions using it directly
  total: number; // incl. sub-concepts (distinct questions)
  descendants: number;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function buildTree(boot: Boot, lib: LibQ[]): { roots: Node[]; all: Map<string, Node> } {
  const all = new Map<string, Node>();
  const subjQ = new Map<string, Set<string>>();
  const conQ = new Map<string, Set<string>>();
  for (const q of lib) {
    if (q.subject_id) (subjQ.get(q.subject_id) ?? subjQ.set(q.subject_id, new Set()).get(q.subject_id)!).add(q.id);
    for (const [c] of q.concepts) (conQ.get(c) ?? conQ.set(c, new Set()).get(c)!).add(q.id);
  }
  const kids = new Map<string, Concept[]>();
  const cById = new Map(boot.concepts.map((c) => [c.id, c]));
  for (const c of boot.concepts) {
    const k = c.parent_id && cById.has(c.parent_id) ? c.parent_id : `root:${c.subject_id}`;
    kids.set(k, [...(kids.get(k) ?? []), c]);
  }
  const conceptNode = (c: Concept, depth: number, seen: Set<string>): Node => {
    seen.add(c.id);
    const children = (kids.get(c.id) ?? []).filter((x) => !seen.has(x.id)).sort(byName).map((x) => conceptNode(x, depth + 1, seen));
    const qs = new Set(conQ.get(c.id) ?? []);
    for (const ch of children) for (const id of qsOf(ch)) qs.add(id);
    const n: Node = {
      key: `c:${c.id}`, kind: "concept", id: c.id, name: c.name, subjectId: c.subject_id, parentId: c.parent_id, depth, archived: !!c.archived_at,
      children, direct: conQ.get(c.id)?.size ?? 0, total: qs.size, descendants: children.reduce((a, x) => a + 1 + x.descendants, 0),
    };
    qsCache.set(n.key, qs);
    all.set(n.key, n);
    return n;
  };
  const qsCache = new Map<string, Set<string>>();
  const qsOf = (n: Node) => qsCache.get(n.key) ?? new Set<string>();
  const roots = [...boot.subjects].sort(byName).map((s) => {
    const seen = new Set<string>();
    const children = (kids.get(`root:${s.id}`) ?? []).sort(byName).map((c) => conceptNode(c, 1, seen));
    const n: Node = {
      key: `s:${s.id}`, kind: "subject", id: s.id, name: s.name, subjectId: s.id, parentId: null, depth: 0, archived: !!s.archived_at,
      children, direct: subjQ.get(s.id)?.size ?? 0, total: subjQ.get(s.id)?.size ?? 0, descendants: children.reduce((a, x) => a + 1 + x.descendants, 0),
    };
    all.set(n.key, n);
    return n;
  });
  return { roots, all };
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function TaxonomyManager(props: { boot: Boot; lib: LibQ[] }) {
  const { boot, lib } = props;
  const { roots, all } = useMemo(() => buildTree(boot, lib), [boot, lib]);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "unused" | "archived">("all");
  const [sort, setSort] = useState<{ key: "name" | "total"; dir: SortDir }>({ key: "name", dir: "asc" });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [adding, setAdding] = useState<{ under: string; text: string } | null>(null);
  const [newSubject, setNewSubject] = useState("");
  const [dialog, setDialog] = useState<{ op: "delete" | "merge" | "move"; keys: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r: any = await fn();
      await refresh();
      toast(r?.summary ?? ok ?? "Saved");
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Which nodes are shown: match the search / filter, plus their parents for context.
  const term = q.trim().toLowerCase();
  const unused = (n: Node) => n.total === 0 && n.children.every(unused);
  const matches = (n: Node) =>
    (!term || n.name.toLowerCase().includes(term)) &&
    (show === "all" ? true : show === "unused" ? unused(n) : n.archived);
  const visible = new Set<string>();
  const mark = (n: Node, up: Node[]): boolean => {
    let any = false;
    for (const c of n.children) if (mark(c, [...up, n])) any = true;
    if (matches(n) || any) {
      visible.add(n.key);
      return true;
    }
    return false;
  };
  roots.forEach((r) => mark(r, []));
  const filtering = !!term || show !== "all";
  const cmp = (a: Node, b: Node) => {
    const c = sort.key === "name" ? byName(a, b) : a.total - b.total || byName(a, b);
    return sort.dir === "asc" ? c : -c;
  };
  const rows: Node[] = [];
  const walk = (n: Node) => {
    if (!visible.has(n.key)) return;
    rows.push(n);
    if (!closed.has(n.key) || filtering) [...n.children].sort(cmp).forEach(walk);
  };
  [...roots].sort(cmp).forEach(walk);

  const selected = [...sel].map((k) => all.get(k)).filter((n): n is Node => !!n);
  const selKinds = new Set(selected.map((n) => n.kind));
  const unusedConcepts = [...all.values()].filter((n) => n.kind === "concept" && n.total === 0);
  const unusedSubjects = roots.filter((s) => s.total === 0 && s.children.every((c) => c.total === 0));
  const toggleSel = (k: string) => { const s = new Set(sel); s.has(k) ? s.delete(k) : s.add(k); setSel(s); };
  const sortBtn = (key: "name" | "total", label: string) => (
    <button type="button" class={`th-sort${sort.key === key ? " on" : ""}`} onClick={() => setSort({ key, dir: sort.key === key && sort.dir === "asc" ? "desc" : key === "total" && sort.key !== key ? "desc" : "asc" })}>
      <span>{label}</span><Icon name={sort.key === key && sort.dir === "desc" ? "dn" : "up"} size={11} class="th-arrow" />
    </button>
  );

  const saveRename = async () => {
    if (!editing) return;
    const n = all.get(editing.key);
    const name = editing.text.trim();
    if (!n || !name || name === n.name) return setEditing(null);
    if (await run(() => api("PATCH", `/api/${n.kind === "subject" ? "subjects" : "concepts"}/${n.id}`, { name }), "Renamed")) setEditing(null);
  };
  const saveAdd = async () => {
    if (!adding?.text.trim()) return setAdding(null);
    const parent = all.get(adding.under)!;
    const ok = await run(() => api("POST", "/api/concepts", { subject_id: parent.subjectId, parent_id: parent.kind === "concept" ? parent.id : null, name: adding.text.trim() }), "Concept added");
    if (ok) {
      setAdding(null);
      const c = new Set(closed); c.delete(parent.key); setClosed(c);
    }
  };

  return (
    <section class="card tax">
      <div class="tax-head">
        <div>
          <h2>Subjects &amp; concepts</h2>
          <p class="muted small">Clean up the list: rename, move, merge or delete anything. Questions and your history are never deleted — only their tags change.</p>
        </div>
        <div class="tax-add">
          <input placeholder="New subject name" aria-label="New subject name" value={newSubject} onInput={(e) => setNewSubject((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && newSubject.trim() && run(async () => { await api("POST", "/api/subjects", { name: newSubject }); setNewSubject(""); }, "Subject added")} />
          <button class="btn" disabled={!newSubject.trim() || busy} onClick={() => run(async () => { await api("POST", "/api/subjects", { name: newSubject }); setNewSubject(""); }, "Subject added")}>
            <Icon name="plus" size={14} /> Add subject
          </button>
        </div>
      </div>

      <div class="tax-bar">
        <label class="search-sm lib-search">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Find a subject or concept" aria-label="Find a subject or concept" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        <Segmented size="sm" label="Show" value={show} onChange={setShow} options={[
          { value: "all", label: "All" },
          { value: "unused", label: `Unused · ${unusedConcepts.length + unusedSubjects.length}` },
          { value: "archived", label: "Archived" },
        ]} />
        <span class="grow" />
        <button class="btn small ghost" onClick={() => setClosed(closed.size ? new Set() : new Set([...all.values()].filter((n) => n.children.length).map((n) => n.key)))}>{closed.size ? "Expand all" : "Collapse all"}</button>
        <button class="btn small" disabled={busy || (!unusedConcepts.length && !unusedSubjects.length)}
          onClick={() => setDialog({ op: "delete", keys: [...unusedSubjects.map((n) => n.key), ...unusedConcepts.filter((c) => !unusedSubjects.some((s) => s.id === c.subjectId)).map((n) => n.key)] })}>
          <Icon name="x" size={14} /> Delete all unused
        </button>
      </div>

      {sel.size > 0 && (
        <div class="sel-bar" role="status">
          <span><b>{sel.size}</b> selected</span>
          {selKinds.size > 1 ? <span class="muted small">Select only subjects or only concepts to act on them together.</span> : (
            <>
              <button class="btn small" onClick={() => setDialog({ op: "merge", keys: [...sel] })}>Merge…</button>
              {selKinds.has("concept") && <button class="btn small" onClick={() => setDialog({ op: "move", keys: [...sel] })}>Move…</button>}
              <button class="btn small danger" onClick={() => setDialog({ op: "delete", keys: [...sel] })}>Delete…</button>
            </>
          )}
          <button class="btn small ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      <div class="tax-table" role="table" aria-label="Subjects and concepts">
        <div class="tax-row tax-th" role="row">
          <span role="columnheader"><span class="sr">Select</span></span>
          <span role="columnheader">{sortBtn("name", "Name")}</span>
          <span role="columnheader" class="end">{sortBtn("total", "Questions")}</span>
          <span role="columnheader" class="end hide-sm">Sub-concepts</span>
          <span role="columnheader" class="end"><span class="sr">Actions</span></span>
        </div>
        {rows.length === 0 && <div class="dt-empty">{boot.subjects.length ? "Nothing matches." : "No subjects yet — add one above, or import questions."}</div>}
        {rows.map((n) => {
          const open = !closed.has(n.key) || filtering;
          const isEdit = editing?.key === n.key;
          return (
            <>
              <div class={`tax-row k-${n.kind}${n.archived ? " archived" : ""}${sel.has(n.key) ? " selected" : ""}`} role="row">
                <span role="cell"><input type="checkbox" class="cb" aria-label={`Select ${n.name}`} checked={sel.has(n.key)} onChange={() => toggleSel(n.key)} /></span>
                <span role="cell" class="tax-name" style={{ paddingLeft: `${n.depth * 22}px` }}>
                  {n.children.length ? (
                    <button type="button" class={`tree-tw${open ? " open" : ""}`} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${n.name}`}
                      onClick={() => { const c = new Set(closed); c.has(n.key) ? c.delete(n.key) : c.add(n.key); setClosed(c); }}><Icon name="right" size={13} /></button>
                  ) : <span class="tree-tw-sp" />}
                  {isEdit ? (
                    <input class="tax-input" autoFocus value={editing.text} aria-label={`New name for ${n.name}`}
                      onInput={(e) => setEditing({ key: n.key, text: (e.target as HTMLInputElement).value })}
                      onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setEditing(null); }} onBlur={saveRename} />
                  ) : (
                    <button type="button" class="tax-label" title="Click to rename" onClick={() => setEditing({ key: n.key, text: n.name })}>{n.name}</button>
                  )}
                  {n.kind === "subject" && <span class="pb-badge accent">Subject</span>}
                  {n.archived && <Badge tone="warn">Archived</Badge>}
                  {unused(n) && !n.archived && <Badge>Unused</Badge>}
                </span>
                <span role="cell" class="end num" title={n.kind === "concept" && n.total !== n.direct ? `${n.direct} tagged directly, ${n.total} including sub-concepts` : undefined}>
                  {n.total.toLocaleString()}{n.kind === "concept" && n.total !== n.direct && <span class="sub"> ({n.direct} direct)</span>}
                </span>
                <span role="cell" class="end num hide-sm muted">{n.descendants || "—"}</span>
                <span role="cell" class="tax-acts">
                  <button class="dt-ib" title={n.kind === "subject" ? "Add a concept" : "Add a sub-concept"} aria-label={`Add under ${n.name}`} onClick={() => setAdding({ under: n.key, text: "" })}><Icon name="plus" /></button>
                  {n.kind === "concept" && <button class="dt-ib" title="Move to another place" aria-label={`Move ${n.name}`} onClick={() => setDialog({ op: "move", keys: [n.key] })}><Icon name="replace" /></button>}
                  <button class="dt-ib" title="Merge into another" aria-label={`Merge ${n.name}`} onClick={() => setDialog({ op: "merge", keys: [n.key] })}><Icon name="target" /></button>
                  <button class="dt-ib" title={n.archived ? "Unarchive" : "Archive (hide, keep tags)"} aria-label={`${n.archived ? "Unarchive" : "Archive"} ${n.name}`}
                    onClick={() => run(() => api("PATCH", `/api/${n.kind === "subject" ? "subjects" : "concepts"}/${n.id}`, { archived: !n.archived }), n.archived ? "Restored" : "Archived")}><Icon name={n.archived ? "reset" : "save"} /></button>
                  <button class="dt-ib danger" title="Delete permanently" aria-label={`Delete ${n.name}`} onClick={() => setDialog({ op: "delete", keys: [n.key] })}><Icon name="x" /></button>
                </span>
              </div>
              {adding?.under === n.key && (
                <div class="tax-row adding" role="row">
                  <span role="cell" />
                  <span role="cell" class="tax-name" style={{ paddingLeft: `${(n.depth + 1) * 22 + 26}px` }}>
                    <input class="tax-input" autoFocus placeholder={n.kind === "subject" ? "New concept name" : "New sub-concept name"} aria-label="New concept name" value={adding.text}
                      onInput={(e) => setAdding({ under: n.key, text: (e.target as HTMLInputElement).value })}
                      onKeyDown={(e) => { if (e.key === "Enter") saveAdd(); if (e.key === "Escape") setAdding(null); }} />
                    <button class="btn small primary" onClick={saveAdd} disabled={busy}>Add</button>
                    <button class="btn small ghost" onClick={() => setAdding(null)}>Cancel</button>
                  </span>
                </div>
              )}
            </>
          );
        })}
      </div>

      {dialog && (
        <ActionDialog op={dialog.op} nodes={dialog.keys.map((k) => all.get(k)).filter((n): n is Node => !!n)} roots={roots} all={all} lib={lib}
          busy={busy} onClose={() => setDialog(null)}
          onRun={async (bodies) => {
            let ok = true;
            for (const b of bodies) ok = ok && (await run(() => api("POST", "/api/taxonomy", b)));
            if (ok) { setDialog(null); setSel(new Set()); }
          }} />
      )}
    </section>
  );
}

function ActionDialog(props: {
  op: "delete" | "merge" | "move";
  nodes: Node[];
  roots: Node[];
  all: Map<string, Node>;
  lib: LibQ[];
  busy: boolean;
  onClose: () => void;
  onRun: (bodies: Record<string, unknown>[]) => void;
}) {
  const { op, nodes, all } = props;
  const subjects = nodes.filter((n) => n.kind === "subject");
  const concepts = nodes.filter((n) => n.kind === "concept");
  const kind: Kind = subjects.length ? "subject" : "concept";
  const [into, setInto] = useState("");
  const [children, setChildren] = useState<"delete" | "lift">("delete");
  const [conceptsMode, setConceptsMode] = useState<"move" | "delete">("delete");
  const [confirmText, setConfirmText] = useState("");

  // Everything under the chosen nodes (can't be a target)
  const under = new Set<string>();
  const addUnder = (n: Node) => { under.add(n.key); n.children.forEach(addUnder); };
  nodes.forEach(addUnder);
  const conceptOptions = [...all.values()].filter((n) => n.kind === "concept" && !n.archived && !under.has(n.key));
  const pathOf = (n: Node): string => {
    const parts = [n.name];
    let p = n.parentId ? all.get(`c:${n.parentId}`) : undefined;
    for (let g = 0; p && g < 30; g++) { parts.unshift(p.name); p = p.parentId ? all.get(`c:${p.parentId}`) : undefined; }
    return `${all.get(`s:${n.subjectId}`)?.name ?? "?"}: ${parts.join(" › ")}`;
  };
  const subjectOptions = props.roots.filter((s) => !s.archived && !nodes.some((n) => n.key === s.key));
  const affected = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const keys = new Set([...under].map((k) => k.slice(2)));
    let n = 0;
    for (const q of props.lib) {
      if (kind === "subject" ? q.subject_id && ids.has(q.subject_id) : q.concepts.some(([c]) => (op === "delete" && children === "lift" ? ids.has(c) : keys.has(c)))) n++;
    }
    return n;
  }, [nodes, children, op]);
  const subCount = nodes.reduce((a, n) => a + n.descendants, 0);
  const names = nodes.slice(0, 6).map((n) => n.kind === "concept" ? pathOf(n) : n.name);

  const title = op === "delete" ? `Delete ${plural(nodes.length, kind === "subject" ? "subject" : "concept")} permanently`
    : op === "merge" ? `Merge ${plural(nodes.length, kind === "subject" ? "subject" : "concept")}` : `Move ${plural(nodes.length, "concept")}`;
  const bodies = (): Record<string, unknown>[] => {
    const ids = (k: Kind) => nodes.filter((n) => n.kind === k).map((n) => n.id);
    if (op === "move") {
      const [kindT, id] = into.split(":");
      return [{ op: "move", kind: "concept", ids: ids("concept"), subject_id: kindT === "s" ? id : all.get(`c:${id}`)!.subjectId, parent_id: kindT === "c" ? id : null }];
    }
    if (op === "merge") return [{ op: "merge", kind, ids: [...ids(kind), into.slice(2)], into: into.slice(2) }];
    const out: Record<string, unknown>[] = [];
    if (concepts.length) out.push({ op: "delete", kind: "concept", ids: ids("concept"), into: kind === "concept" && into ? into.slice(2) : null, children });
    if (subjects.length) out.push({ op: "delete", kind: "subject", ids: ids("subject"), into: into ? into.slice(2) : null, concepts: into ? conceptsMode : "delete" });
    return out;
  };
  const ready = op === "delete" ? confirmText.trim().toUpperCase() === "DELETE" : !!into;

  return (
    <Modal title={title} onClose={props.onClose} wide>
      <div class="tax-dialog">
        <ul class="tax-names">
          {names.map((n) => <li>{n}</li>)}
          {nodes.length > names.length && <li class="muted">+{nodes.length - names.length} more</li>}
        </ul>
        <div class="alert info">
          <Icon name="info" size={16} />
          <div>
            <b>{plural(affected, "question")}</b> {kind === "subject" ? "have this subject" : "are tagged with this"}{subCount && op !== "move" ? `; ${plural(subCount, "sub-concept")} sit underneath` : ""}.
            {" "}Questions and their history are never deleted.
          </div>
        </div>

        {op === "move" && (
          <label class="field">Move to
            <select value={into} onChange={(e) => setInto((e.target as HTMLSelectElement).value)}>
              <option value="">Choose a place…</option>
              {props.roots.filter((s) => !s.archived).map((s) => (
                <optgroup label={s.name}>
                  <option value={`s:${s.id}`}>{s.name} — top level</option>
                  {conceptOptions.filter((c) => c.subjectId === s.id).map((c) => <option value={`c:${c.id}`}>{pathOf(c)}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}

        {op === "merge" && (
          <label class="field">Merge into
            <select value={into} onChange={(e) => setInto((e.target as HTMLSelectElement).value)}>
              <option value="">Choose the one to keep…</option>
              {kind === "subject"
                ? subjectOptions.map((s) => <option value={`s:${s.id}`}>{s.name}</option>)
                : [...nodes, ...conceptOptions].filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i)
                  .map((c) => <option value={`c:${c.id}`}>{pathOf(c)}{nodes.some((n) => n.key === c.key) ? " (one of these)" : ""}</option>)}
            </select>
            <span class="muted small">{kind === "subject" ? "Questions and concepts move to the subject you keep; concepts with the same name are combined." : "Tags move to the concept you keep (strongest weight wins); sub-concepts move under it."}</span>
          </label>
        )}

        {op === "delete" && (
          <>
            {concepts.length > 0 && affected > 0 && (
              <fieldset class="tax-choice">
                <legend>Questions tagged with {concepts.length === 1 ? "it" : "them"}</legend>
                <label><input type="radio" checked={!into} onChange={() => setInto("")} /> Remove the tag — the questions stay, without this concept</label>
                <label><input type="radio" checked={!!into} onChange={() => setInto(conceptOptions[0] ? `c:${conceptOptions[0].id}` : "")} disabled={!conceptOptions.length} /> Re-tag them with another concept</label>
                {!!into && (
                  <select aria-label="Replacement concept" value={into} onChange={(e) => setInto((e.target as HTMLSelectElement).value)}>
                    {conceptOptions.map((c) => <option value={`c:${c.id}`}>{pathOf(c)}</option>)}
                  </select>
                )}
              </fieldset>
            )}
            {concepts.length > 0 && concepts.some((n) => n.children.length) && (
              <fieldset class="tax-choice">
                <legend>Sub-concepts underneath</legend>
                <label><input type="radio" checked={children === "delete"} onChange={() => setChildren("delete")} /> Delete them too</label>
                <label><input type="radio" checked={children === "lift"} onChange={() => setChildren("lift")} /> Keep them — move them up a level</label>
              </fieldset>
            )}
            {subjects.length > 0 && (affected > 0 || subjects.some((n) => n.children.some((c) => c.total > 0))) && (
              <fieldset class="tax-choice">
                <legend>Questions in {subjects.length === 1 ? "this subject" : "these subjects"}</legend>
                <label><input type="radio" checked={!into} onChange={() => setInto("")} /> Leave them with no subject</label>
                <label><input type="radio" checked={!!into} onChange={() => setInto(subjectOptions[0] ? `s:${subjectOptions[0].id}` : "")} disabled={!subjectOptions.length} /> Move them to another subject</label>
                {!!into && (
                  <>
                    <select aria-label="Replacement subject" value={into} onChange={(e) => setInto((e.target as HTMLSelectElement).value)}>
                      {subjectOptions.map((s) => <option value={`s:${s.id}`}>{s.name}</option>)}
                    </select>
                    <label><input type="radio" checked={conceptsMode === "move"} onChange={() => setConceptsMode("move")} /> Move the concepts there too</label>
                    <label><input type="radio" checked={conceptsMode === "delete"} onChange={() => setConceptsMode("delete")} /> Delete the concepts (their tags are removed)</label>
                  </>
                )}
                {!into && subCount > 0 && <span class="muted small">Its {plural(subCount, "concept")} will be deleted and their tags removed.</span>}
              </fieldset>
            )}
            <label class="field">Type DELETE to confirm
              <input value={confirmText} onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)} aria-label="Type DELETE to confirm" autoComplete="off" />
            </label>
          </>
        )}

        <div class="row end">
          <button class="btn" onClick={props.onClose}>Cancel</button>
          <button class={`btn ${op === "delete" ? "danger" : "primary"}`} disabled={!ready || props.busy} onClick={() => props.onRun(bodies())}>
            {props.busy ? "Working…" : op === "delete" ? "Delete permanently" : op === "merge" ? "Merge" : "Move"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
