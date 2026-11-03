// Writes the README's sample data (customer alice, order 1042) through the real writer,
// with the README's timestamps. Run `bun run keygen` first.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { makeDiff } from "../src/format.ts";
import { asWorker, loadContext } from "../src/node-context.ts";
import { listRecords } from "../src/manifest.ts";
import { appendEntry, createRecord } from "../src/writer.ts";

const root = new URL("..", import.meta.url).pathname;
const times = [
  "2026-10-28T14:58:00Z", "2026-10-28T14:58:01Z",                       // alice: header, checkpoint
  "2026-10-29T15:02:10Z", "2026-10-29T15:02:11Z",                       // order: header, checkpoint
  "2026-10-30T13:10:44Z", "2026-10-31T01:05:19Z", "2026-11-01T19:40:02Z",
];
const base = await loadContext(root, { now: () => new Date(times.shift()!) });
if ((await listRecords(base.storage)).length && !process.argv.includes("--force")) {
  console.log("root/ already has records; pass --force to start over");
  process.exit(0);
}
// Clear every worker folder, but keep the manifest.
for (const w of Object.values(base.manifest.workers)) for (const f of Object.keys(w.folders))
  await rm(resolve(base.rootDir, "." + f), { recursive: true, force: true });
const crm = asWorker(base, "crm"), shop = asWorker(base, "shop");

const alice = await createRecord(crm, { path: "/customer/alice.yaml",
  data: { name: "Alice Example", email: "alice@example.com" } });

const note = `Gift message: "Happy 60th, Mom!" Love, José & Ana 🎉
Leave at the side door --- not the front (dog #2 bites).
Sorry it's late :\\ wrap it in {blue} paper if you can.
`;
const customer = `/customer/alice.yaml#${alice.record_id}`;
const items = [{ sku: "MUG-01", qty: 2, price: 12.5 }];
const path = "/order/1042/2026.yaml";

await createRecord(shop, { path,
  data: { status: "placed", customer, items, note, carrierLog: "" } });
await appendEntry(shop, { path, mode: "patch", data: { status: "shipped", tracking: "1Z999AA10123456784" } });
const log = "2026-10-30 09:14 Picked up, Knoxville TN\n2026-10-30 21:02 Departed facility, Nashville TN\n";
await appendEntry(shop, { path, mode: "diff", data: { carrierLog: makeDiff("", log) } });
await appendEntry(shop, { path, mode: "checkpoint", data: {
  status: "delivered", customer, items, note, tracking: "1Z999AA10123456784",
  carrierLog: log + "2026-11-01 14:37 Delivered, side door\n" } });

console.log(`seeded /customer/alice.yaml (id ${alice.record_id}) and ${path}`);
