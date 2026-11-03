// Optional derived output: a disposable SQLite cache, rebuilt from the files every time.
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import type { BuiltRecord } from "./build.ts";

export async function writeSqlite(file: string, records: BuiltRecord[]) {
  await rm(file, { force: true });
  const db = new Database(file);
  db.run(`
    CREATE TABLE records (record_id TEXT PRIMARY KEY, path TEXT UNIQUE, folder TEXT, record_schema TEXT,
      created TEXT, entry_count INTEGER, last_entry_id TEXT, state_json TEXT);
    CREATE TABLE entries (record_id TEXT, seq INTEGER, entry_id TEXT, mode TEXT, time TEXT, PRIMARY KEY (record_id, seq));
    -- Reverse references: who points at each record. Rename a file by looking up target_record_id.
    CREATE TABLE reverse_refs (target_record_id TEXT, target_path TEXT, target_entry_id TEXT, target_field TEXT,
      source_record_id TEXT, source_path TEXT, source_field TEXT, resolved INTEGER);
    CREATE INDEX reverse_refs_target ON reverse_refs (target_record_id);
  `);
  const rec = db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?)");
  const ent = db.prepare("INSERT INTO entries VALUES (?,?,?,?,?)");
  const ref = db.prepare("INSERT INTO reverse_refs VALUES (?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (const r of records) {
      const h = r.v.header!;
      rec.run(h.id, r.path, r.folder, h.record_schema, h.time, r.v.entries.length, r.v.entries.at(-1)?.id ?? null, JSON.stringify(r.v.state));
      for (const e of r.v.entries) ent.run(h.id, e.seq, e.id, e.mode, e.time);
      for (const x of r.refs)
        ref.run(x.ref?.recordId ?? null, x.ref?.path ?? null, x.ref?.entryId ?? null, x.ref?.field ?? null, h.id, r.path, x.pointer, x.error ? 0 : 1);
    }
  })();
  db.close();
}
