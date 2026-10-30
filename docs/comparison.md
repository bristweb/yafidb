# How YafiDB compares

YafiDB keeps records in plain files, checks every write against a schema, and includes a small write API. Many other tools share one or two of those ideas. This page compares YafiDB with more than 50 of them so you can see where it fits and where another tool is the better pick.

A fair warning first. The columns below are the things YafiDB cares about, so YafiDB naturally scores well on them. A list built around query speed, transactions, or live collaboration would favor other tools. The section "What the columns leave out" covers that. YafiDB's row also describes the design, while every other row describes software you can use today.

Facts were checked on October 30, 2026. Products change, so follow the links before you decide. A `?` means I could not confirm the answer.

## How to read the tables

Each table has the same eight columns, and YafiDB is the first row of every table. Each column asks one question.

| Column | The question it asks |
| :-- | :-- |
| **Files** | Is your data kept in plain text files you can open and diff, such as YAML, JSON, Markdown, or CSV? |
| **Schema** | Is every write checked against a schema you define? |
| **Write API** | Does the tool ship an HTTP service that accepts record changes, so you do not build one? |
| **No server** | Can it run with nothing always on for you to operate, as a library or a serverless service? |
| **Free + FOSS** | Can you start at $0 and run it yourself under an open-source license? |
| **Portable** | Is the data in an open format that you can keep on storage you choose, with no lock-in? |
| **Tamper** | Does it help you detect edits to past records, with signatures or hash chains? |
| **Compile** | Can it build another database or a static site from the data? |

Each cell uses one symbol.

| Symbol | Meaning |
| :-: | :-- |
| ✅ | Yes, as a built-in feature |
| 🟡 | Partly. The note under the table says how |
| ❌ | No |
| ? | Not confirmed |
| — | Does not apply |

A few rules keep the symbols consistent:

- **Files:** 🟡 means the tool reads and writes plain files but its main store is something else. ❌ means the main store is binary or hosted. A database that can dump to text still gets ❌. Query engines that work on CSV or JSON files in place get ✅, even though they do not own the write path.
- **Schema:** 🟡 means the check runs only in the tool's own editor, only at build time, only for types, or only if you turn it on.
- **Write API:** 🟡 means a SQL or query endpoint, or a client library with its own protocol, but no ready-made record API.
- **Free + FOSS:** 🟡 means a free tier or free binaries, but the license is not open source or the paid plan is required for real use. ❌ means paid only or discontinued.
- **Tamper:** ✅ means built-in signatures or verification proofs. 🟡 means append-only or content-hashed history without signatures. Git history counts as 🟡 because anyone with write access can rewrite it.
- **Compile:** 🟡 means export or dump only.

## How YafiDB scores

YafiDB's ✅ marks are the design goals. Each one has a condition worth knowing.

- **Files:** records are YAML documents appended to files in object storage.
- **Schema:** the schema is mandatory and strict. The writer rejects any record that fails it.
- **Write API:** a small writer runs as a serverless function. You deploy it, but you do not write it.
- **No server:** the writer runs only when a change arrives. Reads go to files or a compiled output, so no server sits in the read path.
- **Free + FOSS:** the parts are free and open source. Storage and hosting have their own free tiers, which you may outgrow.
- **Portable:** any S3-compatible store works. Moving means copying files.
- **Tamper:** signing is always on for writer-made records. Hash chaining is optional per data type.
- **Compile:** a static site, SQLite, or another database can be rebuilt from the files at any time.

## The tables
### Query engines that read files

