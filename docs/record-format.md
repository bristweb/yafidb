# Record format and write path

Detail behind the README. Start there.

## The example record

- `yafi` is reserved for Yafi. Yafi sets everything in it and rejects any user field with that name. The writer also rejects duplicate keys, since some parsers silently keep only the last of two identical keys.
- `yafi` is one line: the mode, the time written, and a compact JOSE signature. The mode is `checkpoint` (the full record), `patch` (only changed fields) or `diff` (line changes to a text field). Patches and diffs apply to everything above them; a later checkpoint replaces the record in full.
- The header's `yafi_schema` names the version of Yafi's record layout, and `record_schema` names the schema for this data type. The writer sets both, so a file cannot choose its own. A new version starts a new file.
- Your fields sit at the top level, as the schema defines them.
- The signature is a compact JWS (RFC 7515). Its header names the algorithm (`alg`) and key (`kid`). Its claims hold the mode, the time (`iat`), a hash of the entry's data, and the previous entry's signature, so every entry proves the one before it. The first entry links to the header. Editing, removing, or reordering any entry breaks the chain. The time is the writer's claim, not proof.
- Pruning old entries is an admin action that knowingly drops history. The new first checkpoint keeps the hash of the last signature it replaced, so the chain still verifies.

### Free text

 The `note` field takes any text with no escaping. The same `note` in JSON needs every quote and line break escaped:

```json
{"note": "Gift message: \"Happy 60th, Mom!\" Love, José & Ana 🎉\nLeave at the side door --- not the front (dog #2 bites).\nSorry it's late :\\ wrap it in {blue} paper if you can.\n"}
```

In the file, the writer stores this as an indented literal block under `note: |`. A YAML library does the wrapping, so the text cannot change the structure of the file. That makes it safe to store text from a Notion-style editor, a web form, or an AI agent. The one exception is control characters such as NUL, which YAML cannot store. Escaping for display, such as sanitizing HTML, is still the job of whatever renders the text.

## How it works

- **Client:** any app, website, or AI agent that reads or changes data.
- **Writer:** a minimal write API, built as a serverless function. It runs only when a write request arrives, validates the record against its schema, signs it, and adds it to a file. It serves no reads, so visitors never reach it.
- **Record files:** the data itself, stored in any object storage, such as Amazon S3 or Cloudflare R2. Files are split per person or object and per period, so each write rewrites only a small file.
- **Compile:** an optional step that builds derived outputs from the files. The files stay the source of truth. A derived output exists to meet a need the files do not meet well on their own: a static site for fast, cheap publishing, a scalable database for heavy queries, or a format another tool can read. Each output can be deleted and rebuilt from the files.

Writes and reads take separate paths. A write goes through a writer. A read skips the writers and goes to a derived output. If compiling is off, reads go to the files directly. Reads from a derived output can trail writes by a few seconds. Some sites need no writer at all; see the static website use case.

## How writes are validated

A folder of files becomes a database when every write is checked against the same rules, by a writer or by the build.

