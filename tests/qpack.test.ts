import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { parsePackText, repairControlChars } from "../src/shared/qpack/parse";
import { normalizePack } from "../src/shared/qpack/normalize";
import { parseNumberish } from "../src/shared/qpack/numbers";
import { answerKeyOf, composeSolution, fingerprintSource, mdToPlain, plainTextOf, storedQuestionOf } from "../src/shared/qpack/compose";

const read = (p: string) => readFileSync(p, "utf8");
const load = (p: string) => normalizePack(parsePackText(read(p), p).value, { fileName: p });

describe("example packs", () => {
  it("fractions-pack.json normalises without errors", () => {
    const pack = load("docs/examples/fractions-pack.json");
    expect(pack.key).toBe("example-olympiad-fractions");
    expect(pack.questions.map((q) => q.type)).toEqual(["multi_part", "numeric", "mcq_single", "numeric", "open"]);
    expect(pack.questions.flatMap((q) => q.issues.filter((i) => i.level === "error"))).toEqual([]);
    const [q1, q2, q3, q4] = pack.questions;
    expect(q1.parts.map((p) => [p.label, p.answer?.kind === "numeric" && p.answer.value])).toEqual([["a", 0.625], ["b", 0.375]]);
    expect(q1.marks).toBe(2);
    expect(q3.answer).toEqual({ kind: "mcq", labels: ["B"] });
    expect(q4.answer?.kind === "numeric" && q4.answer.value).toBe(75);
    expect(q2.ref).toBe("example-olympiad-fractions/q2");
    expect(q1.topics[0].path).toEqual(["Number", "Fractions"]);
    expect(q1.topics.some((t) => t.path.join(" > ") === "Number > Fractions > Part–whole")).toBe(true);
    expect(q4.fields).toEqual({ Collection: "Olympiad Fractions", Tags: "multi-step" });
  });

  it("mixed-pack.yaml (YAML, units, short answers, multi-select, AI solution)", () => {
    const pack = load("docs/examples/mixed-pack.yaml");
    const [speed, unit, sel, proj] = pack.questions;
    expect(speed.answer).toMatchObject({ kind: "numeric", value: 60, tolerance: 0.5, unit: "km/h" });
    expect(unit.answer).toEqual({ kind: "text", accepted: ["newton", "N"] });
    expect(sel.answer).toEqual({ kind: "mcq", labels: ["A", "C"] });
    expect(proj.type).toBe("multi_part");
    expect(proj.solution?.origin).toBe("ai");
    expect(composeSolution(proj)?.origin).toBe("suggestion");
    expect(speed.solution?.body?.md).toContain("\\frac{d}{t}");
  });

  it("both examples satisfy the published JSON Schema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(read("docs/question-pack.schema.json")));
    for (const p of ["docs/examples/fractions-pack.json", "docs/examples/mixed-pack.yaml"]) {
      const ok = validate(parsePackText(read(p), p).value);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });
});

describe("forgiving parser", () => {
  it("restores LaTeX damaged by JSON escaping", () => {
    const raw = String.raw`Here you go:
` + "```json\n" + String.raw`{"questions":[{"stem":"Find $\frac{1}{2} \times 3$, $\sqrt{4}$, $a \neq b$, $\beta$ and $\left( x \right)$",}]}` + "\n```";
    const r = parsePackText(raw);
    const stem = (r.value as any).questions[0].stem;
    expect(stem).toBe(String.raw`Find $\frac{1}{2} \times 3$, $\sqrt{4}$, $a \neq b$, $\beta$ and $\left( x \right)$`);
    expect(r.repairs).toBeGreaterThanOrEqual(5);
    expect(r.fixes.join()).toMatch(/fence/);
  });
  it("keeps real line breaks and tabs that are not LaTeX", () => {
    expect(repairControlChars("Line one\nnext line\tindented").text).toBe("Line one\nnext line\tindented");
  });
  it("accepts raw line breaks inside strings and prose around JSON", () => {
    const r = parsePackText('Sure! {"questions": [{"stem": "Line 1\nLine 2"}]} Hope this helps.');
    expect((r.value as any).questions[0].stem).toBe("Line 1\nLine 2");
  });
  it("reports where invalid JSON breaks", () => {
    expect(() => parsePackText('{"questions": [ {"stem": "x" } } ]}')).toThrow(/line 1/);
  });
});

