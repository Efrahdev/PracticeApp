#!/usr/bin/env node
// Convert grammar_midterm_mastery_assessment.html -> question pack.
//
// The page keeps every question as a JS object in four arrays (NOUN_/PRONOUN_/ADJECTIVE_/FINAL_QUESTIONS).
// We evaluate exactly those array literals (nothing else from the page's script) in a sandbox and map each
// object 1:1. No text is retyped. Page-computed fields (auditDifficulty, cognitiveDemand) are NOT authored
// content and are not imported. Review sheets / section intros are teaching text, not questions, and are skipped.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "grammar_midterm_mastery_assessment.html"), "utf8");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length !== 1) throw new Error(`expected exactly 1 inline script, found ${scripts.length}`);
const js = scripts[0];

// keep only the four data declarations
const decl = (name) => {
  const start = js.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = js.indexOf("[", start), depth = 0, inStr = false, q = "", esc = false;
  for (; i < js.length; i++) {
    const c = js[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = true; q = c; continue; }
    if (c === "[") depth++;
    if (c === "]" && --depth === 0) break;
  }
  return js.slice(start, i + 1) + ";";
};
const ARRAYS = ["NOUN_QUESTIONS", "PRONOUN_QUESTIONS", "ADJECTIVE_QUESTIONS", "FINAL_QUESTIONS"];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(ARRAYS.map(decl).join("\n") + `\nthis.OUT = {${ARRAYS.join(",")}};`, ctx);
const SRC = ctx.OUT;

const ORDER = ["Plural Rules", "Countability", "Quantifiers", "Personal Pronouns", "Reflexives", "Possessives & Other Pronouns", "Adjectives & Determiners", "Error Lab", "Final Mixed Challenge"];

// ---- helpers
const ESC = /([\\`*_\[\]<>|~$])/g;
const esc = (s) => s.replace(ESC, "\\$1").replace(/&(#?[A-Za-z0-9]+;)/g, "\\&$1");
const letter = (i) => String.fromCharCode(65 + i);
// source difficulty -> the library's three labels (printed label is kept in the "Source difficulty" field)
const DIFF = { FOUNDATION: "Foundation", INTERMEDIATE: "Challenge", CHALLENGE: "Challenge", TRAP: "Achiever", MASTERY: "Achiever" };
const GROUP = { NOUN_QUESTIONS: "Nouns", PRONOUN_QUESTIONS: "Pronouns", ADJECTIVE_QUESTIONS: "Adjectives and Determiners", FINAL_QUESTIONS: "Final Mixed Challenge" };

const labelled = [
  ["rule", "Core rule"], ["why", "Why it works here"], ["wrong", "Why the tempting answer fails"],
  ["trap", "Exam trap"], ["nuance", "Nuance / exception"], ["transfer", "Transfer example"], ["remember", "Remember this"],
];

const all = [];
for (const arr of ARRAYS) for (const q of SRC[arr]) all.push({ ...q, _arr: arr });

// numbering = the page's own render order (sections in ORDER, array order inside a section)
const ordered = ORDER.flatMap((s) => all.filter((q) => q.section === s));
if (ordered.length !== all.length) throw new Error("a question has a section outside ORDER");
ordered.forEach((q, i) => { if (q.id !== "q" + String(i + 1).padStart(3, "0")) throw new Error(`id/position mismatch at ${q.id}`); });

const questions = ordered.map((q, i) => {
  const number = String(i + 1);
  const exp = q.explanation;
  const out = { id: q.id, number, stem: esc(q.prompt) };
  const topicPath = ["Grammar", GROUP[q._arr], q.section].concat(q.section === "Final Mixed Challenge" ? [] : [q.topic]);
  if (q.type === "single" || q.type === "multi") {
    out.type = q.type === "single" ? "mcq_single" : "mcq_multi";
    out.options = q.options.map((o, k) => ({ label: letter(k), text: esc(o.label) }));
    const byValue = new Map(q.options.map((o, k) => [o.value, letter(k)]));
    const toLetter = (v) => { if (!byValue.has(v)) throw new Error(`${q.id}: answer ${v} is not an option`); return byValue.get(v); };
    if (q.type === "single") { if (typeof q.answer !== "string") throw new Error(`${q.id}: single answer must be a string`); out.answer = toLetter(q.answer); }
    else { if (!Array.isArray(q.answer) || !q.answer.length) throw new Error(`${q.id}: multi answer must be a list`); out.answer = q.answer.map(toLetter).sort(); }
  } else if (q.type === "input") {
    out.type = "short_answer";
    if (!Array.isArray(q.answer) || !q.answer.length) throw new Error(`${q.id}: input answer must be a list`);
    out.answer = q.answer.slice(); // accepted answers: plain text, compared as typed (not Markdown)
  } else if (q.type === "open") {
    out.type = "open";
    out.answer = esc(q.answer);
  } else throw new Error(`${q.id}: unknown type ${q.type}`);

  const body = [];
  if (q.type === "open") body.push(`**Correct answer / model answer:** ${esc(exp.correct)}`);
  for (const [key, title] of labelled) { if (!exp[key]) throw new Error(`${q.id}: explanation.${key} empty`); body.push(`**${title}:** ${esc(exp[key])}`); }
  out.solution = { answer: q.type === "open" ? esc(q.answer) : esc(exp.correct), explanation: body.join("\n\n") };

  out.topics = [topicPath.join(" > ")];
  out.difficulty = DIFF[q.difficulty];
  if (!out.difficulty) throw new Error(`${q.id}: unmapped difficulty ${q.difficulty}`);
  out.fields = { "Source difficulty": q.difficulty, Section: q.section, "Skill focus": q.subtopic, "Task type": q.format };
  out.source = { id: q.id, array: q._arr };
  out.tags = [q.tags.rule, q.tags.trap].filter(Boolean);
  return out;
});

const pack = {
  format: "practice-app/question-pack@1",
  pack: {
    id: "grammar-midterm-mastery-assessment",
    title: "Final Grammar Mastery Assessment",
    source: "grammar_midterm_mastery_assessment.html",
    subject: "English",
    topics: ["Grammar"],
    solutions_origin: "source",
  },
  questions,
};
fs.mkdirSync(path.join(ROOT, "ingest", "packs"), { recursive: true });
const outPath = path.join(ROOT, "ingest", "packs", "grammar-midterm-mastery-assessment.json");
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + "\n");
const count = (f) => questions.reduce((m, q) => ((m[f(q)] = (m[f(q)] || 0) + 1), m), {});
console.log(`grammar: ${questions.length} questions -> ${path.relative(ROOT, outPath)}`, count((q) => q.type), count((q) => q.difficulty));
