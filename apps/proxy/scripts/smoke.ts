/**
 * End-to-end check of a running proxy against real Sarvam (costs a few paise):
 *   npx wrangler dev --port 8788   (in apps/proxy, with .dev.vars)
 *   npx tsx apps/proxy/scripts/smoke.ts [http://localhost:8788] [path/to/24k-mono.wav]
 * Uses Node's built-in WebSocket, the same API the extension uses in the browser.
 */
import fs from "node:fs";
import { resample } from "../../../packages/providers/src/audio.js";

const base = process.argv[2] ?? "http://localhost:8788";
const wav = process.argv[3] ?? "cache/spike-ta.wav";
const wsBase = base.replace(/^http/, "ws");

const t = () => performance.now();
const ok = (name: string, pass: boolean, detail = "") => console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);

// 1. Device token (the always-pass Turnstile test secret accepts this dummy response).
const minted = await fetch(`${base}/v1/token`, { method: "POST", body: JSON.stringify({ turnstile: "XXXX.DUMMY.TOKEN.XXXX" }) });
const { token } = (await minted.json()) as { token: string };
ok("mint token", !!token, `HTTP ${minted.status}`);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

// 2. No token: refused.
const bad = await fetch(`${base}/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok("refuses without a token", bad.status === 401, `HTTP ${bad.status}`);

// 3. Translate.
let t0 = t();
const tr = await fetch(`${base}/translate`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ input: "Hello", source_language_code: "en-IN", target_language_code: "hi-IN", model: "mayura:v1" }),
});
const trBody = (await tr.json()) as { translated_text?: string };
ok("translate", tr.ok && !!trBody.translated_text, `${trBody.translated_text} (${Math.round(t() - t0)} ms)`);

// 4. LLM.
t0 = t();
const chat = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    model: "sarvam-105b",
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 20,
    reasoning_effort: null,
  }),
});
const chatBody = (await chat.json()) as any;
ok("chat", chat.ok, `${JSON.stringify(chatBody.choices?.[0]?.message?.content ?? chatBody).slice(0, 60)} (${Math.round(t() - t0)} ms)`);

// 5. TTS over the relay socket.
await new Promise<void>((resolve) => {
  t0 = t();
  const ws = new WebSocket(`${wsBase}/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`, ["drishti", token]);
  let bytes = 0;
  let first = 0;
  const done = (pass: boolean, why: string) => {
    ok("tts relay", pass, why);
    ws.close();
    resolve();
  };
  const timer = setTimeout(() => done(false, "timeout"), 20000);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "config",
        data: { language_code: "hi-IN", speaker: "kavya", output_audio_codec: "linear16", speech_sample_rate: 24000 },
      }),
    );
    ws.send(JSON.stringify({ type: "text", data: { text: "नमस्ते" } }));
    ws.send(JSON.stringify({ type: "flush" }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "audio") {
      first ||= t() - t0;
      bytes += atob(msg.data.audio).length;
    }
    if (msg.type === "event" && msg.data?.event_type === "final") {
      clearTimeout(timer);
      done(bytes > 1000, `${bytes} bytes, first audio ${Math.round(first)} ms, protocol "${ws.protocol}"`);
    }
    if (msg.type === "error") {
      clearTimeout(timer);
      done(false, JSON.stringify(msg.data));
    }
  };
  ws.onerror = () => {
    clearTimeout(timer);
    done(false, "socket error");
  };
});

// 6. STT over the relay socket: stream the clip in 100 ms chunks, then flush.
if (fs.existsSync(wav)) {
  // The spike clip is 24 kHz PCM16; Saaras wants 16 kHz.
  const pcm = Buffer.from(resample(fs.readFileSync(wav).subarray(44), 24000, 16000));
  await new Promise<void>((resolve) => {
    const q = new URLSearchParams({
      language_code: "auto",
      model: "saaras:v4",
      sample_rate: "16000",
      encoding: "linear16",
      mode: "transcribe",
    });
    const ws = new WebSocket(`${wsBase}/speech-to-text-realtime/ws?${q}`, ["drishti", token]);
    let sentAt = 0;
    const done = (pass: boolean, why: string) => {
      ok("stt relay", pass, why);
      ws.close();
      resolve();
    };
    const timer = setTimeout(() => done(false, "timeout"), 30000);
    ws.onopen = async () => {
      for (let i = 0; i < pcm.length; i += 3200) {
        ws.send(JSON.stringify({ event: "audio_input", audio: pcm.subarray(i, i + 3200).toString("base64") }));
        await new Promise((r) => setTimeout(r, 100));
      }
      sentAt = t();
      // Trailing silence lets Saaras's VAD end the utterance, as a pause would.
      const silence = Buffer.alloc(3200).toString("base64");
      for (let i = 0; i < 15 && ws.readyState === 1; i++) {
        ws.send(JSON.stringify({ event: "audio_input", audio: silence }));
        await new Promise((r) => setTimeout(r, 100));
      }
      ws.send(JSON.stringify({ event: "flush" }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.event === "transcript.final" && msg.text?.trim()) {
        clearTimeout(timer);
        done(true, `"${msg.text.trim().slice(0, 50)}" (${msg.language}, ${Math.round(t() - sentAt)} ms after the audio ended)`);
      }
      if (msg.event === "error") {
        clearTimeout(timer);
        done(false, `${msg.code}: ${msg.message}`);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(false, "socket error");
    };
  });
} else console.log(`(no ${wav}: skipped STT)`);

// 7. A socket with a forged token: refused.
await new Promise<void>((resolve) => {
  const ws = new WebSocket(`${wsBase}/text-to-speech/ws`, ["drishti", "forged.token"]);
  ws.onopen = () => (ok("refuses a forged socket token", false), ws.close(), resolve());
  ws.onerror = () => (ok("refuses a forged socket token", true), resolve());
});
