# Prior art

This document lists related projects, what each one shows, and how this design differs. Each link was checked when this document was written.

## Summary of the difference

No project found combines all of these: **readable, appendable record files**, **thin writers that only validate, sign, and append**, **derived outputs of any kind rebuilt from the files**, **any object storage**, **signing with optional hash chaining**, and **free and open-source software only**. Each project below covers part of that.

## Tamper-evident logs and ledgers

| Project | What it is | What we take from it |
| --- | --- | --- |
| [Stackbilt audit-chain](https://github.com/Stackbilt-dev/audit-chain) | Tamper-evident audit trail for Cloudflare Workers, using SHA-256 hash chaining with R2 and D1 | Closest in deployment: hash chain on R2 from Workers. It uses D1 for the index |
| [Byspec ledger](https://byspec.ai/docs/ledger/) | Append-only JSONL ledger with `prev_hash`, SHA-256, and optional Ed25519 signatures kept outside the hashed payload | Signature outside the hashed payload, trusted-key fingerprints, offline verification |
| [GoLogX](https://github.com/AyoubTadlaoui/GoLogX) | Go `slog` handler writing hash-chained, Ed25519-signed entries | Simple entry shape (`seq`, `prev`, `hash`, `sig`) and the note that end-truncation needs an external head-hash anchor |
| [Ledger-Kernel](https://github.com/flyingrobots/ledger-kernel) | A specification for Git-native append-only ledgers with deterministic replay and signed entries | Its invariants: append-only, deterministic replay, authenticated entries. It uses Git as storage. This design uses Git storage only for Git-only sites, which change rarely |

## Transparency logs

These systems publish large append-only logs as static files, which is the same idea as chains in a bucket.

| Project | What it is |
| --- | --- |
| [Sunlight](https://github.com/FiloSottile/sunlight) | A certificate transparency log that serves tiles as static files |
| [Tessera](https://github.com/transparency-dev/tessera) | A Go library for building transparency logs on cloud storage |
| [tlog-tiles](https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md) | The specification for serving a transparency log as static tiles |
| [Cloudflare Azul](https://blog.cloudflare.com/azul-certificate-transparency-log/) | Cloudflare's certificate transparency log built on Workers, Durable Objects, and R2 |
| [Sigstore Rekor v2](https://blog.sigstore.dev/rekor-v2-ga/) | A tile-based transparency log for software signing |

Lesson: object storage with conditional writes and a single sequencer per log works at very large scale. Those logs hold a Merkle tree for public proofs. Chaining in this design is optional per data type and simpler: a hash chain, because the audience is the data's owner and an auditor, not the public.

## Peer-to-peer append-only logs

| Project | What it is |
| --- | --- |
| [Hypercore](https://github.com/holepunchto/hypercore) | A signed, append-only log for peer-to-peer replication |

Lesson: a log signed by one writer with a public key is a proven shape.

## Object storage as a database

| Project | What it is |
| --- | --- |
| [unstorage](https://unstorage.unjs.io) | A key-value abstraction over many storage backends, including S3-compatible ones |
| [s3db.js](https://github.com/forattini-dev/s3db.js) | Uses AWS S3 as a cheap document database |
| [SlateDB](https://slatedb.io) | An embedded storage engine built on object storage |
| [Litestream](https://github.com/benbjohnson/litestream) | Streams SQLite changes to object storage |
| [DuckLake](https://ducklake.select) | An open table format with a SQL catalog over Parquet files |

Lesson: object stores can carry real data with the right write batching. None of these keeps human-readable, per-record signed history.

## Content-managed and versioned data

| Project | What it is |
| --- | --- |
| [Keystatic](https://keystatic.com), [Decap CMS](https://decapcms.org), [TinaCMS](https://tina.io) | Git-backed content editing over Markdown, YAML, and JSON files |
| [Dolt](https://github.com/dolthub/dolt) | A SQL database with Git-style versioning |
| [immudb](https://github.com/codenotary/immudb) | An immutable database with cryptographic verification |

Lesson: readable files with a schema are a good authoring format (the CMS projects). Dolt and immudb give versioned or verifiable data, but as a server you run.

## Actor runtimes

| Project | What it is |
| --- | --- |
| [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) | Per-key single-threaded actors that wake on request |
| [celld](https://celld.dev/) | A self-hostable runtime for the same per-key actor model |

These are candidates for write coordination, which is still an open design decision. Sagas are the proposed direction. Owners on these runtimes are one option under consideration.

## Standards used

- [JSON Schema](https://json-schema.org)
- [CEL specification](https://github.com/google/cel-spec), with the [cel-go](https://github.com/google/cel-go) implementation and the [CEL site](https://cel.dev)
- [YAML 1.2](https://yaml.org/spec/1.2.2/)
- [RFC 7515](https://www.rfc-editor.org/info/rfc7515), JSON Web Signature (JWS): the signature format
- [RFC 7517](https://www.rfc-editor.org/info/rfc7517), JSON Web Key (JWK): public keys and key sets
- [RFC 8037](https://www.rfc-editor.org/info/rfc8037), OKP key types for JOSE: Ed25519 keys
- [RFC 8785](https://www.rfc-editor.org/info/rfc8785), JSON Canonicalization Scheme (JCS): the bytes that are signed
- [RFC 9864](https://www.rfc-editor.org/info/rfc9864), Fully-Specified Algorithms for JOSE: the `Ed25519` algorithm name
- [Ed25519](https://ed25519.cr.yp.to/)
- [Hono](https://hono.dev)

## What is different here

The closest cousins are audit-chain on R2 and the transparency-log family. This design differs in four ways:

1. **Records are readable and appendable files,** YAML today, not JSON lines or binary tiles. Each data type's schema sets the record format.
2. **Writers are thin.** They only validate, sign, and append. Queries come from derived outputs of any kind that can be rebuilt from the files, or from the files directly.
3. **Signing is per record, and chaining is optional per data type.** The writer signs every record, and users can add their own signatures on top. Write coordination is still open, and sagas are the proposed direction for cross-account actions.
4. **It runs on any object storage with free and open-source parts only.**
