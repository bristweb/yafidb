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

## How writes stay valid

A folder of files becomes a database when every write is checked against the same rules, by a writer or by the build.

- **You choose each schema, and Yafi enforces it.** Each data type has one schema, which you write. Yafi does not decide what the schema says. It makes sure every write follows the schema, and a file or client cannot use a different one. The writer sets `yafi.schema` on every record, so the name and version in a file always match the schema Yafi applied. Each schema version also pins the record format, so the signature covers the format too. In Git-only sites, the repository holds the schemas and the build enforces them.
- **Schemas are strict.** Every record must pass its schema before it is written. An invalid record is rejected, and nothing is written.
- **Schemas define the rules.** A schema describes one kind of record. JSON Schema is the first schema language, and it defines the fields and their types. [CEL](https://cel.dev), a small and safe expression language, adds computed values and checks across fields. For example, a contribution schema can compute a `slices` value from the record's `type`, `amount`, `hours`, and `hourly_rate` fields. Other schema languages may be added later, and each must be just as strict. See [example schemas](examples/schemas/).
- **Records are signed.** After validation, the writer signs the record, including everything in `yafi` except the signatures themselves. The signature is a standard JOSE signature (RFC 7515). Its header names the algorithm (`alg`) and the key (`kid`). The signed bytes are the record's canonical JSON (RFC 8785), with only `yafi.signatures` left out. A verifier finds the public key by `kid` in a JSON Web Key Set (RFC 7517), then confirms that the worker validated and wrote the record and that no one has changed it since. The worker uses `Ed25519`, the registered JOSE name (RFC 9864). A plain hash such as SHA-256 is not enough, because anyone who edits a file can recompute it. A shared-secret HMAC is not enough either, because any verifier holding the secret could create records. The signing key is kept separate from storage credentials, so someone who gets storage access cannot forge signed records. Records changed only through Git have no writer, so they are not signed.
- **Ledgers can also be chained.** For data where order and completeness matter, each record can link to the one before it. An edit, deletion, or reordering then breaks the chain. This is set per data type.

See [how schemas are enforced in docs/design.md](docs/design.md#schemas) for the full pipeline.

