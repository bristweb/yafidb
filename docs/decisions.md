# Decision log

This log records each decision, the alternatives that were considered and rejected, and the reason. Each entry stands alone, so you can read only the one you care about.

## Summary

| # | Decision | Chosen | Main rejected alternative |
| --- | --- | --- | --- |
| 1 | Source of truth | YAML chains in an S3-compatible bucket | Git repository |
| 2 | Storage format | Append-only multi-document YAML | A relational database |
| 3 | Integrity | Optional hash chain plus Ed25519 signatures | Always-on, or none |
| 4 | Model language | JSON Schema plus CEL | HyperFormula, custom language, SQL, formulas.ts |
| 5 | Where formulas live | On each model | One shared formulas file |
| 6 | Write coordination | One owner per account | Central worker, 2PC |
| 7 | Cross-account actions | Sagas with a shared transaction ID | Single-record transfers, 2PC |
| 8 | Queue storage | A bucket (R2 or any S3 store) | A key-value store |
| 9 | API | Hono REST first | GraphQL first |
| 10 | Official calculation | Server-side, signed and pinned CEL | Trust client results |

## 1. Source of truth: object store with chains, not Git

**Chosen:** append-only chains in any S3-compatible bucket.

**Rejected:** a Git repository as the source of truth.

**Why:** an object store gives conditional writes, cheap storage, event notifications, and per-account files, and the hash chain and signatures already provide tamper evidence and history. Git would add a second history mechanism with slower, whole-repository writes and no natural per-account serialization. Git is still used for code and model files.

## 2. Storage format: append-only YAML

**Chosen:** multi-document YAML (`---` separators) with freeform Markdown in `|` block scalars.

**Why:** a person can read it, diff it, and export it. Block scalars carry Markdown, JSON, YAML, and code without escaping. Export for a user is handing them their file.

## 3. Integrity is optional per data type

**Chosen:** hash chaining (`prev`, `seq`) and Ed25519 signatures can be switched on per data type. The worker signs the chain wrapper, and the user may also sign their entry.

**Why:** ledgers need strong history, while high-volume low-value types should not pay the cost. The signing key is kept apart from storage credentials so stolen bucket access cannot forge history.

## 4. Models: JSON Schema plus CEL

**Chosen:** JSON Schema for fields and CEL for derived values (`x-computed`) and optional cross-field checks (`x-validate`). The engineer may use either validation style or both.

**Rejected, in the order they came up:**

- **HyperFormula (spreadsheet engine).** It was suggested without agreement. The requirement was client-side JavaScript, not a particular spreadsheet library.
- **Formulas built into the API code.** Simplest, but the goal was spreadsheet-like ease of changing a formula, and a code deploy for each change is not that.
- **Custom language.** Inventing a language adds a thing to design, secure, and document, when a standard exists.
- **SQL inside models.** Rejected in favour of a neutral expression language.
- **A separate `formulas.ts` file.** Editing is easy, but the formulas sit apart from the models they belong to, and finding one means searching "an ocean of unrelated formulas".
- **Models as TypeScript with Zod.** Zod is good, but it ties the definition to one language. Models are meant to work from any language. Zod can still be generated from JSON Schema for TypeScript types.
- **JSON Logic.** Safe and cross-language, but hard to read beyond simple math.
- **Forcing the engineer to use JSON Schema or CEL.** The engineer picks. Both are supported.

**Why CEL:** it is a standard with mature implementations in many languages. It is sandboxed by design, always finishes, and is type-checked before it runs.

## 5. Formulas live on their model

**Chosen:** each formula sits on the model it belongs to.

**Why:** opening a model shows its fields and math together, like a spreadsheet column carries its formula, with no separate file to search.

## 6. One owner per account, not a central worker

**Chosen:** a Durable Object-style actor per account, the only writer for that account. Cloudflare Durable Objects now, celld when self-hosted.

**Rejected:** a central transfer worker that handles all transfers.

**Why:** a central worker would be one very busy component handling every user's traffic. A per-account owner spreads load, and owners for idle accounts cost nothing. Busy accounts split into sub-accounts.

## 7. Sagas with a shared transaction ID

**Chosen:** cross-account actions are sagas between owners (pending, apply, confirm or reverse), tied by a shared transaction ID.

**Rejected:**

- **Single-record-only transfers.** One record for the whole transfer cannot half-apply, but it leaves no authoritative transaction record on each account. Each account's chain should be an auditable record on its own.
- **Two-phase commit.** It gives true all-or-nothing but is slow and complex, can deadlock, and a coordinator crash leaves participants locked. A saga plus single owners covers the same cases.

## 8. Queue in a bucket, not a key-value store

**Chosen:** the write queue lives in R2 or another S3-compatible bucket.

**Why:** it is portable across providers and strongly consistent. A key-value store would be cheaper for some uses but ties the design to one vendor's service and may only be eventually consistent.

## 9. Hono REST first, GraphQL later

**Chosen:** a Hono API with REST generated from the models. GraphQL may be added later as a read layer.

**Why:** Hono runs on Workers, Bun, Deno, Node, and celld. REST is simple and caches by address. GraphQL is possible but adds batching, depth limits, and caching work that is not needed first.

## 10. Official results are computed on the server

**Chosen:** official values come from a signed, pinned, mature CEL implementation on the server. Client-side JavaScript may evaluate CEL for display.

**Why:** clients can fake what they display to themselves, so display needs no extra trust. Differences between implementations would be a defect in an implementation, not a design risk, so a pinned server implementation is a sufficient recommendation.

## 11. Schema migration starts a new chain

**Chosen:** a migration creates a new chain whose first record is a signed genesis record naming the old chain's last hash. The migration script is deterministic and reproducible. Records carry a schema version.

**Why:** old history is never rewritten, and anyone can reproduce the migration.

## 12. Privacy deletion through encryption keys

**Chosen:** personal data is stored encrypted with a per-user key. Deleting a user destroys the key (crypto-shredding).

**Why:** an immutable log cannot delete bytes, but unreadable bytes are as good as deleted.
