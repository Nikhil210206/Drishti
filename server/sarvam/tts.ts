import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { CACHE_DIR, config, requireApiKey, type LangCode } from "../config.js";
import { costMeter } from "./cost.js";

export const TTS_SAMPLE_RATE = 24000;
const CACHE = path.join(CACHE_DIR, "tts");
fs.mkdirSync(CACHE, { recursive: true });

export interface Utterance {
  id: number;
  text: string;
  lang: LangCode;
  cancelled: boolean;
  done: Promise<void>;
  resolve: () => void;
}

interface VoiceSettings {
  speaker: string;
  pace: number;
}

/**
 * Serial speech queue on top of Bulbul v3. Emits `start`, `audio` (raw PCM16 @24 kHz)
 * and `end` per utterance so the panel can play and cancel them individually.
 */
export class TtsEngine extends EventEmitter {
  private queue: Utterance[] = [];
  private current?: Utterance;
  private nextId = 1;
  private ws?: WebSocket;
  private wsKey = "";
  private wsReady?: Promise<void>;
  private pending?: { u: Utterance; chunks: Buffer[]; finish: () => void; timer: NodeJS.Timeout };
  private pingTimer?: NodeJS.Timeout;
  voice: VoiceSettings = { speaker: config.speaker, pace: 1.1 };

  speak(text: string, lang: LangCode): Utterance {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const u: Utterance = { id: this.nextId++, text: cleanForSpeech(text), lang, cancelled: false, done, resolve };
    if (!u.text) {
      resolve();
      return u;
    }
    this.queue.push(u);
    void this.pump();
    return u;
  }

  /** Stop everything: queued and in-flight speech (barge-in / abort). */
  cancelAll() {
    for (const u of this.queue) {
      u.cancelled = true;
      u.resolve();
    }
    this.queue = [];
    if (this.current) this.current.cancelled = true;
    this.emit("cancel");
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  private async pump() {
    if (this.current) return;
    const u = this.queue.shift();
    if (!u) return;
    this.current = u;
    try {
      await this.render(u);
    } catch (e) {
      this.emit("error", e);
    } finally {
      this.emit("end", u);
      u.resolve();
      this.current = undefined;
      void this.pump();
    }
  }

  private cacheFile(u: Utterance) {
    const key = crypto
      .createHash("sha1")
      .update(`${config.ttsModel}|${u.lang}|${this.voice.speaker}|${this.voice.pace}|${u.text}`)
      .digest("hex");
    return path.join(CACHE, `${key}.pcm`);
  }

  private async render(u: Utterance) {
    const file = this.cacheFile(u);
    this.emit("start", u);
    if (fs.existsSync(file)) {
      const pcm = fs.readFileSync(file);
      const step = TTS_SAMPLE_RATE * 2 * 0.5; // half-second chunks
      for (let i = 0; i < pcm.length && !u.cancelled; i += step) this.emit("audio", u, pcm.subarray(i, i + step), true);
      return;
    }
    const chunks = await this.synthesize(u);
    const pcm = Buffer.concat(chunks);
    if (!u.cancelled && pcm.length && u.text.length <= 240) fs.writeFileSync(file, pcm);
  }

  private async synthesize(u: Utterance): Promise<Buffer[]> {
    requireApiKey();
    await this.ensureSocket(u.lang);
    costMeter.addTts(u.text.length);
    return new Promise<Buffer[]>((resolve) => {
      const chunks: Buffer[] = [];
      const finish = () => {
        clearTimeout(timer);
        this.pending = undefined;
        resolve(chunks);
      };
      const timer = setTimeout(finish, 20000);
      this.pending = { u, chunks, finish, timer };
      this.ws!.send(JSON.stringify({ type: "text", data: { text: u.text } }));
      this.ws!.send(JSON.stringify({ type: "flush" }));
    });
  }

  private ensureSocket(lang: LangCode): Promise<void> {
    const key = `${lang}|${this.voice.speaker}|${this.voice.pace}`;
    if (this.ws && this.wsKey === key && this.ws.readyState === WebSocket.OPEN && this.wsReady) return this.wsReady;
    this.ws?.removeAllListeners();
    this.ws?.close();
    clearInterval(this.pingTimer);
    this.wsKey = key;
    const ws = new WebSocket(`wss://api.sarvam.ai/text-to-speech/ws?model=${config.ttsModel}&send_completion_event=true`, {
      headers: { "api-subscription-key": config.apiKey },
    });
    this.ws = ws;
    this.wsReady = new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "config",
            data: {
              language_code: lang,
              speaker: this.voice.speaker,
              pace: this.voice.pace,
              speech_sample_rate: TTS_SAMPLE_RATE,
              output_audio_codec: "linear16",
              enable_preprocessing: true,
              min_buffer_size: 30,
              max_chunk_length: 200,
            },
          }),
        );
        this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 30000);
        resolve();
      });
      ws.once("error", reject);
    });
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) {
        this.ws = undefined;
        this.wsReady = undefined;
      }
      this.pending?.finish();
    });
    return this.wsReady;
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const p = this.pending;
    if (!p) return;
    if (msg.type === "audio" && msg.data?.audio) {
      const pcm = stripWavHeader(Buffer.from(msg.data.audio, "base64"));
      p.chunks.push(pcm);
      if (!p.u.cancelled) this.emit("audio", p.u, pcm, false);
    } else if (msg.type === "event" && msg.data?.event_type === "final") {
      p.finish();
    } else if (msg.type === "error") {
      this.emit("error", new Error(msg.data?.message ?? "TTS error"));
      p.finish();
    }
  }
}

function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    const dataIdx = buf.indexOf("data", 12, "ascii");
    return dataIdx > 0 ? buf.subarray(dataIdx + 8) : buf.subarray(44);
  }
  return buf;
}

/** Remove markup the model sometimes emits so it isn't read aloud. */
export function cleanForSpeech(text: string) {
  return text
    .replace(/\[(\d+)\]/g, "")
    .replace(/[*_#`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
