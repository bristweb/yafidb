// Sample build step: converts every record under `in` to JSON (path, record id, schema, current state).
// Gets paths on stdin ({in: [...], out}) and reads files itself; it never receives the database.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseFile } from "../src/format.ts";

const { in: dirs, out } = await Bun.stdin.json();
let n = 0;
const walk = async (base: string, dir: string): Promise<void> => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(base, p);
    else if (e.name.endsWith(".yaml") && e.name !== "yafi.yaml") {
      const v = await parseFile(await readFile(p, "utf8"));   // a plain read: nothing is screened here
      if (!v.header) continue;
      const rel = relative(base, p).replace(/\.yaml$/, ".json");
      await mkdir(dirname(join(out, rel)), { recursive: true });
      await writeFile(join(out, rel), JSON.stringify({ path: "/" + relative(base, p), record_id: v.header.id, schema: v.header.schema, state: v.state }, null, 2) + "\n");
      n++;
    }
  }
};
for (const d of dirs) await walk(d, d);
console.log(JSON.stringify({ converted: n }));
