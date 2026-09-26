import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config, ROOT } from "./config.js";
import { BrowserController } from "./browser/controller.js";
import { Session } from "./session.js";
import { registerMockApi } from "./mock-api.js";

const browser = new BrowserController();

// ---------- Drishti server (panel WebSocket) ----------
const app = Fastify({ logger: { level: "warn" } });
await app.register(websocket);

let active: Session | undefined;
app.register(async (f) => {
  f.get("/ws", { websocket: true }, (socket) => {
    active?.close();
    const session = new Session(socket, browser);
    active = session;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return session.onAudio(Buffer.from(data));
      try {
        session.onMessage(JSON.parse(data.toString()));
      } catch {}
    });
    socket.on("close", () => {
      session.close();
      if (active === session) active = undefined;
    });
  });
});

// Serve the built panel in production (`npm run build`); Vite serves it in dev.
const dist = path.join(ROOT, "web/dist");
if (fs.existsSync(dist)) await app.register(fastifyStatic, { root: dist });
app.get("/health", async () => ({ ok: true }));

// ---------- Mock websites (a separate origin, like a real third-party site) ----------
const mock = Fastify({ logger: false });
await mock.register(fastifyStatic, { root: path.join(ROOT, "mock-sites/pathik-rail"), prefix: "/" });
await mock.register(fastifyStatic, { root: path.join(ROOT, "mock-sites/bills/out"), prefix: "/docs/", decorateReply: false });
registerMockApi(mock);

await app.listen({ port: config.port, host: "127.0.0.1" });
await mock.listen({ port: config.mockPort, host: "127.0.0.1" });
console.log(`Drishti server  → http://localhost:${config.port}  (panel dev: http://localhost:5173)`);
console.log(`Pathik Rail mock → http://localhost:${config.mockPort}`);

const shutdown = async () => {
  active?.close();
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
