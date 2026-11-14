// Normalises a parsed question pack into one strict internal shape.
// Principle: be generous in what we accept (aliases, loose shapes, missing fields are
// inferred) and precise in what we report (per-question errors and warnings).
import { formatNumber, parseNumberish } from "./numbers";
import type { Answer, Content, FieldValue, Issue, NAsset, NPack, NQuestion, Option, Part, QType, Solution, Topic } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Reads keys by alias (exact, then case/underscore-insensitive) and remembers what was used. */
class Picker {
  private used = new Set<string>();
  private lower = new Map<string, string>();
  constructor(private o: Obj) {
    for (const k of Object.keys(o)) this.lower.set(k.toLowerCase().replace(/[\s_-]/g, ""), k);
  }
  take(...names: string[]): unknown {
    for (const n of names) {
      const k = n in this.o ? n : this.lower.get(n.toLowerCase().replace(/[\s_-]/g, ""));
      if (k !== undefined && !this.used.has(k)) {
        this.used.add(k);
        const v = this.o[k];
        if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) return v;
      }
    }
    return undefined;
  }
  rest(): Obj | null {
    const out: Obj = {};
    for (const [k, v] of Object.entries(this.o)) if (!this.used.has(k)) out[k] = v;
    return Object.keys(out).length ? out : null;
  }
}

export function slug(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.(json|ya?ml|zip|html?)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const tidy = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]<>$])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+\.)(\s)/gm, "$1\\$2$3");
}

export function normContent(v: unknown): Content | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = tidy(v);
    return t ? { md: t } : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return { md: String(v) };
  if (Array.isArray(v)) {
    const parts = v.map(normContent).filter((c): c is Content => !!c);
    if (!parts.length) return null;
    if (parts.every((p) => p.md !== undefined)) return { md: parts.map((p) => p.md).join("\n\n") };
    return { html: parts.map((p) => (p.html !== undefined ? p.html : `<p>${escapeHtml(p.md!)}</p>`)).join("\n") };
  }
  if (isObj(v)) {
    const p = new Picker(v);
    const html = p.take("html");
    if (typeof html === "string" && html.trim()) return { html: html.trim() };
    const md = p.take("markdown", "md", "latex");
    if (typeof md === "string" && md.trim()) return { md: tidy(md) };
    const text = p.take("text", "plain", "value", "content");
    if (typeof text === "string" && text.trim()) return { md: escapeMd(tidy(text)) };
  }
  return null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const contentText = (c: Content | null) => (c ? (c.md ?? c.html ?? "") : "");

// ---------------------------------------------------------------- type

const TYPE_ALIASES: Record<string, QType> = {
  mcqsingle: "mcq_single", mcq: "mcq_single", multiplechoice: "mcq_single", singlechoice: "mcq_single", choice: "mcq_single", single: "mcq_single", radio: "mcq_single", truefalse: "mcq_single", boolean: "mcq_single",
  mcqmulti: "mcq_multi", multipleselect: "mcq_multi", multiselect: "mcq_multi", multipleresponse: "mcq_multi", checkbox: "mcq_multi", checkboxes: "mcq_multi", multianswer: "mcq_multi", multiplechoicemultiple: "mcq_multi",
  numeric: "numeric", number: "numeric", numerical: "numeric", integer: "numeric", calculation: "numeric",
  shortanswer: "short_answer", short: "short_answer", text: "short_answer", shorttext: "short_answer", fillintheblank: "short_answer", fillblank: "short_answer", oneword: "short_answer",
  open: "open", openended: "open", long: "open", longanswer: "open", essay: "open", freeresponse: "open", proof: "open", worked: "open", extended: "open", explain: "open", showthat: "open",
  multipart: "multi_part", parts: "multi_part", structured: "multi_part",
};

function typeAlias(v: unknown): QType | null {
  if (typeof v !== "string") return null;
  return TYPE_ALIASES[v.toLowerCase().replace(/[\s_-]/g, "")] ?? null;
}

// ---------------------------------------------------------------- options

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const normLabel = (l: string) => {
  const t = l.trim().replace(/^\(|\)$|[.:)]$/g, "").trim();
  return /^[a-z]$/i.test(t) ? t.toUpperCase() : t;
};

