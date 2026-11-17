#!/usr/bin/env node
// Independent gates. Usage: node ingest/checker/gate.mjs g2|g3|g4 RUN_DIR     (writes RUN_DIR/gates/gN.json)
//   G2 structure     - the app's own reader accepts the pack
//   G3 text fidelity - the words and numbers survived, judged against the source re-read by a separate route
//   G4 render        - what the app's real renderer will show
// Exit codes: 0 PASS, 10 WARN, 20 FAIL, 30 usage, 40 internal error.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import * as acorn from "acorn";
import { unzipSync } from "fflate";
import Ajv2020 from "ajv/dist/2020.js";
import { ROOT, Verdict, bag, bagDiff, loadApp, loadRun, numerals, tokens } from "./lib.mjs";

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ============================================================================================ G2 structure
function g2Checks(v, app, packText, schema, run) {
  let parsed, pack;
  try {
    parsed = app.parsePackText(packText, "pack.json");
    pack = app.normalizePack(parsed.value, { fileName: "pack.json" });
  } catch (e) {
    v.add("G2.reader", "FAIL", `the app's reader threw: ${e.message}`, { examined: 1 });
    return;
  }
  const n = pack.questions.length;
  const packErrors = pack.issues.filter((i) => i.level === "error");
  v.add("G2.reader", packErrors.length ? "FAIL" : "PASS", packErrors.length ? `reader errors: ${packErrors.map((i) => i.message).join("; ")}` : `the app's own reader (src/shared/qpack) read ${n} questions`, { examined: n, expected: run.job.expect.questions });
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const ok = validate(parsed.value);
  v.add("G2.schema", ok ? "PASS" : "FAIL", ok ? "valid against docs/question-pack.schema.json" : validate.errors.slice(0, 5).map((e) => `${e.instancePath} ${e.message}`).join("; "), { examined: 1 });
  const errors = [], warnings = [];
  for (const q of pack.questions) for (const i of q.issues) (i.level === "error" ? errors : warnings).push(`${q.id}: ${i.message}`);
  for (const i of pack.issues) if (i.level !== "error") warnings.push(`pack: ${i.message}`);
  v.add("G2.question", errors.length ? "FAIL" : warnings.length ? "WARN" : "PASS", `${errors.length} errors, ${warnings.length} warnings from the reader's per-question validation`, { examined: n, details: errors.concat(warnings).slice(0, 40) });
  const declared = new Set((run.profile.passthrough ?? []).map((p) => p.key));
  const dropped = [], passed = new Map();
  for (const q of pack.questions) for (const k of Object.keys(q.extra ?? {})) { if (declared.has(k)) passed.set(k, (passed.get(k) ?? 0) + 1); else dropped.push(`${q.id}: ${k}`); }
  const passNote = passed.size ? `; stored but not used by the app, as the profile declares: ${[...passed].map(([k, c]) => `${k} ×${c}`).join(", ")}` : "";
  v.add("G2.fields_consumed", dropped.length ? "FAIL" : "PASS", dropped.length ? `keys the app does not understand and the profile does not declare under passthrough: ${dropped.slice(0, 5).join("; ")}` : `every pack key is consumed by the app's reader${passNote}`, { examined: n });
  v.add("G2.repairs", parsed.repairs ? "WARN" : "PASS", `the reader repaired ${parsed.repairs} damaged escape(s) while parsing (expected: none)`, { examined: 1 });
  const used = new Set();
  const refs = new Set();
  for (const q of pack.questions) {
    if (refs.has(q.ref)) errors.push(`duplicate ref ${q.ref}`);
    refs.add(q.ref);
    for (const c of app.allContents(q)) for (const r of app.refsInContent(c)) used.add(r.replace(/^asset:/, ""));
  }
  const missing = [...used].filter((r) => !pack.assets[r]);
  const unused = Object.keys(pack.assets).filter((a) => !used.has(a));
  v.add("G2.assets", missing.length || unused.length || refs.size !== n ? "FAIL" : "PASS", `${used.size} figure references: ${missing.length} missing, ${unused.length} unused; ${refs.size} unique question refs`, { examined: n });
  return pack;
}

