// Creates keys/private.jwk.json (secret, gitignored) and keys/public.jwks.json.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { generateKeyPair } from "../src/jws.ts";

const dir = new URL("../keys/", import.meta.url).pathname;
if (existsSync(dir + "private.jwk.json") && !process.argv.includes("--force")) {
  console.log("keys/ already exists; pass --force to replace (existing data will no longer verify)");
  process.exit(0);
}
const { privateJwk, publicJwk } = await generateKeyPair(process.env.KID ?? "demo-writer");
await mkdir(dir, { recursive: true });
await writeFile(dir + "private.jwk.json", JSON.stringify(privateJwk), { mode: 0o600 });
await writeFile(dir + "public.jwks.json", JSON.stringify({ keys: [publicJwk] }, null, 2) + "\n");
console.log("wrote keys/private.jwk.json (keep secret) and keys/public.jwks.json");
