// The Yafi file format: parse, verify (signatures + chain), and replay entries.
import YAML from "yaml";
import { verifyJws, type KeyStore } from "./jws.ts";
import { canonical, isoSeconds, isPlainObject, sha256b64u } from "./util.ts";

export type Mode = "checkpoint" | "patch" | "diff";
export const MODES: Mode[] = ["checkpoint", "patch", "diff"];
// The header's mode carries the format version: `header@1.0.0`. A reader lists the versions it supports and
// matches the whole text exactly; anything else is unusable. Any string is allowed as a version.
export const SUPPORTED_HEADERS: readonly string[] = ["header@1.0.0"];
export const CURRENT_HEADER = "header@1.0.0";
const ID_LEN = 22;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const LINE_RE = /^yafi: (header@\S+|checkpoint|patch|diff) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export interface HeaderInfo { version: string; schema: string; time: string; nonce: string; sig: string; id: string }
export interface VEntry { seq: number; mode: Mode; time: string; sig: string; id: string; data: any; state: any }
export interface VerifyResult {
  ok: boolean;
  header: HeaderInfo | null;   // null: nothing in the file can be trusted
  entries: VEntry[];           // the verified prefix
  state: any;                  // record state after the last verified entry
  lastSig: string;             // signature the next entry must chain to
  validEnd: number;            // text offset where the trusted prefix ends
  error?: string;              // why verification stopped
}

export const recordId = (headerSig: string) => headerSig.slice(0, ID_LEN);

// ---- parsing ----------------------------------------------------------

interface Doc { start: number; body: string; end: number }

/** Entries are YAML documents separated by a line that is exactly `---`. */
function splitDocs(text: string): Doc[] {
  const docs: Doc[] = [];
  let start = 0, bodyStart = 0;
  for (const m of text.matchAll(/^---$/gm)) {
    docs.push({ start, body: text.slice(bodyStart, m.index), end: m.index });
    start = m.index; bodyStart = m.index + 4;
  }
  docs.push({ start, body: text.slice(bodyStart), end: text.length });
  return docs;
}

function parseDoc(body: string) {
  const lines = body.replace(/\n+$/, "").split("\n");
  const m = LINE_RE.exec(lines.pop() ?? "");
  if (!m) throw new Error("missing or malformed yafi line");
  const text = lines.join("\n");
  let data: any = {};
  if (text.trim() !== "") {
    try { data = YAML.parse(text, { uniqueKeys: true }); }   // duplicate keys are an error
    catch (e: any) { throw new Error(`bad YAML: ${String(e.message).split("\n")[0]}`); }
  }
  if (!isPlainObject(data)) throw new Error("entry is not a mapping");
  return { mode: m[1], time: m[2], jws: m[3], data };
}

async function verifyHeader(body: string, keys: KeyStore | null): Promise<HeaderInfo> {
  const d = parseDoc(body);
  if (!d.mode.startsWith("header@")) throw new Error("first line must be a header");
  if (Object.keys(d.data).join(",") !== "schema" || typeof d.data.schema !== "string") throw new Error("header must hold exactly a `schema` text field");
  if (!keys) { const sig = d.jws.split(".")[2]; return { version: d.mode, schema: d.data.schema, time: d.time, nonce: "", sig, id: recordId(sig) }; }   // plain read
  if (!SUPPORTED_HEADERS.includes(d.mode)) throw new Error(`unsupported header version ${d.mode}`);
  const v = await verifyJws(keys, d.jws);
  const p = v.payload;
  if (p.mode !== d.mode) throw new Error("signed mode differs from line mode");
  if (typeof p.nonce !== "string" || !NONCE_RE.test(p.nonce)) throw new Error("header nonce missing or malformed");
  if (p.schema !== d.data.schema) throw new Error("header schema differs from what was signed");
  if (!Number.isInteger(p.iat) || isoSeconds(p.iat) !== d.time) throw new Error("header time differs from signed iat");
  return { version: d.mode, schema: d.data.schema, time: d.time, nonce: p.nonce, sig: v.sig, id: recordId(v.sig) };
}

export const entryDataHash = (data: unknown) => sha256b64u(canonical(data));