function g2Zip(v, run) {
  const dir = path.join(run.runDir, "pack");
  const zip = fs.readFileSync(path.join(dir, "pack.zip"));
  const entries = unzipSync(new Uint8Array(zip));
  const names = Object.keys(entries);
  const problems = [];
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) problems.push(`unsafe path ${name}`);
    if (name !== "pack.json" && !/^assets\/[A-Za-z0-9._-]+$/.test(name)) problems.push(`stray entry ${name}`);
    const onDisk = path.join(dir, name);
    if (!fs.existsSync(onDisk) || sha(fs.readFileSync(onDisk)) !== sha(Buffer.from(entries[name]))) problems.push(`${name} differs from the run folder`);
  }
  if (JSON.stringify(names) !== JSON.stringify([...names].sort())) problems.push("entries are not sorted");
  const total = names.reduce((s, k) => s + entries[k].length, 0);
  if (total > 50 * 1024 * 1024) problems.push(`pack is ${total} bytes (limit 50 MB)`);
  const listing = names.sort().map((k) => [k, entries[k].length, sha(Buffer.from(entries[k]))]);
  const identity = sha(Buffer.from(JSON.stringify(listing)));
  if (identity !== run.inputs.pack_identity_sha256) problems.push("pack identity differs from the one the assembler recorded");
  v.add("G2.zip", problems.length ? "FAIL" : "PASS", problems.join("; ") || `${names.length} entries, sorted, safe paths, identity ${identity.slice(0, 12)}… matches`, { examined: names.length });
}

async function g2(run, app) {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/question-pack.schema.json"), "utf8"));
  const bad = JSON.parse(run.packText);
  bad.questions[0].bogus_key_from_selftest = 1;   // known-bad fixture: a key the app does not know
  const probe = new Verdict("G2-selftest");
  g2Checks(probe, app, JSON.stringify(bad), schema, run);
  const caught = probe.checks.find((c) => c.id === "G2.fields_consumed")?.status === "FAIL";
  const v = new Verdict("G2");
  v.selftest = { fixture: "the real pack with an unknown key added to one question", must_fail: "G2.fields_consumed", status: caught ? "PASS" : "FAIL" };
  g2Checks(v, app, run.packText, schema, run);
  g2Zip(v, run);
  return v;
}

