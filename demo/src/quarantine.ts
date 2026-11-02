// Auto-recovery for a file whose tail fails verification (see docs/record-format.md,
// "Broken or corrupted files"): move the bad tail, whole, into a quarantine record, then cut the
// original back to its last verified entry with a conditional write.
import type { WriterContext } from "./checks.ts";
import type { VerifyResult } from "./format.ts";
import { createRecord } from "./writer.ts";

export async function quarantineTail(
  ctx: WriterContext, path: string, file: { body: string; version: string }, v: VerifyResult,
): Promise<{ quarantinePath: string } | { skipped: string }> {
  if (!v.header) return { skipped: "header does not verify; nothing in the file can be trusted" };
  const tail = file.body.slice(v.validEnd);
  const prefix = file.body.slice(0, v.validEnd);
  const stamp = ctx.now().toISOString().replace(/[-:]|\.\d+/g, "");
  const quarantinePath = `/quarantine/${path.slice(1, -".yaml".length).replace(/\//g, "_")}-${stamp}.yaml`;

  // Save the removed text first, so a crash between the two writes can never lose it.
  await createRecord(ctx, {
    path: quarantinePath, record_schema: "quarantine@1",
    data: { source: `${path}#${v.header.id}`, reason: v.error ?? "verification failed", removed: tail },
  });
  const put = await ctx.storage.putIfMatch(path, prefix.endsWith("\n") ? prefix : prefix + "\n", file.version);
  if (!put.ok) return { skipped: `file changed while quarantining; ${quarantinePath} was kept, rerun the build` };
  return { quarantinePath };
}
