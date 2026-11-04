// Cloudflare Worker entry (sketch): one deployed Worker is one YafiDB worker. It acts as YAFI_WORKER, reads the
// manifest from /yafi.yaml in the bucket, and writes only inside that worker's folders.
// Write screens from the manifest must be `url` steps here, because Workers cannot spawn commands.
//   bindings: BUCKET (R2), YAFI_WORKER, YAFI_PRIVATE_JWK (secret), YAFI_JWKS, YAFI_SCHEMAS (JSON name->schema),
//             YAFI_REQUIRE_SIGNED_MANIFEST ("1", optional), YAFI_TOKEN (secret, optional)
import type { WriterContext } from "./screens.ts";
import { createHandler } from "./handler.ts";
import { importJwks, importSigner } from "./jws.ts";
import { loadManifest, ManifestError } from "./manifest.ts";
import { screenFromStep } from "./plugins.ts";
import { R2Storage, type R2BucketLike } from "./storage.ts";

export interface Env {
  BUCKET: R2BucketLike; YAFI_WORKER: string; YAFI_PRIVATE_JWK: string; YAFI_JWKS: string;
  YAFI_SCHEMAS: string; YAFI_REQUIRE_SIGNED_MANIFEST?: string; YAFI_TOKEN?: string;
}

export async function contextFromEnv(env: Env): Promise<WriterContext> {
  const schemas = JSON.parse(env.YAFI_SCHEMAS) as Record<string, object>;
  const getSchema = async (n: string) => schemas[n] ?? null;
  const storage = new R2Storage(env.BUCKET);
  const keys = await importJwks(JSON.parse(env.YAFI_JWKS));
  const manifest = await loadManifest(storage, keys, { getSchema, requireSigned: env.YAFI_REQUIRE_SIGNED_MANIFEST === "1" });
  if (!manifest.workers[env.YAFI_WORKER]) throw new ManifestError([`worker ${env.YAFI_WORKER} is not in the manifest`]);
  return {
    storage, keys, manifest, worker: env.YAFI_WORKER, getSchema,
    signer: await importSigner(JSON.parse(env.YAFI_PRIVATE_JWK)),
    plugins: manifest.pipelines.write.map((s) => screenFromStep(s, ".")),
    now: () => new Date(),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(() => contextFromEnv(env), { token: env.YAFI_TOKEN })(req);
  },
};
