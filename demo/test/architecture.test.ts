import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../src/build.ts";
import { verifyFile } from "../src/format.ts";
import { importJwks, importSigner } from "../src/jws.ts";
import { loadManifest, ManifestError, ownerOf, parseManifest, signManifest, MANIFEST_PATH, type Step } from "../src/manifest.ts";
import { runPipeline, validatePipeline } from "../src/pipeline.ts";
import { appendEntry, createRecord } from "../src/writer.ts";
import { asWorker } from "../src/node-context.ts";
import { BASE_MANIFEST, makeEnv, order, readData, rejects, root, seedAlice, withBuild, writeData } from "./helpers.ts";

const TWO_WORKERS = `
workers:
  crm:
    folders:
      /customer/: customer@1
  shop:
    folders:
      /order/: order@1
  quarantine:
    folders:
      /quarantine/: quarantine@1
`;
const ORDER = "/order/1042/2026.yaml";
const problems = (text: string) => { try { parseManifest(text); } catch (e) { return (e as ManifestError).problems; } throw new Error("expected the manifest to be rejected"); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("manifest", () => {
  test("a valid manifest parses; a schema may cover several folders", () => {
    const m = parseManifest(`
workers:
  a:
    folders:
      /x/: order@1
      /y/: order@1
  b:
    folders:
      /z/: customer@1
`);
    expect(Object.keys(m.workers)).toEqual(["a", "b"]);
    expect(ownerOf(m, "/y/1.yaml")).toEqual({ worker: "a", folder: "/y/", schema: "order@1" });
    expect(m.pipelines).toEqual({ write: [], build: [], quarantine: [] });
  });

  test("a folder shared by two workers is rejected", () => {
    const p = problems(`
workers:
  a:
    folders:
      /x/: order@1
  b:
    folders:
      /x/: order@1
`);
    expect(p).toEqual(["folder /x/ is shared by workers a and b"]);
  });

  test("a worker folder inside another worker's folder is rejected, in either order", () => {
    for (const [outer, inner] of [["a", "b"], ["b", "a"]]) {
      const p = problems(`
workers:
  ${outer}:
    folders:
      /x/: order@1
  ${inner}:
    folders:
      /x/deep/: order@1
`);
      expect(p).toEqual([`folder /x/deep/ of worker ${inner} is inside /x/ of worker ${outer}`]);
    }
    expect(problems(`
workers:
  a:
    folders:
      /: order@1
  b:
    folders:
      /y/: order@1
`)[0]).toContain("inside");
  });

  test("nesting inside one worker is allowed, and the nearest rule applies", async () => {
    const { ctx } = await makeEnv({ manifest: `
workers:
  main:
    folders:
      /data/: customer@1
      /data/orders/: order@1
  quarantine:
    folders:
      /quarantine/: quarantine@1
` });
    expect(ownerOf(ctx.manifest, "/data/a.yaml")!.schema).toBe("customer@1");
    expect(ownerOf(ctx.manifest, "/data/orders/2026/b.yaml")!.schema).toBe("order@1"); // subfolders inherit
    const c = await createRecord(ctx, { path: "/data/a.yaml", data: { name: "A", email: "a@x.io" } });
    expect(c.record_id).toHaveLength(22);
    const text = await readData((await makeEnvDir(ctx)), "data/a.yaml");
    expect(text).toContain("record_schema: customer@1");
  });

  test("a folder needs exactly one schema; unknown keys, bad folders and bad steps are all reported together", () => {
    const p = problems(`
bogus: 1
workers:
  a:
    folders:
      /x/: [order@1, customer@1]
      y/: order@1
  b: {}
pipelines:
  write:
    - name: dup
      url: http://x
    - name: dup
      url: http://x
    - name: both
      url: http://x
      command: [a]
    - name: nope
      builtin: static-site
    - name: ghost
      url: http://x
      after: [missing]
`);
    expect(p).toContain("unknown key bogus");
    expect(p).toContain("worker a: folder /x/ needs exactly one schema like name@1");
    expect(p).toContain("worker a: folder y/ must start and end with /");
    expect(p).toContain("worker b needs folders");
    expect(p).toContain("pipelines.write: duplicate step dup");
    expect(p.some((x) => x.includes("(both) needs exactly one of"))).toBe(true);
    expect(p.some((x) => x.includes("(nope) needs exactly one of"))).toBe(true); // builtin only in the build pipeline
  });

  test("duplicate YAML keys and unknown schemas are rejected", async () => {
    expect(problems("workers:\n  a:\n    folders:\n      /x/: order@1\n      /x/: order@1\n")[0]).toContain("bad YAML");
    await expect(rejects(makeEnv({ manifest: BASE_MANIFEST.replace("order@1", "nonexistent@1") }).then(async ({ ctx }) => {
      const { checkSchemas } = await import("../src/manifest.ts");
      await checkSchemas(ctx.manifest, ctx.getSchema);
    }))).resolves.toBeInstanceOf(ManifestError);
  });

  test("signing is optional: a signed manifest verifies, tampering fails, and a worker can require it", async () => {
    const env = await makeEnv();
    const { ctx } = env;
    const signed = await signManifest(BASE_MANIFEST, ctx.signer, new Date("2026-11-03T12:00:00Z"));
    expect(signed).toMatch(/\nyafi: manifest 2026-11-03T12:00:00Z \S+\n$/);
    const put = async (text: string) => {
      const cur = await ctx.storage.get(MANIFEST_PATH);
      await ctx.storage.putIfMatch(MANIFEST_PATH, text, cur!.version);
    };
    await put(signed);
    expect(Object.keys((await loadManifest(ctx.storage, ctx.keys, { requireSigned: true })).workers)).toEqual(["main", "quarantine"]);
    // re-signing replaces the old line
    expect((await signManifest(signed, ctx.signer, new Date("2026-11-04T00:00:00Z"))).match(/yafi: manifest/g)).toHaveLength(1);

    await put(signed.replace("/customer/", "/evil/"));
    expect((await rejects(loadManifest(ctx.storage, ctx.keys))).problems[0]).toContain("changed after signing");

    await put(BASE_MANIFEST);
    await loadManifest(ctx.storage, ctx.keys); // unsigned is fine by default
    expect((await rejects(loadManifest(ctx.storage, ctx.keys, { requireSigned: true }))).problems[0]).toContain("not signed");

    const other = await importSigner((await (await import("../src/jws.ts")).generateKeyPair("evil")).privateJwk);
    await put(await signManifest(BASE_MANIFEST, other, new Date()));
    expect((await rejects(loadManifest(ctx.storage, ctx.keys))).problems[0]).toContain("unknown kid");
  });
});

/** The temp dir of an env made by makeEnv (rootDir is `<dir>/root`). */
const makeEnvDir = async (ctx: { rootDir?: string }) => join(ctx.rootDir!, "..");

describe("worker authority", () => {
  async function two() {
    const env = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    return { ...env, crm: asWorker(env.ctx, "crm"), shop: asWorker(env.ctx, "shop") };
  }

  test("a worker writes in its own folders, and reads anywhere to validate (references across workers)", async () => {
    const { crm, shop, dir } = await two();
    const alice = await seedAlice(crm);
    const o = await createRecord(shop, { path: ORDER, data: order(alice.ref) });   // shop reads crm's file to check the link
    expect(o.record_id).toHaveLength(22);
    expect((await verifyFile(await readData(dir, ORDER), shop.keys)).ok).toBe(true);
    // and a dangling cross-worker link still fails
    const e = await rejects(createRecord(shop, { path: "/order/2.yaml", data: order(`/customer/ghost.yaml#${"A".repeat(22)}`) }));
    expect(e.check).toBe("relationships");
  });

  test("a write outside the worker's folders is rejected, for create and append, and nothing is written", async () => {
    const { crm, shop, dir } = await two();
    const alice = await seedAlice(crm);
    const e = await rejects(createRecord(shop, { path: "/customer/bob.yaml", data: { name: "Bob", email: "b@x.io" } }));
    expect(e.check).toBe("authority");
    expect(e.status).toBe(403);
    expect(e.message).toContain("belongs to worker crm, not shop");
    expect(await Bun.file(join(dir, "root/customer/bob.yaml")).exists()).toBe(false);

    const before = await readData(dir, "customer/alice.yaml");
    const e2 = await rejects(appendEntry(shop, { path: "/customer/alice.yaml", mode: "patch", data: { name: "Hijacked" } }));
    expect(e2.check).toBe("authority");
    expect(await readData(dir, "customer/alice.yaml")).toBe(before);
    // the owner can still write
    await appendEntry(crm, { path: "/customer/alice.yaml", mode: "patch", data: { name: "Alice B" } });
    expect(alice.record_id).toHaveLength(22);
  });

  test("paths no worker owns are refused, including the manifest itself", async () => {
    const { shop, dir } = await two();
    const before = await readFile(join(dir, "root/yafi.yaml"), "utf8");
    for (const path of ["/yafi.yaml", "/elsewhere/x.yaml", "/quarantine/x.yaml".replace("quarantine", "orders")]) {
      expect((await rejects(createRecord(shop, { path, data: { a: 1 } }))).check).toBe("authority");
    }
    expect((await rejects(appendEntry(shop, { path: "/yafi.yaml", mode: "patch", data: { a: 1 } }))).check).toBe("authority");
    expect(await readFile(join(dir, "root/yafi.yaml"), "utf8")).toBe(before);
    // only the quarantine worker may write /quarantine/
    expect((await rejects(createRecord(shop, { path: "/quarantine/x.yaml", data: { source: "/a.yaml", reason: "r", removed: "x" } }))).check).toBe("authority");
  });

  test("the folder fixes the schema: a different record_schema is refused", async () => {
    const { shop } = await two();
    const e = await rejects(createRecord(shop, { path: "/order/1.yaml", record_schema: "customer@1", data: { name: "A", email: "a@x.io" } }));
    expect(e.check).toBe("authority");
    expect(e.message).toContain("uses order@1, not customer@1");
  });

  test("an unknown worker name has no authority anywhere", async () => {
    const { ctx } = await two();
    const e = await rejects(createRecord(asWorker(ctx, "ghost"), { path: "/order/1.yaml", data: {} }));
    expect(e.check).toBe("authority");
  });
});

describe("pipeline runner", () => {
  test("independent steps run in parallel; a step waits for everything it follows", async () => {
    const log: string[] = [];
    const nodes = [
      { name: "json" }, { name: "csv" }, { name: "parquet" },
      { name: "site", after: ["json", "csv", "parquet"] },
    ];
    const t0 = performance.now();
    const res = await runPipeline(nodes, async (n) => {
      log.push(`start ${n}`);
      await sleep(n === "site" ? 10 : 120);
      log.push(`end ${n}`);
    });
    expect(performance.now() - t0).toBeLessThan(120 * 3);                      // not sequential
    expect(log.slice(0, 3).sort()).toEqual(["start csv", "start json", "start parquet"]);
    expect(log.indexOf("start site")).toBeGreaterThan(log.lastIndexOf("end parquet") - 3);
    const ends = ["json", "csv", "parquet"].map((n) => res.get(n)!.end!);
    expect(res.get("site")!.start!).toBeGreaterThanOrEqual(Math.max(...ends) - 1);
    expect([...res.values()].every((r) => r.status === "ok")).toBe(true);
  });

  test("a chain runs in order", async () => {
    const log: string[] = [];
    await runPipeline([{ name: "c", after: ["b"] }, { name: "b", after: ["a"] }, { name: "a" }], async (n) => { await sleep(5); log.push(n); });
    expect(log).toEqual(["a", "b", "c"]);
  });

  test("a failure skips what follows it, and independent steps still finish unless failFast", async () => {
    const nodes = [{ name: "a" }, { name: "b", after: ["a"] }, { name: "c" }, { name: "d", after: ["c"] }];
    const run = async (n: string) => { if (n === "a") throw new Error("boom"); await sleep(10); };
    const r = await runPipeline(nodes, run);
    expect([r.get("a")!.status, r.get("b")!.status, r.get("c")!.status, r.get("d")!.status]).toEqual(["failed", "skipped", "ok", "ok"]);
    expect(r.get("a")!.error).toBe("boom");
    const ff = await runPipeline(nodes, run, { failFast: true });
    expect(ff.get("a")!.status).toBe("failed");
    expect(ff.get("b")!.status).toBe("skipped");
    expect(ff.get("d")!.status).toBe("skipped");
  });

  test("duplicate names, unknown dependencies and cycles are rejected", async () => {
    expect(validatePipeline([{ name: "a" }, { name: "a" }], "p")).toEqual(["p: duplicate step a"]);
    expect(validatePipeline([{ name: "a", after: ["x"] }], "p")).toEqual(["p: step a runs after unknown step x"]);
    expect(validatePipeline([{ name: "a", after: ["b"] }, { name: "b", after: ["a"] }], "p")[0]).toMatch(/cycle/);
    expect(validatePipeline([{ name: "a", after: ["a"] }], "p")[0]).toMatch(/cycle a -> a/);
    await expect(runPipeline([{ name: "a", after: ["a"] }], async () => {})).rejects.toThrow(/cycle/);
  });

  test("write checks without `after` run in parallel, all must pass, and one failure rejects", async () => {
    const { ctx } = await makeEnv({ plugins: [] });
    const alice = await seedAlice(ctx);
    const slow = (name: string, pass = true) => ({ name, run: async () => { await sleep(200); return { pass }; } });
    ctx.plugins = [slow("a"), slow("b"), slow("c")];
    const t0 = performance.now();
    await createRecord(ctx, { path: ORDER, data: order(alice.ref) });
    expect(performance.now() - t0).toBeLessThan(500);
    ctx.plugins = [slow("a"), slow("b", false)];
    const e = await rejects(createRecord(ctx, { path: "/order/2.yaml", data: order(alice.ref) }));
    expect(e.check).toBe("plugin");
    expect(e.message).toContain("check b rejected");
  });

  test("a check that follows a failed check never runs", async () => {
    const { ctx } = await makeEnv({ plugins: [] });
    const alice = await seedAlice(ctx);
    const ran: string[] = [];
    ctx.plugins = [
      { name: "perm", run: async () => (ran.push("perm"), { pass: false, reason: "no" }) },
      { name: "audit", after: ["perm"], run: async () => (ran.push("audit"), { pass: true }) },
    ];
    const e = await rejects(createRecord(ctx, { path: ORDER, data: order(alice.ref) }));
    expect(e.message).toBe("check perm rejected the write: no");
    expect(ran).toEqual(["perm"]);
  });
});

describe("build pipeline", () => {
  const cmd = (name: string, script: string, extra: Partial<Step> = {}): Step => ({ name, command: ["bun", "-e", script], ...extra });

  test("no build is required: with no steps, build only verifies and writes nothing", async () => {
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const r = await build({ ctx });
    expect(r.records).toBe(1);
    expect(r.steps).toEqual({});
    expect((await readdir(dir)).sort()).toEqual(["root"]);
  });

  test("a build over a path finds the workers under it and covers only their folders", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    const alice = await seedAlice(asWorker(ctx, "crm"));
    await createRecord(asWorker(ctx, "shop"), { path: ORDER, data: order(alice.ref) });
    const seen = join(dir, "seen.json");
    withBuild(ctx, [cmd("probe", `await Bun.write(${JSON.stringify(seen)}, JSON.stringify(await Bun.stdin.json()))`)]);

    const all = await build({ ctx });
    expect(all.workers.map((w) => `${w.worker}${w.folder}`).sort()).toEqual(["crm/customer/", "quarantine/quarantine/", "shop/order/"]);
    expect(all.records).toBe(2);

    const some = await build({ ctx, path: "/order/" });
    expect(some.workers).toEqual([{ worker: "shop", folder: "/order/", schema: "order@1" }]);
    expect(some.records).toBe(1);
    expect(some.brokenRefs).toEqual([]);     // references still resolve across the whole root

    const inside = await build({ ctx, path: "/order/1042/" });   // a path inside a folder uses that folder's rule
    expect(inside.workers).toEqual([{ worker: "shop", folder: "/order/", schema: "order@1" }]);
    expect(inside.records).toBe(1);

    await expect(build({ ctx, path: "order" })).rejects.toThrow(/build path/);
  });

  test("command steps get paths in and out, never the records", async () => {
    const { dir, ctx } = await makeEnv();
    const alice = await seedAlice(ctx);
    await createRecord(ctx, { path: ORDER, data: order(alice.ref) });
    const seen = join(dir, "seen.json");
    withBuild(ctx, [cmd("probe",
      `const i = await Bun.stdin.json(); await Bun.write(${JSON.stringify(seen)}, JSON.stringify({ i, env: [process.env.YAFI_ROOT, process.env.YAFI_IN, process.env.YAFI_OUT] }))`,
      { out: join(dir, "out") })]);
    const r = await build({ ctx });
    expect(r.steps.probe.status).toBe("ok");
    const { i, env } = JSON.parse(await readFile(seen, "utf8"));
    expect(Object.keys(i).sort()).toEqual(["in", "name", "out", "path", "root"]);
    expect(i.in).toEqual([join(dir, "root", "/")]);
    expect(i.out).toBe(join(dir, "out"));
    expect(env).toEqual([join(dir, "root"), join(dir, "root", "/"), join(dir, "out")]);
    expect(JSON.stringify(i)).not.toContain("Alice");
  });

  test("three converters run in parallel, then the site builder runs once all three are done", async () => {
    const { dir, ctx } = await makeEnv();
    await seedAlice(ctx);
    const out = join(dir, "out");
    const conv = (name: string) => cmd(name,
      `await Bun.sleep(250); await Bun.write(${JSON.stringify(join(out, name + ".done"))}, String(Date.now()))`, { timeout_ms: 5000 });
    const site = cmd("site", `
      const fs = require("fs"); const names = ["json","csv","parquet"];
      const missing = names.filter(n => !fs.existsSync(${JSON.stringify(out)} + "/" + n + ".done"));
      await Bun.write(${JSON.stringify(join(out, "site.txt"))}, missing.length ? "missing " + missing : "all three present");`,
      { after: ["json", "csv", "parquet"] });
    withBuild(ctx, [conv("json"), conv("csv"), conv("parquet"), site]);
    const t0 = performance.now();
    const r = await build({ ctx });
    const took = performance.now() - t0;
    expect(Object.values(r.steps).map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(await readFile(join(out, "site.txt"), "utf8")).toBe("all three present");
    expect(took).toBeLessThan(250 * 3);      // the converters overlapped
  });

  test("a failed step skips what follows it; the others still run, and the report says which", async () => {
    const { dir, ctx } = await makeEnv();
    await seedAlice(ctx);
    const mark = join(dir, "independent");
    withBuild(ctx, [
      cmd("broken", "process.exit(2)"),
      cmd("after-broken", "process.exit(0)", { after: ["broken"] }),
      cmd("independent", `await Bun.write(${JSON.stringify(mark)}, "ran")`),
    ]);
    const r = await build({ ctx });
    expect(r.steps.broken).toEqual({ status: "failed", error: "exit code 2" });
    expect(r.steps["after-broken"].status).toBe("skipped");
    expect(r.steps.independent.status).toBe("ok");
    expect(await readFile(mark, "utf8")).toBe("ran");
  });

  test("the default builds are ordinary steps: remove them, replace them, or keep them", async () => {
    const { dir, ctx } = await makeEnv();
    await seedAlice(ctx);
    const site = join(dir, "site");
    withBuild(ctx, [{ name: "static-site", builtin: "static-site", out: site }]);
    await build({ ctx });
    expect(await Bun.file(join(site, "index.html")).exists()).toBe(true);
    // replaced by the admin's own step under the same name
    const mine = join(dir, "mine");
    withBuild(ctx, [cmd("static-site", `await Bun.write(${JSON.stringify(mine)}, "custom")`)]);
    await build({ ctx });
    expect(await readFile(mine, "utf8")).toBe("custom");
    // an unknown builtin fails that step only
    withBuild(ctx, [{ name: "x", builtin: "nope", out: join(dir, "x") }]);
    expect((await build({ ctx })).steps.x.error).toContain("unknown builtin");
  });

  test("the sample export step reads the root by path and converts verified records", async () => {
    const { dir, ctx, publicJwk } = await makeEnv();
    const a = await seedAlice(ctx);
    const keysFile = join(dir, "jwks.json");
    await writeFile(keysFile, JSON.stringify({ keys: [publicJwk] }));
    await writeFile(join(dir, "root/customer/forged.yaml"), "name: x\n");   // unverified files are skipped
    withBuild(ctx, [{ name: "export-json", command: ["bun", "plugins/export-json.ts"], out: join(dir, "json") }]);
    const prev = process.env.YAFI_JWKS_FILE;
    process.env.YAFI_JWKS_FILE = keysFile;
    try { expect((await build({ ctx })).steps["export-json"].status).toBe("ok"); } finally { process.env.YAFI_JWKS_FILE = prev; if (prev === undefined) delete process.env.YAFI_JWKS_FILE; }
    const j = JSON.parse(await readFile(join(dir, "json/customer/alice.json"), "utf8"));
    expect(j).toMatchObject({ path: "/customer/alice.yaml", record_id: a.record_id, record_schema: "customer@1", state: { name: "Alice" } });
    expect(await Bun.file(join(dir, "json/customer/forged.json")).exists()).toBe(false);
  });
});

describe("quarantine as a worker", () => {
  test("a file written into a worker folder without going through its worker is quarantined whole", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    const alice = await seedAlice(asWorker(ctx, "crm"));
    await createRecord(asWorker(ctx, "shop"), { path: ORDER, data: order(alice.ref) });
    // e.g. a build step that wrote its output into the order folder
    await writeFile(join(dir, "root/order/report.yaml"), "totals:\n  orders: 1\n");
    const r = await build({ ctx });
    expect(r.quarantined).toHaveLength(1);
    expect(r.quarantined[0].path).toBe("/order/report.yaml");
    expect(await Bun.file(join(dir, "root/order/report.yaml")).exists()).toBe(false);   // removed from the original
    const q = await verifyFile(await readData(dir, r.quarantined[0].quarantinePath!.slice(1)), ctx.keys);
    expect(q.ok && q.header!.record_schema).toBe("quarantine@1");
    expect(q.state.removed).toBe("totals:\n  orders: 1\n");
    // the quarantine record was written by the quarantine worker, so only that worker owns it
    expect(ownerOf(ctx.manifest, r.quarantined[0].quarantinePath!)!.worker).toBe("quarantine");
    expect((await build({ ctx })).quarantined).toEqual([]);
  });

  test("a file holding another folder's schema is corrupt for its folder", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    await seedAlice(asWorker(ctx, "crm"));
    await mkdir(join(dir, "root/order"), { recursive: true });
    await writeFile(join(dir, "root/order/alice.yaml"), await readData(dir, "customer/alice.yaml")); // a valid file in the wrong folder
    const r = await build({ ctx });
    expect(r.quarantined).toHaveLength(1);
    expect(r.quarantined[0].reason).toContain("does not match folder schema order@1");
    expect(await Bun.file(join(dir, "root/order/alice.yaml")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "root/customer/alice.yaml")).exists()).toBe(true);
  });

  test("files outside every worker folder are reported and left alone", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    await mkdir(join(dir, "root/stray"), { recursive: true });
    await writeFile(join(dir, "root/stray/x.yaml"), "a: 1\n");
    const r = await build({ ctx });
    expect(r.unowned).toEqual(["/stray/x.yaml"]);
    expect(r.quarantined).toEqual([]);
    expect(await readData(dir, "stray/x.yaml")).toBe("a: 1\n");
  });

  test("the original is cut only after the quarantine write succeeds", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS });
    const alice = await seedAlice(asWorker({ ...ctx, plugins: [] }, "crm"));
    await createRecord(asWorker({ ...ctx, plugins: [] }, "shop"), { path: ORDER, data: order(alice.ref) });
    const text = (await readData(dir, ORDER)) + "---\nstatus: refunded\nyafi: patch 2026-11-01T20:12:09Z a.b.c\n";
    await writeData(dir, ORDER, text);
    // an admin write check rejects anything going into /quarantine/
    ctx.plugins = [{ name: "deny", run: async (i) => ({ pass: !i.path.startsWith("/quarantine/") }) }];
    const r = await build({ ctx });
    expect(r.quarantined[0].skipped).toContain("quarantine write failed");
    expect(await readData(dir, ORDER)).toBe(text);                                           // untouched
    expect(await readdir(join(dir, "root")).then((x) => x.includes("quarantine"))).toBe(false); // nothing half-written
  });

  test("without a quarantine worker in the manifest, nothing is moved", async () => {
    const { dir, ctx } = await makeEnv({ manifest: "workers:\n  main:\n    folders:\n      /customer/: customer@1\n", plugins: [] });
    await seedAlice(ctx);
    const text = (await readData(dir, "customer/alice.yaml")) + "---\ngarbage: 1\n";
    await writeData(dir, "customer/alice.yaml", text);
    const r = await build({ ctx });
    expect(r.quarantined[0].skipped).toContain("no quarantine worker");
    expect(await readData(dir, "customer/alice.yaml")).toBe(text);
    expect(r.records).toBe(1);   // still trusted up to the break
  });

  test("the quarantine pipeline runs after the move, with what moved, and cannot undo it", async () => {
    const { dir, ctx } = await makeEnv({ plugins: [] });
    await seedAlice(ctx);
    const alert = join(dir, "alert.json");
    const t = (await readData(dir, "customer/alice.yaml")) + "---\ngarbage: 1\n";
    await writeData(dir, "customer/alice.yaml", t);
    ctx.manifest = { ...ctx.manifest, pipelines: { ...ctx.manifest.pipelines, quarantine: [
      { name: "alert", command: ["bun", "-e", `const i = await Bun.stdin.json(); i.originalTailGone = !(await Bun.file(${JSON.stringify(join(dir, "root/customer/alice.yaml"))}).text()).includes("garbage"); await Bun.write(${JSON.stringify(alert)}, JSON.stringify(i))`] },
      { name: "second", command: ["bun", "-e", "process.exit(1)"], after: ["alert"] },
    ] } };
    const r = await build({ ctx });
    const info = JSON.parse(await readFile(alert, "utf8"));
    expect(info).toMatchObject({ source: "/customer/alice.yaml", whole: false, originalTailGone: true });
    expect(info.quarantine_path).toBe(r.quarantined[0].quarantinePath);
    expect(r.quarantined[0].followUps).toEqual({ alert: "ok", second: "failed: exit code 1" });
    expect(await readData(dir, "customer/alice.yaml")).not.toContain("garbage");               // the move stands
  });
});
