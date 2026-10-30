# Prior art

This document lists related projects, what each one shows, and how this design differs. Each link was checked when this document was written.

## Summary of the difference

No project found combines all of these: **readable, appendable YAML records**, **per-record hash chaining and signing**, **stateless per-account owner writers**, **any S3-compatible bucket**, and **free and open-source software only**. Each project below covers part of that.

## Tamper-evident logs and ledgers

| Project | What it is | What we take from it |
| --- | --- | --- |
| [Stackbilt audit-chain](https://github.com/Stackbilt-dev/audit-chain) | Tamper-evident audit trail for Cloudflare Workers, using SHA-256 hash chaining with R2 and D1 | Closest in deployment: hash chain on R2 from Workers. It uses D1 for the index |
| [Byspec ledger](https://byspec.ai/docs/ledger/) | Append-only JSONL ledger with `prev_hash`, SHA-256, and optional Ed25519 signatures kept outside the hashed payload | Signature outside the hashed payload, trusted-key fingerprints, offline verification |
| [GoLogX](https://github.com/AyoubTadlaoui/GoLogX) | Go `slog` handler writing hash-chained, Ed25519-signed entries | Simple entry shape (`seq`, `prev`, `hash`, `sig`) and the note that end-truncation needs an external head-hash anchor |
| [Ledger-Kernel](https://github.com/flyingrobots/ledger-kernel) | A specification for Git-native append-only ledgers with deterministic replay and signed entries | Its invariants: append-only, deterministic replay, authenticated entries. It uses Git as storage, which this design chose not to do |

## Transparency logs

These systems publish large append-only logs as static files, which is the same idea as chains in a bucket.

| Project | What it is |
| --- | --- |
| [Sunlight](https://github.com/FiloSottile/sunlight) | A certificate transparency log that serves tiles as static files |
| [Tessera](https://github.com/transparency-dev/tessera) | A Go library for building transparency logs on cloud storage |
| [tlog-tiles](https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md) | The specification for serving a transparency log as static tiles |
| [Cloudflare Azul](https://blog.cloudflare.com/azul-certificate-transparency-log/) | Cloudflare's certificate transparency log built on Workers, Durable Objects, and R2 |
| [Sigstore Rekor v2](https://blog.sigstore.dev/rekor-v2-ga/) | A tile-based transparency log for software signing |

Lesson: object storage with conditional writes and a single sequencer per log works at very large scale. Those logs hold a Merkle tree for public proofs. This design uses a simpler hash chain per account because the audience is the account holder and an auditor, not the public.

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

These provide the per-account owner.

## Standards used

- [JSON Schema](https://json-schema.org)
- [CEL specification](https://github.com/google/cel-spec), with the [cel-go](https://github.com/google/cel-go) implementation and the [CEL site](https://cel.dev)
- [YAML 1.2](https://yaml.org/spec/1.2.2/)
- [Ed25519](https://ed25519.cr.yp.to/)
- [Hono](https://hono.dev)

## What is different here

The closest cousins are audit-chain on R2 and the transparency-log family. This design differs in four ways:

1. **Records are readable and appendable YAML,** not JSON lines or binary tiles.
2. **Integrity is per record and per data type,** with optional user signatures on top of the worker's.
3. **Writers are stateless, per-account owners** that wake per request, and cross-account actions are sagas.
4. **It runs on any S3-compatible bucket with free and open-source parts only,** with the derived query databases rebuildable from the chains.