// ============================================================================================ G3 text fidelity
/** Our own reading of the source: nothing here comes from the converter. */
function readSource(run) {
  const kind = run.profile.source.kind;
  if (kind === "docx") {
    const files = unzipSync(new Uint8Array(run.sourceBytes));
    const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
    const paras = [];
    for (const name of Object.keys(files).sort()) {
      if (name !== "word/document.xml" && !/^word\/(header|footer|footnotes|endnotes|comments)\d*\.xml$/.test(name)) continue;
      const xml = new TextDecoder("utf-8").decode(files[name]);
      for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
        const text = [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => dec(m[1])).join("");
        if (text.trim()) paras.push({ part: name, text });
      }
    }
    return { all: paras.map((p) => p.text).join("\n"), units: paras.filter((p) => p.part === "word/document.xml").map((p) => p.text), leaves: null };
  }
  const html = new TextDecoder("utf-8").decode(run.sourceBytes);
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const SKIP = new Set(["script", "style", "template", "svg", "math", "head", "title"]);
  const textOf = (root) => {
    const out = [];
    const walk = (n) => {
      if (n.type === "text") out.push(n.data);
      else if (n.children && !SKIP.has(n.name)) for (const c of n.children) walk(c);
    };
    walk(root);
    return out.join(" ");
  };
  const body = $("body")[0] ?? $.root()[0];
  const result = { all: textOf(body), units: null, leaves: null, $, textOf };
  if (kind === "html-json") {
    const wanted = new Set(run.profile.segment.arrays);
    const leaves = new Map();
    const lit = (node, where) => {
      switch (node.type) {
        case "Literal": if (node.regex || typeof node.value === "bigint") throw new Error(`non-literal at ${where}`); return node.value;
        case "TemplateLiteral": if (node.expressions.length) throw new Error(`template expression at ${where}`); return node.quasis.map((q) => q.value.cooked).join("");
        case "UnaryExpression": if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") return -node.argument.value; throw new Error(`expression at ${where}`);
        case "ArrayExpression": return node.elements.map((e, i) => { if (!e || e.type === "SpreadElement") throw new Error(`spread or hole at ${where}`); return lit(e, `${where}[${i}]`); });
        case "ObjectExpression": {
          const o = {};
          for (const p of node.properties) {
            if (p.type !== "Property" || p.computed || p.method || p.shorthand) throw new Error(`non-literal property at ${where}`);
            const key = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
            o[key] = lit(p.value, `${where}.${key}`);
          }
          return o;
        }
        default: throw new Error(`${node.type} at ${where}`);
      }
    };
    const flat = (v, p) => {
      if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${p}[${i}]`));
      else if (v && typeof v === "object") for (const k of Object.keys(v)) flat(v[k], `${p}.${k}`);
      else leaves.set(p, v);
    };
    $("script").each((_, s) => {
      if ($(s).attr("src") || /json/.test($(s).attr("type") ?? "")) return;
      const ast = acorn.parse($(s).text(), { ecmaVersion: "latest", sourceType: "script" });
      for (const stmt of ast.body) {
        if (stmt.type !== "VariableDeclaration") continue;
        for (const d of stmt.declarations) if (d.id.type === "Identifier" && wanted.has(d.id.name) && d.init?.type === "ArrayExpression") flat(lit(d.init, d.id.name), d.id.name);
      }
    });
    result.leaves = leaves;
  }
  return result;
}

const pyRepr = (v) => v === null ? "null" : v === true ? "True" : v === false ? "False" : typeof v === "number" && Number.isInteger(v) ? String(v) : String(v);

function fieldValue(pack, q, field) {
  if (field === "pack.title") return { text: pack.pack.title, md: false };
  const get = (node, key) => node?.[key];
  const m = field.match(/^parts\.([^.]+)\.(.+)$/);
  let node = q, rest = field;
  if (m) { node = (q.parts ?? []).find((p) => p.label === m[1]); rest = m[2]; }
  const o = field.match(/^options\.(.+)$/);
  if (o) { const opt = (q.options ?? []).find((x) => x.label === o[1]); return opt ? { text: opt.text, md: true } : null; }
  let value = rest.split(".").reduce(get, node);
  if (value === undefined || value === null) return null;
  if (rest === "title") return { text: value, md: false };
  if (Array.isArray(value)) return { text: value.join("\n\n"), md: rest === "hints" };
  if (typeof value === "object") return { text: `${value.value}${value.unit ? " " + value.unit : ""}`, md: false };
  return { text: String(value), md: true };
}

function contentFields(q) {   // every learner-visible text field a pack question carries
  const out = [];
  const one = (prefix, node) => {
    for (const k of ["stem", "notes", "answer"]) if (node[k] !== undefined && node[k] !== null && !(k === "answer" && typeof node[k] !== "string" && !Array.isArray(node[k]) && typeof node[k] !== "object")) out.push(prefix + k);
    if (node.solution && typeof node.solution === "object") for (const k of ["answer", "explanation"]) if (node.solution[k]) out.push(`${prefix}solution.${k}`);
    if (node.hints?.length) out.push(prefix + "hints");
  };
  one("", q);
  for (const o of q.options ?? []) out.push(`options.${o.label}`);
  for (const p of q.parts ?? []) one(`parts.${p.label}.`, p);
  if (q.title) out.push("title");
  return out;
}

function g3Checks(v, app, run, src, pack) {
  const cov = run.coverage, kind = run.profile.source.kind;
  const visible = (val) => {
    if (!val.md) return val.text;
    const $ = cheerio.load(app.renderMarkdown(val.text), null, false);
    $("annotation, annotation-xml").remove();
    const out = [];
    const walk = (n) => { if (n.type === "text") out.push(n.data); else if (n.children) for (const c of n.children) walk(c); };
    walk($.root()[0]);
    return out.join(" ");
  };

  // ---- G3.conservation: the whole source, read here, against the whole ledger. Uses no profile selector.
  {
    const ledgerText = cov.blocks.filter((b) => (kind === "html-json" ? b.dom : true) && b.kind !== "value").map((b) => b.text).join("\n");
    const a = bag(tokens(src.all)), b = bag(tokens(ledgerText));
    const d = bagDiff(a, b);
    let jsonProblems = [];
    let leavesExamined = 0;
    if (kind === "html-json") {
      const led = new Map(cov.blocks.filter((x) => !x.dom).map((x) => [x.locator, x]));
      leavesExamined = src.leaves.size;
      for (const [p, val] of src.leaves) {
        const blk = led.get(p);
        if (!blk) jsonProblems.push(`${p} is in the source but not in the ledger`);
        else if (typeof val === "string" ? blk.text !== val.normalize("NFC") && blk.text !== val : JSON.stringify(blk.value) !== JSON.stringify(val)) jsonProblems.push(`${p} differs`);
      }
      for (const p of led.keys()) if (!src.leaves.has(p)) jsonProblems.push(`${p} is in the ledger but not in the source`);
    }
    const bad = d.onlyA.length || d.onlyB.length || jsonProblems.length;
    const total = [...a.values()].reduce((s, n) => s + n, 0);
    v.add("G3.conservation", bad ? "FAIL" : "PASS", bad
      ? `source and ledger disagree. In the source but not accounted for: ${d.onlyA.slice(0, 12).join(" ")}; in the ledger but not in the source: ${d.onlyB.slice(0, 12).join(" ")} ${jsonProblems.slice(0, 5).join("; ")}`
      : `all ${total} visible source tokens${leavesExamined ? ` and ${leavesExamined} data values` : ""} are accounted for in the ledger (claimed or ignored with a reason)`, { examined: total + leavesExamined });
  }

  // ---- G3.compare: each pack field against the source text it claims, in order.
  const byQF = new Map();
  for (const b of cov.blocks) if (b.status === "claimed") for (const c of b.by) if (c.mode === "verbatim") {
    const key = `${c.q ?? ""}\u0000${c.field}`;
    if (!byQF.has(key)) byQF.set(key, []);
    byQF.get(key).push(b);
  }
  const extra = new Map(), stripped = new Map();
  for (const a of cov.added) { const k = `${a.q ?? ""}\u0000${a.field}`; extra.set(k, (extra.get(k) ?? []).concat(tokens(visible({ text: a.text, md: true })))); }
  for (const s of cov.stripped) stripped.set(`${s.q ?? ""}\u0000${s.field}`, s.text);
  const qById = new Map(pack.questions.map((q) => [q.id, q]));
  const failures = [], compared = new Set();
  let fieldsCompared = 0, tokensCompared = 0;
  for (const [key, blocks] of byQF) {
    const [qid, field] = key.split("\u0000");
    const q = qid ? qById.get(qid) : null;
    if (qid && !q) { failures.push(`${qid}: claims exist for a question that is not in the pack`); continue; }
    const members = cov.groups?.[qid]?.[field] ?? [field];
    let packTokens = [], allowed = [];
    let missing = false;
    for (const m of members) {
      const val = fieldValue(pack, q, m);
      if (!val) { missing = true; break; }
      compared.add(`${qid}\u0000${m}`);
      const pre = stripped.get(`${qid}\u0000${m}`);
      if (pre) packTokens = packTokens.concat(tokens(pre));   // plain text: "1. " must not be read as a Markdown list
      packTokens = packTokens.concat(tokens(visible(val)));
      allowed = allowed.concat(extra.get(`${qid}\u0000${m}`) ?? []);
    }
    allowed = allowed.concat(extra.get(key) ?? []);
    if (missing) { failures.push(`${qid || "pack"} ${field}: the source text is claimed but the pack has no such field`); continue; }
    const srcTokens = tokens(blocks.map((b) => b.text).join("\n"));
    fieldsCompared++; tokensCompared += srcTokens.length;
    const spare = bag(allowed);
    let i = 0, problem = null;
    for (let k = 0; k < packTokens.length && !problem; k++) {
      const t = packTokens[k];
      if (i < srcTokens.length && t === srcTokens[i]) i++;
      else if ((spare.get(t) ?? 0) > 0) spare.set(t, spare.get(t) - 1);
      else problem = `pack has ${JSON.stringify(packTokens.slice(Math.max(0, k - 4), k + 3).join(" "))} where the source has ${JSON.stringify(srcTokens.slice(Math.max(0, i - 4), i + 3).join(" "))}`;
    }
    if (!problem && i < srcTokens.length) problem = `the pack stops before source text ${JSON.stringify(srcTokens.slice(i, i + 8).join(" "))}`;
    if (problem && (cov.unordered ?? []).includes(field)) {   // fields the profile assembles in its own order: same tokens, any order
      const d = bagDiff(bag(packTokens), bag(srcTokens.concat(allowed)));
      const d2 = bagDiff(bag(srcTokens), bag(packTokens));
      problem = d.onlyA.length || d2.onlyA.length ? `pack-only ${d.onlyA.slice(0, 6).join(" ")} / source-only ${d2.onlyA.slice(0, 6).join(" ")}` : null;
    }
    if (problem) failures.push(`${qid || "pack"} ${field}: ${problem}`);
  }
  v.add("G3.compare", failures.length ? "FAIL" : "PASS", failures.length ? `${failures.length} field(s) differ from the source; first: ${failures[0]}` : `${fieldsCompared} fields (${tokensCompared} tokens) equal the source text they claim, token by token and in order`, { examined: fieldsCompared, details: failures.slice(0, 40) });

  // ---- G3.invented: pack text that no source text stands behind (R3).
  const orphans = [];
  let fieldsSeen = 0;
  for (const q of pack.questions) for (const f of contentFields(q)) {
    fieldsSeen++;
    if (compared.has(`${q.id}\u0000${f}`)) continue;
    const derived = cov.blocks.some((b) => b.status === "claimed" && b.by.some((c) => c.q === q.id && (c.field === f || (f.startsWith("parts.") && c.field === "part_answers"))));
    if (!derived) orphans.push(`${q.id} ${f}`);
  }
  v.add("G3.invented", orphans.length ? "FAIL" : "PASS", orphans.length ? `${orphans.length} pack field(s) have no source text behind them; first: ${orphans[0]}` : `all ${fieldsSeen} text fields in the pack trace back to source blocks`, { examined: fieldsSeen, details: orphans.slice(0, 40) });

  // ---- G3.numerals: per question, digits and operators in the source container (our own selection) against the ledger.
  {
    const containers = cov.containers ?? {};
    const mismatches = [];
    let units = [];
    if (kind === "html") units = src.$(run.profile.segment.selector).toArray().map((el) => src.textOf(el));
    else if (kind === "docx") units = null;
    else units = null;
    let examined = 0;
    pack.questions.forEach((q, idx) => {
      const where = containers[q.id];
      const mine = cov.blocks.filter((b) => !b.dom && (b.locator === where || b.locator.startsWith(where + " ") || b.locator.startsWith(where + ".") || b.locator.startsWith(where + "[")));
      let sourceText;
      if (kind === "html") sourceText = units[idx];
      else if (kind === "docx") { const n = +where.match(/p\[(\d+)\]/)[1]; sourceText = src.byIndex?.[n]; }
      else sourceText = [...src.leaves].filter(([p]) => p === where || p.startsWith(where + ".") || p.startsWith(where + "[")).filter(([, val]) => typeof val === "string").map(([, val]) => val).join("\n");
      if (sourceText === undefined) return;
      examined++;
      const a = numerals(sourceText), b = numerals(mine.filter((x) => x.kind !== "value").map((x) => x.text).join("\n"));
      if (a.join(" ") !== b.join(" ")) mismatches.push(`${q.id}: source ${a.slice(0, 12).join(" ")} … / ledger ${b.slice(0, 12).join(" ")} …`);
    });
    if (kind === "html" && units.length !== pack.questions.length) mismatches.push(`our own selection finds ${units.length} question containers, the pack has ${pack.questions.length}`);
    v.add("G3.numerals", mismatches.length ? "FAIL" : "PASS", mismatches.length ? `${mismatches.length} question(s) differ; first: ${mismatches[0]}` : `the sequence of digits, decimal points and operators matches the source in ${examined} questions`, { examined, expected: pack.questions.length, details: mismatches.slice(0, 20) });
  }

  // ---- G3.association: content sits with its own question.
  {
    const containers = cov.containers ?? {};
    const content = /^(stem|answer|notes|hints|solution|parts|options|part_answers|title)/;
    const stray = [];
    let examined = 0;
    for (const b of cov.blocks) if (b.status === "claimed") for (const c of b.by) {
      if (!c.q || !content.test(c.field) || c.shared && kind === "docx") continue;
      examined++;
      const where = containers[c.q];
      if (!where || !(b.locator === where || b.locator.startsWith(where + " ") || b.locator.startsWith(where + ".") || b.locator.startsWith(where + "["))) stray.push(`${c.q} ${c.field} <- ${b.locator}`);
    }
    v.add("G3.association", stray.length ? "FAIL" : "PASS", stray.length ? `${stray.length} piece(s) of content come from outside their question; first: ${stray[0]}` : `${examined} claims: every stem, answer, solution and figure comes from inside its own question's container`, { examined, details: stray.slice(0, 20) });
  }

  // ---- G3.labels: a label taken off the text is the label stored.
  {
    const bad = cov.stripped.filter((s) => { const m = s.field.match(/^parts\.([^.]+)\./); return m && !tokens(s.text).includes(m[1]); });
    const partLabels = cov.stripped.filter((s) => s.field.startsWith("parts.")).length;
    v.add("G3.labels", bad.length ? "FAIL" : "PASS", bad.length ? `${bad.length} stripped label(s) do not match the stored part label` : `${partLabels} printed part labels match the labels stored in the pack`, { examined: partLabels, zeroOk: true });
  }
  v.add("G3.formatting", "WARN", "NOT RUN: counting bold / italic / underline runs independently against the source is not built yet. Formatting is carried by the converter (see decisions.json formats) and is visible in the review packet.", { examined: 0, zeroOk: true });
}

