// Races and failures: concurrent quarantines, concurrent valid writes, and a whole-file quarantine whose delete fails.
import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkPath } from "../src/check.ts";
import { verifyFile } from "../src/format.ts";
import { asWorker } from "../src/node-context.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { R2Storage } from "../src/storage.ts";
import { appendEntry, createRecord } from "../src/writer.ts";
import { fakeR2, gated, makeEnv, moved, order, readData, rejects, seedAlice, writeData } from "./helpers.ts";

const ORDER = "/order/1042/2026.yaml";
const FORGED = "---\nstatus: refunded\nyafi: patch 2026-11-01T20:12:09Z aaaa.bbbb.cccc\n";
const quarantined = async (dir: string) => (await readdir(join(dir, "root/quarantine")).catch(() => [] as string[])).filter((f) => f.endsWith(".yaml"));

async function orderWithForgedTail() {
  const env = await makeEnv();
  const alice = await seedAlice(env.ctx);
  await createRecord(env.ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
  const good = await readData(env.dir, ORDER);
  await writeData(env.dir, ORDER, good + FORGED);
  return { ...env, good };
}

describe("concurrent quarantine", () => {
  test("two writers hit the same corrupt file: one quarantine record, the file cut once, one is told to retry and the other writes", async () => {
    const { ctx, dir } = await orderWithForgedTail();
    // both read the corrupt file, and both have written the quarantine record, before either cuts
    const racing = { ...ctx, storage: gated(gated(ctx.storage, "get", ORDER, 2), "putIfMatch", ORDER, 2) };
    const results = await Promise.allSettled([
      appendEntry(racing, { path: ORDER, mode: "patch", data: { status: "shipped" } }),
      appendEntry(racing, { path: ORDER, mode: "patch", data: { tracking: "1Z999" } }),
    ]);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);   // the one that lost the cut re-read and wrote
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.status).toBe(409);
    expect(failed[0].reason.message).toContain("retry");   // the one that cut answers retry

    expect(await quarantined(dir)).toHaveLength(1);        // the second quarantine found the record and added none
    const v = await verifyFile(await readData(dir, ORDER), ctx.keys);
    expect(v.ok).toBe(true);                               // the forged tail is gone, the winner's entry is in
    expect(v.entries).toHaveLength(2);
    const q = await verifyFile(await readData(dir, `/quarantine/${(await quarantined(dir))[0]}`), ctx.keys);
    expect(q.ok && q.state.removed).toBe(FORGED);

    // the one told to retry can now write, and chains to what is there
    await appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "delivered" } });
    expect((await verifyFile(await readData(dir, ORDER), ctx.keys)).entries).toHaveLength(3);
  });

  test("a whole-file quarantine race: the garbage is logged once, both are told to retry, and a retry creates the record", async () => {
    const { ctx, dir } = await makeEnv();
    const P = "/customer/alice.yaml";
    await mkdir(join(dir, "root/customer"), { recursive: true });
    await writeData(dir, P, "name: forged\n");
    const racing = { ...ctx, storage: gated(ctx.storage, "delete", P, 2) };   // both have logged before either deletes
    const data = { name: "Alice", email: "alice@example.com" };
    const results = await Promise.allSettled([
      createRecord(racing, { path: P, schema: "customer@1", data }),
      createRecord(racing, { path: P, schema: "customer@1", data }),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.status).toBe(409);
      expect((r as PromiseRejectedResult).reason.message).toContain("retry");
    }
    expect(await quarantined(dir)).toHaveLength(1);        // the second log found the record and added none
    expect(await ctx.storage.get(P)).toBeNull();
    const q = await verifyFile(await readData(dir, `/quarantine/${(await quarantined(dir))[0]}`), ctx.keys);
    expect(q.ok && q.state.removed).toBe("name: forged\n");
    await createRecord(ctx, { path: P, schema: "customer@1", data });
    expect((await verifyFile(await readData(dir, P), ctx.keys)).ok).toBe(true);
  });

  test("a crash between the quarantine write and the cut is finished by the next check, with no second record", async () => {
    const { ctx, dir, good } = await orderWithForgedTail();
    let crash = true;
    const crashing = { ...ctx, storage: new Proxy(ctx.storage, {
      get(t: any, k) {
        if (k === "putIfMatch") return async (p: string, ...a: any[]) => {
          if (crash && p === ORDER) throw new Error("process died");
          return t.putIfMatch(p, ...a);
        };
        return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      } }) };
    await rejects(checkPath(crashing, ORDER));
    expect(await readData(dir, ORDER)).toBe(good + FORGED);   // not cut yet
    expect(await quarantined(dir)).toHaveLength(1);           // but the bad text is already safe
    crash = false;
    const first = (await quarantined(dir))[0];

    const done = moved(await checkPath(ctx, ORDER));
    expect(done).toHaveLength(1);
    expect(done[0].quarantinePath).toBe(`/quarantine/${first}`);   // the name comes from the removed bytes
    expect(await quarantined(dir)).toEqual([first]);
    expect(await readData(dir, ORDER)).toBe(good);
  });
});

