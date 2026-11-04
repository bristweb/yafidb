// Pipeline runner: steps with `after` dependencies. Steps with no dependency between them run in parallel.
export interface Node { name: string; after?: string[] }
export interface StepResult { status: "ok" | "failed" | "skipped"; error?: string; start?: number; end?: number }

/** Problems with a step list: duplicate names, unknown `after` targets, cycles. Empty when valid. */
export function validatePipeline(nodes: Node[], label: string): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const n of nodes) {
    if (names.has(n.name)) problems.push(`${label}: duplicate step ${n.name}`);
    names.add(n.name);
  }
  for (const n of nodes) for (const d of n.after ?? [])
    if (!names.has(d)) problems.push(`${label}: step ${n.name} runs after unknown step ${d}`);
  if (problems.length) return problems;
  const state = new Map<string, 1 | 2>(); // 1 visiting, 2 done
  const visit = (n: string, trail: string[]): void => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) { problems.push(`${label}: cycle ${[...trail.slice(trail.indexOf(n)), n].join(" -> ")}`); return; }
    state.set(n, 1);
    for (const d of nodes.find((x) => x.name === n)!.after ?? []) visit(d, [...trail, n]);
    state.set(n, 2);
  };
  for (const n of nodes) visit(n.name, []);
  return problems;
}

/**
 * Runs `run(name)` for every node, each as soon as everything it follows has succeeded.
 * A failed step skips everything after it. With `failFast`, no new step starts after a failure
 * (steps already running finish), which is what write screens need.
 */
export async function runPipeline(nodes: Node[], run: (name: string) => Promise<void>, o: { failFast?: boolean } = {}): Promise<Map<string, StepResult>> {
  const bad = validatePipeline(nodes, "pipeline");
  if (bad.length) throw new Error(bad.join("; "));
  const res = new Map<string, StepResult>();
  const inflight = new Map<string, Promise<void>>();
  let failed = false;
  const t0 = performance.now();
  const start = (n: Node) => {
    const r: StepResult = { status: "ok", start: performance.now() - t0 };
    inflight.set(n.name, (async () => {
      try { await run(n.name); }
      catch (e: any) { r.status = "failed"; r.error = String(e?.message ?? e); failed = true; }
      r.end = performance.now() - t0;
      res.set(n.name, r);
      inflight.delete(n.name);
    })());
  };
  while (res.size < nodes.length) {
    // Skip whatever can no longer run, until nothing more changes.
    for (let again = true; again;) {
      again = false;
      for (const n of nodes) {
        if (res.has(n.name) || inflight.has(n.name)) continue;
        if ((o.failFast && failed) || (n.after ?? []).some((d) => res.has(d) && res.get(d)!.status !== "ok")) {
          res.set(n.name, { status: "skipped" }); again = true;
        }
      }
    }
    for (const n of nodes)
      if (!res.has(n.name) && !inflight.has(n.name) && (n.after ?? []).every((d) => res.get(d)?.status === "ok")) start(n);
    if (!inflight.size) break;
    await Promise.race(inflight.values());
  }
  return res;
}
