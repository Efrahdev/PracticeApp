// Types for the canonical question pack (practice-app/question-pack@1) after
// normalisation, and for the immutable content record stored per question version.

export const PACK_FORMAT = "practice-app/question-pack@1";
export const STORED_FORMAT = "practice-app/question@1";

export type QType = "mcq_single" | "mcq_multi" | "numeric" | "short_answer" | "open" | "multi_part";
export const QTYPES: QType[] = ["mcq_single", "mcq_multi", "numeric", "short_answer", "open", "multi_part"];

/** Exactly one of md / html is set. */
export interface Content {
  md?: string;
  html?: string;
}

export interface Option {
  label: string;
  content: Content;
}

export type Answer =
  | { kind: "mcq"; labels: string[] }
  | { kind: "numeric"; value: number; tolerance: number; unit: string | null; display: string }
  | { kind: "text"; accepted: string[] }
  | { kind: "content"; content: Content };

export interface Solution {
  answer: Content | null;
  steps: Content[];
  body: Content | null;
  origin: "source" | "ai";
}

export interface Part {
  label: string;
  type: QType;
  stem: Content | null;
  options: Option[];
  answer: Answer | null;
  solution: Solution | null;
  marks: number | null;
  hints: Content[];
}

export interface Issue {
  level: "error" | "warning";
  message: string;
}

export interface Topic {
  path: string[];
  weight: number;
}

export type FieldValue = string | number | boolean;

export interface NQuestion {
  index: number; // 0-based position in the pack
  id: string | null; // as given
  ref: string; // permanent external reference: pack key + "/" + id
  number: string | null;
  type: QType;
  stem: Content | null;
  options: Option[];
  answer: Answer | null;
  answerOrigin: "source" | "ai";
  solution: Solution | null;
  hints: Content[];
  parts: Part[];
  subject: string | null;
  topics: Topic[];
  difficulty: string | null;
  marks: number | null;
  fields: Record<string, FieldValue>;
  notes: string | null;
  source: unknown;
  extra: Record<string, unknown> | null;
  issues: Issue[];
}

export interface NAsset {
  name: string;
  mime: string | null;
  text?: string; // e.g. SVG markup
  bytes?: Uint8Array; // binary
  file?: string; // path inside the uploaded zip (resolved by the importer)
}

export interface NPack {
  format: string | null;
  id: string | null;
  key: string; // namespace for question refs
  title: string | null;
  source: string | null;
  css: string | null;
  assets: Record<string, NAsset>;
  questions: NQuestion[];
  issues: Issue[];
}

/** The immutable content record of one question version (stored as a JSON file in R2). */
export interface StoredQuestion {
  schema: typeof STORED_FORMAT;
  type: QType;
  number: string | null;
  stem: Content | null;
  options: Option[];
  parts: Omit<Part, "answer" | "solution">[];
  hints: Content[];
  css: string | null;
  source: unknown;
  extra: Record<string, unknown> | null;
}
