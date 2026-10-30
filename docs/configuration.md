# Configuration

This document explains the parts of a YafiDB project that you can choose, and how to set them in `yafidb.yaml`. All key names and template names here are illustrative, because no code exists yet.

## What is configurable

Each project has one configuration file, called `yafidb.yaml` in these examples. These are the configurable parts. Each has a default.

- **Record format:** how records are written in a file. Each data type's schema sets it with `x-format`. YAML today. Other formats only if someone builds them.
- **Storage:** where the files live. Any object storage, such as Amazon S3 or Cloudflare R2. Git for Git-only sites.
- **Schema language:** how each schema is written. JSON Schema, with CEL for computed values and checks.
- **Signing:** the algorithm that signs each record. Ed25519 by default. Other JOSE algorithms can be named by their `alg` value. A shared-secret option such as HS256 cannot prove who wrote a record.
- **Chaining:** whether a data type's records link to the one before. Off by default. Turn it on per data type.
- **Derived output:** what is built from the files. None by default. A static site, SQLite, a scalable database, or another format. See [Static site](static-site.md).
- **Where the writer runs:** a serverless function, another serverless host, or none for Git-only sites.

Write coordination is not a setting. It is an open design decision.

## Templates

A **template** is a named starting point. It fills in storage and derived output, and it names the record format that the schemas use. You can start from a template and change any part afterward.

| Template | Storage | Format | Derived output |
| --- | --- | --- | --- |
| `s3+yaml+none` | S3-compatible object storage | YAML | None |
| `s3+yaml+sqlite` | S3-compatible object storage | YAML | SQLite |

The repository has an example config for each template in [examples/config/](../examples/config/).

## An example config

This is the config for the `s3+yaml+none` template. It has no format key, because each data type's schema sets its record format with `x-format`, such as `x-format: yaml/1`.

```yaml
# yafidb.yaml (key names are illustrative)
template: s3+yaml+none
storage:
  type: s3                       # any object storage
  bucket: my-records
  endpoint: https://example.r2.cloudflarestorage.com
signing:
  alg: Ed25519                   # default
chaining:
  data_types: []                 # off by default. List a data type to turn it on
derived_output:
  type: none
writer:
  runs_on: serverless            # a serverless function
```

Other mixes, such as SQLite as derived output with chaining on one data type, are in [examples/config/](../examples/config/).

## What each part must provide

This section describes what the record format, storage, and derived output must provide, at the interface level only. The design does not yet define code. Each part talks to the others only through these requirements, so a part can be replaced without changing the others.

**A record format must provide:**

- A name and version, such as `yaml/1`, that each data type's schema sets with `x-format`. Files do not declare their own format.
- A way to read a file's bytes into records.
- A way to write records into bytes.
- A way to add records to the end of existing file content. Records are separated by `---`, and a file has no header document.

**Storage must provide:**

- A way to list the files under a path.
- A way to read a file.
- A way to write a file.
- Optionally, a way to announce that a file changed, so compile can run.

**Derived output must provide:**

- A name for the output, such as a static site or SQLite, and a place to write it.
- A way to build the whole output from scratch from all the files, so it can always be deleted and rebuilt.
- Optionally, a way to update the output from only the files that changed.
- A promise never to change the files. The derived output is built from them, and the files stay the source of truth.
