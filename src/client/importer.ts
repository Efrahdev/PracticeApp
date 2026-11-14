// Client side of import (FR-1.1–1.4): parse in the browser, fingerprint, upload
// content-addressed files, then ask the Worker to commit everything in one step.
import { parseQuestionBank, sha256Hex, contentFingerprint, type ParseResult } from "../shared/parse";
import { api, sha256HexBytes } from "./api";

export const PARSER_VERSION = "parse.ts@1";

export interface PreparedQuestion {
  position: number;
  number: string;
  category_key: string | null;
  band: string | null;
  html: string;
  html_sha256: string;
  content_sha256: string;
  plain_text: string;
  solution_html: string | null;
  solution_sha256: string | null;
  status?: "new" | "new_version" | "duplicate" | "duplicate_in_file";
  existing_id?: string | null;
  accept: boolean;
}

export interface Prepared {
  fileName: string;
  bytes: ArrayBuffer;
  fileSha: string;
  parsed: ParseResult;
  cssSha: string;
  missingRefs: string[];
  questions: PreparedQuestion[];
}

export async function prepareImport(file: File): Promise<Prepared> {
  const bytes = await file.arrayBuffer();
  const fileSha = await sha256HexBytes(bytes);
  const text = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(text, "text/html");
  const parsed = parseQuestionBank(doc);
  const cssSha = await sha256Hex(parsed.css);
  // Local images/fonts the file points at but does not contain (FR-1.3).
  const missingRefs = new Set<string>();
  doc.querySelectorAll("img[src], link[href], source[src]").forEach((n) => {
    const v = n.getAttribute("src") ?? n.getAttribute("href") ?? "";
    if (v && !/^(data:|https?:|#)/i.test(v)) missingRefs.add(v);
  });
  for (const m of parsed.css.matchAll(/url\(\s*['"]?([^'")]+)/gi)) if (!/^(data:|https?:|#)/i.test(m[1])) missingRefs.add(m[1]);

  const questions: PreparedQuestion[] = [];
  for (const q of parsed.questions) {
    questions.push({
      position: q.position,
      number: q.number,
      category_key: q.categoryKey,
      band: q.band,
      html: q.html,
      html_sha256: await sha256Hex(q.html),
      content_sha256: await contentFingerprint(q.html, cssSha),
      plain_text: q.plainText,
      solution_html: q.solutionHtml,
      solution_sha256: q.solutionHtml ? await sha256Hex(q.solutionHtml) : null,
      accept: true,
    });
  }
  const { results } = await api<{ results: { status: PreparedQuestion["status"]; question_id: string | null }[] }>(
    "POST", "/api/imports/preview",
    { file_name: file.name, questions: questions.map((q) => ({ number: q.number, content_sha256: q.content_sha256 })) },
  );
  results.forEach((r, i) => {
    questions[i].status = r.status;
    questions[i].existing_id = r.question_id;
    if (r.status === "duplicate" || r.status === "duplicate_in_file") questions[i].accept = false;
  });
  return { fileName: file.name, bytes, fileSha, parsed, cssSha, missingRefs: [...missingRefs], questions };
}

export async function commitImport(
  p: Prepared,
  subject: { id?: string; name?: string } | null,
  onProgress: (msg: string, frac: number) => void,
) {
  onProgress("Saving the original file…", 0.02);
  await api("PUT", `/api/blobs/${p.fileSha}?mime=${encodeURIComponent("text/html")}`, p.bytes);

  const items = new Map<string, { sha256: string; mime: string; text: string }>();
  items.set(p.cssSha, { sha256: p.cssSha, mime: "text/css", text: p.parsed.css });
  for (const q of p.questions) {
    if (!q.accept) continue;
    items.set(q.html_sha256, { sha256: q.html_sha256, mime: "text/html", text: q.html });
    if (q.solution_html && q.solution_sha256) items.set(q.solution_sha256, { sha256: q.solution_sha256, mime: "text/html", text: q.solution_html });
  }
  const { missing } = await api<{ missing: string[] }>("POST", "/api/blobs/check", { hashes: [...items.keys()] });
  const todo = missing.map((h) => items.get(h)!);
  let done = 0;
  while (todo.length) {
    const chunk: typeof todo = [];
    let size = 0;
    while (todo.length && chunk.length < 25 && size < 1_500_000) {
      const it = todo.shift()!;
      chunk.push(it);
      size += it.text.length;
    }
    await api("POST", "/api/blobs", { items: chunk });
    done += chunk.length;
    onProgress(`Uploading question files… ${done}/${missing.length}`, 0.05 + 0.85 * (done / Math.max(1, missing.length)));
  }
  onProgress("Saving to the library…", 0.93);
  const categories = p.parsed.categories.map((c) => ({ key: c.key, name: c.name }));
  const res = await api("POST", "/api/imports/commit", {
    file: { sha256: p.fileSha, name: p.fileName },
    css_sha256: p.cssSha,
    parser_version: PARSER_VERSION,
    subject,
    categories,
    questions: p.questions.map((q) => ({
      position: q.position,
      number: q.number,
      category_key: q.category_key,
      band: q.band,
      html_sha256: q.html_sha256,
      content_sha256: q.content_sha256,
      plain_text: q.plain_text,
      solution_sha256: q.solution_sha256,
      accept: q.accept,
    })),
  });
  onProgress("Done", 1);
  return res as { found: number; new: number; new_versions: number; duplicates: number; rejected: number };
}
