// Subjects & concepts clean-up: delete (permanently), merge and move — each as ONE
// all-or-nothing D1 batch. Questions are never deleted here: their tags move to a
// replacement or are removed, and attempts/grades are untouched. Daily metrics are
// rebuilt in the same batch (they are derived from the current tags), so analytics
// stay exact. Every change is written to change_log.
import { HttpError, json, readJson } from "./http";
import { rebuildDailyStatements } from "./metrics";
import type { Env } from "./api";

export interface TaxSpec {
  op: "delete" | "merge" | "move";
  kind: "subject" | "concept";
  ids: string[];
  into?: string | null; // merge target, or replacement for deleted items (null = untag / no subject)
  children?: "delete" | "lift"; // concept delete: what happens to sub-concepts
  concepts?: "move" | "delete"; // subject delete: what happens to its concepts
  subject_id?: string; // concept move: new subject
  parent_id?: string | null; // concept move: new parent (null = top level)
}

interface CRow { id: string; subject_id: string; parent_id: string | null; name: string; archived_at: number | null }

const LOG = `INSERT INTO change_log (table_name, row_key, column_name, op, old_value, new_value, changed_at)`;

export async function taxonomyEdit(req: Request, env: Env) {
  const db = env.DB;
  const spec = await readJson<TaxSpec>(req);
  const ids = [...new Set((spec.ids ?? []).filter((x) => typeof x === "string" && x))];
  if (!ids.length) throw new HttpError(400, "Nothing selected.");
  const t = Date.now();
  const concepts = (await db.prepare(`SELECT id, subject_id, parent_id, name, archived_at FROM concept`).all<CRow>()).results;
  const subjects = (await db.prepare(`SELECT id, name FROM subject`).all<{ id: string; name: string }>()).results;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const kids = new Map<string, string[]>();
  for (const c of concepts) if (c.parent_id) kids.set(c.parent_id, [...(kids.get(c.parent_id) ?? []), c.id]);
  const subtree = (roots: string[]) => {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(kids.get(id) ?? []));
    }
    return out;
  };

  const stmts: D1PreparedStatement[] = [db.prepare(`PRAGMA defer_foreign_keys = on`)];
  const pre = [db.prepare(`DELETE FROM concept_daily_stat`), db.prepare(`DELETE FROM subject_daily_stat`)];
  let summary = "";

  /** Removes concepts `del` (a closed set), moving their tags to `into` and their surviving children to `childParent(child)`. */
  const removeConcepts = (del: Set<string>, into: string | null, childParent: (childId: string) => string | null) => {
    const delJson = JSON.stringify([...del]);
    if (into) {
      stmts.push(db.prepare(
        `INSERT INTO question_concept (question_id, concept_id, weight, created_at)
         SELECT question_id, ?2, max(weight), ?3 FROM question_concept WHERE concept_id IN (SELECT value FROM json_each(?1)) GROUP BY question_id
         ON CONFLICT (question_id, concept_id) DO UPDATE SET weight = max(weight, excluded.weight)`,
      ).bind(delJson, into, t));
      stmts.push(db.prepare(
        `${LOG} SELECT DISTINCT 'question_concept', question_id || '|' || ?2, 'weight', 'insert', NULL, 'from merge/delete', ?3
         FROM question_concept WHERE concept_id IN (SELECT value FROM json_each(?1))`,
      ).bind(delJson, into, t));
    }
    stmts.push(db.prepare(
      `${LOG} SELECT 'question_concept', question_id || '|' || concept_id, 'weight', 'delete', weight, NULL, ?2
       FROM question_concept WHERE concept_id IN (SELECT value FROM json_each(?1))`,
    ).bind(delJson, t));
    stmts.push(db.prepare(`DELETE FROM question_concept WHERE concept_id IN (SELECT value FROM json_each(?1))`).bind(delJson));
    const moves: { id: string; p: string | null }[] = [];
    for (const c of concepts) if (!del.has(c.id) && c.parent_id && del.has(c.parent_id)) moves.push({ id: c.id, p: childParent(c.id) });
    if (moves.length) {
      const mj = JSON.stringify(moves);
      stmts.push(db.prepare(
        `${LOG} SELECT 'concept', json_extract(value,'$.id'), 'parent_id', 'update', (SELECT parent_id FROM concept WHERE id = json_extract(value,'$.id')), json_extract(value,'$.p'), ?2 FROM json_each(?1)`,
      ).bind(mj, t));
      stmts.push(db.prepare(
        `UPDATE concept SET parent_id = (SELECT json_extract(value,'$.p') FROM json_each(?1) WHERE json_extract(value,'$.id') = concept.id)
         WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`,
      ).bind(mj));
    }
    stmts.push(db.prepare(`UPDATE concept SET merged_into_id = ?2 WHERE merged_into_id IN (SELECT value FROM json_each(?1))`).bind(delJson, into));
    stmts.push(db.prepare(
      `${LOG} SELECT 'concept', id, 'name', 'delete', name, NULL, ?2 FROM concept WHERE id IN (SELECT value FROM json_each(?1))`,
    ).bind(delJson, t));
    stmts.push(db.prepare(`DELETE FROM concept WHERE id IN (SELECT value FROM json_each(?1))`).bind(delJson));
  };

  if (spec.kind === "concept") {
    for (const id of ids) if (!byId.has(id)) throw new HttpError(404, "A concept no longer exists — reload the page.");
    if (spec.op === "move") {
      const sid = spec.subject_id ?? byId.get(ids[0])!.subject_id;
      if (!subjects.some((s) => s.id === sid)) throw new HttpError(400, "Choose a subject.");
      const parent = spec.parent_id || null;
      const moving = subtree(ids);
      if (parent) {
        const p = byId.get(parent);
        if (!p) throw new HttpError(400, "That parent concept no longer exists.");
        if (moving.has(parent)) throw new HttpError(400, "A concept cannot go under itself or its own sub-concepts.");
        if (p.subject_id !== sid) throw new HttpError(400, "The new parent belongs to another subject.");
      }
      const tops = ids.filter((id) => !ids.some((o) => o !== id && subtree([o]).has(id))); // moved roots
      const topsJson = JSON.stringify(tops);
      const allJson = JSON.stringify([...moving]);
      stmts.push(db.prepare(`${LOG} SELECT 'concept', id, 'parent_id', 'update', parent_id, ?2, ?3 FROM concept WHERE id IN (SELECT value FROM json_each(?1))`).bind(topsJson, parent, t));
      stmts.push(db.prepare(`UPDATE concept SET parent_id = ?2 WHERE id IN (SELECT value FROM json_each(?1))`).bind(topsJson, parent));
      stmts.push(db.prepare(`${LOG} SELECT 'concept', id, 'subject_id', 'update', subject_id, ?2, ?3 FROM concept WHERE subject_id <> ?2 AND id IN (SELECT value FROM json_each(?1))`).bind(allJson, sid, t));
      stmts.push(db.prepare(`UPDATE concept SET subject_id = ?2 WHERE id IN (SELECT value FROM json_each(?1))`).bind(allJson, sid));
      summary = `Moved ${tops.length} concept${tops.length === 1 ? "" : "s"}`;
    } else if (spec.op === "merge") {
      const into = spec.into;
      if (!into || !byId.has(into)) throw new HttpError(400, "Choose the concept to merge into.");
      const sources = ids.filter((id) => id !== into);
      if (!sources.length) throw new HttpError(400, "Pick at least one other concept to merge.");
      if (subtree(sources).has(into)) throw new HttpError(400, "You can't merge a concept into one of its own sub-concepts.");
      removeConcepts(new Set(sources), into, () => into);
      const tSub = byId.get(into)!.subject_id;
      const moved = [...subtree(sources)].filter((id) => !sources.includes(id) && byId.get(id)!.subject_id !== tSub);
      if (moved.length) stmts.push(db.prepare(`UPDATE concept SET subject_id = ?2 WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(moved), tSub));
      summary = `Merged ${sources.length} concept${sources.length === 1 ? "" : "s"} into “${byId.get(into)!.name}”`;
    } else {
      const del = spec.children === "lift" ? new Set(ids) : subtree(ids);
      const into = spec.into || null;
      if (into && (!byId.has(into) || del.has(into))) throw new HttpError(400, "The replacement concept is being deleted too — pick another.");
      const lift = (child: string): string | null => {
        let p = byId.get(child)?.parent_id ?? null;
        for (let guard = 0; p && del.has(p) && guard < 50; guard++) p = byId.get(p)?.parent_id ?? null;
        return p;
      };
      removeConcepts(del, into, lift);
      summary = `Deleted ${del.size} concept${del.size === 1 ? "" : "s"}`;
    }
  } else {
    const known = new Set(subjects.map((s) => s.id));
    for (const id of ids) if (!known.has(id)) throw new HttpError(404, "A subject no longer exists — reload the page.");
    if (spec.op !== "delete" && spec.op !== "merge") throw new HttpError(400, "Subjects can be merged or deleted.");
    const into = spec.into || null;
    if (spec.op === "merge" && !into) throw new HttpError(400, "Choose the subject to merge into.");
    if (into && !known.has(into)) throw new HttpError(400, "The replacement subject no longer exists.");
    const del = ids.filter((id) => id !== into);
    if (!del.length) throw new HttpError(400, "Pick at least one other subject.");
    const delJson = JSON.stringify(del);
    // Questions: move to the replacement subject, or to "no subject".
    stmts.push(db.prepare(`${LOG} SELECT 'question', id, 'subject_id', 'update', subject_id, ?2, ?3 FROM question WHERE subject_id IN (SELECT value FROM json_each(?1))`).bind(delJson, into, t));
    stmts.push(db.prepare(`UPDATE question SET subject_id = ?2 WHERE subject_id IN (SELECT value FROM json_each(?1))`).bind(delJson, into));
    const owned = concepts.filter((c) => del.includes(c.subject_id));
    const keepConcepts = spec.op === "merge" || spec.concepts === "move";
    if (keepConcepts && owned.length) {
      if (!into) throw new HttpError(400, "Pick a subject to move the concepts to, or delete them.");
      // Same-named top-level concepts would clash in the target: merge them into the existing one.
      const targetRoots = new Map(concepts.filter((c) => c.subject_id === into && !c.parent_id && !c.archived_at).map((c) => [c.name.toLowerCase(), c.id]));
      const clash = owned.filter((c) => !c.parent_id && !c.archived_at && targetRoots.has(c.name.toLowerCase()));
      for (const c of clash) {
        const target = targetRoots.get(c.name.toLowerCase())!;
        removeConcepts(new Set([c.id]), target, () => target);
      }
      const rest = owned.filter((c) => !clash.includes(c)).map((c) => c.id);
      if (rest.length) {
        const rj = JSON.stringify(rest);
        stmts.push(db.prepare(`${LOG} SELECT 'concept', id, 'subject_id', 'update', subject_id, ?2, ?3 FROM concept WHERE id IN (SELECT value FROM json_each(?1))`).bind(rj, into, t));
        stmts.push(db.prepare(`UPDATE concept SET subject_id = ?2 WHERE id IN (SELECT value FROM json_each(?1))`).bind(rj, into));
      }
    } else if (owned.length) {
      removeConcepts(new Set(owned.map((c) => c.id)), null, () => null);
    }
    stmts.push(db.prepare(`${LOG} SELECT 'subject', id, 'name', 'delete', name, NULL, ?2 FROM subject WHERE id IN (SELECT value FROM json_each(?1))`).bind(delJson, t));
    stmts.push(db.prepare(`DELETE FROM subject WHERE id IN (SELECT value FROM json_each(?1))`).bind(delJson));
    summary = spec.op === "merge"
      ? `Merged ${del.length} subject${del.length === 1 ? "" : "s"} into “${subjects.find((s) => s.id === into)!.name}”`
      : `Deleted ${del.length} subject${del.length === 1 ? "" : "s"}`;
  }

  const daily = rebuildDailyStatements(db).filter((_, i) => i % 2 === 1); // the INSERTs; DELETEs ran first
  try {
    await db.batch([stmts[0], ...pre, ...stmts.slice(1), ...daily]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "A concept with that name already exists in that place. Rename or merge it first.");
    throw e;
  }
  return json({ ok: true, summary });
}
