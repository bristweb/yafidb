// Builds a WriterContext on a normal machine (Bun/Node): deployment settings from yafidb.yaml,
// authority and pipelines from the manifest stored in the root (/yafi.yaml).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { WriterContext } from "./checks.ts";
import { importJwks, importSigner } from "./jws.ts";
import { loadManifest, ManifestError } from "./manifest.ts";
import { checkFromStep } from "./plugins.ts";
import { LocalStorage } from "./storage-local.ts";

export interface Config {
  storage: { type: "local"; dir: string };   // the root on disk
  schemas: string;
  keys: { public: string; private: string };
  manifest?: { require_signature?: boolean };
}

export async function loadConfig(root: string): Promise<Config> {
  return YAML.parse(await readFile(join(root, "yafidb.yaml"), "utf8"));
}

export const schemaLoader = (dir: string) => async (name: string) => {
  if (!/^[a-z][a-z0-9_-]*@\d+$/.test(name)) return null;
  try { return YAML.parse(await readFile(join(dir, `${name}.schema.yaml`), "utf8")); } catch { return null; }
};

/** The same context, acting as another worker. Authority follows the worker name. */
export const asWorker = <T extends WriterContext>(ctx: T, worker: string): T => ({ ...ctx, worker });

/**
 * `worker` is who the context writes as; leave it out for read-only users such as the build tool.
 * `needSigner: false` allows running without a key (reads, and builds that cannot heal).
 */
export async function loadContext(project: string, o: { worker?: string; needSigner?: boolean; now?: () => Date } = {}): Promise<WriterContext & { config: Config; hasSigner: boolean; rootDir: string }> {
  const cfg = await loadConfig(project);
  const keys = await importJwks(JSON.parse(await readFile(resolve(project, cfg.keys.public), "utf8")));
  let signer: any = null;
  const priv = process.env.YAFI_PRIVATE_JWK ?? (await readFile(resolve(project, cfg.keys.private), "utf8").catch(() => null));
  if (priv) signer = await importSigner(JSON.parse(priv));
  else if (o.needSigner !== false) throw new Error(`no signing key: run \`bun run keygen\` (looked for ${cfg.keys.private})`);
  const rootDir = resolve(project, cfg.storage.dir);
  const storage = new LocalStorage(rootDir);
  const getSchema = schemaLoader(resolve(project, cfg.schemas));
  const manifest = await loadManifest(storage, keys, { getSchema, requireSigned: cfg.manifest?.require_signature });
  if (o.worker && !manifest.workers[o.worker]) throw new ManifestError([`worker ${o.worker} is not in the manifest`]);
  return {
    config: cfg, hasSigner: !!signer, keys, signer, manifest, worker: o.worker ?? "", cwd: project, rootDir, storage, getSchema,
    plugins: manifest.pipelines.write.map((s) => checkFromStep(s, project)),
    now: o.now ?? (() => new Date()),
  };
}