function normOptions(raw: unknown, issues: Issue[]): { options: Option[]; correct: string[] } {
  const options: Option[] = [];
  const correct: string[] = [];
  if (raw === undefined) return { options, correct };
  let list: { label: string | null; v: unknown; correct?: boolean }[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((o) => {
      if (typeof o === "string" || typeof o === "number") {
        const s = String(o);
        const m = s.match(/^\s*\(?([A-Za-z]|\d{1,2})[).:]\s+([\s\S]+)$/) ?? s.match(/^\s*\(([A-Za-z]|\d{1,2})\)\s*([\s\S]+)$/);
        return m ? { label: m[1], v: m[2] } : { label: null, v: s };
      }
      if (isObj(o)) {
        const p = new Picker(o);
        const label = p.take("label", "key", "letter", "id", "option_label");
        const isCorrect = p.take("correct", "is_correct", "isCorrect", "answer");
        const content = "html" in o || "markdown" in o ? o : p.take("text", "content", "value", "option", "body", "label_text");
        return { label: label === undefined ? null : String(label), v: content, correct: isCorrect === true || isCorrect === "true" };
      }
      return { label: null, v: o };
    });
  } else if (isObj(raw)) {
    list = Object.entries(raw).map(([k, v]) => ({ label: k, v }));
  } else {
    issues.push({ level: "warning", message: "Options were not a list, so they were ignored." });
    return { options, correct };
  }
  const seen = new Set<string>();
  list.forEach((o, i) => {
    let label = o.label !== null ? normLabel(o.label) : LETTERS[i] ?? String(i + 1);
    if (!label || seen.has(label.toUpperCase())) {
      const next = LETTERS[i] ?? String(i + 1);
      if (label) issues.push({ level: "warning", message: `Option label "${label}" appears twice; relabelled ${next}.` });
      label = next;
    }
    seen.add(label.toUpperCase());
    const content = normContent(o.v);
    if (!content) issues.push({ level: "warning", message: `Option ${label} is empty.` });
    options.push({ label, content: content ?? { md: "" } });
    if (o.correct) correct.push(label);
  });
  return { options, correct };
}

// ---------------------------------------------------------------- answers

const stripMath = (s: string) => s.trim().replace(/^\$+|\$+$/g, "").trim();

function mcqLabels(raw: unknown, options: Option[], issues: Issue[]): string[] {
  const byUpper = new Map(options.map((o) => [o.label.toUpperCase(), o.label]));
  const byText = new Map(options.map((o) => [stripMath(contentText(o.content)).toLowerCase(), o.label]));
  const out: string[] = [];
  const add = (token: string) => {
    const t = token.trim();
    if (!t) return;
    const lab = normLabel(t.replace(/^(option|answer|choice)\s+/i, ""));
    const hit = byUpper.get(lab.toUpperCase()) ?? byText.get(stripMath(t).toLowerCase());
    if (hit) {
      if (!out.includes(hit)) out.push(hit);
      return;
    }
    // a 1-based index when the labels are letters
    if (/^\d+$/.test(t) && !byUpper.has(t) && Number(t) >= 1 && Number(t) <= options.length) {
      const l = options[Number(t) - 1].label;
      if (!out.includes(l)) out.push(l);
      issues.push({ level: "warning", message: `Answer "${t}" was read as option ${l} (position ${t}).` });
      return;
    }
    issues.push({ level: "warning", message: `Answer "${t}" is not one of the options, so it was ignored.` });
  };
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "number") add(String(v));
    else if (typeof v === "string") {
      const s = v.trim();
      if (byUpper.has(normLabel(s).toUpperCase()) || byText.has(stripMath(s).toLowerCase())) add(s);
      else if (/^[A-Za-z](\s*(,|;|&|\band\b|\s)\s*[A-Za-z])+$/.test(s)) s.split(/\s*(?:,|;|&|\band\b|\s)\s*/).forEach(add);
      else if (/^[A-Z]{2,6}$/.test(s) && [...s].every((ch) => byUpper.has(ch))) [...s].forEach(add);
      else add(s);
    } else if (isObj(v)) {
      const p = new Picker(v);
      visit(p.take("options", "labels", "label", "value", "answer", "correct"));
    }
  };
  visit(raw);
  return out;
}

