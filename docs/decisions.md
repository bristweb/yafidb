# Decision log

This log records each decision, the alternatives that were considered and rejected, and the reason. Each entry stands alone, so you can read only the one you care about.

## Summary

| # | Decision | Chosen | Main rejected alternative |
| --- | --- | --- | --- |
| 1 | Storage backend | S3-compatible storage as the default. Git as a storage backend is an open question | Git as the only backend |
| 2 | Storage format | Append-only multi-document YAML (today) | A relational database |
| 3 | Integrity | Optional pattern: hash chain plus Ed25519 signatures | Always-on, or none |
| 4 | Model language | JSON Schema plus CEL | HyperFormula, custom language, SQL, formulas.ts |
| 5 | Where formulas live | On each model | One shared formulas file |
| 6 | Write coordination | Optional pattern: one owner per account | Central worker, 2PC |
| 7 | Cross-account actions | Optional pattern: sagas with a shared transaction ID | Single-record transfers, 2PC |
| 8 | Queue storage | A bucket (R2 or any S3 store) | A key-value store |
| 9 | API | Hono REST first | GraphQL first |
| 10 | Official calculation | Server-side, signed and pinned CEL | Trust client results |
| 11 | Schema migration | New files with a signed genesis record | Rewriting history |
| 12 | Privacy deletion | Per-user encryption keys | Deleting bytes |
| 13 | Core idea | Readable files as truth, any database derived from them | Defining the system as one chain per entity |
| 14 | File format | Pluggable through a codec, YAML first | Hard-wiring YAML |
| 15 | Core goals | AI-easy start, $0 cost, optional databases, composable | A fixed storage and database stack |
| 16 | Composition | Three independent configurable parts chosen in one config, with defaults and templates | A fixed stack, or a single bundled backend |

## 1. Storage backend: S3-compatible storage by default, git under reconsideration

