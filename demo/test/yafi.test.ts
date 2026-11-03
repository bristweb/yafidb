import { checkPath } from "../src/check.ts";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { WriteError } from "../src/checks.ts";
import { applyDiff, makeDiff, mergePatch, verifyFile } from "../src/format.ts";
import { createHandler } from "../src/handler.ts";
import { build } from "../src/build.ts";
import { generateKeyPair, importJwks, importSigner } from "../src/jws.ts";
import { commandCheck } from "../src/plugins.ts";
import { appendEntry, createRecord } from "../src/writer.ts";
import { makeEnv, moved, order, readData, rejects, root, seedAlice, withBuild, writeData } from "./helpers.ts";

const ORDER = "/order/1042/2026.yaml";

describe("happy path", () => {
  test("create, patch, diff, checkpoint all verify; ids and nonce follow the spec", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    const created = await createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref, { carrierLog: "" }) });
    await appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "shipped", tracking: "1Z999" } });
    await appendEntry(ctx, { path: ORDER, mode: "diff", data: { carrierLog: makeDiff("", "picked up\ndeparted\n") } });
    const last = await appendEntry(ctx, { path: ORDER, mode: "checkpoint", data: order(alice.ref, { status: "delivered", carrierLog: "picked up\ndeparted\narrived\n" }) });

    const text = await readData(dir, ORDER);
    const v = await verifyFile(text, ctx.keys);
    expect(v.ok).toBe(true);
    expect(v.entries.map((e) => e.mode)).toEqual(["checkpoint", "patch", "diff", "checkpoint"]);
    expect(v.entries[2].state.carrierLog).toBe("picked up\ndeparted\n");
    expect(v.state.status).toBe("delivered");
    expect(text.split("\n").filter((l) => l === "---").length).toBe(4);
    expect(text).toMatch(/^schema: order@1\nyafi: header@1\.0\.0 /);
    expect(text).not.toMatch(/\{ ?sku/); // block YAML, no flow style

    // record id = first 22 chars of the header's signature segment; nonce is 128-bit base64url
    const headerSig = text.split("\n")[1].split(" ")[3].split(".")[2];
    expect(created.record_id).toBe(headerSig.slice(0, 22));
    expect(v.header!.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(last.entry_id).toBe(v.entries[3].id);
  });

  test("headers created in the same second still get different ids", async () => {
    const { ctx } = await makeEnv();
    ctx.now = () => new Date("2026-11-02T12:00:00Z");
    const a = await createRecord(ctx, { path: "/customer/a.yaml", schema: "customer@1", data: { name: "A", email: "a@x.io" } });
    const b = await createRecord(ctx, { path: "/customer/b.yaml", schema: "customer@1", data: { name: "A", email: "a@x.io" } });
    expect(a.record_id).not.toBe(b.record_id);
  });

  test("HTTP writer: POST creates and appends, anything else is refused, no reads", async () => {
    const { ctx } = await makeEnv();
    const h = createHandler(() => ctx, { token: "s3cret" });
    const post = (path: string, body: unknown, auth = "Bearer s3cret") =>
      h(new Request(`http://w${path}`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }));
    expect((await post("/records", {}, "nope")).status).toBe(401);
    const c = await post("/records", { path: "/customer/alice.yaml", schema: "customer@1", data: { name: "Alice", email: "a@x.io" } });
    expect(c.status).toBe(201);
    const a = await post("/entries", { path: "/customer/alice.yaml", mode: "patch", data: { name: "Alice B" } });
    expect(a.status).toBe(200);
    expect((await h(new Request("http://w/customer/alice.yaml"))).status).toBe(404);
    expect((await h(new Request("http://w/records"))).status).toBe(405);
    const bad = await post("/entries", { path: "/customer/alice.yaml", mode: "patch", data: { email: 5 } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).check).toBe("entry");
  });

  test("build outputs a linked static site and a SQLite cache with reverse references", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, data: order(alice.ref) });
    const out = join(dir, "dist"), sqlite = join(dir, "cache.sqlite");
    withBuild(ctx, [
      { name: "relationship-cache", builtin: "relationship-cache", out: sqlite },
      { name: "static-site", builtin: "static-site", out },
    ]);
    const r = await build({ ctx });
    expect(r.records).toBe(2);
    expect(r.steps).toEqual({ "relationship-cache": { status: "ok" }, "static-site": { status: "ok" } });
    const page = await readFile(join(out, "order/1042/2026.html"), "utf8");
    expect(page).toContain('href="../../customer/alice.html"');
    expect(await readFile(join(out, "customer/alice.html"), "utf8")).toContain("Referenced by");
    expect(await readFile(join(out, "order/index.html"), "utf8")).toContain("/order/1042/2026.yaml");
    const db = new Database(sqlite);
    const rows = db.query("select source_path from reverse_refs where target_record_id = ?").all(alice.record_id);
    expect(rows).toEqual([{ source_path: ORDER }]);
  });
});

