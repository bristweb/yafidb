// `bun run build`: verify, quarantine, and write dist/ (and the SQLite cache when configured).
import { resolve } from "node:path";
import { build } from "./build.ts";
import { loadContext } from "./node-context.ts";

const root = new URL("..", import.meta.url).pathname;
const ctx = await loadContext(root, { needSigner: false });
const cfg = ctx.config.build ?? { out: "dist" };
const sqliteFlag = process.argv.includes("--no-sqlite") ? null : cfg.sqlite;
const r = await build({ ctx, out: resolve(root, cfg.out), sqlite: sqliteFlag ? resolve(root, sqliteFlag) : null });

console.log(`built ${r.records} records -> ${cfg.out}/${sqliteFlag ? ` and ${sqliteFlag}` : ""}`);
for (const q of r.quarantined) console.log(`QUARANTINE ${q.path}: ${q.reason}${q.quarantinePath ? ` -> moved tail to ${q.quarantinePath}` : ` (${q.skipped})`}`);
for (const u of r.unusable) console.log(`UNUSABLE ${u.path}: ${u.reason}`);
for (const b of r.brokenRefs) console.log(`BROKEN REF ${b.path} ${b.pointer}: ${b.error}`);
