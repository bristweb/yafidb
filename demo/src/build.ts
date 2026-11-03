// Build: an optional pass. Given a path, find the folders under it (from the manifest), verify each file
// with its folder's schema, heal corrupt data through the quarantine worker, then run the build pipeline.
// Files stay the source of truth; build steps only read them and write elsewhere.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WriterContext } from "./checks.ts";
import { verifyFile, type VerifyResult } from "./format.ts";
import { healFile } from "./heal.ts";
import { foldersUnder, listRecords, ownerOf, type Owner, type Step } from "./manifest.ts";
import { runPipeline } from "./pipeline.ts";
import { callUrl, runCommand } from "./plugins.ts";
import { findRefs, parseRef, resolveRef, type Ref } from "./refs.ts";
import { validate } from "./schema.ts";
import { renderSite } from "./site.ts";

export interface BuiltRef { pointer: string; raw: string; ref: Ref | null; error: string | null }
export interface BuiltRecord { path: string; folder: string; schema: string; v: VerifyResult; refs: BuiltRef[]; warnings: string[]; body: string }
export interface BuildReport {
  path: string; workers: Owner[]; records: number;
  quarantined: { path: string; quarantinePath?: string; reason: string; skipped?: string; followUps?: Record<string, string> }[];
  unsupported: { path: string; version: string }[];   // files whose header version this reader does not list; not corrupt, not moved
  unowned: string[];                                  // files under the path that no worker folder covers
  brokenRefs: { path: string; pointer: string; error: string }[];
  steps: Record<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
}

/** What a built-in step sees: the verified records. Command and URL steps never see this. */
interface Built { records: BuiltRecord[]; out: string }
const BUILTINS: Record<string, (b: Built) => Promise<void>> = {
  "static-site": async ({ records, out }) => {
    await rm(out, { recursive: true, force: true });
    for (const [p, html] of renderSite(records)) await put(join(out, p), html);
    for (const r of records) await put(join(out, r.path), r.body); // raw file, next to its page
  },
  "relationship-cache": async ({ records, out }) => {
    const { writeSqlite } = await import("./sqlite.ts");
    await mkdir(dirname(out), { recursive: true });
    await writeSqlite(out, records);
  },
};

/** `ctx` supplies storage, keys, the manifest and (to heal) a signing key. `ctx.rootDir` is the root on local disk. */
export async function build(o: { ctx: WriterContext; path?: string }): Promise<BuildReport> {
  const { ctx } = o;
  const cwd = ctx.cwd ?? process.cwd();
  const path = o.path ?? "/";
  if (!/^\/([^/]+\/)*$/.test(path)) throw new Error(`build path must be a folder like / or /order/, got ${path}`);
  const report: BuildReport = { path, workers: foldersUnder(ctx.manifest, path), records: 0, quarantined: [], unowned: [], unsupported: [], brokenRefs: [], steps: {} };

  // Pass 1: verify against each folder's schema, and heal.
  const files = (await listRecords(ctx.storage)).filter((p) => p.startsWith(path));
  const healed = new Set<string>();
  for (const p of files) {
    const owner = ownerOf(ctx.manifest, p);
    if (!owner) { report.unowned.push(p); continue; }
    const f = await ctx.storage.get(p);
    if (!f) continue;
    const v = await verifyFile(f.body, ctx.keys);
    if (v.unsupported) { report.unsupported.push({ path: p, version: v.unsupported }); continue; }   // newer, not corrupt: left alone
    const wrongSchema = !!v.header && v.header.schema !== owner.schema;
    if (v.ok && !wrongSchema) continue;
    const reason = wrongSchema ? `schema ${v.header!.schema} does not match folder schema ${owner.schema}` : v.error!;
    const r = await healFile(ctx, p, f, v, reason, !wrongSchema && !!v.header);
    report.quarantined.push("quarantinePath" in r ? { path: p, reason, ...r } : { path: p, reason, skipped: r.skipped });
    if ("quarantinePath" in r) healed.add(p);
  }

  // Pass 2: read the files and build records. A file that could not be healed is trusted only up to the break.
  const records: BuiltRecord[] = [];
  for (const p of await listRecords(ctx.storage)) {
    if (!p.startsWith(path)) continue;
    const owner = ownerOf(ctx.manifest, p);
    const f = owner && (await ctx.storage.get(p));
    if (!owner || !f) continue;
    const v = await verifyFile(f.body, ctx.keys);
    if (!v.header || v.header.schema !== owner.schema) continue; // reported under quarantined
    const warnings: string[] = [];
    if (!v.ok) warnings.push(`Trusted up to entry ${v.entries.length}; the rest of the file is ignored (${v.error}).`);
    const schema = await ctx.getSchema(owner.schema);
    const bad = schema && v.entries.length ? validate(schema, v.state) : null;
    if (bad) warnings.push(`Current state fails ${owner.schema}: ${bad}`);
    records.push({ path: p, folder: owner.folder, schema: owner.schema, v, refs: [], warnings, body: f.body });
  }
  // References resolve across the whole root, not only the build path.
  const byPath = new Map(records.map((r) => [r.path, r.v]));
  for (const r of records) {
    for (const x of findRefs(r.v.state)) {
      const error = await resolveRef(x.raw, async (p) => byPath.get(p) ?? (await lookup(ctx, p)));
      r.refs.push({ ...x, ref: parseRef(x.raw), error });
      if (error) report.brokenRefs.push({ path: r.path, pointer: x.pointer, error });
    }
  }
  report.records = records.length;

  // Build pipeline: optional. Outputs can live anywhere.
  const steps = ctx.manifest.pipelines.build;
  const results = await runPipeline(steps, async (name) => {
    const s = steps.find((x) => x.name === name)!;
    await runStep(ctx, s, { records, path, cwd });
  });
  for (const [n, r] of results) report.steps[n] = { status: r.status, ...(r.error ? { error: r.error } : {}) };
  return report;
}

async function lookup(ctx: WriterContext, p: string): Promise<VerifyResult | null> {
  const f = await ctx.storage.get(p);
  return f ? verifyFile(f.body, ctx.keys) : null;
}

async function runStep(ctx: WriterContext, s: Step, b: { records: BuiltRecord[]; path: string; cwd: string }) {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(b.cwd, p));
  const rootDir = ctx.rootDir ? resolve(ctx.rootDir) : "";
  const ins = (s.in === undefined ? ["@root"] : [s.in].flat()).map((p) => (p === "@root" ? join(rootDir, b.path) : abs(p)));
  const out = s.out ? abs(s.out) : "";
  if (s.builtin) {
    const fn = BUILTINS[s.builtin];
    if (!fn) throw new Error(`unknown builtin ${s.builtin}`);
    if (!out) throw new Error("builtin steps need an out path");
    return fn({ records: b.records, out });
  }
  // Commands and endpoints get paths in and out, never the records.
  const input = { name: s.name, root: rootDir, path: b.path, in: ins, out };
  if (s.url) await callUrl(s.url, input, s.timeout_ms ?? 60000);
  else await runCommand(s.command!, input, { cwd: b.cwd, timeout_ms: s.timeout_ms ?? 60000, env: { YAFI_ROOT: rootDir, YAFI_IN: ins.join(":"), YAFI_OUT: out } });
}

async function put(file: string, body: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}