describe("loose shapes", () => {
  it("understands aliases, inferred types and answer forms", () => {
    const pack = normalizePack([
      { q: "What is half of 3?", a: "1 1/2" },
      { question: "Pick the prime", choices: ["4", "6", "7", "9"], correct_answer: "7" },
      { text: "Select all even", options: { A: "2", B: "3", C: "4" }, answer: "A, C" },
      { stem: "Name the capital of France", answer: "Paris" },
      { stem: "Percent?", answer: "62.5%" },
    ]);
    const [a, b, c, d, e] = pack.questions;
    expect(a.type).toBe("numeric");
    expect(a.answer).toMatchObject({ value: 1.5 });
    expect(b.answer).toEqual({ kind: "mcq", labels: ["C"] });
    expect(c.type).toBe("mcq_multi");
    expect(c.answer).toEqual({ kind: "mcq", labels: ["A", "C"] });
    expect(d.type).toBe("short_answer");
    expect(e.answer).toMatchObject({ value: 62.5, unit: "%" });
    expect(answerKeyOf(b)).toMatchObject({ answer_type: "mcq_single", mcq_correct: ["C"], origin: "import" });
  });
  it("flags empty questions as errors and keeps going", () => {
    const pack = normalizePack({ questions: [{ id: "x" }, { stem: "ok" }] });
    expect(pack.questions[0].issues[0].level).toBe("error");
    expect(pack.questions[1].issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("reads numbers the way people write them", () => {
    expect(parseNumberish("\\frac{5}{8}")?.value).toBe(0.625);
    expect(parseNumberish("£12.50")).toMatchObject({ value: 12.5, unit: "£" });
    expect(parseNumberish("1.2 × 10^3")?.value).toBe(1200);
    expect(parseNumberish("x = -4")?.value).toBe(-4);
    expect(parseNumberish("3 boys and 4 girls")).toBeNull();
    expect(parseNumberish("2½")?.value).toBe(2.5);
  });
});

describe("storage", () => {
  const base = { stem: "What is $\\frac{1}{2} + \\frac{1}{4}$?", answer: "3/4", solution: "Add: $\\frac{3}{4}$." };
  const fp = (q: object) => fingerprintSource(storedQuestionOf(normalizePack([q]).questions[0], null));
  it("fingerprint ignores whitespace, numbering, answers and solutions", () => {
    expect(fp({ ...base, stem: "What  is $\\frac{1}{2} + \\frac{1}{4}$?\n" })).toBe(fp(base));
    expect(fp({ ...base, number: "7", solution: "Different working" })).toBe(fp(base));
    expect(fp({ ...base, stem: "What is $\\frac{1}{2} + \\frac{1}{3}$?" })).not.toBe(fp(base));
  });
  it("composes one solution document per question, part by part", () => {
    const pack = load("docs/examples/fractions-pack.json");
    const s = composeSolution(pack.questions[0])!;
    expect(s.body).toContain("**(a)** **Answer:** 5/8");
    expect(s.body).toContain("**(b)** **Answer:** 3/8");
    expect(composeSolution(pack.questions[1])!.body).toContain("**Answer:** 28 students\n\n1. ");
    expect(plainTextOf(pack.questions[2])).toContain("6/8");
    expect(mdToPlain("A car travels $150\\,\\text{km}$ in 2.5 hours")).toBe("A car travels 150 km in 2.5 hours");
  });
});
