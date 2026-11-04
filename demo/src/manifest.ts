// The root manifest, /yafi.yaml: the single source of truth for write authority and pipelines.
import YAML from "yaml";
import { signJws, verifyJws, type KeyStore, type Signer } from "./jws.ts";
import { validatePipeline } from "./pipeline.ts";
import type { Storage } from "./storage.ts";
import { isoSeconds, isPlainObject, sha256b64u } from "./util.ts";

export const MANIFEST_PATH = "/yafi.yaml";
export const QUARANTINE_SCHEMA = "quarantine@1";
const FOLDER_RE = /^\/([A-Za-z0-9_@.-]+\/)*$/;
const SCHEMA_RE = /^[a-z][a-z0-9_-]*@\d+$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** One pipeline step: a command, an HTTP endpoint, or (build only) a built-in that Yafi ships. */
export interface Step {
  name: string; after?: string[];
  command?: string[]; url?: string; builtin?: string;
  in?: string | string[]; out?: string; timeout_ms?: number;
}
export interface Manifest {
  workers: Record<string, { folders: Record<string, string> }>;
  pipelines: { write: Step[]; build: Step[]; quarantine: Step[] };
}
export interface Owner { worker: string; folder: string; schema: string }

export class ManifestError extends Error {
  constructor(public problems: string[]) { super(`invalid manifest:\n- ${problems.join("\n- ")}`); }
}

export const listRecords = async (storage: Storage) => (await storage.list()).filter((p) => p !== MANIFEST_PATH);

function parseSteps(v: unknown, label: string, builtins: boolean, problems: string[]): Step[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { problems.push(`pipelines.${label} must be a list`); return []; }
  const out: Step[] = [];
  v.forEach((s: any, i) => {
    const at = `pipelines.${label}[${i}]`;
    if (!isPlainObject(s) || typeof s.name !== "string" || !NAME_RE.test(s.name)) { problems.push(`${at} needs a name`); return; }
    const kinds = ["command", "url", ...(builtins ? ["builtin"] : [])].filter((k) => s[k] !== undefined);
    if (kinds.length !== 1) problems.push(`${at} (${s.name}) needs exactly one of command, url${builtins ? ", builtin" : ""}`);
    if (s.command !== undefined && !(Array.isArray(s.command) && s.command.length && s.command.every((x: unknown) => typeof x === "string")))
      problems.push(`${at} (${s.name}) command must be a list of strings`);
    if (s.after !== undefined && !(Array.isArray(s.after) && s.after.every((x: unknown) => typeof x === "string")))
      problems.push(`${at} (${s.name}) after must be a list of step names`);
    out.push(s as unknown as Step);
  });
  for (const p of validatePipeline(out, `pipelines.${label}`)) problems.push(p);
  return out;
}

/** Parses and validates the manifest text (without a signature line). Throws ManifestError listing every problem. */
export function parseManifest(text: string): Manifest {
  const problems: string[] = [];
  let doc: any;
  try { doc = YAML.parse(text, { uniqueKeys: true }); } catch (e: any) { throw new ManifestError([`bad YAML: ${String(e.message).split("\n")[0]}`]); }
  if (!isPlainObject(doc)) throw new ManifestError(["manifest must be a mapping"]);
  for (const k of Object.keys(doc)) if (k !== "workers" && k !== "pipelines") problems.push(`unknown key ${k}`);

  const workers: Manifest["workers"] = {};
  if (!isPlainObject(doc.workers) || Object.keys(doc.workers).length === 0) problems.push("workers must list at least one worker");
  else for (const [name, w] of Object.entries<any>(doc.workers)) {
    if (!NAME_RE.test(name)) problems.push(`bad worker name ${name}`);
    if (!isPlainObject(w) || !isPlainObject(w.folders) || Object.keys(w.folders).length === 0) { problems.push(`worker ${name} needs folders`); continue; }
    workers[name] = { folders: {} };
    for (const [folder, schema] of Object.entries<any>(w.folders)) {
      if (!FOLDER_RE.test(folder)) problems.push(`worker ${name}: folder ${folder} must start and end with /`);
      else if (typeof schema !== "string" || !SCHEMA_RE.test(schema)) problems.push(`worker ${name}: folder ${folder} needs exactly one schema like name@1`);
      else workers[name].folders[folder] = schema;
    }
  }

  // Authority: a folder belongs to one worker, and worker folders never nest across workers.
  const all = Object.entries(workers).flatMap(([worker, w]) => Object.keys(w.folders).map((folder) => ({ worker, folder })));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.worker === b.worker) continue;
    if (a.folder === b.folder) problems.push(`folder ${a.folder} is shared by workers ${a.worker} and ${b.worker}`);
    else if (a.folder.startsWith(b.folder) || b.folder.startsWith(a.folder)) {
      const [outer, inner] = a.folder.length < b.folder.length ? [a, b] : [b, a];
      problems.push(`folder ${inner.folder} of worker ${inner.worker} is inside ${outer.folder} of worker ${outer.worker}`);
    }
  }

  const pl = doc.pipelines ?? {};
  if (!isPlainObject(pl)) problems.push("pipelines must be a mapping");
  for (const k of Object.keys(isPlainObject(pl) ? pl : {})) if (!["write", "build", "quarantine"].includes(k)) problems.push(`unknown pipeline ${k}`);
  const p = isPlainObject(pl) ? pl : {};
  const pipelines = {
    write: parseSteps(p.write, "write", false, problems),
    build: parseSteps(p.build, "build", true, problems),
    quarantine: parseSteps(p.quarantine, "quarantine", false, problems),
  };
  if (problems.length) throw new ManifestError(problems);
  return { workers, pipelines };
}

