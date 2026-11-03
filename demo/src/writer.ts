// The writer: runs the enforced checks, signs, and appends with a conditional write.
import { enforcedChecks, WriteError, type EntryRequest, type WriterContext } from "./checks.ts";
import { dumpData, entryDataHash, MODES, verifyFile, CURRENT_HEADER, type Mode } from "./format.ts";
import { checkFile } from "./check.ts";
import { signJws } from "./jws.ts";
import { ownerOf } from "./manifest.ts";
import { assertPath } from "./storage.ts";
import { isoSeconds, randomNonce } from "./util.ts";

export interface WriteResult { path: string; record_id: string; entry_id: string; version: string }

/** Authority: a worker writes only inside the folders it owns, and each folder has one schema. */
export function authorize(ctx: WriterContext, path: string): { folder: string; schema: string } {
  try { assertPath(path); } catch (e: any) { throw new WriteError("request", e.message, 400); }
  const o = ownerOf(ctx.manifest, path);
  if (!o) throw new WriteError("authority", `${path} is not inside any worker folder`, 403);
  if (o.worker !== ctx.worker) throw new WriteError("authority", `${path} belongs to worker ${o.worker}, not ${ctx.worker}`, 403);
  return o;
}

function stamp(ctx: WriterContext) {
  const iat = Math.floor(ctx.now().getTime() / 1000);
  return { iat, time: isoSeconds(iat) };
}

async function headerText(ctx: WriterContext, schema: string) {
  const { iat, time } = stamp(ctx);
  const nonce = randomNonce();
  const jws = await signJws(ctx.signer, { mode: CURRENT_HEADER, iat, nonce, schema });
  return `schema: ${schema}\nyafi: ${CURRENT_HEADER} ${time} ${jws}\n`;
}

async function commit(ctx: WriterContext, path: string, base: string, expected: string | null, entry: EntryRequest, folderSchema: string): Promise<WriteResult> {
  const { verified } = await enforcedChecks(ctx, path, base, entry, folderSchema);

  // Sign over the previous signature, then append.
  const { iat, time } = stamp(ctx);
  const jws = await signJws(ctx.signer, {
    mode: entry.mode, iat, data_hash: await entryDataHash(entry.data), prev: verified.lastSig,
  });
  const text = (base.endsWith("\n") ? base : base + "\n") + `---\n${dumpData(entry.data)}yafi: ${entry.mode} ${time} ${jws}\n`;

  // Self-check: the bytes we are about to write must verify and replay to what we validated.
  const after = await verifyFile(text, ctx.keys);
  if (!after.ok) throw new WriteError("write", `refusing to write: result does not verify (${after.error})`, 500);

  // 5. Conditional write. If the file changed since it was read, nothing is written.
  const put = await ctx.storage.putIfMatch(path, text, expected);
  if (!put.ok) throw new WriteError("write", "conflict: the file changed since it was read; re-read and retry", 409);
  return { path, record_id: after.header!.id, entry_id: after.entries.at(-1)!.id, version: put.version };
}

/**
 * The worker always runs the check on a file before writing to it. A file the check had to quarantine refuses the write
 * (409, retry). If another check got there first, the check re-reads, and the write goes on against the file as it is now.
 * Returns that file, or null if it no longer exists.
 */
async function checked(ctx: WriterContext, path: string, f: { body: string; version: string }) {
  const c = await checkFile(ctx, path, f);
  if (c.status === "quarantined" || c.status === "failed")
    throw new WriteError("existing", `existing file does not verify: ${c.reason}${c.status === "quarantined" ? `; moved to ${c.quarantinePath}, retry` : ` (${c.skipped})`}`, 409);
  return c.status === "ok" ? c.file : null;
}

export async function createRecord(ctx: WriterContext, req: { path: string; schema?: string; data: any }): Promise<WriteResult> {
  const { schema } = authorize(ctx, req.path);
  if (req.schema !== undefined && req.schema !== schema)
    throw new WriteError("authority", `${req.path} uses ${schema}, not ${req.schema}`, 403);
  const existing = await ctx.storage.get(req.path);
  if (existing && (await checked(ctx, req.path, existing))) throw new WriteError("write", `${req.path} already exists`, 409);
  return commit(ctx, req.path, await headerText(ctx, schema), null, { mode: "checkpoint", data: req.data }, schema);
}

export async function appendEntry(ctx: WriterContext, req: { path: string; mode: Mode; data: any }): Promise<WriteResult> {
  const { schema } = authorize(ctx, req.path);
  if (!MODES.includes(req.mode)) throw new WriteError("request", `mode must be one of ${MODES.join(", ")}`, 400);
  const f = await ctx.storage.get(req.path);
  if (!f) throw new WriteError("request", `${req.path} does not exist`, 404);
  const now = await checked(ctx, req.path, f);
  if (!now) throw new WriteError("request", `${req.path} does not exist`, 404);
  return commit(ctx, req.path, now.body, now.version, { mode: req.mode, data: req.data }, schema);
}
