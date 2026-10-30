# Tradeoffs

This document lists the real costs and risks of the design, so nobody is surprised later. Each item says what the cost is, when it matters, and what softens it.

## You own the engine

The configuration loader, the writer, the processor, the codecs, and the code that generates the API are custom code that you build and run. The optional patterns (owners, sagas, integrity, tiers) add more. This is the biggest cost. It is acceptable because the core is small, the LLC use case needs only part of the patterns, and the rest can be added later.

## The owner runtime is the main lock-in point, when you use owners

The optional owner pattern runs on Cloudflare Durable Objects today, or celld if self-hosted. The data (readable files), the models (JSON Schema and CEL), and the API code (Hono) are portable. The owner runtime is the one piece that is tied to a platform, and use cases without owners do not have it. The design keeps the owner's job small (accept, check, queue, flush) so it can be reimplemented.

## Eventual consistency

Reads trail writes by seconds, because derived databases are built from files after they are written. Saga steps appear as "pending" until confirmed. The pending overlay gives users their own writes at once. Anything that needs an instant check has to ask the account's owner.

## Hot accounts

With the owner pattern, a single very busy account handles one request at a time. Split it into sub-accounts, as banks do with omnibus accounts. This is rare and limited to that account.

## Key management

With the integrity pattern, signing keys per writer need rotation and revocation. The key is kept apart from storage credentials. How old signatures stay verifiable after a rotation is an open question.

## Privacy deletion

An immutable log conflicts with a request to delete a person's data. The answer is crypto-shredding: store personal data encrypted with a per-user key, and destroy the key to delete it. This needs careful design of which fields count as personal data.

## Schema evolution

Records written under one model version must stay readable under later versions. That means versioned schemas plus upgrade steps on read, or occasional migrations that start new files. A migration is clean, and it becomes a long-running job at large scale.

## Git as a storage backend

Git is a supported backend for small and starter projects, with the files kept in a repository.

- **Strengths:** it is free, it keeps full history, it supports pull request review, and it is easy for AI agents to work in.
- **Limits:** many concurrent writers contend on commits, and a repository gets slower as it grows.
- **What softens it:** move the same files to S3-compatible object storage with thin writers when write concurrency or size needs it. The files do not change in the move.

## Cloudflare Artifacts is not a $0 path

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/platform/pricing/) is git-compatible versioned storage built on Durable Objects. It can be used as a storage plug-in, but it requires the Workers Paid plan, which has a $5 per month minimum. It is unavailable on the free Workers plan. It is therefore an optional example, not a happy path, and it does not meet the $0 goal.

## Choosing git means accepting that it is slow

YafiDB is only the file access layer, so it does not hide git's limits. Git writes are commits, which are slow and allow limited write concurrency. Repository size grows with history. A user who picks git accepts that, and can move the same files to S3-compatible storage later.

## Custom plug-ins are your responsibility

Anyone can bring their own format codec, storage backend, or compiler. Each must meet the plug-in interface (see the design). A plug-in that cannot offer part of an interface, such as a conditional write, must document that limit. The project does not test or support third-party plug-ins.

## The file format may change

YAML is the format today. A later format means a new codec and a migration, and old files stay readable by their old codec. The cost is that every part must go through the codec and never parse files directly. The header syntax that every codec must read is still an open question.

## Storage request costs

Objects are rewritten whole on each flush, and listing a bucket costs requests. Batching, time-split files, and shared physical files at scale keep this bounded. Costs rise with the number of flushes, not with the number of records.

## Pending states are visible

With sagas, readers have to handle pending saga entries. Official totals exclude them.

## Gaps and limits in the model standards

- **JSON Schema is clumsy for rules across fields.** `if/then` blocks get long. CEL checks (`x-validate`) cover this, and the engineer chooses.
- **CEL is less flexible than a full programming language.** It cannot define new functions. Related records are passed in as variables, and a small standard `sum` extension is registered everywhere. For multipliers, sums, conditions, and percentages this is plenty.
- **JavaScript CEL implementations are newer than the Go and Java ones.** Official results come from a mature, signed, pinned server implementation, and the browser value is for display.

## Who can change formulas

A formula change is an edit to a model, which is a signed record and a Git commit, with a before-and-after preview. It needs no deploy. It still needs someone who can write a CEL expression, or an assistant to write it.

## What it does not fit

Firehose data such as access logs and telemetry. Use a purpose-built pipeline.
