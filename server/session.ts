import type { WebSocket } from "ws";
import { LANGS, langFromScript, toSpeakable, type LangCode } from "./config.js";
import { SttStream } from "./sarvam/stt.js";
import { TtsEngine } from "./sarvam/tts.js";
import { costMeter } from "./sarvam/cost.js";
import type { BrowserController } from "./browser/controller.js";
import { Agent, type AgentIO } from "./agent/orchestrator.js";
import { phrase, warmPhrases, type PhraseKey } from "./agent/phrases.js";
import { quickCommand } from "./agent/safety.js";

type Waiter = { kind: "question" | "confirm"; resolve: (t: string | null) => void; timer: NodeJS.Timeout };

/** One connected Drishti panel: mic in, speech out, and the agent in between. */
export class Session implements AgentIO {
  lang: LangCode = (process.env.DRISHTI_LANG as LangCode) || "hi-IN";
  private stt?: SttStream;
  private tts = new TtsEngine();
  private agent: Agent;
  private task?: { abort: AbortController; text: string };
  private waiter?: Waiter;
  private composeWaiter?: { resolve: (t: string | null) => void; timer: NodeJS.Timeout };
  private conversation: string[] = [];
  private interjections: string[] = [];
  private lastSpoken = "";
  private lastFinalAt = 0;
  private firstAudioPending = false;
  private unsubscribeCost: () => void;

  constructor(private ws: WebSocket, private browser: BrowserController) {
    this.agent = new Agent(browser);
    this.wireTts();
    this.unsubscribeCost = costMeter.onChange((inr) => this.emit({ type: "cost", inr }));
    this.emit({ type: "lang", code: this.lang, name: LANGS[this.lang].name, native: LANGS[this.lang].native });
    this.emit({ type: "voice", pace: this.tts.voice.pace, speaker: this.tts.voice.speaker });
    void warmPhrases(this.lang);
    browser
      .ensure()
      .then(() => this.emit({ type: "status", browser: "ready" }))
      .catch((e) => this.emit({ type: "error", message: `Browser: ${e.message}` }));
  }

  // ---------- panel messages ----------
  onAudio(pcm: Buffer) {
    if (!this.stt) this.startStt();
    this.stt!.sendAudio(pcm);
  }

  onMessage(msg: any) {
    switch (msg.type) {
      case "ptt":
        if (msg.down) this.bargeIn();
        else this.stt?.flush();
        break;
      case "text":
        if (typeof msg.text === "string" && msg.text.trim()) {
          this.handleUtterance(msg.text.trim(), langFromScript(msg.text, this.lang), 1, msg.source ?? "typed");
        }
        break;
      case "stop":
        void this.stopAll(true);
        break;
      case "stop_speech":
        this.bargeIn();
        break;
      case "confirm":
        if (this.waiter) this.resolveWaiter(msg.answer === "yes" ? "yes" : "no");
        break;
      case "compose_submit":
        if (this.composeWaiter) {
          clearTimeout(this.composeWaiter.timer);
          const w = this.composeWaiter;
          this.composeWaiter = undefined;
          this.emit({ type: "compose_close" });
          w.resolve(typeof msg.text === "string" && msg.text.trim() ? msg.text.trim() : null);
        }
        break;
      case "settings":
        if (typeof msg.pace === "number") this.tts.voice.pace = clamp(msg.pace, 0.6, 2);
        if (typeof msg.speaker === "string") this.tts.voice.speaker = msg.speaker;
        if (typeof msg.lang === "string" && msg.lang in LANGS) this.setLang(msg.lang as LangCode);
        this.emit({ type: "voice", pace: this.tts.voice.pace, speaker: this.tts.voice.speaker });
        break;
      case "greet":
        void this.sayPhrase("ready");
        break;
      case "home":
        void this.browser.navigate(msg.url ?? `http://localhost:${process.env.MOCK_PORT ?? 5174}/`);
        break;
    }
  }

  close() {
    this.stt?.close();
    this.tts.cancelAll();
    this.task?.abort.abort();
    this.unsubscribeCost();
  }

  // ---------- speech in ----------
  private startStt() {
    this.stt = new SttStream();
    this.stt.on("status", (s: string, detail?: string) => this.emit({ type: "status", stt: s, detail }));
    this.stt.on("partial", (text: string, lang?: string) => this.emit({ type: "partial", text, lang }));
    this.stt.on("speechStart", () => this.emit({ type: "vad", speaking: true }));
    this.stt.on("speechEnd", () => this.emit({ type: "vad", speaking: false }));
    this.stt.on("final", (text: string, lang?: string, conf?: number) => this.handleUtterance(text, lang, conf, "voice"));
    this.stt.connect();
  }

