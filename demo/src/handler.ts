// One worker's HTTP surface: two POST endpoints, no reads. Uses only Web standard APIs,
// so the same handler runs under Bun.serve and as a Cloudflare Worker.
import { WriteError, type WriterContext } from "./screens.ts";
import { appendEntry, createRecord } from "./writer.ts";

const MAX_BODY = 256 * 1024;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2) + "\n", { status, headers: { "content-type": "application/json" } });

export function createHandler(getCtx: () => Promise<WriterContext> | WriterContext, opts: { token?: string } = {}) {
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (pathname !== "/records" && pathname !== "/entries") return json(404, { error: "not found" });
    if (req.method !== "POST") return json(405, { error: "this worker accepts writes only (POST)" });
    if (opts.token && req.headers.get("authorization") !== `Bearer ${opts.token}`) return json(401, { error: "unauthorized" });
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY) throw new WriteError("request", "body too large", 413);
      let body: any;
      try { body = JSON.parse(raw); } catch { throw new WriteError("request", "body must be JSON", 400); }
      const ctx = await getCtx();
      const out = pathname === "/records"
        ? await createRecord(ctx, { path: body?.path, schema: body?.schema, data: body?.data })
        : await appendEntry(ctx, { path: body?.path, mode: body?.mode, data: body?.data });
      return json(pathname === "/records" ? 201 : 200, out);
    } catch (e: any) {
      if (e instanceof WriteError) return json(e.status, { error: e.message, screen: e.screen });
      return json(500, { error: "internal error" });
    }
  };
}
