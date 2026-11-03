import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPath } from "../src/check.ts";
import { build } from "../src/build.ts";
import { verifyFile } from "../src/format.ts";
import { importJwks, importSigner } from "../src/jws.ts";
import { loadManifest, ManifestError, ownerOf, parseManifest, signManifest, MANIFEST_PATH, type Step } from "../src/manifest.ts";
import { runPipeline, validatePipeline } from "../src/pipeline.ts";
import { appendEntry, createRecord } from "../src/writer.ts";
import { asWorker } from "../src/node-context.ts";
import { BASE_MANIFEST, makeEnv, moved, order, readData, rejects, root, seedAlice, withBuild, writeData } from "./helpers.ts";

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
    expect(text).toContain("schema: customer@1");
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

  test("the folder fixes the schema: a different schema is refused", async () => {
    const { shop } = await two();
    const e = await rejects(createRecord(shop, { path: "/order/1.yaml", schema: "customer@1", data: { name: "A", email: "a@x.io" } }));
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
    expect(some.steps).toEqual({ probe: { status: "ok" } });

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

  test("the sample export step reads the root by path and converts what it reads", async () => {
    const { dir, ctx } = await makeEnv();
    const a = await seedAlice(ctx);
    await writeFile(join(dir, "root/customer/stray.yaml"), "name: x\n");   // no header: not a record, skipped
    withBuild(ctx, [{ name: "export-json", command: ["bun", "plugins/export-json.ts"], out: join(dir, "json") }]);
    expect((await build({ ctx })).steps["export-json"].status).toBe("ok");
    const j = JSON.parse(await readFile(join(dir, "json/customer/alice.json"), "utf8"));
    expect(j).toMatchObject({ path: "/customer/alice.yaml", record_id: a.record_id, schema: "customer@1", state: { name: "Alice" } });
    expect(await Bun.file(join(dir, "json/customer/stray.json")).exists()).toBe(false);
  });
});

describe("check tool", () => {
  /** A project directory around the test root, so the standalone command can load it. */
  async function project(env: Awaited<ReturnType<typeof makeEnv>>) {
    const { dir, publicJwk, privateJwk } = env;
    await mkdir(join(dir, "keys"), { recursive: true });
    await writeFile(join(dir, "keys/public.jwks.json"), JSON.stringify({ keys: [publicJwk] }));
    await writeFile(join(dir, "keys/private.jwk.json"), JSON.stringify(privateJwk));
    await writeFile(join(dir, "yafidb.yaml"), `storage:\n  type: local\n  dir: root\nschemas: ${join(root, "schemas")}\nkeys:\n  public: keys/public.jwks.json\n  private: keys/private.jwk.json\n`);
  }
  const run = async (dir: string, ...args: string[]) => {
    const p = Bun.spawn(["bun", "src/check-cli.ts", ...args], { cwd: root, env: { ...process.env, YAFI_PROJECT: dir }, stdout: "pipe", stderr: "pipe" });
    return { out: await new Response(p.stdout).text(), code: await p.exited };
  };

  test("`check` is a standalone command: it quarantines what is wrong and reports it", async () => {
    const env = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    const { dir, ctx } = env;
    await project(env);
    await seedAlice(asWorker(ctx, "crm"));
    await writeFile(join(dir, "root/order-bad.yaml"), "x: 1\n");   // outside every folder
    await mkdir(join(dir, "root/order"), { recursive: true });
    await writeFile(join(dir, "root/order/junk.yaml"), "x: 1\n");
    const r = await run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("QUARANTINE /order/junk.yaml");
    expect(r.out).toContain("UNOWNED /order-bad.yaml");
    expect(r.out).toContain("1 ok, 1 quarantined, 0 failed, 1 unowned");
    expect(await Bun.file(join(dir, "root/order/junk.yaml")).exists()).toBe(false);
    expect((await run(dir, "/customer/alice.yaml")).out).toContain("1 ok, 0 quarantined");   // one file by path
  });

  test("a build can opt in: the check runs as a step and the others run after it", async () => {
    const env = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    const { dir, ctx } = env;
    await project(env);
    await seedAlice(asWorker(ctx, "crm"));
    await mkdir(join(dir, "root/order"), { recursive: true });
    await writeFile(join(dir, "root/order/junk.yaml"), "x: 1\n");
    const prev = process.env.YAFI_PROJECT;
    process.env.YAFI_PROJECT = dir;
    withBuild(ctx, [
      { name: "check", command: ["bun", "src/check-cli.ts", "/"] },
      { name: "export-json", command: ["bun", "plugins/export-json.ts"], out: join(dir, "json"), after: ["check"] },
    ]);
    try {
      const r = await build({ ctx });
      expect(r.steps).toEqual({ check: { status: "ok" }, "export-json": { status: "ok" } });
    } finally { if (prev === undefined) delete process.env.YAFI_PROJECT; else process.env.YAFI_PROJECT = prev; }
    expect(await Bun.file(join(dir, "root/order/junk.yaml")).exists()).toBe(false);          // the check quarantined it
    expect(await readdir(join(dir, "root/quarantine"))).toHaveLength(1);
    expect(await Bun.file(join(dir, "json/customer/alice.json")).exists()).toBe(true);
  });

  test("the check fails the step when it cannot quarantine, so later steps are skipped", async () => {
    const env = await makeEnv({ manifest: "workers:\n  crm:\n    folders:\n      /customer/: customer@1\n", plugins: [] });
    const { dir, ctx } = env;
    await project(env);
    await seedAlice(asWorker(ctx, "crm"));
    await writeFile(join(dir, "root/customer/junk.yaml"), "x: 1\n");
    const prev = process.env.YAFI_PROJECT;
    process.env.YAFI_PROJECT = dir;
    withBuild(ctx, [
      { name: "check", command: ["bun", "src/check-cli.ts", "/"] },
      { name: "export-json", command: ["bun", "plugins/export-json.ts"], out: join(dir, "json"), after: ["check"] },
    ]);
    try {
      const r = await build({ ctx });
      expect(r.steps.check.status).toBe("failed");
      expect(r.steps["export-json"].status).toBe("skipped");
    } finally { if (prev === undefined) delete process.env.YAFI_PROJECT; else process.env.YAFI_PROJECT = prev; }
  });

  test("a worker checks a file before writing, even to create it", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    const crm = asWorker(ctx, "crm");
    await mkdir(join(dir, "root/customer"), { recursive: true });
    await writeFile(join(dir, "root/customer/alice.yaml"), "name: forged\n");   // not written through the worker
    const e = await rejects(createRecord(crm, { path: "/customer/alice.yaml", data: { name: "Alice", email: "a@x.io" } }));
    expect(e.check).toBe("existing");
    expect(e.message).toContain("moved to /quarantine/");
    expect((await createRecord(crm, { path: "/customer/alice.yaml", data: { name: "Alice", email: "a@x.io" } })).path).toBe("/customer/alice.yaml");
  });
});

