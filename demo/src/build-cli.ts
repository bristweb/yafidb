// `bun run build [folder]`: read the files under the folder and run the manifest's build pipeline. Validates nothing.
import { build } from "./build.ts";
import { loadContext } from "./node-context.ts";

const project = new URL("..", import.meta.url).pathname;
const ctx = await loadContext(project, { needSigner: false });
const r = await build({ ctx, path: process.argv[2] ?? "/" });

console.log(`build ${r.path}: ${r.records} records, workers: ${r.workers.map((w) => `${w.worker}${w.folder}`).join(" ") || "none"}`);
for (const [n, s] of Object.entries(r.steps)) console.log(`step ${n}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
if (Object.values(r.steps).some((s) => s.status === "failed")) process.exit(1);