function numericAnswer(raw: unknown): Answer | null {
  let value: unknown = raw;
  let tol: number | null = null;
  let unit: string | null = null;
  if (isObj(raw)) {
    const p = new Picker(raw);
    value = p.take("value", "answer", "number", "exact");
    const t = p.take("tolerance", "tol", "error", "plus_minus", "margin");
    if (typeof t === "number" && t >= 0) tol = t;
    else if (typeof t === "string" && parseNumberish(t)) tol = Math.abs(parseNumberish(t)!.value);
    const u = p.take("unit", "units");
    if (typeof u === "string" && u.trim()) unit = u.trim();
  }
  const n = parseNumberish(value);
  if (!n) return null;
  const display = typeof value === "string" ? stripMath(value) : formatNumber(n.value);
  const finalUnit = unit ?? n.unit;
  return {
    kind: "numeric",
    value: n.value,
    tolerance: tol ?? n.tolerance ?? 0,
    unit: finalUnit,
    display: finalUnit && !display.includes(finalUnit) ? `${display} ${finalUnit}` : display,
  };
}

function textAnswer(raw: unknown): Answer | null {
  const acc: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s) acc.push(s);
    } else if (isObj(v)) {
      const p = new Picker(v);
      visit(p.take("accepted", "answers", "value", "answer", "text"));
    }
  };
  visit(raw);
  return acc.length ? { kind: "text", accepted: [...new Set(acc)] } : null;
}

// ---------------------------------------------------------------- solutions

function normSolution(raw: unknown, extraBody: unknown, extraSteps: unknown, extraAnswer: unknown, aiFlag: boolean, issues: Issue[]): Solution | null {
  let answer: Content | null = null;
  let steps: Content[] = [];
  let body: Content | null = null;
  let origin: "source" | "ai" = aiFlag ? "ai" : "source";

  const asSteps = (v: unknown): Content[] =>
    Array.isArray(v) ? v.map(normContent).filter((c): c is Content => !!c) : normContent(v) ? [normContent(v)!] : [];

  if (Array.isArray(raw)) steps = asSteps(raw);
  else if (isObj(raw) && !("html" in raw) && !("markdown" in raw)) {
    const p = new Picker(raw);
    answer = normContent(p.take("answer", "final_answer", "final", "result", "conclusion"));
    steps = asSteps(p.take("steps", "working", "workings", "method", "work"));
    body = normContent(p.take("explanation", "text", "body", "solution", "details", "content", "markdown", "md"));
    const o = p.take("origin", "source", "author", "generated_by");
    const ai = p.take("ai_generated", "generated", "is_ai");
    const verified = p.take("verified");
    if ((typeof o === "string" && /ai|model|gpt|claude|gemini|generated|llm/i.test(o)) || ai === true || verified === false) origin = "ai";
  } else if (raw !== undefined) {
    body = normContent(raw);
    if (!body) issues.push({ level: "warning", message: "The solution could not be read, so it was ignored." });
  }
  if (!body) body = normContent(extraBody);
  else if (extraBody !== undefined && normContent(extraBody)) {
    const e = normContent(extraBody)!;
    if (body.md !== undefined && e.md !== undefined) body = { md: `${body.md}\n\n${e.md}` };
  }
  if (!steps.length) steps = asSteps(extraSteps);
  if (!answer) answer = normContent(extraAnswer);
  if (!answer && !steps.length && !body) return null;
  return { answer, steps, body, origin };
}

// ---------------------------------------------------------------- topics, fields