describe("quarantine as a worker", () => {
  test("a file written into a worker folder without going through its worker is quarantined whole", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    const alice = await seedAlice(asWorker(ctx, "crm"));
    await createRecord(asWorker(ctx, "shop"), { path: ORDER, data: order(alice.ref) });
    // e.g. a build step that wrote its output into the order folder
    await writeFile(join(dir, "root/order/report.yaml"), "totals:\n  orders: 1\n");
    const m = moved(await checkPath(ctx));
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe("/order/report.yaml");
    expect(await Bun.file(join(dir, "root/order/report.yaml")).exists()).toBe(false);   // removed from the original
    const q = await verifyFile(await readData(dir, m[0].quarantinePath.slice(1)), ctx.keys);
    expect(q.ok && q.header!.schema).toBe("quarantine@1");
    expect(q.state.removed).toBe("totals:\n  orders: 1\n");
    // the quarantine record was written by the quarantine worker, so only that worker owns it
    expect(ownerOf(ctx.manifest, m[0].quarantinePath)!.worker).toBe("quarantine");
    expect((await checkPath(ctx)).every((r) => r.status === "ok")).toBe(true);
  });

  test("a file holding another folder's schema is corrupt for its folder", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    await seedAlice(asWorker(ctx, "crm"));
    await mkdir(join(dir, "root/order"), { recursive: true });
    await writeFile(join(dir, "root/order/alice.yaml"), await readData(dir, "customer/alice.yaml")); // a valid file in the wrong folder
    const m = moved(await checkPath(ctx));
    expect(m).toHaveLength(1);
    expect(m[0].reason).toContain("does not match folder schema order@1");
    expect(await Bun.file(join(dir, "root/order/alice.yaml")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "root/customer/alice.yaml")).exists()).toBe(true);
  });

  test("files outside every worker folder are not checked, and left alone", async () => {
    const { dir, ctx } = await makeEnv({ manifest: TWO_WORKERS, plugins: [] });
    await mkdir(join(dir, "root/stray"), { recursive: true });
    await writeFile(join(dir, "root/stray/x.yaml"), "a: 1\n");
    expect((await checkPath(ctx)).filter((r) => r.status === "unowned").map((r) => r.path)).toEqual(["/stray/x.yaml"]);
    expect((await build({ ctx })).records).toBe(0);
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
    const r = await checkPath(ctx);
    expect(r.find((x) => x.status === "failed")).toMatchObject({ skipped: expect.stringContaining("quarantine write failed") });
    expect(await readData(dir, ORDER)).toBe(text);                                           // untouched
    expect(await readdir(join(dir, "root")).then((x) => x.includes("quarantine"))).toBe(false); // nothing half-written
  });

  test("without a quarantine worker in the manifest, nothing is moved", async () => {
    const { dir, ctx } = await makeEnv({ manifest: "workers:\n  main:\n    folders:\n      /customer/: customer@1\n", plugins: [] });
    await seedAlice(ctx);
    const text = (await readData(dir, "customer/alice.yaml")) + "---\ngarbage: 1\n";
    await writeData(dir, "customer/alice.yaml", text);
    const r = await checkPath(ctx);
    expect(r[0]).toMatchObject({ status: "failed", skipped: expect.stringContaining("no quarantine worker") });
    expect(await readData(dir, "customer/alice.yaml")).toBe(text);
    expect((await build({ ctx })).records).toBe(1);   // the build reads it anyway
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
    const m = moved(await checkPath(ctx));
    const info = JSON.parse(await readFile(alert, "utf8"));
    expect(info).toMatchObject({ source: "/customer/alice.yaml", whole: false, originalTailGone: true });
    expect(info.quarantine_path).toBe(m[0].quarantinePath);
    expect(m[0].followUps).toEqual({ alert: "ok", second: "failed: exit code 1" });
    expect(await readData(dir, "customer/alice.yaml")).not.toContain("garbage");               // the move stands
  });
});

