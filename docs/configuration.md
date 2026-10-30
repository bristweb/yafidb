# Configuration

This document explains how a YafiDB project chooses its file format, its storage, and whether its files are compiled into a database. All key names and template names here are illustrative, because no code exists yet.

## What is configurable

Each project has one configuration file, called `yafidb.yaml` in these examples. It has one section for each of three parts.

- **Format:** how records are written in a file. The default is YAML. The focus today is YAML, and other formats may be adopted in the future.
- **Storage:** where the files live. The default is any S3-compatible storage.
- **Compile:** whether the files are compiled into something else. The default is none, or a SQLite database. A fully static website is another compile target. See [Static site](static-site.md).

Each part is configured on its own. A choice for one part does not limit the other two. More options may be added in the future.

Optional features, such as signed history, are turned on in the same file, per project or per data type. See [Design](design.md).

## Templates

A **template** is a named starting point that fills in the three sections for you. You can start from a template and change any part afterward.

| Template | Format | Storage | Compile |
| --- | --- | --- | --- |
| `s3+yaml+none` | YAML | S3-compatible | None |
| `s3+yaml+sqlite` | YAML | S3-compatible | SQLite |

The repository has an example config for each template in [examples/config/](../examples/config/).

## An example config

This is the config for the `s3+yaml+none` template.

```yaml
# yafidb.yaml (key names are illustrative)
template: s3+yaml+none
format:
  type: yaml
  version: 1
storage:
  type: s3
  bucket: my-records
  endpoint: https://example.r2.cloudflarestorage.com
compile:
  type: none
```

This is a project that chose its own mix: S3-compatible storage, YAML, a SQLite database, and signed history on one data type.

```yaml
# yafidb.yaml (key names are illustrative)
format:
  type: yaml
  version: 1
storage:
  type: s3
  bucket: ledger-records
  endpoint: https://example.r2.cloudflarestorage.com
compile:
  type: sqlite
  output: derived/ledger.sqlite
features:
  integrity:
    data_types: [contribution]   # hash chain and signatures for this type only
```

## Plug-in interfaces

Each of the three parts is a **plug-in**. This section describes what each plug-in type must provide, at the interface level only. The design does not yet define code. Because each part talks to the others only through these interfaces, a part can be replaced without changing the other two.

**A format codec must provide:**

- A name and version, such as `yaml/1`, that files declare in their header.
- A way to read a file's bytes into records, including reading the header.
- A way to write records into bytes.
- A way to add records to the end of existing file content.

**A storage backend must provide:**

- A way to list the files under a path.
- A way to read a file and get back a version tag that identifies that exact content.
- A way to write a file only if its version tag is unchanged, so two writers cannot overwrite each other. For S3-compatible storage this is a conditional write.
- Optionally, a way to announce that a file changed, so a compiler can run.

**A compiler must provide:**

- A name for the database engine and a place to write its output.
- A way to build the whole database from scratch from all the files, so a lost database can always be rebuilt.
- Optionally, a way to update the database from only the files that changed.
- A promise never to change the files. The database is derived and the files stay the source of truth.
