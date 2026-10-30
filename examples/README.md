# Examples

Sample record files and models that show the shapes described in [docs/design.md](../docs/design.md). All names, IDs, and amounts are illustrative. Every record file starts with a format header (`format: yaml/1`). Hashes and signatures belong to the optional integrity pattern and are placeholders, not real values, because no code exists yet to compute them.

| File | Shows |
| --- | --- |
| [chains/member-alice-2026.yaml](chains/member-alice-2026.yaml) | A chain with hash links, worker signature, and an optional user signature |
| [chains/saga-transfer-alice.yaml](chains/saga-transfer-alice.yaml) and [chains/saga-transfer-bob.yaml](chains/saga-transfer-bob.yaml) | Two sides of one saga, tied by transaction ID `t_881` |
| [chains/genesis-after-migration.yaml](chains/genesis-after-migration.yaml) | A signed genesis record that starts a new chain after a schema migration |
| [chains/freeform-markdown.yaml](chains/freeform-markdown.yaml) | Markdown, JSON, YAML, and code inside `|` blocks with no escaping |
| [models/contribution.model.yaml](models/contribution.model.yaml) | A model: JSON Schema fields, CEL `x-computed` values, and `x-validate` rules |
| [models/member.model.yaml](models/member.model.yaml) | A model that uses related records as CEL variables |

Models are JSON Schema, written here in YAML for readability. The same content in a `.json` file is equally valid.

## Config examples

Sample `yafidb.yaml` files for each template, plus one custom mix. Key names are illustrative.

| File | Shows |
| --- | --- |
| [config/yafidb.s3-yaml-none.yaml](config/yafidb.s3-yaml-none.yaml) | Template `s3+yaml+none`: files in an S3-compatible bucket, no database |
| [config/yafidb.s3-yaml-sqlite.yaml](config/yafidb.s3-yaml-sqlite.yaml) | Template `s3+yaml+sqlite`: files in a bucket, compiled to SQLite |
| [config/yafidb.custom-mix.yaml](config/yafidb.custom-mix.yaml) | A custom mix with optional integrity on one data type |
