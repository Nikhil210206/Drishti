/**
 * The extension's code path, end to end: the browser-safe providers with a device token and the
 * default browser socket (Node 22's WebSocket is the browser's API), through a running proxy.
 * Costs a few paise plus about ₹1 for the one-page Doc AI read.
 *
 *   npm run dev -w @drishti/proxy -- --port 8788
 *   npx tsx apps/proxy/scripts/providers.ts [http://localhost:8788]
 */
import fs from "node:fs";
import { chromium } from "playwright";
import { SarvamDocReader, SarvamLLM, SarvamTranslator, SttStream, TtsEngine, resample } from "@drishti/providers";

const base = process.argv[2] ?? "http://localhost:8788";
const ok = (name: string, pass: boolean, detail = "") => console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
const t = () => performance.now();

const { token } = (await (
  await fetch(`${base}/v1/token`, { method: "POST", body: JSON.stringify({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" }) })
).json()) as { token: string };
// No apiKey and no socket factory: exactly what the extension passes.
const auth = { baseUrl: base, token };

// Hosts fetched, to see where Doc AI's result download goes (the extension may need permission for it).
const hosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: any) => {
  hosts.add(new URL(typeof input === "string" ? input : input.url).host);
  return realFetch(input, init);
};

let t0 = t();
const ta = await new SarvamTranslator(auth).translate("Your ticket is booked.", "ta-IN", { source: "en-IN" });
ok("translate", !!ta, `${ta} (${Math.round(t() - t0)} ms)`);

t0 = t();
const reply = await new SarvamLLM({ ...auth, model: "sarvam-105b" }).chat({
  messages: [{ role: "user", content: "Say ok." }],
  maxTokens: 20,
});
ok("llm", !!reply.content, `${JSON.stringify(reply.content.trim())} (${Math.round(t() - t0)} ms)`);

await new Promise<void>((resolve) => {
  const tts = new TtsEngine({ ...auth, model: "bulbul:v3", speaker: "kavya" });
  let bytes = 0;
  let first = 0;
  t0 = t();
  tts.on("audio", (_u, pcm) => {
    first ||= t() - t0;
    bytes += pcm.length;
  });
  tts.on("error", (e) => ok("tts", false, e.message));
  void tts.speak("आपका टिकट बुक हो गया है।", "hi-IN").done.then(() => {
    ok("tts", bytes > 10000, `${(bytes / 48000).toFixed(1)} s of audio, first at ${Math.round(first)} ms`);
    resolve();
  });
});

const clip = "cache/spike-ta.wav";
if (fs.existsSync(clip)) {
  await new Promise<void>((resolve) => {
    const stt = new SttStream({ ...auth, model: "saaras:v4" });
    const timer = setTimeout(() => (ok("stt", false, "no transcript in 30 s"), stt.close(), resolve()), 30000);
    let ended = 0;
    stt.on("final", (text, lang) => {
      clearTimeout(timer);
      ok("stt", true, `"${text.slice(0, 50)}" (${lang}, ${Math.round(t() - ended)} ms after the audio ended)`);
      stt.close();
      resolve();
    });
    stt.on("status", async (s, d) => {
      if (s === "error") ok("stt status", false, d);
      if (s !== "open") return;
      const pcm = resample(new Uint8Array(fs.readFileSync(clip).subarray(44)), 24000, 16000);
      for (let i = 0; i < pcm.length; i += 3200) {
        stt.sendAudio(pcm.subarray(i, i + 3200));
        await new Promise((r) => setTimeout(r, 100));
      }
      ended = t();
      for (let i = 0; i < 15; i++) {
        stt.sendAudio(new Uint8Array(3200));
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    stt.connect();
  });
}

// A one-page fictional bill, printed to PDF, read with Doc AI through the proxy.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<h1>Pathik Power Ltd (fictional)</h1><p>Electricity bill for October 2026</p>
  <p>Consumer: Asha Verma (test)</p><p>Units used: 142</p><p>Amount due: ₹1,284.50</p><p>Due date: 20 October 2026</p>`);
const pdf = new Uint8Array(await page.pdf({ format: "A4" }));
await browser.close();
t0 = t();
try {
  const md = await new SarvamDocReader(auth).read(pdf, "bill.pdf", "en-IN");
  ok(
    "doc ai",
    /1,?284/.test(md),
    `${md.length} chars, amount ${/1,?284(\.50)?/.test(md) ? "found" : "missing"} (${Math.round(t() - t0)} ms)`,
  );
} catch (e) {
  ok("doc ai", false, String((e as Error).message));
}
console.log(`hosts fetched: ${[...hosts].join(", ")}`);
process.exit(0); // the TTS socket stays open by design
