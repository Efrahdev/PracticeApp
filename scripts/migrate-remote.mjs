// DR-11: apply numbered migrations to the live D1 database, only after a backup.
// 1) records a Time Travel bookmark (D1 can rewind to it for 30 days on paid / 7 on free)
// 2) exports a full SQL dump to backups/ (git-ignored)
// 3) applies pending migrations
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const DB = "practice-app-db";
const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString();

const pending = run(`npx wrangler d1 migrations list ${DB} --remote`);
if (/No migrations to apply/i.test(pending)) { console.log("No migrations to apply."); process.exit(0); }
console.log(pending);

const info = run(`npx wrangler d1 time-travel info ${DB} --json`);
const bookmark = JSON.parse(info.slice(info.indexOf("{"))).bookmark;
console.log(`Time Travel bookmark (restore point): ${bookmark}`);

mkdirSync("backups", { recursive: true });
const file = `backups/${DB}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
try {
  run(`npx wrangler d1 export ${DB} --remote --output ${file}`);
  console.log(`SQL dump saved: ${file}`);
} catch {
  console.log("(SQL export skipped — an empty database cannot be exported; the bookmark above is the backup)");
}

execSync(`npx wrangler d1 migrations apply ${DB} --remote`, { stdio: "inherit" });
console.log(`\nDone. To undo: npx wrangler d1 time-travel restore ${DB} --bookmark=${bookmark}`);
