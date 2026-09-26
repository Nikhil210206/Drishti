import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config, requireApiKey } from "../config.js";
import { costMeter } from "./cost.js";

// Domain words that Saaras v4 should bias towards (station names, rail jargon, product names).
export const DEFAULT_KEYTERMS = [
  "Drishti", "Pathik Rail", "Kivi", "Tatkal", "Sleeper", "AC 3 tier", "AC 2 tier", "PNR",
  "Chennai Central", "Bengaluru", "Howrah", "Mumbai", "New Delhi", "Secunderabad", "Pune",
  "Coimbatore", "Madurai", "Ernakulam", "Thiruvananthapuram", "Mysuru", "Vijayawada",
];

export interface SttEvents {
  partial: (text: string, lang?: string) => void;
  final: (text: string, lang?: string, confidence?: number) => void;
  speechStart: () => void;
  speechEnd: () => void;
  status: (s: "connecting" | "open" | "closed" | "error", detail?: string) => void;
}

/**
 * One realtime Saaras connection per panel session. Audio arrives as 16 kHz mono
 * linear16 PCM from the browser; transcripts come back with the detected language.
 */
export class SttStream extends EventEmitter {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private closedByUs = false;
  private backlog: Buffer[] = [];
  private reconnectDelay = 500;

  constructor(private keyterms: string[] = DEFAULT_KEYTERMS) {
    super();
  }

  connect() {
    requireApiKey();
    this.closedByUs = false;
    const q = new URLSearchParams({
      language_code: "auto",
      model: config.sttModel,
      stream_type: "fast",
      sample_rate: "16000",
      encoding: "linear16",
      mode: "transcribe",
      silence_duration_ms: "700",
    });
    if (config.sttModel === "saaras:v4" && this.keyterms.length) {
      q.set("keyterms", JSON.stringify(this.keyterms.slice(0, 50)));
    }
    this.emit("status", "connecting");
    const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text-realtime/ws?${q}`, {
      headers: { "api-subscription-key": config.apiKey },
    });
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectDelay = 500;
      this.emit("status", "open");
      for (const chunk of this.backlog.splice(0)) this.sendAudio(chunk);
      this.pingTimer = setInterval(() => this.send({ event: "ping" }), 15000);
    });
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("error", (err) => this.emit("status", "error", String(err)));
    ws.on("close", (code, reason) => {
      clearInterval(this.pingTimer);
      this.emit("status", "closed", `${code} ${reason}`);
      if (!this.closedByUs) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
      }
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.event) {
      case "transcript.partial":
        if (msg.text?.trim()) this.emit("partial", msg.text, msg.language);
        break;
      case "transcript.final":
        if (msg.text?.trim()) this.emit("final", msg.text.trim(), msg.language, msg.language_confidence);
        break;
      case "vad.speech_start":
        this.emit("speechStart");
        break;
      case "vad.speech_end":
        this.emit("speechEnd");
        break;
      case "session.end":
        if (msg.audio_duration_s) costMeter.addStt(msg.audio_duration_s);
        break;
      case "error":
        this.emit("status", "error", `${msg.code}: ${msg.message}`);
        break;
    }
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(pcm: Buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Keep ~2 s while (re)connecting so the start of an utterance isn't lost.
      this.backlog.push(pcm);
      if (this.backlog.length > 20) this.backlog.shift();
      return;
    }
    this.send({ event: "audio_input", audio: pcm.toString("base64") });
  }

  /** Force the current utterance to finalise (push-to-talk release). */
  flush() {
    this.send({ event: "flush" });
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.send({ event: "end" });
    this.ws?.close();
  }
}
