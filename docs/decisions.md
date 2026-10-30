# Decision log

This log records each decision, the alternatives that were considered and rejected, and the reason. Each entry stands alone, so you can read only the one you care about.

## Summary

| # | Decision | Chosen | Main rejected alternative |
| --- | --- | --- | --- |
| 1 | Storage backend | Any object storage. Git for Git-only sites. Git as a storage backend beyond those sites is an open question | Git as the only backend |
| 2 | Record format | Append-only multi-document YAML, set per data type by its schema (today) | A relational database |
| 3 | Integrity | The writer signs every record (Ed25519 by default). Chaining is off by default and set per data type | Always-on chaining, or none |
| 4 | Schema language | JSON Schema plus CEL | HyperFormula, custom language, SQL, formulas.ts |
| 5 | Where formulas live | On each schema | One shared formulas file |
| 6 | Write coordination | Open, not configurable. Owners are one option under consideration | Central worker, 2PC |
| 7 | Cross-account actions | Proposed: sagas with a shared transaction ID. Not decided | Single-record transfers, 2PC |
| 8 | Queue storage | A bucket in object storage (R2, S3, or another S3-compatible store) | A key-value store |
| 9 | API | Hono REST first | GraphQL first |
| 10 | Official calculation | Signed, pinned CEL, run by the writer or the build | Trust client results |
| 11 | Schema migration | New files with a signed genesis record | Rewriting history |
| 12 | Privacy deletion | Per-user encryption keys | Deleting bytes |
| 13 | Core idea | Readable files as truth, any database derived from them | Defining the system as one chain per entity |
| 14 | Record format | Set per data type by its schema, YAML first | Hard-wiring YAML |
| 15 | Core goals | Easy for AI, low cost, scale when needed, composable | A fixed storage and database stack |
| 16 | Composition | Configurable parts chosen in one config, with defaults and templates | A fixed stack, or a single bundled backend |
| 17 | Static site | Static site with optional workers. Git-only publishing for rarely changed sites | None recorded |
| 18 | Fully static first | No servers, small risk surface, static reads | Self-hosted servers in the default path |
| 19 | Writer | Minimal write API: accepts writes only, validates, signs, and appends | A writer that also serves reads |
| 20 | Language and runtime | TypeScript or JavaScript on Node or Bun, as serverless functions | Rust, which needs a separate server to run |
| 21 | Reserved `yafi` field | User fields at the top level, `yafi` reserved, duplicate keys rejected | A `data:` wrapper, or an `id` field |
| 22 | Signature format | JOSE (RFC 7515) with Ed25519 (`alg` `Ed25519`, RFC 9864) | Invented signature fields, plain SHA-256 |
| 23 | Write coordination | Open, not configurable. Sagas proposed, owners under consideration | Central worker, 2PC |

## 1. Storage backend: any object storage

