// Local writers: `bun run serve`. One handler per worker, each accepting POST only:
//   POST /workers/<name>/records   POST /workers/<name>/entries
import { createHandler } from "./handler.ts";
import { asWorker, loadContext } from "./node-context.ts";

const project = new URL("..", import.meta.url).pathname;
const base = await loadContext(project);
const handlers = Object.fromEntries(Object.keys(base.manifest.workers).map((w) =>
  [w, createHandler(() => asWorker(base, w), { token: process.env.YAFI_TOKEN })]));

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  fetch(req) {
    const u = new URL(req.url);
    const m = /^\/workers\/([^/]+)(\/.*)$/.exec(u.pathname);
    const h = m && Object.hasOwn(handlers, m[1]) ? handlers[m[1]] : null;
    if (!m || !h) return new Response(JSON.stringify({ error: "not found" }) + "\n", { status: 404, headers: { "content-type": "application/json" } });
    u.pathname = m[2];
    return h(new Request(u, req));
  },
});
console.log(`YafiDB writers on ${server.url}: ${Object.keys(handlers).map((w) => `/workers/${w}`).join(" ")} (POST /records, POST /entries)`);
