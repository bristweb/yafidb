import type { CheckResult } from "../src/check.ts";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginCheck, WriterContext } from "../src/checks.ts";
import { generateKeyPair, importJwks, importSigner } from "../src/jws.ts";
import { parseManifest, MANIFEST_PATH, type Manifest, type Step } from "../src/manifest.ts";
import { schemaLoader } from "../src/node-context.ts";
import { commandCheck } from "../src/plugins.ts";
import { LocalStorage } from "../src/storage-local.ts";
import { createRecord } from "../src/writer.ts";

export const root = resolve(import.meta.dir, "..");

export const BASE_MANIFEST = `
workers:
  main:
    folders:
      /customer/: customer@1
      /order/: order@1
  quarantine:
    folders:
      /quarantine/: quarantine@1
`;

/** Replaces the manifest's build pipeline. */
export const withBuild = (ctx: WriterContext, build: Step[]): Manifest => (ctx.manifest = { ...ctx.manifest, pipelines: { ...ctx.manifest.pipelines, build } });

export async function makeEnv(opts: { plugins?: PluginCheck[]; manifest?: string; worker?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "yafi-"));
  const { privateJwk, publicJwk } = await generateKeyPair("test-writer");
  let tick = Date.parse("2026-11-02T12:00:00Z");
  const storage = new LocalStorage(join(dir, "root"));
  const manifestText = opts.manifest ?? BASE_MANIFEST;
  await storage.putIfMatch(MANIFEST_PATH, manifestText, null);   // the manifest is part of the root
  const ctx: WriterContext = {
    storage, manifest: parseManifest(manifestText), worker: opts.worker ?? "main", cwd: root, rootDir: join(dir, "root"),
    keys: await importJwks({ keys: [publicJwk] }),
    signer: await importSigner(privateJwk),
    getSchema: schemaLoader(join(root, "schemas")),
    plugins: opts.plugins ?? [commandCheck({ name: "limit-qty", command: ["bun", "plugins/limit-qty.ts"] }, root)],
    now: () => new Date((tick += 1000)),
  };
  return { dir, ctx, privateJwk, publicJwk };
}

export const order = (customer: string, extra: Record<string, unknown> = {}) => ({
  status: "placed", customer, items: [{ sku: "MUG-01", qty: 2, price: 12.5 }], ...extra,
});

export async function seedAlice(ctx: WriterContext) {
  const a = await createRecord(ctx, { path: "/customer/alice.yaml", schema: "customer@1", data: { name: "Alice", email: "alice@example.com" } });
  return { ...a, ref: `/customer/alice.yaml#${a.record_id}` };
}

/** The files a check run moved to quarantine. */
export const moved = (rs: CheckResult[]) => rs.filter((r): r is Extract<CheckResult, { status: "quarantined" }> => r.status === "quarantined");

export const readData = async (dir: string, p: string) => readFile(join(dir, "root", p), "utf8");
export const writeData = async (dir: string, p: string, s: string) => writeFile(join(dir, "root", p), s);

export async function rejects<T>(p: Promise<T>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected the write to be rejected");
}

/** An in-memory R2 bucket binding: put honours onlyIf, delete takes no precondition. */
export function fakeR2() {
  const kv = new Map<string, { body: string; etag: string }>();
  let n = 0;
  const bucket = {
    async get(k: string) { const o = kv.get(k); return o ? { text: async () => o.body, etag: o.etag } : null; },
    async put(k: string, v: string, o?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      await Promise.resolve();
      const cur = kv.get(k);
      if (o?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (o?.onlyIf?.etagMatches && cur?.etag !== o.onlyIf.etagMatches) return null;
      const etag = `e${++n}`; kv.set(k, { body: v, etag }); return { etag };
    },
    async delete(k: string) { kv.delete(k); },
    async list() { return { objects: [...kv].map(([key, o]) => ({ key, size: o.body.length })), truncated: false }; },
  };
  return { kv, bucket };
}

/** Wraps a storage so the first `n` calls of `method` on `path` all wait until `n` of them have arrived. Forces an interleaving. */
export function gated<S extends object>(storage: S, method: "get" | "putIfMatch" | "deleteIfMatch", path: string, n: number): S {
  let arrived = 0;
  let open!: () => void;
  const door = new Promise<void>((r) => (open = r));
  return new Proxy(storage, {
    get(t: any, k) {
      const v = t[k];
      if (k !== method) return typeof v === "function" ? v.bind(t) : v;
      return async (p: string, ...rest: unknown[]) => {
        if (p === path && arrived < n && ++arrived <= n) { if (arrived === n) open(); await door; }
        return v.call(t, p, ...rest);
      };
    },
  });
}
