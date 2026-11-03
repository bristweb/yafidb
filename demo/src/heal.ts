// Quarantine: corrupt data found by anyone (a worker, a build, a reader) goes to the quarantine worker.
// Only after that write succeeds is the data removed from the original, so it lives in one place.
//   - a file that fails part-way keeps its verified entries; the tail moves, the file is cut back
//   - a file with no verified header, or the wrong schema for its folder, moves whole and is deleted
import type { WriterContext } from "./checks.ts";
import type { VerifyResult } from "./format.ts";
import { quarantineTarget } from "./manifest.ts";
import { runPipeline } from "./pipeline.ts";
import { callUrl, runCommand } from "./plugins.ts";
import { createRecord } from "./writer.ts";

export type HealResult =
  | { quarantinePath: string; followUps: Record<string, string> }
  | { skipped: string };

/** `keepPrefix`: the file has a verified prefix worth keeping. Otherwise the whole file is moved. */
export async function healFile(
  ctx: WriterContext, path: string, file: { body: string; version: string }, v: VerifyResult, reason: string, keepPrefix = !!v.header,
): Promise<HealResult> {
  const target = quarantineTarget(ctx.manifest);
  if (!target) return { skipped: "the manifest has no quarantine worker" };
  if (!ctx.signer) return { skipped: "no signing key; nothing moved" };
  const whole = !keepPrefix || !v.header;
  const removed = whole ? file.body : file.body.slice(v.validEnd);
  const stamp = ctx.now().toISOString().replace(/[-:]|\.\d+/g, "");
  const quarantinePath = `${target.folder}${path.slice(1, -".yaml".length).replace(/\//g, "_")}-${stamp}.yaml`;

  // Save the removed text first, as the quarantine worker, so a crash between the two steps never loses it.
  try {
    await createRecord({ ...ctx, worker: target.worker }, {
      path: quarantinePath,
      data: { source: whole ? path : `${path}#${v.header!.id}`, reason, removed },
    });
  } catch (e: any) { return { skipped: `quarantine write failed: ${e.message}` }; }

  let ok: boolean;
  if (whole) ok = await ctx.storage.deleteIfMatch(path, file.version);
  else {
    const prefix = file.body.slice(0, v.validEnd);
    ok = (await ctx.storage.putIfMatch(path, prefix.endsWith("\n") ? prefix : prefix + "\n", file.version)).ok;
  }
  if (!ok) return { skipped: `file changed while quarantining; ${quarantinePath} was kept, run again` };

  // Admin steps after the move (for example an alert). They cannot undo it; their results are reported.
  const steps = ctx.manifest.pipelines.quarantine;
  const info = { source: path, quarantine_path: quarantinePath, reason, whole };
  const results = await runPipeline(steps, async (name) => {
    const s = steps.find((x) => x.name === name)!;
    if (s.url) await callUrl(s.url, info, s.timeout_ms);
    else await runCommand(s.command!, info, { cwd: ctx.cwd ?? ".", timeout_ms: s.timeout_ms });
  });
  return { quarantinePath, followUps: Object.fromEntries([...results].map(([n, r]) => [n, r.status === "failed" ? `failed: ${r.error}` : r.status])) };
}
