# Record format and write path

Detail behind the README. Start there.

## The example record

- `yafi` is reserved for Yafi. Yafi sets everything in it and rejects any user field with that name. The writer also rejects duplicate keys, since some parsers silently keep only the last of two identical keys.
- `yafi` is one line: the mode, the time written, and a compact JOSE signature. The mode is `checkpoint` (the full record), `patch` (only changed fields) or `diff` (line changes to a text field). Patches and diffs apply to everything above them; a later checkpoint replaces the record in full.
- The header holds one field, `schema`, which names the schema for this data type. The writer sets it, so a file cannot choose its own. The header's mode, such as `header@1.0.0`, carries the version of the record format (see [Format versions](#format-versions)). A new version starts a new file.
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
- **Build steps:** optional steps that make derived outputs from the files. The files stay the source of truth. A derived output exists to meet a need the files do not meet well on their own: a static site for fast, cheap publishing, a scalable database for heavy queries, or a format another tool can read. Each output can be deleted and rebuilt from the files.

Writes and reads take separate paths. A write goes through a writer. A read skips the writers and goes to a derived output. If no build is set up, reads go to the files directly. Reads from a derived output can trail writes by a few seconds. Some sites need no writer at all; see the static website use case.

## Format versions

The version rides on the header's mode: `header@1.0.0`. The signed claims hold that full mode, so the signature covers the version.

The check tool holds a list of the versions it supports, as PDF and SQLite readers do. It matches the version as whole text, exactly. Any string is a valid version (`1.0.0`, `2.1.0-beta`, `stable`), and Yafi never compares or orders them. `header@1.0` does not match `header@1.0.0`. A file whose version is not on the list is corrupt as far as the tool is concerned, like any other file it cannot verify. It is quarantined whole, and a worker refuses that write so the caller retries. Builds and plain reads do not look at versions. Support for a new format version means adding it to the list, and a file never changes version, so a new version starts a new file.

## Record ids

When a file is created, Yafi signs its header (the versioned mode, `schema`, the time, and a random nonce) and writes that signature on the header's own `yafi: header@<version>` line, in the same shape as every entry. The record id is the first 22 characters of that signature's last segment. The nonce makes every header signature unique (see below). The first entry chains to the header signature, and a prune keeps the header line unchanged, so the id never changes.

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
- If a file is renamed, the relationship cache (a default build step) knows which files point to each record id, so only those files are rewritten. Without it, the owning worker finds them by scanning. The cache is derived from the files and can be rebuilt at any time.
- Optionally, a renamed file leaves a stub at its old path pointing to the new one.
- Open: a link to a field of the current state with no entry id (`#id//field`) is undecided, and the current checks reject it.
- A link to an entry removed by a prune falls back to the record, with a "history pruned" warning.

## Broken or corrupted files