async function verifyEntry(body: string, prev: string, first: boolean, keys: KeyStore | null) {
  const d = parseDoc(body);
  if (!MODES.includes(d.mode as Mode)) throw new Error(`invalid mode ${d.mode}`);
  if ("yafi" in d.data) throw new Error("`yafi` is a reserved field");
  if (first && d.mode !== "checkpoint") throw new Error("first entry must be a checkpoint");
  if (!keys) { const sig = d.jws.split(".")[2]; return { mode: d.mode as Mode, time: d.time, sig, id: recordId(sig), data: d.data }; }   // plain read
  const v = await verifyJws(keys, d.jws);
  const p = v.payload;
  if (p.mode !== d.mode) throw new Error("signed mode differs from line mode");
  if (!Number.isInteger(p.iat) || isoSeconds(p.iat) !== d.time) throw new Error("time differs from signed iat");
  if (p.prev !== prev) throw new Error("chain broken (previous signature mismatch)");
  if (p.data_hash !== (await entryDataHash(d.data))) throw new Error("data does not match signed hash");
  return { mode: d.mode as Mode, time: d.time, sig: v.sig, id: recordId(v.sig), data: d.data };
}

/**
 * Verifies a whole file; with `keys: null` it only reads it (see `parseFile`). Never throws: on a failure the result holds
 * up to the last good entry (`entries`, `state`, `validEnd`) plus `error`.
 */
export async function verifyFile(text: string, keys: KeyStore | null): Promise<VerifyResult> {
  const res: VerifyResult = { ok: false, header: null, entries: [], state: {}, lastSig: "", validEnd: 0 };
  const docs = splitDocs(text);
  try { res.header = await verifyHeader(docs[0].body, keys); }
  catch (e: any) { res.error = `header: ${e.message}`; return res; }
  res.lastSig = res.header.sig;
  res.validEnd = docs[0].end;
  for (let i = 1; i < docs.length; i++) {
    try {
      const e = await verifyEntry(docs[i].body, res.lastSig, i === 1, keys);
      res.state = applyEntry(res.state, e.mode, e.data);
      res.entries.push({ seq: i, ...e, state: res.state });
      res.lastSig = e.sig;
      res.validEnd = docs[i].end;
    } catch (e: any) {
      res.error = `entry ${i}: ${e.message}`;
      return res;
    }
  }
  res.ok = true;
  return res;
}

/**
 * Reads a file without checking anything: no signatures, chain, hashes or versions. Whatever parses and replays is
 * returned, up to the first entry that does not. For builds and other consumers; only a worker validates.
 */
export const parseFile = (text: string) => verifyFile(text, null);

// ---- replaying entries --------------------------------------------------

export function applyEntry(state: any, mode: Mode, data: any): any {
  if (mode === "checkpoint") return structuredClone(data);
  if (mode === "patch") return mergePatch(state, data);
  const out = structuredClone(state);
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "string") throw new Error(`diff for ${k} must be text`);
    const cur = out[k] ?? "";
    if (typeof cur !== "string") throw new Error(`${k} is not a text field`);
    out[k] = applyDiff(cur, v);
  }
  return out;
}

/** RFC 7386 JSON Merge Patch: objects merge, everything else replaces, null deletes. */
export function mergePatch(target: any, patch: any): any {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, any> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const toLines = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
const fromLines = (l: string[]) => (l.length ? l.join("\n") + "\n" : "");

/** Applies a zero-context unified diff (`@@ -a,b +c,d @@` hunks). Text is line-based. */
export function applyDiff(text: string, diff: string): string {
  const old = toLines(text), out: string[] = [];
  let pos = 0;
  const lines = diff.replace(/\n$/, "").split("\n");
  for (let i = 0; i < lines.length;) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[i++]);
    if (!h) throw new Error("malformed diff hunk");
    const oldCount = h[2] === undefined ? 1 : +h[2];
    const at = oldCount === 0 ? +h[1] : +h[1] - 1;
    if (at < pos || at > old.length) throw new Error("diff hunk out of range");
    out.push(...old.slice(pos, at));
    pos = at;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const l = lines[i++], c = l[0], rest = l.slice(1);
      if (c === "+") out.push(rest);
      else if (c === "-" || c === " ") {
        if (old[pos] !== rest) throw new Error("diff does not match current text");
        if (c === " ") out.push(rest);
        pos++;
      } else throw new Error("malformed diff line");
    }
  }
  out.push(...old.slice(pos));
  return fromLines(out);
}

/** Builds a single-hunk, zero-context diff from old to new text. */
export function makeDiff(a: string, b: string): string {
  const x = toLines(a), y = toLines(b);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const del = x.slice(p, x.length - s), add = y.slice(p, y.length - s);
  if (!del.length && !add.length) return "";
  const head = `@@ -${del.length ? p + 1 : p},${del.length} +${add.length ? p + 1 : p},${add.length} @@`;
  return [head, ...del.map((l) => "-" + l), ...add.map((l) => "+" + l)].join("\n") + "\n";
}

// ---- serializing ----------------------------------------------------------

/** Block-style YAML; multi-line text becomes a literal block. */
export function dumpData(data: Record<string, unknown>): string {
  return YAML.stringify(data, { lineWidth: 0, blockQuote: "literal", indentSeq: true });
}
