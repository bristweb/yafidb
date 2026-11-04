# YafiDB demo

A working, zero-cost demo of the [architecture](../docs/architecture.md) and [record format](../docs/record-format.md) in TypeScript on Bun: a root manifest, workers with folder authority, a pipeline runner for write screens and build steps, a screen tool that quarantines through a quarantine worker, and the file-format library. Dependencies: `yaml` and `@cfworker/json-schema` only. Signing uses WebCrypto Ed25519.

## Run it

```sh
bun install
bun run keygen          # keys/private.jwk.json (secret, gitignored) + keys/public.jwks.json
bun run seed            # writes root/: customer alice (worker crm) and the README's order 1042 (worker shop)
bun run screen [path]   # the screen tool: verify files, quarantine what is wrong (default: /)
bun run build [folder]  # read the files and run the manifest's build steps; validates nothing (default: /)
bun run serve           # one writer per worker on :8787, POST only (set YAFI_TOKEN to require a bearer token)
bun run sign-manifest   # optional: sign root/yafi.yaml with the admin key
bun test                # 68 tests
```

The root is `root/`. Its manifest, [`root/yafi.yaml`](root/yafi.yaml), lists three workers (`crm`, `shop`, `quarantine`), the folder each owns and its schema, the write screens, and the build steps. Open `dist/site/index.html` after a build.

Try a writer. Each worker has its own endpoint and can write only in its own folders:

```sh
curl -XPOST localhost:8787/workers/shop/entries -d '{"path":"/order/1042/2026.yaml","mode":"patch","data":{"note":"Thanks!"}}'
curl -XPOST localhost:8787/workers/crm/entries  -d '{"path":"/order/1042/2026.yaml","mode":"patch","data":{"note":"x"}}'   # 403, screen "authority"
```

