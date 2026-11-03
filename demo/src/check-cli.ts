// `bun run check [path]`: the check tool. Verifies the files under a folder (default /), or one file, and quarantines
// what is wrong through the quarantine worker. Exit 1 only if something wrong could not be quarantined.
import { checkPath } from "./check.ts";
import { loadContext } from "./node-context.ts";

const project = process.env.YAFI_PROJECT ?? new URL("..", import.meta.url).pathname;
const ctx = await loadContext(project);
const results = await checkPath(ctx, process.argv[2] ?? "/");

for (const r of results) {
  if (r.status === "quarantined") console.log(`QUARANTINE ${r.path}: ${r.reason} -> ${r.quarantinePath}`);
  else if (r.status === "failed") console.log(`FAILED ${r.path}: ${r.reason} (${r.skipped})`);
  else if (r.status === "unowned") console.log(`UNOWNED ${r.path}: not inside any worker folder, left alone`);
}
const count = (s: string) => results.filter((r) => r.status === s).length;
console.log(`check ${process.argv[2] ?? "/"}: ${count("ok")} ok, ${count("quarantined")} quarantined, ${count("failed")} failed, ${count("unowned")} unowned`);
if (count("failed")) process.exit(1);