async function g3(run, app) {
  const src = readSource(run);
  if (run.profile.source.kind === "docx") {   // paragraph n of the body, counted our own way
    const xml = new TextDecoder("utf-8").decode(unzipSync(new Uint8Array(run.sourceBytes))["word/document.xml"]);
    const body = xml.slice(xml.indexOf("<w:body>"));
    const top = [];
    let depth = 0;
    for (const m of body.matchAll(/<(\/?)w:(tbl|p)(?=[ >/])[^>]*?(\/?)>/g)) {
      if (m[2] === "tbl") depth += m[1] ? -1 : 1;
      else if (!m[1] && depth === 0) top.push({ start: m.index, selfClosing: m[3] === "/" });
    }
    src.byIndex = {};
    top.forEach((p, i) => {
      const end = p.selfClosing ? p.start : body.indexOf("</w:p>", p.start);
      src.byIndex[i + 1] = [...body.slice(p.start, end).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")).join("");
    });
  }
  // known-bad fixture: change one digit (or one letter) of the real pack; G3.compare must notice
  const bad = JSON.parse(run.packText);
  let mutated = null;
  for (const q of bad.questions) {
    const target = q.stem !== undefined ? q : (q.parts ?? [])[0];
    if (!target?.stem) continue;
    const m = target.stem.match(/\d/) ?? target.stem.match(/[A-Za-z]{4,}/);
    if (!m) continue;
    const swap = /\d/.test(m[0]) ? String((+m[0] + 1) % 10) : m[0].slice(1) + m[0][0];
    target.stem = target.stem.slice(0, m.index) + swap + target.stem.slice(m.index + m[0].length);
    mutated = q.id;
    break;
  }
  const probe = new Verdict("G3-selftest");
  g3Checks(probe, app, run, src, bad);
  const caught = probe.checks.find((c) => c.id === "G3.compare")?.status === "FAIL";
  const v = new Verdict("G3");
  v.selftest = { fixture: `the real pack with one character changed in the stem of ${mutated}`, must_fail: "G3.compare", status: mutated && caught ? "PASS" : "FAIL" };
  g3Checks(v, app, run, src, run.pack);
  return v;
}

// ============================================================================================ G4 render
function g4Checks(v, app, pack, hostile) {
  const norm = app.normalizePack(pack, { fileName: "pack.json" });
  const textOf = (html) => { const $ = cheerio.load(html, null, false); $("math").replaceWith(" MATH "); $("img").replaceWith(" IMG "); return $.root().text().replace(/\s+/g, " ").trim(); };
  let pieces = 0, maths = 0, images = 0;
  const mathErrors = [], leftovers = [], lostImages = [];
  for (const q of norm.questions) {
    const mds = [];
    for (const c of app.allContents(q)) if (c.md !== undefined) mds.push(c.md);
    const sol = app.composeSolution(q);
    if (sol) mds.push(sol.body);
    for (const md of mds) {
      const report = { mathErrors: [] };
      const html = app.renderMarkdown(md, report);
      pieces++;
      maths += (html.match(/<math/g) ?? []).length;
      images += (html.match(/<img/g) ?? []).length;
      const t = textOf(html);
      if (report.mathErrors.length || /class="math-error"/.test(html)) mathErrors.push(`${q.id}: ${report.mathErrors[0] ?? "math error"}`);
      const left = t.match(/.{0,20}(\*\*|\\[\\`*_\[\]<>|~$&(]|\$|&(amp|lt|gt|quot|nbsp|#\d+);).{0,20}/);
      if (left) leftovers.push(`${q.id}: …${left[0]}…`);
      if ((md.match(/!\[[^\]]*\]\(/g) ?? []).length !== (html.match(/<img/g) ?? []).length) lostImages.push(q.id);
    }
  }
  v.add("G4.math", mathErrors.length ? "FAIL" : "PASS", mathErrors.length ? `${mathErrors.length} formula(s) do not parse; first: ${mathErrors[0]}` : `${maths} maths fragments in ${pieces} rendered pieces parse without an error node (the app's renderer: marked + Temml)`, { examined: pieces, details: mathErrors.slice(0, 20) });
  v.add("G4.markup", leftovers.length || lostImages.length ? "FAIL" : "PASS", leftovers.length || lostImages.length ? `${leftovers.length} piece(s) show leftover escape or Markdown characters, ${lostImages.length} lost an image; first: ${leftovers[0] ?? lostImages[0]}` : `no leftover escape characters, stray $ or raw entities in ${pieces} rendered pieces; ${images} images resolved`, { examined: pieces, details: leftovers.slice(0, 20) });
  const failed = [];
  for (const h of hostile) {
    const shown = cheerio.load(app.renderMarkdown(h.escaped), null, false).root().text().replace(/\s+/g, " ").trim();
    if (shown !== h.raw.replace(/\s+/g, " ").trim()) failed.push(`${JSON.stringify(h.raw)} is shown as ${JSON.stringify(shown)}`);
  }
  v.add("G4.hostile", failed.length ? "FAIL" : "PASS", failed.length ? `${failed.length} hostile string(s) do not survive the renderer; first: ${failed[0]}` : `${hostile.length} hostile strings (brackets, $, *, _, backticks, <, &, …) come back from the real renderer as the same visible text`, { examined: hostile.length, details: failed.slice(0, 20) });
}

async function g4(run, app) {
  const hostile = JSON.parse(fs.readFileSync(path.join(run.runDir, "gates", "hostile.json"), "utf8"));
  const bad = JSON.parse(run.packText);
  bad.questions[0].stem = (bad.questions[0].stem ?? "") + " $\\frac{1}{2$";   // known-bad fixture: an unbalanced formula
  const probe = new Verdict("G4-selftest");
  g4Checks(probe, app, bad, hostile);
  const caught = probe.checks.find((c) => c.id === "G4.math")?.status === "FAIL";
  const v = new Verdict("G4");
  v.selftest = { fixture: "the real pack with an unbalanced \\frac added to one stem", must_fail: "G4.math", status: caught ? "PASS" : "FAIL" };
  g4Checks(v, app, run.pack, hostile);
  const figs = Object.keys(run.pack.assets ?? {}).length;
  if (figs) {
    const { figureCheck } = await import("./figures.mjs");
    await figureCheck(v, run);
  } else v.add("G4.svg", "INFO", "the pack has no figures", { examined: 0, zeroOk: true });
  v.add("G4.layout", "WARN", "NOT RUN: comparing rendered line breaks, leading spaces and bold/italic styling against the rendered source page is not built yet. Words, numbers and maths are covered by G3 and G4.math; check layout in the review packet.", { examined: 0, zeroOk: true });
  return v;
}

// ============================================================================================ main
const [, , which, runDirArg] = process.argv;
if (!["g2", "g3", "g4"].includes(which) || !runDirArg) {
  console.error("usage: node ingest/checker/gate.mjs g2|g3|g4 RUN_DIR");
  process.exit(30);
}
try {
  const run = loadRun(path.resolve(runDirArg));
  const app = await loadApp();
  const v = await { g2, g3, g4 }[which](run, app);
  v.write(path.join(run.runDir, "gates", `${which}.json`));
  process.exit({ PASS: 0, INFO: 0, WARN: 10, FAIL: 20 }[v.status]);
} catch (e) {
  console.error(e.stack ?? String(e));
  process.exit(40);
}