describe("concurrent valid writes", () => {
  test("two appends that both pass the checks before either writes: one lands, one gets a conflict and writes nothing; a retry chains to the winner", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
    const racing = { ...ctx, storage: gated(ctx.storage, "get", ORDER, 2) };   // both read the same version
    const results = await Promise.allSettled([
      appendEntry(racing, { path: ORDER, mode: "patch", data: { status: "shipped" } }),
      appendEntry(racing, { path: ORDER, mode: "patch", data: { tracking: "1Z999" } }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.status).toBe(409);
    expect(lost[0].reason.message).toContain("conflict");

    // a success means the entry is in the file; the failure left nothing behind
    let v = await verifyFile(await readData(dir, ORDER), ctx.keys);
    expect(v.ok && v.entries).toHaveLength(2);
    expect(v.entries.at(-1)!.id).toBe(ok[0].value.entry_id);
    expect(await readdir(join(dir, "root/order/1042"))).toEqual(["2026.yaml"]);   // no leftovers

    // the loser re-reads and retries; its entry chains to the winner's
    const winnerSig = v.entries.at(-1)!.sig;
    const loserData = results[0].status === "rejected" ? { status: "shipped" } : { tracking: "1Z999" };
    const retry = await appendEntry(ctx, { path: ORDER, mode: "patch", data: loserData });
    const text = await readData(dir, ORDER);
    v = await verifyFile(text, ctx.keys);
    expect(v.ok && v.entries).toHaveLength(3);
    expect(v.entries.at(-1)!.id).toBe(retry.entry_id);
    const jws = text.trimEnd().split("\n").at(-1)!.split(" ").at(-1)!;
    expect(JSON.parse(atob(jws.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).prev).toBe(winnerSig);
    expect(v.state.status).toBe("shipped");
    expect(v.state.tracking).toBe("1Z999");
  });
});

describe("whole-file quarantine", () => {
  const P = "/customer/junk.yaml";
  const junk = async (dir: string, body: string) => { await mkdir(join(dir, "root/customer"), { recursive: true }); await writeData(dir, P, body); };
  const failing = (ctx: any, method: "delete" | "putIfMatch", match: (p: string) => boolean, on = { fail: true }) => ({
    ...ctx, storage: new Proxy(ctx.storage, {
      get(t: any, k) {
        if (k === method) return async (p: string, ...a: any[]) => {
          if (on.fail && match(p)) throw new Error("storage unavailable");
          return t[method](p, ...a);
        };
        return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      } }) });

  test("if the quarantine write fails, nothing is deleted", async () => {
    const { ctx, dir } = await makeEnv();
    await junk(dir, "name: forged\n");
    const broken = failing(ctx, "putIfMatch", (p) => p.startsWith("/quarantine/"));
    const [r] = await checkPath(broken, P);
    expect(r.status).toBe("failed");
    expect(await readData(dir, P)).toBe("name: forged\n");
    expect(await quarantined(dir)).toHaveLength(0);
    const err = await rejects(createRecord(broken, { path: P, schema: "customer@1", data: { name: "Alice", email: "a@example.com" } }));
    expect(err.status).toBe(409);
  });

  test("a failed delete changes nothing about the outcome: the file is quarantined and the write answers retry, and the next check finds the file again", async () => {
    const { ctx, dir } = await makeEnv();
    await junk(dir, "name: forged\n");
    const broken = failing(ctx, "delete", (p) => p === P);
    const err = await rejects(createRecord(broken, { path: P, schema: "customer@1", data: { name: "Alice", email: "a@example.com" } }));
    expect(err.status).toBe(409);
    expect(err.message).toContain("retry");                   // the same answer as when the delete works
    expect(await readData(dir, P)).toBe("name: forged\n");   // the file is still there
    expect(await quarantined(dir)).toHaveLength(1);           // and already logged
    const first = (await quarantined(dir))[0];

    const done = moved(await checkPath(ctx, P));              // the next check finds it again, same record, and deletes
    expect(done[0].quarantinePath).toBe(`/quarantine/${first}`);
    expect(await quarantined(dir)).toEqual([first]);
    expect(await ctx.storage.get(P)).toBeNull();
  });

  test("if the file is still there and has changed, the next check logs the new content too", async () => {
    const { ctx, dir } = await makeEnv();
    await junk(dir, "name: forged\n");
    await checkPath(failing(ctx, "delete", (p) => p === P), P);
    await writeData(dir, P, "name: forged\nextra: junk\n");
    expect(moved(await checkPath(ctx, P))).toHaveLength(1);
    const names = await quarantined(dir);
    expect(names).toHaveLength(2);
    const removed = await Promise.all(names.map(async (n) => {
      const q = await verifyFile(await readData(dir, `/quarantine/${n}`), ctx.keys);
      return q.ok && q.state.removed;
    }));
    expect(removed.sort()).toEqual(["name: forged\n", "name: forged\nextra: junk\n"]);
    expect(await ctx.storage.get(P)).toBeNull();
  });

  test("on R2 the original is deleted after the record is written, and the folder checks clean", async () => {
    const { ctx } = await makeEnv({ plugins: [] });
    const { kv, bucket } = fakeR2();
    const r2 = { ...ctx, storage: new R2Storage(bucket) };
    await r2.storage.putIfMatch(MANIFEST_PATH, (await ctx.storage.get(MANIFEST_PATH))!.body, null);
    await seedAlice(r2);
    kv.set("customer/junk.yaml", { body: "name: forged\n", etag: "j1" });
    const m = moved(await checkPath(r2));
    expect(m.map((x) => x.path)).toEqual(["/customer/junk.yaml"]);
    expect(kv.has("customer/junk.yaml")).toBe(false);
    const q = await verifyFile((await r2.storage.get(m[0].quarantinePath))!.body, ctx.keys);
    expect(q.ok && q.state.removed).toBe("name: forged\n");
    expect((await checkPath(r2)).every((x) => x.status === "ok")).toBe(true);
    expect(asWorker(r2, "main").worker).toBe("main");
  });
});
