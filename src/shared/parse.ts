// Splits one question-bank HTML file into individual questions.
// Pure DOM code: runs in the browser (DOMParser) for the review screen, and in
// Node tests (linkedom). No network, no storage.
//
// Expected template (confirmed on fixtures/fractions-1.html):
//   section.cat#cN > h2 (".catno N." + name) > .skill
//     .band.<foundation|challenge|achiever> > .band-body > div.q > span.qn "Qn."
//   section#solutions > .sol-cat > div.sol > span.qn "Qn."
//   All styling in <style> blocks; figures are inline <svg>.

export const BANDS = ["foundation", "challenge", "achiever"] as const;
export type Band = (typeof BANDS)[number];

export interface ParsedCategory {
  key: string;          // section id, e.g. "c1"
  number: number;       // 1
  name: string;         // "Part–Whole"
  skill: string | null; // skill-focus text
}

export interface ParsedQuestion {
  position: number;        // 1-based order in the file
  number: string;          // printed number, e.g. "1"
  categoryKey: string | null;
  band: Band | null;
  html: string;            // the question wrapped in its band context, ready to render with `css`
  plainText: string;       // for search
  solutionHtml: string | null;
  solutionText: string | null;
}

export interface ParseIssue {
  level: "error" | "warning";
  number?: string;
  message: string;
}

export interface ParseResult {
  title: string;
  css: string;                 // every <style> block, joined; shared by all questions
  categories: ParsedCategory[];
  questions: ParsedQuestion[];
  issues: ParseIssue[];
  scriptCount: number;         // FR-1.5: scripts are never run; reported so the user knows
  externalRefs: string[];      // http(s) URLs in src/href/url() — would not load (no outside calls)
}

const QN_RE = /^\s*Q\s*(\d+)\s*\.?\s*$/i;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function questionNumber(el: Element): string | null {
  const qn = el.querySelector(".qn");
  const m = qn?.textContent?.match(QN_RE);
  return m ? m[1] : null;
}

function bandOf(el: Element): Band | null {
  const band = el.closest(".band");
  if (!band) return null;
  return BANDS.find((b) => band.classList.contains(b)) ?? null;
}

function textWithoutNumber(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelector(".qn")?.remove();
  copy.querySelectorAll("svg title, figcaption").forEach((n) => n.remove()); // keep search to question wording
  return squash(copy.textContent ?? "");
}

export function parseQuestionBank(doc: Document): ParseResult {
  const issues: ParseIssue[] = [];
  const title = squash(doc.querySelector("title")?.textContent ?? "");
  const css = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");

  // categories
  const categories: ParsedCategory[] = Array.from(doc.querySelectorAll("section.cat")).map((sec) => {
    const h2 = sec.querySelector(":scope > h2");
    const numText = h2?.querySelector(".catno")?.textContent ?? "";
    const name = squash((h2?.textContent ?? "").replace(numText, ""));
    const skill = sec.querySelector(".skill")?.textContent ?? null;
    return {
      key: sec.id,
      number: Number.parseInt(numText, 10),
      name,
      skill: skill ? squash(skill.replace(/^\s*Skill focus:\s*/i, "")) : null,
    };
  });

  // solutions, keyed by printed number
  const solutions = new Map<string, Element>();
  doc.querySelectorAll("#solutions .sol").forEach((sol) => {
    const n = questionNumber(sol);
    if (!n) return issues.push({ level: "warning", message: "Solution without a readable Q number" });
    if (solutions.has(n)) issues.push({ level: "error", number: n, message: `Two solutions for Q${n}` });
    solutions.set(n, sol);
  });

  // questions
  const seen = new Set<string>();
  const questions: ParsedQuestion[] = [];
  Array.from(doc.querySelectorAll(".q"))
    .filter((el) => !el.closest("#solutions"))
    .forEach((el) => {
      const number = questionNumber(el);
      if (!number) {
        issues.push({ level: "error", message: `Question block #${questions.length + 1} has no readable Q number` });
        return;
      }
      if (seen.has(number)) issues.push({ level: "error", number, message: `Q${number} appears twice` });
      seen.add(number);

      const band = bandOf(el);
      const categoryKey = el.closest("section.cat")?.id ?? null;
      if (!band) issues.push({ level: "warning", number, message: `Q${number} has no difficulty band` });
      if (!categoryKey) issues.push({ level: "warning", number, message: `Q${number} has no category` });

      // Wrap in the same containers it sits in, so the file's CSS paints it exactly as authored.
      const html = band
        ? `<div class="band ${band}"><div class="band-body">${el.outerHTML}</div></div>`
        : el.outerHTML;

      const sol = solutions.get(number) ?? null;
      if (!sol) issues.push({ level: "warning", number, message: `Q${number} has no solution` });

      questions.push({
        position: questions.length + 1,
        number,
        categoryKey,
        band,
        html,
        plainText: textWithoutNumber(el),
        solutionHtml: sol ? sol.outerHTML : null,
        solutionText: sol ? textWithoutNumber(sol) : null,
      });
    });

  for (const n of solutions.keys()) {
    if (!seen.has(n)) issues.push({ level: "warning", number: n, message: `Solution for Q${n} has no matching question` });
  }

  const scriptCount = doc.querySelectorAll("script").length;
  if (scriptCount) issues.push({ level: "warning", message: `${scriptCount} script(s) found; they will not run` });

  const refs = new Set<string>();
  doc.querySelectorAll("[src],[href]").forEach((n) => {
    const v = n.getAttribute("src") ?? n.getAttribute("href") ?? "";
    if (/^https?:/i.test(v)) refs.add(v);
  });
  for (const m of css.matchAll(/url\(\s*['"]?(https?:[^'")]+)/gi)) refs.add(m[1]);
  const externalRefs = [...refs];
  if (externalRefs.length)
    issues.push({ level: "warning", message: `${externalRefs.length} outside link(s) will not load` });

  return { title, css, categories, questions, issues, scriptCount, externalRefs };
}

// Content fingerprint (DR-2): question HTML (whitespace-normalised) + hash of the CSS it renders with.
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function contentFingerprint(questionHtml: string, cssSha256: string): Promise<string> {
  return sha256Hex(`${squash(questionHtml)}\n${cssSha256}`);
}