function normTopics(raw: unknown, issues: Issue[]): Topic[] {
  if (raw === undefined) return [];
  const out: Topic[] = [];
  const pushPath = (name: string, weight: unknown) => {
    const path = name.split(/\s*(?:>|›|»|→|\/\/|::)\s*/).map((s) => s.trim()).filter(Boolean);
    if (!path.length) return;
    let w = 1;
    if (weight !== undefined) {
      const n = typeof weight === "number" ? weight : Number(weight);
      if (n > 0 && n <= 1) w = n;
      else if (n > 1 && n <= 100) {
        w = n / 100;
        issues.push({ level: "warning", message: `Topic weight ${n} for "${name}" was read as ${w}.` });
      } else issues.push({ level: "warning", message: `Topic weight for "${name}" must be above 0 and at most 1; used 1.` });
    }
    const key = path.join(">").toLowerCase();
    const existing = out.find((t) => t.path.join(">").toLowerCase() === key);
    if (existing) existing.weight = w;
    else out.push({ path, weight: Math.round(w * 1000) / 1000 });
  };
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "string") {
      const s = v.trim();
      if (/[;\n]/.test(s)) s.split(/[;\n]/).forEach((x) => visit(x));
      else if (s.includes(",") && !/[>›»→]/.test(s)) s.split(",").forEach((x) => visit(x));
      else if (s) pushPath(s, undefined);
    } else if (isObj(v)) {
      const p = new Picker(v);
      const name = p.take("name", "path", "topic", "title", "concept", "label");
      if (typeof name === "string") pushPath(name, p.take("weight", "share", "w"));
      else if (Array.isArray(name)) pushPath(name.map(String).join(" > "), p.take("weight", "share", "w"));
    }
  };
  visit(raw);
  return out;
}