Endpoints: `POST /workers/<name>/records` with `{path, data}` (`schema` is optional, and must match the folder's schema), and `POST /workers/<name>/entries` with `{path, mode, data}`. A rejected write returns 4xx with `{error, screen}` where `screen` is `request`, `authority`, `existing`, `entry`, `relationships`, `plugin` or `write`. Nothing is written on any failure.

To see quarantine: append `---\nstatus: refunded\nyafi: patch 2026-11-01T20:12:09Z a.b.c` to `root/order/1042/2026.yaml`, or drop any file into `root/order/`, and run `bun run screen`. The tail (or the whole stray file) moves to a record in `root/quarantine/`, and the order verifies again. `bun run build` reads the same files without noticing anything wrong. To build from screened data, add a step that runs `bun src/screen-cli.ts /` and put `after: [screen]` on the steps that need it. Inspect the cache with `sqlite3 dist/cache.sqlite 'select * from reverse_refs'`.

## Layout

| Path | What |
| --- | --- |
| `root/yafi.yaml` | the manifest: workers, folders, schemas, pipelines |
| `yafidb.yaml`, `schemas/`, `plugins/` | deployment settings (storage, keys), JSON Schemas, sample write screk and build step |
| `src/manifest.ts` | parse and validate the manifest (overlap rules), folder rules, optional signing |
| `src/pipeline.ts` | the step runner: `after` dependencies, parallel where independent |
| `src/format.ts`, `jws.ts` | parse, verify, replay (checkpoint, patch, diff), dump block YAML; compact JWS, Ed25519 |
| `src/screen.ts`, `screen-cli.ts`, `quarantine.ts` | the screen tool and its quarantine: verify a file for its folder, log what is wrong with the quarantine worker, then overwrite (partial) or delete (whole) the original |
| `src/screens.ts`, `writer.ts` | the enforced screens on a new entry, in order; create and append with authority, run the screen tool first, sign, conditional write |
| `src/build.ts`, `site.ts`, `sqlite.ts` | build: find workers under a path, read the files, run build steps; the two default steps |
| `src/plugins.ts` | command and URL steps |
| `src/handler.ts`, `server.ts`, `worker.ts` | HTTP handler (Web APIs), Bun server (one handler per worker), Cloudflare Worker entry |
| `src/storage.ts`, `storage-local.ts` | storage interface: local (hash compare-and-swap), S3 (`If-Match`), R2 binding (`onlyIf`) |

## Decisions and gaps

- **Manifest location:** `/yafi.yaml` is a file in the root, read through the same storage as the records, so every worker sees one copy. It is excluded from record listings, and no worker owns it, so a write to it is refused. Deployment settings (storage location, keys) stay in `yafidb.yaml`, because they are not authority.
- **Authority:** a context acts as one worker. Every write screens that the path is in that worker's folders (nearest folder rule) and that the record uses the folder's schema. Workers read anywhere in the root. The demo shares one signing key across workers, so authority is enforced by the writer and by the screen tool's folder rule, not by a key per worker.
- **Signed payload:** header `{mode, iat, nonce, schema}`, where `mode` is the versioned `header@1.0.0`; entry `{mode, iat, data_hash, prev}`. `data_hash` is SHA-256 of the entry's canonical JSON; `prev` is the previous signature segment. `iat` is epoch seconds and must equal the line's time.
- **Manifest signing** is optional: `bun run sign-manifest` adds a last line `yafi: manifest <time> <jws>` over a hash of the text above it. A signature that fails always stops the worker, and `manifest.require_signature: true` also refuses an unsigned manifest. The committed manifest is unsigned, because the key is per machine.
- **Pipelines:** steps are a `command` (JSON on stdin), a `url` (JSON POST), or, for builds, a `builtin` (`relationship-cache`, `static-site`). A step runs once everything in its `after` has succeeded. Write screens fail fast; a build step that fails skips what follows it and the others finish. Only built-in steps see the records, read as they are. Command and URL build steps get `{name, root, path, in, out}` (also as `YAFI_ROOT`, `YAFI_IN`, `YAFI_OUT`) and read the files themselves.
- **Screen and quarantine:** only the screen tool quarantines. A file is wrong if its header version is not in `SUPPORTED_HEADERS` (exact text match), a signature or chain link fails, or its schema is not its folder's. A writer runs the screen on a file before writing, quarantines what is wrong, and refuses that write, so a retry succeeds. A file outside every worker folder is not screened.
- **Quarantine target:** the first folder whose schema is `quarantine@1`. One rule for both cases: the quarantine worker logs the problem data first, and only if that succeeds is the original overwritten (partial, conditional write) or, for a whole file, a plain delete is attempted and its result ignored, and then the caller gets 409 "retry". The record's path is `<flattened source>-<16 hex of SHA-256 of the logged text>.yaml`, so a repeat of the same bytes finds it and adds none. If the file is still there at the next screen, it is logged again and the delete is retried; a file that changed meanwhile is logged as new content. The manifest's `quarantine` steps run after the move, and their failure cannot undo it.
- **Builds read, they do not screen:** `parseFile` reads a file with no signature, chain or version checks, and stops at the first part that does not parse. The default steps and the sample `export-json` use it. A file with no readable header is skipped without a report.
- **Patch** is RFC 7386 merge patch (`null` deletes). **Diff** is a zero-context unified diff on a text field; text is line-based and ends with a newline.
- **Entry check:** a checkpoint must pass the schema; a patch is checked with `required` removed; the applied result must always pass.
- **References** are screened only in the new entry's data. Linking to a field of the current state without naming an entry (`#id//field`) is still open in the docs, so it is rejected.
- **Compare-and-swap:** local storage uses a lock file plus the file's SHA-256, so it is safe across processes on one machine. S3 and R2 use ETags. Deletes are plain. Of two simultaneous valid appends, one succeeds and the other gets 409 with nothing written; a success always means the entry is in the file. `test/races.test.ts` covers these. The S3 path is tested against a fake server, not a live bucket; the build tool reads local storage only.
- **Write screens** fail closed: a crash, bad reply or 5 s timeout rejects the write. Workers cannot spawn commands, so `worker.ts` supports URL screens only. `worker.ts` is tested with a fake R2 bucket, not deployed with wrangler.
- **Quarantine needs the signing key**, since the quarantine record is signed. Without one, the screen tool finds the problem and moves nothing, and a screen step fails.
- **Only `.yaml` files** are listed, so a stray non-YAML file in a worker folder is not seen. A file outside every worker folder is reported as unowned by the screen tool and left alone.
- **No keys in git:** `keys/`, `dist/` and everything in `root/` except the manifest are gitignored. Re-running `keygen --force` makes existing data unverifiable.
