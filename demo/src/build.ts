// Build: verify every file, trust each only up to its last valid entry, quarantine bad tails,
// then derive a static site and (optionally) a SQLite cache. Files stay the source of truth.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WriterContext } from "./checks.ts";
import { verifyFile, type VerifyResult } from "./format.ts";
import { quarantineTail } from "./quarantine.ts";
import { findRefs, parseRef, resolveRef, type Ref } from "./refs.ts";
import { validate } from "./schema.ts";
import { renderSite } from "./site.ts";
import type { Storage } from "./storage.ts";

export interface BuiltRef { pointer: string; raw: string; ref: Ref | null; error: string | null }
export interface BuiltRecord { path: string; type: string; v: VerifyResult; refs: BuiltRef[]; warnings: string[]; body: string }
export interface BuildReport {
  records: number; quarantined: { path: string; quarantinePath?: string; reason: string; skipped?: string }[];
  unusable: { path: string; reason: string }[]; brokenRefs: { path: string; pointer: string; error: string }[]; warnings: string[];
}

/** `ctx` is needed only to quarantine (it signs the quarantine record). Without a signer, bad tails are just ignored. */
export async function build(o: { ctx: WriterContext & { hasSigner?: boolean }; out: string; sqlite?: string | null; log?: (s: string) => void }): Promise<BuildReport> {
  const { ctx } = o;
  const report: BuildReport = { records: 0, quarantined: [], unusable: [], brokenRefs: [], warnings: [] };
  const canSign = !!ctx.signer;

  // Pass 1: verify, and heal files with a bad tail.
  for (const path of await ctx.storage.list()) {
    const f = await ctx.storage.get(path);
    if (!f) continue;
    const v = await verifyFile(f.body, ctx.keys);
    if (v.ok) continue;
    if (!v.header) { report.unusable.push({ path, reason: v.error! }); continue; }
    if (!canSign) { report.quarantined.push({ path, reason: v.error!, skipped: "no signing key; tail ignored but not moved" }); continue; }
    const r = await quarantineTail(ctx, path, f, v);
    report.quarantined.push("quarantinePath" in r
      ? { path, reason: v.error!, quarantinePath: r.quarantinePath }
      : { path, reason: v.error!, skipped: r.skipped });
  }

  // Pass 2: read the healed files and build records.
  const records: BuiltRecord[] = [];
  for (const path of await ctx.storage.list()) {
    const f = await ctx.storage.get(path);
    const v = f ? await verifyFile(f.body, ctx.keys) : null;
    if (!f || !v?.header) continue; // already reported as unusable
    const warnings: string[] = [];
    if (!v.ok) warnings.push(`Trusted up to entry ${v.entries.length}; the rest of the file is ignored (${v.error}).`);
    const schema = await ctx.getSchema(v.header.record_schema);
    const bad = schema && v.entries.length ? validate(schema, v.state) : null;
    if (bad) warnings.push(`Current state fails ${v.header.record_schema}: ${bad}`);
    records.push({ path, type: path.split("/")[1], v, refs: [], warnings, body: f.body });
  }
  const byPath = new Map(records.map((r) => [r.path, r.v]));
  for (const r of records) {
    for (const x of findRefs(r.v.state)) {
      const error = await resolveRef(x.raw, async (p) => byPath.get(p) ?? null);
      r.refs.push({ ...x, ref: parseRef(x.raw), error });
      if (error) report.brokenRefs.push({ path: r.path, pointer: x.pointer, error });
    }
  }
  report.records = records.length;

  // Outputs are disposable: wipe and rewrite.
  await rm(o.out, { recursive: true, force: true });
  for (const [p, html] of renderSite(records)) await put(join(o.out, p), html);
  for (const r of records) await put(join(o.out, r.path), r.body);          // raw file, next to its page
  if (o.sqlite) {
    const { writeSqlite } = await import("./sqlite.ts");
    await mkdir(dirname(o.sqlite), { recursive: true });
    await writeSqlite(o.sqlite, records);
  }
  return report;
}

async function put(file: string, body: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}