describe("bad signature", () => {
  async function seeded() {
    const env = await makeEnv();
    const alice = await seedAlice(env.ctx);
    await createRecord(env.ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
    await appendEntry(env.ctx, { path: ORDER, mode: "patch", data: { status: "shipped" } });
    return { ...env, alice };
  }

  test("an edited entry fails the data hash, and the writer refuses to append", async () => {
    const { ctx, dir } = await seeded();
    const text = await readData(dir, ORDER);
    await writeData(dir, ORDER, text.replace("status: shipped", "status: delivered"));
    const v = await verifyFile(await readData(dir, ORDER), ctx.keys);
    expect(v.ok).toBe(false);
    expect(v.entries.length).toBe(1);
    expect(v.error).toContain("data does not match signed hash");
    const before = await readData(dir, ORDER);
    const e = await rejects(appendEntry(ctx, { path: ORDER, mode: "patch", data: { tracking: "x" } }));
    expect(e).toBeInstanceOf(WriteError);
    expect(e.check).toBe("existing");
    // the write is refused; the corrupt entry is quarantined, so the file is back to its trusted prefix
    expect(e.message).toContain("/quarantine/");
    expect(await readData(dir, ORDER)).not.toBe(before);
    expect((await verifyFile(await readData(dir, ORDER), ctx.keys)).ok).toBe(true);
    await appendEntry(ctx, { path: ORDER, mode: "patch", data: { tracking: "x" } });
  });

  test("a signature from an unknown key, a flipped signature, and a reordered entry all fail", async () => {
    const { ctx, dir } = await seeded();
    const text = await readData(dir, ORDER);

    const other = await importSigner((await generateKeyPair("evil")).privateJwk);
    const forged = (await import("../src/jws.ts")).signJws;
    const bad = await forged(other, { mode: "patch", iat: 1, data_hash: "x", prev: "y" });
    const lines = text.trimEnd().split("\n");
    lines[lines.length - 1] = lines.at(-1)!.replace(/\S+$/, bad);
    expect((await verifyFile(lines.join("\n") + "\n", ctx.keys)).error).toContain("unknown kid");

    const flipped = text.trimEnd().replace(/.$/, (c) => (c === "A" ? "B" : "A")) + "\n";
    expect((await verifyFile(flipped, ctx.keys)).error).toContain("signature invalid");

    const docs = text.split(/^---\n/m);
    const reordered = [docs[0], docs[2], docs[1]].join("---\n");
    expect((await verifyFile(reordered, ctx.keys)).ok).toBe(false);
  });

  test("duplicate keys and a user `yafi` field are rejected", async () => {
    const { ctx, dir } = await seeded();
    const text = await readData(dir, ORDER);
    const dup = text.replace("status: shipped\n", "status: shipped\nstatus: placed\n");
    expect((await verifyFile(dup, ctx.keys)).error).toContain("bad YAML");
    const e = await rejects(appendEntry(ctx, { path: ORDER, mode: "patch", data: { yafi: "x" } }));
    expect(e.check).toBe("entry");
  });
});

describe("broken references", () => {
  test("missing target, wrong record id, unknown entry, bad field, malformed", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    const id = alice.record_id;
    const create = (customer: string) => createRecord(ctx, { path: ORDER, data: order(customer) });

    for (const bad of [
      `/customer/nobody.yaml#${id}`,                     // path does not exist
      `/customer/alice.yaml#${"A".repeat(22)}`,          // record id mismatch
      `/customer/alice.yaml#${id}/${"B".repeat(22)}`,    // entry id not in file
      `/customer/alice.yaml#${id}/${alice.entry_id}/nope`, // field not in that entry
      `/customer/alice.yaml#${id}/email`,                // field without entry: not supported
    ]) {
      const e = await rejects(create(bad));
      expect(e.check, bad).toMatch(/relationships|entry/);   // the order schema's pattern may catch some first
      expect(await Bun.file(join(dir, "root", ORDER)).exists()).toBe(false);
    }
    // a pinned entry and field that do exist resolve
    const good = await create(`/customer/alice.yaml#${id}/${alice.entry_id}/name`);
    expect(good.record_id).toHaveLength(22);
  });

  test("the check names `relationships` for a dangling link", async () => {
    const { ctx } = await makeEnv();
    const e = await rejects(createRecord(ctx, { path: ORDER, schema: "order@1", data: order(`/customer/ghost.yaml#${"A".repeat(22)}`) }));
    expect(e.check).toBe("relationships");
  });
});

