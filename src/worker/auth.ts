// Cloudflare Access check (FR-6.1). Access is the gate at Cloudflare's edge; this
// verifies the signed token Access attaches, so the Worker is never open even if
// the Access app is misconfigured or switched off. Fails closed when not set up.

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. "myteam.cloudflareaccess.com"
  ACCESS_AUD?: string; // Application Audience (AUD) tag
  DEV_ALLOW_NO_AUTH?: string; // "1" only in local .dev.vars
  PUBLIC_ACCESS?: string; // "1" = no login wall: anyone with the link can use the app
}

type Jwk = JsonWebKey & { kid?: string };
let certCache: { domain: string; keys: Jwk[]; at: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKeys(domain: string, force = false): Promise<Jwk[]> {
  if (!force && certCache && certCache.domain === domain && Date.now() - certCache.at < 3600_000) {
    return certCache.keys;
  }
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not load Access certs (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  certCache = { domain, keys: body.keys, at: Date.now() };
  return body.keys;
}

function readToken(req: Request): string | null {
  const h = req.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

export type AuthResult = { ok: true; email: string | null } | { ok: false; status: number; reason: string };

export async function checkAccess(req: Request, env: AuthEnv): Promise<AuthResult> {
  if (env.DEV_ALLOW_NO_AUTH === "1") return { ok: true, email: "local-dev" };
  if (env.PUBLIC_ACCESS === "1") return { ok: true, email: null };
  const domain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!domain || !aud) {
    return { ok: false, status: 503, reason: "Login wall not configured yet (ACCESS_TEAM_DOMAIN / ACCESS_AUD)." };
  }
  const token = readToken(req);
  if (!token) return { ok: false, status: 401, reason: "Not signed in." };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, reason: "Malformed token." };
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (header.alg !== "RS256") return { ok: false, status: 401, reason: "Unexpected token algorithm." };
    let keys = await getKeys(domain);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await getKeys(domain, true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return { ok: false, status: 401, reason: "Unknown signing key." };
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]) as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return { ok: false, status: 401, reason: "Bad token signature." };
    const now = Math.floor(Date.now() / 1000);
    const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return { ok: false, status: 403, reason: "Token is for another application." };
    if (payload.iss !== `https://${domain}`) return { ok: false, status: 403, reason: "Token from another team." };
    if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, status: 401, reason: "Token expired." };
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, status: 401, reason: "Token not yet valid." };
    return { ok: true, email: payload.email ?? null };
  } catch (e) {
    return { ok: false, status: 401, reason: `Token check failed: ${(e as Error).message}` };
  }
}
