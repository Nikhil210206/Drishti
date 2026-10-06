import type { LangCode, SpeakOptions, SpeechOut, SpeechOutEvents, Utterance } from "@drishti/core";
import { openSocket, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";
import { Emitter } from "../emitter.js";
import { ascii, concat, fromBase64, messageText } from "../bytes.js";

export const TTS_SAMPLE_RATE = 24000;
const OPEN = 1;

interface VoiceSettings {
  speaker: string;
  pace: number;
}

/** Stored audio for fixed phrases (a disk folder in Node; packaged audio or IndexedDB in the extension). */
export interface AudioCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, pcm: Uint8Array): Promise<void>;
}

interface TtsConfig extends SarvamAuth {
  model: string;
  speaker: string;
  /** Where fixed phrases are kept. Omit to cache nothing. */
  cache?: AudioCache;
}

type CachedUtterance = Utterance & { cache: boolean };

/**
 * Serial speech queue on top of Bulbul v3. Emits `start`, `audio` (raw PCM16 @24 kHz)
 * and `end` per utterance so the panel can play and cancel them individually.
 * Only utterances spoken with `{ cache: true }` (fixed phrases) are ever written to disk.
 */
export class TtsEngine extends Emitter<SpeechOutEvents> implements SpeechOut {
  private queue: CachedUtterance[] = [];
  private current?: CachedUtterance;
  private nextId = 1;
  private ws?: WebSocket;
  private wsKey = "";
  private wsReady?: Promise<void>;
  private pending?: { u: Utterance; chunks: Uint8Array[]; finish: () => void; timer: ReturnType<typeof setTimeout> };
  private pingTimer?: ReturnType<typeof setInterval>;
  voice: VoiceSettings;

  constructor(private cfg: TtsConfig) {
    super();
    this.voice = { speaker: cfg.speaker, pace: 1.1 };
  }

  speak(text: string, lang: LangCode, opts: SpeakOptions = {}): Utterance {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const u: CachedUtterance = {
      id: this.nextId++,
      text: cleanForSpeech(text),
      lang,
      cancelled: false,
      done,
      resolve,
      cache: !!opts.cache,
    };
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
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.emit("end", u);
      u.resolve();
      this.current = undefined;
      void this.pump();
    }
  }

  private cacheKey(u: CachedUtterance) {
    if (!u.cache || !this.cfg.cache) return undefined;
    return `${this.cfg.model}|${u.lang}|${this.voice.speaker}|${this.voice.pace}|${u.text}`;
  }

  private async render(u: CachedUtterance) {
    const key = this.cacheKey(u);
    this.emit("start", u);
    const hit = key ? await this.cfg.cache!.get(key).catch(() => undefined) : undefined;
    if (hit) {
      const step = TTS_SAMPLE_RATE * 2 * 0.5; // half-second chunks
      for (let i = 0; i < hit.length && !u.cancelled; i += step) this.emit("audio", u, hit.subarray(i, i + step), true);
      return;
    }
    const pcm = concat(await this.synthesize(u));
    if (key && !u.cancelled && pcm.length) await this.cfg.cache!.set(key, pcm).catch(() => {});
  }

  private async synthesize(u: Utterance): Promise<Uint8Array[]> {
    await this.ensureSocket(u.lang);
    costMeter.addTts(u.text.length);
    return new Promise<Uint8Array[]>((resolve) => {
      const chunks: Uint8Array[] = [];
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
    if (this.ws && this.wsKey === key && this.ws.readyState === OPEN && this.wsReady) return this.wsReady;
    const old = this.ws;
    this.ws = undefined;
    old?.close();
    clearInterval(this.pingTimer);
    this.wsKey = key;
    const ws = openSocket(this.cfg, `/text-to-speech/ws?model=${this.cfg.model}&send_completion_event=true`);
    this.ws = ws;
    this.wsReady = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
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
        this.pingTimer = setInterval(() => ws.readyState === OPEN && ws.send(JSON.stringify({ type: "ping" })), 30000);
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("TTS socket error")));
    });
    ws.addEventListener("message", (e) => this.ws === ws && this.onMessage(messageText(e.data)));
    ws.addEventListener("close", () => {
      // A replaced socket closing late must not touch the new one's timer or utterance.
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = undefined;
      this.wsReady = undefined;
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
      const pcm = stripWavHeader(fromBase64(msg.data.audio));
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

function stripWavHeader(buf: Uint8Array): Uint8Array {
  if (buf.length > 44 && ascii(buf, 0, 4) === "RIFF") {
    for (let i = 12; i < Math.min(buf.length - 8, 512); i++) if (ascii(buf, i, i + 4) === "data") return buf.subarray(i + 8);
    return buf.subarray(44);
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
