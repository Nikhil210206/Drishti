/**
 * Hour-0 de-risking: exercise every Sarvam API once and print latencies.
 *   npx tsx spikes/check.ts            (LLM, TTS, STT loopback, translate)
 *   npx tsx spikes/check.ts path.pdf   (also Sarvam Vision on that file)
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, requireApiKey } from "../server/config.js";
import { chat } from "../server/sarvam/llm.js";
import { TtsEngine, TTS_SAMPLE_RATE } from "../server/sarvam/tts.js";
import { SttStream } from "../server/sarvam/stt.js";
import { translate } from "../server/sarvam/translate.js";
import { readDocument } from "../server/sarvam/vision.js";
import { costMeter } from "../server/sarvam/cost.js";
import { resample, pcmToWav } from "../server/audio.js";

requireApiKey();
const results: Record<string, string> = {};
const ok = (k: string, v: string) => {
  results[k] = v;
  console.log(`✅ ${k}: ${v}`);
};
const fail = (k: string, e: unknown) => {
  results[k] = `FAILED ${e}`;
  console.log(`❌ ${k}: ${e}`);
};

async function llm() {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "click",
        description: "Click an element by id",
        parameters: {
          type: "object",
          properties: { id: { type: "integer" }, narration: { type: "string" } },
          required: ["id", "narration"],
        },
      },
    },
  ];
  const messages = [
    { role: "system" as const, content: "You operate a web page for a blind user. Reply only with tool calls. Narration in Tamil." },
    { role: "user" as const, content: 'PAGE:\n[3] textbox "From"\n[4] textbox "To"\n[9] button "Search trains"\nTASK: search the trains' },
  ];
  for (const reasoning of ["none", "low"] as const) {
    try {
      const r = await chat({ messages, tools, toolChoice: "required", reasoning });
      ok(`llm tool-call (reasoning=${reasoning})`, `${r.ms} ms → ${JSON.stringify(r.toolCalls)}`);
    } catch (e) {
      fail(`llm tool-call (reasoning=${reasoning})`, e);
    }
  }
}

async function ttsAndStt() {
  const tts = new TtsEngine();
  const text = "வணக்கம்! நாளை காலை சென்னையிலிருந்து பெங்களூருக்கு ரயில் தேடுகிறேன்.";
  const chunks: Buffer[] = [];
  let first = 0;
  const t0 = Date.now();
  tts.on("audio", (_u, pcm: Buffer) => {
    if (!first) first = Date.now() - t0;
    chunks.push(pcm);
  });
  tts.on("error", (e) => fail("tts", e));
  const u = tts.speak(text, "ta-IN");
  await u.done;
  const pcm = Buffer.concat(chunks);
  if (!pcm.length) return fail("tts", "no audio returned");
  fs.writeFileSync(path.join(CACHE_DIR, "spike-ta.wav"), pcmToWav(pcm, TTS_SAMPLE_RATE));
  ok("tts bulbul:v3 ta-IN", `first audio ${first} ms, total ${Date.now() - t0} ms, ${(pcm.length / 2 / TTS_SAMPLE_RATE).toFixed(1)} s of audio → cache/spike-ta.wav`);

  // Loop the synthetic speech back through realtime STT with language auto-detection.
  const pcm16k = resample(pcm, TTS_SAMPLE_RATE, 16000);
  const stt = new SttStream();
  const final = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no final transcript in 20 s")), 20000);
    stt.on("final", (t: string, lang?: string, conf?: number) => {
      clearTimeout(timer);
      resolve(`"${t}" lang=${lang} conf=${conf}`);
    });
    stt.on("status", (s: string, d?: string) => s === "error" && console.log("stt status", s, d));
  });
  stt.connect();
  const t1 = Date.now();
  const step = 3200; // 100 ms
  for (let i = 0; i < pcm16k.length; i += step) {
    stt.sendAudio(pcm16k.subarray(i, i + step));
    await new Promise((r) => setTimeout(r, 100));
  }
  const silence = Buffer.alloc(step);
  const pad = setInterval(() => stt.sendAudio(silence), 100);
  try {
    const t = await final;
    ok("stt saaras realtime (auto LID)", `${t}, ${Date.now() - t1} ms after audio start`);
  } catch (e) {
    fail("stt saaras realtime", e);
  } finally {
    clearInterval(pad);
    stt.close();
  }
}

async function translation() {
  try {
    const t0 = Date.now();
    const out = await translate("Should I go ahead with the payment of 845 rupees?", "bn-IN", { source: "en-IN" });
    ok("translate mayura:v1 en→bn", `${Date.now() - t0} ms → ${out}`);
  } catch (e) {
    fail("translate", e);
  }
}

async function vision(file: string) {
  try {
    const t0 = Date.now();
    const md = await readDocument(fs.readFileSync(file), path.basename(file), "bn-IN");
    ok("vision doc-ai digitise", `${Date.now() - t0} ms → ${md.slice(0, 200).replace(/\n/g, " ")}…`);
  } catch (e) {
    fail("vision", e);
  }
}

await llm();
await ttsAndStt();
await translation();
if (process.argv[2]) await vision(process.argv[2]);
console.log(`\nApprox spend: ₹${costMeter.total.toFixed(3)}`);
fs.writeFileSync(path.join(CACHE_DIR, "spike-results.json"), JSON.stringify(results, null, 2));
process.exit(0);
