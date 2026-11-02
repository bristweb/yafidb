// Cloudflare Worker entry (sketch: same handler, R2 binding for storage, secrets for keys).
// Plugged-in checks must be HTTP (`url`) checks here, because Workers cannot spawn commands.
//   bindings: BUCKET (R2), YAFI_PRIVATE_JWK (secret), YAFI_JWKS, YAFI_SCHEMAS (JSON name->schema),
//             YAFI_CHECKS (JSON array of {name,url}), YAFI_TOKEN (secret, optional)
import type { WriterContext } from "./checks.ts";
import { createHandler } from "./handler.ts";
import { importJwks, importSigner } from "./jws.ts";
import { urlCheck } from "./plugins.ts";
import { R2Storage, type R2BucketLike } from "./storage.ts";

export interface Env {
  BUCKET: R2BucketLike; YAFI_PRIVATE_JWK: string; YAFI_JWKS: string;
  YAFI_SCHEMAS: string; YAFI_CHECKS?: string; YAFI_TOKEN?: string;
}

export async function contextFromEnv(env: Env): Promise<WriterContext> {
  const schemas = JSON.parse(env.YAFI_SCHEMAS) as Record<string, object>;
  return {
    storage: new R2Storage(env.BUCKET),
    keys: await importJwks(JSON.parse(env.YAFI_JWKS)),
    signer: await importSigner(JSON.parse(env.YAFI_PRIVATE_JWK)),
    plugins: (JSON.parse(env.YAFI_CHECKS ?? "[]") as { name: string; url: string }[]).map((c) => urlCheck(c)),
    getSchema: async (n) => schemas[n] ?? null,
    now: () => new Date(),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(() => contextFromEnv(env), { token: env.YAFI_TOKEN })(req);
  },
};
