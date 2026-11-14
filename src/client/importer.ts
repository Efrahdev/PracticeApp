// Client side of import: read files / zip / pasted text → parse → normalise →
// resolve images → stored record + fingerprint per question → preview (server
// classification) → upload files by fingerprint → commit in batches.
import { unzipSync } from "fflate";
import { parsePackText, PackParseError } from "../shared/qpack/parse";
import { normalizePack, parseDataUri } from "../shared/qpack/normalize";
import {
  allContents, answerFormatOf, answerKeyOf, composeSolution, externalRefs, fingerprintSource, mapContents, plainTextOf,
  refsInContent, rewriteRefs, storedQuestionOf, type ComposedSolution, type KeyOut,
} from "../shared/qpack/compose";
import { sha256Hex } from "../shared/qpack/hash";
import type { FieldValue, NPack, NQuestion, StoredQuestion } from "../shared/qpack/types";
import { api } from "./api";
import { ensureMath, renderSolutionBody, renderStoredQuestion, type RenderReport } from "./render";

export const PARSER_VERSION = "qpack@1";

export type Status = "new" | "new_version" | "duplicate" | "duplicate_in_file";

export interface PreparedQuestion {
  nq: NQuestion;
  stored: StoredQuestion;
  storedJson: string;
  blobSha: string;
  contentSha: string;
  plain: string;
  solution: ComposedSolution | null;
  key: KeyOut | null;
  assets: { ref: string; blob_sha256: string | null; role: "image" | "other" }[];
  errors: string[];
  warnings: string[];
  status: Status;
  existingId: string | null;
  existingBlob: { sha: string; format: string; css: string | null } | null;
  include: boolean; // false = skip this question
  asNew: boolean; // new_version → import as a separate question instead
}

export interface PreparedPack {
  sourceName: string;
  sourceBytes: Uint8Array;
  sourceMime: string;
  sourceSha: string;
  pack: NPack;
  syntax: "json" | "yaml";
  repairs: number;
  fixes: string[];
  questions: PreparedQuestion[];
  assetBlobs: Map<string, { bytes: Uint8Array; mime: string }>;
  warnings: string[];
}

export interface ReadFailure {
  name: string;
  error: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  avif: "image/avif", bmp: "image/bmp",
};
const mimeOf = (name: string, bytes?: Uint8Array) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (bytes && dec.decode(bytes.subarray(0, 200)).trimStart().startsWith("<svg")) return "image/svg+xml";
  return "application/octet-stream";
};
const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();

/** Everything the user gave us → prepared packs (each still needs preview()). */
export async function readInputs(files: File[], pasted: string | null): Promise<{ packs: PreparedPack[]; failures: ReadFailure[] }> {
  await ensureMath();
  const packs: PreparedPack[] = [];
  const failures: ReadFailure[] = [];
  const tryPack = async (name: string, text: string, sourceName: string, sourceBytes: Uint8Array, sourceMime: string, zipFiles: Map<string, Uint8Array>, dir: string) => {
    try {
      packs.push(await preparePack(name, text, sourceName, sourceBytes, sourceMime, zipFiles, dir));
    } catch (e) {
      failures.push({ name, error: e instanceof PackParseError || e instanceof Error ? e.message : String(e) });
    }
  };
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(bytes);
      } catch {
        failures.push({ name: f.name, error: "This zip file could not be opened." });
        continue;
      }
      const zipFiles = new Map<string, Uint8Array>();
      for (const [p, b] of Object.entries(entries)) if (!p.endsWith("/") && !p.startsWith("__MACOSX")) zipFiles.set(normPath(p), b);
      const packFiles = Object.keys(entries).filter((p) => /\.(json|ya?ml)$/i.test(p) && !p.startsWith("__MACOSX") && !p.split("/").pop()!.startsWith("."));
      if (!packFiles.length) failures.push({ name: f.name, error: "No .json or .yaml question pack inside this zip." });
      for (const p of packFiles) {
        const dir = p.includes("/") ? normPath(p.slice(0, p.lastIndexOf("/") + 1)) : "";
        await tryPack(`${f.name} › ${p}`, dec.decode(entries[p]), f.name, bytes, "application/zip", zipFiles, dir);
      }
    } else {
      const mime = /\.ya?ml$/i.test(f.name) ? "application/yaml" : "application/json";
      await tryPack(f.name, dec.decode(bytes), f.name, bytes, mime, new Map(), "");
    }
  }
  if (pasted && pasted.trim()) {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const bytes = enc.encode(pasted);
    await tryPack(`Pasted text`, pasted, `pasted ${stamp}`, bytes, "text/plain", new Map(), "");
  }
  return { packs, failures };
}

