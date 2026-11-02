// Local writer: `bun run serve`. Accepts POST /records and POST /entries only.
import { createHandler } from "./handler.ts";
import { loadContext } from "./node-context.ts";

const root = new URL("..", import.meta.url).pathname;
const ctx = await loadContext(root);
const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: createHandler(() => ctx, { token: process.env.YAFI_TOKEN }) });
console.log(`YafiDB writer listening on ${server.url} (POST /records, POST /entries)`);