/** Every referenced schema must exist. */
export async function screenSchemas(m: Manifest, getSchema: (n: string) => Promise<object | null>) {
  const missing = new Set<string>();
  for (const w of Object.values(m.workers)) for (const s of Object.values(w.folders)) if (!(await getSchema(s))) missing.add(s);
  if (missing.size) throw new ManifestError([...missing].map((s) => `schema ${s} does not exist`));
}

/** The folder rule that applies to a path: the nearest (longest) folder above it. The manifest itself is nobody's. */
export function ownerOf(m: Manifest, path: string): Owner | null {
  if (path === MANIFEST_PATH) return null;
  let best: Owner | null = null;
  for (const [worker, w] of Object.entries(m.workers))
    for (const [folder, schema] of Object.entries(w.folders))
      if (path.startsWith(folder) && (!best || folder.length > best.folder.length)) best = { worker, folder, schema };
  return best;
}

/** Folder rules a build over `path` covers: folders inside it, or the rule it sits inside. */
export function foldersUnder(m: Manifest, path: string): Owner[] {
  const out: Owner[] = [];
  for (const [worker, w] of Object.entries(m.workers))
    for (const [folder, schema] of Object.entries(w.folders)) if (folder.startsWith(path)) out.push({ worker, folder, schema });
  const inside = ownerOf(m, path);
  if (inside && !out.some((o) => o.folder === inside.folder)) out.push(inside);
  return out;
}

/** Corrupt data goes to the worker that owns the quarantine schema's folder (the first, in manifest order). */
export function quarantineTarget(m: Manifest): { worker: string; folder: string } | null {
  for (const [worker, w] of Object.entries(m.workers))
    for (const [folder, schema] of Object.entries(w.folders)) if (schema === QUARANTINE_SCHEMA) return { worker, folder };
  return null;
}

// ---- optional signing: a last line `yafi: manifest <time> <jws>` over a hash of everything above it ----

const SIG_RE = /\nyafi: manifest (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\n?$/;

export function splitSignature(text: string): { body: string; time?: string; jws?: string } {
  const m = SIG_RE.exec(text.endsWith("\n") ? text : text + "\n");
  if (!m) return { body: text };
  const t = text.endsWith("\n") ? text : text + "\n";
  return { body: t.slice(0, m.index + 1), time: m[1], jws: m[2] };
}

export async function signManifest(text: string, signer: Signer, now: Date): Promise<string> {
  const body = splitSignature(text).body.replace(/\n*$/, "\n");
  const iat = Math.floor(now.getTime() / 1000);
  const jws = await signJws(signer, { mode: "manifest", iat, manifest_hash: await sha256b64u(body) });
  return `${body}yafi: manifest ${isoSeconds(iat)} ${jws}\n`;
}

/** A signature, if present, must verify. With `requireSigned`, it must be present. */
export async function verifyManifestText(text: string, keys: KeyStore, requireSigned = false): Promise<string> {
  const { body, time, jws } = splitSignature(text);
  if (!jws) {
    if (requireSigned) throw new ManifestError(["manifest is not signed"]);
    return body;
  }
  try {
    const v = await verifyJws(keys, jws);
    if (v.payload.mode !== "manifest") throw new Error("wrong mode");
    if (isoSeconds(v.payload.iat) !== time) throw new Error("time differs from signed iat");
    if (v.payload.manifest_hash !== (await sha256b64u(body))) throw new Error("manifest was changed after signing");
  } catch (e: any) { throw new ManifestError([`manifest signature failed: ${e.message}`]); }
  return body;
}

/** Reads /yafi.yaml from storage (it is part of the root), verifies it, and validates it. */
export async function loadManifest(storage: Storage, keys: KeyStore, o: { getSchema?: (n: string) => Promise<object | null>; requireSigned?: boolean } = {}): Promise<Manifest> {
  const f = await storage.get(MANIFEST_PATH);
  if (!f) throw new ManifestError([`${MANIFEST_PATH} not found`]);
  const m = parseManifest(await verifyManifestText(f.body, keys, o.requireSigned));
  if (o.getSchema) await screenSchemas(m, o.getSchema);
  return m;
}
