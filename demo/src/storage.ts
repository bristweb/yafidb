// Storage interface plus S3/R2 backends. Every write is a compare-and-swap:
// `expected` is the version (hash/ETag) the writer read, or null to create only.
import { dec, enc } from "./util.ts";

export type PutResult = { ok: true; version: string } | { ok: false };

export interface Storage {
  get(path: string): Promise<{ body: string; version: string } | null>;
  putIfMatch(path: string, body: string, expected: string | null): Promise<PutResult>;
  list(): Promise<string[]>;
}

export const PATH_RE = /^\/[A-Za-z0-9_@.-]+(\/[A-Za-z0-9_@.-]+)*\.yaml$/;
export function assertPath(p: string) {
  if (!PATH_RE.test(p) || p.split("/").some((s) => s === "." || s === ".."))
    throw new Error(`invalid record path: ${p}`);
}

// ---- S3 (also Cloudflare R2's S3 API): If-Match / If-None-Match on PutObject ----

export interface S3Options {
  endpoint: string; bucket: string; region?: string;
  accessKeyId: string; secretAccessKey: string;
  fetch?: typeof fetch;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: BufferSource, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

export class S3Storage implements Storage {
  private f: typeof fetch;
  constructor(private o: S3Options) { this.f = o.fetch ?? fetch; }

  private async request(method: string, path: string, body?: string, extra: Record<string, string | undefined> = {}) {
    const url = new URL(`${this.o.endpoint.replace(/\/$/, "")}/${this.o.bucket}${path}`);
    const region = this.o.region ?? "auto";
    const amz = new Date().toISOString().replace(/[-:]|\.\d+/g, ""); // 20261102T181500Z
    const day = amz.slice(0, 8);
    const payloadHash = await sha(body ?? "");
    const signed: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
    const names = Object.keys(signed).sort();
    const canonical = [method, url.pathname.split("/").map(encodeURIComponent).join("/"), "",
      ...names.map((n) => `${n}:${signed[n]}`), "", names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amz, scope, await sha(canonical)].join("\n");
    let k: BufferSource = enc.encode("AWS4" + this.o.secretAccessKey);
    for (const part of [day, region, "s3", "aws4_request"]) k = await hmac(k, part);
    const sig = hex(await hmac(k, toSign));
    const headers = {
      ...extra, "x-amz-content-sha256": payloadHash, "x-amz-date": amz,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`,
    };
    return this.f(url, { method, headers, body });
  }

  async get(path: string) {
    const r = await this.request("GET", path);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 GET ${r.status}`);
    return { body: dec.decode(await r.arrayBuffer()), version: r.headers.get("etag") ?? "" };
  }

  async putIfMatch(path: string, body: string, expected: string | null) {
    const cond = expected === null ? { "if-none-match": "*" } : { "if-match": expected };
    const r = await this.request("PUT", path, body, { "content-type": "application/yaml", ...cond });
    if (r.status === 412 || r.status === 409) return { ok: false as const };
    if (!r.ok) throw new Error(`S3 PUT ${r.status}`);
    return { ok: true as const, version: r.headers.get("etag") ?? "" };
  }

  async list(): Promise<string[]> {
    throw new Error("S3Storage.list is not implemented in the demo; the build tool reads local storage");
  }
}

// ---- Cloudflare R2 binding (Workers): conditional put with onlyIf ----

export interface R2BucketLike {
  get(key: string): Promise<{ text(): Promise<string>; etag: string } | null>;
  put(key: string, value: string, o?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }):
    Promise<{ etag: string } | null>;
  list(o?: { cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export class R2Storage implements Storage {
  constructor(private bucket: R2BucketLike) {}
  async get(path: string) {
    const o = await this.bucket.get(path.slice(1));
    return o ? { body: await o.text(), version: o.etag } : null;
  }
  async putIfMatch(path: string, body: string, expected: string | null) {
    // A put with a failed precondition resolves to null. Creating uses etagDoesNotMatch "*".
    const onlyIf = expected === null ? { etagDoesNotMatch: "*" } : { etagMatches: expected };
    const r = await this.bucket.put(path.slice(1), body, { onlyIf });
    return r ? { ok: true as const, version: r.etag } : { ok: false as const };
  }
  async list() {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.bucket.list({ cursor });
      keys.push(...r.objects.map((o) => "/" + o.key).filter((k) => k.endsWith(".yaml")));
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return keys.sort();
  }
}
