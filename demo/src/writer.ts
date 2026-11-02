// The writer: runs the enforced checks, signs, and appends with a conditional write.
import { enforcedChecks, WriteError, type EntryRequest, type WriterContext } from "./checks.ts";
import { dumpData, entryDataHash, MODES, verifyFile, YAFI_SCHEMA, type Mode } from "./format.ts";
import { signJws } from "./jws.ts";
import { assertPath } from "./storage.ts";
import { isoSeconds, randomNonce } from "./util.ts";

export interface WriteResult { path: string; record_id: string; entry_id: string; version: string }

function stamp(ctx: WriterContext) {
  const iat = Math.floor(ctx.now().getTime() / 1000);
  return { iat, time: isoSeconds(iat) };
}

async function headerText(ctx: WriterContext, record_schema: string) {
  const { iat, time } = stamp(ctx);
  const nonce = randomNonce();
  const jws = await signJws(ctx.signer, { mode: "header", iat, nonce, yafi_schema: YAFI_SCHEMA, record_schema });
  return `yafi_schema: ${YAFI_SCHEMA}\nrecord_schema: ${record_schema}\nyafi: header ${time} ${jws}\n`;
}

async function commit(ctx: WriterContext, path: string, base: string, expected: string | null, entry: EntryRequest): Promise<WriteResult> {
  const { verified } = await enforcedChecks(ctx, path, base, entry);

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

export async function createRecord(ctx: WriterContext, req: { path: string; record_schema: string; data: any }): Promise<WriteResult> {
  try { assertPath(req.path); } catch (e: any) { throw new WriteError("request", e.message, 400); }
  if (typeof req.record_schema !== "string" || !/^[a-z][a-z0-9_-]*@\d+$/.test(req.record_schema))
    throw new WriteError("request", "record_schema must look like name@1", 400);
  // Demo rule: a record lives under /<schema name>/..., so the folder names its type.
  if (!req.path.startsWith(`/${req.record_schema.split("@")[0]}/`))
    throw new WriteError("request", `path for ${req.record_schema} must start with /${req.record_schema.split("@")[0]}/`, 400);
  if (await ctx.storage.get(req.path)) throw new WriteError("write", `${req.path} already exists`, 409);
  return commit(ctx, req.path, await headerText(ctx, req.record_schema), null, { mode: "checkpoint", data: req.data });
}

export async function appendEntry(ctx: WriterContext, req: { path: string; mode: Mode; data: any }): Promise<WriteResult> {
  try { assertPath(req.path); } catch (e: any) { throw new WriteError("request", e.message, 400); }
  if (!MODES.includes(req.mode)) throw new WriteError("request", `mode must be one of ${MODES.join(", ")}`, 400);
  const f = await ctx.storage.get(req.path);
  if (!f) throw new WriteError("request", `${req.path} does not exist`, 404);
  return commit(ctx, req.path, f.body, f.version, { mode: req.mode, data: req.data });
}
