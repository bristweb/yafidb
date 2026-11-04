// Pipeline steps in any language: a command (JSON on stdin) or an HTTP endpoint (JSON POST).
// Write screens answer {"pass": true|false, "reason"?: string}. Neither kind ever receives the database,
// and neither writes records; only Yafi signs and appends.
import type { PluginScreen } from "./screens.ts";
import type { Step } from "./manifest.ts";

export interface ScreenConfig { name: string; command?: string[]; url?: string; timeout_ms?: number; after?: string[] }

export async function callUrl(url: string, input: unknown, timeout_ms = 5000, f: typeof fetch = fetch): Promise<any> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(timeout_ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text().then((t) => (t.trim() ? JSON.parse(t) : null));
}

/** Runs any program: JSON on stdin, stdout returned as text. Bun/Node only. */
export async function runCommand(cmd: string[], input: unknown, o: { cwd: string; timeout_ms?: number; env?: Record<string, string> }): Promise<string> {
  if (typeof Bun === "undefined") throw new Error("this runtime cannot run commands; use a url step");
  const p = Bun.spawn(cmd, { cwd: o.cwd, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "ignore", env: { ...process.env, ...o.env } });
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => { p.kill("SIGKILL"); p.stdout.cancel().catch(() => {}); rej(new Error("timed out")); }, o.timeout_ms ?? 5000);
  });
  try {
    const run = Promise.all([new Response(p.stdout).text(), p.exited]);
    const [out, code] = await Promise.race([run, timeout]);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return out;
  } finally { clearTimeout(timer); }
}

export function urlScreen(c: ScreenConfig, f: typeof fetch = fetch): PluginScreen {
  return { name: c.name, after: c.after, run: (input) => callUrl(c.url!, input, c.timeout_ms, f) };
}

export function commandScreen(c: ScreenConfig, cwd: string): PluginScreen {
  return { name: c.name, after: c.after, run: async (input) => JSON.parse(await runCommand(c.command!, input, { cwd, timeout_ms: c.timeout_ms })) };
}

/** A write screen from a manifest step. */
export function screenFromStep(s: Step, cwd: string): PluginScreen {
  if (s.builtin) throw new Error(`write step ${s.name} cannot be a builtin`);
  return s.url ? urlScreen(s as ScreenConfig) : commandScreen(s as ScreenConfig, cwd);
}