describe("header version", () => {
  const withVersion = (text: string, v: string) => text.replace("yafi: header@1.0.0 ", `yafi: ${v} `);

  test("the signed header holds the versioned mode, the time, a nonce and the schema, and nothing else", async () => {
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const text = await readData(dir, "customer/alice.yaml");
    expect(text).not.toContain("yafi_schema");
    expect(text).not.toContain("record_schema");
    const jws = text.split("\n")[1].split(" ")[3];
    const payload = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["iat", "mode", "nonce", "schema"]);
    expect(payload).toMatchObject({ mode: "header@1.0.0", schema: "customer@1" });
  });

  test("only an exact match of a listed version verifies; any other string is rejected", async () => {
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const text = await readData(dir, "customer/alice.yaml");
    expect((await verifyFile(text, ctx.keys)).ok).toBe(true);
    for (const v of ["header@1.0.1", "header@1.0", "header@1", "header@1.0.0-beta", "header@stable", "header@1.0.0.0"]) {
      const r = await verifyFile(withVersion(text, v), ctx.keys);
      expect(r.ok).toBe(false);
      expect(r.error).toBe(`header: unsupported header version ${v}`);
    }
    expect((await verifyFile(withVersion(text, "header"), ctx.keys)).ok).toBe(false);
  });

  test("a supported version still needs a signature that covers it", async () => {
    // Listing a second version is a decision of the checking tool; the signed mode must equal the line's mode.
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const fmt = await import("../src/format.ts");
    const list = fmt.SUPPORTED_HEADERS as string[];
    list.push("header@beta");
    try {
      const r = await verifyFile(withVersion(await readData(dir, "customer/alice.yaml"), "header@beta"), ctx.keys);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("signed mode differs");
    } finally { list.pop(); }
  });

  test("the worker treats an unsupported version as corrupt: quarantined whole, then the write can be retried", async () => {
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const newer = withVersion(await readData(dir, "customer/alice.yaml"), "header@2.0.0");
    await writeData(dir, "customer/alice.yaml", newer);
    const e = await rejects(appendEntry(ctx, { path: "/customer/alice.yaml", mode: "patch", data: { name: "B" } }));
    expect(e.check).toBe("existing");
    expect(e.message).toContain("unsupported header version header@2.0.0");
    expect(e.message).toContain("moved to /quarantine/");
    expect(await Bun.file(join(dir, "root/customer/alice.yaml")).exists()).toBe(false);
    const qp = e.message.match(/moved to (\/quarantine\/[^,]+), retry/)![1];
    expect((await verifyFile(await readData(dir, qp.slice(1)), ctx.keys)).state.removed).toBe(newer);
  });

  test("a build reads without checking: it does not look at versions or signatures", async () => {
    const { ctx, dir } = await makeEnv();
    await seedAlice(ctx);
    const out = join(dir, "json");
    withBuild(ctx, [{ name: "export-json", command: ["bun", "plugins/export-json.ts"], out }]);
    await writeData(dir, "customer/alice.yaml", withVersion(await readData(dir, "customer/alice.yaml"), "header@2.0.0"));
    const r = await build({ ctx });
    expect(r.steps["export-json"].status).toBe("ok");
    expect(JSON.parse(await readFile(join(out, "customer/alice.json"), "utf8")).state.name).toBe("Alice");
    expect(await Bun.file(join(dir, "root/customer/alice.yaml")).exists()).toBe(true);   // nothing moved
  });
});