describe("conflicting writes", () => {
  test("two writers that read the same version: exactly one wins, the other gets a conflict", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
    const settled = await Promise.allSettled([
      appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "shipped" } }),
      appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "cancelled" } }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(lost[0].reason.check).toBe("write");
    expect(lost[0].reason.status).toBe(409);
    const v = await verifyFile(await readData(dir, ORDER), ctx.keys);
    expect(v.ok && v.entries.length).toBe(2); // checkpoint + the one winner
  });

  test("a write that lands between read and write is not overwritten", async () => {
    const { ctx, dir } = await makeEnv({ plugins: [] });
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
    // a plugin that runs after the read lets us slip another write in first
    ctx.plugins = [{ name: "race", run: async () => {
      await appendEntry({ ...ctx, plugins: [] }, { path: ORDER, mode: "patch", data: { tracking: "sneaky" } });
      return { pass: true };
    } }];
    const e = await rejects(appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "shipped" } }));
    expect(e.check).toBe("write");
    const v = await verifyFile(await readData(dir, ORDER), ctx.keys);
    expect(v.ok).toBe(true);
    expect(v.state.tracking).toBe("sneaky");
    expect(v.state.status).toBe("placed");
  });

  test("creating a record that exists is a conflict; stale compare-and-swap fails", async () => {
    const { ctx } = await makeEnv();
    await seedAlice(ctx);
    expect((await rejects(seedAlice(ctx))).status).toBe(409);
    const f = (await ctx.storage.get("/customer/alice.yaml"))!;
    expect((await ctx.storage.putIfMatch("/customer/alice.yaml", "x", "stale")).ok).toBe(false);
    expect((await ctx.storage.putIfMatch("/customer/alice.yaml", "x", null)).ok).toBe(false);
    expect((await ctx.storage.get("/customer/alice.yaml"))!.version).toBe(f.version);
  });
});