  private handleUtterance(text: string, detected: string | undefined, confidence = 1, source: string) {
    this.lastFinalAt = Date.now();
    this.firstAudioPending = true;
    if (detected && confidence >= 0.6) this.setLang(toSpeakable(detected, this.lang));
    this.emit({ type: "final", text, lang: detected, source });

    const cmd = quickCommand(text);
    if (cmd === "stop") return void this.stopAll(true);
    if (cmd === "repeat" && this.lastSpoken) return void this.say(this.lastSpoken);
    if (cmd === "faster" || cmd === "slower") {
      this.tts.voice.pace = clamp(this.tts.voice.pace + (cmd === "faster" ? 0.25 : -0.25), 0.6, 2);
      this.emit({ type: "voice", pace: this.tts.voice.pace, speaker: this.tts.voice.speaker });
      return void this.sayPhrase(cmd);
    }
    if (this.waiter) return this.resolveWaiter(text);
    if (this.composeWaiter) return; // compose text comes from the Kivi box, not speech
    this.conversation.push(`User: ${text}`);
    if (this.task) {
      this.interjections.push(text);
      return;
    }
    void this.runTask(text);
  }

  private setLang(code: LangCode) {
    if (code === this.lang) return;
    this.lang = code;
    this.emit({ type: "lang", code, name: LANGS[code].name, native: LANGS[code].native });
    void warmPhrases(code);
  }

  private async runTask(text: string) {
    const abort = new AbortController();
    this.task = { abort, text };
    this.interjections = [];
    this.emit({ type: "task", state: "running", text });
    const t0 = Date.now();
    try {
      const r = await this.agent.run(text, this, abort.signal);
      if (r.speech) this.conversation.push(`Drishti: ${r.speech}`);
      this.emit({ type: "task", state: r.outcome, text, ms: Date.now() - t0 });
    } catch (e: any) {
      this.emit({ type: "error", message: e?.message ?? String(e) });
      this.emit({ type: "task", state: "error", text });
      if (!abort.signal.aborted) await this.sayPhrase("error");
    } finally {
      if (this.task?.abort === abort) this.task = undefined;
      this.conversation = this.conversation.slice(-8);
    }
  }

  private async stopAll(speak: boolean) {
    this.tts.cancelAll();
    this.task?.abort.abort();
    this.task = undefined;
    if (this.waiter) this.resolveWaiter(null);
    if (this.composeWaiter) {
      clearTimeout(this.composeWaiter.timer);
      this.composeWaiter.resolve(null);
      this.composeWaiter = undefined;
      this.emit({ type: "compose_close" });
    }
    this.emit({ type: "task", state: "aborted" });
    if (speak) await this.sayPhrase("stopped");
  }

  private bargeIn() {
    if (this.tts.busy) this.tts.cancelAll();
  }

  private resolveWaiter(text: string | null) {
    const w = this.waiter!;
    clearTimeout(w.timer);
    this.waiter = undefined;
    this.emit({ type: "awaiting", kind: null });
    w.resolve(text);
  }

  // ---------- speech out ----------
  private wireTts() {
    this.tts.on("start", (u) => this.emit({ type: "tts_start", id: u.id, text: u.text, lang: u.lang }));
    this.tts.on("audio", (u, pcm: Buffer) => {
      if (u.cancelled) return;
      if (this.firstAudioPending) {
        this.firstAudioPending = false;
        this.emit({ type: "metric", name: "turn_latency", ms: Date.now() - this.lastFinalAt });
      }
      if (this.ws.readyState === 1) this.ws.send(pcm, { binary: true });
    });
    this.tts.on("end", (u) => this.emit({ type: "tts_end", id: u.id }));
    this.tts.on("cancel", () => this.emit({ type: "tts_stop" }));
    this.tts.on("error", (e: Error) => this.emit({ type: "error", message: `TTS: ${e.message}` }));
  }

  // ---------- AgentIO ----------
  say(text: string) {
    if (!text?.trim()) return;
    this.lastSpoken = text;
    this.tts.speak(text, this.lang);
  }

  async sayPhrase(key: PhraseKey) {
    this.say(await phrase(key, this.lang));
  }

  ask(question: string, kind: "question" | "confirm"): Promise<string | null> {
    this.say(question);
    if (this.waiter) this.resolveWaiter(null);
    this.emit({ type: "awaiting", kind, question });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.waiter && this.resolveWaiter(null), 60000);
      this.waiter = { kind, resolve, timer };
    });
  }

  compose(prompt: string, field: string): Promise<string | null> {
    this.say(prompt);
    this.emit({ type: "compose_open", prompt, field });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.composeWaiter = undefined;
        this.emit({ type: "compose_close" });
        resolve(null);
      }, 180000);
      this.composeWaiter = { resolve, timer };
    });
  }

  emit(event: Record<string, unknown>) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(event));
  }

  recent() {
    return this.conversation.slice(-6);
  }

  takeInterjections() {
    const out = this.interjections;
    this.interjections = [];
    return out;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