**Status:** git as a storage backend is under reconsideration. See [Open questions](#open-questions). The history below is kept as written.

**Chosen:** the readable files are the source of truth, and the backend is pluggable by stage. Small and starter projects keep the files in a git repository. Projects that need write concurrency or scale keep them in S3-compatible object storage with thin writers. The files are the same in both.

**Rejected:** git as the only backend. An earlier version of this decision dropped git entirely, and this entry revises it: git is now a supported backend for the starter stage. Decision 16 makes the backend one of three configurable parts. Since then, git as a storage backend has become an open question, and the default is S3-compatible storage only.

**Why:** git is free, keeps history, supports pull request review, and is easy for AI agents to work in, so it is the cheapest start. It is a poor fit for many concurrent writers, because writes are whole-repository commits and there is no per-account serialization, and repository size can grow without bound. Object storage gives conditional writes, cheap storage, event notifications, and files that any tool can read. The optional hash chain and signatures provide tamper evidence where a use case needs them. Git is also still used for code and model files.

## 2. Storage format: append-only YAML today

**Chosen:** multi-document YAML (`---` separators) with freeform Markdown in `|` block scalars.

**Why:** a person can read it, diff it, and export it. Block scalars carry Markdown, JSON, YAML, and code without escaping. Export for a user is handing them their file. YAML is the current format and is replaceable through a codec (see decisions 14 and 16).

## 3. Integrity is an optional pattern, per data type

**Chosen:** hash chaining (`prev`, `seq`) and Ed25519 signatures can be switched on per data type. The writer signs the chain wrapper, and the user may also sign their entry.

**Why:** ledgers need strong history, while high-volume low-value types should not pay the cost. The signing key is kept apart from storage credentials so stolen bucket access cannot forge history.

## 4. Models: JSON Schema plus CEL

**Chosen:** JSON Schema for fields and CEL for derived values (`x-computed`) and optional cross-field checks (`x-validate`). Schema enforcement is mandatory and strict: every record must pass its model's JSON Schema before it is written (see [How a write is validated](design.md#how-a-write-is-validated)). The engineer chooses how to write the model: the JSON Schema, plus optional CEL computed values and extra CEL checks.

**Rejected, in the order they came up:**

- **HyperFormula (spreadsheet engine).** It was suggested without agreement. The requirement was client-side JavaScript, not a particular spreadsheet library.
- **Formulas built into the API code.** Simplest, but the goal was spreadsheet-like ease of changing a formula, and a code deploy for each change is not that.
- **Custom language.** Inventing a language adds a thing to design, secure, and document, when a standard exists.
- **SQL inside models.** Rejected in favour of a neutral expression language.
- **A separate `formulas.ts` file.** Editing is easy, but the formulas sit apart from the models they belong to, and finding one means searching "an ocean of unrelated formulas".
- **Models as TypeScript with Zod.** Zod is good, but it ties the definition to one language. Models are meant to work from any language. Zod can still be generated from JSON Schema for TypeScript types. YafiDB will probably also provide Zod or a similar validator out of the box as a convenience. That is likely, not promised, and models are still defined with JSON Schema and CEL.
- **JSON Logic.** Safe and cross-language, but hard to read beyond simple math.
- **Making schema checking optional.** Every record must pass its JSON Schema. CEL computed values and extra checks are optional, and the engineer chooses them.

**Why CEL:** it is a standard with mature implementations in many languages. It is sandboxed by design, always finishes, and is type-checked before it runs.

## 5. Formulas live on their model

**Chosen:** each formula sits on the model it belongs to.

**Why:** opening a model shows its fields and math together, like a spreadsheet column carries its formula, with no separate file to search.

## 6. Optional pattern: one owner per account, not a central worker

**Chosen:** for use cases that need it, a Durable Object-style actor per account, the only writer for that account. Cloudflare Durable Objects now, celld when self-hosted.

**Rejected:** a central transfer worker that handles all transfers.

**Why:** a central worker would be one very busy component handling every user's traffic. A per-account owner spreads load, and owners for idle accounts cost nothing. Busy accounts split into sub-accounts.

## 7. Optional pattern: sagas with a shared transaction ID

**Chosen:** for use cases that need it, cross-account actions are sagas between owners (pending, apply, confirm or reverse), tied by a shared transaction ID.

**Rejected:**

- **Single-record-only transfers.** One record for the whole transfer cannot half-apply, but it leaves no authoritative transaction record on each account. Each account's record should be auditable on its own.
- **Two-phase commit.** It gives true all-or-nothing but is slow and complex, can deadlock, and a coordinator crash leaves participants locked. A saga plus single owners covers the same cases.

## 8. Queue in a bucket, not a key-value store

**Chosen:** the write queue lives in R2 or another S3-compatible store.

**Why:** it is portable across providers and strongly consistent. A key-value store would be cheaper for some uses but ties the design to one vendor's service and may only be eventually consistent.

## 9. Hono REST first, GraphQL later

**Chosen:** for the TypeScript implementation, a Hono API with REST generated from the models. The implementation language can change per project, and every implementation must enforce the same models. GraphQL may be added later as a read layer.

**Why:** Hono runs on Workers, Bun, Deno, Node, and celld. REST is simple and caches by address. GraphQL is possible but adds batching, depth limits, and caching work that is not needed first.

## 10. Official results are computed on the server

**Chosen:** official values come from a signed, pinned, mature CEL implementation on the server. Client-side JavaScript may evaluate CEL for display.

**Why:** clients can fake what they display to themselves, so display needs no extra trust. Differences between implementations would be a defect in an implementation, not a design risk, so a pinned server implementation is a sufficient recommendation.

## 11. Schema migration starts new files

**Chosen:** a migration creates new files. With integrity on, the first record is a signed genesis record naming the old chain's last hash. The migration script is deterministic and reproducible. Records carry a schema version.

**Why:** old history is never rewritten, and anyone can reproduce the migration.

## 12. Privacy deletion through encryption keys

**Chosen:** personal data is stored encrypted with a per-user key. Deleting a user destroys the key (crypto-shredding).

**Why:** an immutable log cannot delete bytes, but unreadable bytes are as good as deleted.

## 13. Readable files are the truth, and any database is derived

**Chosen:** the source of truth is a set of human-readable files in any S3-compatible store. Writers do the minimum work: check, append, and flush. A processor turns the files into any database engine, and those databases are derived and rebuildable. Per-account owners, sagas, hash chains, and signing are optional patterns for use cases that need them, such as money movement.

**Rejected:** defining the system as one append-only chain per account or entity, with a per-account owner as a required part.

**Why:** the main goal is to remove CPU and server overhead and to keep everything as human-readable files. Scale then comes from processing the files into any database system, so the same design serves a trivial weekend project, personal accounting, banking, and very large systems. Requiring owners and signed chains for every use would add cost that small uses do not need.

## 14. The file format is pluggable, and YAML is the first format

**Chosen:** all files are YAML today. Each file declares its format and version in a header, for example `format: yaml/1`. All reading and writing goes through a codec interface. Switching to another format,, means writing a new codec and running a migration, which is the same pattern as a schema migration. Old files stay readable by their old codec.

**Rejected:** hard-wiring YAML into every part of the system.

**Why:** YAML fits today for human readability, comments, appendable multi-document files, Markdown in `|` blocks without escaping, and universal parsers. The best format may change over the life of the data, and a codec keeps that change small. The exact header syntax is an open question in the [design](design.md#open-questions).

## 15. Core goals: easy for AI, $0, optional databases, composable

**Chosen:** YafiDB ("Yet Another File DB", a nod to YAML files) is built around four goals.

1. **Very easy for AI agents to spin up new projects.** A project is files plus model definitions that an AI can generate and read, with no infrastructure to provision.
2. **$0 cost for most any project.**
3. **Infinite scaling through optional database writing.** Derived databases are opt-in.
4. **Composable.** The file format, the storage, and the compilation are each configurable. An earlier wording of this goal was "pluggable storage by stage", with files moving from a git repository to S3-compatible storage. Git as storage is now an open question.

**Rejected:** a fixed storage and database stack that every project must provision.

**Why:** these goals come from the owner. Files plus models are something an AI can write without setting up servers, so starting is fast and free. Scale is added later by choosing a database, not by rewriting data. 

## 16. Composable configuration: three configurable parts, defaults, and templates

**Chosen:** YafiDB reads and writes the files and makes sure they are structured properly, which is what turns files into a database. It has three independent, configurable parts, each chosen in one configuration file (illustratively `yafidb.yaml`): the file format (codec), the storage backend, and database compilation, which is optional. Each part works with any choice for the other two. Everything else is an optional layer or feature that a project turns on per project or per data type: integrity, one owner per account, sagas, tiered databases, models, and the API.

**Defaults** are YAML for the format, S3-compatible storage for storage, and either no compilation or SQLite. **Templates** prefill the config with one choice per part, for example `s3+yaml+none` and `s3+yaml+sqlite` (names illustrative). A user can start from a template or change any part. The structure is composable, and more options may be added later. The README does not list other plug-ins, and this decision neither promises nor rules them out.

**Plug-in interfaces** are defined at the interface level only. A format codec provides a name and version, reads bytes into records, writes records into bytes, and can add records to a file. A storage backend lists files, reads a file with a version tag, and writes only if the version tag is unchanged. A compiler names its engine and output, can rebuild from scratch, and never changes the files.

**Git** as a storage backend is under reconsideration (see decision 1). Git is still used as a publish target for a generated static site (see decision 17).

**Rejected:** a fixed stack that every project must use, and a single bundled storage or database.

**Why:** the owner's direction is that everything is composable and files act as the database. Independent parts let a project start free and simple, then change one part without touching the others or the files. This builds on decision 1 (pluggable storage), decision 14 (pluggable format), and decision 15 (goals). Config key names and template names are illustrative and may change.

## 17. A fully static website is compiled from the files and published through git

**Chosen:** a key use is a fully static website. The files are compiled into a static site, and the generated site is committed to a repository so it can be published to GitHub Pages, Cloudflare Pages, or any static host. Only changes route through a small worker. See [Static site](static-site.md).

**Why:** a static site needs no server for visitors, which keeps cost near $0 and makes the site fast. Git here is only the publish target. The records stay in the configured storage.

## Open questions

- **Git as a storage backend.** Git was once a supported backend for small projects, because it is free, keeps a commit log, and could even host the engine that runs it. It is now under reconsideration. The concerns are that git is slow for writes, that GitHub has outages, and that concurrent pushes conflict. Each backend also adds complexity to support. S3-compatible storage may be enough on its own. Until this is settled, the default is S3-compatible storage and git is used only as a publish target for generated static sites.
