// Turns uploaded or pasted text into a value, forgiving the usual AI-output problems:
// prose or ``` fences around the JSON, trailing commas, comments, raw line breaks inside
// strings, and — most importantly — LaTeX backslashes that JSON/YAML escaping has damaged
// ("\frac" read as form-feed + "rac", "\times" as tab + "imes", "\sqrt" as an invalid escape).
import { load as yamlLoad } from "js-yaml";

export interface ParsedText {
  value: unknown;
  syntax: "json" | "yaml";
  repairs: number; // LaTeX backslashes restored
  fixes: string[]; // other lenient fixes applied
}

export class PackParseError extends Error {
  constructor(message: string, public line?: number, public column?: number) {
    super(message);
  }
}

const isYamlName = (name?: string) => !!name && /\.ya?ml$/i.test(name);

/** Pull the JSON/YAML out of a chat reply: prefer a fenced block, else the outermost {...} / [...]. */
export function extractPayload(text: string): { body: string; fenced: boolean } {
  const t = text.replace(/^﻿/, "");
  const fences = [...t.matchAll(/```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g)];
  if (fences.length) {
    // the longest fenced block is the payload
    const best = fences.reduce((a, b) => (b[2].length > a[2].length ? b : a));
    return { body: best[2], fenced: true };
  }
  const trimmed = t.trim();
  if (/^[{[]/.test(trimmed)) return { body: trimmed, fenced: false };
  // prose before/after the JSON: take the outermost {...} or [...]
  const first = trimmed.search(/[{[]/);
  const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    if (/"questions"|"stem"/.test(candidate)) return { body: candidate, fenced: false };
  }
  return { body: trimmed, fenced: false };
}

/**
 * Lenient JSON pre-pass, string-aware: doubles backslashes that start an invalid escape
 * (\sqrt, \alpha, \left, \u not followed by 4 hex digits…), escapes raw control characters
 * inside strings, drops trailing commas and // or /* *\/ comments.
 */
export function repairJsonText(src: string): { text: string; repairs: number; fixes: Set<string> } {
  let out = "";
  let inStr = false;
  let repairs = 0;
  const fixes = new Set<string>();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") {
        const n = src[i + 1];
        if (n !== undefined && '"\\/bfnrt'.includes(n)) {
          out += c + n;
          i++;
        } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
          out += src.slice(i, i + 6);
          i += 5;
        } else {
          out += "\\\\"; // keep the backslash literally (LaTeX command)
          repairs++;
        }
      } else if (c === '"') {
        inStr = false;
        out += c;
      } else if (c === "\n") {
        out += "\\n";
        fixes.add("line breaks inside text");
      } else if (c === "\r") {
        out += "\\r";
      } else if (c === "\t") {
        out += "\\t";
        fixes.add("tabs inside text");
      } else {
        out += c;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      fixes.add("comments");
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      fixes.add("comments");
    } else if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        fixes.add("trailing commas");
        continue;
      }
      out += c;
    } else {
      out += c;
    }
  }
  return { text: out, repairs, fixes };
}

// LaTeX commands that start with a letter JSON/YAML treat as an escape.
const T_CMDS = "times|theta|tan|tanh|text|textbf|textit|textrm|textsf|texttt|textstyle|textcolor|tau|triangle|to|top|tfrac|tbinom|tilde|therefore|thinspace|tiny";
const N_LONG = "neq|nabla|not|notin|neg|newline|nleq|ngeq|nless|ngtr|nmid|nparallel|nsubseteq|nsupseteq|nexists|nRightarrow|nLeftarrow|nrightarrow|nleftarrow|ncong|nsim";
const N_ALL = `${N_LONG}|ne|nu|ni`;
const R_CMDS = "right|rho|rangle|rightarrow|Rightarrow|rfloor|rceil|rbrace|rvert|rVert|rm|root";

/** Restore LaTeX backslashes that came out of parsing as control characters. */
export function repairControlChars(s: string): { text: string; repairs: number } {
  let repairs = 0;
  let t = s;
  const sub = (re: RegExp, rep: string) => {
    t = t.replace(re, () => {
      repairs++;
      return rep;
    });
  };
  sub(/\f/g, "\\f"); // \frac, \forall
  sub(/\x08/g, "\\b"); // \beta, \bar, \binom
  sub(/\x0B/g, "\\v"); // \vec, \varepsilon
  sub(/\x07/g, "\\a"); // \alpha (YAML)
  sub(/\x1B/g, "\\e"); // \epsilon (YAML)
  t = t.replace(new RegExp(`\\r(?=(?:${R_CMDS.split("|").map((c) => c.slice(1)).join("|")})(?![a-zA-Z]))`, "g"), () => {
    repairs++;
    return "\\r";
  });
  t = t.replace(new RegExp(`\\t(?=(?:${T_CMDS.split("|").map((c) => c.slice(1)).join("|")})(?![a-zA-Z]))`, "g"), () => {
    repairs++;
    return "\\t";
  });
  // A real line break can sit inside display maths, so only obvious commands are restored
  // there; inline $...$ never contains a line break, so all n-commands are restored.
  t = t.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, (span) => {
    const display = span.startsWith("$$");
    const re = new RegExp(`\\n(?=(?:${(display ? N_LONG : N_ALL).split("|").map((c) => c.slice(1)).join("|")})(?![a-zA-Z]))`, "g");
    return span.replace(re, () => {
      repairs++;
      return "\\n";
    });
  });
  return { text: t, repairs };
}

function deepRepair(v: unknown, counter: { n: number }): unknown {
  if (typeof v === "string") {
    const r = repairControlChars(v);
    counter.n += r.repairs;
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => deepRepair(x, counter));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepRepair(x, counter);
    return out;
  }
  return v;
}

function lineCol(text: string, pos: number): { line: number; column: number } {
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  return { line, column: pos - before.lastIndexOf("\n") };
}

export function parsePackText(text: string, fileName?: string): ParsedText {
  const { body, fenced } = extractPayload(text);
  const fixes: string[] = [];
  if (fenced) fixes.push("removed the ``` code fence");
  const looksJson = /^\s*[{[]/.test(body);
  let value: unknown;
  let syntax: "json" | "yaml";
  let repairs = 0;

  if (!isYamlName(fileName) && looksJson) {
    syntax = "json";
    try {
      value = JSON.parse(body);
    } catch {
      const r = repairJsonText(body);
      repairs += r.repairs;
      fixes.push(...r.fixes);
      try {
        value = JSON.parse(r.text);
      } catch (e) {
        const msg = (e as Error).message;
        const m = msg.match(/position (\d+)/) ?? null;
        const lc = msg.match(/line (\d+) column (\d+)/);
        if (lc) throw new PackParseError(`This is not valid JSON (line ${lc[1]}, column ${lc[2]}): ${msg.replace(/\s*\(line.*$/, "")}`, Number(lc[1]), Number(lc[2]));
        if (m) {
          const p = lineCol(r.text, Number(m[1]));
          throw new PackParseError(`This is not valid JSON (line ${p.line}, column ${p.column}): ${msg}`, p.line, p.column);
        }
        throw new PackParseError(`This is not valid JSON: ${msg}`);
      }
    }
  } else {
    syntax = "yaml";
    try {
      value = yamlLoad(body);
    } catch (e) {
      const err = e as { message: string; mark?: { line: number; column: number } };
      const first = err.message.split("\n")[0];
      throw new PackParseError(
        `This is not valid ${looksJson ? "JSON" : "YAML"}${err.mark ? ` (line ${err.mark.line + 1}, column ${err.mark.column + 1})` : ""}: ${first}`,
        err.mark ? err.mark.line + 1 : undefined,
        err.mark ? err.mark.column + 1 : undefined,
      );
    }
    if (typeof value === "string" || value === null || value === undefined) {
      throw new PackParseError("No questions found. Expected a JSON or YAML question pack (an object with a \"questions\" list).");
    }
  }
  const counter = { n: 0 };
  value = deepRepair(value, counter);
  repairs += counter.n;
  return { value, syntax, repairs, fixes };
}
