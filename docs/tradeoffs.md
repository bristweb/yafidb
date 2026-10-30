# Tradeoffs

This document lists the real costs and risks of the design, so nobody is surprised later. Each item says what the cost is, when it matters, and what softens it.

## You own the engine

The configuration loader, the writer, the compile step, the record format code, and the code that generates the API are custom code that you build and run. The optional patterns (chaining, tiers, and write coordination, which is still under consideration) add more. This is the biggest cost. It is acceptable because the core is small, the LLC use case needs only part of the patterns, and the rest can be added later.

## Write coordination may add platform lock-in

Write coordination is still an open design decision. Sagas are the proposed direction. Owners on Cloudflare Durable Objects are one option under consideration, and so is celld, which is self-hosted. Self-hosted options conflict with the goal of having no servers. An owner runtime would be the one piece tied to a platform. The data (readable files), the schemas (JSON Schema and CEL), and the API code (Hono) are portable. If an owner runtime is chosen, keeping its job small (accept, check, queue, flush) would make it easier to reimplement.

## Eventual consistency

Reads from a derived output trail writes by seconds, because it is built from files after they are written. Anything that needs an instant check cannot rely on a derived output. If sagas are used for write coordination, saga steps appear as "pending" until confirmed. A pending overlay can give users their own writes at once.

## Hot accounts

If write coordination uses one owner per account, a single very busy account would handle one request at a time. Owners are still under consideration. If they are chosen, the fix is to split the account into sub-accounts, as banks do with omnibus accounts. This would be rare and limited to that account.

## Key management

Signing keys per writer need rotation and revocation. Public keys are kept in a JWK Set (RFC 7517), and the signing key is kept apart from storage credentials. How old signatures stay verifiable after a rotation is an open question.

## Privacy deletion

An immutable log conflicts with a request to delete a person's data. The answer is crypto-shredding: store personal data encrypted with a per-user key, and destroy the key to delete it. This needs careful design of which fields count as personal data.

## Schema evolution

Records written under one schema version must stay readable under later versions. That means versioned schemas plus upgrade steps on read, or occasional migrations that start new files. A migration is clean, and it becomes a long-running job at large scale.

## Git as a storage backend is under reconsideration

Git was considered as a storage backend because it is free, keeps a commit log, and is easy for AI agents to work in. Its costs are slow writes, limited write concurrency, conflicts when several pushes arrive at once, repository growth, and dependence on GitHub's availability. The default is object storage, such as S3-compatible storage. Git stores records only in Git-only sites, which change rarely. For other sites, the question stays open. See [Open questions](decisions.md#open-questions).

## Custom parts are your responsibility

Anyone can bring their own record format, storage, or derived output. Each must meet the requirements in [What each part must provide](configuration.md#what-each-part-must-provide). A part that cannot meet one of them must document that limit. The project does not test or support third-party parts.

## The record format may change

YAML is the record format today. A later format means a new record format and a migration. Old files stay readable in the format they were written in. The cost is that every part must read records through the format and never parse files directly.

## Storage request costs

Objects are rewritten whole on each write, and listing a bucket costs requests. Batching, time-split files, and shared physical files at scale keep this bounded. Costs rise with the number of writes, not with the number of records.

## Pending states are visible

If sagas are used, readers have to handle pending saga entries. Official totals exclude them.

## Gaps and limits in the schema standards

- **JSON Schema is clumsy for rules across fields.** `if/then` blocks get long. CEL checks (`x-validate`) cover this, and the engineer chooses.
- **CEL is less flexible than a full programming language.** It cannot define new functions. Related records are passed in as variables, and a small standard `sum` extension is registered everywhere. For multipliers, sums, conditions, and percentages this is plenty.
- **JavaScript CEL implementations are newer than the Go and Java ones.** The writer and other code are TypeScript or JavaScript, so which CEL implementation gives official results is an open question. The browser value is for display.

## Who can change formulas

A formula change is an edit to a schema, with a before-and-after preview. It needs no deploy. It still needs someone who can write a CEL expression, or an assistant to write it.

## What it does not fit

Firehose data such as access logs and telemetry. Use a purpose-built pipeline.
