// `bun run build [folder]`: verify, heal through the quarantine worker, then run the manifest's build pipeline.
import { build } from "./build.ts";
import { loadContext } from "./node-context.ts";

const project = new URL("..", import.meta.url).pathname;
const ctx = await loadContext(project, { needSigner: false });
const r = await build({ ctx, path: process.argv[2] ?? "/" });

console.log(`build ${r.path}: ${r.records} records, workers: ${r.workers.map((w) => `${w.worker}${w.folder}`).join(" ") || "none"}`);
for (const [n, s] of Object.entries(r.steps)) console.log(`step ${n}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
for (const q of r.quarantined) console.log(`QUARANTINE ${q.path}: ${q.reason}${q.quarantinePath ? ` -> ${q.quarantinePath}` : ` (${q.skipped})`}`);
for (const u of r.unsupported) console.log(`UNSUPPORTED ${u.path}: header version ${u.version} is not supported by this reader, left alone`);
for (const u of r.unowned) console.log(`UNOWNED ${u}: not inside any worker folder, left alone`);
for (const b of r.brokenRefs) console.log(`BROKEN REF ${b.path} ${b.pointer}: ${b.error}`);
if (Object.values(r.steps).some((s) => s.status === "failed")) process.exit(1);
