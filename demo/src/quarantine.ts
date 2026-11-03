// Quarantine: moves corrupt data to the quarantine worker. It is part of the check tool (check.ts) and nothing else calls it.
// One rule for both cases: the problem data is logged to quarantine first, and only once that succeeds is the original
// changed. No locks. The record's path comes from a hash of the logged text, so repeating a quarantine of the same bytes
// finds the record and adds none. If the file is still there at the next check, that check logs again (a no-op for the
// same bytes, a new record if the file changed meanwhile) and retries.
//   - a file that fails part-way keeps its verified entries; the tail is logged, then the file is overwritten with the
//     verified part (a conditional write on the version that was read)
//   - a file with no verified header (including an unsupported version), or the wrong schema for its folder, is logged
//     whole, then a plain delete is attempted and its result is ignored
import type { WriterContext } from "./checks.ts";
import type { VerifyResult } from "./format.ts";
import { quarantineTarget } from "./manifest.ts";
import { runPipeline } from "./pipeline.ts";
import { callUrl, runCommand } from "./plugins.ts";
import { sha256hex } from "./util.ts";
import { createRecord } from "./writer.ts";

export type QuarantineResult =
  | { quarantinePath: string; followUps: Record<string, string> }
  | { lost: true }          // the overwrite lost to a newer write, so nothing was changed: read and check it again
  | { skipped: string };

/** `keepPrefix`: the file has a verified prefix worth keeping. Otherwise the whole file is moved. */
export async function quarantineFile(
  ctx: WriterContext, path: string, file: { body: string; version: string }, v: VerifyResult, reason: string, keepPrefix = !!v.header,
): Promise<QuarantineResult> {
  const target = quarantineTarget(ctx.manifest);
  if (!target) return { skipped: "the manifest has no quarantine worker" };
  if (!ctx.signer) return { skipped: "no signing key; nothing moved" };
  const whole = !keepPrefix || !v.header;
  const removed = whole ? file.body : file.body.slice(v.validEnd);
  const hash = (await sha256hex(removed)).slice(0, 16);
  const quarantinePath = `${target.folder}${path.slice(1, -".yaml".length).replace(/\//g, "_")}-${hash}.yaml`;

  // Log first, as the quarantine worker. If this fails, the original is left alone.
  // The record may already exist (an earlier or concurrent quarantine of the same bytes): that is as good as writing it.
  try {
    await createRecord({ ...ctx, worker: target.worker }, {
      path: quarantinePath,
      data: { source: whole ? path : `${path}#${v.header!.id}`, reason, removed },
    });
  } catch (e: any) {
    if (!(await ctx.storage.get(quarantinePath))) return { skipped: `quarantine write failed: ${e.message}` };
  }

  if (whole) {
    // Only an attempt: nothing depends on the result. If the file is still there, the next check finds it again.
    await ctx.storage.delete(path).catch(() => {});
  } else {
    const prefix = file.body.slice(0, v.validEnd);
    if (!(await ctx.storage.putIfMatch(path, prefix.endsWith("\n") ? prefix : prefix + "\n", file.version)).ok) return { lost: true };
  }

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
