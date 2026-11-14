export class ApiError extends Error {
  constructor(public status: number, message: string, public limit = false) {
    super(message);
  }
}

const LIMIT_MSG = "Today's free-tier limit was reached. Nothing is lost — please try again after midnight UTC.";

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const raw = body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof Blob || typeof body === "string";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !raw ? { "content-type": "application/json", ...headers } : headers,
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the app. Check your connection — or your sign-in may have expired, so reload the page.");
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    if (res.status === 429 || res.status === 1027) throw new ApiError(429, LIMIT_MSG, true);
    if (res.status === 401 || res.status === 403 || res.redirected) throw new ApiError(res.status, "Your sign-in expired. Reload the page to sign in again.");
    if (res.ok) return (await res.arrayBuffer()) as T;
    const text = await res.text().catch(() => "");
    if (/1027|limit/i.test(text)) throw new ApiError(429, LIMIT_MSG, true);
    throw new ApiError(res.status, `Something went wrong (error ${res.status}). Please try again.`);
  }
  const data: any = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Error ${res.status}`, !!data.limit);
  return data as T;
}

const blobCache = new Map<string, Promise<string>>();
export function blobText(sha: string): Promise<string> {
  let p = blobCache.get(sha);
  if (!p) {
    p = fetch(`/api/blobs/${sha}`, { credentials: "same-origin" }).then((r) => {
      if (!r.ok) throw new ApiError(r.status, "Could not load the question file.");
      return r.text();
    });
    p.catch(() => blobCache.delete(sha));
    blobCache.set(sha, p);
  }
  return p;
}

export async function sha256HexBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the learner's time zone
