import type { SpeechIn, SpeechInEvents } from "@drishti/core";
import { openSocket, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";
import { Emitter } from "../emitter.js";
import { messageText, toBase64 } from "../bytes.js";

const OPEN = 1;

// Words Saaras v4 should bias towards: Drishti's own vocabulary only. Place names are left out: a
// fixed list of the practice site's stations biased every place name on every site (likely why a
// Tamil user's "Erode" came out as "Ernakulam").
export const DEFAULT_KEYTERMS = ["Drishti", "Pathik Rail", "Kivi", "Tatkal", "Sleeper", "AC 3 tier", "AC 2 tier", "PNR", "OTP"];

/**
 * One realtime Saaras connection per panel session. Audio arrives as 16 kHz mono
 * linear16 PCM from the browser; transcripts come back with the detected language.
 */
export class SttStream extends Emitter<SpeechInEvents> implements SpeechIn {
  private ws?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private closedByUs = false;
  private backlog: Uint8Array[] = [];
  /** Connections in a row that failed or were refused, and when the next one may be tried. */
  private failures = 0;
  private retryAt = 0;

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
      this.failed();
      this.emit("status", "error", String((e as Error)?.message ?? e));
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.emit("status", "open");
      for (const chunk of this.backlog.splice(0)) this.sendAudio(chunk);
      this.pingTimer = setInterval(() => this.send({ event: "ping" }), 15000);
    });
    ws.addEventListener("message", (e) => this.onMessage(messageText(e.data)));
    ws.addEventListener("error", () => this.emit("status", "error", "socket error"));
    ws.addEventListener("close", (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = undefined;
      // The proxy refuses with a 4xxx code and says why: a browser never sees a failed handshake's status.
      const refused = e.code >= 4000;
      this.emit("status", refused ? "refused" : "closed", refused ? e.reason : `${e.code} ${e.reason}`);
      if (refused || !opened) this.failed();
      else this.failures = 0;
      // No reconnecting from here: the next audio does it (sendAudio). An idle socket only costs
      // quota (the proxy closes it after 15 minutes anyway), and a refused one was retried forever.
    });
  }

  /** Back off before the next try: 1 s, 2 s, 4 s… up to 30 s. */
  private failed() {
    this.failures++;
    this.retryAt = Date.now() + Math.min(30_000, 500 * 2 ** this.failures);
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
      // Not connected (closed, refused or never opened): audio is what reconnects, so a socket is
      // only tried while someone is talking, and after a pause when the last tries failed.
      if (!this.ws && !this.closedByUs && Date.now() >= this.retryAt) this.connect();
      return;
    }
    this.send({ event: "audio_input", audio: toBase64(pcm) });
  }

  /**
   * Finish the current utterance (push-to-talk release). Saaras ends an utterance after 700 ms of
   * silence (VAD); its "flush" only works with manual endpointing. A release just stops the audio,
   * so the server never hears that silence: send a second of it.
   */
  flush() {
    const silence = new Uint8Array(3200); // 100 ms of 16 kHz PCM16
    for (let i = 0; i < 10; i++) this.sendAudio(silence);
    this.send({ event: "flush" });
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.send({ event: "end" });
    this.ws?.close();
  }
}
