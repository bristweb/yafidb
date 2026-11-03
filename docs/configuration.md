# Configuration

This document explains the parts of a YafiDB project that you can choose, and how to set them in `yafidb.yaml`. Key names and template names here are illustrative. The [demo](../demo/README.md) reads a small `yafidb.yaml` of its own.

## What is configurable

A project has two YAML files with different jobs. **`yafidb.yaml`** holds deployment settings and sits outside the data: where the storage is, which keys sign and verify, and where workers run. **`/yafi.yaml`**, the manifest, sits at the top of the root next to the data. It holds who may write where, which schema each folder uses, and the pipelines (see [architecture.md](architecture.md#the-manifest)). These are the parts of the deployment settings you can choose. Each has a default.

- **Record format:** how records are written in a file. The version rides on each file's header (`header@1.0.0`), and the check tool keeps the list of versions it supports. YAML today. Other formats only if someone builds them.
- **Storage:** where the files live. Any object storage, such as Amazon S3 or Cloudflare R2. Git for Git-only sites.
- **Schema language:** how each schema is written. JSON Schema, with CEL for computed values and checks.
- **Signing:** the algorithm that signs each entry. Ed25519 by default. Other JOSE algorithms can be named by their `alg` value. A shared-secret option such as HS256 cannot prove who wrote a record. Each signature covers the previous one, so entries are always chained.
- **Derived output:** what the build steps make from the files. None by default. A static site, SQLite, a scalable database, or another format. See [Static site](static-site.md).
- **Where workers run:** a serverless function, another serverless host, or none for Git-only sites.

Write coordination across accounts is not a setting. It is an open design decision.

## Templates

A **template** is a named starting point. It fills in storage and derived output, and it names the record format that the schemas use. You can start from a template and change any part afterward.

| Template | Storage | Format | Derived output |
| --- | --- | --- | --- |
| `s3+yaml+none` | S3-compatible object storage | YAML | None |
| `s3+yaml+sqlite` | S3-compatible object storage | YAML | SQLite |

The repository has an example config for each template in [examples/config/](../examples/config/).

## An example config

This is the config for the `s3+yaml+none` template. It has no format key, because the format version is on each file's header. Folders, schemas, and pipelines are in the manifest, not here.

```yaml
# yafidb.yaml (key names are illustrative)
template: s3+yaml+none
storage:
  type: s3                       # any object storage
  bucket: my-records
  endpoint: https://example.r2.cloudflarestorage.com
signing:
  alg: Ed25519                   # default
derived_output:
  type: none
writer:
  runs_on: serverless            # a serverless function
```

Other mixes, such as SQLite as derived output, are in [examples/config/](../examples/config/).

## What each part must provide

This section describes what the record format, storage, and derived output must provide, at the interface level only. The design does not yet define code. Each part talks to the others only through these requirements, so a part can be replaced without changing the others.

**A record format must provide:**

- A name and version, such as `header@1.0.0`, on each file's header. The check tool keeps the list of versions it supports, and a file cannot choose its own.
- A way to read a file's bytes into records.
- A way to write records into bytes.
- A way to add entries to the end of existing file content. Entries are separated by `---`, after the header.

**Storage must provide:**

- A way to list the files under a path.
- A way to read a file, with its version (an ETag or a hash).
- A way to write a file only if it is still at a given version, or only if it does not exist.
- A way to remove a file only if it is still at a given version. A store with no conditional delete can overwrite the file with an empty tombstone instead, and a tombstone reads as absent.
- Optionally, a way to announce that a file changed, so a build can run.

**Derived output must provide:**

- A name for the output, such as a static site or SQLite, and a place to write it.
- A way to build the whole output from scratch from all the files, so it can always be deleted and rebuilt. A build only reads: it does no validation, and an admin can add the check tool as a step.
- Optionally, a way to update the output from only the files that changed.
- A promise never to change the files. The derived output is built from them, and the files stay the source of truth.