function normFields(raw: unknown, issues: Issue[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  if (!isObj(raw)) {
    if (raw !== undefined) issues.push({ level: "warning", message: "\"fields\" must be an object of name → value; ignored." });
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim();
    if (!name || v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[name] = typeof v === "string" ? v.trim() : v;
    else if (Array.isArray(v)) out[name] = v.map(String).join(", ");
    else out[name] = JSON.stringify(v);
  }
  return out;
}

// ---------------------------------------------------------------- parts

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];

function inferType(explicit: QType | null, hasParts: boolean, options: Option[], answerRaw: unknown, issues: Issue[], where: string): QType {
  if (hasParts) {
    if (explicit && explicit !== "multi_part") issues.push({ level: "warning", message: `${where}type "${explicit}" ignored because it has parts.` });
    return "multi_part";
  }
  if (options.length) {
    if (explicit === "mcq_multi") return "mcq_multi";
    if (explicit && explicit !== "mcq_single") issues.push({ level: "warning", message: `${where}has options, so it is treated as multiple choice (not "${explicit}").` });
    return "mcq_single";
  }
  if (explicit === "multi_part") {
    issues.push({ level: "warning", message: `${where}is marked multi-part but has no parts.` });
    return "open";
  }
  if (explicit === "mcq_single" || explicit === "mcq_multi") {
    issues.push({ level: "warning", message: `${where}is marked multiple choice but has no options; treated as ${parseNumberish(answerRaw) ? "numeric" : "short answer"}.` });
    return parseNumberish(answerRaw) ? "numeric" : "short_answer";
  }
  if (explicit) return explicit;
  if (answerRaw === undefined) return "open";
  if (typeof answerRaw === "number" || (isObj(answerRaw) && parseNumberish((answerRaw as Obj).value) !== null)) return "numeric";
  if (typeof answerRaw === "string") {
    if (parseNumberish(answerRaw)) return "numeric";
    if (answerRaw.length <= 80 && !answerRaw.includes("\n")) return "short_answer";
    return "open";
  }
  if (Array.isArray(answerRaw) && answerRaw.every((a) => typeof a === "string" && a.length <= 80)) return "short_answer";
  return "open";
}

function normAnswer(type: QType, raw: unknown, options: Option[], correct: string[], issues: Issue[], where: string): { type: QType; answer: Answer | null } {
  if (type === "mcq_single" || type === "mcq_multi") {
    const labels = mcqLabels(raw, options, issues);
    for (const c of correct) if (!labels.includes(c)) labels.push(c);
    if (!labels.length) {
      if (raw !== undefined) issues.push({ level: "warning", message: `${where}answer could not be matched to an option.` });
      return { type, answer: null };
    }
    if (type === "mcq_single" && labels.length > 1) {
      issues.push({ level: "warning", message: `${where}has ${labels.length} correct options, so it was treated as "choose all that apply".` });
      return { type: "mcq_multi", answer: { kind: "mcq", labels } };
    }
    return { type, answer: { kind: "mcq", labels } };
  }
  if (raw === undefined) return { type, answer: null };
  if (type === "numeric") {
    const a = numericAnswer(raw);
    if (a) return { type, answer: a };
    issues.push({ level: "warning", message: `${where}numeric answer "${typeof raw === "string" ? raw : JSON.stringify(raw)}" is not a number; treated as a short answer.` });
    return { type: "short_answer", answer: textAnswer(raw) };
  }
  if (type === "short_answer") return { type, answer: textAnswer(raw) };
  const c = normContent(isObj(raw) && !("html" in raw) && !("markdown" in raw) ? ((raw as Obj).value ?? (raw as Obj).answer ?? (raw as Obj).text) : raw);
  return { type, answer: c ? { kind: "content", content: c } : null };
}

function normPart(raw: unknown, i: number, aiDefault: boolean, issues: Issue[], roman: boolean): Part {
  const where = `Part ${i + 1}: `;
  if (typeof raw === "string") raw = { stem: raw };
  const o: Obj = isObj(raw) ? raw : {};
  const p = new Picker(o);
  const labelRaw = p.take("label", "part", "id", "number", "letter");
  const label = labelRaw !== undefined ? String(labelRaw).trim().replace(/^\(|\)$/g, "") : roman ? ROMAN[i] ?? String(i + 1) : "abcdefghijklmnopqrstuvwxyz"[i] ?? String(i + 1);
  const stem = normContent(p.take("stem", "question", "text", "prompt", "body", "content", "statement"));
  const { options, correct } = normOptions(p.take("options", "choices", "alternatives"), issues);
  const explicit = typeAlias(p.take("type", "question_type", "qtype", "kind"));
  const answerRaw = p.take("answer", "correct_answer", "correct", "answer_key", "key", "final_answer");
  const solRaw = p.take("solution", "worked_solution", "working", "workings", "method", "mark_scheme", "rationale");
  const expl = p.take("explanation");
  const steps = p.take("steps", "solution_steps");
  const aiFlag = p.take("ai_generated", "solution_origin");
  const marksRaw = p.take("marks", "mark", "points", "score", "max_marks");
  const hints = toContents(p.take("hints", "hint"));
  let type = inferType(explicit, false, options, answerRaw, issues, `Part (${label}) `);
  const na = normAnswer(type, answerRaw, options, correct, issues, `Part (${label}) `);
  type = na.type;
  const solution = normSolution(solRaw, expl, steps, undefined, aiDefault || aiFlag === true || aiFlag === "ai", issues);
  if (!stem && !options.length) issues.push({ level: "warning", message: `${where}has no text.` });
  return { label, type, stem, options, answer: na.answer, solution, marks: marksOf(marksRaw, issues), hints };
}

function toContents(v: unknown): Content[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(normContent).filter((c): c is Content => !!c);
}

function marksOf(v: unknown, issues: Issue[]): number | null {
  if (v === undefined) return null;
  const n = parseNumberish(v);
  if (!n || n.value < 0) {
    issues.push({ level: "warning", message: `Marks "${String(v)}" is not a number; ignored.` });
    return null;
  }
  return n.value;
}

// ---------------------------------------------------------------- questions

interface Ctx {
  key: string;
  defaults: { subject: string | null; topics: Topic[]; difficulty: string | null; fields: Record<string, FieldValue>; aiSolutions: boolean };
  ids: Map<string, number>;
}

function normQuestion(raw: unknown, index: number, ctx: Ctx): NQuestion {
  const issues: Issue[] = [];
  if (typeof raw === "string") raw = { stem: raw };
  const o: Obj = isObj(raw) ? raw : {};
  if (!isObj(raw)) issues.push({ level: "error", message: "This entry is not a question object." });
  const p = new Picker(o);

  const idRaw = p.take("id", "question_id", "qid", "uid");
  const numberRaw = p.take("number", "num", "no", "question_number", "qno", "label");
  const number = numberRaw !== undefined ? String(numberRaw).trim().replace(/^Q(?:uestion)?\s*/i, "").replace(/[.)]$/, "") : null;
  let id = idRaw !== undefined ? String(idRaw).trim() : number !== null ? `q${number}` : `item-${index + 1}`;
  const stem = normContent(p.take("stem", "question", "text", "prompt", "body", "content", "question_text", "statement", "problem", "q"));
  const { options, correct } = normOptions(p.take("options", "choices", "alternatives"), issues);
  const explicitRaw = p.take("type", "question_type", "qtype", "kind");
  const explicit = typeAlias(explicitRaw);
  if (explicitRaw !== undefined && !explicit) issues.push({ level: "warning", message: `Unknown type "${String(explicitRaw)}"; the type was worked out instead.` });
  const answerRaw = p.take("answer", "correct_answer", "correct", "answer_key", "key", "correct_option", "correct_options", "answers", "a");
  const finalAnswer = p.take("final_answer");
  const solRaw = p.take("solution", "worked_solution", "solutions", "working", "workings", "method", "mark_scheme", "markscheme", "rationale");
  const expl = p.take("explanation", "explanations");
  const steps = p.take("steps", "solution_steps");
  const aiFlag = p.take("ai_generated", "solution_origin", "generated");
  const verified = p.take("verified");
  const partsRaw = p.take("parts", "subquestions", "sub_questions", "subparts", "sub_parts");
  const hints = toContents(p.take("hints", "hint"));
  const subjectRaw = p.take("subject");
  const topicsRaw = p.take("topics", "topic", "concepts", "concept", "skills", "skill");
  const difficultyRaw = p.take("difficulty", "level", "band", "difficulty_level");
  const marksRaw = p.take("marks", "mark", "points", "score", "max_marks", "total_marks");
  const tagsRaw = p.take("tags", "tag", "keywords");
  const fieldsRaw = p.take("fields", "custom_fields", "metadata", "meta", "properties", "attributes");
  const source = p.take("source", "reference", "provenance");
  const notesRaw = p.take("notes", "note", "comment", "comments", "remarks");
  const extra = p.rest();

  const aiDefault = ctx.defaults.aiSolutions || aiFlag === true || (typeof aiFlag === "string" && /ai|model|generated/i.test(aiFlag)) || verified === false;
  const partsList = Array.isArray(partsRaw) ? partsRaw : isObj(partsRaw) ? Object.entries(partsRaw).map(([k, v]) => (isObj(v) ? { label: k, ...v } : { label: k, stem: v })) : [];
  const roman = partsList.length > 0 && isObj(partsList[0]) && typeof (partsList[0] as Obj).label === "string" && /^i+$/i.test(String((partsList[0] as Obj).label));
  const parts = partsList.map((pr, i) => normPart(pr, i, aiDefault, issues, roman));

  let type = inferType(explicit, parts.length > 0, options, answerRaw ?? finalAnswer, issues, "");
  let answer: Answer | null = null;
  if (type === "multi_part") {
    const c = normContent(answerRaw ?? finalAnswer);
    answer = c ? { kind: "content", content: c } : null;
  } else {
    const na = normAnswer(type, answerRaw ?? finalAnswer, options, correct, issues, "");
    type = na.type;
    answer = na.answer;
  }
  const solution = normSolution(solRaw, expl, steps, undefined, aiDefault, issues);

  if (!stem && !parts.length && !options.length) issues.push({ level: "error", message: "The question has no text (no \"stem\" and no \"parts\")." });
  if ((type === "mcq_single" || type === "mcq_multi") && options.length < 2) issues.push({ level: "warning", message: "Multiple choice with fewer than 2 options." });
  if ((type === "mcq_single" || type === "mcq_multi" || type === "numeric" || type === "short_answer") && !answer) {
    issues.push({ level: "warning", message: "No answer given — you will mark it yourself." });
  }
  if (type === "multi_part" && parts.some((pt) => !pt.answer && !pt.solution) && !solution) {
    issues.push({ level: "warning", message: "Some parts have no answer or solution." });
  }

  // ids: unique within the pack
  const seenAt = ctx.ids.get(id.toLowerCase());
  if (seenAt !== undefined) {
    issues.push({ level: "warning", message: `Id "${id}" is also used by question ${seenAt + 1}; this one was given its own id.` });
    id = `${id}~${index + 1}`;
  }
  ctx.ids.set(id.toLowerCase(), index);

  const fields = { ...ctx.defaults.fields, ...normFields(fieldsRaw, issues) };
  const tags = tagsRaw === undefined ? [] : (Array.isArray(tagsRaw) ? tagsRaw : String(tagsRaw).split(/[,;]/)).map((t) => String(t).trim()).filter(Boolean);
  if (tags.length) fields["Tags"] = [...new Set([...(typeof fields["Tags"] === "string" ? fields["Tags"].split(/,\s*/) : []), ...tags])].join(", ");

  const ownTopics = normTopics(topicsRaw, issues);
  const topics = [...ctx.defaults.topics.filter((d) => !ownTopics.some((t) => t.path.join(">").toLowerCase() === d.path.join(">").toLowerCase())), ...ownTopics];
  const marks = marksOf(marksRaw, issues) ?? (parts.some((pt) => pt.marks !== null) ? parts.reduce((s, pt) => s + (pt.marks ?? 0), 0) : null);

  return {
    index,
    id: idRaw !== undefined ? String(idRaw) : null,
    ref: `${ctx.key}/${id}`,
    number,
    type,
    stem,
    options,
    answer,
    answerOrigin: aiDefault ? "ai" : "source",
    solution,
    hints,
    parts,
    subject: typeof subjectRaw === "string" ? subjectRaw.trim() : ctx.defaults.subject,
    topics,
    difficulty: difficultyRaw !== undefined ? String(difficultyRaw).trim() : ctx.defaults.difficulty,
    marks,
    fields,
    notes: typeof notesRaw === "string" ? notesRaw.trim() : notesRaw !== undefined ? JSON.stringify(notesRaw) : null,
    source: source ?? null,
    extra,
    issues,
  };
}

