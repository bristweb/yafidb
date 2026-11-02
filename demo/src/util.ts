// Small helpers that run on Bun, Node and Cloudflare Workers (no Buffer, no fs).

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** RFC 8785-style canonical JSON: sorted keys, no whitespace. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
    if (v === undefined) throw new Error("undefined value");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

export async function sha256b64u(s: string): Promise<string> {
  return b64uEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

export async function sha256hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomNonce(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(16))); // 128 bits CSPRNG -> 22 chars
}

export function isoSeconds(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
