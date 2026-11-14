export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

export function need<T>(v: T | null | undefined, msg: string, status = 400): T {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) throw new HttpError(status, msg);
  return v;
}

export const SHA_RE = /^[0-9a-f]{64}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function sha256Bytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
