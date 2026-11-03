// Static site rendering: a root index, an index per folder, and a page per record.
import { posix } from "node:path";
import type { BuiltRecord } from "./build.ts";
import { REF_LIKE } from "./refs.ts";

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export const htmlPath = (p: string) => p.replace(/\.yaml$/, ".html");
const rel = (from: string, to: string) => posix.relative(posix.dirname(from), to) || ".";

const CSS = `body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}
dl{margin:0 0 0 1rem}dt{font-weight:600}dd{margin:0 0 .4rem 1rem}pre{background:#f5f5f5;padding:.5rem;overflow:auto}
code,.id{font:13px ui-monospace,monospace;color:#555}table{border-collapse:collapse}td,th{padding:.2rem .7rem;border-bottom:1px solid #ddd;text-align:left}
.broken{color:#b00;text-decoration:underline wavy}.warn{background:#fff4d6;padding:.5rem 1rem}`;

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style>\n${body}\n`;

export function renderSite(records: BuiltRecord[]): Map<string, string> {
  const files = new Map<string, string>();
  const backlinks = new Map<string, { from: string; pointer: string }[]>();
  for (const r of records) for (const x of r.refs) if (x.ref && !x.error)
    (backlinks.get(x.ref.path) ?? backlinks.set(x.ref.path, []).get(x.ref.path)!).push({ from: r.path, pointer: x.pointer });

  for (const r of records) {
    const self = htmlPath(r.path);
    const refMap = new Map(r.refs.map((x) => [x.raw, x]));
    const value = (v: any): string => {
      if (typeof v === "string") {
        if (REF_LIKE.test(v)) {
          const x = refMap.get(v);
          if (x?.ref && !x.error) {
            const to = htmlPath(x.ref.path) + (x.ref.entryId ? `#e-${x.ref.entryId}` : "");
            return `<a href="${esc(rel(self, to))}">${esc(v)}</a>`;
          }
          return `<span class="broken" title="${esc(x?.error ?? "unresolved")}">${esc(v)}</span>`;
        }
        return v.includes("\n") ? `<pre>${esc(v)}</pre>` : esc(v) || "<code>(empty)</code>";
      }
      if (Array.isArray(v)) return `<ol>${v.map((x) => `<li>${value(x)}</li>`).join("")}</ol>`;
      if (v && typeof v === "object")
        return `<dl>${Object.entries(v).map(([k, x]) => `<dt>${esc(k)}</dt><dd>${value(x)}</dd>`).join("")}</dl>`;
      return `<code>${esc(JSON.stringify(v))}</code>`;
    };
    const h = r.v.header!;
    const back = (backlinks.get(r.path) ?? []).map((b) =>
      `<li><a href="${esc(rel(self, htmlPath(b.from)))}">${esc(b.from)}</a> <code>${esc(b.pointer)}</code></li>`).join("");
    files.set(self, page(r.path, `
<p><a href="${esc(rel(self, `${r.folder}index.html`))}">&larr; ${esc(r.folder)}</a></p>
<h1>${esc(r.path)}</h1>
<p class="id">record id ${esc(h.id)} &middot; ${esc(h.schema)} &middot; created ${esc(h.time)} &middot; <a href="${esc(posix.basename(r.path))}">raw file</a></p>
${r.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
<h2>Current state</h2>${value(r.v.state)}
${back ? `<h2>Referenced by</h2><ul>${back}</ul>` : ""}
<h2>History</h2><table><tr><th>#</th><th>mode</th><th>time</th><th>entry id</th></tr>
${r.v.entries.map((e) => `<tr id="e-${esc(e.id)}"><td>${e.seq}</td><td>${e.mode}</td><td>${esc(e.time)}</td><td class="id">${esc(e.id)}</td></tr>`).join("")}</table>`));
  }

  const types = new Map<string, BuiltRecord[]>();
  for (const r of records) (types.get(r.folder) ?? types.set(r.folder, []).get(r.folder)!).push(r);
  for (const [t, list] of types) {
    const idx = `${t}index.html`;
    files.set(idx, page(t, `<p><a href="${esc(rel(idx, "/index.html"))}">&larr; all folders</a></p><h1>${esc(t)}</h1><table><tr><th>record</th><th>entries</th><th>last entry</th></tr>
${list.map((r) => `<tr><td><a href="${esc(rel(idx, htmlPath(r.path)))}">${esc(r.path)}</a></td><td>${r.v.entries.length}</td><td>${esc(r.v.entries.at(-1)?.time ?? "")}</td></tr>`).join("")}</table>`));
  }
  files.set("/index.html", page("YafiDB demo", `<h1>YafiDB demo</h1><ul>${[...types].map(([t, l]) =>
    `<li><a href="${esc(t.slice(1))}index.html">${esc(t)}</a> (${l.length})</li>`).join("")}</ul>`));
  return files;
}
