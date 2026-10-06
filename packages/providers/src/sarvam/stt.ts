import type { SpeechIn, SpeechInEvents } from "@drishti/core";
import { openSocket, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";
import { Emitter } from "../emitter.js";
import { messageText, toBase64 } from "../bytes.js";

const OPEN = 1;

// Domain words that Saaras v4 should bias towards (station names, rail jargon, product names).
export const DEFAULT_KEYTERMS = [
  "Drishti",
  "Pathik Rail",
  "Kivi",
  "Tatkal",
  "Sleeper",
  "AC 3 tier",
  "AC 2 tier",
  "PNR",
  "Chennai Central",
  "Bengaluru",
  "Howrah",
  "Mumbai",
  "New Delhi",
  "Secunderabad",
  "Pune",
  "Coimbatore",
  "Madurai",
  "Ernakulam",
  "Thiruvananthapuram",
  "Mysuru",
  "Vijayawada",
];

/**
 * One realtime Saaras connection per panel session. Audio arrives as 16 kHz mono
 * linear16 PCM from the browser; transcripts come back with the detected language.
 */
export class SttStream extends Emitter<SpeechInEvents> implements SpeechIn {
  private ws?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private closedByUs = false;
  private backlog: Uint8Array[] = [];
  private reconnectDelay = 500;

  constructor(
    private cfg: SarvamAuth & { model: string },
    private keyterms: string[] = DEFAULT_KEYTERMS,
  ) {
    super();
  }

  connect() {
    this.closedByUs = false;
    const q = new URLSearchParams({
      language_code: "auto",
      model: this.cfg.model,
      stream_type: "fast",
      sample_rate: "16000",
      encoding: "linear16",
      mode: "transcribe",
      silence_duration_ms: "700",
    });
    if (this.cfg.model === "saaras:v4" && this.keyterms.length) {
      q.set("keyterms", JSON.stringify(this.keyterms.slice(0, 50)));
    }
    this.emit("status", "connecting");
    let ws: WebSocket;
    try {
      ws = openSocket(this.cfg, `/speech-to-text-realtime/ws?${q}`);
    } catch (e) {
      this.emit("status", "error", String((e as Error)?.message ?? e));
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.reconnectDelay = 500;
      this.emit("status", "open");
      for (const chunk of this.backlog.splice(0)) this.sendAudio(chunk);
      this.pingTimer = setInterval(() => this.send({ event: "ping" }), 15000);
    });
    ws.addEventListener("message", (e) => this.onMessage(messageText(e.data)));
    ws.addEventListener("error", () => this.emit("status", "error", "socket error"));
    ws.addEventListener("close", (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.emit("status", "closed", `${e.code} ${e.reason}`);
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
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(pcm: Uint8Array) {
    if (this.ws?.readyState !== OPEN) {
      // Keep ~2 s while (re)connecting so the start of an utterance isn't lost.
      this.backlog.push(pcm);
      if (this.backlog.length > 20) this.backlog.shift();
      return;
    }
    this.send({ event: "audio_input", audio: toBase64(pcm) });
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
