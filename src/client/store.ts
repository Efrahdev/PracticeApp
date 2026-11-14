import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import type { Boot, LibQ } from "./types";

let boot: Boot | null = null;
let lib: LibQ[] | null = null;
let loading: Promise<void> | null = null;
let error: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

async function load() {
  try {
    const [b, l] = await Promise.all([api<Boot>("GET", "/api/bootstrap"), api<{ questions: any[] }>("GET", "/api/library")]);
    boot = b;
    lib = l.questions.map((q) => ({ ...q, concepts: q.concepts ? JSON.parse(q.concepts) : [], fields: q.fields ? JSON.parse(q.fields) : {}, batches: q.batches ? JSON.parse(q.batches) : [] }));
    error = null;
  } catch (e) {
    error = (e as Error).message;
  } finally {
    loading = null;
    emit();
  }
}

/** Reload metadata after any change (one small request for ~1,000 rows). */
export function refresh(): Promise<void> {
  if (!loading) loading = load();
  return loading;
}

export function useData() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (!boot && !loading) refresh();
    return () => void subs.delete(f);
  }, []);
  return { boot, lib, error, loading: !!loading };
}

export const getBoot = () => boot;
export const getLib = () => lib;

// Hand-off between screens (e.g. "build a paper on these concepts", or
// { def, selectAll: true, openBulk: true } from an import's "Edit questions").
let pendingFilter: any = null;
export const setPendingFilter = (f: any) => (pendingFilter = f);
export const takePendingFilter = () => {
  const f = pendingFilter;
  pendingFilter = null;
  return f;
};

// Hand-off into the paper builder (#/papers/new): the Library's current filter,
// "build a paper on these concepts" from Progress, or nothing (a fresh paper).
export interface BuildInit {
  def?: unknown; // a Library FilterDef
  savedFilterId?: string | null;
  tree?: string[];
  name?: string;
  favourWeak?: boolean;
  pool?: Record<string, unknown>; // extra builder pool rules (e.g. the Library's quick filters)
}
let pendingBuild: BuildInit | null = null;
export function openBuilder(init: BuildInit = {}) {
  pendingBuild = init;
  location.hash = "#/papers/new";
}
export const takePendingBuild = () => {
  const p = pendingBuild;
  pendingBuild = null;
  return p;
};
