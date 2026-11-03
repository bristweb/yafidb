// The check tool: verifies a file as its owning worker's folder requires, and quarantines what is wrong.
// It is standalone (`bun run check [path]`). A worker always runs it on a file before writing; an admin can add it
// to a build as an opt-in step. Anything that runs it automatically quarantines what is wrong, through the
// quarantine worker. Builds and reads do not run it by default.
//
// What it checks: the header's version is one this tool supports, every signature and chain link verifies, and the
// header's schema is the schema of the file's folder.
import type { WriterContext } from "./checks.ts";
import { verifyFile } from "./format.ts";
import { listRecords, ownerOf } from "./manifest.ts";
import { quarantineFile } from "./quarantine.ts";

export type CheckResult =
  | { path: string; status: "ok"; file: { body: string; version: string } }   // the file as last read, which verified
  | { path: string; status: "unowned" | "missing" }
  | { path: string; status: "quarantined"; reason: string; quarantinePath: string; followUps: Record<string, string> }
  | { path: string; status: "failed"; reason: string; skipped: string };   // wrong, and could not be quarantined

/**
 * Checks one file. Pass `file` if it was just read, so the check sees exactly what the caller sees.
 * If another check cuts the file first (our conditional cut loses), the file is read again and checked afresh,
 * so the result always describes the file as it is now, never a version someone else already dealt with.
 */
export async function checkFile(ctx: WriterContext, path: string, file?: { body: string; version: string } | null): Promise<CheckResult> {
  const owner = ownerOf(ctx.manifest, path);
  if (!owner) return { path, status: "unowned" };
  for (let attempt = 0; ; attempt++) {
    const f = attempt === 0 && file ? file : await ctx.storage.get(path);
    if (!f) return { path, status: "missing" };
    const v = await verifyFile(f.body, ctx.keys);
    const wrongSchema = v.ok && v.header!.schema !== owner.schema;
    if (v.ok && !wrongSchema) return { path, status: "ok", file: f };
    const reason = wrongSchema ? `schema ${v.header!.schema} does not match folder schema ${owner.schema}` : v.error!;
    // A file that fails part-way keeps its verified entries. No verified header, or the wrong schema: the whole file moves.
    const q = await quarantineFile(ctx, path, f, v, reason, !v.ok && !!v.header);
    if ("lost" in q) {
      if (attempt < 4) continue;
      return { path, status: "failed", reason, skipped: "the file kept changing while it was being quarantined; run again" };
    }
    return "quarantinePath" in q
      ? { path, status: "quarantined", reason, quarantinePath: q.quarantinePath, followUps: q.followUps }
      : { path, status: "failed", reason, skipped: q.skipped };
  }
}

/** Checks every record file under a folder (or one file). */
export async function checkPath(ctx: WriterContext, path = "/"): Promise<CheckResult[]> {
  const files = path.endsWith("/") ? (await listRecords(ctx.storage)).filter((p) => p.startsWith(path)) : [path];
  const out: CheckResult[] = [];
  for (const p of files) out.push(await checkFile(ctx, p));
  return out;
}
