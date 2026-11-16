// "Practice notes": the free-form note written under a question while solving. Stored as the question's value of the
// custom text field of this name, so it can be filtered (builder, Library, advanced conditions) and counted (Progress).
import type { Boot, LibQ } from "./types";

export const NOTES_FIELD = "Practice notes";

export function notesFieldId(boot: Boot | null | undefined): string | null {
  return boot?.fields.find((f) => f.name.toLowerCase() === NOTES_FIELD.toLowerCase() && f.data_type === "text" && !f.archived_at)?.id ?? null;
}

/** The question's note, or null when it has none. */
export function noteOf(q: LibQ, fid: string | null): string | null {
  if (!fid) return null;
  const v = q.fields?.[fid];
  return typeof v === "string" && v.trim() ? v : null;
}
