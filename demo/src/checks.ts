// Enforced checks, in the order the docs list them. Any failure throws WriteError and nothing is written.
import { applyEntry, MODES, verifyFile, type Mode, type VerifyResult } from "./format.ts";
import type { KeyStore, Signer } from "./jws.ts";
import { findRefs, resolveRef } from "./refs.ts";
import { dropNulls, partialSchema, validate } from "./schema.ts";
import type { Storage } from "./storage.ts";
import { isPlainObject } from "./util.ts";

export type CheckName = "request" | "existing" | "entry" | "relationships" | "plugin" | "write";

export class WriteError extends Error {
  constructor(public check: CheckName, message: string, public status = 422) { super(message); }
}

export interface PluginInput {
  path: string;
  record_schema: string;
  existing: string;                      // the file as it is now (just the header when creating a record)
  entry: { mode: Mode; data: any };      // the proposed entry
  result: any;                           // the record after the entry is applied
}
export interface PluginCheck { name: string; run(input: PluginInput): Promise<{ pass: boolean; reason?: string }> }

export interface WriterContext {
  storage: Storage;
  keys: KeyStore;
  signer: Signer;
  getSchema(name: string): Promise<object | null>;
  plugins: PluginCheck[];
  now(): Date;
}

export interface EntryRequest { mode: Mode; data: any }

export async function enforcedChecks(ctx: WriterContext, path: string, existingText: string, entry: EntryRequest) {
  // 1. Existing file: every signature and chain link verifies.
  const v: VerifyResult = await verifyFile(existingText, ctx.keys);
  if (!v.ok || !v.header) throw new WriteError("existing", `existing file does not verify: ${v.error}`, 409);

  // 2. Entry: valid mode, passes the schema, and so does the applied result.
  if (!MODES.includes(entry.mode)) throw new WriteError("entry", `invalid mode ${entry.mode}`);
  if (!isPlainObject(entry.data) || Object.keys(entry.data).length === 0) throw new WriteError("entry", "entry data must be a non-empty object");
  if ("yafi" in entry.data) throw new WriteError("entry", "`yafi` is a reserved field");
  if (v.entries.length === 0 && entry.mode !== "checkpoint") throw new WriteError("entry", "first entry must be a checkpoint");
  const schema = await ctx.getSchema(v.header.record_schema);
  if (!schema) throw new WriteError("entry", `unknown record_schema ${v.header.record_schema}`);
  let result: any;
  try { result = applyEntry(v.state, entry.mode, entry.data); }
  catch (e: any) { throw new WriteError("entry", `cannot apply ${entry.mode}: ${e.message}`); }
  if (entry.mode !== "diff") {
    const own = entry.mode === "checkpoint" ? validate(schema, entry.data) : validate(partialSchema(schema), dropNulls(entry.data));
    if (own) throw new WriteError("entry", `entry fails ${v.header.record_schema}: ${own}`);
  }
  const whole = validate(schema, result);
  if (whole) throw new WriteError("entry", `resulting record fails ${v.header.record_schema}: ${whole}`);

  // 3. Relationships: every reference in the entry resolves.
  const seen = new Map<string, VerifyResult | null>();
  const lookup = async (p: string) => {
    if (!seen.has(p)) { const f = await ctx.storage.get(p); seen.set(p, f ? await verifyFile(f.body, ctx.keys) : null); }
    return seen.get(p)!;
  };
  for (const r of findRefs(entry.data)) {
    const err = await resolveRef(r.raw, lookup).catch((e) => `invalid reference: ${e.message}`);
    if (err) throw new WriteError("relationships", `${r.pointer || "/"}: ${err}`);
  }

  // 4. Plugged-in checks, in configured order. A check that errors counts as a failure.
  for (const p of ctx.plugins) {
    let out: { pass: boolean; reason?: string };
    try { out = await p.run({ path, record_schema: v.header.record_schema, existing: existingText, entry: { mode: entry.mode, data: entry.data }, result }); }
    catch (e: any) { throw new WriteError("plugin", `check ${p.name} errored: ${e.message}`, 403); }
    if (out?.pass !== true) throw new WriteError("plugin", `check ${p.name} rejected the write${out?.reason ? `: ${out.reason}` : ""}`, 403);
  }
  return { verified: v, result };
}
