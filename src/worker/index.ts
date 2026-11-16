import { taxonomyEdit } from "./taxonomy";
import { checkAccess } from "./auth";
import { HttpError, json } from "./http";
import * as api from "./api";
import * as admin from "./admin";
import * as imports from "./imports";
import { bulkEdit } from "./bulk";
import type { Env } from "./api";
import { STATIC } from "./static.gen";

type Handler = (req: Request, env: Env, p: string[], url: URL) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:[a-z_]+/g, "([^/]+)") + "$"), h]);

on("GET", "/api/bootstrap", (_r, env) => api.bootstrap(env));
on("GET", "/api/library", (_r, env) => api.library(env));
on("POST", "/api/blobs/check", (r, env) => api.blobsCheck(r, env));
on("POST", "/api/blobs", (r, env) => api.blobsUploadText(r, env));
on("PUT", "/api/blobs/:sha", (r, env, p) => api.blobPut(r, env, p[0]));
on("GET", "/api/blobs/:sha", (_r, env, p) => api.blobGet(env, p[0]));
on("POST", "/api/imports/preview", (r, env) => imports.importPreview(r, env));
on("POST", "/api/imports/commit", (r, env) => imports.importCommit(r, env));
on("GET", "/api/imports", (_r, env) => imports.importList(env));
on("POST", "/api/imports/:id/archive", (r, env, p) => imports.importArchive(r, env, p[0]));
on("PATCH", "/api/imports/:id", (r, env, p) => imports.importPatch(r, env, p[0]));
on("POST", "/api/questions/:id/solution/verify", (_r, env, p) => api.verifyMetadata(env, p[0], "solution"));
on("POST", "/api/questions/:id/answer-key/verify", (_r, env, p) => api.verifyMetadata(env, p[0], "answer-key"));
on("GET", "/api/versions/:id/solution", (_r, env, p) => api.versionSolution(env, p[0]));
on("POST", "/api/fields", (r, env) => api.fieldCreate(r, env));
on("PATCH", "/api/fields/:id", (r, env, p) => api.fieldPatch(r, env, p[0]));
on("GET", "/api/questions/:id", (_r, env, p) => api.questionDetail(env, p[0]));
on("PATCH", "/api/questions/:id", (r, env, p) => api.questionPatch(r, env, p[0]));
on("POST", "/api/questions-bulk", (r, env) => bulkEdit(r, env));
on("POST", "/api/questions/:id/answer-key", (r, env, p) => api.answerKeySet(r, env, p[0]));
on("POST", "/api/questions/:id/solution", (r, env, p) => api.solutionSet(r, env, p[0]));
on("POST", "/api/subjects", (r, env) => api.subjectCreate(r, env));
on("PATCH", "/api/subjects/:id", (r, env, p) => api.subjectPatch(r, env, p[0]));
on("POST", "/api/concepts", (r, env) => api.conceptCreate(r, env));
on("PATCH", "/api/concepts/:id", (r, env, p) => api.conceptPatch(r, env, p[0]));
on("POST", "/api/taxonomy", (r, env) => taxonomyEdit(r, env));
on("POST", "/api/filters", (r, env) => api.filterSave(r, env));
on("PUT", "/api/filters/:id", (r, env, p) => api.filterSave(r, env, p[0]));
on("DELETE", "/api/filters/:id", (_r, env, p) => api.filterArchive(env, p[0]));
on("POST", "/api/papers", (r, env) => api.paperCreate(r, env));
on("GET", "/api/papers", (_r, env) => api.paperList(env));
on("GET", "/api/papers/:id", (_r, env, p) => api.paperDetail(env, p[0]));
on("DELETE", "/api/papers/:id", (_r, env, p) => api.paperArchive(env, p[0]));
on("POST", "/api/papers/:id/delete", (_r, env, p) => api.paperDelete(env, p[0]));
on("POST", "/api/papers/:id/sessions", (_r, env, p) => api.sessionStart(env, p[0]));
on("PATCH", "/api/sessions/:id", (r, env, p) => api.sessionPatch(r, env, p[0]));
on("POST", "/api/attempts", (r, env) => api.attemptCreate(r, env));
on("POST", "/api/attempts/:id/grades", (r, env, p) => api.gradeCorrect(r, env, p[0]));
on("GET", "/api/analytics", (_r, env) => api.analytics(env));
on("GET", "/api/export", () => admin.exportInfo());
on("GET", "/api/export/:table", (_r, env, p, url) => admin.exportTable(env, p[0], url));
on("POST", "/api/admin/integrity", async (_r, env) => json(await admin.integrityCheck(env, "manual")));
on("POST", "/api/admin/rebuild-metrics", (_r, env) => admin.rebuildMetrics(env));
on("POST", "/api/admin/restore/begin", (_r, env) => admin.restoreBegin(env));
on("POST", "/api/admin/restore/table/:table", (r, env, p) => admin.restoreTable(r, env, p[0]));
on("POST", "/api/admin/restore/finish", (r, env) => admin.restoreFinish(r, env));

const decoded = new Map<string, Uint8Array>();
function decodeOnce(key: string, b64: string): Uint8Array {
  let d = decoded.get(key);
  if (!d) {
    const bin = atob(b64);
    d = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
    decoded.set(key, d);
  }
  return d;
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
};

function blockedPage(status: number, reason: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Practice App</title>
<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222"><h1 style="font-size:1.3rem">Practice App is locked</h1>
<p>${reason.replace(/[<>&]/g, "")}</p><p style="color:#666">Sign in through Cloudflare Access to continue.</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith("/api/");

    if (url.pathname === "/api/health") {
      // No data, just whether the pieces are wired up.
      const v = await env.DB.prepare(`SELECT max(version) AS v FROM schema_migration`).first<{ v: number }>().catch(() => null);
      return json({ ok: true, schemaVersion: v?.v ?? null, loginWall: env.PUBLIC_ACCESS !== "1" && !!(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) });
    }

    const auth = await checkAccess(req, env);
    if (!auth.ok) return isApi ? json({ error: auth.reason }, auth.status) : blockedPage(auth.status, auth.reason);

    if (!isApi) {
      // Hash routing: every page path serves the app shell.
      const f = STATIC[url.pathname] ?? STATIC["/index.html"];
      const immutable = url.pathname.startsWith("/chunks/") || url.pathname.startsWith("/fonts/");
      const headers: Record<string, string> = {
        ...SECURITY_HEADERS,
        "content-type": f.type,
        etag: f.etag,
        "cache-control": f.type.startsWith("text/html") ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "no-cache",
      };
      if (url.pathname.startsWith("/fonts/")) headers["access-control-allow-origin"] = "*";
      if (req.headers.get("if-none-match") === f.etag) return new Response(null, { status: 304, headers });
      return new Response((f.b64 ? decodeOnce(url.pathname, f.b64) : f.body!) as BodyInit, { headers });
    }

    try {
      for (const [method, re, h] of routes) {
        if (method !== req.method) continue;
        const m = url.pathname.match(re);
        if (m) return await h(req, env, m.slice(1).map(decodeURIComponent), url);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const msg = String((e as Error)?.message ?? e);
      console.error("API error", req.method, url.pathname, msg);
      if (/limit|exceeded|too many/i.test(msg)) {
        return json({ error: "Today's free-tier limit was reached. Everything is saved; try again after midnight UTC.", limit: true }, 429);
      }
      return json({ error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
