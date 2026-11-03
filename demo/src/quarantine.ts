// Quarantine: moves corrupt data to the quarantine worker. It is part of the check tool (check.ts) and nothing else calls it.
// Order: write the quarantine record, then cut the original with a conditional write on the version that was read,
// then the caller answers "retry". No locks. The record's path comes from a hash of the removed text, so concurrent
// or repeated quarantines of the same bytes meet at one record (the second finds it and moves on), and a crash between
// the steps is finished by the next check. Whoever loses the conditional cut reports `lost` and re-reads.
//   - a file that fails part-way keeps its verified entries; the tail moves, the file is cut back
//   - a file with no verified header (including an unsupported version), or the wrong schema for its folder, moves whole and is deleted
import type { WriterContext } from "./checks.ts";
import type { VerifyResult } from "./format.ts";
import { quarantineTarget } from "./manifest.ts";
import { runPipeline } from "./pipeline.ts";
import { callUrl, runCommand } from "./plugins.ts";
import { sha256hex } from "./util.ts";
import { createRecord } from "./writer.ts";

export type QuarantineResult =
  | { quarantinePath: string; followUps: Record<string, string> }
  | { lost: true }          // the conditional cut failed: the file changed or another check already cut it
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

  // Save the removed text first, as the quarantine worker, so a crash between the two steps never loses it.
  // The record may already exist (a concurrent or earlier quarantine of the same bytes): that is as good as writing it.
  try {
    await createRecord({ ...ctx, worker: target.worker }, {
      path: quarantinePath,
      data: { source: whole ? path : `${path}#${v.header!.id}`, reason, removed },
    });
  } catch (e: any) {
    if (!(await ctx.storage.get(quarantinePath))) return { skipped: `quarantine write failed: ${e.message}` };
  }

  let ok: boolean;
  if (whole) ok = await ctx.storage.deleteIfMatch(path, file.version);
  else {
    const prefix = file.body.slice(0, v.validEnd);
    ok = (await ctx.storage.putIfMatch(path, prefix.endsWith("\n") ? prefix : prefix + "\n", file.version)).ok;
  }
  if (!ok) return { lost: true };

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
