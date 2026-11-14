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
    lib = l.questions.map((q) => ({ ...q, concepts: q.concepts ? JSON.parse(q.concepts) : [] }));
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

// Hand-off between screens (e.g. "build a paper on these concepts").
let pendingFilter: any = null;
export const setPendingFilter = (f: any) => (pendingFilter = f);
export const takePendingFilter = () => {
  const f = pendingFilter;
  pendingFilter = null;
  return f;
};
