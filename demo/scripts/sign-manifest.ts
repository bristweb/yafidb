// Signs root/yafi.yaml with the admin key (adds or replaces its last line, `yafi: manifest <time> <jws>`).
// Edit the manifest by hand, then run this again. Workers refuse a manifest whose signature no longer verifies.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { importSigner } from "../src/jws.ts";
import { parseManifest, signManifest, splitSignature } from "../src/manifest.ts";
import { loadConfig } from "../src/node-context.ts";

const project = new URL("..", import.meta.url).pathname;
const cfg = await loadConfig(project);
const file = resolve(project, cfg.storage.dir, "yafi.yaml");
const text = await readFile(file, "utf8");
parseManifest(splitSignature(text).body); // never sign an invalid manifest
const priv = process.env.YAFI_PRIVATE_JWK ?? (await readFile(resolve(project, cfg.keys.private), "utf8"));
await writeFile(file, await signManifest(text, await importSigner(JSON.parse(priv)), new Date()));
console.log(`signed ${file}`);
