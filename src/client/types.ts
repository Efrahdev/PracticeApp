export interface Subject { id: string; name: string; created_at: number; archived_at: number | null }
export interface Concept { id: string; subject_id: string; parent_id: string | null; name: string; archived_at: number | null; merged_into_id: string | null }
export interface Difficulty { code: string; label: string; sort_rank: number; archived_at: number | null }
export interface ErrorType { code: string; label: string }
export interface SavedFilter { id: string; name: string; definition: string; updated_at: number }

export interface Boot {
  subjects: Subject[];
  concepts: Concept[];
  difficulties: Difficulty[];
  errorTypes: ErrorType[];
  filters: SavedFilter[];
  schemaVersion: number | null;
}

export type Result = "correct" | "incorrect" | "partial";

export interface LibQ {
  id: string;
  subject_id: string | null;
  difficulty_code: string | null;
  answer_format: "none" | "mcq_single" | "mcq_multi" | "numeric" | "text";
  created_at: number;
  archived_at: number | null;
  version_id: string;
  version_no: number;
  qno: string;
  plain_text: string;
  file_name: string;
  concepts: [string, number][];
  has_key: number;
  attempt_count: number | null;
  graded_count: number | null;
  correct_count: number | null;
  score_permille_sum: number | null;
  total_time_seconds: number | null;
  last_attempted_at: number | null;
  last_time_seconds: number | null;
  last_result: Result | null;
  personal_difficulty_permille: number | null;
  familiarity_permille: number | null;
}
