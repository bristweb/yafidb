// JSON Schema validation with @cfworker/json-schema (no code generation, so it runs on Workers).
import { Validator } from "@cfworker/json-schema";
import { isPlainObject } from "./util.ts";

const cache = new WeakMap<object, Validator>();

/** Returns null when valid, else a readable error. */
export function validate(schema: object, instance: unknown): string | null {
  let v = cache.get(schema);
  if (!v) cache.set(schema, (v = new Validator(schema as any, "2020-12")));
  const r = v.validate(instance);
  return r.valid ? null : r.errors.slice(0, 5).map((e) => `${e.instanceLocation || "/"}: ${e.error}`).join("; ");
}

/** Patch entries carry only changed fields, so drop `required` before checking them. */
export function partialSchema(s: any): any {
  if (Array.isArray(s)) return s.map(partialSchema);
  if (!isPlainObject(s)) return s;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "required") continue;
    out[k] = k === "properties" && isPlainObject(v)
      ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, partialSchema(x)]))
      : partialSchema(v);
  }
  return out;
}

/** In a merge patch, null means "delete this field", so it is not a value to type-check. */
export function dropNulls(v: any): any {
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
}
