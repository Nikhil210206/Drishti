import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { VoiceSession } from "@drishti/core";
import { costMeter } from "@drishti/providers";
import { config, ROOT } from "./config.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { startMockSite } from "./mock-server.js";
import { createAgent, navigationPolicy, sarvamProviders } from "./wiring.js";

const browser = new PlaywrightDriver();
const providers = sarvamProviders();
const policy = navigationPolicy();
const homeUrl = `http://localhost:${config.mockPort}/`;

// ---------- Drishti server (panel WebSocket) ----------
const app = Fastify({ logger: { level: "warn" } });
await app.register(websocket);

let active: { session: VoiceSession; close(): void } | undefined;
app.register(async (f) => {
  f.get("/ws", { websocket: true }, (socket) => {
    active?.close();
    const session = new VoiceSession(
      {
        agent: createAgent(browser, providers, policy),
        browser,
        policy,
        phrases: providers.phrases,
        speechOut: providers.createSpeechOut(),
        createSpeechIn: providers.createSpeechIn,
        sink: {
          event: (e) => socket.readyState === 1 && socket.send(JSON.stringify(e)),
          audio: (pcm) => socket.readyState === 1 && socket.send(pcm, { binary: true }),
        },
      },
      { lang: config.lang, homeUrl },
    );
    const unsubscribeCost = costMeter.onChange((inr) => session.emit({ type: "cost", inr }));
    browser
      .ensure()
      .then(() => session.emit({ type: "status", browser: "ready" }))
      .catch((e) => session.emit({ type: "error", message: `Browser: ${e.message}` }));
    const entry = {
      session,
      close() {
        unsubscribeCost();
        session.close();
      },
    };
    active = entry;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return session.onAudio(new Uint8Array(data));
      try {
        session.onMessage(JSON.parse(data.toString()));
      } catch {}
    });
    socket.on("close", () => {
      entry.close();
      if (active === entry) active = undefined;
    });
  });
});

// Serve the built panel in production (`npm run build`); Vite serves it in dev.
const dist = path.join(ROOT, "packages/ui/dist");
if (fs.existsSync(dist)) await app.register(fastifyStatic, { root: dist });
app.get("/health", async () => ({ ok: true }));

await app.listen({ port: config.port, host: "127.0.0.1" });
// Mock websites on a separate origin, like a real third-party site.
await startMockSite();
console.log(`Drishti server  → http://localhost:${config.port}  (panel dev: http://localhost:5173)`);
console.log(`Pathik Rail mock → http://localhost:${config.mockPort}`);

const shutdown = async () => {
  active?.close();
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