async function preparePack(
  name: string, text: string, sourceName: string, sourceBytes: Uint8Array, sourceMime: string, zipFiles: Map<string, Uint8Array>, dir: string,
): Promise<PreparedPack> {
  const parsed = parsePackText(text, name);
  const pack = normalizePack(parsed.value, { fileName: name.split("›").pop()!.trim() });
  const warnings: string[] = pack.issues.map((i) => i.message);
  if (parsed.repairs) warnings.unshift(`Repaired ${parsed.repairs} LaTeX backslash${parsed.repairs === 1 ? "" : "es"} damaged by JSON/YAML escaping — check the maths in the previews.`);
  if (parsed.fixes.length) warnings.push(`Tidied: ${[...new Set(parsed.fixes)].join(", ")}.`);

  // Resolve every image to bytes + fingerprint.
  const assetBlobs = new Map<string, { bytes: Uint8Array; mime: string }>();
  const byName = new Map<string, string>(); // asset name or file path (lower) → hex
  const fromZip = (path: string) => zipFiles.get(normPath(dir + path)) ?? zipFiles.get(normPath(path));
  for (const a of Object.values(pack.assets)) {
    let bytes: Uint8Array | undefined = a.bytes ?? (a.text !== undefined ? enc.encode(a.text) : undefined);
    if (!bytes && a.file) {
      if (a.file.startsWith("data:")) {
        const d = parseDataUri(a.file);
        bytes = d?.bytes ?? (d?.text !== undefined ? enc.encode(d.text) : undefined);
      } else bytes = fromZip(a.file);
    }
    if (!bytes) continue;
    const hex = await sha256Hex(bytes);
    assetBlobs.set(hex, { bytes, mime: a.mime ?? mimeOf(a.file ?? a.name, bytes) });
    byName.set(a.name.toLowerCase(), hex);
    if (a.file) byName.set(normPath(a.file), hex);
  }

  const questions: PreparedQuestion[] = [];
  for (const nq0 of pack.questions) {
    const errors = nq0.issues.filter((i) => i.level === "error").map((i) => i.message);
    const warnings = nq0.issues.filter((i) => i.level === "warning").map((i) => i.message);
    const refs = new Map<string, string | null>();
    for (const c of allContents(nq0)) {
      for (const ref of refsInContent(c)) {
        if (refs.has(ref)) continue;
        const key = ref.startsWith("asset:") ? ref.slice(6) : ref;
        let hex = byName.get(key.toLowerCase()) ?? byName.get(normPath(key)) ?? null;
        if (!hex && !ref.startsWith("asset:")) {
          const b = fromZip(ref);
          if (b) {
            hex = await sha256Hex(b);
            assetBlobs.set(hex, { bytes: b, mime: mimeOf(ref, b) });
          }
        }
        refs.set(ref, hex);
        if (!hex) warnings.push(`Image "${key}" is missing — add it to "assets" or put the file in the zip.`);
      }
      for (const ext of externalRefs(c)) warnings.push(`Web image ${ext.slice(0, 50)}… will not load (no outside calls); include the file instead.`);
    }
    const nq = mapContents(nq0, (c) => rewriteRefs(c, (t) => (refs.has(t) ? (refs.get(t) ? `asset:sha256:${refs.get(t)}` : `asset:missing:${t.replace(/^asset:/, "")}`) : null)));
    const stored = storedQuestionOf(nq, pack.css);
    const storedJson = JSON.stringify(stored);
    const solution = composeSolution(nq);
    // LaTeX check
    const report: RenderReport = { mathErrors: [] };
    renderStoredQuestion(stored, {}, report);
    if (solution) renderSolutionBody(solution.format, solution.body, report);
    for (const m of report.mathErrors.slice(0, 3)) warnings.push(`LaTeX problem: ${m}`);
    if (!solution) warnings.push("No solution.");
    if (solution?.origin === "suggestion") warnings.push("Solution written by AI — stored as Unverified until you approve it.");
    questions.push({
      nq,
      stored,
      storedJson,
      blobSha: await sha256Hex(storedJson),
      contentSha: await sha256Hex(fingerprintSource(stored)),
      plain: plainTextOf(nq),
      solution,
      key: answerKeyOf(nq),
      assets: [...refs].map(([ref, hex]) => ({ ref, blob_sha256: hex, role: "image" as const })),
      errors,
      warnings,
      status: "new",
      existingId: null,
      existingBlob: null,
      include: errors.length === 0,
      asNew: false,
    });
  }
  return {
    sourceName, sourceBytes, sourceMime, sourceSha: await sha256Hex(sourceBytes), pack, syntax: parsed.syntax, repairs: parsed.repairs,
    fixes: parsed.fixes, questions, assetBlobs, warnings,
  };
}

