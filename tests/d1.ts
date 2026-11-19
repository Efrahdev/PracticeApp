// A small stand-in for Cloudflare D1 on top of Node's built-in SQLite, so Worker handlers can be tested against the
// real schema (every file in migrations/, applied in order). Same calls the app uses: prepare().bind().first/all/run
// and batch() — which, as on D1, runs every statement in one transaction and rolls all of them back on any error.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Val = string | number | null;

class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, readonly args: Val[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === "boolean" ? Number(a) : (a as Val))));
  }
  rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r }));
  }
  async first<T>(): Promise<T | null> {
    return (this.rows()[0] as T) ?? null;
  }
  async all<T>() {
    return { results: this.rows() as T[], success: true };
  }
  async run() {
    this.rows();
    return { success: true };
  }
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ results: s.rows(), success: true }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { raw: db, d1: d1 as unknown as D1Database };
}