If a signature or chain link fails to verify, the file is trusted up to the last entry that verifies. The check tool finds the problem and recovers the file automatically through the quarantine worker (see [architecture.md](architecture.md#the-check-tool)). A worker runs it before every write, and a build can opt in to running it.

1. Everything after the break is moved, as-is, into a new quarantine record. The bad text is kept whole in a block field, and the record links back to the original by record id.
2. Once that write succeeds, the original file is truncated to its last verified entry, with a conditional write so nothing new is lost.
3. The write that triggered the check is refused with a retry. Writes resume from there. No admin is needed.

How this stays safe when several checks or writes meet is under [Concurrent writes](#concurrent-writes).

A file with no verified header, or one whose `schema` differs from its folder's schema, moves whole and is removed. Its `source` is the path alone, since it has no record id.

```yaml
schema: quarantine@1
yafi: header@1.0.0 2026-11-01T21:50:00Z eyJhbGciOiJFZDI1NTE5In0...Qz8rLm
---
source: /order/1042/2026.yaml#Hn4sW7cP2xLq9TbR5mZe1a
reason: signature failed
removed: |
  status: returned
  yafi: patch 2026-11-01T20:12:09Z eyJhbGciOiJFZDI1NTE5In0...BADsig
yafi: checkpoint 2026-11-01T21:50:00Z eyJhbGciOiJFZDI1NTE5In0...Mw2kTp
```

An admin can review the quarantine record later and, if anything was legitimate, write it back as a new entry.

## Enforced checks

A folder of files becomes a database when every write is checked against the same rules, by a worker or, in Git-only sites, by the check tool in a test. Every write passes all enforced checks, or nothing is written. Yafi's own checks always run, in this order:

0. **Authority:** the path is inside a folder the writing worker owns, and a new record uses that folder's schema. See [architecture.md](architecture.md#writes).
1. **Existing file:** every signature and chain link already in the file verifies, and its `schema` is the folder's schema.
2. **Entry:** the entry passes its record schema, uses a valid mode (`checkpoint`, `patch`, or `diff`), and the result of applying it still passes the schema. You write each schema and Yafi enforces it. JSON Schema defines the fields, and [CEL](https://cel.dev), a small and safe expression language, adds computed values and checks across fields (see [design.md](design.md#schemas)). A schema cannot be skipped, and a file or client cannot choose a different one, because the worker takes the header's `schema` from the folder.
3. **Relationships:** every reference resolves, meaning the path exists and its record id matches the anchor, along with any entry id or field it names.
4. **Write checks:** the admin's own steps from the manifest's write pipeline, such as permissions, in any language. Steps run in parallel unless one names another in `after`. A step only decides pass or fail, and every step must pass.
5. **Write:** Yafi signs over the previous signature and appends with a conditional write. If the file changed since it was read, such as a duplicate or conflicting write, nothing is written, and the caller gets a conflict.

The signature is a standard JOSE signature (RFC 7515) with `Ed25519`, the registered name (RFC 9864). A verifier finds the public key by `kid` in a JSON Web Key Set (RFC 7517). A plain hash such as SHA-256 is not enough, because anyone who edits a file can recompute it. A shared-secret HMAC is not enough either, because any verifier holding the secret could create entries. The signing key is kept separate from storage credentials, so storage access alone cannot forge signed records. Records changed only through Git have no worker, so they are not signed, and the check tool still checks their structure and schema as a test.

Only Yafi signs and appends. A success always means the entry is in the file. A write that did not land says so, and leaves the file as it was.

## Concurrent writes

No locks. Every change to a file is a conditional write on the version that was read, and each case below ends in one of two ways: the change is in the file, or it was refused and the file is as it was.

- **Two valid appends:** both read the same version, and the store lets one write through. The other gets a conflict (409, or 412 from the store), and nothing of it is written. It re-reads and retries, and its entry chains to the winner's.
- **Two checks find the same corrupt file:** the order is fixed. First the quarantine record is written. Then the original is cut or removed with a conditional write on the version that was read. Then the caller answers "retry".
  - The quarantine record's path comes from a hash of the removed text (`/quarantine/<source path>-<first 16 hex of the SHA-256>.yaml`). A second check of the same bytes finds the record already there and adds none.
  - Whoever loses the conditional cut re-reads the file, checks it again, and carries on with the file as it is now: gone, cut back, or changed by a new write.
  - A crash between the steps is finished by the next check. It finds the same corrupt text, finds the record already written, and makes the cut.
- **Removal where the store cannot delete conditionally:** local storage and S3 delete conditionally. Cloudflare R2 does not: its Workers `delete()` takes no condition, and its [S3 compatibility page](https://developers.cloudflare.com/r2/api/s3/api/) lists conditional headers only for HeadObject, GetObject, and PutObject. There the removal is a conditional overwrite with an empty tombstone, on the version that was read. A tombstone reads as absent, is not listed, and a create replaces it with a conditional write on the tombstone's version.
