# Tradeoffs

This document lists the real costs and risks of the design, so nobody is surprised later. Each item says what the cost is, when it matters, and what softens it.

## You own the engine

Owners, sagas, the cruncher, tiers, compaction, and the code that generates the API are custom code that you build and run. This is the biggest cost. It is acceptable because the LLC use case needs only a small part of it, and the rest can be added later.

## The owner runtime is the main lock-in point

Owners run on Cloudflare Durable Objects today, or celld if self-hosted. The data (YAML), the models (JSON Schema and CEL), and the API code (Hono) are portable. The owner runtime is the one piece that is tied to a platform. The design keeps the owner's job small (accept, check, queue, flush) so it can be reimplemented.

## Eventual consistency

Reads trail writes by seconds. Saga steps appear as "pending" until confirmed. The pending overlay gives users their own writes at once. Anything that needs an instant check has to ask the account's owner.

## Hot accounts

A single very busy account handles one request at a time. Split it into sub-accounts, as banks do with omnibus accounts. This is rare and limited to that account.

## Key management

Signing keys per writer need rotation and revocation. The key is kept apart from storage credentials. How old signatures stay verifiable after a rotation is an open question.

## Privacy deletion

An immutable log conflicts with a request to delete a person's data. The answer is crypto-shredding: store personal data encrypted with a per-user key, and destroy the key to delete it. This needs careful design of which fields count as personal data.

## Schema evolution

Records written under one model version must stay readable under later versions. That means versioned schemas plus upgrade steps on read, or occasional migrations that start new chains. A migration is clean, and it becomes a long-running job at large scale.

## Storage request costs

Objects are rewritten whole on each flush, and listing a bucket costs requests. Batching, time-split files, and shared physical files at scale keep this bounded. Costs rise with the number of flushes, not with the number of records.

## Pending states are visible

Readers have to handle pending saga entries. Official totals exclude them.

## Gaps and limits in the model standards

- **JSON Schema is clumsy for rules across fields.** `if/then` blocks get long. CEL checks (`x-validate`) cover this, and the engineer chooses.
- **CEL is less flexible than a full programming language.** It cannot define new functions. Related records are passed in as variables, and a small standard `sum` extension is registered everywhere. For multipliers, sums, conditions, and percentages this is plenty.
- **JavaScript CEL implementations are newer than the Go and Java ones.** Official results come from a mature, signed, pinned server implementation, and the browser value is for display.

## Who can change formulas

A formula change is an edit to a model, which is a signed record and a Git commit, with a before-and-after preview. It needs no deploy. It still needs someone who can write a CEL expression, or an assistant to write it.

## What it does not fit

Firehose data such as access logs and telemetry. Use a purpose-built pipeline.
