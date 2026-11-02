// Plugged-in checks. A check gets JSON and answers {"pass": true|false, "reason"?: string}.
// It never writes; only Yafi signs and appends.
import type { PluginCheck } from "./checks.ts";

export interface CheckConfig { name: string; command?: string[]; url?: string; timeout_ms?: number }

export function urlCheck(c: CheckConfig, f: typeof fetch = fetch): PluginCheck {
  return {
    name: c.name,
    async run(input) {
      const r = await f(c.url!, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(c.timeout_ms ?? 5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as any;
    },
  };
}

/** Runs any program in any language: JSON on stdin, JSON on stdout. Bun/Node only. */
export function commandCheck(c: CheckConfig, cwd: string): PluginCheck {
  return {
    name: c.name,
    async run(input) {
      const p = Bun.spawn(c.command!, { cwd, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "ignore" });
      let timer: Timer | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => { p.kill("SIGKILL"); p.stdout.cancel().catch(() => {}); rej(new Error("timed out")); }, c.timeout_ms ?? 5000);
      });
      try {
        const run = Promise.all([new Response(p.stdout).text(), p.exited]);
        const [out, code] = await Promise.race([run, timeout]);
        if (code !== 0) throw new Error(`exit code ${code}`);
        return JSON.parse(out);
      } finally { clearTimeout(timer); }
    },
  };
}
