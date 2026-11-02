# YafiDB demo

A working, zero-cost demo of the [record format](../docs/record-format.md) in TypeScript on Bun: a file-format library, a writer that enforces the checks, and a build tool that makes a static site and a SQLite cache. Dependencies: `yaml` and `@cfworker/json-schema` only. Signing uses WebCrypto Ed25519.

## Run it

```sh
bun install
bun run keygen     # keys/private.jwk.json (secret, gitignored) + keys/public.jwks.json
bun run seed       # writes data/: customer alice and the README's order 1042, through the real writer
bun run build      # verifies data/, quarantines bad tails, writes dist/ (site) and dist/cache.sqlite
bun run serve      # writer on :8787, accepts POST only (set YAFI_TOKEN to require a bearer token)
bun test           # 20 tests
```

Open `dist/index.html`. Try the writer:

```sh
curl -XPOST localhost:8787/entries -d '{"path":"/order/1042/2026.yaml","mode":"patch","data":{"note":"Thanks!"}}'
```

Endpoints: `POST /records` with `{path, record_schema, data}`, and `POST /entries` with `{path, mode, data}`. A rejected write returns 4xx with `{error, check}` where `check` is `existing`, `entry`, `relationships`, `plugin` or `write`. Nothing is written on any failure.

To see quarantine: append `---\nstatus: refunded\nyafi: patch 2026-11-01T20:12:09Z a.b.c` to `data/order/1042/2026.yaml` and run `bun run build`. The tail moves to `data/quarantine/`, and the order verifies again. Inspect the cache with `sqlite3 dist/cache.sqlite 'select * from reverse_refs'`.

## Layout

| Path | What |
| --- | --- |
| `src/format.ts` | parse, verify, replay (checkpoint, patch, diff), dump block YAML |
| `src/jws.ts` | compact JWS, Ed25519 |
| `src/checks.ts` | the enforced checks, in order |
| `src/writer.ts` | create and append: checks, sign, conditional write |
| `src/handler.ts`, `server.ts`, `worker.ts` | HTTP handler (Web APIs), Bun server, Cloudflare Worker entry |
| `src/storage.ts`, `storage-local.ts` | storage interface: local (hash compare-and-swap), S3 (`If-Match`), R2 binding (`onlyIf`) |
| `src/build.ts`, `site.ts`, `sqlite.ts`, `quarantine.ts` | build tool and outputs |
| `yafidb.yaml`, `schemas/`, `plugins/` | config, JSON Schemas, sample plugged-in check |

## Decisions and gaps

- **Signed payload:** header `{mode, iat, nonce, yafi_schema, record_schema}`; entry `{mode, iat, data_hash, prev}`. `data_hash` is SHA-256 of the entry's canonical JSON; `prev` is the previous signature segment. `iat` is epoch seconds and must equal the line's time.
- **Patch** is RFC 7386 merge patch (`null` deletes). **Diff** is a zero-context unified diff on a text field; text is line-based and ends with a newline.
- **Entry check:** a checkpoint must pass the schema; a patch is checked with `required` removed; the applied result must always pass.
- **References** are checked only in the new entry's data. Linking to a field of the current state without naming an entry (`#id//field`) is still open in the docs, so it is rejected.
- **Folder rule (demo only):** `order@1` records must live under `/order/`.
- **Compare-and-swap:** local storage uses a lock file plus the file's SHA-256, so it is safe across processes on one machine. S3 and R2 use ETags. The S3 path is tested against a fake server, not a live bucket; the build tool reads local storage only.
- **Plugged-in checks** fail closed: a crash, bad reply or 5 s timeout rejects the write. Workers cannot spawn commands, so `worker.ts` supports URL checks only. `worker.ts` is tested with a fake R2 bucket, not deployed with wrangler.
- **Quarantine** needs the signing key, since the quarantine record is signed. Without one, the build still trusts only the valid prefix but moves nothing. A file whose header fails is reported unusable and left alone.
- **No keys in git:** `keys/`, `data/` and `dist/` are gitignored. Re-running `keygen --force` makes existing data unverifiable.
