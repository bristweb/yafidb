# Examples

Sample record files and schemas that show the shapes described in [docs/design.md](../docs/design.md). All names, IDs, and amounts are illustrative. Each file is one record: a header, then entries that each end in a `yafi:` line. The signatures are placeholders, not real values. The [working demo](../demo/README.md) writes real ones.

| File | Shows |
| --- | --- |
| [chains/member.yaml](chains/member.yaml) | A header, a checkpoint, and a patch, each signed over the one before |
| [chains/saga-alice.yaml](chains/saga-alice.yaml) and [chains/saga-bob.yaml](chains/saga-bob.yaml) | Two sides of one saga, each a record with its own entries, tied by transaction ID `t_881` |
| [chains/migration.yaml](chains/migration.yaml) | A migration file that starts after a schema migration and names the last signature of the old file |
| [chains/note.yaml](chains/note.yaml) | Markdown, JSON, YAML, and code inside `|` blocks with no escaping |
| [schemas/contribution.yaml](schemas/contribution.yaml) | A schema: JSON Schema fields, CEL `x-computed` values, and `x-validate` rules |
| [schemas/member.yaml](schemas/member.yaml) | A schema that uses related records as CEL variables |

Schemas are JSON Schema, written here in YAML for readability. The same content in a `.json` file is equally valid.

## Config examples

Sample `yafidb.yaml` deployment settings for each template, plus one custom mix. Key names are illustrative. Folders, schemas, and pipelines live in the manifest, `/yafi.yaml`, not here (see [architecture](../docs/architecture.md#the-manifest)).

| File | Shows |
| --- | --- |
| [config/s3-yaml-none.yaml](config/s3-yaml-none.yaml) | Template `s3+yaml+none`: files in an S3-compatible bucket, no derived output |
| [config/s3-yaml-sqlite.yaml](config/s3-yaml-sqlite.yaml) | Template `s3+yaml+sqlite`: files in a bucket, built to SQLite |
| [config/custom-mix.yaml](config/custom-mix.yaml) | A custom mix with a signed manifest required |
