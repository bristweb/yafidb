# Examples

Sample record files and schemas that show the shapes described in [docs/design.md](../docs/design.md). All names, IDs, and amounts are illustrative. Each file is one record: a header, then entries that each end in a `yafi:` line. The signatures are placeholders, not real values. The [working demo](../demo/README.md) writes real ones.

| File | Shows |
| --- | --- |
| [chains/member-alice-2026.yaml](chains/member-alice-2026.yaml) | A header, a checkpoint, and a patch, each signed over the one before |
| [chains/saga-transfer-alice.yaml](chains/saga-transfer-alice.yaml) and [chains/saga-transfer-bob.yaml](chains/saga-transfer-bob.yaml) | Two sides of one saga, each a record with its own entries, tied by transaction ID `t_881` |
| [chains/genesis-after-migration.yaml](chains/genesis-after-migration.yaml) | A genesis file that starts after a schema migration and names the last signature of the old file |
| [chains/freeform-markdown.yaml](chains/freeform-markdown.yaml) | Markdown, JSON, YAML, and code inside `|` blocks with no escaping |
| [schemas/contribution.schema.yaml](schemas/contribution.schema.yaml) | A schema: JSON Schema fields, CEL `x-computed` values, and `x-validate` rules |
| [schemas/member.schema.yaml](schemas/member.schema.yaml) | A schema that uses related records as CEL variables |

Schemas are JSON Schema, written here in YAML for readability. The same content in a `.json` file is equally valid.

## Config examples

Sample `yafidb.yaml` deployment settings for each template, plus one custom mix. Key names are illustrative. Folders, schemas, and pipelines live in the manifest, `/yafi.yaml`, not here (see [architecture](../docs/architecture.md#the-manifest)).

| File | Shows |
| --- | --- |
| [config/yafidb.s3-yaml-none.yaml](config/yafidb.s3-yaml-none.yaml) | Template `s3+yaml+none`: files in an S3-compatible bucket, no derived output |
| [config/yafidb.s3-yaml-sqlite.yaml](config/yafidb.s3-yaml-sqlite.yaml) | Template `s3+yaml+sqlite`: files in a bucket, built to SQLite |
| [config/yafidb.custom-mix.yaml](config/yafidb.custom-mix.yaml) | A custom mix with a signed manifest required |
