// References: /path.yaml#recordId[/entryId[/json-pointer-field]]
import type { VerifyResult } from "./format.ts";

export const REF_LIKE = /^\/[^\s#]*\.yaml#/;
export const REF_RE = /^(\/[A-Za-z0-9_@./-]+\.yaml)#([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{22})(\/.+)?)?$/;

export interface Ref { path: string; recordId: string; entryId?: string; field?: string; raw: string }

export function parseRef(s: string): Ref | null {
  const m = REF_RE.exec(s);
  return m ? { path: m[1], recordId: m[2], entryId: m[3], field: m[4], raw: s } : null;
}

/** Every string value that looks like a reference, with the JSON Pointer of where it sits. */
export function findRefs(v: unknown, pointer = ""): { pointer: string; raw: string }[] {
  if (typeof v === "string") return REF_LIKE.test(v) ? [{ pointer, raw: v }] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => findRefs(x, `${pointer}/${i}`));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => findRefs(x, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  return [];
}

export function pointerGet(doc: any, pointer: string): { found: boolean; value?: any } {
  let cur = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const t = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur !== null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, t)) cur = cur[t];
    else return { found: false };
  }
  return { found: true, value: cur };
}

export type Lookup = (path: string) => Promise<VerifyResult | null>;

/** Returns an error message, or null when the reference resolves. */
export async function resolveRef(raw: string, lookup: Lookup): Promise<string | null> {
  const ref = parseRef(raw);
  if (!ref) return `malformed reference ${raw} (expected /path.yaml#recordId[/entryId[/field]])`;
  const t = await lookup(ref.path);
  if (!t) return `${ref.path} does not exist`;
  if (!t.header) return `${ref.path} has no valid header`;
  if (t.header.id !== ref.recordId) return `${ref.path} has record id ${t.header.id}, not ${ref.recordId}`;
  if (!ref.entryId) return null;
  const e = t.entries.find((x) => x.id === ref.entryId);
  if (!e) return `${ref.path} has no verified entry ${ref.entryId}`;
  if (ref.field && !pointerGet(e.state, ref.field).found) return `${ref.path} entry ${ref.entryId} has no field ${ref.field}`;
  return null;
}