- **You choose each schema, and Yafi enforces it.** Each data type has one schema, which you write. Yafi does not decide what the schema says. It makes sure every write follows the schema, and a file or client cannot use a different one. The writer sets `yafi.schema` on every record, so the name and version in a file always match the schema Yafi applied. Each schema version also pins the record format, so the signature covers the format too. In Git-only sites, the repository holds the schemas and the build enforces them.
- **Schemas are strict.** Every record must pass its schema before it is written. An invalid record is rejected, and nothing is written.
- **Schemas define the rules.** A schema describes one kind of record. JSON Schema is the first schema language, and it defines the fields and their types. [CEL](https://cel.dev), a small and safe expression language, adds computed values and checks across fields. For example, a contribution schema can compute a `slices` value from the record's `type`, `amount`, `hours`, and `hourly_rate` fields. Other schema languages may be added later, and each must be just as strict. See [example schemas](examples/schemas/).
- **Records are signed.** After validation, the writer signs the record, including everything in `yafi` except the signatures themselves. The signature is a standard JOSE signature (RFC 7515). Its header names the algorithm (`alg`) and the key (`kid`). The signed bytes are the record's canonical JSON (RFC 8785), with only `yafi.signatures` left out. A verifier finds the public key by `kid` in a JSON Web Key Set (RFC 7517), then confirms that the worker validated and wrote the record and that no one has changed it since. The worker uses `Ed25519`, the registered JOSE name (RFC 9864). A plain hash such as SHA-256 is not enough, because anyone who edits a file can recompute it. A shared-secret HMAC is not enough either, because any verifier holding the secret could create records. The signing key is kept separate from storage credentials, so someone who gets storage access cannot forge signed records. Records changed only through Git have no writer, so they are not signed.
- **Ledgers can also be chained.** For data where order and completeness matter, each record can link to the one before it. An edit, deletion, or reordering then breaks the chain. This is set per data type.

See [how schemas are enforced in docs/design.md](docs/design.md#schemas) for the full pipeline.


## Record ids

When a file is created, Yafi signs its header (`yafi_schema`, `record_schema`, the time, and a random nonce) and writes that signature on the header's own `yafi: header` line. The record id is the first 22 characters of that signature's last segment. The nonce makes every header signature unique (see below). The first entry chains to the header signature, and a prune keeps the header line unchanged, so the id never changes.

## Nonce

Ed25519 is deterministic and JWS adds no randomness, so identical input gives an identical signature. The nonce keeps header signatures, and therefore record ids, unique.

- **Where:** required in the header signature's payload, as the claim `nonce`. Entries do not carry one; each entry signs the previous signature, so entries are already unique.
- **Size:** 128 bits.
- **Source:** a cryptographically secure random number generator (CSPRNG), such as `crypto.getRandomValues` in Node or Bun. Never a timestamp, counter, or hash of the content.
- **Encoding:** base64url without padding, 22 characters.
- **Checked:** a verifier rejects a header whose `nonce` is missing or is not 22 base64url characters.
- **Generated once:** when the file is created. A prune keeps the header line, so the nonce and the record id stay the same.

## Linking records

A reference is a path from the database root (starting with `/`) plus an anchor that always begins with the target's record id:

```yaml
customer: /customer/alice.yaml#kQ3x9fT2bL7pW8nZaB1c2d                    # the record, current state
customer: /customer/alice.yaml#kQ3x9fT2bL7pW8nZaB1c2d/Vt3nQcR8yP1wLm6sDf4gHa  # the record as of one entry
customer: /customer/alice.yaml#kQ3x9fT2bL7pW8nZaB1c2d/Vt3nQcR8yP1wLm6sDf4gHa/email  # one field at that entry
```

- The path is chosen by the architect and stays clickable in ordinary file viewers.
- The record id is authoritative; the path is a convenience.
- An entry id is the first 22 characters of that entry's signature segment. Field paths follow JSON Pointer.
- If a file is renamed, the compiled cache knows which files point to each record id, so only those files are rewritten. The cache is derived from the files and can be rebuilt at any time.
- Optionally, a renamed file leaves a stub at its old path pointing to the new one.
- A link to an entry removed by a prune falls back to the record, with a "history pruned" warning.

## Broken or corrupted files

If a signature or chain link fails to verify, the file is trusted up to the last entry that verifies. Yafi recovers it automatically:

1. Everything after the break is moved, as-is, into a new quarantine record. The bad text is kept whole in a block field, and the record links back to the original by record id.
2. The original file is truncated to its last verified entry, with a conditional write so nothing new is lost.
3. Writes resume from there. No admin is needed.

```yaml
yafi_schema: yafi@1
record_schema: quarantine@1
yafi: header 2026-11-01T21:50:00Z eyJhbGciOiJFZDI1NTE5In0...Qz8rLm
---
source: /order/1042/2026.yaml#Hn4sW7cP2xLq9TbR5mZe1a
reason: signature failed
removed: |
  status: returned
  yafi: patch 2026-11-01T20:12:09Z eyJhbGciOiJFZDI1NTE5In0...BADsig
yafi: checkpoint 2026-11-01T21:50:00Z eyJhbGciOiJFZDI1NTE5In0...Mw2kTp
```

An admin can review the quarantine record later and, if anything was legitimate, write it back as a new entry.

## Permitted writers

A file can limit who may write to it by listing permitted key ids (`kid`). Every signature names its `kid` in the JWS header, and the writer refuses any entry whose `kid` is not on the current list.

The list is set by a `keys` entry, which always states the full list:

```yaml
kids:
  - shop-writer-2026
  - admin-jonathan
yafi: keys 2026-11-01T21:55:00Z eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiYWRtaW4tam9uYXRoYW4ifQ...Pk4vXe
```

- The latest `keys` entry replaces the earlier list, and applies to every entry after it.
- A `keys` entry must itself be signed by a `kid` on the list it replaces.
- With no `keys` entry, any key the writer trusts may write.
- A `keys` entry is part of the signature chain like any other entry, and a prune's new first checkpoint carries the current list forward.
