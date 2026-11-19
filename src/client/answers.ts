// Answers as the practice screen handles them: what the answer box holds, what is sent and stored on an attempt,
// and how a saved answer is shown again (going back to a question, changing an answer). Pure functions, unit-tested.
import { parseNumberish } from "../shared/qpack/numbers";

export function responseOf(item: { answer_format: string }, v: any): SavedResponse {
  const f = item.answer_format;
  if ((f === "mcq_single" || f === "mcq_multi") && Array.isArray(v) && v.length) return { kind: "mcq", options: v };
  if (f === "numeric" && typeof v === "string" && parseNumberish(v)) return { kind: "numeric", numeric: parseNumberish(v)!.value };
  if (f === "text" && typeof v === "string" && v.trim()) return { kind: "text", text: v };
  return { kind: "none" };
}

export interface SavedResponse { kind: "none" | "mcq" | "numeric" | "text"; options?: string[] | null; numeric?: number | null; text?: string | null }

/** The response stored on an attempt row, in the shape the screen uses. */
export function responseFromRow(a: { response_kind: string; response_options?: string | null; response_numeric?: number | null; response_text?: string | null }): SavedResponse {
  return {
    kind: a.response_kind as SavedResponse["kind"],
    options: a.response_kind === "mcq" ? JSON.parse(a.response_options ?? "[]") : null,
    numeric: a.response_kind === "numeric" ? a.response_numeric ?? null : null,
    text: a.response_kind === "text" ? a.response_text ?? "" : null,
  };
}

/** A saved response as the answer box's value, so "Change answer" starts from what was given. */
export function inputValueOf(r: SavedResponse): any {
  if (r.kind === "mcq") return r.options ?? [];
  if (r.kind === "numeric") return r.numeric === null || r.numeric === undefined ? "" : String(r.numeric);
  if (r.kind === "text") return r.text ?? "";
  return undefined;
}

export function responseLabel(r: SavedResponse): string {
  if (r.kind === "mcq") return (r.options ?? []).join(", ");
  if (r.kind === "numeric") return String(r.numeric ?? "");
  if (r.kind === "text") return r.text ?? "";
  return "";
}

/** Formats whose answer box can be changed after saving (worked-on-paper questions only have Correct grade). */
export const CHANGEABLE_FORMATS = ["mcq_single", "mcq_multi", "numeric", "text"];

/** First position (in paper order) that has no saved answer, or null when every question is answered. */
export function firstUnanswered(items: { position: number }[], answered: Record<number, unknown>): number | null {
  for (const i of [...items].sort((a, b) => a.position - b.position)) if (!answered[i.position]) return i.position;
  return null;
}

/** True when two responses are the same answer (options in any order). */
export function sameResponse(a: SavedResponse, b: SavedResponse): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "mcq") return JSON.stringify([...(a.options ?? [])].sort()) === JSON.stringify([...(b.options ?? [])].sort());
  if (a.kind === "numeric") return (a.numeric ?? null) === (b.numeric ?? null);
  if (a.kind === "text") return (a.text ?? "") === (b.text ?? "");
  return true;
}
