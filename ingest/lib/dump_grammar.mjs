// Independent evaluator for the fidelity check: runs the page's whole data section (everything before the first
// helper function) and prints the combined question list as JSON. Deliberately NOT the converter's code path.
import fs from "node:fs"; import vm from "node:vm";
const html = fs.readFileSync(process.argv[2], "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const pre = js.slice(0, js.indexOf("function auditedDifficulty")).replace('"use strict";', "");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(pre + "\nthis.ALL=[...NOUN_QUESTIONS,...PRONOUN_QUESTIONS,...ADJECTIVE_QUESTIONS,...FINAL_QUESTIONS];", ctx);
const ORDER=["Plural Rules","Countability","Quantifiers","Personal Pronouns","Reflexives","Possessives & Other Pronouns","Adjectives & Determiners","Error Lab","Final Mixed Challenge"];
process.stdout.write(JSON.stringify(ORDER.flatMap(s=>ctx.ALL.filter(q=>q.section===s))));
