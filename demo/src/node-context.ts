// Builds a WriterContext from yafidb.yaml on a normal machine (Bun/Node).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { WriterContext } from "./checks.ts";
import { importJwks, importSigner } from "./jws.ts";
import { commandCheck, urlCheck, type CheckConfig } from "./plugins.ts";
import { LocalStorage } from "./storage-local.ts";

export interface Config {
  storage: { type: "local"; dir: string };
  schemas: string;
  keys: { public: string; private: string };
  checks?: CheckConfig[];
  build?: { out: string; sqlite?: string | null };
}

export async function loadConfig(root: string): Promise<Config> {
  return YAML.parse(await readFile(join(root, "yafidb.yaml"), "utf8"));
}

export const schemaLoader = (dir: string) => async (name: string) => {
  if (!/^[a-z][a-z0-9_-]*@\d+$/.test(name)) return null;
  try { return YAML.parse(await readFile(join(dir, `${name}.schema.yaml`), "utf8")); } catch { return null; }
};

/** `needSigner: false` is for read-only users such as the build tool without a key. */
export async function loadContext(root: string, o: { needSigner?: boolean; now?: () => Date } = {}): Promise<WriterContext & { config: Config; hasSigner: boolean }> {
  const cfg = await loadConfig(root);
  const keys = await importJwks(JSON.parse(await readFile(resolve(root, cfg.keys.public), "utf8")));
  let signer: any = null;
  const priv = process.env.YAFI_PRIVATE_JWK ?? (await readFile(resolve(root, cfg.keys.private), "utf8").catch(() => null));
  if (priv) signer = await importSigner(JSON.parse(priv));
  else if (o.needSigner !== false) throw new Error(`no signing key: run \`bun run keygen\` (looked for ${cfg.keys.private})`);
  const plugins = (cfg.checks ?? []).map((c) => (c.url ? urlCheck(c) : commandCheck(c, root)));
  return {
    config: cfg, hasSigner: !!signer, keys, signer, plugins,
    storage: new LocalStorage(resolve(root, cfg.storage.dir)),
    getSchema: schemaLoader(resolve(root, cfg.schemas)),
    now: o.now ?? (() => new Date()),
  };
}