/** Ask the library which questions are new, changed or already there. */
export async function preview(p: PreparedPack): Promise<void> {
  if (!p.questions.length) return;
  const { results } = await api<{ results: any[] }>("POST", "/api/imports/preview", {
    questions: p.questions.map((q) => ({ ref: q.nq.ref, content_sha256: q.contentSha })),
  });
  results.forEach((r, i) => {
    const q = p.questions[i];
    q.status = r.status;
    q.existingId = r.question_id ?? null;
    q.existingBlob = r.status === "new_version" ? { sha: r.current_blob_sha256, format: r.current_format, css: r.current_css } : null;
  });
}

// ---------------------------------------------------------------- mapping (subjects, difficulty labels, fields)

export type SubjectChoice = { id: string } | { name: string } | null;
export type DifficultyChoice = { code: string } | { create: string } | null;

export interface Mapping {
  subjects: Map<string, SubjectChoice>; // key: subject name as written ("" = none given)
  difficulties: Map<string, DifficultyChoice>; // key: label as written
  updateExisting: boolean;
}

export function fieldTypes(packs: PreparedPack[], existing: { name: string; data_type: string }[]): Map<string, "text" | "number" | "date" | "boolean"> {
  const vals = new Map<string, FieldValue[]>();
  for (const p of packs) for (const q of p.questions) for (const [k, v] of Object.entries(q.nq.fields)) vals.set(k, [...(vals.get(k) ?? []), v]);
  const ex = new Map(existing.map((f) => [f.name.toLowerCase(), f.data_type]));
  const out = new Map<string, "text" | "number" | "date" | "boolean">();
  for (const [k, vs] of vals) {
    const known = ex.get(k.toLowerCase());
    if (known) out.set(k, known as any);
    else if (vs.every((v) => typeof v === "boolean")) out.set(k, "boolean");
    else if (vs.every((v) => typeof v === "number")) out.set(k, "number");
    else if (vs.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) out.set(k, "date");
    else out.set(k, "text");
  }
  return out;
}

const slugCode = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// ---------------------------------------------------------------- upload + commit

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export interface CommitResult {
  pack: string;
  new: number;
  new_versions: number;
  duplicates: number;
  rejected: number;
  updated_solutions: number;
  updated_keys: number;
}