describe("quarantine", () => {
  test("a forged tail is moved whole to a quarantine record and the file recovers without an admin", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
    const good = await appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "shipped" } });
    const goodText = await readData(dir, ORDER);
    const forged = "---\nstatus: refunded\nyafi: patch 2026-11-01T20:12:09Z aaaa.bbbb.cccc\n";
    await writeData(dir, ORDER, goodText + forged);

    // a build only reads: it does not notice the forged tail, and moves nothing
    const out = join(dir, "dist");
    withBuild(ctx, [{ name: "static-site", builtin: "static-site", out }]);
    await build({ ctx });
    expect(await readData(dir, ORDER)).toBe(goodText + forged);

    // the check tool finds it and quarantines it
    const results = await checkPath(ctx);
    expect(moved(results)).toHaveLength(1);
    const q = moved(results)[0].quarantinePath;
    expect(q).toStartWith("/quarantine/");

    // the original is cut back to its last verified entry
    expect(await readData(dir, ORDER)).toBe(goodText);
    const v = await verifyFile(await readData(dir, ORDER), ctx.keys);
    expect(v.ok).toBe(true);
    expect(v.entries.at(-1)!.id).toBe(good.entry_id);

    // the quarantine record verifies, keeps the bad text whole, and links back by record id
    const qv = await verifyFile(await readData(dir, q), ctx.keys);
    expect(qv.ok).toBe(true);
    expect(qv.state.removed).toBe(forged);
    expect(qv.state.source).toBe(`${ORDER}#${v.header!.id}`);
    expect(qv.state.reason).toContain("entry 3");
    await build({ ctx });
    expect(await readFile(join(out, "quarantine", q.split("/")[2].replace(".yaml", ".html")), "utf8")).toContain("refunded");

    // writes resume
    await appendEntry(ctx, { path: ORDER, mode: "patch", data: { status: "delivered" } });
    // and a second check has nothing left to move
    expect((await checkPath(ctx)).every((r) => r.status === "ok")).toBe(true);
  });

  test("a build reads what it can and checks nothing; the check tool without a signing key moves nothing", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) });
    const text = (await readData(dir, ORDER)) + "---\ngarbage: true\n";
    await writeData(dir, ORDER, text);
    const out = join(dir, "dist");
    withBuild(ctx, [{ name: "static-site", builtin: "static-site", out }]);
    const r = await build({ ctx: { ...ctx, signer: null as any } });
    expect(r.records).toBe(2);
    expect(Object.keys(r)).not.toContain("quarantined");
    expect(await readFile(join(out, "order/1042/2026.html"), "utf8")).toContain("MUG-01");   // read as far as it parses
    const c = await checkPath({ ...ctx, signer: null as any }, ORDER);
    expect(c[0]).toMatchObject({ status: "failed", skipped: expect.stringContaining("no signing key") });
    expect(await readData(dir, ORDER)).toBe(text);
  });

  test("a file whose header fails moves whole to quarantine and is removed", async () => {
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const t = (await readData(dir, "customer/alice.yaml")).replace("schema: customer@1", "schema: order@1");
    await writeData(dir, "customer/alice.yaml", t);
    const m = moved(await checkPath(ctx));
    expect(m).toHaveLength(1);
    expect((await build({ ctx })).records).toBe(1); // only the quarantine record
    expect(await Bun.file(join(dir, "root/customer/alice.yaml")).exists()).toBe(false);
    const q = await verifyFile(await readData(dir, m[0].quarantinePath.slice(1)), ctx.keys);
    expect(q.ok).toBe(true);
    expect(q.state.removed).toBe(t);
    expect(q.state.source).toBe("/customer/alice.yaml"); // no valid header, so no record id
  });
});

describe("write checks", () => {
  test("a failing check blocks the write; a crashing or hanging check fails closed", async () => {
    const { ctx, dir } = await makeEnv();
    const alice = await seedAlice(ctx);
    const e = await rejects(createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref, { items: [{ sku: "X", qty: 500, price: 1 }] }) }));
    expect(e.check).toBe("plugin");
    expect(e.message).toContain("over the limit");
    expect(await Bun.file(join(dir, "root", ORDER)).exists()).toBe(false);

    ctx.plugins = [commandCheck({ name: "crash", command: ["bun", "-e", "process.exit(3)"] }, root)];
    expect((await rejects(createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) }))).check).toBe("plugin");
    ctx.plugins = [commandCheck({ name: "hang", command: ["bun", "-e", "setTimeout(()=>{},60000)"], timeout_ms: 300 }, root)];
    expect((await rejects(createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) }))).check).toBe("plugin");
  });

  test("checks run after Yafi's own, and `after` sets their order", async () => {
    const { ctx } = await makeEnv({ plugins: [] });
    const calls: string[] = [];
    ctx.plugins = [
      { name: "b", after: ["a"], run: async () => (calls.push("b"), { pass: false }) },
      { name: "a", run: async () => (calls.push("a"), { pass: true }) },
    ];
    const alice = await seedAlice({ ...ctx, plugins: [] });
    const e = await rejects(createRecord(ctx, { path: ORDER, schema: "order@1", data: order(alice.ref) }));
    expect(calls).toEqual(["a", "b"]);
    expect(e.message).toContain("check b");
    calls.length = 0;
    await rejects(createRecord(ctx, { path: ORDER, schema: "order@1", data: { nope: 1 } })); // fails schema first
    expect(calls).toEqual([]);
  });
});