// ---------------------------------------------------------------- assets

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseDataUri(uri: string): { mime: string; bytes?: Uint8Array; text?: string } | null {
  const m = uri.match(/^data:([^;,]*)(;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  if (m[3]) return { mime, bytes: decodeBase64(m[4]) };
  return { mime, text: decodeURIComponent(m[4]) };
}

function normAssets(raw: unknown, issues: Issue[]): Record<string, NAsset> {
  const out: Record<string, NAsset> = {};
  if (raw === undefined) return out;
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((a, i) => [isObj(a) && typeof a.name === "string" ? a.name : isObj(a) && typeof a.id === "string" ? a.id : `asset${i + 1}`, a])
    : isObj(raw)
      ? Object.entries(raw)
      : [];
  for (const [name, a] of entries) {
    try {
      if (typeof a === "string") {
        const s = a.trim();
        if (s.startsWith("data:")) {
          const d = parseDataUri(s);
          if (d) out[name] = { name, mime: d.mime, bytes: d.bytes, text: d.text };
        } else if (s.startsWith("<svg") || s.startsWith("<?xml")) out[name] = { name, mime: "image/svg+xml", text: s };
        else out[name] = { name, mime: null, file: s };
        continue;
      }
      if (!isObj(a)) continue;
      const p = new Picker(a);
      const mime = p.take("type", "mime", "mime_type", "content_type", "media_type");
      const data = p.take("data", "svg", "content", "text");
      const b64 = p.take("base64", "b64");
      const file = p.take("file", "path", "src", "filename");
      const url = p.take("url", "uri");
      const m = typeof mime === "string" ? mime : null;
      if (typeof b64 === "string") out[name] = { name, mime: m, bytes: decodeBase64(b64.replace(/^data:[^,]*,/, "")) };
      else if (typeof data === "string" && data.trim().startsWith("data:")) {
        const d = parseDataUri(data.trim());
        if (d) out[name] = { name, mime: m ?? d.mime, bytes: d.bytes, text: d.text };
      } else if (typeof data === "string") out[name] = { name, mime: m ?? (data.trim().startsWith("<svg") ? "image/svg+xml" : "text/plain"), text: data };
      else if (typeof file === "string") out[name] = { name, mime: m, file };
      else if (typeof url === "string" && url.startsWith("data:")) {
        const d = parseDataUri(url);
        if (d) out[name] = { name, mime: m ?? d.mime, bytes: d.bytes, text: d.text };
      } else if (typeof url === "string") {
        issues.push({ level: "warning", message: `Image "${name}" is a web link (${url.slice(0, 60)}); outside links never load. Put the file in a zip instead.` });
      } else issues.push({ level: "warning", message: `Image "${name}" has no data or file.` });
    } catch {
      issues.push({ level: "warning", message: `Image "${name}" could not be read (bad base64?).` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack

export interface NormalizeOptions {
  fileName?: string;
}

export function normalizePack(raw: unknown, opts: NormalizeOptions = {}): NPack {
  const issues: Issue[] = [];
  let root: Obj;
  if (Array.isArray(raw)) root = { questions: raw };
  else if (isObj(raw)) root = raw;
  else throw new Error("Expected a question pack: an object with a \"questions\" list (or just the list).");

  const rp = new Picker(root);
  const format = rp.take("format", "$schema", "schema", "version");
  let questionsRaw = rp.take("questions", "items", "problems", "question_list");
  if (questionsRaw === undefined) {
    // a single question on its own
    if (rp.take("stem", "question", "parts") !== undefined) questionsRaw = [root];
    else throw new Error("No \"questions\" list found in this file.");
  }
  if (isObj(questionsRaw)) {
    questionsRaw = Object.entries(questionsRaw).map(([k, v]) => (isObj(v) ? { id: k, ...v } : { id: k, stem: v }));
  }
  if (!Array.isArray(questionsRaw)) throw new Error("\"questions\" must be a list.");

  const packRaw = rp.take("pack", "meta", "metadata", "info", "source_info");
  const pk = new Picker(isObj(packRaw) ? packRaw : root); // AI sometimes puts pack facts at the top level
  const id = pk.take("id", "pack_id", "slug");
  const title = pk.take("title", "name");
  const source = pk.take("source", "origin", "book", "document");
  const subject = pk.take("subject");
  const topics = normTopics(pk.take("topics", "topic", "concepts", "chapter"), issues);
  const difficulty = pk.take("difficulty", "level");
  const fields = normFields(pk.take("fields", "custom_fields"), issues);
  const solOrigin = pk.take("solutions_origin", "solution_origin");
  const css = pk.take("css", "style", "styles");
  const assets = normAssets(rp.take("assets", "images", "figures", "files") ?? (isObj(packRaw) ? pk.take("assets", "images", "figures") : undefined), issues);

  if (format !== undefined && typeof format === "string" && !/question-pack@1/.test(format)) {
    issues.push({ level: "warning", message: `Unexpected format "${format}"; reading it as practice-app/question-pack@1.` });
  }
  const fileStem = (opts.fileName ?? "").replace(/^.*[\\/]/, "");
  const key = slug(id) || slug(title) || slug(fileStem) || "pack";
  if (!id) issues.push({ level: "warning", message: `No pack.id, so "${key}" is used. Give the same pack.id every time you convert this source so changed questions are recognised as new versions.` });

  const ctx: Ctx = {
    key,
    defaults: {
      subject: typeof subject === "string" ? subject.trim() : null,
      topics,
      difficulty: difficulty !== undefined ? String(difficulty).trim() : null,
      fields,
      aiSolutions: typeof solOrigin === "string" && /ai/i.test(solOrigin),
    },
    ids: new Map(),
  };
  const questions = questionsRaw.map((q, i) => normQuestion(q, i, ctx));
  if (!questions.length) issues.push({ level: "error", message: "The pack has no questions." });

  return {
    format: typeof format === "string" ? format : null,
    id: typeof id === "string" ? id : null,
    key,
    title: typeof title === "string" ? title.trim() : null,
    source: typeof source === "string" ? source.trim() : null,
    css: typeof css === "string" && css.trim() ? css : null,
    assets,
    questions,
    issues,
  };
}
