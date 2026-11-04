// Build: an optional pass. Given a path, find the folders under it (from the manifest), read the files there, and run
// the build pipeline. A build does no validation and no quarantine. A build that wants screened data adds the screen tool
// as a step (`command: [bun, src/screen-cli.ts, /order/]`) and makes the other steps run `after` it.
// Files stay the source of truth; build steps only read them and write elsewhere.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WriterContext } from "./screens.ts";
import { parseFile, type VerifyResult } from "./format.ts";
import { foldersUnder, listRecords, ownerOf, type Owner, type Step } from "./manifest.ts";
import { runPipeline } from "./pipeline.ts";
import { callUrl, runCommand } from "./plugins.ts";
import { findRefs, parseRef, resolveRef, type Ref } from "./refs.ts";
import { renderSite } from "./site.ts";

export interface BuiltRef { pointer: string; raw: string; ref: Ref | null; error: string | null }
export interface BuiltRecord { path: string; folder: string; schema: string; v: VerifyResult; refs: BuiltRef[]; body: string }
export interface BuildReport {
  path: string; workers: Owner[]; records: number;
  steps: Record<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
}

/** What a built-in step sees: the records as read (nothing is screened). Command and URL steps never see this. */
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

/** `ctx` supplies storage and the manifest. `ctx.rootDir` is the root on local disk. */
export async function build(o: { ctx: WriterContext; path?: string }): Promise<BuildReport> {
  const { ctx } = o;
  const cwd = ctx.cwd ?? process.cwd();
  const path = o.path ?? "/";
  if (!/^\/([^/]+\/)*$/.test(path)) throw new Error(`build path must be a folder like / or /order/, got ${path}`);
  const report: BuildReport = { path, workers: foldersUnder(ctx.manifest, path), records: 0, steps: {} };

  // Read the files under the path. A file in no worker folder, or that does not parse, is simply not a record.
  const records: BuiltRecord[] = [];
  for (const p of (await listRecords(ctx.storage)).filter((x) => x.startsWith(path))) {
    const owner = ownerOf(ctx.manifest, p);
    const f = owner && (await ctx.storage.get(p));
    if (!owner || !f) continue;
    const v = await parseFile(f.body);
    if (!v.header) continue;
    records.push({ path: p, folder: owner.folder, schema: v.header.schema, v, refs: [], body: f.body });
  }
  // References resolve across the whole root, not only the build path.
  const byPath = new Map(records.map((r) => [r.path, r.v]));
  for (const r of records) {
    for (const x of findRefs(r.v.state)) {
      const error = await resolveRef(x.raw, async (p) => byPath.get(p) ?? (await lookup(ctx, p)));
      r.refs.push({ ...x, ref: parseRef(x.raw), error });
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
  return f ? parseFile(f.body) : null;
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