describe("storage backends and formats", () => {
  test("S3 storage sends If-None-Match / If-Match and maps 412 to a conflict", async () => {
    const { S3Storage } = await import("../src/storage.ts");
    const objects = new Map<string, { body: string; etag: string }>();
    let n = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const key = new URL(req.url).pathname;
      expect(req.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 Credential=AK/");
      const cur = objects.get(key);
      if (req.method === "DELETE") {
        if (!cur || req.headers.get("if-match") !== cur.etag) return new Response("", { status: 412 });
        objects.delete(key); return new Response("", { status: 204 });
      }
      if (req.method === "GET") return cur ? new Response(cur.body, { headers: { etag: cur.etag } }) : new Response("", { status: 404 });
      const ifNone = req.headers.get("if-none-match"), ifMatch = req.headers.get("if-match");
      if ((ifNone === "*" && cur) || (ifMatch && cur?.etag !== ifMatch) || (ifMatch && !cur)) return new Response("", { status: 412 });
      const etag = `"e${++n}"`;
      objects.set(key, { body: await req.text(), etag });
      return new Response("", { headers: { etag } });
    } });
    const s3 = new S3Storage({ endpoint: `http://localhost:${server.port}`, bucket: "b", accessKeyId: "AK", secretAccessKey: "SK" });
    const a = await s3.putIfMatch("/x/a.yaml", "one", null);
    expect(a.ok).toBe(true);
    expect((await s3.putIfMatch("/x/a.yaml", "dup", null)).ok).toBe(false);
    const got = (await s3.get("/x/a.yaml"))!;
    expect(got.body).toBe("one");
    expect((await s3.putIfMatch("/x/a.yaml", "two", '"stale"')).ok).toBe(false);
    expect((await s3.putIfMatch("/x/a.yaml", "two", got.version)).ok).toBe(true);
    expect(await s3.deleteIfMatch("/x/a.yaml", got.version)).toBe(false); // stale version
    const cur = (await s3.get("/x/a.yaml"))!;
    expect(await s3.deleteIfMatch("/x/a.yaml", cur.version)).toBe(true);
    expect(await s3.get("/x/a.yaml")).toBeNull();
    await s3.putIfMatch("/x/a.yaml", "two", null);
    expect(await s3.get("/x/none.yaml")).toBeNull();
    server.stop(true);
  });

  test("Worker entry runs the same writer on an R2-style bucket", async () => {
    const { default: worker } = await import("../src/worker.ts");
    const kv = new Map<string, { body: string; etag: string }>();
    let n = 0;
    const bucket = {
      async get(k: string) { const o = kv.get(k); return o ? { text: async () => o.body, etag: o.etag } : null; },
      async put(k: string, v: string, o?: any) {
        const cur = kv.get(k);
        if (o?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
        if (o?.onlyIf?.etagMatches && cur?.etag !== o.onlyIf.etagMatches) return null;
        const etag = `e${++n}`; kv.set(k, { body: v, etag }); return { etag };
      },
      async delete(k: string) { kv.delete(k); },
      async list() { return { objects: [...kv.keys()].map((key) => ({ key })), truncated: false }; },
    };
    const { privateJwk, publicJwk } = await generateKeyPair("w");
    const schema = (await import("yaml")).default.parse(await readFile(join(root, "schemas/customer@1.schema.yaml"), "utf8"));
    kv.set("yafi.yaml", { body: "workers:\n  main:\n    folders:\n      /customer/: customer@1\n", etag: "m" });
    const env = { BUCKET: bucket, YAFI_WORKER: "main", YAFI_PRIVATE_JWK: JSON.stringify(privateJwk), YAFI_JWKS: JSON.stringify({ keys: [publicJwk] }),
      YAFI_SCHEMAS: JSON.stringify({ "customer@1": schema }) };
    const send = (p: string, b: unknown) => worker.fetch(new Request(`http://w${p}`, { method: "POST", body: JSON.stringify(b) }), env);
    const c = await send("/records", { path: "/customer/a.yaml", schema: "customer@1", data: { name: "A", email: "a@x.io" } });
    expect(c.status).toBe(201);
    expect((await send("/entries", { path: "/customer/a.yaml", mode: "patch", data: { name: "B" } })).status).toBe(200);
    const v = await verifyFile(kv.get("customer/a.yaml")!.body, await importJwks({ keys: [publicJwk] }));
    expect(v.ok && v.state.name).toBe("B");
  });

  test("diff and merge-patch helpers", () => {
    const a = "one\ntwo\nthree\n", b = "one\n2\nthree\nfour\n";
    expect(applyDiff(a, makeDiff(a, b))).toBe(b);
    expect(applyDiff("", makeDiff("", b))).toBe(b);
    expect(() => applyDiff("different\n", makeDiff(a, b))).toThrow();
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: [1] });
  });
});
