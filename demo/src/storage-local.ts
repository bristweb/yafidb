// Local-disk storage. The version is the SHA-256 of the file, and the
// compare-and-swap runs under an exclusive lock file so two writers cannot interleave.
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertPath, type Storage } from "./storage.ts";
import { sha256hex } from "./util.ts";

export class LocalStorage implements Storage {
  constructor(private root: string) {}
  private file(p: string) { assertPath(p); return join(this.root, p); }

  async get(path: string) {
    try {
      const body = await readFile(this.file(path), "utf8");
      return { body, version: await sha256hex(body) };
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  private async locked<T>(f: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(f), { recursive: true });
    const lock = f + ".lock";
    let fh;
    for (let i = 0; ; i++) {
      try { fh = await open(lock, "wx"); break; }
      catch (e: any) {
        if (e.code !== "EEXIST" || i > 200) throw e;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try { return await fn(); }
    finally { await fh.close(); await rm(lock, { force: true }); }
  }

  async putIfMatch(path: string, body: string, expected: string | null) {
    const f = this.file(path);
    return this.locked(f, async () => {
      const cur = await this.get(path);
      if ((cur?.version ?? null) !== expected) return { ok: false as const };
      const tmp = f + ".tmp";
      await writeFile(tmp, body);
      await rename(tmp, f);
      return { ok: true as const, version: await sha256hex(body) };
    });
  }

  async delete(path: string) { await rm(this.file(path), { force: true }); }

  async list() {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      let ents;
      try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}/${e.name}`);
        else if (e.name.endsWith(".yaml")) out.push(`${prefix}/${e.name}`);
      }
    };
    await walk(this.root, "");
    return out.sort();
  }
}