**Status:** open for sites beyond Git-only sites. Whether Git is a storage backend for them is under reconsideration. See [Open questions](#open-questions).

**Chosen:** the readable files are the source of truth, kept in any object storage, such as Amazon S3 or Cloudflare R2. Git-only sites keep the records in a Git repository, with no writer (see decision 17). The files are the same in both.

**Rejected:** git as the only backend. An earlier version of this decision dropped git entirely. Git is now kept for Git-only sites. Decision 16 makes storage a configurable part. Whether Git is also a storage backend for other sites is an open question.

**Why:** git is free, keeps history, supports pull request review, and is easy for AI agents to work in, so it is the cheapest start for a Git-only site. It is a poor fit for many concurrent writers, because writes are whole-repository commits and there is no per-account serialization, and repository size can grow without bound. Object storage keeps the files in a form any tool can read. Signatures show who wrote a record and whether it changed, and chaining also detects deleted or reordered records (decisions 3 and 22). Git is also still used for code and schema files.

## 2. Record format: append-only YAML today

**Chosen:** multi-document YAML (`---` separators) with freeform Markdown in `|` block scalars. Each record is appended to the end of its file. A file has no header document and no format key. Each data type's schema sets the record format (see decision 14).

**Why:** a person can read it, diff it, and export it. Block scalars carry Markdown, JSON, YAML, and code without escaping. Export for a user is handing them their file. YAML is the current format. Another format can be set for a data type later, through its schema (see decisions 14 and 16).

## 3. The writer signs every record, and chaining is optional per data type

**Chosen:** the writer signs every record it writes, with Ed25519 by default (see decision 22). Chaining adds `prev`, a hash of the previous record. It is off by default and can be turned on per data type. A user may also sign their own entry.

**Why:** ledgers need strong history, while high-volume low-value types should not pay the cost. A per-record signature cannot detect a deleted or reordered record, so chaining is needed for that. The signing key is kept apart from storage credentials, so storage access alone cannot forge signed records.

## 4. Schemas: JSON Schema plus CEL

**Chosen:** JSON Schema for fields and CEL for derived values (`x-computed`) and optional cross-field checks (`x-validate`). Schema enforcement is mandatory and strict: every record must pass its schema before it is written (see [How a write is validated](design.md#how-a-write-is-validated)). The engineer chooses how to write the schema: the JSON Schema, plus optional CEL computed values and extra CEL checks. Schemas are language-neutral (see decision 20).

**Rejected, in the order they came up:**

- **HyperFormula (spreadsheet engine).** It was suggested without agreement. The requirement was client-side JavaScript, not a particular spreadsheet library.
- **Formulas built into the API code.** Simplest, but the goal was spreadsheet-like ease of changing a formula, and a code deploy for each change is not that.
- **Custom language.** Inventing a language adds a thing to design, secure, and document, when a standard exists.
- **SQL inside schemas.** Rejected in favour of a neutral expression language.
- **A separate `formulas.ts` file.** Editing is easy, but the formulas sit apart from the schemas they belong to, and finding one means searching "an ocean of unrelated formulas".
- **JSON Logic.** Safe and cross-language, but hard to read beyond simple math.
- **Making schema checking optional.** Every record must pass its JSON Schema. CEL computed values and extra checks are optional, and the engineer chooses them.

**Why CEL:** it is a standard with mature implementations in many languages. It is sandboxed by design, always finishes, and is type-checked before it runs.

## 5. Formulas live on their schema

**Chosen:** each formula sits on the schema it belongs to.

**Why:** opening a schema shows its fields and math together, like a spreadsheet column carries its formula, with no separate file to search.

## 6. Write coordination: owners are one option under consideration

**Status:** open. Write coordination is not configurable, and no option is chosen. Sagas (decision 7) are the proposed direction. See decision 23.

**Under consideration:** one owner per account, a Durable Object-style actor that is the only writer for that account. Owners could run on Cloudflare Durable Objects, or on celld. celld is self-hosted and conflicts with the no-servers goal (decision 18).

**Rejected:** a central transfer worker that handles all transfers.

**Why:** a central worker would be one very busy component handling every user's traffic. An owner per account would spread load, and owners for idle accounts cost nothing. Busy accounts can split into sub-accounts. These points are why owners are still considered. They do not settle the choice.

## 7. Cross-account actions: sagas are the proposed direction

**Status:** proposed, not decided. Not configurable.

**Proposed:** cross-account actions as sagas (pending, apply, confirm or reverse), tied by a shared transaction ID.

**Rejected:**

- **Single-record-only transfers.** One record for the whole transfer cannot half-apply, but it leaves no authoritative transaction record on each account. Each account's record should be auditable on its own.
- **Two-phase commit.** It gives true all-or-nothing but is slow and complex, can deadlock, and a coordinator crash leaves participants locked. Sagas cover the same cases.

## 8. Queue in a bucket, not a key-value store

**Chosen:** the write queue lives in object storage, such as R2 or another S3-compatible store.

**Why:** it is portable across providers and strongly consistent. A key-value store would be cheaper for some uses but ties the design to one vendor's service and may only be eventually consistent.

## 9. Hono REST first, GraphQL later

**Chosen:** for the TypeScript writer, a Hono API with REST generated from the schemas. The writer accepts writes only (see decision 19). Every implementation must enforce the same schemas. GraphQL may be added later as a read layer, separate from the writer.

**Why:** Hono runs on Node, Bun, and serverless hosts such as Cloudflare Workers. REST is simple and caches by address. GraphQL is possible but adds batching, depth limits, and caching work that is not needed first.

## 10. Official results are computed by the writer or the build

**Chosen:** official values come from a signed, pinned, mature CEL implementation, run by the writer or the build. Client-side JavaScript may evaluate CEL for display. See the open questions on where official values are computed.

**Why:** clients can fake what they display to themselves, so display needs no extra trust. Differences between implementations would be a defect in an implementation, not a design risk, so a pinned implementation is a sufficient recommendation.

## 11. Schema migration starts new files

**Chosen:** a migration creates new files. With chaining on, the first record is a signed genesis record whose `prev` names the old chain's last hash. The migration script is deterministic and reproducible. Records carry a schema version (`yafi.schema`).

**Why:** old history is never rewritten, and anyone can reproduce the migration.

## 12. Privacy deletion through encryption keys

**Chosen:** personal data is stored encrypted with a per-user key. Deleting a user destroys the key (crypto-shredding).

**Why:** an immutable log cannot delete bytes, but unreadable bytes are as good as deleted.

## 13. Readable files are the truth, and any database is derived

**Chosen:** the source of truth is a set of human-readable files in any object storage. Writers do the minimum work: validate, sign, and append. A compile step turns the files into any derived output, such as a database engine, and each derived output is rebuildable. Signing is on for every writer record. Chaining is optional per data type. Write coordination is an open decision (decision 23).

**Rejected:** defining the system as one append-only chain per account or entity, with a per-account owner as a required part.

**Why:** the main goal is to remove CPU and server overhead and to keep everything as human-readable files. Scale then comes from deriving a database from the files, so the same design serves a trivial weekend project, personal accounting, banking, and very large systems. Requiring owners and chains for every use would add cost that small uses do not need.

## 14. The record format is set per data type, and YAML is the first format

**Chosen:** all records are YAML today. Each data type's schema sets its record format with the keyword `x-format`, for example `x-format: yaml/1`. Files do not declare their own format. Each schema version pins the record format, so the signature covers it. Another format can be added later if someone builds it. Switching a data type to another format is a migration, the same pattern as a schema migration (decision 11). Old records stay readable under the schema version that wrote them.

**Rejected:** hard-wiring YAML into every part of the system.

**Why:** YAML fits today for human readability, comments, appendable multi-document files, Markdown in `|` blocks without escaping, and universal parsers. The best format may change over the life of the data, and a format set per schema keeps that change small.

## 15. Core goals: easy for AI, low cost, scale when needed, composable

**Chosen:** YafiDB ("Yet Another File Database", a nod to YAML files) is built around five goals, in this order. Decision 18 covers the first.

1. **Fully static, with no servers and a small risk surface.** See decision 18.
2. **Easy for AI agents to start.** A project is files plus schemas that an AI can generate and read, with no infrastructure to provision.
3. **Low cost.** Small projects aim to cost nothing to run or to leave idle.
4. **Scale when needed.** Deriving a database for heavy queries is optional, and you choose the engine.
5. **Composable.** Most parts, from storage to schema language, can be chosen to fit the infrastructure of each application. An earlier wording of this goal was "pluggable storage by stage", with files moving from a git repository to S3-compatible storage. Git as storage is now an open question (decision 1).

**Rejected:** a fixed storage and database stack that every project must provision.

**Why:** these goals come from the owner. Files plus schemas are something an AI can write without setting up servers, so starting is fast and free. Scale is added later by choosing a database, not by rewriting data.

## 16. Composable configuration: configurable parts, defaults, and templates

**Chosen:** YafiDB reads and writes the files and makes sure they are structured properly, which is what turns files into a database. Each configurable part is chosen in one configuration file (illustratively `yafidb.yaml`):

- **Record format:** set per data type by its schema. YAML today.
- **Storage:** any object storage. Git, for Git-only sites.
- **Schema language:** JSON Schema, with CEL for computed values.
- **Signing:** Ed25519 by default. Other JOSE algorithms.
- **Chaining:** off by default. On per data type.
- **Derived output:** none by default. A static site, SQLite, a scalable database, or another format.
- **Where the writer runs:** a serverless function. Another serverless host, or none for Git-only sites.

Write coordination is not configurable. It is an open decision (see decision 23). Schemas are not optional: every data type has one.

**Defaults** are YAML for the record format, any object storage for storage, no derived output, Ed25519 signing, and chaining off. **Templates** prefill the storage, record format, and derived output parts, for example `s3+yaml+none` and `s3+yaml+sqlite` (names illustrative). A user can start from a template or change any part. More options may be added later. This decision neither promises nor rules them out.

**Plug-in interfaces** are defined at the interface level only. A record format provides a name and version, reads bytes into records, writes records into bytes, and can add records to a file. A storage backend lists files, reads a file, and writes a file. A compile step names its engine and output, can rebuild from scratch, and never changes the files.

**Git** as a storage backend, beyond Git-only sites, is an open question (see decision 1). Git-only sites keep the records in Git, with no writer (see decision 17).

**Rejected:** a fixed stack that every project must use, and a single bundled storage or database.

**Why:** the owner's direction is that everything is composable and files act as the database. Choosing parts lets a project start free and simple, then change one without changing the files. This builds on decision 1 (storage), decision 14 (record format), and decision 15 (goals). Config key names and template names are illustrative and may change.

## 17. Static site with optional workers, and Git-only publishing for rarely changed sites

**Chosen:** a key use is a static website, built from the records by a compile step. The default shape is a static site with optional workers. Most of the site is static files that any web host can serve. A minimal write API, run as a few small workers, accepts changes such as form submissions. Each one validates the record, signs it, and writes it to storage. The site is then rebuilt and redeployed. Visitors never reach the workers.

Git-only publishing is adopted for sites that change rarely. The records are YAML files in a Git repository. The author creates and edits them with a local YafiDB tool, which checks each record against its schema. A build runs as a test in the repository, so a bad record fails it. The Git host (GitHub, GitLab, or similar) builds and publishes the site on each push. No write API runs.

The build can run in CI, or YafiDB can commit the generated site to a publish repository. See [Static site](static-site.md).

**Why:** a static site needs no server for visitors, which keeps cost low and the site fast. Git-only publishing adds no write surface beyond the Git host, but every change is a commit, so it suits sites that change rarely. Git history shows who changed what. Authorship is verified only when commits are signed.

## 18. Fully static first, with no servers and a small risk surface

**Chosen:** this is the first goal. Nothing runs unless a request arrives, so there is no server to maintain, secure, or patch. Reads are plain static files. Writes, if a project needs them, go through the minimal write API (decision 19), which accepts only records that pass their schema. Visitors never reach it, so the system is static again.

**Rejected:** self-hosted servers in the default path, such as celld. They conflict with this goal.

**Why:** fewer running parts means a smaller risk surface and less to maintain.

## 19. The writer is a minimal write API

**Chosen:** the writer accepts writes only, and serves no reads. For each write, it validates the record against its schema, signs it, and adds it to a file. The optional workers in the static site use case are writer instances (see decision 17).

**Rejected:** a writer that also serves reads. Visitors would then reach it, which widens the risk surface.

**Why:** a small write path is easy to review and keeps the risk surface small (decision 18). A record that fails its schema is rejected, and nothing is written.

## 20. Language and runtime: TypeScript or JavaScript on Node or Bun

**Chosen:** the writer and any other code are TypeScript or JavaScript. They run on Node or Bun as serverless functions, with no separate server. Schemas are language-neutral (see decision 4).

**Rejected:** Rust. It would need a separate server to run.

**Why:** serverless functions keep the default path free of servers (decision 18). Because schemas are language-neutral, the language choice does not change the files.

## 21. The top-level `yafi` field is reserved for Yafi

**Chosen:** user data fields sit at the top level, as the schema defines them. The top-level key `yafi` is reserved for Yafi. Inside it, Yafi sets `schema`, `seq`, `written_at`, and `signatures`, and optionally `idem` and `prev`. The writer rejects any user field named `yafi`, and rejects duplicate keys. A record is identified by its file path and `yafi.seq`.

**Rejected:** a `data:` wrapper around user fields, and a separate `id` field.

**Why:** top-level fields are easy to read and write, and a reserved key keeps Yafi's fields apart from user fields. Duplicate keys are rejected because some parsers silently keep only the last of two identical keys.

## 22. Signatures use JOSE (RFC 7515), with Ed25519

**Chosen:** `yafi.signatures` is a list of signatures in the JOSE JSON serialization (RFC 7515). The writer's signature is detached, with the payload member omitted (RFC 7515, Appendix F). The signed bytes are the record's canonical JSON (RFC 8785), excluding `yafi.signatures`. The protected header carries `alg` and `kid`. Ed25519 uses the `alg` value `Ed25519` (RFC 9864). The value `EdDSA` is deprecated. Public keys are JWKs (RFC 8037 for OKP keys) in a JWK Set (RFC 7517, section 5). A user who also signs adds a second entry to the list.

**Rejected:** invented signature fields. A plain SHA-256 hash, since anyone who edits a file can recompute it. HS256 as proof of authorship, since a shared secret cannot prove who wrote a record to anyone who holds it. HS256 remains a configurable option.

**Why:** a standard format lets a verifier find the key by `kid` in a JWK Set. A public key can verify a signature without being able to make one. A signature alone cannot show that a record was deleted or reordered, which is what chaining is for (decision 3).

## 23. Write coordination is open, and not configurable

**Chosen:** no option is chosen. Write coordination is not one of the configurable parts (decision 16). Sagas (decision 7) are the proposed direction. Owners (decision 6) are one option under consideration.

**Rejected:** a central transfer worker (decision 6) and two-phase commit (decision 7).

**Why:** the choice is not settled. Owners on celld would conflict with the no-servers goal (decision 18). Offering write coordination as a setting would present an open choice as settled.

## Open questions

- **Git as a storage backend.** Git was once a supported backend for small projects, because it is free, keeps a commit log, and could even host the engine that runs it. It is now under reconsideration, beyond Git-only sites. The concerns are that git is slow for writes, that GitHub has outages, and that concurrent pushes conflict. Each backend also adds complexity to support. Object storage may be enough on its own. Until this is settled, the default is any object storage, and Git is used for Git-only sites.
- **Write coordination (decision 23).** Sagas are the proposed direction, and owners are one option under consideration. Whether either is chosen is open.
- **Write queue (decision 8).** The writer appends to files directly. Whether a write queue is still needed is open.
- **Official values (decision 10).** Decision 10 says the writer or the build computes official values. Confirm which one, or both.

## File rollover

**Chosen:** when a file reaches its size limit, YafiDB starts a new file. The engineer sets the limit for each data type, and YafiDB provides a default. An optional schedule (for example yearly) also starts new files. Whichever comes first wins. Only the newest file is ever written, so existing files are never updated.

**Why:** editing existing files is the hardest part of a file database: object storage rewrites whole objects, and in-place edits risk conflicts and corruption. Capping file size bounds the cost of every write and leaves older files immutable.

## Record modes: checkpoint, patch, diff

**Chosen:** every record sets exactly one mode. `checkpoint` holds the complete record, `patch` holds only changed fields (JSON Merge Patch rules), and `diff` holds unified line diffs of text fields. The mode is never assumed, and records never mix modes. JSON Patch (RFC 6902) and format-specific patch standards are not supported.

**Why:** three modes cover structured data and data kept exactly as received, without supporting an open-ended list of patch types. Whether data is parsed into fields or kept as text is the engineer's choice. YafiDB stays blind to the original format.