These tools run SQL over files in place. They are strong readers. None of them is a write service, and none checks records at write time.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Apache Drill](https://drill.apache.org) | ✅ | ❌ | 🟡 | 🟡 | ✅ | ✅ | ❌ | 🟡 |
| [DuckDB](https://duckdb.org) | ✅ | 🟡 | ❌ | ✅ | ✅ | ✅ | ❌ | 🟡 |
| [Trino / Presto](https://trino.io) | 🟡 | 🟡 | 🟡 | ❌ | ✅ | ✅ | ❌ | 🟡 |
| [Spark SQL](https://spark.apache.org/sql/) | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ❌ | 🟡 |
| [ClickHouse (clickhouse-local)](https://clickhouse.com/docs/operations/utilities/clickhouse-local) | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ❌ | 🟡 |
| [Polars](https://pola.rs) | ✅ | 🟡 | ❌ | ✅ | ✅ | ✅ | ❌ | 🟡 |

**Notes**

- **Apache Drill:** Schema-on-read. REST API runs queries only. `CREATE TABLE AS` writes new files, never edits old ones. Embedded mode runs without a cluster.
- **DuckDB:** In-process engine. Queries CSV, JSON, and Parquet in S3 directly. Types are enforced in its own tables, not in your files. `COPY TO` exports files.
- **Trino / Presto:** Distributed SQL engines. Mostly used on Parquet or ORC, with CSV and JSON supported. You run a cluster. Writes go through SQL.
- **Spark SQL:** Reads JSON and CSV natively. Local mode needs no cluster, but large jobs do. SQL endpoint only.
- **ClickHouse (clickhouse-local):** `clickhouse-local` queries files with no server. The full ClickHouse server adds an HTTP SQL interface.
- **Polars:** Fast data-frame library. Checks types in memory. Reads and writes CSV, JSON, and Parquet. No service.

### Table formats and lakehouse

These formats add schemas and transactions on top of data files in object storage. They are built for analytics at large scale. Records are stored as Parquet, which is not human-readable.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Apache Iceberg](https://iceberg.apache.org) | ❌ | ✅ | ❌ | 🟡 | ✅ | ✅ | ❌ | ❌ |
| [Delta Lake](https://delta.io) | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| [Apache Hudi](https://hudi.apache.org) | ❌ | ✅ | ❌ | 🟡 | ✅ | ✅ | ❌ | ❌ |
| [Lance](https://lance.org) | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| [DuckLake](https://ducklake.select) | ❌ | ✅ | ❌ | 🟡 | ✅ | ✅ | ❌ | ❌ |

**Notes**

- **Apache Iceberg:** Enforces the table schema on write. Needs a catalog, which can be as simple as a database file. Never edits data files in place.
- **Delta Lake:** Schema enforcement on write. The transaction log is JSON, but data files are Parquet. Libraries run without a server.
- **Apache Hudi:** Supports record-level upserts and deletes on files. Usually runs with Spark or Flink.
- **Lance:** Columnar format for machine-learning data, with versioned datasets. Arrow schema enforced. LanceDB is the database built on it.
- **DuckLake:** Parquet files plus a SQL database as the catalog. The catalog database is a server unless you use a file-based one.

### Git and file-based content tools

The closest relatives. They keep content in plain files and give you a schema, an editor, or both. Most are built for website content.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Decap CMS](https://decapcms.org) | ✅ | 🟡 | ❌ | 🟡 | ✅ | ✅ | 🟡 | 🟡 |
| [TinaCMS](https://tina.io) | ✅ | ? | ✅ | 🟡 | ✅ | ✅ | 🟡 | 🟡 |
| [Keystatic](https://keystatic.com) | ✅ | 🟡 | ❌ | 🟡 | ✅ | ✅ | 🟡 | 🟡 |
| [Contentlayer](https://contentlayer.dev) | ✅ | 🟡 | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| [Astro content collections](https://docs.astro.build/en/guides/content-collections/) | ✅ | 🟡 | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| [Dolt](https://github.com/dolthub/dolt) | 🟡 | ✅ | 🟡 | ❌ | ✅ | 🟡 | 🟡 | 🟡 |
| [Datasette](https://datasette.io) | 🟡 | 🟡 | ✅ | 🟡 | ✅ | ✅ | ❌ | 🟡 |
| [Flat Data / git scraping](https://githubnext.com/projects/flat-data) | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| [lowdb](https://github.com/typicode/lowdb) | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| [NeDB](https://github.com/louischatriot/nedb) | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| [TinyBase](https://tinybase.org) | 🟡 | 🟡 | ❌ | ✅ | ✅ | 🟡 | ❌ | 🟡 |
| [PocketBase](https://pocketbase.io) | ❌ | ✅ | ✅ | ❌ | ✅ | 🟡 | ❌ | 🟡 |
| [Do it yourself: files + JSON Schema in CI](https://json-schema.org) | ✅ | 🟡 | ❌ | ✅ | ✅ | ✅ | 🟡 | 🟡 |

**Notes**

- **Decap CMS:** Browser editor that commits Markdown, YAML, or JSON to Git. Field rules apply in the editor only. GitHub login needs a small OAuth helper. Your site generator does the build.
- **TinaCMS:** Git is the source of truth, with a GraphQL content API. Self-hosting needs a database such as MongoDB or Redis as an index. TinaCloud has a free plan.
- **Keystatic:** Typed fields defined in code, with a Git-backed editor, local or on GitHub. Rules apply in the editor only.
- **Contentlayer:** Turns content files into typed data at build time. No longer maintained. The community fork Contentlayer2 and Content Collections continue the idea.
- **Astro content collections:** Zod schemas check every content file when the site builds. Catches bad files before publishing, but not when they are written.
- **Dolt:** SQL database with Git-style branches and merges. History is content-hashed but not signed. You run a SQL server. Imports and exports CSV and JSON.
- **Datasette:** Publishes SQLite files with a web UI and JSON API. The JSON write API ships in its 1.0 alpha releases. Python server, which can run on serverless hosts.
- **Flat Data / git scraping:** A pattern: a scheduled GitHub Action fetches data and commits it. The Flat Data action is archived. No schema, no write API.
- **lowdb:** A JSON file as a database, for small projects. No schema checks. Rewrites the whole file on each save.
- **NeDB:** Embedded database that stores documents as lines of JSON. Its README says it is no longer maintained. Forks such as `@seald-io/nedb` continue it.
- **TinyBase:** Reactive in-memory store. Optional schemas. Can save to files, SQLite, and other backends.
- **PocketBase:** One Go binary with SQLite, typed collections, and a REST API. Needs a server and a disk. Its repository moved off GitHub in October 2026.
- **Do it yourself: files + JSON Schema in CI:** A folder of files, a schema, and a test that fails on bad records. Cheap and clear. Nothing checks writes until the test runs, and you build any API yourself.

### Embedded and serverless databases

These are the usual answer to a small app that needs no server of its own. They are databases first. The data is in a binary store, not readable files.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [SQLite](https://sqlite.org) | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | 🟡 |
| [Litestream](https://litestream.io) | ❌ | — | ❌ | 🟡 | ✅ | ✅ | ❌ | 🟡 |
| [LiteFS](https://fly.io/docs/litefs/) | ❌ | — | ❌ | ❌ | ✅ | 🟡 | ❌ | 🟡 |
| [libSQL / Turso](https://turso.tech) | ❌ | ✅ | 🟡 | ✅ | ✅ | ✅ | ❌ | 🟡 |
| [Cloudflare D1](https://developers.cloudflare.com/d1/) | ❌ | ✅ | 🟡 | ✅ | 🟡 | 🟡 | ❌ | 🟡 |
| [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) | ❌ | 🟡 | ❌ | ✅ | 🟡 | ❌ | ❌ | ❌ |
| [PGlite](https://pglite.dev) | ❌ | ✅ | ❌ | ✅ | ✅ | 🟡 | ❌ | 🟡 |
| [Neon](https://neon.com) | ❌ | ✅ | 🟡 | ✅ | ✅ | 🟡 | ❌ | 🟡 |
| [Supabase](https://supabase.com) | ❌ | ✅ | ✅ | 🟡 | ✅ | 🟡 | ❌ | 🟡 |
| [Firebase Firestore](https://firebase.google.com/docs/firestore) | ❌ | 🟡 | ✅ | ✅ | 🟡 | ❌ | ❌ | 🟡 |
| [PlanetScale](https://planetscale.com) | ❌ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ❌ | 🟡 |
| [MongoDB Atlas](https://www.mongodb.com/atlas) | ❌ | 🟡 | ❌ | 🟡 | 🟡 | 🟡 | ❌ | 🟡 |
| [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) | ❌ | 🟡 | ✅ | ✅ | 🟡 | ❌ | ❌ | 🟡 |
| [Fauna](https://github.com/fauna/faunadb) | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| [PostgreSQL (self-hosted)](https://www.postgresql.org) | ❌ | ✅ | ❌ | ❌ | ✅ | 🟡 | ❌ | 🟡 |
| [SlateDB](https://slatedb.io) | ❌ | ❌ | ❌ | ✅ | ✅ | 🟡 | ❌ | ❌ |

**Notes**

- **SQLite:** Strict tables and CHECK constraints enforce a schema. One portable file. `.dump` gives readable SQL text.
- **Litestream:** Streams SQLite changes to any S3 store, with point-in-time restore. Runs next to your app as a process.
- **LiteFS:** Replicates SQLite across machines. Runs as a process on each node and is built around Fly.io.
- **libSQL / Turso:** Open SQLite fork with HTTP access and embedded replicas. Turso has a free plan.
- **Cloudflare D1:** Serverless SQLite on Cloudflare, with a free tier. Closed service. You can export a SQL dump.
- **Cloudflare Durable Objects:** Per-key actors with storage. SQLite-backed ones are on the free plan. You write the code, so there is no ready-made write API. Runs only on Cloudflare.
- **PGlite:** Postgres compiled to run in a browser or Node. Persists to IndexedDB or the file system.
- **Neon:** Serverless Postgres that scales to zero. Free plan. SQL over HTTP. Open-source core.
- **Supabase:** Postgres with an auto-generated REST API. Open source, with a free plan.
- **Firebase Firestore:** Serverless document database with a free plan. Security rules can check shape. Closed service.
- **PlanetScale:** Managed MySQL-compatible and Postgres. No free plan, from $5 a month for a single-node Postgres. Vitess is open source.
- **MongoDB Atlas:** JSON Schema validation is optional. The Atlas Data API ended on September 30, 2025. Free M0 cluster. Server license is SSPL.
- **Amazon DynamoDB:** Serverless key-value and document store with an always-free tier. Only keys are typed. Exports to S3. AWS only.
- **Fauna:** The hosted service ended on May 30, 2025. An open-source release exists but is early, and I could not confirm its license.
- **PostgreSQL (self-hosted):** The standard baseline. Excellent schema and query power. You run it. A separate tool such as PostgREST adds an API.
- **SlateDB:** Embedded key-value engine that stores data in object storage, in its own format. A library, not a service.

### Ledgers and immutable stores

These focus on history that cannot be quietly changed. Several are better than YafiDB at proof and at throughput.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [immudb](https://immudb.io) | ❌ | 🟡 | ✅ | ❌ | 🟡 | 🟡 | ✅ | ? |
| [TigerBeetle](https://tigerbeetle.com) | ❌ | ✅ | 🟡 | ❌ | ✅ | 🟡 | 🟡 | ? |
| [Amazon QLDB](https://docs.aws.amazon.com/qldb/latest/developerguide/getting-started-next-steps.html) | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | 🟡 |
| [Datomic](https://www.datomic.com) | ❌ | ✅ | 🟡 | ❌ | 🟡 | 🟡 | 🟡 | ❌ |
| [XTDB](https://xtdb.com) | ❌ | ? | ✅ | ❌ | ✅ | 🟡 | 🟡 | ❌ |
| [KurrentDB (EventStoreDB)](https://www.kurrent.io) | ❌ | ❌ | ✅ | ❌ | 🟡 | 🟡 | 🟡 | 🟡 |
| [Apache Kafka](https://kafka.apache.org) | ❌ | ❌ | 🟡 | ❌ | ✅ | 🟡 | 🟡 | 🟡 |

**Notes**

- **immudb:** Built-in cryptographic verification of every entry. Source-available under the Business Source License, free for most production use.
- **TigerBeetle:** Purpose-built for financial transactions at very high speed. Fixed account and transfer schema. Checksummed log. You run a cluster.
- **Amazon QLDB:** Deprecated. Support ended on July 31, 2025. It had cryptographic verification but did not enforce document structure.
- **Datomic:** Immutable facts with full history. Binaries are free under Apache 2.0, but the source is closed. No signatures.
- **XTDB:** Immutable, bitemporal SQL database. Open source under MPL-2.0. History is kept, not signed.
- **KurrentDB (EventStoreDB):** Event store, renamed from EventStoreDB. Append-only. Kurrent License v1 forbids offering it as a hosted service. Projections build read models.
- **Apache Kafka:** Append-only distributed log. Clients use its own protocol. Kafka Connect can copy data to other systems. Built for streams, not for stored records.

### Local-first and sync

These keep data on the device and sync it. Their strength is offline work and live collaboration, which YafiDB does not try to offer.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [CouchDB / PouchDB](https://couchdb.apache.org) | ❌ | 🟡 | ✅ | 🟡 | ✅ | 🟡 | ❌ | 🟡 |
| [Electric SQL](https://electric-sql.com) | ❌ | ✅ | ❌ | ❌ | ✅ | 🟡 | ❌ | 🟡 |
| [RxDB](https://rxdb.info) | ❌ | ✅ | ❌ | ✅ | ✅ | 🟡 | ❌ | 🟡 |
| [Automerge](https://automerge.org) | ❌ | ❌ | ❌ | ✅ | ✅ | 🟡 | 🟡 | 🟡 |

**Notes**

- **CouchDB / PouchDB:** HTTP document database with replication. Validation is JavaScript you write. PouchDB runs in the browser and syncs with CouchDB.
- **Electric SQL:** Syncs Postgres data to clients. Reads only. Writes go through your own backend.
- **RxDB:** Local-first database for apps. Requires a JSON Schema per collection. Core is Apache 2.0. Some plugins are paid.
- **Automerge:** Data type for merging edits from many people. Changes are linked by hash. No schema. Binary format.

### Spreadsheets and no-code databases

These win on ease for people who do not write code. They are hosted or server-based products.

| Tool | Files | Schema | Write API | No server | Free + FOSS | Portable | Tamper | Compile |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **YafiDB** (design) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| [Airtable](https://airtable.com) | ❌ | 🟡 | ✅ | ✅ | 🟡 | ❌ | ❌ | 🟡 |
| [Google Sheets](https://workspace.google.com/products/sheets/) | ❌ | ❌ | ✅ | ✅ | 🟡 | ❌ | ❌ | 🟡 |
| [NocoDB](https://nocodb.com) | ❌ | 🟡 | ✅ | ❌ | 🟡 | 🟡 | ❌ | 🟡 |
| [Baserow](https://baserow.io) | ❌ | 🟡 | ✅ | ❌ | ✅ | 🟡 | ❌ | 🟡 |

**Notes**

- **Airtable:** Typed fields and a REST API. Free plan. Closed. Exports CSV.
- **Google Sheets:** Cell validation rules apply to typing in the UI. API writes are not checked by them. Free with an account. Exports CSV.
- **NocoDB:** Spreadsheet-style UI over your own SQL database. Sustainable Use License, which is source-available, not open source.
- **Baserow:** No-code database with a REST API. Core is MIT. Premium and enterprise features are under separate licenses.

## What the columns leave out

The columns above favor YafiDB's goals. These are the things they do not measure, and YafiDB is weaker on most of them.

- **Query power.** The files alone answer simple reads. Joins, aggregates, and search need a compiled database such as SQLite or DuckDB.
- **Transactions.** A write changes one record in one file. Changes that must succeed together across many records are a harder fit.
- **Write volume.** Every write rewrites a small file in object storage, and request costs grow with write frequency. Rollover to new files keeps each file small, but it does not make YafiDB a stream processor.
- **Freshness.** Reads from a compiled output can trail writes by a few seconds.
- **Real-time and offline collaboration.** Tools such as Automerge, RxDB, and Electric SQL are built for this. YafiDB is not.
- **Maturity.** Every other tool here has users and a track record. YafiDB is a design.
- **Tooling.** Dashboards, drivers, and hosting support for the others are far ahead.

## When to pick something else

Choose the other tool when its strength matches your main need.

| If your main need is... | Look at |
| :-- | :-- |
| Fast analytics over large files | DuckDB, ClickHouse, Trino, or Iceberg and Delta Lake for very large tables |
| A relational app with joins and transactions | PostgreSQL, Neon, Supabase, or SQLite |
| A blog or docs site edited by people in a browser | Decap CMS, Keystatic, TinaCMS, or Astro content collections |
| Live collaboration or offline-first apps | Automerge, RxDB, CouchDB, or Electric SQL |
| High-volume events or logs | Kafka, or KurrentDB for event sourcing |
| Money movement at very high speed | TigerBeetle |
| Verified history today, with proofs you can check | immudb |
| A spreadsheet that non-coders edit | Airtable, Google Sheets, NocoDB, or Baserow |
| A small private app with one server and an API | PocketBase |
| Files you validate yourself and no write service | Files with JSON Schema in CI |

YafiDB is a fit when you want records that people and AI agents can read as files, strict checking on every write, a write API you do not build, signed history, and a $0 start with no lock-in. See [prior-art.md](prior-art.md) for related projects and [tradeoffs.md](tradeoffs.md) for the costs.

## Items not confirmed

- **TinaCMS, Schema:** I could not confirm whether data is checked against its schema on every write or only when you build.
- **XTDB, Schema:** I could not confirm how strict schemas are in the current version.
- **immudb, Compile:** I could not confirm a built-in export path.
- **TigerBeetle, Compile:** I could not confirm a built-in export path. Check its change-data-capture option.
- **Fauna, license:** the open-source release states "available under license", and I could not read the terms.