export async function commitPacks(
  packs: PreparedPack[], mapping: Mapping, fieldTypeMap: Map<string, "text" | "number" | "date" | "boolean">, onProgress: (msg: string, frac: number) => void,
): Promise<CommitResult[]> {
  const results: CommitResult[] = [];
  const newDiffs = [...mapping.difficulties.values()].flatMap((c) => (c && "create" in c ? [{ code: slugCode(c.create), label: c.create.trim() }] : []));
  let step = 0;
  const steps = packs.length * 3;
  const tick = (msg: string, sub = 0) => onProgress(msg, Math.min(0.99, (step + sub) / steps));

  for (const p of packs) {
    const label = p.pack.title ?? p.sourceName;
    const included = p.questions.filter((q) => q.include && !q.errors.length);
    if (!included.length) {
      results.push({ pack: label, new: 0, new_versions: 0, duplicates: 0, rejected: p.questions.length, updated_solutions: 0, updated_keys: 0 });
      step += 3;
      continue;
    }
    // 1. files: original upload, images, stored question records
    tick(`Saving ${label}: original file…`);
    const blobs = new Map<string, { bytes?: Uint8Array; text?: string; mime: string }>();
    blobs.set(p.sourceSha, { bytes: p.sourceBytes, mime: p.sourceMime });
    for (const q of included) {
      blobs.set(q.blobSha, { text: q.storedJson, mime: "application/json" });
      for (const a of q.assets) if (a.blob_sha256 && p.assetBlobs.has(a.blob_sha256)) blobs.set(a.blob_sha256, p.assetBlobs.get(a.blob_sha256)!);
    }
    const { missing } = await api<{ missing: string[] }>("POST", "/api/blobs/check", { hashes: [...blobs.keys()] });
    const bin = missing.filter((h) => blobs.get(h)!.bytes);
    const txt = missing.filter((h) => blobs.get(h)!.text !== undefined);
    let done = 0;
    await pool(bin, 3, async (h) => {
      const b = blobs.get(h)!;
      await api("PUT", `/api/blobs/${h}?mime=${encodeURIComponent(b.mime)}`, b.bytes!);
      tick(`Saving ${label}: files ${++done}/${missing.length}`, (done / Math.max(1, missing.length)) * 0.9);
    });
    for (let i = 0; i < txt.length; ) {
      const chunk: { sha256: string; mime: string; text: string }[] = [];
      let size = 0;
      while (i < txt.length && chunk.length < 25 && size < 1_200_000) {
        const b = blobs.get(txt[i])!;
        chunk.push({ sha256: txt[i], mime: b.mime, text: b.text! });
        size += b.text!.length;
        i++;
      }
      await api("POST", "/api/blobs", { items: chunk });
      done += chunk.length;
      tick(`Saving ${label}: files ${done}/${missing.length}`, (done / Math.max(1, missing.length)) * 0.9);
    }
    step++;

    // 2. commit rows in batches (each batch is all-or-nothing)
    const rows = p.questions.map((q, i) => commitRow(q, i + 1, mapping, fieldTypeMap));
    const total: CommitResult = { pack: label, new: 0, new_versions: 0, duplicates: 0, rejected: 0, updated_solutions: 0, updated_keys: 0 };
    let batch: any[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await api("POST", "/api/imports/commit", {
        source: { sha256: p.sourceSha, name: p.sourceName },
        parser_version: PARSER_VERSION,
        update_existing: mapping.updateExisting,
        new_difficulties: newDiffs,
        questions: batch,
      });
      for (const k of ["new", "new_versions", "duplicates", "rejected", "updated_solutions", "updated_keys"] as const) total[k] += r[k] ?? 0;
      batch = [];
      size = 0;
    };
    for (const r of rows) {
      const s = JSON.stringify(r).length;
      if (batch.length >= 150 || size + s > 850_000) await flush();
      batch.push(r);
      size += s;
    }
    tick(`Saving ${label}: adding to the library…`, 0.5);
    await flush();
    results.push(total);
    step += 2;
  }
  onProgress("Done", 1);
  return results;
}

function commitRow(q: PreparedQuestion, position: number, mapping: Mapping, ftypes: Map<string, "text" | "number" | "date" | "boolean">) {
  const sKey = q.nq.subject ?? "";
  const subject = mapping.subjects.has(sKey) ? mapping.subjects.get(sKey)! : q.nq.subject ? { name: q.nq.subject } : null;
  const dKey = q.nq.difficulty ?? "";
  const dChoice = dKey ? mapping.difficulties.get(dKey) ?? null : null;
  const difficulty_code = dChoice ? ("code" in dChoice ? dChoice.code : slugCode(dChoice.create)) : null;
  const optionLabels = q.nq.options.map((o) => o.label);
  return {
    position,
    ref: q.nq.ref,
    number: q.nq.number ?? "",
    content_sha256: q.contentSha,
    blob_sha256: q.blobSha,
    plain_text: q.plain,
    answer_format: answerFormatOf(q.nq.type),
    option_labels: optionLabels.length ? optionLabels : null,
    marks: q.nq.marks,
    subject,
    topics: q.nq.topics,
    difficulty_code,
    fields: Object.entries(q.nq.fields).map(([name, value]) => ({ name, type: ftypes.get(name) ?? "text", value })),
    notes: q.nq.notes,
    key: q.key,
    solution: q.solution,
    assets: q.assets,
    decision: !q.include || q.errors.length ? "reject" : q.status === "new_version" && q.asNew ? "as_new" : "accept",
  };
}

/** Suggested difficulty mapping for common labels. */
export function suggestDifficulty(label: string, existing: { code: string; label: string }[]): DifficultyChoice {
  const l = label.trim().toLowerCase();
  const hit = existing.find((d) => d.code.toLowerCase() === l || d.label.toLowerCase() === l);
  if (hit) return { code: hit.code };
  const by = (codes: string[]) => existing.find((d) => codes.includes(d.code));
  if (/^(easy|basic|simple|beginner|foundation|low|1|level 1|bronze)$/.test(l)) return by(["foundation"]) ? { code: by(["foundation"])!.code } : { create: label };
  if (/^(medium|moderate|intermediate|standard|challenge|core|2|level 2|silver)$/.test(l)) return by(["challenge"]) ? { code: by(["challenge"])!.code } : { create: label };
  if (/^(hard|difficult|advanced|higher|achiever|extension|stretch|olympiad|3|level 3|gold)$/.test(l)) return by(["achiever"]) ? { code: by(["achiever"])!.code } : { create: label };
  return { create: label };
}
