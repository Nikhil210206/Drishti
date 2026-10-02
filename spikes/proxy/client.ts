/**
 * Spike 2 client: stream the same 16 kHz clip (a) straight to Saaras, (b) through the local
 * Worker relay, and (c) send it to the REST endpoint in one request; compare latency.
 *   npx tsx spikes/proxy/client.ts   (with `npx wrangler dev` running in spikes/proxy)
 * Also probes whether Saaras accepts the key without a header (needed for BYOK from a browser).
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { pcmToWav, resample } from "@drishti/providers";
import { config, CACHE_DIR, requireApiKey } from "../../apps/dev-harness/src/config.js";

requireApiKey();
const RELAY = process.env.RELAY ?? "ws://127.0.0.1:8788";
const TOKEN = process.env.DEVICE_TOKEN ?? "spike-device-token";

const wav = fs.readFileSync(path.join(CACHE_DIR, "spike-ta.wav"));
const pcm16k = resample(wav.subarray(44), 24000, 16000);
const audioSeconds = pcm16k.length / 2 / 16000;
const params = new URLSearchParams({
  language_code: "auto",
  model: config.sttModel,
  stream_type: "fast",
  sample_rate: "16000",
  encoding: "linear16",
  mode: "transcribe",
  silence_duration_ms: "700",
});

async function streamTo(url: string, headers: Record<string, string> = {}) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const t0 = Date.now();
    const ws = new WebSocket(url, { headers });
    let openMs = 0;
    let audioDoneAt = 0;
    let stats: unknown;
    const done = (r: Record<string, unknown>) => {
      clearInterval(pad);
      ws.close();
      resolve({ openMs, ...r, stats });
    };
    let pad: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => done({ ok: false, error: "no final transcript in 25 s" }), 25000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      done({ ok: false, error: `HTTP ${res.statusCode}` });
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, error: String(e.message) });
    });
    ws.on("open", async () => {
      openMs = Date.now() - t0;
      const step = 3200; // 100 ms of audio
      for (let i = 0; i < pcm16k.length; i += step) {
        ws.send(JSON.stringify({ event: "audio_input", audio: pcm16k.subarray(i, i + step).toString("base64") }));
        await new Promise((r) => setTimeout(r, 100));
      }
      audioDoneAt = Date.now();
      const silence = Buffer.alloc(step).toString("base64");
      pad = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: "audio_input", audio: silence })), 100);
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "relay.stats") stats = msg;
      if (msg.event === "error") {
        clearTimeout(timer);
        done({ ok: false, error: `${msg.code}: ${msg.message}` });
      }
      if (msg.event === "transcript.final" && msg.text?.trim()) {
        clearTimeout(timer);
        done({ ok: true, text: msg.text, lang: msg.language, finalAfterAudioEndMs: Date.now() - audioDoneAt, totalMs: Date.now() - t0 });
      }
    });
  });
}

async function rest() {
  const form = new FormData();
  form.append("file", new Blob([pcmToWav(pcm16k, 16000)], { type: "audio/wav" }), "clip.wav");
  form.append("model", config.sttModel);
  form.append("language_code", "unknown");
  const t0 = Date.now();
  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": config.apiKey },
    body: form,
  });
  const body: any = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - t0,
    text: body.transcript,
    lang: body.language_code,
    error: res.ok ? undefined : JSON.stringify(body).slice(0, 200),
  };
}

async function keyWithoutHeader() {
  // Browsers cannot set headers on WebSocket; does Sarvam accept the key any other way?
  const tryOpen = (url: string, protocols?: string[]) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(url, protocols);
      const t = setTimeout(() => (ws.terminate(), resolve("timeout")), 8000);
      ws.on("open", () => {
        // Opening is not proof; wait briefly for an auth error event.
        ws.once("message", (raw) => (clearTimeout(t), ws.close(), resolve(`open, then: ${raw.toString().slice(0, 120)}`)));
        setTimeout(() => (clearTimeout(t), ws.close(), resolve("open, no error within 3 s")), 3000);
      });
      ws.on("unexpected-response", (_q, res) => (clearTimeout(t), resolve(`HTTP ${res.statusCode}`)));
      ws.on("error", (e) => (clearTimeout(t), resolve(`error ${e.message}`)));
    });
  const base = `wss://api.sarvam.ai/speech-to-text-realtime/ws?${params}`;
  return {
    queryParam: await tryOpen(`${base}&api-subscription-key=${encodeURIComponent(config.apiKey)}`),
    noKey: await tryOpen(base),
  };
}

const out: Record<string, unknown> = { audioSeconds: Number(audioSeconds.toFixed(2)) };
out.direct = await streamTo(`wss://api.sarvam.ai/speech-to-text-realtime/ws?${params}`, { "api-subscription-key": config.apiKey });
console.log("direct", out.direct);
out.relay = await streamTo(`${RELAY}/stt?${params}&token=${TOKEN}`);
console.log("relay", out.relay);
out.relayBadToken = await streamTo(`${RELAY}/stt?${params}&token=wrong`);
console.log("relay with bad token", out.relayBadToken);
out.rest = await rest();
console.log("rest", out.rest);
out.keyWithoutHeader = await keyWithoutHeader();
console.log("key without header", out.keyWithoutHeader);
fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
fs.writeFileSync(path.join(import.meta.dirname, "results/relay.json"), JSON.stringify(out, null, 2));
process.exit(0);
