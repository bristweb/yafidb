# YafiDB demo

A working, zero-cost demo of the [architecture](../docs/architecture.md) and [record format](../docs/record-format.md) in TypeScript on Bun: a root manifest, workers with folder authority, a pipeline runner for write checks and build steps, quarantine as a worker, and the file-format library. Dependencies: `yaml` and `@cfworker/json-schema` only. Signing uses WebCrypto Ed25519.

## Run it

```sh
bun install
bun run keygen          # keys/private.jwk.json (secret, gitignored) + keys/public.jwks.json
bun run seed            # writes root/: customer alice (worker crm) and the README's order 1042 (worker shop)
bun run build [folder]  # verify, heal through quarantine, then run the manifest's build steps (default: /)
bun run serve           # one writer per worker on :8787, POST only (set YAFI_TOKEN to require a bearer token)
bun run sign-manifest   # optional: sign root/yafi.yaml with the admin key
bun test                # 51 tests
```

The root is `root/`. Its manifest, [`root/yafi.yaml`](root/yafi.yaml), lists three workers (`crm`, `shop`, `quarantine`), the folder each owns and its schema, the write checks, and the build steps. Open `dist/site/index.html` after a build.

Try a writer. Each worker has its own endpoint and can write only in its own folders:

```sh
curl -XPOST localhost:8787/workers/shop/entries -d '{"path":"/order/1042/2026.yaml","mode":"patch","data":{"note":"Thanks!"}}'
curl -XPOST localhost:8787/workers/crm/entries  -d '{"path":"/order/1042/2026.yaml","mode":"patch","data":{"note":"x"}}'   # 403, check "authority"
```

Endpoints: `POST /workers/<name>/records` with `{path, data}` (`record_schema` is optional, and must match the folder's schema), and `POST /workers/<name>/entries` with `{path, mode, data}`. A rejected write returns 4xx with `{error, check}` where `check` is `request`, `authority`, `existing`, `entry`, `relationships`, `plugin` or `write`. Nothing is written on any failure.

To see quarantine: append `---\nstatus: refunded\nyafi: patch 2026-11-01T20:12:09Z a.b.c` to `root/order/1042/2026.yaml`, or drop any file into `root/order/`, and run `bun run build`. The tail (or the whole stray file) moves to a record in `root/quarantine/`, and the order verifies again. Inspect the cache with `sqlite3 dist/cache.sqlite 'select * from reverse_refs'`.

## Layout

| Path | What |
| --- | --- |
| `root/yafi.yaml` | the manifest: workers, folders, schemas, pipelines |
| `yafidb.yaml`, `schemas/`, `plugins/` | deployment settings (storage, keys), JSON Schemas, sample write check and build step |
| `src/manifest.ts` | parse and validate the manifest (overlap rules), folder rules, optional signing |
| `src/pipeline.ts` | the step runner: `after` dependencies, parallel where independent |
| `src/format.ts`, `jws.ts` | parse, verify, replay (checkpoint, patch, diff), dump block YAML; compact JWS, Ed25519 |
| `src/checks.ts`, `writer.ts` | the enforced checks, in order; create and append with authority, sign, conditional write |
| `src/heal.ts` | quarantine: send corrupt data to the quarantine worker, then remove it from the original |
| `src/build.ts`, `site.ts`, `sqlite.ts` | build: find workers under a path, verify, run build steps; the two default steps |
| `src/plugins.ts` | command and URL steps |
| `src/handler.ts`, `server.ts`, `worker.ts` | HTTP handler (Web APIs), Bun server (one handler per worker), Cloudflare Worker entry |
| `src/storage.ts`, `storage-local.ts` | storage interface: local (hash compare-and-swap), S3 (`If-Match`), R2 binding (`onlyIf`) |

## Decisions and gaps

- **Manifest location:** `/yafi.yaml` is a file in the root, read through the same storage as the records, so every worker sees one copy. It is excluded from record listings, and no worker owns it, so a write to it is refused. Deployment settings (storage location, keys) stay in `yafidb.yaml`, because they are not authority.
- **Authority:** a context acts as one worker. Every write checks that the path is in that worker's folders (nearest folder rule) and that the record uses the folder's schema. Workers read anywhere in the root. The demo shares one signing key across workers, so authority is enforced by the writer and by the build's folder check, not by a key per worker.
- **Signed payload:** header `{mode, iat, nonce, yafi_schema, record_schema}`; entry `{mode, iat, data_hash, prev}`. `data_hash` is SHA-256 of the entry's canonical JSON; `prev` is the previous signature segment. `iat` is epoch seconds and must equal the line's time.
- **Manifest signing** is optional: `bun run sign-manifest` adds a last line `yafi: manifest <time> <jws>` over a hash of the text above it. A signature that fails always stops the worker, and `manifest.require_signature: true` also refuses an unsigned manifest. The committed manifest is unsigned, because the key is per machine.
- **Pipelines:** steps are a `command` (JSON on stdin), a `url` (JSON POST), or, for builds, a `builtin` (`relationship-cache`, `static-site`). A step runs once everything in its `after` has succeeded. Write checks fail fast; a build step that fails skips what follows it and the others finish. Only built-in steps see the verified records. Command and URL build steps get `{name, root, path, in, out}` (also as `YAFI_ROOT`, `YAFI_IN`, `YAFI_OUT`) and read the files themselves.
- **Quarantine target:** the first folder whose schema is `quarantine@1`. The quarantine worker writes the record, the original is cut or deleted with a conditional write only after that succeeds, and then the manifest's `quarantine` steps run. Their failure is reported and cannot undo the move. A writer that finds a corrupt file quarantines it and refuses that write, so a retry succeeds.
- **Patch** is RFC 7386 merge patch (`null` deletes). **Diff** is a zero-context unified diff on a text field; text is line-based and ends with a newline.
- **Entry check:** a checkpoint must pass the schema; a patch is checked with `required` removed; the applied result must always pass.
- **References** are checked only in the new entry's data. Linking to a field of the current state without naming an entry (`#id//field`) is still open in the docs, so it is rejected.
- **Compare-and-swap:** local storage uses a lock file plus the file's SHA-256, so it is safe across processes on one machine. S3 and R2 use ETags. R2 has no conditional delete, so a whole-file quarantine there checks the ETag and then deletes, which can race. The S3 path is tested against a fake server, not a live bucket; the build tool reads local storage only.
- **Write checks** fail closed: a crash, bad reply or 5 s timeout rejects the write. Workers cannot spawn commands, so `worker.ts` supports URL checks only. `worker.ts` is tested with a fake R2 bucket, not deployed with wrangler.
- **Quarantine needs the signing key**, since the quarantine record is signed. Without one, the build still trusts only the valid prefix but moves nothing.
- **Only `.yaml` files** are listed, so a stray non-YAML file in a worker folder is not seen. A file outside every worker folder is reported as unowned and left alone.
- **No keys in git:** `keys/`, `dist/` and everything in `root/` except the manifest are gitignored. Re-running `keygen --force` makes existing data unverifiable.
